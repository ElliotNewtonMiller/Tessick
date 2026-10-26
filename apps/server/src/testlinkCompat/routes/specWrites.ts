import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompatIdRepository, CustomFieldRepository } from '@testify/db';
import { TL_KEYWORDS_FIELD, executionTypeFromCode, keywordKey, priorityFromImportance, statusTarget } from '@testify/core';
import type { CompatContext, CompatRoute } from '../index.js';
import { ALL, CUSTOM, V2_UP } from '../versions.js';
import { INSUFFICIENT_RIGHTS, tlError, tlKo, tlOk } from '../envelope.js';
import { isKeywordsField } from '../projectData.js';
import {
  DUPLICATE_CASE,
  asUser,
  bodyOf,
  caseByRef,
  duplicateTitle,
  fieldWrites,
  given,
  latestVersion,
  mayApprove,
  missing,
  moveToStatus,
  projectFields,
  projectFromRef,
  refuse,
  stepsFrom,
  suiteByNumber,
  textOf,
  writeFields,
} from '../writes.js';
import { noProject } from './projects.js';

/**
 * Suites, cases and keywords. A case's content (summary, preconditions, steps) is versioned in
 * Testify and editable only in a draft, so changing an approved case through this API makes a
 * new DRAFT, as MCP does (decided with Elliot); `status: 7` approves it in the same request
 * (needs SPEC_APPROVE). Title, importance, execution type, custom fields and keywords change in
 * place, as in TestLink.
 */

const ID_FAIL = { id: -1 };

/** The parent a suite write names: the project itself (null, the top level) or a suite of it. */
async function parentSuite(request: FastifyRequest, ctx: CompatContext, projectId: string, parentRef: unknown): Promise<{ parentId: string | null } | undefined> {
  if (!given(parentRef)) return { parentId: null };
  if (Number(parentRef) === (await new CompatIdRepository(ctx.db).intId('project', projectId))) return { parentId: null };
  const found = await suiteByNumber(request, ctx, parentRef);
  return found && found.suite.project_id === projectId ? { parentId: found.suite.id } : undefined;
}

/** A case's fields and status, after it's made or its content changed. The first refusal, sent. */
async function finishCase(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CompatContext,
  caseId: string,
  writes: Parameters<typeof writeFields>[2],
  target: 'DRAFT' | 'APPROVED' | 'DEPRECATED' | undefined
): Promise<boolean> {
  const fieldRefusal = await writeFields(request, caseId, writes);
  if (fieldRefusal) {
    refuse(reply, fieldRefusal, ID_FAIL);
    return false;
  }
  if (target) {
    const refusal = await moveToStatus(request, ctx, caseId, target);
    if (refusal) {
      refuse(reply, refusal, ID_FAIL);
      return false;
    }
  }
  return true;
}

export const specWriteRoutes: CompatRoute[] = [
  {
    method: 'POST',
    path: '/testsuites',
    statuses: [500],
    versions: ALL,
    auth: true,
    // `parentID` is the project (or missing) for a top-level suite, or a suite to nest under.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      if (!given(b.name)) return missing(reply, 'name');
      const ref = given(b.testProjectID) ? b.testProjectID : b.testProject;
      if (!given(ref)) return missing(reply, 'testProjectID');
      const found = await projectFromRef(request, ctx, ref);
      if (!found) return tlKo(reply, 404, noProject(String(typeof ref === 'object' ? JSON.stringify(ref) : ref)), ID_FAIL);
      const parent = await parentSuite(request, ctx, found.project.id, b.parentID);
      if (!parent) return tlError(reply, 404, `No Test Project or Test Suite identified by '${b.parentID}' to use as parent!`, ID_FAIL);
      const res = await asUser(request, 'POST', `/api/v1/projects/${found.project.id}/suites`, {
        name: String(b.name),
        description: textOf(b.notes) ?? null,
        parent_suite_id: parent.parentId,
        ...(Number.isInteger(Number(b.order)) && Number(b.order) >= 0 && given(b.order) ? { position: Number(b.order) } : {}),
      });
      if (!res.ok) return refuse(reply, res, ID_FAIL);
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('suite', res.body.suite.id) });
    },
  },
  {
    method: 'POST',
    path: '/testcases',
    statuses: [409, 500],
    versions: ALL,
    auth: true,
    // The author is always the key's user (Testify records who made each version). `order`
    // isn't kept: Testify's cases have no order within a suite.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      if (!given(b.name)) return missing(reply, 'name');
      const suiteRef = b.testSuite && typeof b.testSuite === 'object' ? b.testSuite.id : b.testSuiteID;
      if (!given(suiteRef)) return missing(reply, 'testSuite');
      const suite = await suiteByNumber(request, ctx, suiteRef);
      if (!suite) return tlError(reply, 404, `No Test Suite identified by '${suiteRef}'!`, ID_FAIL);
      const projectRef = given(b.testProjectID) ? b.testProjectID : b.testProject;
      if (given(projectRef)) {
        const project = await projectFromRef(request, ctx, projectRef);
        if (!project) return tlKo(reply, 404, noProject(String(typeof projectRef === 'object' ? JSON.stringify(projectRef) : projectRef)), ID_FAIL);
        if (project.project.id !== suite.suite.project_id) return tlKo(reply, 400, `Test suite ${suiteRef} isn't in that test project`, ID_FAIL);
      }
      const projectId = suite.suite.project_id;
      const title = String(b.name);
      if (await duplicateTitle(ctx, suite.suite.id, title)) return tlKo(reply, 409, DUPLICATE_CASE, ID_FAIL);

      const { target } = statusTarget(b.status, b.active);
      if ((target === 'APPROVED' || target === 'DEPRECATED') && !(await mayApprove(request, ctx, projectId))) {
        return tlKo(reply, 403, INSUFFICIENT_RIGHTS, { ...ID_FAIL, detail: 'Approving or deprecating a test case needs SPEC_APPROVE' });
      }
      const fields = fieldWrites(b, await projectFields(ctx, projectId));
      if ('problem' in fields) return tlKo(reply, 400, fields.problem, ID_FAIL);

      const res = await asUser(
        request,
        'POST',
        `/api/v1/projects/${projectId}/cases`,
        {
          test_suite_id: suite.suite.id,
          title,
          ...(priorityFromImportance(b.importance) ? { priority: priorityFromImportance(b.importance) } : {}),
          ...(executionTypeFromCode(b.executionType) ? { execution_type: executionTypeFromCode(b.executionType) } : {}),
          summary: textOf(b.summary) ?? '',
          preconditions: textOf(b.preconditions) ?? '',
          steps: stepsFrom(b.steps) ?? [],
        },
        // TestLink's default status is draft: only status 7 (or none) lets Testify auto-approve.
        { startDraft: target === 'DRAFT' || (given(b.status) && target !== 'APPROVED') }
      );
      if (!res.ok) return refuse(reply, res, ID_FAIL);
      const caseId = res.body.test_case.id;
      if (!(await finishCase(request, reply, ctx, caseId, fields.writes, target))) return reply;
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('case', caseId) });
    },
  },
  {
    method: 'POST',
    path: '/testcases/:id',
    statuses: [400, 404, 409, 500],
    versions: CUSTOM,
    auth: true,
    // A partial update; `{id}` is the case's number or external id (MA-1).
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const b = bodyOf(request);
      const found = await caseByRef(request, ctx, id);
      if (!found) return tlError(reply, 404, `No Test Case identified by '${id}'!`);
      const { testCase } = found;
      const projectId = testCase.project_id;
      const { target, reactivate } = statusTarget(b.status, b.active);
      const contentChange = b.summary !== undefined || b.preconditions !== undefined || Array.isArray(b.steps);

      if (given(b.name) && String(b.name) !== testCase.title && (await duplicateTitle(ctx, testCase.test_suite_id, String(b.name), testCase.id))) {
        return tlKo(reply, 409, DUPLICATE_CASE, ID_FAIL);
      }
      const latest = await latestVersion(ctx, testCase.id);
      const deprecated = latest?.status === 'DEPRECATED';
      const restoring = deprecated && (reactivate || target === 'APPROVED' || target === 'DRAFT');
      if (deprecated && contentChange && !restoring) {
        return tlKo(reply, 409, `Test case ${testCase.external_id} is obsolete: send "active": 1 to restore it before changing it`, ID_FAIL);
      }
      const statusChange = restoring || (target !== undefined && target !== latest?.status) || (contentChange && target === 'APPROVED');
      if (statusChange && target !== 'DRAFT' && !(await mayApprove(request, ctx, projectId))) {
        return tlKo(reply, 403, INSUFFICIENT_RIGHTS, { ...ID_FAIL, detail: 'Approving, deprecating or restoring a test case needs SPEC_APPROVE' });
      }
      const fields = fieldWrites(b, await projectFields(ctx, projectId));
      if ('problem' in fields) return tlKo(reply, 400, fields.problem, ID_FAIL);

      if (restoring) {
        const refusal = await moveToStatus(request, ctx, testCase.id, 'APPROVED');
        if (refusal) return refuse(reply, refusal, ID_FAIL);
      }
      const casePatch: Record<string, unknown> = {};
      if (given(b.name)) casePatch.title = String(b.name);
      if (priorityFromImportance(b.importance)) casePatch.priority = priorityFromImportance(b.importance);
      if (executionTypeFromCode(b.executionType)) casePatch.execution_type = executionTypeFromCode(b.executionType);
      if (Object.keys(casePatch).length > 0) {
        const res = await asUser(request, 'PATCH', `/api/v1/cases/${testCase.id}`, casePatch);
        if (!res.ok) return refuse(reply, res, ID_FAIL);
      }
      if (contentChange) {
        // Content lives in a draft: an approved case gets a new one, copying the latest.
        const refusal = await moveToStatus(request, ctx, testCase.id, 'DRAFT');
        if (refusal) return refuse(reply, refusal, ID_FAIL);
        const draft = (await latestVersion(ctx, testCase.id))!;
        const res = await asUser(request, 'PATCH', `/api/v1/versions/${draft.id}`, {
          ...(b.summary !== undefined ? { summary: textOf(b.summary) ?? '' } : {}),
          ...(b.preconditions !== undefined ? { preconditions: textOf(b.preconditions) ?? '' } : {}),
          ...(Array.isArray(b.steps) ? { steps: stepsFrom(b.steps) } : {}),
        });
        if (!res.ok) return refuse(reply, res, ID_FAIL);
      }
      if (!(await finishCase(request, reply, ctx, testCase.id, fields.writes, target))) return reply;
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('case', testCase.id) });
    },
  },
  {
    method: 'POST',
    path: '/testcases/:id/move',
    statuses: [400, 404, 409, 500],
    versions: CUSTOM,
    auth: true,
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const b = bodyOf(request);
      if (!given(b.testSuiteID)) return missing(reply, 'testSuiteID');
      const found = await caseByRef(request, ctx, id);
      if (!found) return tlError(reply, 404, `No Test Case identified by '${id}'!`);
      const target = await suiteByNumber(request, ctx, b.testSuiteID);
      if (!target) return tlError(reply, 404, `No Test Suite identified by '${b.testSuiteID}'!`);
      if (target.suite.project_id !== found.testCase.project_id) return tlError(reply, 409, 'Target test suite must belong to the same project as the test case');
      const caseNumber = await new CompatIdRepository(ctx.db).intId('case', found.testCase.id);
      if (target.suite.id === found.testCase.test_suite_id) return tlOk(reply, { id: caseNumber });
      const res = await asUser(request, 'POST', `/api/v1/projects/${found.testCase.project_id}/move`, { case_ids: [found.testCase.id], target_suite_id: target.suite.id });
      if (!res.ok) return refuse(reply, res, ID_FAIL);
      return tlOk(reply, { id: caseNumber });
    },
  },
  {
    method: 'POST',
    path: '/testsuites/:id/move',
    statuses: [400, 404, 409, 500],
    versions: CUSTOM,
    auth: true,
    // `parentID` is the project (top level) or another suite of it, not inside the suite itself.
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const b = bodyOf(request);
      if (!given(b.parentID)) return missing(reply, 'parentID');
      const found = await suiteByNumber(request, ctx, id);
      if (!found) return tlError(reply, 404, `No Test Suite identified by '${id}'!`);
      const { suite } = found;
      const ids = new CompatIdRepository(ctx.db);
      const projectNumber = await ids.intId('project', suite.project_id);
      let targetId: string | null;
      if (Number(b.parentID) === projectNumber) {
        targetId = null;
      } else {
        const parent = await suiteByNumber(request, ctx, b.parentID);
        if (!parent) {
          const otherProject = await projectFromRef(request, ctx, Number(b.parentID));
          if (otherProject) return tlError(reply, 409, 'Target parent must belong to the same project as the test suite');
          return tlError(reply, 404, `No Test Project or Test Suite identified by '${b.parentID}' to use as parent!`);
        }
        if (parent.suite.project_id !== suite.project_id) return tlError(reply, 409, 'Target parent must belong to the same project as the test suite');
        if (parent.suite.id === suite.id || parent.suite.path.startsWith(`${suite.path}/`)) {
          return tlError(reply, 409, 'A test suite cannot be moved into one of its own descendants');
        }
        targetId = parent.suite.id;
      }
      const suiteNumber = await ids.intId('suite', suite.id);
      if (targetId === suite.parent_suite_id) return tlOk(reply, { id: suiteNumber });
      const res = await asUser(request, 'POST', `/api/v1/projects/${suite.project_id}/move`, { suite_ids: [suite.id], target_suite_id: targetId });
      if (!res.ok) return refuse(reply, res, ID_FAIL);
      return tlOk(reply, { id: suiteNumber });
    },
  },
  {
    method: 'POST',
    path: '/keywords',
    statuses: [500],
    versions: V2_UP,
    auth: true,
    // A keyword is an option of the project's `keywords` field, made with the first keyword.
    // Changing that field is an admin's change in Testify (CUSTOM_FIELD_MANAGE). Notes aren't kept.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      const keyword = given(b.keyword) ? String(b.keyword).trim() : '';
      if (!keyword) return missing(reply, 'keyword');
      const ref = b.testProject ?? b.testProjectID;
      if (!given(ref)) return missing(reply, 'testProject');
      const found = await projectFromRef(request, ctx, ref);
      if (!found) return tlKo(reply, 404, noProject(String(typeof ref === 'object' ? JSON.stringify(ref) : ref)), ID_FAIL);
      const definitions = await new CustomFieldRepository(ctx.db).listVisibleToProject(found.project.id, 'TestCase');
      const field = definitions.find(isKeywordsField);
      let fieldId: string;
      if (!field) {
        const res = await asUser(request, 'POST', '/api/v1/admin/custom-fields', {
          entity_type: 'TestCase',
          name: TL_KEYWORDS_FIELD,
          field_label: 'Keywords',
          field_type: 'MULTI_SELECT',
          options: [{ option_label: keyword, option_value: keyword }],
          project_ids: [found.project.id],
        });
        if (!res.ok) return refuse(reply, res, ID_FAIL);
        fieldId = res.body.definition.id;
      } else {
        if (field.options.some((o) => o.option_value.toLowerCase() === keyword.toLowerCase())) {
          return tlKo(reply, 409, `Keyword '${keyword}' already exists in test project '${found.project.prefix}'`, ID_FAIL);
        }
        const options = [...field.options.map((o) => ({ option_label: o.option_label, option_value: o.option_value })), { option_label: keyword, option_value: keyword }];
        const res = await asUser(request, 'PATCH', `/api/v1/admin/custom-fields/${field.id}`, { options });
        if (!res.ok) return refuse(reply, res, ID_FAIL);
        fieldId = field.id;
      }
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('keyword', keywordKey(fieldId, keyword)) });
    },
  },
];
