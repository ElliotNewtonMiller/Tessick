import { sql, type Kysely } from 'kysely';
import { COMPAT_ID_SPACES, CustomFieldRepository, type CompatEntityType, type Database } from '@testify/db';
import { TL_KEYWORDS_FIELD, parseCustomFieldValue, type CustomFieldType } from '@testify/core';
import { v7 as uuidv7 } from 'uuid';

/**
 * What a TestLink XML import keeps for the TestLink-compatible API: the suites' and cases' own
 * TestLink ids, and the cases' keywords, so a spec moved by XML answers with TestLink's numbers.
 * (Versions and keywords have no ids in TestLink's XML: they're numbered when first shown.)
 */

/** Keeps a new row's TestLink id when that number is still free; true if it was kept. */
export async function keepTestLinkId(db: Kysely<Database>, type: CompatEntityType, entityId: string, intId: number): Promise<boolean> {
  const kept = await sql<{ int_id: number }>`
    insert into compat_ids (id_space, int_id, entity_type, entity_id, origin)
    values (${COMPAT_ID_SPACES[type]}, ${intId}, ${type}, ${entityId}, 'testlink')
    on conflict do nothing
    returning int_id`.execute(db);
  return kept.rows.length > 0;
}

/**
 * Adds keywords to a case: the project's `keywords` field (made, project-scoped, the first
 * time) gains any it lacks as options, and the case's value gains them.
 */
export async function addImportedKeywords(db: Kysely<Database>, projectId: string, caseId: string, keywords: string[]): Promise<void> {
  const wanted = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (wanted.length === 0) return;
  const fields = new CustomFieldRepository(db);
  let field = (await fields.listVisibleToProject(projectId, 'TestCase')).find((d) => d.name === TL_KEYWORDS_FIELD && d.field_type === 'MULTI_SELECT');
  const toOptions = (values: string[]) => values.map((v) => ({ option_label: v, option_value: v }));
  if (!field) {
    field = await fields.createDefinition({ entity_type: 'TestCase', name: TL_KEYWORDS_FIELD, field_label: 'Keywords', field_type: 'MULTI_SELECT', options: toOptions(wanted), project_ids: [projectId] });
  } else {
    const missing = wanted.filter((k) => !field!.options.some((o) => o.option_value === k));
    if (missing.length) field = (await fields.updateDefinition(field.id, { options: toOptions([...field.options.map((o) => o.option_value), ...missing]) }))!;
  }
  const row = await db
    .selectFrom('custom_field_values')
    .select(['id', 'json_value'])
    .where('custom_field_definition_id', '=', field.id)
    .where('entity_type', '=', 'TestCase')
    .where('entity_id', '=', caseId)
    .executeTakeFirst();
  let current: string[] = [];
  try {
    current = row?.json_value ? JSON.parse(row.json_value) : [];
  } catch {
    current = [];
  }
  const value = [...new Set([...(Array.isArray(current) ? current : []), ...wanted])];
  const typed = parseCustomFieldValue(field.field_type as CustomFieldType, value, { options: field.options });
  const now = new Date().toISOString();
  if (row) {
    await db.updateTable('custom_field_values').set({ ...typed, updated_at: now }).where('id', '=', row.id).execute();
  } else {
    await db
      .insertInto('custom_field_values')
      .values({ id: uuidv7(), custom_field_definition_id: field.id, entity_type: 'TestCase', entity_id: caseId, ...typed, created_at: now, updated_at: now })
      .execute();
  }
}
