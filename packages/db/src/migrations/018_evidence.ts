import { sql, type Kysely } from 'kysely';

/**
 * Evidence for test executions: screenshots, videos, logs and Playwright traces uploaded for a
 * case's execution in a run (docs/rfc_03_api_and_xml_contracts.md §5). The files live in
 * storage (apps/server/src/storage/: a directory or an S3 bucket); the database keeps where,
 * what (the type its contents showed), how big, its SHA-256, and who added it.
 *
 * - `evidence`: one row per file. It belongs to a case's execution in a run (the run and the
 *   plan case) and names the result it was added with. It goes when its result, run or plan
 *   case does (cascades), whichever delete removes them.
 * - `storage_deletions`: files to delete from storage, queued by a trigger whenever an
 *   evidence row is deleted, by any path, so a file is never left behind or deleted before the
 *   deleting transaction commits. The storage sweeper (services/storageSweeper.ts) empties it.
 * - `evidence_uploads`: upload links (for large files and MCP agents): a single-use token,
 *   stored as a digest, for one file of a known size and checksum, valid 15 minutes.
 * - `test_runs.closed_at`: when the run last closed, kept by a trigger on every path that closes
 *   or reopens a run; evidence may be added for 24 hours after it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('evidence')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('test_run_id', 'varchar(36)', (col) => col.notNull().references('test_runs.id').onDelete('cascade'))
    .addColumn('test_plan_case_id', 'varchar(36)', (col) => col.notNull().references('test_plan_cases.id').onDelete('cascade'))
    .addColumn('test_result_id', 'varchar(36)', (col) => col.notNull().references('test_results.id').onDelete('cascade'))
    .addColumn('kind', 'varchar(10)', (col) => col.notNull())
    .addColumn('media_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('size_bytes', 'bigint', (col) => col.notNull())
    .addColumn('sha256', 'varchar(64)', (col) => col.notNull())
    .addColumn('storage_key', 'varchar(255)', (col) => col.notNull().unique())
    // A user's id, or an API token's (as test_results.tester_id).
    .addColumn('uploaded_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('actor_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('uploaded_via', 'varchar(10)', (col) => col.notNull())
    .addColumn('after_close', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await sql`CREATE INDEX idx_evidence_execution ON evidence (test_run_id, test_plan_case_id, created_at)`.execute(db);
  await sql`CREATE INDEX idx_evidence_checksum ON evidence (test_run_id, test_plan_case_id, sha256)`.execute(db);
  await sql`CREATE INDEX idx_evidence_result ON evidence (test_result_id)`.execute(db);

  await db.schema
    .createTable('storage_deletions')
    .addColumn('storage_key', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await sql`
    CREATE OR REPLACE FUNCTION queue_evidence_file_deletion()
    RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO storage_deletions (storage_key, attempts, created_at)
      VALUES (OLD.storage_key, 0, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ON CONFLICT (storage_key) DO NOTHING;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_evidence_file_deletion
    AFTER DELETE ON evidence
    FOR EACH ROW EXECUTE FUNCTION queue_evidence_file_deletion();
  `.execute(db);

  await db.schema
    .createTable('evidence_uploads')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('token_hash', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('test_run_id', 'varchar(36)', (col) => col.notNull().references('test_runs.id').onDelete('cascade'))
    .addColumn('test_plan_case_id', 'varchar(36)', (col) => col.notNull().references('test_plan_cases.id').onDelete('cascade'))
    .addColumn('test_result_id', 'varchar(36)', (col) => col.notNull().references('test_results.id').onDelete('cascade'))
    .addColumn('created_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('actor_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('created_via', 'varchar(10)', (col) => col.notNull())
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('size_bytes', 'bigint', (col) => col.notNull())
    .addColumn('sha256', 'varchar(64)', (col) => col.notNull())
    .addColumn('storage_key', 'varchar(255)', (col) => col.notNull().unique())
    // pending: waiting for the file; receiving: being uploaded through Tessick; done: it's evidence
    // (`evidence_id`), whose row now owns the stored file.
    .addColumn('status', 'varchar(10)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('evidence_id', 'varchar(36)')
    .addColumn('expires_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema.alterTable('test_runs').addColumn('closed_at', 'varchar(30)').execute();
  await sql`UPDATE test_runs SET closed_at = updated_at WHERE status = 'CLOSED'`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION keep_test_run_closed_at()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.status = 'CLOSED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'CLOSED') THEN
        NEW.closed_at := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      ELSIF NEW.status <> 'CLOSED' THEN
        NEW.closed_at := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_test_run_closed_at
    BEFORE INSERT OR UPDATE OF status ON test_runs
    FOR EACH ROW EXECUTE FUNCTION keep_test_run_closed_at();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_test_run_closed_at ON test_runs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS keep_test_run_closed_at()`.execute(db);
  await db.schema.alterTable('test_runs').dropColumn('closed_at').execute();
  await db.schema.dropTable('evidence_uploads').execute();
  await sql`DROP TRIGGER IF EXISTS trg_evidence_file_deletion ON evidence`.execute(db);
  await sql`DROP FUNCTION IF EXISTS queue_evidence_file_deletion()`.execute(db);
  await db.schema.dropTable('evidence').execute();
  await db.schema.dropTable('storage_deletions').execute();
}
