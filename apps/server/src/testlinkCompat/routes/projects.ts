import { CompatApiKeyRepository, CompatIdRepository, CompatPlatformRepository, ProjectRepository, TestPlanRepository, TestRunRepository } from '@testify/db';
import { buildFlags, planFlags } from '@testify/core';
import type { CompatRoute } from '../index.js';
import { ALL, V2_UP } from '../versions.js';
import { tlError, tlOk } from '../envelope.js';
import { findProject, projectAccess, projectItems } from '../projectData.js';

/** TestLink orders projects, plans and builds by name. */
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export const noProject = (idCard: string) => `No Test Project identified by '${idCard}'!`;

/** Projects, their plans, and a plan's builds (Testify's runs). */
export const projectRoutes: CompatRoute[] = [
  {
    method: 'GET',
    path: '/testprojects',
    statuses: [400],
    versions: ALL,
    auth: true,
    // Every project the caller can see, as `item` (an array, as TestLink names it).
    handle: async (request, reply, ctx) => {
      const visible = [];
      for (const p of (await new ProjectRepository(ctx.db).findAll()).sort(byName)) {
        if ((await projectAccess(request, ctx, p.id)).visible) visible.push(p);
      }
      return tlOk(reply, { item: await projectItems(ctx, visible) });
    },
  },
  {
    method: 'GET',
    path: '/testprojects/:id',
    statuses: [400],
    versions: ALL,
    auth: true,
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const found = await findProject(request, ctx, id);
      if (!found) return tlError(reply, 404, noProject(id), { item: null });
      return tlOk(reply, { item: (await projectItems(ctx, [found.project]))[0] });
    },
  },
  {
    method: 'GET',
    path: '/testprojects/:id/testplans',
    statuses: [500],
    versions: ALL,
    auth: true,
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const found = await findProject(request, ctx, id);
      if (!found) return tlError(reply, 404, noProject(id), { items: null });
      const plans = (await new TestPlanRepository(ctx.db).findByProject(found.project.id)).sort(byName);
      const ids = new CompatIdRepository(ctx.db);
      const planIds = await ids.intIds('plan', plans.map((p) => p.id));
      const projectIntId = await ids.intId('project', found.project.id);
      const keys = new CompatApiKeyRepository(ctx.db);
      const items = [];
      for (const p of plans) {
        items.push({
          id: planIds.get(p.id),
          name: p.name,
          notes: p.description ?? '',
          ...planFlags(p.status),
          is_public: 1,
          testproject_id: projectIntId,
          api_key: await keys.keyFor('plan', p.id),
        });
      }
      return tlOk(reply, { items });
    },
  },
  {
    method: 'GET',
    path: '/testplans/:id/builds',
    statuses: [400],
    versions: V2_UP,
    auth: true,
    // `{id}` is the plan's API key, not its id (as in TestLink).
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const notFound = () => tlError(reply, 404, `No Test Plan identified by API KEY '${id}'!`, { items: null });
      const planId = await new CompatApiKeyRepository(ctx.db).entityFor('plan', id);
      const plan = planId ? await new TestPlanRepository(ctx.db).findById(planId) : undefined;
      if (!plan || !(await projectAccess(request, ctx, plan.project_id)).visible) return notFound();
      // A build's per-platform runs aren't builds of their own.
      const allRuns = await new TestRunRepository(ctx.db).findByTestPlan(plan.id);
      const platformRuns = await new CompatPlatformRepository(ctx.db).platformRunIds(allRuns.map((r) => r.id));
      const runs = allRuns.filter((r) => !platformRuns.has(r.id)).sort(byName);
      const ids = new CompatIdRepository(ctx.db);
      const buildIds = await ids.intIds('build', runs.map((r) => r.id));
      const planIntId = await ids.intId('plan', plan.id);
      return tlOk(reply, {
        items: runs.map((r) => ({
          id: buildIds.get(r.id),
          testplan_id: planIntId,
          name: r.name,
          notes: r.description ?? '',
          ...buildFlags(r.status),
          release_date: r.release_date ? r.release_date.slice(0, 10) : null,
        })),
      });
    },
  },
];
