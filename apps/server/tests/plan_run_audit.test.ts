import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Creating, changing, closing, reopening and deleting plans and runs is audit-logged. */
describe('Audit rows for plans and runs', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const rows = async (action: string) => body(await call(admin, 'GET', `/api/v1/admin/audit-logs?action=${action}`)).audit_logs;
  const diff = (row: any) => JSON.parse(row.diff);

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('plans: created, changed (only what changed), deleted with what it held', async () => {
    const plan = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'Release 3' })).plan;
    expect((await rows('PLAN_CREATED')).map((r: any) => [r.resource_id, diff(r).name, r.actor_type, r.project_id])).toEqual([[plan.id, 'Release 3', 'USER', seed.projectId]]);

    await call(admin, 'PATCH', `/api/v1/plans/${plan.id}`, { name: 'Release 3.0', status: 'ACTIVE' });
    await call(admin, 'PATCH', `/api/v1/plans/${plan.id}`, { name: 'Release 3.0' }); // nothing changes: no row
    const updated = await rows('PLAN_UPDATED');
    expect(updated).toHaveLength(1);
    expect(diff(updated[0]).changes).toEqual({ name: { from: 'Release 3', to: 'Release 3.0' } });

    await call(admin, 'POST', `/api/v1/plans/${plan.id}/cases`, { test_case_id: 'SHOP-101' });
    const run = body(await call(admin, 'POST', `/api/v1/plans/${plan.id}/runs`, { name: 'r1' })).run;
    await call(admin, 'POST', `/api/v1/runs/${run.id}/results/batch`, { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] });
    expect((await call(admin, 'DELETE', `/api/v1/plans/${plan.id}`)).statusCode).toBe(409); // refused: no row
    expect(await rows('PLAN_DELETED')).toHaveLength(0);
    expect((await call(admin, 'DELETE', `/api/v1/plans/${plan.id}?force=true`)).statusCode).toBe(204);
    expect(diff((await rows('PLAN_DELETED'))[0])).toEqual({ name: 'Release 3.0', forced: true, deleted_runs: 1, deleted_results: 1 });
  });

  it('runs: created (in the app, by a token naming a run), closed, reopened, changed, closed by CI, deleted', async () => {
    const run = body(await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Nightly' })).run;
    await call(admin, 'PATCH', `/api/v1/runs/${run.id}`, { status: 'CLOSED' });
    await call(admin, 'PATCH', `/api/v1/runs/${run.id}`, { status: 'OPEN' });
    await call(admin, 'PATCH', `/api/v1/runs/${run.id}`, { name: 'Nightly 1' });
    expect(diff((await rows('RUN_CLOSED'))[0]).changes).toEqual({ status: { from: 'OPEN', to: 'CLOSED' } });
    expect(diff((await rows('RUN_REOPENED'))[0]).changes).toEqual({ status: { from: 'CLOSED', to: 'OPEN' } });
    expect(diff((await rows('RUN_UPDATED'))[0]).changes).toEqual({ name: { from: 'Nightly', to: 'Nightly 1' } });

    const ci = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN', 'RUN_MANAGE'] })).plaintext;
    const upload = body(
      await call(ci, 'POST', `/api/v1/plans/${seed.planId}/results/junit?run_name=build-7&close_run=true`, '<testsuite name="x"><testcase name="SHOP-102 a"/></testsuite>', { 'content-type': 'application/xml' })
    );
    const created = (await rows('RUN_CREATED')).map((r: any) => [diff(r).name, diff(r).via ?? null, r.actor_type]);
    expect(created).toEqual(expect.arrayContaining([['Nightly', null, 'USER'], ['build-7', 'run_name', 'SERVICE_ACCOUNT']]));
    const closedByCi = (await rows('RUN_CLOSED')).find((r: any) => r.resource_id === upload.run.id);
    expect([diff(closedByCi).via, closedByCi.actor_type]).toEqual(['close_run', 'SERVICE_ACCOUNT']);

    await call(admin, 'DELETE', `/api/v1/runs/${upload.run.id}?force=true`);
    expect(diff((await rows('RUN_DELETED'))[0])).toMatchObject({ name: 'build-7', forced: true, deleted_results: 1 });
  });

  it('only the deletes show in the Security Audit Log', async () => {
    const plan = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'P' })).plan;
    const run = body(await call(admin, 'POST', `/api/v1/plans/${plan.id}/runs`, { name: 'R' })).run;
    await call(admin, 'PATCH', `/api/v1/runs/${run.id}`, { status: 'CLOSED' });
    await call(admin, 'DELETE', `/api/v1/runs/${run.id}`);
    await call(admin, 'DELETE', `/api/v1/plans/${plan.id}`);
    const security = body(await call(admin, 'GET', '/api/v1/admin/audit-logs')).audit_logs.map((r: any) => r.action);
    expect(security).toEqual(expect.arrayContaining(['PLAN_DELETED', 'RUN_DELETED']));
    for (const hidden of ['PLAN_CREATED', 'RUN_CREATED', 'RUN_CLOSED']) expect(security).not.toContain(hidden);
  });
});
