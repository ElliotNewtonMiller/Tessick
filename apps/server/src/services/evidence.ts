import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { EvidenceRepository, type Database, type Evidence } from '@tessick/db';
import { MAX_EVIDENCE_DESCRIPTION, MAX_EVIDENCE_PER_EXECUTION, cleanFilename, evidenceWindow } from '@tessick/core';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { actorType, requestOrigin } from '../audit.js';
import { actorNames } from './actorNames.js';
import { internalVia } from '../internalRequests.js';
import { newStorageKey } from '../storage/provider.js';
import { EvidenceRefused, type SpooledFile } from '../storage/spool.js';

/**
 * Evidence for a case's execution in a run (docs/rfc_03_api_and_xml_contracts.md §5): which
 * execution and result a file belongs to, whether it may be added now, storing it, and how it's
 * shown. Shared by the routes (routes/evidence.ts), upload links and JUnit uploads.
 */

/** The execution a file is for: its run, plan link, and the result it's added with. */
export interface ExecutionTarget {
  projectId: string;
  run: { id: string; status: string; closed_at: string | null; test_plan_id: string };
  planCaseId: string;
  testCaseId: string;
  result: { id: string; tester_id: string };
}

/**
 * A case's execution in a run, with the result evidence attaches to: the latest, or `resultId`
 * when given (it must be one of this execution's). Refused when the case isn't in the run's plan,
 * has left it, or has no result yet: evidence documents a result.
 */
export async function findExecution(db: Kysely<Database>, input: { runId: string; caseId: string; resultId?: string }): Promise<ExecutionTarget> {
  const run = await db
    .selectFrom('test_runs')
    .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
    .select(['test_runs.id', 'test_runs.status', 'test_runs.closed_at', 'test_runs.test_plan_id', 'test_plans.project_id'])
    .where('test_runs.id', '=', input.runId)
    .executeTakeFirst();
  if (!run) throw new EvidenceRefused(404, 'NOT_FOUND', 'Run not found');
  const links = await db
    .selectFrom('test_plan_cases')
    .select(['id', 'removed_at'])
    .where('test_plan_id', '=', run.test_plan_id)
    .where('test_case_id', '=', input.caseId)
    .execute();
  const link = links.find((l) => l.removed_at === null);
  if (!link) {
    if (links.length) throw new EvidenceRefused(409, 'CASE_RETIRED', "This case has left the run's plan, so its results there are read-only.");
    throw new EvidenceRefused(404, 'NOT_FOUND', "The case isn't in this run's plan.");
  }
  let query = db.selectFrom('test_results').select(['id', 'tester_id']).where('test_run_id', '=', run.id).where('test_plan_case_id', '=', link.id);
  if (input.resultId) query = query.where('id', '=', input.resultId);
  const result = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  if (!result) {
    if (input.resultId) throw new EvidenceRefused(404, 'NOT_FOUND', "That result isn't one of this case's in the run.");
    throw new EvidenceRefused(409, 'NO_RESULT_TO_ATTACH', 'Record a result for the case in this run first: evidence documents a result.');
  }
  return {
    projectId: run.project_id,
    run: { id: run.id, status: run.status, closed_at: run.closed_at, test_plan_id: run.test_plan_id },
    planCaseId: link.id,
    testCaseId: input.caseId,
    result,
  };
}

/** The execution of a given result. */
export async function findResultExecution(db: Kysely<Database>, resultId: string): Promise<ExecutionTarget> {
  const row = await db
    .selectFrom('test_results')
    .innerJoin('test_plan_cases', 'test_plan_cases.id', 'test_results.test_plan_case_id')
    .select(['test_results.test_run_id', 'test_plan_cases.test_case_id'])
    .where('test_results.id', '=', resultId)
    .executeTakeFirst();
  if (!row) throw new EvidenceRefused(404, 'NOT_FOUND', 'Result not found');
  return findExecution(db, { runId: row.test_run_id, caseId: row.test_case_id, resultId });
}

/**
 * Whether `user` may add evidence to the execution now (decided with Elliot): any time while the
 * run is open; for 24 hours after it closes, only whoever recorded the result. Answers whether
 * it's after the close.
 */
export function checkWindow(target: ExecutionTarget, user: Pick<AuthenticatedUser, 'id'>, now: Date): { afterClose: boolean } {
  const window = evidenceWindow({ runStatus: target.run.status, closedAt: target.run.closed_at, callerRecordedResult: target.result.tester_id === user.id, now });
  if (!window.allowed) throw new EvidenceRefused(422, 'RUN_CLOSED', window.reason);
  return { afterClose: window.afterClose };
}

/** Whether `user` may delete the evidence (decided with Elliot): its uploader while the run is open, or anyone with EXECUTE_OVERWRITE. */
export function mayDeleteEvidence(user: Pick<AuthenticatedUser, 'id' | 'permissions'>, evidence: Pick<Evidence, 'uploaded_by'>, runStatus: string | undefined): boolean {
  const overwrite = user.permissions.includes('EXECUTE_OVERWRITE') || user.permissions.includes('SYSTEM_ADMIN');
  return overwrite || (evidence.uploaded_by === user.id && runStatus === 'OPEN');
}

/**
 * Whether `user` may add evidence to a case's execution now, and if not why: the same checks an
 * upload makes, for the web app to show before anyone picks a file.
 */
export async function canAddEvidence(
  db: Kysely<Database>,
  user: Pick<AuthenticatedUser, 'id' | 'permissions'>,
  input: { runId: string; caseId: string },
  now: Date
): Promise<{ allowed: boolean; code: string | null; reason: string | null }> {
  if (!user.permissions.includes('EXECUTE_RUN') && !user.permissions.includes('SYSTEM_ADMIN')) {
    return { allowed: false, code: 'FORBIDDEN', reason: "Your role can't add evidence: it needs EXECUTE_RUN." };
  }
  try {
    checkWindow(await findExecution(db, input), user, now);
    return { allowed: true, code: null, reason: null };
  } catch (err) {
    if (!(err instanceof EvidenceRefused)) throw err;
    // "Record a result first" can't be done on a closed run.
    if (err.code === 'NO_RESULT_TO_ATTACH') {
      const run = await db.selectFrom('test_runs').select('status').where('id', '=', input.runId).executeTakeFirst();
      if (run?.status === 'CLOSED') return { allowed: false, code: 'RUN_CLOSED', reason: 'The run is closed, and this case has no result in it to add evidence to.' };
    }
    return { allowed: false, code: err.code, reason: err.message };
  }
}

/** How a request came: the web app, MCP, or the API. */
export function viaOf(request: FastifyRequest): 'UI' | 'MCP' | 'API' {
  if (internalVia(request) === 'mcp') return 'MCP';
  return request.headers['x-tessick-client'] === 'web' ? 'UI' : 'API';
}

export function checkDescription(description: unknown): string | null {
  if (description === undefined || description === null || description === '') return null;
  if (typeof description !== 'string') throw new EvidenceRefused(400, 'INVALID_REQUEST', 'description must be text');
  if (description.length > MAX_EVIDENCE_DESCRIPTION) throw new EvidenceRefused(400, 'INVALID_REQUEST', `description can be at most ${MAX_EVIDENCE_DESCRIPTION} characters`);
  return description;
}

/** Who added a file, for its row and audit row. */
export interface Uploader {
  id: string;
  actorType: 'USER' | 'SERVICE_ACCOUNT';
  via: 'UI' | 'MCP' | 'API';
  /** For the audit row's origin. */
  request: FastifyRequest;
}

export function uploaderOf(request: FastifyRequest): Uploader {
  const user = request.user!;
  return { id: user.id, actorType: actorType(user), via: viaOf(request), request };
}

/**
 * Stores a checked file as evidence for the execution and audits it. The same file (same SHA-256)
 * already on the execution is answered instead, so a retried upload adds nothing. The spooled
 * file is moved into storage, or discarded.
 */
export async function storeEvidence(
  db: Kysely<Database>,
  storage: import('../storage/provider.js').StorageProvider,
  target: ExecutionTarget,
  file: SpooledFile | { storageKey: string; size: number; sha256: string; type: SpooledFile['type'] },
  details: { filename: unknown; description: string | null; afterClose: boolean; uploader: Uploader }
): Promise<{ evidence: Evidence; duplicate: boolean }> {
  const repo = new EvidenceRepository(db);
  const existing = await repo.findDuplicate(target.run.id, target.planCaseId, file.sha256);
  if (existing) {
    if ('discard' in file) await file.discard();
    return { evidence: existing, duplicate: true };
  }
  if ((await repo.countForExecution(target.run.id, target.planCaseId)) >= MAX_EVIDENCE_PER_EXECUTION) {
    if ('discard' in file) await file.discard();
    throw new EvidenceRefused(409, 'EVIDENCE_LIMIT', `A case's execution can have at most ${MAX_EVIDENCE_PER_EXECUTION} evidence files.`);
  }
  let storageKey: string;
  if ('discard' in file) {
    storageKey = newStorageKey(target.projectId);
    await storage.putFile(storageKey, file.path, { size: file.size, mediaType: file.type.media_type, sha256: file.sha256 });
  } else {
    storageKey = file.storageKey;
  }
  const now = new Date().toISOString();
  const evidence = await repo.create({
    id: uuidv7(),
    project_id: target.projectId,
    test_run_id: target.run.id,
    test_plan_case_id: target.planCaseId,
    test_result_id: target.result.id,
    kind: file.type.kind,
    media_type: file.type.media_type,
    filename: cleanFilename(details.filename, file.type.ext),
    description: details.description,
    size_bytes: file.size,
    sha256: file.sha256,
    storage_key: storageKey,
    uploaded_by: details.uploader.id,
    actor_type: details.uploader.actorType,
    uploaded_via: details.uploader.via,
    after_close: details.afterClose,
    created_at: now,
  });
  await db
    .insertInto('audit_logs')
    .values({
      id: uuidv4(),
      actor_id: details.uploader.id,
      actor_type: details.uploader.actorType,
      action: 'EVIDENCE_ADDED',
      resource_type: 'evidence',
      resource_id: evidence.id,
      project_id: target.projectId,
      diff: JSON.stringify({
        test_run_id: target.run.id,
        test_case_id: target.testCaseId,
        test_result_id: target.result.id,
        filename: evidence.filename,
        kind: evidence.kind,
        size_bytes: evidence.size_bytes,
        sha256: evidence.sha256,
        via: evidence.uploaded_via,
        after_close: evidence.after_close,
      }),
      ...requestOrigin(details.uploader.request),
      created_at: now,
    })
    .execute();
  return { evidence, duplicate: false };
}

/** Evidence as the API shows it (the Evidence schema). */
export async function presentEvidence(db: Kysely<Database>, rows: Evidence[], extra: (e: Evidence) => Record<string, unknown> = () => ({})) {
  const caseIds = new Map<string, string>();
  const planCaseIds = [...new Set(rows.map((r) => r.test_plan_case_id))];
  if (planCaseIds.length) {
    for (const link of await db.selectFrom('test_plan_cases').select(['id', 'test_case_id']).where('id', 'in', planCaseIds).execute()) caseIds.set(link.id, link.test_case_id);
  }
  const names = await actorNames(db, rows.map((r) => r.uploaded_by));
  return rows.map((e) => ({
    id: e.id,
    test_run_id: e.test_run_id,
    test_case_id: caseIds.get(e.test_plan_case_id) ?? null,
    test_result_id: e.test_result_id,
    kind: e.kind,
    media_type: e.media_type,
    filename: e.filename,
    description: e.description,
    size_bytes: e.size_bytes,
    sha256: e.sha256,
    uploaded_by: names.get(e.uploaded_by) ?? e.uploaded_by,
    uploaded_by_id: e.uploaded_by,
    uploaded_via: e.uploaded_via,
    after_close: e.after_close,
    created_at: e.created_at,
    content_url: `/api/v1/evidence/${e.id}/content`,
    ...extra(e),
  }));
}

/** How many evidence files a delete would take with it, for its warning. */
export async function evidenceCount(db: Kysely<Database>, scope: { projectId?: string; runIds?: string[]; caseIds?: string[] }): Promise<number> {
  const repo = new EvidenceRepository(db);
  if (scope.caseIds) {
    if (!scope.caseIds.length) return 0;
    const links = (await db.selectFrom('test_plan_cases').select('id').where('test_case_id', 'in', scope.caseIds).execute()).map((l) => l.id);
    return (await repo.countWhere({ planCaseIds: links })).files;
  }
  return (await repo.countWhere({ projectId: scope.projectId, runIds: scope.runIds })).files;
}
