import { CompatIdRepository, CompatPlatformRepository, TestPlanRepository, TestRunRepository } from '@testify/db';
import { TL_EXECUTION_STATUS } from '@testify/core';
import type { CompatRoute } from '../index.js';
import { ALL } from '../versions.js';
import { tlKo, tlOk } from '../envelope.js';
import { asUser, bodyOf, buildRunId, caseByRef, given, missing, planByNumber, refuse, textOf } from '../writes.js';
import { platformRunName } from './projectWrites.js';

const ID_FAIL = { id: -1 };

/**
 * POST /executions: one result for a case in a (plan, build, platform). It's recorded as a CI
 * result (Testify's batch route, as the key's user), so it never auto-closes the run, as
 * TestLink never closes a build. Re-recording a case that has a result needs EXECUTE_OVERWRITE,
 * as everywhere in Testify.
 *
 * In a plan with platforms each (build, platform) has its own run, made on its first result.
 */
export const executionRoutes: CompatRoute[] = [
  {
    method: 'POST',
    path: '/executions',
    statuses: [500],
    versions: ALL,
    auth: true,
    handle: async (request, reply, ctx) => {
      const b = bodyOf(request);
      for (const name of ['testPlanID', 'buildID', 'statusCode']) if (!given(b[name])) return missing(reply, name);
      const caseRef = given(b.testCaseExternalID) ? b.testCaseExternalID : b.testCaseID;
      if (!given(caseRef)) return missing(reply, 'testCaseExternalID');
      const code = String(b.statusCode).trim().toLowerCase();
      const verdict = TL_EXECUTION_STATUS[code];
      if (!verdict) return tlKo(reply, 400, `Invalid status code '${b.statusCode}': use p (passed), f (failed) or b (blocked)`, ID_FAIL);

      const plan = await planByNumber(request, ctx, b.testPlanID);
      if (!plan) return tlKo(reply, 404, `No Test Plan identified by '${b.testPlanID}'!`, ID_FAIL);
      const runs = new TestRunRepository(ctx.db);
      const buildRun = await buildRunId(ctx, b.buildID);
      const build = buildRun ? await runs.findById(buildRun) : undefined;
      const platforms = new CompatPlatformRepository(ctx.db);
      if (!build || build.test_plan_id !== plan.plan.id || (await platforms.platformRunIds([build.id])).size > 0) {
        return tlKo(reply, 404, `Build ${b.buildID} doesn't belong to test plan ${b.testPlanID}`, ID_FAIL);
      }
      if (build.status === 'CLOSED') return tlKo(reply, 409, `Build '${build.name}' is closed: results can't be recorded on it`, ID_FAIL);

      const found = await caseByRef(request, ctx, caseRef);
      if (!found || found.testCase.project_id !== plan.plan.project_id) return tlKo(reply, 404, `No Test Case identified by '${caseRef}'!`, ID_FAIL);
      if (!(await new TestPlanRepository(ctx.db).getPinnedCase(plan.plan.id, found.testCase.id))) {
        return tlKo(reply, 400, `Test case ${found.testCase.external_id} isn't linked to test plan ${b.testPlanID}`, ID_FAIL);
      }

      // The run the result goes in: the build's own, or its run for the platform.
      let runId = build.id;
      const planPlatforms = await platforms.platformsOfPlan(plan.plan.id);
      if (planPlatforms.length > 0) {
        if (!given(b.platformID)) return tlKo(reply, 400, `Test plan ${b.testPlanID} has platforms: platformID is required`, ID_FAIL);
        const numbers = await new CompatIdRepository(ctx.db).intIds('platform', planPlatforms.map((p) => p.id));
        const platform = planPlatforms.find((p) => numbers.get(p.id) === Number(b.platformID));
        if (!platform) return tlKo(reply, 400, `Platform ${b.platformID} isn't linked to test plan ${b.testPlanID}`, ID_FAIL);
        const existing = await platforms.platformRun(build.id, platform.id);
        if (existing) {
          runId = existing;
        } else {
          const made = await asUser(request, 'POST', `/api/v1/plans/${plan.plan.id}/runs`, {
            name: platformRunName(build.name, platform.name),
            description: build.description,
            release_date: build.release_date,
          });
          if (!made.ok) return refuse(reply, made, ID_FAIL);
          runId = await platforms.setPlatformRun(build.id, platform.id, made.body.run.id);
        }
      }

      const res = await asUser(request, 'POST', `/api/v1/runs/${runId}/results/batch`, {
        results: [{ case_identifier: { by_uuid: found.testCase.id }, verdict, ...(given(b.notes) ? { notes: textOf(b.notes) } : {}) }],
      });
      if (!res.ok) return refuse(reply, res, ID_FAIL);
      const item = res.body?.results?.[0];
      if (!item || item.status >= 300) return refuse(reply, { ok: false, status: item?.status ?? 400, body: item, detail: item?.detail ?? 'The result was refused' }, ID_FAIL);
      return tlOk(reply, { id: await new CompatIdRepository(ctx.db).intId('execution', item.test_result_id) });
    },
  },
];
