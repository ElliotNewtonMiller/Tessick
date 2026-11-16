import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CompatIdRepository,
  CustomFieldRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
  TestSuiteRepository,
  type CustomFieldDefinition,
  type Project,
} from '@tessick/db';
import { cleanHtmlText, customFieldValueFromString, keywordKey, parseCustomFieldValue, type CustomFieldType } from '@tessick/core';
import { innerRequest } from '../internalRequests.js';
import { permissionsInProject } from '../middleware/auth.js';
import { INSUFFICIENT_RIGHTS, tlKo } from './envelope.js';
import type { CompatContext } from './index.js';
import { findProject, isDurationField, isKeywordsField, projectAccess, type ProjectAccess } from './projectData.js';

/**
 * What the TestLink-compatible API's writes share. Every change goes through Tessick's own route,
 * as the key's user (an inner request, `via: 'testlink'`), so permissions, validation, audit
 * rows and webhooks are Tessick's; a refusal comes back in TestLink's envelope.
 */

export interface TessickAnswer {
  ok: boolean;
  status: number;
  body: any;
  /** A refusal's message (problem details' `detail`). */
  detail: string;
}

/** Calls one of Tessick's routes as the key's user. */
export async function asUser(
  request: FastifyRequest,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  opts: { startDraft?: boolean } = {}
): Promise<TessickAnswer> {
  const res = await innerRequest(request, 'testlink', method, url, payload, { asUserId: request.user!.id, startDraft: opts.startDraft });
  const detail = typeof res.body?.detail === 'string' ? res.body.detail : typeof res.body === 'string' ? res.body : 'error';
  return { ok: res.status < 300, status: res.status, body: res.body, detail };
}

/**
 * Tessick's refusal as TestLink's: 403 is "Insufficient rights" (Tessick's reason in `detail`),
 * 404 and 409 stay, a refusal of the current state (422: a closed run, a version not a draft)
 * is a 409, anything else a 400; `extra` adds the route's own fields (`id: -1`).
 */
export function refuse(reply: FastifyReply, res: TessickAnswer, extra: Record<string, unknown> = {}) {
  if (res.status === 403) return tlKo(reply, 403, INSUFFICIENT_RIGHTS, { ...extra, detail: res.detail });
  if (res.status >= 500) return tlKo(reply, 500, `Server error: ${res.detail}`, extra);
  const http = res.status === 404 || res.status === 409 ? res.status : res.status === 422 ? 409 : 400;
  return tlKo(reply, http, res.detail, extra);
}

/** TestLink's answer to a body without a property it needs. */
export const missing = (reply: FastifyReply, name: string, extra: Record<string, unknown> = { id: -1 }) =>
  tlKo(reply, 400, `Missing required property: ${name}`, extra);

/** The JSON body as an object ({} when there's none, or it isn't one). */
export function bodyOf(request: FastifyRequest): Record<string, any> {
  const body = request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, any>) : {};
}

/** A value given, i.e. not missing, null or an empty string. */
export const given = (v: unknown) => v !== undefined && v !== null && v !== '';

/** TestLink's HTML as Tessick's text (as the TestLink XML importer does). */
export const textOf = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : cleanHtmlText(String(v)));

/**
 * A project a write names: a number or a name/prefix (`testProjectID`), or an object with
 * `id` or `prefix` (or `name`), as v2 and custom send them. Only a project the caller can see.
 */
export async function projectFromRef(request: FastifyRequest, ctx: CompatContext, ref: unknown): Promise<{ project: Project; access: ProjectAccess } | undefined> {
  if (ref && typeof ref === 'object') {
    const r = ref as Record<string, unknown>;
    const card = given(r.id) ? r.id : given(r.prefix) ? r.prefix : r.name;
    if (!given(card)) return undefined;
    // A prefix is looked up as v2 and custom do, whatever the version.
    return findProject(request, { ...ctx, version: given(r.prefix) && !given(r.id) ? 'custom' : ctx.version }, String(card));
  }
  return given(ref) ? findProject(request, ctx, String(ref)) : undefined;
}

/** A Tessick row behind a TestLink number. */
async function byNumber(ctx: CompatContext, type: 'suite' | 'case' | 'plan' | 'build', value: unknown): Promise<string | undefined> {
  if (!given(value) || !/^\d+$/.test(String(value))) return undefined;
  return new CompatIdRepository(ctx.db).entityId(type, Number(value));
}

/** A plan by its number, in a project the caller can see. */
export async function planByNumber(request: FastifyRequest, ctx: CompatContext, value: unknown) {
  const id = await byNumber(ctx, 'plan', value);
  const plan = id ? await new TestPlanRepository(ctx.db).findById(id) : undefined;
  if (!plan) return undefined;
  const access = await projectAccess(request, ctx, plan.project_id);
  return access.visible ? { plan, access } : undefined;
}

/** A suite by its number, in a project the caller can see. */
export async function suiteByNumber(request: FastifyRequest, ctx: CompatContext, value: unknown) {
  const id = await byNumber(ctx, 'suite', value);
  const suite = id ? await new TestSuiteRepository(ctx.db).findById(id) : undefined;
  if (!suite) return undefined;
  const access = await projectAccess(request, ctx, suite.project_id);
  return access.visible ? { suite, access } : undefined;
}

/** A run by its build number (the run of the build itself). */
export async function buildRunId(ctx: CompatContext, value: unknown): Promise<string | undefined> {
  return byNumber(ctx, 'build', value);
}

/** A case by its number or its external id (MA-1), in a project the caller can see. */
export async function caseByRef(request: FastifyRequest, ctx: CompatContext, value: unknown) {
  if (!given(value)) return undefined;
  const cases = new TestCaseRepository(ctx.db);
  let found;
  const id = await byNumber(ctx, 'case', value);
  if (id) {
    found = await cases.findById(id);
  } else {
    // An external id names one case per project; take the one the caller can see.
    const rows = await ctx.db.selectFrom('test_cases').selectAll().where('external_id', '=', String(value).trim()).execute();
    for (const row of rows) {
      if ((await projectAccess(request, ctx, row.project_id)).visible) {
        found = row;
        break;
      }
    }
  }
  if (!found) return undefined;
  const access = await projectAccess(request, ctx, found.project_id);
  return access.visible ? { testCase: found, access } : undefined;
}

export async function latestVersion(ctx: CompatContext, caseId: string) {
  return new TestCaseVersionRepository(ctx.db).findLatestVersion(caseId);
}

/** Another case with this title in the suite (TestLink refuses a duplicate name in a suite). */
export async function duplicateTitle(ctx: CompatContext, suiteId: string, title: string, exceptCaseId?: string): Promise<boolean> {
  let query = ctx.db.selectFrom('test_cases').select('id').where('test_suite_id', '=', suiteId).where('title', '=', title);
  if (exceptCaseId) query = query.where('id', '<>', exceptCaseId);
  return Boolean(await query.executeTakeFirst());
}

export const DUPLICATE_CASE = 'Test case name already exists on this suite';

/** A TestLink test step as Tessick's. */
export function stepsFrom(steps: unknown): Array<{ step_number: number; action: string; expected_result: string; execution_type: string }> | undefined {
  if (!Array.isArray(steps)) return undefined;
  return steps.map((s: any, i) => ({
    step_number: Number.isInteger(Number(s?.step_number)) && Number(s.step_number) > 0 ? Number(s.step_number) : i + 1,
    action: textOf(s?.actions) ?? '',
    expected_result: textOf(s?.expected_results) ?? '',
    execution_type: Number(s?.execution_type) === 2 ? 'AUTOMATED' : 'MANUAL',
  }));
}

/** A project's case fields, as the writes need them. */
export interface ProjectFields {
  /** Fields TestLink calls custom fields, by name and by their numeric id. */
  byName: Map<string, CustomFieldDefinition>;
  byNumber: Map<number, CustomFieldDefinition>;
  keywords?: CustomFieldDefinition;
  duration?: CustomFieldDefinition;
  /** Keyword numbers → keyword (the keywords field's option values). */
  keywordByNumber: Map<number, string>;
}

export async function projectFields(ctx: CompatContext, projectId: string): Promise<ProjectFields> {
  const definitions = await new CustomFieldRepository(ctx.db).listVisibleToProject(projectId, 'TestCase');
  const keywords = definitions.find(isKeywordsField);
  const duration = definitions.find(isDurationField);
  const shown = definitions.filter((d) => d !== keywords && d !== duration);
  const ids = new CompatIdRepository(ctx.db);
  const numbers = await ids.intIds('customfield', shown.map((d) => d.id));
  const keywordValues = keywords?.options.map((o) => o.option_value) ?? [];
  const keywordNumbers = keywords ? await ids.intIds('keyword', keywordValues.map((v) => keywordKey(keywords.id, v))) : new Map<string, number>();
  return {
    byName: new Map(shown.map((d) => [d.name, d])),
    byNumber: new Map(shown.map((d) => [numbers.get(d.id)!, d])),
    keywords,
    duration,
    keywordByNumber: new Map(keywordValues.map((v) => [keywordNumbers.get(keywordKey(keywords!.id, v))!, v])),
  };
}

/** A value to write to one of a case's fields. */
export interface FieldWrite {
  definition: CustomFieldDefinition;
  value: unknown;
}

/**
 * A write's `customFields`, `keywords` and `estimatedExecDuration` as values for the case's
 * fields, checked before anything is changed. `customFields` keys are a field's name or its
 * number; unknown ones are skipped, as TestLink does. Unknown keyword numbers are skipped too.
 * A value the field can't take is refused, naming the field.
 */
export function fieldWrites(body: Record<string, any>, fields: ProjectFields): { writes: FieldWrite[] } | { problem: string } {
  const writes: FieldWrite[] = [];
  const check = (definition: CustomFieldDefinition, raw: unknown, label: string): string | undefined => {
    const value = customFieldValueFromString(definition.field_type, raw);
    try {
      parseCustomFieldValue(definition.field_type as CustomFieldType, value, {
        isRequired: definition.is_required,
        options: definition.options,
        validationRegex: definition.validation_regex,
      } as any);
    } catch (err: any) {
      return `${label}: ${String(err?.message ?? err).replace(/^[A-Z_]+: /, '')}`;
    }
    writes.push({ definition, value });
    return undefined;
  };
  const custom = body.customFields;
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    for (const [key, raw] of Object.entries(custom)) {
      const definition = fields.byName.get(key) ?? (/^\d+$/.test(key) ? fields.byNumber.get(Number(key)) : undefined);
      if (!definition) continue;
      const problem = check(definition, raw, `customFields.${key}`);
      if (problem) return { problem };
    }
  }
  if (Array.isArray(body.keywords) && fields.keywords) {
    const names = body.keywords.map((k: unknown) => fields.keywordByNumber.get(Number(k))).filter((k: string | undefined): k is string => Boolean(k));
    writes.push({ definition: fields.keywords, value: [...new Set(names)] });
  }
  if (given(body.estimatedExecDuration) && fields.duration) {
    const problem = check(fields.duration, body.estimatedExecDuration, 'estimatedExecDuration');
    if (problem) return { problem };
  }
  return { writes };
}

/** Writes the fields through Tessick's route; the first refusal, if any. */
export async function writeFields(request: FastifyRequest, caseId: string, writes: FieldWrite[]): Promise<TessickAnswer | undefined> {
  for (const w of writes) {
    const res = await asUser(request, 'PUT', `/api/v1/cases/${caseId}/custom-fields/${w.definition.id}`, { value: w.value });
    if (!res.ok) return res;
  }
  return undefined;
}

/**
 * Takes a case's latest version from where it is to `target` through Tessick's lifecycle
 * routes (approve, deprecate, restore, a new draft). The first refusal, if any.
 */
export async function moveToStatus(request: FastifyRequest, ctx: CompatContext, caseId: string, target: 'DRAFT' | 'APPROVED' | 'DEPRECATED'): Promise<TessickAnswer | undefined> {
  for (let step = 0; step < 3; step++) {
    const latest = await latestVersion(ctx, caseId);
    if (!latest || latest.status === target) return undefined;
    let res: TessickAnswer;
    if (latest.status === 'DEPRECATED') res = await asUser(request, 'POST', `/api/v1/versions/${latest.id}/restore`);
    else if (latest.status === 'DRAFT') res = await asUser(request, 'POST', `/api/v1/versions/${latest.id}/approve`);
    else if (target === 'DEPRECATED') res = await asUser(request, 'POST', `/api/v1/versions/${latest.id}/deprecate`);
    else res = await asUser(request, 'POST', `/api/v1/cases/${caseId}/versions`);
    if (!res.ok) return res;
  }
  return undefined;
}

/** Whether the caller may approve, deprecate and restore in the project. */
export async function mayApprove(request: FastifyRequest, ctx: CompatContext, projectId: string): Promise<boolean> {
  const permissions = await permissionsInProject(request.user!, projectId, ctx.db);
  return permissions.includes('SYSTEM_ADMIN') || permissions.includes('SPEC_APPROVE');
}
