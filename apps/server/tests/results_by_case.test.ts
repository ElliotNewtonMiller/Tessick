import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** API audit of 2026-10-23, findings 7 and 9: one result by case id or readable id; no results from the future. */
describe('Recording results: naming the case, and the time', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });
  const record = (payload: unknown) => call('POST', `/api/v1/runs/${seed.buildId}/results`, payload);

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('one result can name its case by readable id or case id, not only by its plan link', async () => {
    const link = await db.selectFrom('test_plan_cases').select(['id', 'test_case_id']).where('test_plan_id', '=', seed.planId).where('test_case_id', '=', seed.caseIds[0]).executeTakeFirstOrThrow();

    const byReadableId = await record({ test_case_id: 'SHOP-101', verdict: 'PASSED' });
    expect(byReadableId.statusCode, byReadableId.payload).toBe(201);
    expect(body(byReadableId).result.test_plan_case_id).toBe(link.id);

    const byCaseId = await record({ test_case_id: seed.caseIds[1], verdict: 'FAILED', notes: 'Times out' });
    expect(byCaseId.statusCode, byCaseId.payload).toBe(201);

    // The link still works (the web app sends it).
    expect((await record({ test_plan_case_id: link.id, verdict: 'PASSED' })).statusCode).toBe(201);

    const neither = await record({ verdict: 'PASSED' });
    expect([neither.statusCode, body(neither).code, body(neither).invalid_params[0].name]).toEqual([400, 'INVALID_RESULT', 'test_case_id']);
    const both = await record({ test_case_id: 'SHOP-101', test_plan_case_id: link.id, verdict: 'PASSED' });
    expect([both.statusCode, body(both).invalid_params[0].reason]).toEqual([400, 'send test_case_id or test_plan_case_id, not both']);
    // SHOP-110 is in the project but not in the plan.
    expect((await record({ test_case_id: 'SHOP-110', verdict: 'PASSED' })).statusCode).toBe(404);
  });

  it('a CI result dated more than 5 minutes ahead is refused; a little ahead (clock drift) is fine', async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const res = await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, {
      results: [
        { case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', executed_at: '2099-01-01T00:00:00Z' },
        { case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED', executed_at: at(2 * 60_000) },
        { case_identifier: { external_id: 'SHOP-103' }, verdict: 'PASSED', executed_at: at(-86_400_000) },
      ],
    });
    expect(res.statusCode, res.payload).toBe(207);
    const items = body(res).results;
    expect(items.map((r: any) => r.status)).toEqual([400, 201, 201]);
    expect(items[0].invalid_params[0]).toEqual({ name: 'results[0].executed_at', reason: "can't be in the future (check the CI machine's clock)" });
  });
});
