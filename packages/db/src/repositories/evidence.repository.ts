import type { Kysely, Selectable } from 'kysely';
import type { Database, EvidenceTable, EvidenceUploadsTable } from '../types.js';
import { decodeCursor, toPage, type Page } from '../paging.js';

/**
 * Evidence for test executions (migration 018): the rows that say where each file is, what it
 * is and who added it. The files themselves are in storage (apps/server/src/storage/); deleting
 * a row queues its file for the storage sweeper (a trigger), so these never touch storage.
 */

export type Evidence = Omit<Selectable<EvidenceTable>, 'size_bytes'> & { size_bytes: number };
export type EvidenceUpload = Omit<Selectable<EvidenceUploadsTable>, 'size_bytes'> & { size_bytes: number };

// PostgreSQL's driver gives bigint as a string.
const withSize = <T extends { size_bytes: unknown }>(row: T): T & { size_bytes: number } => ({ ...row, size_bytes: Number(row.size_bytes) });

export class EvidenceRepository {
  constructor(private db: Kysely<Database>) {}

  async create(row: Selectable<EvidenceTable>): Promise<Evidence> {
    await this.db.insertInto('evidence').values(row).execute();
    return withSize(row);
  }

  async findById(id: string): Promise<Evidence | undefined> {
    const row = await this.db.selectFrom('evidence').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? withSize(row) : undefined;
  }

  /** The same file already added to this case's execution (a retried upload). */
  async findDuplicate(testRunId: string, testPlanCaseId: string, sha256: string): Promise<Evidence | undefined> {
    const row = await this.db
      .selectFrom('evidence')
      .selectAll()
      .where('test_run_id', '=', testRunId)
      .where('test_plan_case_id', '=', testPlanCaseId)
      .where('sha256', '=', sha256)
      .executeTakeFirst();
    return row ? withSize(row) : undefined;
  }

  async countForExecution(testRunId: string, testPlanCaseId: string): Promise<number> {
    const row = await this.db
      .selectFrom('evidence')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('test_run_id', '=', testRunId)
      .where('test_plan_case_id', '=', testPlanCaseId)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** A run's evidence, oldest first, a page at a time (keyset on created_at, id). */
  async listForRun(testRunId: string, filter: { testPlanCaseId?: string; kind?: string }, page: { limit: number; cursor?: string | null }): Promise<Page<Evidence>> {
    let query = this.db.selectFrom('evidence').selectAll().where('test_run_id', '=', testRunId);
    if (filter.testPlanCaseId) query = query.where('test_plan_case_id', '=', filter.testPlanCaseId);
    if (filter.kind) query = query.where('kind', '=', filter.kind);
    const cursor = decodeCursor(page.cursor);
    if (cursor) {
      query = query.where((eb) => eb.or([eb('created_at', '>', cursor.ts), eb.and([eb('created_at', '=', cursor.ts), eb('id', '>', cursor.id)])]));
    }
    const rows = (await query.orderBy('created_at', 'asc').orderBy('id', 'asc').limit(page.limit + 1).execute()).map(withSize);
    return toPage(rows, page.limit, (r) => ({ ts: r.created_at, id: r.id }));
  }

  /** The evidence each of these results was added with, oldest first. */
  async listForResults(resultIds: string[]): Promise<Map<string, Evidence[]>> {
    const out = new Map<string, Evidence[]>();
    if (resultIds.length === 0) return out;
    const rows = await this.db.selectFrom('evidence').selectAll().where('test_result_id', 'in', resultIds).orderBy('created_at').orderBy('id').execute();
    for (const row of rows) out.set(row.test_result_id, [...(out.get(row.test_result_id) ?? []), withSize(row)]);
    return out;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('evidence').where('id', '=', id).execute();
  }

  /** How much evidence a delete would take with it: in these runs, plan cases or a project. */
  async countWhere(where: { runIds?: string[]; planCaseIds?: string[]; projectId?: string }): Promise<{ files: number; bytes: number }> {
    let query = this.db.selectFrom('evidence').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.sum<string>('size_bytes').as('bytes')]);
    if (where.projectId) query = query.where('project_id', '=', where.projectId);
    if (where.runIds) query = where.runIds.length ? query.where('test_run_id', 'in', where.runIds) : query.where('id', '=', '');
    if (where.planCaseIds) query = where.planCaseIds.length ? query.where('test_plan_case_id', 'in', where.planCaseIds) : query.where('id', '=', '');
    const row = await query.executeTakeFirst();
    return { files: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
  }
}

export class EvidenceUploadRepository {
  constructor(private db: Kysely<Database>) {}

  async create(row: Selectable<EvidenceUploadsTable>): Promise<void> {
    await this.db.insertInto('evidence_uploads').values(row).execute();
  }

  async findById(id: string): Promise<EvidenceUpload | undefined> {
    const row = await this.db.selectFrom('evidence_uploads').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? withSize(row) : undefined;
  }

  async findByTokenHash(tokenHash: string): Promise<EvidenceUpload | undefined> {
    const row = await this.db.selectFrom('evidence_uploads').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
    return row ? withSize(row) : undefined;
  }

  /** Claims a pending link for its one upload; false when another request already did, or it isn't pending. */
  async claim(id: string): Promise<boolean> {
    const result = await this.db.updateTable('evidence_uploads').set({ status: 'receiving' }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async setStatus(id: string, status: 'pending' | 'received'): Promise<void> {
    await this.db.updateTable('evidence_uploads').set({ status }).where('id', '=', id).execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('evidence_uploads').where('id', '=', id).execute();
  }

  /** Links past their expiry, for the sweeper to remove with any file they received. */
  async expired(now: string, limit = 100): Promise<EvidenceUpload[]> {
    return (await this.db.selectFrom('evidence_uploads').selectAll().where('expires_at', '<', now).limit(limit).execute()).map(withSize);
  }
}

export class StorageDeletionRepository {
  constructor(private db: Kysely<Database>) {}

  /** Queues a file to delete (one that never became evidence, such as a refused upload's). */
  async queue(storageKey: string): Promise<void> {
    await this.db
      .insertInto('storage_deletions')
      .values({ storage_key: storageKey, attempts: 0, last_error: null, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.column('storage_key').doNothing())
      .execute();
  }

  async due(limit = 100): Promise<Array<{ storage_key: string; attempts: number }>> {
    return this.db.selectFrom('storage_deletions').select(['storage_key', 'attempts']).orderBy('created_at').limit(limit).execute();
  }

  async done(storageKey: string): Promise<void> {
    await this.db.deleteFrom('storage_deletions').where('storage_key', '=', storageKey).execute();
  }

  async failed(storageKey: string, error: string): Promise<void> {
    await this.db
      .updateTable('storage_deletions')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: error.slice(0, 2000) }))
      .where('storage_key', '=', storageKey)
      .execute();
  }
}
