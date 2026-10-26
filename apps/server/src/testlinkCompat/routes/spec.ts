import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompatIdRepository, TestSuiteRepository } from '@testify/db';
import {
  TestLinkQueryError,
  parseCaseQuery,
  parseSuiteTreeQuery,
  projectCaseItem,
  runCaseQuery,
  specCaseItem,
  suiteCaseItem,
  suiteTreeItems,
  type SuiteTree,
  type TlSuite,
} from '@testify/core';
import type { CompatContext, CompatRoute } from '../index.js';
import { ALL, CUSTOM } from '../versions.js';
import { INSUFFICIENT_RIGHTS, tlError, tlKo, tlOk } from '../envelope.js';
import { findProject, loadProjectSpec, projectAccess, type ProjectSpec } from '../projectData.js';
import { noProject } from './projects.js';

type Handler = (request: FastifyRequest, reply: FastifyReply, ctx: CompatContext) => Promise<unknown>;

/** A bad query parameter is TestLink's 400, `status: "error"`, saying which. */
function refusingBadParams(handle: Handler): Handler {
  return async (request, reply, ctx) => {
    try {
      return await handle(request, reply, ctx);
    } catch (err) {
      if (err instanceof TestLinkQueryError) return tlError(reply, 400, err.message);
      throw err;
    }
  };
}

/**
 * A project route's project and its specification, or the answer already sent: not found
 * (including one the caller can't see), or 403 without SPEC_VIEW.
 */
async function projectSpec(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: CompatContext,
  emptyKey: 'items' | 'item',
  opts: { steps?: boolean } = {}
): Promise<{ spec: ProjectSpec; project: { id: string; name: string; prefix: string } } | undefined> {
  const { id } = request.params as { id: string };
  const found = await findProject(request, ctx, id);
  if (!found) {
    tlError(reply, 404, noProject(id), { [emptyKey]: null });
    return undefined;
  }
  if (!found.access.spec) {
    tlKo(reply, 403, INSUFFICIENT_RIGHTS);
    return undefined;
  }
  return { spec: await loadProjectSpec(ctx, found.project.id, opts), project: found.project };
}

/** A suite in GET /testprojects/{id}/testspec: its cases, then its child suites. */
function specSuite(tree: SuiteTree, suite: TlSuite): Record<string, unknown> {
  return {
    type: 'testsuite',
    id: suite.id,
    name: suite.name,
    parent_id: suite.parent_id,
    node_order: suite.node_order,
    testcases: tree.casesOf(suite.id).map(specCaseItem),
    children: tree.children(suite.id).map((child) => specSuite(tree, child)),
  };
}

/** A project's specification: its suite tree, test cases (with the query layer), keywords and custom fields. */
export const specRoutes: CompatRoute[] = [
  {
    method: 'GET',
    path: '/testprojects/:id/testcases',
    statuses: [400],
    versions: ALL,
    auth: true,
    // Every case's latest version; v2 and custom add keywords and custom fields. suiteIds
    // narrows it to those suites (each deep).
    handle: refusingBadParams(async (request, reply, ctx) => {
      const q = parseCaseQuery(request.query as Record<string, unknown>, 'project', { customfields: ctx.version !== 'v1' });
      const loaded = await projectSpec(request, reply, ctx, 'items', { steps: !q.nosteps || Boolean(q.fields?.includes('steps')) });
      if (!loaded) return reply;
      const { spec } = loaded;
      for (const suiteId of q.suiteIds ?? []) {
        if (!spec.tree.byId.has(suiteId)) return tlError(reply, 400, `Test suite ${suiteId} isn't in the test project '${(request.params as any).id}'`);
      }
      const cases = spec.tree.collect(q.suiteIds ?? null, true, q.exclusions);
      return tlOk(reply, runCaseQuery(cases, q, projectCaseItem));
    }),
  },
  {
    method: 'GET',
    path: '/testsuites/:id/testcases',
    statuses: [400, 404, 500],
    versions: CUSTOM,
    auth: true,
    // The suite's own cases, or with deep=1 its sub-suites' too.
    handle: refusingBadParams(async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const notFound = () => tlError(reply, 404, `No Test Suite identified by '${id}'!`, { items: null });
      const q = parseCaseQuery(request.query as Record<string, unknown>, 'suite');
      const suiteUuid = /^\d+$/.test(id) ? await new CompatIdRepository(ctx.db).entityId('suite', Number(id)) : undefined;
      const suite = suiteUuid ? await new TestSuiteRepository(ctx.db).findById(suiteUuid) : undefined;
      if (!suite) return notFound();
      const access = await projectAccess(request, ctx, suite.project_id);
      if (!access.visible) return notFound();
      if (!access.spec) return tlKo(reply, 403, INSUFFICIENT_RIGHTS);
      const spec = await loadProjectSpec(ctx, suite.project_id, { steps: !q.nosteps || Boolean(q.fields?.includes('steps')) });
      const cases = spec.tree.collect([Number(id)], q.deep, q.exclusions);
      return tlOk(reply, runCaseQuery(cases, q, suiteCaseItem));
    }),
  },
  {
    method: 'GET',
    path: '/testprojects/:id/testsuites',
    statuses: [400, 500],
    versions: CUSTOM,
    auth: true,
    handle: refusingBadParams(async (request, reply, ctx) => {
      const q = parseSuiteTreeQuery(request.query as Record<string, unknown>);
      const loaded = await projectSpec(request, reply, ctx, 'items', { steps: false });
      if (!loaded) return reply;
      return tlOk(reply, { items: suiteTreeItems(loaded.spec.tree, q) });
    }),
  },
  {
    method: 'GET',
    path: '/testprojects/:id/testspec',
    statuses: [400, 500],
    versions: CUSTOM,
    auth: true,
    handle: async (request, reply, ctx) => {
      const loaded = await projectSpec(request, reply, ctx, 'items');
      if (!loaded) return reply;
      const { spec, project } = loaded;
      return tlOk(reply, {
        project: { id: spec.projectIntId, name: project.name, prefix: project.prefix },
        items: spec.tree.children(null).map((top) => specSuite(spec.tree, top)),
      });
    },
  },
  {
    method: 'GET',
    path: '/testprojects/:id/keywords',
    statuses: [400, 500],
    versions: CUSTOM,
    auth: true,
    handle: async (request, reply, ctx) => {
      const loaded = await projectSpec(request, reply, ctx, 'items', { steps: false });
      if (!loaded) return reply;
      return tlOk(reply, { items: loaded.spec.keywords });
    },
  },
  {
    method: 'GET',
    path: '/testprojects/:id/customfields',
    statuses: [400, 500],
    versions: CUSTOM,
    auth: true,
    handle: async (request, reply, ctx) => {
      const loaded = await projectSpec(request, reply, ctx, 'items', { steps: false });
      if (!loaded) return reply;
      return tlOk(reply, { items: loaded.spec.customFields });
    },
  },
];
