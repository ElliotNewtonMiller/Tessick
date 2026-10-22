import { sql, type Kysely } from 'kysely';

/**
 * A custom field applies to all projects, or to a chosen set of them (it used to be one project
 * at most: `project_id`). `applies_to_all_projects` says which, and `custom_field_projects` lists
 * the projects otherwise. Fields that had a `project_id` (made by imports) keep that one project.
 *
 * Name uniqueness: an all-projects field's name is unique among all-projects fields (the index
 * below, as before for global fields); fields for chosen projects are checked by the repository,
 * since their scope is a list (CustomFieldRepository.nameTaken).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('custom_field_projects')
    .addColumn('custom_field_definition_id', 'varchar(36)', (col) => col.notNull().references('custom_field_definitions.id').onDelete('cascade'))
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_custom_field_projects', ['custom_field_definition_id', 'project_id'])
    .execute();
  await db.schema.createIndex('idx_custom_field_projects_project').on('custom_field_projects').column('project_id').execute();

  await db.schema
    .alterTable('custom_field_definitions')
    .addColumn('applies_to_all_projects', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();
  await sql`
    INSERT INTO custom_field_projects (custom_field_definition_id, project_id, created_at)
    SELECT id, project_id, created_at FROM custom_field_definitions WHERE project_id IS NOT NULL
  `.execute(db);
  await sql`UPDATE custom_field_definitions SET applies_to_all_projects = 0 WHERE project_id IS NOT NULL`.execute(db);

  await sql`DROP INDEX IF EXISTS uq_custom_field_def_project_scope`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_custom_field_def_global_scope`.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_custom_field_def_all_projects
    ON custom_field_definitions (entity_type, name)
    WHERE applies_to_all_projects = 1
  `.execute(db);
  await db.schema.alterTable('custom_field_definitions').dropColumn('project_id').execute();
}

/** Back to one project per field: a field for several projects keeps one of them. */
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('custom_field_definitions')
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('restrict'))
    .execute();
  await sql`
    UPDATE custom_field_definitions d SET project_id = (
      SELECT MIN(p.project_id) FROM custom_field_projects p WHERE p.custom_field_definition_id = d.id
    ) WHERE d.applies_to_all_projects = 0
  `.execute(db);
  await sql`DROP INDEX IF EXISTS uq_custom_field_def_all_projects`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_custom_field_def_global_scope ON custom_field_definitions (entity_type, name) WHERE project_id IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_custom_field_def_project_scope ON custom_field_definitions (project_id, entity_type, name) WHERE project_id IS NOT NULL`.execute(db);
  await db.schema.alterTable('custom_field_definitions').dropColumn('applies_to_all_projects').execute();
  await db.schema.dropTable('custom_field_projects').execute();
}
