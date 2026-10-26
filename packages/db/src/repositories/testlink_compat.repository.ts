import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../types.js';
import { hashToken } from './api_token.repository.js';

/**
 * What the TestLink-compatible API (apps/server/src/testlinkCompat/) keeps beside Testify's own
 * rows: TestLink's numeric ids, users' TestLink API keys, and the project and plan API keys
 * TestLink uses as identifiers (migration 016).
 */

/** Each kind of row and the id space (one sequence) its numeric ids come from. */
export const COMPAT_ID_SPACES = {
  // One space, as TestLink's nodes_hierarchy: a parentID may be a project or a suite.
  project: 'node',
  suite: 'node',
  case: 'node',
  version: 'node',
  plan: 'node',
  build: 'build',
  execution: 'execution',
  keyword: 'keyword',
  customfield: 'customfield',
  platform: 'platform',
} as const;

export type CompatEntityType = keyof typeof COMPAT_ID_SPACES;

export class CompatIdRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * The numeric ids of these rows, giving the ones that have none the next ids in their space
   * (highest + 1). Each round numbers all the missing rows in one statement, so it never hands
   * out an id twice; a concurrent request that took the same ids makes some rows conflict, and
   * the next round numbers those above it. Testify's UUIDs stay the rows' real ids; these exist
   * only for the TestLink-compatible API.
   */
  async intIds(entityType: CompatEntityType, entityIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let missing = [...new Set(entityIds)];
    const space = COMPAT_ID_SPACES[entityType];
    for (let round = 0; missing.length > 0; round++) {
      const known = await this.db
        .selectFrom('compat_ids')
        .select(['entity_id', 'int_id'])
        .where('entity_type', '=', entityType)
        .where('entity_id', 'in', missing)
        .execute();
      for (const r of known) out.set(r.entity_id, r.int_id);
      missing = missing.filter((id) => !out.has(id));
      if (missing.length === 0) break;
      if (round === 20) throw new Error(`Couldn't number ${missing.length} ${entityType} rows`);
      const numbered = await sql<{ entity_id: string; int_id: number }>`
        insert into compat_ids (id_space, int_id, entity_type, entity_id)
        select ${space}, m.top + t.n, ${entityType}, t.id
        from (select coalesce(max(int_id), 0) as top from compat_ids where id_space = ${space}) m,
             unnest(${missing}::varchar[]) with ordinality as t(id, n)
        on conflict do nothing
        returning entity_id, int_id`.execute(this.db);
      for (const r of numbered.rows) out.set(r.entity_id, Number(r.int_id));
      missing = missing.filter((id) => !out.has(id));
    }
    return out;
  }

  async intId(entityType: CompatEntityType, entityId: string): Promise<number> {
    return (await this.intIds(entityType, [entityId])).get(entityId)!;
  }

  /** The row a numeric id names, if it's one of these kinds (a node id may be a project, a suite, ...). */
  async find(intId: number, types: CompatEntityType[]): Promise<{ entity_type: CompatEntityType; entity_id: string } | undefined> {
    const spaces = [...new Set(types.map((t) => COMPAT_ID_SPACES[t]))];
    const row = await this.db
      .selectFrom('compat_ids')
      .select(['entity_type', 'entity_id'])
      .where('id_space', 'in', spaces)
      .where('int_id', '=', intId)
      .where('entity_type', 'in', types)
      .executeTakeFirst();
    return row ? { entity_type: row.entity_type as CompatEntityType, entity_id: row.entity_id } : undefined;
  }

  async entityId(entityType: CompatEntityType, intId: number): Promise<string | undefined> {
    return (await this.find(intId, [entityType]))?.entity_id;
  }

  /** Records a row's numeric id as given (a migration keeping TestLink's ids). */
  async assign(entityType: CompatEntityType, entityId: string, intId: number): Promise<void> {
    await this.db
      .insertInto('compat_ids')
      .values({ id_space: COMPAT_ID_SPACES[entityType], int_id: intId, entity_type: entityType, entity_id: entityId })
      .onConflict((oc) => oc.columns(['entity_type', 'entity_id']).doUpdateSet({ int_id: intId }))
      .execute();
  }
}

/** A user's TestLink API key, as shown: never the key itself. */
export interface UserApiKeyInfo {
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

/** 32 hex characters, the shape of TestLink's own keys, so clients that check it accept ours. */
const newKey = () => randomBytes(16).toString('hex');

export class UserApiKeyRepository {
  constructor(private db: Kysely<Database>) {}

  /** A new key for the user, replacing any they had (TestLink has one per user). The plaintext is returned only here. */
  async create(userId: string): Promise<{ plaintext: string; key: UserApiKeyInfo }> {
    const plaintext = newKey();
    await this.store(userId, plaintext);
    return { plaintext, key: (await this.getForUser(userId))! };
  }

  /** Keeps a key the user already has elsewhere (a migration from TestLink, whose keys scripts hold). */
  async store(userId: string, plaintext: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.deleteFrom('user_api_keys').where('user_id', '=', userId).execute();
    await this.db
      .insertInto('user_api_keys')
      .values({ id: uuidv7(), user_id: userId, key_hash: hashToken(plaintext), key_prefix: plaintext.slice(0, 6), created_at: now, last_used_at: null })
      .execute();
  }

  async getForUser(userId: string): Promise<UserApiKeyInfo | undefined> {
    return this.db.selectFrom('user_api_keys').select(['key_prefix', 'created_at', 'last_used_at']).where('user_id', '=', userId).executeTakeFirst();
  }

  /** Every user's key, for the Admin Panel's roster. */
  async listAll(): Promise<Map<string, UserApiKeyInfo>> {
    const rows = await this.db.selectFrom('user_api_keys').select(['user_id', 'key_prefix', 'created_at', 'last_used_at']).execute();
    return new Map(rows.map(({ user_id, ...info }) => [user_id, info]));
  }

  async findByKey(plaintext: string): Promise<{ id: string; user_id: string; last_used_at: string | null } | undefined> {
    return this.db.selectFrom('user_api_keys').select(['id', 'user_id', 'last_used_at']).where('key_hash', '=', hashToken(plaintext)).executeTakeFirst();
  }

  async touch(id: string, at: string): Promise<void> {
    await this.db.updateTable('user_api_keys').set({ last_used_at: at }).where('id', '=', id).execute();
  }

  /** True when the user had a key. */
  async revoke(userId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('user_api_keys').where('user_id', '=', userId).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

/** The kinds of rows with a TestLink API key. */
export type CompatKeyEntity = 'project' | 'plan';

export class CompatApiKeyRepository {
  constructor(private db: Kysely<Database>) {}

  /** The row's API key, made the first time it's asked for (64 hex characters, as TestLink's). */
  async keyFor(entityType: CompatKeyEntity, entityId: string): Promise<string> {
    const existing = await this.db
      .selectFrom('compat_api_keys')
      .select('api_key')
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    if (existing) return existing.api_key;
    await this.db
      .insertInto('compat_api_keys')
      .values({ entity_type: entityType, entity_id: entityId, api_key: randomBytes(32).toString('hex') })
      .onConflict((oc) => oc.columns(['entity_type', 'entity_id']).doNothing())
      .execute();
    return (await this.db
      .selectFrom('compat_api_keys')
      .select('api_key')
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirstOrThrow()).api_key;
  }

  async entityFor(entityType: CompatKeyEntity, apiKey: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('compat_api_keys')
      .select('entity_id')
      .where('entity_type', '=', entityType)
      .where('api_key', '=', apiKey)
      .executeTakeFirst();
    return row?.entity_id;
  }

  /** Keeps a key from TestLink (a migration). */
  async assign(entityType: CompatKeyEntity, entityId: string, apiKey: string): Promise<void> {
    await this.db
      .insertInto('compat_api_keys')
      .values({ entity_type: entityType, entity_id: entityId, api_key: apiKey })
      .onConflict((oc) => oc.columns(['entity_type', 'entity_id']).doUpdateSet({ api_key: apiKey }))
      .execute();
  }
}

export interface CompatPlatform {
  id: string;
  project_id: string;
  name: string;
  notes: string | null;
}

/**
 * TestLink's platforms (migration 017). Testify has none of its own: a build of a plan with
 * platforms keeps one run per platform, made on the first result (`platformRun`).
 */
export class CompatPlatformRepository {
  constructor(private db: Kysely<Database>) {}

  /** A new platform in a project (the migration from TestLink makes them; TestLink's API can't). */
  async create(projectId: string, name: string, notes: string | null = null): Promise<CompatPlatform> {
    const row = { id: uuidv7(), project_id: projectId, name, notes, created_at: new Date().toISOString() };
    await this.db.insertInto('compat_platforms').values(row).execute();
    return { id: row.id, project_id: projectId, name, notes };
  }

  async listForProject(projectId: string): Promise<CompatPlatform[]> {
    return this.db.selectFrom('compat_platforms').select(['id', 'project_id', 'name', 'notes']).where('project_id', '=', projectId).orderBy('name').execute();
  }

  async linkToPlan(planId: string, platformIds: string[]): Promise<void> {
    if (platformIds.length === 0) return;
    const now = new Date().toISOString();
    await this.db
      .insertInto('compat_plan_platforms')
      .values(platformIds.map((platform_id) => ({ test_plan_id: planId, platform_id, created_at: now })))
      .onConflict((oc) => oc.columns(['test_plan_id', 'platform_id']).doNothing())
      .execute();
  }

  async platformsOfPlan(planId: string): Promise<CompatPlatform[]> {
    return this.db
      .selectFrom('compat_plan_platforms')
      .innerJoin('compat_platforms', 'compat_platforms.id', 'compat_plan_platforms.platform_id')
      .select(['compat_platforms.id', 'compat_platforms.project_id', 'compat_platforms.name', 'compat_platforms.notes'])
      .where('compat_plan_platforms.test_plan_id', '=', planId)
      .orderBy('compat_platforms.name')
      .execute();
  }

  /** The run a build's results on a platform go in, if it has been made. */
  async platformRun(buildRunId: string, platformId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('compat_platform_runs')
      .select('run_id')
      .where('build_run_id', '=', buildRunId)
      .where('platform_id', '=', platformId)
      .executeTakeFirst();
    return row?.run_id;
  }

  /** Records a platform's run for a build; when another request got there first, its run (the caller's is then unused). */
  async setPlatformRun(buildRunId: string, platformId: string, runId: string): Promise<string> {
    await this.db
      .insertInto('compat_platform_runs')
      .values({ build_run_id: buildRunId, platform_id: platformId, run_id: runId })
      .onConflict((oc) => oc.columns(['build_run_id', 'platform_id']).doNothing())
      .execute();
    return (await this.platformRun(buildRunId, platformId))!;
  }

  /** A build's platform runs. */
  async runsOfBuild(buildRunId: string): Promise<Array<{ platform_id: string; run_id: string; name: string }>> {
    return this.db
      .selectFrom('compat_platform_runs')
      .innerJoin('compat_platforms', 'compat_platforms.id', 'compat_platform_runs.platform_id')
      .select(['compat_platform_runs.platform_id', 'compat_platform_runs.run_id', 'compat_platforms.name'])
      .where('compat_platform_runs.build_run_id', '=', buildRunId)
      .execute();
  }

  /** Which of these runs are platform runs (not builds of their own). */
  async platformRunIds(runIds: string[]): Promise<Set<string>> {
    if (runIds.length === 0) return new Set();
    const rows = await this.db.selectFrom('compat_platform_runs').select('run_id').where('run_id', 'in', runIds).execute();
    return new Set(rows.map((r) => r.run_id));
  }
}
