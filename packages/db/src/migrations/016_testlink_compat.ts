import { sql, type Kysely } from 'kysely';

/**
 * The TestLink-compatible API (apps/server/src/testlinkCompat/): what it needs to answer
 * TestLink's requests with TestLink's identifiers, so a client of Dave's TestLink REST API
 * changes only the host.
 *
 * - `compat_ids`: TestLink's numeric ids for Testify's rows (UUIDs stay primary). Each
 *   `id_space` is one sequence: `node` holds projects, suites, cases, versions and plans
 *   together, as TestLink's nodes_hierarchy does (an id like `parentID` may name a project or a
 *   suite, so they must never collide); builds, executions, keywords, custom fields and
 *   platforms have their own. A migration from TestLink keeps TestLink's ids; new rows get the
 *   highest + 1.
 * - `user_api_keys`: a user's TestLink API key (the APIKEY header), one per user, stored as a
 *   SHA-256 digest like API tokens. It works only on the TestLink-compatible paths.
 * - `compat_api_keys`: the project and plan API keys TestLink uses as identifiers in requests
 *   (`projectApiKey`, `GET /testplans/{apikey}/builds`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('compat_ids')
    .addColumn('id_space', 'varchar(20)', (col) => col.notNull())
    .addColumn('int_id', 'integer', (col) => col.notNull())
    .addColumn('entity_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('entity_id', 'varchar(36)', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_compat_ids', ['id_space', 'int_id'])
    .addUniqueConstraint('uq_compat_ids_entity', ['entity_type', 'entity_id'])
    .execute();

  await db.schema
    .createTable('user_api_keys')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull().unique().references('users.id').onDelete('cascade'))
    .addColumn('key_hash', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('key_prefix', 'varchar(12)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('last_used_at', 'varchar(30)')
    .execute();

  await db.schema
    .createTable('compat_api_keys')
    .addColumn('entity_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('entity_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('api_key', 'varchar(64)', (col) => col.notNull().unique())
    .addPrimaryKeyConstraint('pk_compat_api_keys', ['entity_type', 'entity_id'])
    .execute();
  await sql`CREATE INDEX idx_compat_ids_space_entity ON compat_ids (id_space, entity_type)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('compat_api_keys').execute();
  await db.schema.dropTable('user_api_keys').execute();
  await db.schema.dropTable('compat_ids').execute();
}
