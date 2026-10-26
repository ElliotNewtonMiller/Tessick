import { CompatApiKeyRepository, CompatIdRepository, CompatPlatformRepository, TestRunRepository } from '@testify/db';
import { platformRunName } from '@testify/core';
import { writeAudit } from '../../audit.js';
import { permissionsInProject } from '../../middleware/auth.js';
import type { CompatRoute } from '../index.js';
import { ALL, V2_UP } from '../versions.js';
import { INSUFFICIENT_RIGHTS, tlKo, tlOk } from '../envelope.js';
import { asUser, bodyOf, buildRunId, given, missing, planByNumber, projectFromRef, refuse, textOf } from '../writes.js';
import { noProject } from './projects.js';

/**
 * Creating projects, plans and builds, changing plans and builds, and linking platforms to a
 * plan. TestLink answers a change with 200 and the row's id (`id: -1` when refused).
 */

const dateOf = (v: unknown) => (given(v) ? String(v).slice(0, 10) : undefined);

export const projectWriteRoutes: CompatRoute[] = [
  {
    method: 'POST',
    path: '/testprojects',
    statuses: [400, 403, 500],
    versions: ALL,
    auth: true,
    // Testify's projects are always active and public, and have no feature options.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      if (!given(b.name)) return missing(reply, 'name');
      if (!given(b.prefix)) return missing(reply, 'prefix');
      const res = await asUser(request, 'POST', '/api/v1/projects', { name: String(b.name), prefix: String(b.prefix), description: textOf(b.notes) ?? null });
      if (!res.ok) return refuse(reply, res, { id: -1 });
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('project', res.body.project.id) });
    },
  },
  {
    method: 'POST',
    path: '/testplans',
    statuses: [500],
    versions: ALL,
    auth: true,
    // `active: 0` makes an archived plan.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      if (!given(b.name)) return missing(reply, 'name');
      const ref = given(b.testProjectID) ? b.testProjectID : b.testProject ?? b.testProjectName ?? b.prefix;
      if (!given(ref)) return missing(reply, 'testProjectID');
      const found = await projectFromRef(request, ctx, ref);
      if (!found) return tlKo(reply, 404, noProject(String(typeof ref === 'object' ? JSON.stringify(ref) : ref)), { id: -1 });
      const res = await asUser(request, 'POST', `/api/v1/projects/${found.project.id}/plans`, { name: String(b.name), description: textOf(b.notes) ?? null });
      if (!res.ok) return refuse(reply, res, { id: -1 });
      const plan = res.body.plan;
      if (Number(b.active) === 0) {
        const archived = await asUser(request, 'PATCH', `/api/v1/plans/${plan.id}`, { status: 'ARCHIVED' });
        if (!archived.ok) return refuse(reply, archived, { id: -1 });
      }
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('plan', plan.id) });
    },
  },
  {
    method: 'POST',
    path: '/testplans/:id',
    statuses: [500],
    versions: ALL,
    auth: true,
    // Only what's sent changes; `active` archives the plan (0) or takes it out of the archive (1).
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const b = bodyOf(request);
      const found = await planByNumber(request, ctx, id);
      if (!found) return tlKo(reply, 404, `No Test Plan identified by '${id}'!`, { id: -1 });
      const { plan } = found;
      const patch: Record<string, unknown> = {};
      if (given(b.name)) patch.name = String(b.name);
      if (b.notes !== undefined) patch.description = textOf(b.notes) ?? null;
      if (given(b.active)) {
        if (Number(b.active) === 0 && plan.status !== 'ARCHIVED') patch.status = 'ARCHIVED';
        if (Number(b.active) === 1 && plan.status === 'ARCHIVED') patch.status = 'ACTIVE';
      }
      if (Object.keys(patch).length > 0) {
        const res = await asUser(request, 'PATCH', `/api/v1/plans/${plan.id}`, patch);
        if (!res.ok) return refuse(reply, res, { id: -1 });
      }
      return tlOk(reply, { id: Number(id) });
    },
  },
  {
    method: 'POST',
    path: '/testplans/:id/platforms',
    statuses: [400, 500],
    versions: V2_UP,
    auth: true,
    // TestLink's answer here is `status: true` and "ok", or `status: false` with a list of
    // problems; every platform is checked before any is linked.
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const fail = (problems: string[]) => reply.code(200).send({ status: false, message: problems });
      const found = await planByNumber(request, ctx, id);
      if (!found) return fail([`Test plan ${id} does not exist`]);
      const permissions = await permissionsInProject(request.user!, found.plan.project_id, ctx.db);
      if (!permissions.includes('SYSTEM_ADMIN') && !permissions.includes('PLAN_MANAGE')) return tlKo(reply, 403, INSUFFICIENT_RIGHTS);
      const refs = Array.isArray(request.body) ? request.body : [];
      if (refs.length === 0) return fail(['The body must be a list of platforms, each {"name": ...} or {"id": ...}']);

      const platforms = new CompatPlatformRepository(ctx.db);
      const available = await platforms.listForProject(found.plan.project_id);
      const ids = new CompatIdRepository(ctx.db);
      const numbers = await ids.intIds('platform', available.map((p) => p.id));
      const problems: string[] = [];
      const chosen: string[] = [];
      for (const ref of refs as any[]) {
        const match = given(ref?.id)
          ? available.find((p) => numbers.get(p.id) === Number(ref.id))
          : given(ref?.name)
            ? available.find((p) => p.name.toLowerCase() === String(ref.name).toLowerCase())
            : undefined;
        if (match) chosen.push(match.id);
        else problems.push(`Platform ${given(ref?.id) ? `id ${ref.id}` : `'${ref?.name ?? ''}'`} does not exist in this test project`);
      }
      if (problems.length > 0) return fail(problems);
      await platforms.linkToPlan(found.plan.id, chosen);
      await writeAudit(ctx.db, request, {
        action: 'PLAN_PLATFORMS_LINKED',
        resourceType: 'plan',
        resourceId: found.plan.id,
        projectId: found.plan.project_id,
        diff: { platforms: available.filter((p) => chosen.includes(p.id)).map((p) => p.name) },
      });
      return reply.code(200).send({ status: true, message: 'ok' });
    },
  },
  {
    method: 'POST',
    path: '/builds',
    statuses: [403, 404, 409],
    versions: V2_UP,
    auth: true,
    // `testplan` is the plan's number or its API key. Names are unique in a plan.
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      const fail = (status: number, message: string, details: string[] = []) => tlKo(reply, status, message, { details, id: -1 });
      if (!given(b.testplan)) return missing(reply, 'testplan', { details: [], id: -1 });
      if (!given(b.name)) return missing(reply, 'name', { details: [], id: -1 });
      let found = await planByNumber(request, ctx, b.testplan);
      if (!found) {
        const byKey = await new CompatApiKeyRepository(ctx.db).entityFor('plan', String(b.testplan));
        if (byKey) found = await planByNumber(request, ctx, await new CompatIdRepository(ctx.db).intId('plan', byKey));
      }
      if (!found) return fail(404, 'ko', [`Test plan ID ${b.testplan} does not exist`]);
      const name = String(b.name);
      const existing = (await new TestRunRepository(ctx.db).findByTestPlan(found.plan.id)).find((r) => r.name === name);
      if (existing) return fail(409, `Build name '${name}' already exists (id ${await new CompatIdRepository(ctx.db).intId('build', existing.id)})`);

      const res = await asUser(request, 'POST', `/api/v1/plans/${found.plan.id}/runs`, { name, description: textOf(b.notes) ?? null, release_date: dateOf(b.releasedate) ?? null });
      if (!res.ok) return refuse(reply, res, { details: [], id: -1 });
      if (given(b.is_open) && Number(b.is_open) === 0) {
        const closed = await asUser(request, 'PATCH', `/api/v1/runs/${res.body.run.id}`, { status: 'CLOSED' });
        if (!closed.ok) return refuse(reply, closed, { details: [], id: -1 });
      }
      return tlOk(reply, { details: [], id: await new CompatIdRepository(ctx.db).intId('build', res.body.run.id) });
    },
  },
  {
    method: 'POST',
    path: '/builds/:id',
    statuses: [403, 404, 409],
    versions: V2_UP,
    auth: true,
    // Only what's sent changes; `is_open` closes or reopens it. Its platform runs follow it.
    handle: async (request, reply, ctx) => {
      const { id } = request.params as { id: string };
      const b = bodyOf(request);
      const invalid = () => tlKo(reply, 404, `Invalid build id ${id}`, { details: [], id: -1 });
      const runId = await buildRunId(ctx, id);
      const runs = new TestRunRepository(ctx.db);
      const run = runId ? await runs.findById(runId) : undefined;
      if (!run) return invalid();
      const platforms = new CompatPlatformRepository(ctx.db);
      if ((await platforms.platformRunIds([run.id])).size > 0) return invalid();
      const plan = await planByNumber(request, ctx, await new CompatIdRepository(ctx.db).intId('plan', run.test_plan_id));
      if (!plan) return invalid();

      const patch: Record<string, unknown> = {};
      if (given(b.name) && String(b.name) !== run.name) {
        const name = String(b.name);
        const taken = (await runs.findByTestPlan(run.test_plan_id)).find((r) => r.name === name);
        if (taken) return tlKo(reply, 409, `Build name '${name}' already exists (id ${await new CompatIdRepository(ctx.db).intId('build', taken.id)})`, { details: [], id: -1 });
        patch.name = name;
      }
      if (b.notes !== undefined) patch.description = textOf(b.notes) ?? null;
      if (given(b.releasedate)) patch.release_date = dateOf(b.releasedate);
      if (given(b.is_open)) {
        const status = Number(b.is_open) === 0 ? 'CLOSED' : 'OPEN';
        if (status !== run.status) patch.status = status;
      }
      if (Object.keys(patch).length > 0) {
        const res = await asUser(request, 'PATCH', `/api/v1/runs/${run.id}`, patch);
        if (!res.ok) return refuse(reply, res, { details: [], id: -1 });
        for (const pr of await platforms.runsOfBuild(run.id)) {
          const { description: _notes, ...rest } = patch;
          const follow = { ...rest, ...(patch.name ? { name: platformRunName(String(patch.name), pr.name) } : {}) };
          if (Object.keys(follow).length > 0) await asUser(request, 'PATCH', `/api/v1/runs/${pr.run_id}`, follow);
        }
      }
      return tlOk(reply, { details: [], id: Number(id) });
    },
  },
];
