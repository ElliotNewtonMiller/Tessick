import type { Kysely } from 'kysely';

/**
 * TestLink's platforms, for the TestLink-compatible API (testlinkCompat/). Testify has no
 * platforms of its own: a TestLink build of a plan with platforms is a run per platform.
 *
 * - `compat_platforms`: a project's platforms (made by the migration from TestLink, phase 5).
 * - `compat_plan_platforms`: the platforms linked to a plan (POST /testplans/{id}/platforms).
 * - `compat_platform_runs`: for a build (its own run) and a platform, the run that platform's
 *   results go in, made on the first result. The build's own run is what lists as the build.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('compat_platforms')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('notes', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_compat_platforms_name', ['project_id', 'name'])
    .execute();

  await db.schema
    .createTable('compat_plan_platforms')
    .addColumn('test_plan_id', 'varchar(36)', (col) => col.notNull().references('test_plans.id').onDelete('cascade'))
    .addColumn('platform_id', 'varchar(36)', (col) => col.notNull().references('compat_platforms.id').onDelete('cascade'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_compat_plan_platforms', ['test_plan_id', 'platform_id'])
    .execute();

  await db.schema
    .createTable('compat_platform_runs')
    .addColumn('build_run_id', 'varchar(36)', (col) => col.notNull().references('test_runs.id').onDelete('cascade'))
    .addColumn('platform_id', 'varchar(36)', (col) => col.notNull().references('compat_platforms.id').onDelete('cascade'))
    .addColumn('run_id', 'varchar(36)', (col) => col.notNull().unique().references('test_runs.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('pk_compat_platform_runs', ['build_run_id', 'platform_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('compat_platform_runs').execute();
  await db.schema.dropTable('compat_plan_platforms').execute();
  await db.schema.dropTable('compat_platforms').execute();
}
