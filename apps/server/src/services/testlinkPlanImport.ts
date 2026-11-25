import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { CompatPlatformRepository, type Database } from '@tessick/db';
import { MAX_NAME_LENGTH, projectCaseId, withoutNul, type TestLinkPlanFile } from '@tessick/core';
import { innerRequest, type InnerResponse } from '../internalRequests.js';
import { writeAudit } from '../audit.js';
import { emitImportCompleted, webhookActor } from './webhookEvents.js';

/**
 * Importing a TestLink test plan export (routes/ingestion.ts, `imports/testlink-plan/...`): the
 * plan's cases are found in the project by their TestLink number (`12` → `PREFIX-12`, as the test
 * case import numbers them), and added to a new plan, or to an existing one, in TestLink's
 * execution order.
 *
 * Everything is done through the ordinary routes as the caller (internalRequests.ts), as bulk
 * changes are: creating the plan, approving drafts when asked, adding each case. So the rules are
 * those of the app: only an approved case can be added (its latest version is pinned), a
 * deprecated one never; each change writes its own audit row. Like a bulk change it isn't one
 * transaction, and the answer says what happened to each case.
 *
 * Tessick has no platforms. A case linked on several platforms is added once, and the platforms
 * are linked to the plan for the TestLink-compatible API, which takes results per platform.
 */

export const TESTLINK_PLAN_FORMAT = 'TESTLINK_PLAN_XML';

export type PlanImportState = 'READY' | 'DRAFT' | 'DEPRECATED' | 'NOT_FOUND' | 'ALREADY_IN_PLAN';
export type PlanImportOutcome = 'ADDED' | 'ALREADY_IN_PLAN' | 'SKIPPED' | 'FAILED';

export interface PlanImportItem {
  /** The case's number in the file (TestLink's `<externalid>`) */
  testlink_external_id: string;
  /** Its id in this project (`PREFIX-12`), or null when the file gave none */
  external_id: string | null;
  /** The case's name in the file */
  file_name: string;
  /** The TestLink version the plan held (Tessick pins the case's current approved version) */
  testlink_version: number | null;
  test_case_id: string | null;
  /** The case's title in Tessick */
  title: string | null;
  state: PlanImportState;
  /** Tessick's title isn't the file's name (renamed since, or another project's case) */
  title_differs: boolean;
}

export interface PlanImportResultItem extends PlanImportItem {
  outcome: PlanImportOutcome;
  /** The draft was approved by this import */
  approved: boolean;
  code?: string;
  detail?: string;
}

export interface PlanImportWarning {
  code: string;
  message: string;
}

export interface PlanImportPreview {
  object: 'testlink_plan_preview';
  plan_name: string;
  /** The project's plans already named like the file's plan */
  matching_plans: Array<{ id: string; name: string; status: string }>;
  platforms: string[];
  summary: { links: number; total: number; ready: number; draft: number; deprecated: number; not_found: number; already_in_plan: number; title_differs: number };
  items: PlanImportItem[];
  warnings: PlanImportWarning[];
}

export interface PlanImportOptions {
  /** A name for the new plan (default: the file's) */
  plan_name?: string;
  /** Add to this plan instead of creating one */
  test_plan_id?: string;
  /** Approve the plan's DRAFT cases (needs SPEC_APPROVE) so they can be added */
  approve_drafts?: boolean;
}

const sameTitle = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);

/** The plan's name for a new plan: the one given, else the file's, cut to what the database holds. */
export function planNameFor(file: TestLinkPlanFile, options: PlanImportOptions): string {
  const name = withoutNul(options.plan_name ?? '').trim() || withoutNul(file.name).trim() || 'Imported test plan';
  return name.slice(0, MAX_NAME_LENGTH);
}

/** What importing the file into the project would do (into `targetPlanId`, when given); writes nothing. */
export async function previewPlanImport(
  db: Kysely<Database>,
  project: { id: string; prefix: string },
  file: TestLinkPlanFile,
  targetPlanId?: string
): Promise<PlanImportPreview> {
  // TestLink's order, then the file's; a case on several platforms once, where it comes first.
  const ordered = file.links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => (a.link.execution_order ?? Infinity) - (b.link.execution_order ?? Infinity) || a.index - b.index)
    .map(({ link }) => link);
  const links: typeof ordered = [];
  const seen = new Set<string>();
  for (const link of ordered) {
    const key = link.external_id ? `id:${link.external_id}` : `name:${link.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }

  const ids = [...new Set(links.map((l) => projectCaseId(l.external_id, project.prefix)).filter((id): id is string => !!id))];
  const cases = ids.length
    ? await db.selectFrom('test_cases').select(['id', 'external_id', 'title']).where('project_id', '=', project.id).where('external_id', 'in', ids).execute()
    : [];
  const caseById = new Map(cases.map((c) => [c.external_id, c]));
  const latestStatus = new Map<string, { version_number: number; status: string }>();
  if (cases.length) {
    const versions = await db
      .selectFrom('test_case_versions')
      .select(['test_case_id', 'version_number', 'status'])
      .where('test_case_id', 'in', cases.map((c) => c.id))
      .execute();
    for (const v of versions) {
      const latest = latestStatus.get(v.test_case_id);
      if (!latest || v.version_number > latest.version_number) latestStatus.set(v.test_case_id, v);
    }
  }
  const inPlan = new Set<string>();
  if (targetPlanId) {
    const rows = await db.selectFrom('test_plan_cases').select('test_case_id').where('test_plan_id', '=', targetPlanId).where('removed_at', 'is', null).execute();
    for (const r of rows) inPlan.add(r.test_case_id);
  }

  const items: PlanImportItem[] = links.map((link) => {
    const externalId = projectCaseId(link.external_id, project.prefix) ?? null;
    const found = externalId ? caseById.get(externalId) : undefined;
    const status = found ? latestStatus.get(found.id)?.status : undefined;
    const state: PlanImportState = !found
      ? 'NOT_FOUND'
      : inPlan.has(found.id)
        ? 'ALREADY_IN_PLAN'
        : status === 'APPROVED'
          ? 'READY'
          : status === 'DEPRECATED'
            ? 'DEPRECATED'
            : 'DRAFT';
    return {
      testlink_external_id: link.external_id,
      external_id: externalId,
      file_name: link.name,
      testlink_version: link.version,
      test_case_id: found?.id ?? null,
      title: found?.title ?? null,
      state,
      title_differs: !!found && !sameTitle(found.title, link.name),
    };
  });

  const count = (state: PlanImportState) => items.filter((i) => i.state === state).length;
  const summary = {
    links: file.links.length,
    total: items.length,
    ready: count('READY'),
    draft: count('DRAFT'),
    deprecated: count('DEPRECATED'),
    not_found: count('NOT_FOUND'),
    already_in_plan: count('ALREADY_IN_PLAN'),
    title_differs: items.filter((i) => i.title_differs).length,
  };

  const planName = planNameFor(file, {});
  const matchingPlans = await db
    .selectFrom('test_plans')
    .select(['id', 'name', 'status'])
    .where('project_id', '=', project.id)
    .execute()
    .then((plans) => plans.filter((p) => p.name.trim().toLowerCase() === planName.toLowerCase()));

  const warnings: PlanImportWarning[] = [];
  if (items.length === 0) warnings.push({ code: 'NO_CASES', message: 'The file lists no test cases.' });
  const found = items.length - summary.not_found;
  if (items.length > 0 && (summary.not_found > items.length / 2 || summary.title_differs > found / 2)) {
    warnings.push({
      code: 'OTHER_PROJECT_LIKELY',
      message: `Most of the plan's cases are missing from this project or have other titles. The file may come from another TestLink project, or its cases may have been imported into a project with another prefix (cases are found by their TestLink number: ${project.prefix}-<number>).`,
    });
  }
  if (summary.not_found > 0) {
    warnings.push({
      code: 'CASES_NOT_FOUND',
      message: `${summary.not_found} of the plan's cases aren't in this project. Import the project's test cases from TestLink first ("TestLink XML"), into a project with TestLink's prefix.`,
    });
  }
  if (summary.title_differs > 0) {
    warnings.push({
      code: 'TITLES_DIFFER',
      message: `${summary.title_differs} cases have another title here than in the plan file: renamed since the test cases were exported, or another project's cases. They're found by their number all the same.`,
    });
  }
  if (summary.draft > 0) {
    warnings.push({
      code: 'DRAFT_CASES',
      message: `${summary.draft} cases are drafts, and a plan takes only approved cases. Approve them with this import, or approve them later and import the plan again into the same plan.`,
    });
  }
  if (summary.deprecated > 0) {
    warnings.push({ code: 'DEPRECATED_CASES', message: `${summary.deprecated} cases are deprecated here, so they can't be added.` });
  }
  if (file.platforms.length > 0) {
    warnings.push({
      code: 'PLATFORMS',
      message: `Tessick has no platforms: each case is added once. The plan's platforms (${file.platforms.join(', ')}) are linked to it for scripts using the TestLink-compatible API, which records results per platform.`,
    });
  }

  return { object: 'testlink_plan_preview', plan_name: planName, matching_plans: matchingPlans, platforms: file.platforms, summary, items, warnings };
}

export type PlanImportExecution =
  | { ok: true; body: Record<string, unknown> }
  // The plan couldn't be created or used: a refusal of the route it called, or a locked plan.
  | { ok: false; status: number; code: string; detail: string; invalid_params?: unknown };

const failure = (res: Pick<InnerResponse, 'status' | 'body'>) => ({
  code: (res.body?.code as string | undefined) ?? 'ERROR',
  detail: (res.body?.detail as string | undefined) ?? `Failed with HTTP ${res.status}`,
});

/**
 * Imports the plan: the caller's permissions (IMPORT_DATA, PLAN_MANAGE and, with approve_drafts,
 * SPEC_APPROVE) are checked by the route first.
 */
export async function executePlanImport(
  request: FastifyRequest,
  db: Kysely<Database>,
  project: { id: string; prefix: string },
  file: TestLinkPlanFile,
  options: PlanImportOptions
): Promise<PlanImportExecution> {
  const refused = (res: Pick<InnerResponse, 'status' | 'body'>): PlanImportExecution => ({
    ok: false,
    status: res.status,
    ...failure(res),
    ...(res.body?.invalid_params ? { invalid_params: res.body.invalid_params } : {}),
  });
  let plan: { id: string; name: string; status: string; project_id: string };
  const planCreated = !options.test_plan_id;
  if (options.test_plan_id) {
    const res = await innerRequest(request, 'bulk', 'GET', `/api/v1/plans/${encodeURIComponent(options.test_plan_id)}`);
    if (res.status >= 400 || res.body.plan.project_id !== project.id) {
      return refused(res.status >= 400 ? res : { status: 404, body: { code: 'NOT_FOUND', detail: 'Test plan not found' } });
    }
    plan = res.body.plan;
    if (plan.status !== 'ACTIVE') {
      return refused({ status: 422, body: { code: 'PLAN_LOCKED', detail: `The test plan "${plan.name}" is ${plan.status.toLowerCase()}, so cases can't be added to it.` } });
    }
  } else {
    const res = await innerRequest(request, 'bulk', 'POST', `/api/v1/projects/${project.id}/plans`, { name: planNameFor(file, options) });
    if (res.status >= 400) return refused(res);
    plan = res.body.plan;
  }

  const preview = await previewPlanImport(db, project, file, planCreated ? undefined : plan.id);
  const items: PlanImportResultItem[] = [];
  for (const item of preview.items) {
    const result: PlanImportResultItem = { ...item, outcome: 'SKIPPED', approved: false };
    items.push(result);
    if (item.state === 'ALREADY_IN_PLAN') {
      result.outcome = 'ALREADY_IN_PLAN';
      continue;
    }
    if (item.state === 'DRAFT' && options.approve_drafts) {
      const latest = await db
        .selectFrom('test_case_versions')
        .select('id')
        .where('test_case_id', '=', item.test_case_id!)
        .orderBy('version_number', 'desc')
        .executeTakeFirst();
      const res = latest
        ? await innerRequest(request, 'bulk', 'POST', `/api/v1/versions/${latest.id}/approve`)
        : { status: 422, body: { code: 'NO_VERSION', detail: 'The case has no version' } };
      if (res.status >= 400) {
        Object.assign(result, { outcome: 'FAILED', ...failure(res) });
        continue;
      }
      result.approved = true;
    } else if (item.state !== 'READY') {
      continue;
    }
    const res = await innerRequest(request, 'bulk', 'POST', `/api/v1/plans/${plan.id}/cases`, { test_case_id: item.test_case_id });
    if (res.status >= 400) Object.assign(result, { outcome: 'FAILED', ...failure(res) });
    else result.outcome = res.status === 201 ? 'ADDED' : 'ALREADY_IN_PLAN';
  }

  if (file.platforms.length > 0) {
    const platforms = new CompatPlatformRepository(db);
    const existing = await platforms.listForProject(project.id);
    const ids: string[] = [];
    for (const name of file.platforms.map((n) => withoutNul(n).trim().slice(0, MAX_NAME_LENGTH)).filter(Boolean)) {
      const known = existing.find((p) => p.name.toLowerCase() === name.toLowerCase());
      ids.push(known ? known.id : (await platforms.create(project.id, name)).id);
    }
    await platforms.linkToPlan(plan.id, ids);
    await writeAudit(db, request, { action: 'PLAN_PLATFORMS_LINKED', resourceType: 'plan', resourceId: plan.id, projectId: project.id, diff: { platforms: file.platforms } });
  }

  const outcomes = (o: PlanImportOutcome) => items.filter((i) => i.outcome === o).length;
  const summary = {
    total: items.length,
    added: outcomes('ADDED'),
    approved: items.filter((i) => i.approved).length,
    already_in_plan: outcomes('ALREADY_IN_PLAN'),
    skipped: outcomes('SKIPPED'),
    failed: outcomes('FAILED'),
  };
  await writeAudit(db, request, {
    action: 'IMPORT_EXECUTED',
    resourceType: 'plan',
    resourceId: plan.id,
    projectId: project.id,
    diff: { format: TESTLINK_PLAN_FORMAT, plan_created: planCreated, ...summary },
  });
  await emitImportCompleted(db, webhookActor(request.user!), project.id, TESTLINK_PLAN_FORMAT, {
    plan_name: plan.name,
    added_cases_count: summary.added,
    approved_cases_count: summary.approved,
    already_in_plan_count: summary.already_in_plan,
    skipped_cases_count: summary.skipped,
    failed_cases_count: summary.failed,
  });

  return {
    ok: true,
    body: {
      object: 'testlink_plan_import_result',
      plan,
      plan_created: planCreated,
      platforms: file.platforms,
      summary,
      items,
      warnings: preview.warnings,
    },
  };
}
