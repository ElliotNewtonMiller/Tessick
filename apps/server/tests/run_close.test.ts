import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Closing a run: manual close/reopen and auto-close when every case has a result', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function login(app: any, username = 'admin', password = 'password'): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  async function planCaseRows(db: any, planId: string) {
    return db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select(['tpc.id as test_plan_case_id', 'tc.external_id'])
      .where('tpc.test_plan_id', '=', planId)
      .execute();
  }

  it('auto-closes the first time every case has a result, refuses results until reopened, and never auto-closes again after a reopen', async () => {
    const { app, seed, db } = serverInstance;
    const token = await login(app);
    const h = { authorization: `Bearer ${token}` };
    const rows = await planCaseRows(db, seed.planId);
    expect(rows.length).toBeGreaterThan(1);

    // Every case but the last via batch: run stays open.
    const batch = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results/batch`,
      headers: h,
      payload: { results: rows.slice(0, -1).map((r: any) => ({ case_identifier: { external_id: r.external_id }, verdict: 'PASSED' })) },
    });
    expect(batch.statusCode).toBe(201);
    expect(JSON.parse(batch.payload).run_status).toBe('OPEN');

    // Last case via the single route: run auto-closes.
    const last = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[rows.length - 1].test_plan_case_id, verdict: 'FAILED' },
    });
    expect(last.statusCode).toBe(201);
    expect(JSON.parse(last.payload).run_status).toBe('CLOSED');

    const audit = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'RUN_AUTO_CLOSED').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].resource_id).toBe(seed.buildId);

    // Closed: no more results.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'FAILED' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(JSON.parse(blocked.payload).code).toBe('RUN_CLOSED');

    // Reopen (RUN_MANAGE) and a result can be recorded again.
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${seed.buildId}`,
      headers: h,
      payload: { status: 'OPEN' },
    });
    expect(reopen.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'BLOCKED' },
    });
    expect(again.statusCode).toBe(201);
    // Every case still has a result, but the run already auto-closed once -- it stays open.
    expect(JSON.parse(again.payload).run_status).toBe('OPEN');
    const auditAfter = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'RUN_AUTO_CLOSED').execute();
    expect(auditAfter).toHaveLength(1);
  });

  it('a manually closed run blocks results; a Tester (no RUN_MANAGE) cannot open or close it', async () => {
    const { app, seed, db } = serverInstance;
    const token = await login(app);
    const h = { authorization: `Bearer ${token}` };
    const url = `/api/v1/runs/${seed.buildId}`;

    const close = await app.inject({ method: 'PATCH', url, headers: h, payload: { status: 'CLOSED' } });
    expect(close.statusCode).toBe(200);
    const rows = await planCaseRows(db, seed.planId);
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'PASSED' },
    });
    expect(blocked.statusCode).toBe(422);

    const username = `tester_${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: h,
      payload: { username, email: `${username}@tessick.local`, password: 'SecurePass123!', global_role: 'Tester' },
    });
    const testerToken = await login(app, username, 'SecurePass123!');
    const denied = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${testerToken}` }, payload: { status: 'OPEN' } });
    expect(denied.statusCode).toBe(403);
  });

  async function createTester(app: any, adminHeaders: Record<string, string>): Promise<Record<string, string>> {
    const username = `tester_${Math.random().toString(36).slice(2, 10)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: adminHeaders,
      payload: { username, email: `${username}@tessick.local`, password: 'SecurePass123!', global_role: 'Tester' },
    });
    expect(created.statusCode).toBe(201);
    return { authorization: `Bearer ${await login(app, username, 'SecurePass123!')}` };
  }

  /** Every case but the last gets a result through CI, so the next single result completes the run. */
  async function allButLast(app: any, h: Record<string, string>, runId: string, rows: any[]) {
    const batch = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/results/batch`,
      headers: h,
      payload: { results: rows.slice(0, -1).map((r: any) => ({ case_identifier: { external_id: r.external_id }, verdict: 'PASSED' })) },
    });
    expect(batch.statusCode).toBe(201);
    return JSON.parse(batch.payload);
  }

  const autoCloseRows = (db: any) => db.selectFrom('audit_logs').selectAll().where('action', '=', 'RUN_AUTO_CLOSED').execute();

  it('Fail with defer_auto_close keeps the run open until the notes arrive; the notes are saved and then close it (a Tester, no EXECUTE_OVERWRITE)', async () => {
    const { app, seed, db } = serverInstance;
    const admin = { authorization: `Bearer ${await login(app)}` };
    const tester = await createTester(app, admin);
    const rows = await planCaseRows(db, seed.planId);
    await allButLast(app, admin, seed.buildId, rows);
    const last = rows[rows.length - 1].test_plan_case_id;
    const url = `/api/v1/runs/${seed.buildId}/results`;

    // `f`: the last missing result, recorded with the auto-close deferred.
    const fail = await app.inject({ method: 'POST', url, headers: tester, payload: { test_plan_case_id: last, verdict: 'FAILED', defer_auto_close: true } });
    expect(fail.statusCode).toBe(201);
    expect(JSON.parse(fail.payload)).toMatchObject({ run_status: 'OPEN', auto_close_deferred: true });
    expect(await autoCloseRows(db)).toHaveLength(0);

    // Ctrl+Enter: the same verdict again with the notes. Accepted, and now the run auto-closes.
    const notes = await app.inject({ method: 'POST', url, headers: tester, payload: { test_plan_case_id: last, verdict: 'FAILED', notes: 'Checkout button does nothing' } });
    expect(notes.statusCode).toBe(201);
    expect(JSON.parse(notes.payload)).toMatchObject({ run_status: 'CLOSED', auto_close_deferred: false });
    expect(await autoCloseRows(db)).toHaveLength(1);

    const latest = await app.inject({ method: 'GET', url: `${url}?latest_only=true`, headers: admin });
    const mine = JSON.parse(latest.payload).results.find((r: any) => r.test_plan_case_id === last);
    expect(mine).toMatchObject({ verdict: 'FAILED', notes: 'Checkout button does nothing' });
  });

  it('POST /runs/:runId/auto-close finishes a deferred auto-close, once, and only for your own single result', async () => {
    const { app, seed, db } = serverInstance;
    const admin = { authorization: `Bearer ${await login(app)}` };
    const tester = await createTester(app, admin);
    const rows = await planCaseRows(db, seed.planId);
    await allButLast(app, admin, seed.buildId, rows);
    const finishUrl = `/api/v1/runs/${seed.buildId}/auto-close`;

    const block = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: tester,
      payload: { test_plan_case_id: rows[rows.length - 1].test_plan_case_id, verdict: 'BLOCKED', defer_auto_close: true },
    });
    expect(JSON.parse(block.payload).auto_close_deferred).toBe(true);
    const resultId = JSON.parse(block.payload).result.id;

    // Missing id, an unknown one, and someone else's result.
    expect((await app.inject({ method: 'POST', url: finishUrl, headers: tester, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: finishUrl, headers: tester, payload: { test_result_id: '00000000-0000-0000-0000-000000000000' } })).statusCode).toBe(404);
    const notYours = await app.inject({ method: 'POST', url: finishUrl, headers: admin, payload: { test_result_id: resultId } });
    expect(notYours.statusCode).toBe(403);
    expect(JSON.parse(notYours.payload).code).toBe('AUTO_CLOSE_NOT_YOURS');
    expect(await autoCloseRows(db)).toHaveLength(0);

    const finish = await app.inject({ method: 'POST', url: finishUrl, headers: tester, payload: { test_result_id: resultId } });
    expect(finish.statusCode).toBe(200);
    expect(JSON.parse(finish.payload)).toEqual({ run_status: 'CLOSED' });
    const audit = await autoCloseRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].resource_id).toBe(seed.buildId);

    // Again (e.g. the tab closing after the notes closed it): nothing more happens.
    const again = await app.inject({ method: 'POST', url: finishUrl, headers: tester, payload: { test_result_id: resultId } });
    expect(JSON.parse(again.payload)).toEqual({ run_status: 'CLOSED' });
    expect(await autoCloseRows(db)).toHaveLength(1);

    // Reopened after its auto-close: finishing never closes it a second time.
    await app.inject({ method: 'PATCH', url: `/api/v1/runs/${seed.buildId}`, headers: admin, payload: { status: 'OPEN' } });
    const afterReopen = await app.inject({ method: 'POST', url: finishUrl, headers: tester, payload: { test_result_id: resultId } });
    expect(JSON.parse(afterReopen.payload)).toEqual({ run_status: 'OPEN' });
    expect(await autoCloseRows(db)).toHaveLength(1);
  });

  it('a deferral only reports what it put off; CI results cannot be used to auto-close a run', async () => {
    const { app, seed, db } = serverInstance;
    const admin = { authorization: `Bearer ${await login(app)}` };
    const rows = await planCaseRows(db, seed.planId);
    const url = `/api/v1/runs/${seed.buildId}/results`;

    // Not the last missing result: nothing was deferred.
    const early = await app.inject({ method: 'POST', url, headers: admin, payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'FAILED', defer_auto_close: true } });
    expect(JSON.parse(early.payload)).toMatchObject({ run_status: 'OPEN', auto_close_deferred: false });

    const bad = await app.inject({ method: 'POST', url, headers: admin, payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'FAILED', defer_auto_close: 'yes' } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.payload).invalid_params).toEqual([{ name: 'defer_auto_close', reason: 'must be true or false' }]);

    // Every case covered by CI: the run stays open, and a CI result can't finish an auto-close.
    await app.inject({
      method: 'POST',
      url: `${url}/batch`,
      headers: admin,
      payload: { results: rows.map((r: any) => ({ case_identifier: { external_id: r.external_id }, verdict: 'PASSED' })) },
    });
    const ciResult = await db
      .selectFrom('test_results')
      .select('id')
      .where('test_run_id', '=', seed.buildId)
      .where('source', '!=', 'UI')
      .executeTakeFirstOrThrow();
    const finish = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/auto-close`, headers: admin, payload: { test_result_id: ciResult.id } });
    expect(finish.statusCode).toBe(403);
    expect(await autoCloseRows(db)).toHaveLength(0);
  });
});
