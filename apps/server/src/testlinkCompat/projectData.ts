import type { FastifyRequest } from 'fastify';
import {
  CompatApiKeyRepository,
  CompatIdRepository,
  CustomFieldRepository,
  ProjectRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestSuiteRepository,
  type CustomFieldDefinition,
  type Project,
} from '@testify/db';
import {
  SuiteTree,
  TL_CHECKBOX_VALUE,
  TL_DURATION_FIELD,
  TL_KEYWORDS_FIELD,
  TL_LIST_SEPARATOR,
  customFieldTypeCode,
  customFieldValueString,
  executionTypeCode,
  externalIdNumber,
  importanceCode,
  keywordKey,
  resolveDefaultValue,
  versionStatusCodes,
  type CustomFieldType,
  type TlCase,
  type TlCustomFieldDef,
  type TlCustomFieldEntry,
  type TlSuite,
} from '@testify/core';
import { permissionsInProject } from '../middleware/auth.js';
import type { CompatContext } from './index.js';

/**
 * Testify's rows as the TestLink-compatible API shows them: TestLink's numeric ids (compat_ids,
 * numbered the first time they're shown), codes and field names. Reads go straight to the
 * repositories; writes go through Testify's routes (phase 3).
 */

/** What the caller may do in a project, through this API. */
export interface ProjectAccess {
  /** Can see the project, its plans and builds (SPEC_VIEW or EXECUTE_RUN, as Testify's project list). */
  visible: boolean;
  /** Can read its specification (SPEC_VIEW). */
  spec: boolean;
}

export async function projectAccess(request: FastifyRequest, ctx: CompatContext, projectId: string): Promise<ProjectAccess> {
  const permissions = await permissionsInProject(request.user!, projectId, ctx.db);
  const admin = permissions.includes('SYSTEM_ADMIN');
  const spec = admin || permissions.includes('SPEC_VIEW');
  return { visible: spec || permissions.includes('EXECUTE_RUN'), spec };
}

/**
 * The project an `{id}` names, as TestLink reads it: a number is the project's id; anything else
 * its name (v1), or its name or prefix (v2 and custom). Names and prefixes ignore case. Only a
 * project the caller can see is found.
 */
export async function findProject(request: FastifyRequest, ctx: CompatContext, idCard: string): Promise<{ project: Project; access: ProjectAccess } | undefined> {
  const projects = new ProjectRepository(ctx.db);
  let project: Project | undefined;
  if (/^\d+$/.test(idCard)) {
    const id = await new CompatIdRepository(ctx.db).entityId('project', Number(idCard));
    project = id ? await projects.findById(id) : undefined;
  } else {
    const wanted = idCard.toLowerCase();
    const all = await projects.findAll();
    project = all.find((p) => p.name.toLowerCase() === wanted) ?? (ctx.version === 'v1' ? undefined : all.find((p) => p.prefix.toLowerCase() === wanted));
  }
  if (!project) return undefined;
  const access = await projectAccess(request, ctx, project.id);
  return access.visible ? { project, access } : undefined;
}

/** Projects as TestLink shows them (GET /testprojects). Testify has no inactive or private projects. */
export async function projectItems(ctx: CompatContext, projects: Project[]): Promise<Record<string, unknown>[]> {
  const ids = await new CompatIdRepository(ctx.db).intIds('project', projects.map((p) => p.id));
  const keys = new CompatApiKeyRepository(ctx.db);
  const out: Record<string, unknown>[] = [];
  for (const p of projects) {
    out.push({ id: ids.get(p.id), name: p.name, prefix: p.prefix, notes: p.description ?? '', active: 1, is_public: 1, api_key: await keys.keyFor('project', p.id) });
  }
  return out;
}

/** A project's specification, as TestLink rows. */
export interface ProjectSpec {
  projectIntId: number;
  suites: TlSuite[];
  cases: TlCase[];
  tree: SuiteTree;
  /** The project's case custom fields, without the ones shown as keywords and duration. */
  customFields: TlCustomFieldDef[];
  keywords: Array<{ id: number; keyword: string; notes: string }>;
  /** Testify's suite id for each numeric one. */
  suiteUuid: Map<number, string>;
}

const byCreation = <T extends { created_at: string; id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

export const isKeywordsField = (d: CustomFieldDefinition) => d.name === TL_KEYWORDS_FIELD && d.field_type === 'MULTI_SELECT';
export const isDurationField = (d: CustomFieldDefinition) => d.name === TL_DURATION_FIELD && d.field_type === 'NUMBER';

function customFieldDef(d: CustomFieldDefinition, intId: number): TlCustomFieldDef {
  const { type, type_name } = customFieldTypeCode(d.field_type);
  const options = d.options.map((o) => o.option_value);
  const possible = d.field_type === 'CHECKBOX' ? TL_CHECKBOX_VALUE : options.join(TL_LIST_SEPARATOR);
  const fallback = resolveDefaultValue(d.field_type as CustomFieldType, d.default_value, { options: d.options });
  return {
    id: intId,
    name: d.name,
    label: d.field_label,
    type,
    type_name,
    possible_values: possible,
    default_value: customFieldValueString(d.field_type, fallback) ?? '',
    required: d.is_required ? 1 : 0,
    enabled_on_design: 1,
  };
}

/**
 * Loads a project's suites and cases (latest versions, with steps unless `steps` is false),
 * custom fields and keywords, numbering whatever hasn't a numeric id yet.
 */
export async function loadProjectSpec(ctx: CompatContext, projectId: string, opts: { steps?: boolean } = {}): Promise<ProjectSpec> {
  const db = ctx.db;
  const ids = new CompatIdRepository(db);
  const projectIntId = await ids.intId('project', projectId);
  const suiteRows = await new TestSuiteRepository(db).findByProject(projectId);
  const caseRows = (await new TestCaseRepository(db).findByProjectWithLatestVersion(projectId)).filter((c) => c.latest_version);
  const versionIds = caseRows.map((c) => c.latest_version!.id);
  const steps = opts.steps === false ? new Map() : await new TestCaseVersionRepository(db).getStepsForVersions(versionIds);

  const fieldsRepo = new CustomFieldRepository(db);
  const definitions = await fieldsRepo.listVisibleToProject(projectId, 'TestCase');
  const values = await fieldsRepo.getValuesForEntities('TestCase', caseRows.map((c) => c.id), projectId);
  const keywordsField = definitions.find(isKeywordsField);
  const durationField = definitions.find(isDurationField);
  const shownFields = definitions.filter((d) => d !== keywordsField && d !== durationField);

  // Rows not yet numbered get ids in the order they were made, as TestLink's would have.
  const [suiteIds, caseIds, versionIntIds, fieldIds, keywordIds] = [
    await ids.intIds('suite', byCreation(suiteRows).map((s) => s.id)),
    await ids.intIds('case', byCreation(caseRows).map((c) => c.id)),
    await ids.intIds('version', byCreation(caseRows).map((c) => c.latest_version!.id)),
    await ids.intIds('customfield', shownFields.map((d) => d.id)),
    await ids.intIds('keyword', (keywordsField?.options ?? []).map((o) => keywordKey(keywordsField!.id, o.option_value))),
  ];

  const suites: TlSuite[] = suiteRows.map((s) => ({
    id: suiteIds.get(s.id)!,
    name: s.name,
    parent_id: s.parent_suite_id ? suiteIds.get(s.parent_suite_id)! : projectIntId,
    parent_suite_id: s.parent_suite_id ? suiteIds.get(s.parent_suite_id)! : null,
    node_order: s.position,
  }));
  const paths = new SuiteTree(suites);
  const fieldDefs = new Map(shownFields.map((d) => [d.id, customFieldDef(d, fieldIds.get(d.id)!)]));
  const keywordByValue = new Map(
    (keywordsField?.options ?? []).map((o) => [o.option_value, { id: keywordIds.get(keywordKey(keywordsField!.id, o.option_value))!, keyword: o.option_value }])
  );

  const cases: TlCase[] = caseRows.map((c) => {
    const v = c.latest_version!;
    const suiteIntId = suiteIds.get(c.test_suite_id)!;
    const customfields: Record<string, TlCustomFieldEntry> = {};
    const keywords: Record<string, string> = {};
    let duration: string | null = null;
    for (const { definition, value } of values.get(c.id) ?? []) {
      if (definition.id === keywordsField?.id) {
        for (const k of Array.isArray(value) ? value : []) {
          const found = keywordByValue.get(String(k));
          if (found) keywords[String(found.id)] = found.keyword;
        }
      } else if (definition.id === durationField?.id) {
        duration = customFieldValueString(definition.field_type, value);
      } else {
        const def = fieldDefs.get(definition.id);
        if (def) customfields[String(def.id)] = { ...def, value: customFieldValueString(definition.field_type, value) };
      }
    }
    return {
      id: caseIds.get(c.id)!,
      tcversion_id: versionIntIds.get(v.id)!,
      name: c.title,
      external_id: c.external_id,
      tc_external_id: externalIdNumber(c.external_id),
      version: v.version_number,
      summary: v.summary ?? '',
      preconditions: v.preconditions ?? '',
      importance: importanceCode(c.priority),
      ...versionStatusCodes(v.status),
      execution_type: executionTypeCode(c.execution_type),
      estimated_exec_duration: duration,
      steps: (steps.get(v.id) ?? []).map((s: any) => ({
        step_number: s.step_number,
        actions: s.action,
        expected_results: s.expected_result,
        execution_type: executionTypeCode(s.execution_type),
      })),
      tsuite_id: suiteIntId,
      tsuite_name: paths.byId.get(suiteIntId)?.name ?? '',
      path: paths.path(suiteIntId),
      keywords,
      customfields,
    };
  });

  return {
    projectIntId,
    suites,
    cases,
    tree: new SuiteTree(suites, cases),
    customFields: [...fieldDefs.values()],
    keywords: [...keywordByValue.values()].map((k) => ({ ...k, notes: '' })),
    suiteUuid: new Map(suiteRows.map((s) => [suiteIds.get(s.id)!, s.id])),
  };
}
