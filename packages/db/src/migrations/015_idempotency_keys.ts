import { type Kysely } from 'kysely';

/**
 * Idempotency keys for the result routes (API audit, 2026-10-23): a CI job that retries an
 * upload after a network error sends the same `Idempotency-Key`, and gets the first answer back
 * instead of every result recorded twice (services/idempotency.ts).
 *
 * A key belongs to its caller (a user or an API token), project and route. The row is
 * IN_PROGRESS while the first request runs and COMPLETE with its answer once that succeeded;
 * a failed request deletes it, so a retry runs. Rows are kept for 24 hours (`expires_at`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('idempotency_keys')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('caller', 'varchar(50)', (col) => col.notNull()) // user:<id> or token:<id>
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('route', 'varchar(255)', (col) => col.notNull()) // e.g. POST /api/v1/runs/:runId/results/batch
    .addColumn('idempotency_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('fingerprint', 'varchar(64)', (col) => col.notNull()) // sha256 of the request
    .addColumn('status', 'varchar(20)', (col) => col.notNull()) // IN_PROGRESS | COMPLETE
    .addColumn('response_status', 'integer')
    .addColumn('response_body', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('expires_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_idempotency_key', ['caller', 'project_id', 'route', 'idempotency_key'])
    .execute();
  await db.schema.createIndex('idx_idempotency_keys_expires').on('idempotency_keys').column('expires_at').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('idempotency_keys').execute();
}
