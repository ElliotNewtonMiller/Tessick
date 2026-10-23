import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * Idempotency-Key on the result routes (API audit, 2026-10-23): a retried upload gets the first
 * answer back instead of recording every result twice (services/idempotency.ts).
 */
describe('Idempotency-Key on the result routes', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}, token = admin) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const batchUrl = () => `/api/v1/runs/${seed.buildId}/results/batch`;
  const batch = (ids: string[], verdict = 'PASSED') => ({ results: ids.map((id) => ({ case_identifier: { external_id: id }, verdict })) });
  const resultCount = async () => (await db.selectFrom('test_results').select('id').where('test_run_id', '=', seed.buildId).execute()).length;
  const key = (k: string) => ({ 'idempotency-key': k });

  beforeEach(async () => {
    ({ app, db, seed } = await createServer(undefined, { webhooks: { allowLocal: true, deliverImmediately: false, timeoutMs: 500 } }));
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('a retry with the same key gets the first answer back, marked replayed, and records nothing again (no second webhook either)', async () => {
    const hook = await call('POST', `/api/v1/projects/${seed.projectId}/webhooks`, { name: 'CI', url: 'https://example.com/hook', format: 'json', events: ['results.recorded'] });
    expect(hook.statusCode, hook.payload).toBe(201);

    const first = await call('POST', batchUrl(), batch(['SHOP-101', 'SHOP-102']), key('build-42-1-junit.xml'));
    expect(first.statusCode, first.payload).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await call('POST', batchUrl(), batch(['SHOP-101', 'SHOP-102']), key('build-42-1-junit.xml'));
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.payload).toBe(first.payload);
    expect(await resultCount()).toBe(2);
    expect(await db.selectFrom('webhook_deliveries').select('id').execute()).toHaveLength(1);

    // Without a key, nothing changes: a repeat records again.
    await call('POST', batchUrl(), batch(['SHOP-101']));
    await call('POST', batchUrl(), batch(['SHOP-101']));
    expect(await resultCount()).toBe(4);
  });

  it('JUnit into a run by name: one run, one set of results, the same answer', async () => {
    const xml = '<testsuite name="auth"><testcase name="[SHOP-102] rotates tokens" time="0.5"/></testsuite>';
    const url = `/api/v1/plans/${seed.planId}/results/junit?run_name=Nightly%2042`;
    const first = await call('POST', url, xml, { 'content-type': 'application/xml', ...key('"nightly-42"') });
    expect(first.statusCode, first.payload).toBe(201);
    expect(body(first).run.created).toBe(true);
    // The quoted form (as the IETF draft writes it) and the plain one are the same key.
    const again = await call('POST', url, xml, { 'content-type': 'application/xml', ...key('nightly-42') });
    expect([again.statusCode, again.headers['idempotent-replayed'], body(again).run]).toEqual([201, 'true', body(first).run]);
    const runs = await db.selectFrom('test_runs').select('id').where('name', '=', 'Nightly 42').execute();
    expect(runs).toHaveLength(1);
    expect(await db.selectFrom('test_results').select('id').where('test_run_id', '=', runs[0].id).execute()).toHaveLength(1);
  });

  it('the same key with a different request is refused, not replayed', async () => {
    expect((await call('POST', batchUrl(), batch(['SHOP-101']), key('build-7'))).statusCode).toBe(201);
    for (const [url, payload] of [
      [batchUrl(), batch(['SHOP-102'])], // another file reusing the build's key
      [`${batchUrl()}?close_run=true`, batch(['SHOP-101'])], // another query
    ] as const) {
      const res = await call('POST', url, payload, key('build-7'));
      expect([res.statusCode, body(res).code], url).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    }
    expect(await resultCount()).toBe(1);
  });

  it('a failed request frees its key, so a retry after fixing the problem runs', async () => {
    expect((await call('PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' })).statusCode).toBe(200);
    const refused = await call('POST', batchUrl(), batch(['SHOP-101']), key('retry-me'));
    expect([refused.statusCode, body(refused).code]).toEqual([422, 'RUN_CLOSED']);
    expect((await call('PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'OPEN' })).statusCode).toBe(200);
    const retried = await call('POST', batchUrl(), batch(['SHOP-101']), key('retry-me'));
    expect([retried.statusCode, retried.headers['idempotent-replayed']]).toEqual([201, undefined]);
    expect(await resultCount()).toBe(1);
  });

  it('keys belong to their caller and route: the same key elsewhere is a different key', async () => {
    const token = body(await call('POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'CI', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN', 'EXECUTE_OVERWRITE'] })).plaintext;
    expect((await call('POST', batchUrl(), batch(['SHOP-101']), key('shared'))).statusCode).toBe(201);
    const byToken = await call('POST', batchUrl(), batch(['SHOP-101']), key('shared'), token);
    expect([byToken.statusCode, byToken.headers['idempotent-replayed']]).toEqual([201, undefined]);
    // The JUnit route with the same key is its own.
    const junit = await call('POST', `/api/v1/runs/${seed.buildId}/results/junit`, '<testsuite name="s"><testcase name="SHOP-103 x"/></testsuite>', {
      'content-type': 'application/xml',
      ...key('shared'),
    });
    expect([junit.statusCode, junit.headers['idempotent-replayed']]).toEqual([201, undefined]);
    expect(await resultCount()).toBe(3);
  });

  it('one result at a time too', async () => {
    const planCase = await db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', seed.planId).executeTakeFirstOrThrow();
    const url = `/api/v1/runs/${seed.buildId}/results`;
    const payload = { test_plan_case_id: planCase.id, verdict: 'FAILED', notes: 'Checkout button missing' };
    const first = await call('POST', url, payload, key('hotkey-1'));
    expect(first.statusCode, first.payload).toBe(201);
    const again = await call('POST', url, payload, key('hotkey-1'));
    expect([again.statusCode, again.headers['idempotent-replayed'], body(again).result.id]).toEqual([201, 'true', body(first).result.id]);
    expect(await resultCount()).toBe(1);
  });

  it('a key still in use is 409 with Retry-After; one held for over 10 minutes is taken over; an expired one is free again', async () => {
    expect((await call('POST', batchUrl(), batch(['SHOP-101']), key('slow'))).statusCode).toBe(201);
    const row = () => db.updateTable('idempotency_keys').where('idempotency_key', '=', 'slow');

    // As if the first request were still running.
    await row().set({ status: 'IN_PROGRESS', response_status: null, response_body: null, created_at: new Date().toISOString() }).execute();
    const busy = await call('POST', batchUrl(), batch(['SHOP-101']), key('slow'));
    expect([busy.statusCode, body(busy).code, busy.headers['retry-after']]).toEqual([409, 'IDEMPOTENCY_KEY_IN_USE', '2']);

    // As if the server had stopped while handling it.
    await row().set({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute();
    const takenOver = await call('POST', batchUrl(), batch(['SHOP-101']), key('slow'));
    expect([takenOver.statusCode, takenOver.headers['idempotent-replayed']]).toEqual([201, undefined]);
    expect((await call('POST', batchUrl(), batch(['SHOP-101']), key('slow'))).headers['idempotent-replayed']).toBe('true');

    // Expired: the key can be used again, even for another request.
    await row().set({ expires_at: new Date(Date.now() - 1000).toISOString() }).execute();
    expect((await call('POST', batchUrl(), batch(['SHOP-102']), key('slow'))).statusCode).toBe(201);
    expect(await resultCount()).toBe(3);
  });

  it('concurrent retries record once', async () => {
    const sent = await Promise.all([1, 2, 3, 4].map(() => call('POST', batchUrl(), batch(['SHOP-104', 'SHOP-105']), key('burst'))));
    const statuses = sent.map((r: any) => r.statusCode);
    expect(statuses.every((s: number) => s === 201 || s === 409), String(statuses)).toBe(true);
    expect(statuses).toContain(201);
    expect(await resultCount()).toBe(2);
  });

  it("a project's keys go with it when it's deleted", async () => {
    expect((await call('POST', batchUrl(), batch(['SHOP-101']), key('k'))).statusCode).toBe(201);
    const deleted = await call('DELETE', `/api/v1/projects/${seed.projectId}?force=true`);
    expect(deleted.statusCode, deleted.payload).toBe(204);
    expect(await db.selectFrom('idempotency_keys').select('id').execute()).toEqual([]);
  });

  it('refuses a key it cannot use, naming the header', async () => {
    for (const bad of ['x'.repeat(256), '""', 'café']) {
      const res = await call('POST', batchUrl(), batch(['SHOP-101']), key(bad));
      expect([res.statusCode, body(res).invalid_params?.[0]?.name], bad).toEqual([400, 'Idempotency-Key']);
    }
    expect(await resultCount()).toBe(0);
  });
});
