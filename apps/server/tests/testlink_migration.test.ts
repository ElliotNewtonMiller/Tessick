import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { migrateTestLink, MigrationError } from '../src/testlinkMigration/migrate.js';
import { testLinkSourceFixture, QA_KEY, PROJECT_KEY, PLAN_KEY, type TestLinkFixture } from './testlinkSourceFixture.js';

/**
 * The migration from TestLink's database (phase 5): a TestLink (testlinkSourceFixture.ts) moved
 * into a fresh Tessick, then read back through the TestLink-compatible API with a migrated
 * user's own TestLink key, so ids, keys and history must have come across as TestLink had them.
 * With TESTLINK_SQL_DIR (TestLink's install/sql/postgres), the TestLink is built from TestLink's
 * own schema and default data.
 */
describe('Migrating a TestLink database', () => {
  let app: any;
  let db: any;
  let tl: TestLinkFixture;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const get = async (path: string, key = QA_KEY) => {
    const res = await app.inject({ method: 'GET', url: `/lib/api/rest/custom${path}`, headers: { apikey: key } });
    expect(res.statusCode, `${path}: ${res.payload}`).toBe(200);
    return body(res);
  };
  const api = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });
    expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBeLessThan(300);
    return body(res);
  };
  const migrate = (opts: { dryRun?: boolean } = {}) => migrateTestLink(db, tl.source, { actor: 'admin', ...opts });

  beforeEach(async () => {
    ({ app, db } = await createServer());
    tl = await testLinkSourceFixture();
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app?.close();
    await tl?.db.destroy();
  });

  it('reports what it brought, what it skipped and why', async () => {
    const report = await migrate();
    const created = Object.fromEntries(Object.entries(report.counts).map(([k, t]) => [k, t.created]));
    expect(created).toEqual({
      users: 3,
      projects: 1,
      suites: 4,
      cases: 4,
      versions: 5,
      steps: 3,
      custom_fields: 5,
      keywords: 2,
      plans: 2,
      plan_cases: 3,
      platforms: 2,
      builds: 2,
      executions: 5,
      step_results: 2,
      project_roles: 1,
    });
    expect(report.counts.users).toMatchObject({ testlink: 4, existing: 1 }); // admin was there
    expect(report.counts.executions).toMatchObject({ testlink: 7, skipped: 2 });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        "Custom field 'colour' (TestLink type 9) became a SINGLE_SELECT field.",
        "1 executions with the status code 'x' weren't migrated: Tessick knows p, f and b.",
      ])
    );
    expect(await db.selectFrom('audit_logs').select('action').where('action', '=', 'TESTLINK_MIGRATED').execute()).toHaveLength(1);
  });

  it("answers TestLink's requests with TestLink's ids and keys, to a migrated user's own key", async () => {
    await migrate();
    expect((await app.inject({ method: 'GET', url: '/lib/api/rest/custom/whoAmI', headers: { apikey: QA_KEY } })).statusCode).toBe(200);
    const project = (await get('/testprojects')).item.find((p: any) => p.prefix === 'MA');
    expect(project).toEqual({ id: 1, name: 'Mobile App', prefix: 'MA', notes: 'Phones & tablets', active: 1, is_public: 1, api_key: PROJECT_KEY });

    const tree = (await get('/testprojects/1/testsuites')).items;
    expect(tree.map((s: any) => [s.id, s.parent_id, s.children.map((c: any) => c.id)])).toEqual([
      [40, 1, [41, 42]],
      [50, 1, []],
    ]);

    const cases = (await get('/testprojects/1/testcases')).items;
    expect(cases.map((c: any) => [c.id, c.tcversion_id, c.external_id, c.version, c.status, c.active])).toEqual([
      [100, 103, 'MA-1', 2, 1, 1],
      [110, 111, 'MA-2', 1, 5, 0],
      [120, 121, 'MA-3', 1, 7, 1],
      [130, 131, 'MA-4', 1, 1, 1],
    ]);
    const login = cases[0];
    expect(login).toMatchObject({ name: 'Login with valid credentials', summary: 'Verify login, v2', importance: 3, keywords: { '12': 'smoke' } });
    expect(login.steps).toEqual([
      { step_number: 1, actions: 'Open the login page', expected_results: 'The form shows', execution_type: 1 },
      { step_number: 2, actions: 'Sign in', expected_results: 'The dashboard shows', execution_type: 2 },
    ]);
    const cf = (c: any, n: string) => (Object.values(c.customfields) as any[]).find((f) => f.name === n);
    expect([cf(login, 'automationStatus').id, cf(login, 'automationStatus').value, cf(login, 'colour').value]).toEqual([7, 'Done', 'blue']);
    expect([cases[2].estimated_exec_duration, cf(cases[2], 'jiraKey').value, cf(cases[2], 'releaseDate').value]).toEqual(['5', 'MA-999', '2026-06-01']);
    // Unset stays unset, not the field's default (N/A).
    expect(cf(cases[3], 'automationStatus').value).toBeNull();

    expect((await get('/testprojects/1/keywords')).items).toEqual([
      { id: 12, keyword: 'smoke', notes: '' },
      { id: 15, keyword: 'regression', notes: '' },
    ]);
    expect((await get('/testprojects/1/customfields')).items.map((f: any) => [f.id, f.name, f.type_name])).toEqual([
      [7, 'automationStatus', 'list'],
      [11, 'colour', 'list'],
      [8, 'jiraKey', 'string'],
      [10, 'releaseDate', 'date'],
    ]);
    const metrics = (await get(`/testcasemetrics?projectApiKey=${PROJECT_KEY}`)).metrics;
    expect(metrics).toMatchObject({ total: 3, automation_status: { Done: 1, 'To Do': 1 }, testcases_without_automation_status: [130] });

    const plans = (await get('/testprojects/1/testplans')).items;
    expect(plans.map((p: any) => [p.id, p.name, p.active, p.is_open, p.api_key])).toEqual([
      [210, 'Old release', 0, 0, 'd'.repeat(64)],
      [200, 'Release 2.0', 1, 1, PLAN_KEY],
    ]);
    expect((await get(`/testplans/${PLAN_KEY}/builds`)).items.map((b: any) => [b.id, b.name, b.is_open, b.release_date])).toEqual([
      [31, 'Build 2.0.0', 0, null],
      [30, 'Build 2.0.1', 1, '2024-06-01'],
    ]);
  });

  it('keeps the history: a run per build and platform, testers, times, step results, a case that left the plan', async () => {
    await migrate();
    const project = (await api('GET', '/api/v1/projects')).projects.find((p: any) => p.prefix === 'MA');
    const plan = (await api('GET', `/api/v1/projects/${project.id}/plans`)).plans.find((p: any) => p.name === 'Release 2.0');
    const runs = (await api('GET', `/api/v1/plans/${plan.id}/runs`)).runs;
    expect(runs.map((r: any) => r.name).sort()).toEqual(['Build 2.0.0', 'Build 2.0.0 — iOS', 'Build 2.0.1', 'Build 2.0.1 — Android', 'Build 2.0.1 — iOS']);
    const results = async (runName: string) => (await api('GET', `/api/v1/runs/${runs.find((r: any) => r.name === runName).id}/results?limit=100`)).results;

    const ios = await results('Build 2.0.1 — iOS');
    expect(ios.map((r: any) => r.verdict).sort()).toEqual(['BLOCKED', 'PASSED', 'PASSED']);
    const first = ios.find((r: any) => r.notes === 'Fine on iOS');
    expect(first).toMatchObject({ executed_at: '2024-06-02T10:00:00.000Z', verdict: 'PASSED' });
    const qa = (await api('GET', '/api/v1/admin/users')).users.find((u: any) => u.username === 'qa.engineer');
    expect(first.tester_id ?? first.tester?.id).toBe(qa.id);
    expect(ios.find((r: any) => r.verdict === 'BLOCKED').duration_ms).toBe(150_000);
    expect((await results('Build 2.0.1 — Android')).map((r: any) => r.verdict)).toEqual(['FAILED']);
    expect(await results('Build 2.0.1')).toEqual([]);
    // Refund (MA-4) isn't in the plan any more; its result is kept on a retired link.
    const links = await db.selectFrom('test_plan_cases').select(['test_case_id', 'removed_at']).where('test_plan_id', '=', plan.id).execute();
    expect(links.filter((l: any) => l.removed_at !== null)).toHaveLength(1);
    const steps = await db.selectFrom('test_step_results').select(['verdict', 'actual_result']).orderBy('verdict').execute();
    expect(steps).toEqual([
      { verdict: 'FAILED', actual_result: 'Crashed' },
      { verdict: 'PASSED', actual_result: 'Shown' },
    ]);
  });

  it("migrates users without their passwords, with their roles and TestLink keys", async () => {
    await migrate();
    const users = (await api('GET', '/api/v1/admin/users')).users;
    const by = (n: string) => users.find((u: any) => u.username === n);
    expect(by('qa.engineer')).toMatchObject({ email: 'qa@example.com', status: 'ACTIVE', global_role: 'Tester', testlink_key: { key_prefix: QA_KEY.slice(0, 6) } });
    expect(by('lead')).toMatchObject({ email: 'lead@testlink.invalid', global_role: 'Test Lead', testlink_key: null });
    expect(by('gone')).toMatchObject({ status: 'DISABLED', testlink_key: null });
    const projectRoles = await db.selectFrom('user_project_roles').innerJoin('users', 'users.id', 'user_project_roles.user_id').select(['users.username', 'role']).execute();
    expect(projectRoles).toEqual([{ username: 'qa.engineer', role: 'Test Lead' }]);
    // No password signs them in until an admin sets one.
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'qa.engineer', password: 'x' } });
    expect(login.statusCode).toBe(401);
  });

  it('numbers new rows above TestLink\'s, and brings only what TestLink gained when run again', async () => {
    await migrate();
    const suite = await app.inject({
      method: 'POST',
      url: '/lib/api/rest/custom/testsuites',
      headers: { apikey: QA_KEY, 'content-type': 'application/json' },
      payload: { name: 'New after the move', testProjectID: 1 },
    });
    expect(body(suite).id).toBe(211);

    const again = await migrate();
    expect(Object.values(again.counts).every((t) => t.created === 0)).toBe(true);
    expect(again.counts.cases).toMatchObject({ testlink: 4, existing: 4 });

    await tl.run(`INSERT INTO executions (id, build_id, tester_id, execution_ts, status, testplan_id, tcversion_id, platform_id, execution_type, notes) VALUES (6000, 30, 7, '2024-06-04 09:00:00', 'p', 200, 121, 2, 2, 'Later')`);
    const later = await migrate();
    expect(later.counts.executions).toMatchObject({ created: 1, existing: 5 });
  });

  it('a dry run writes nothing; a number Tessick gave something else stops the migration', async () => {
    const dry = await migrate({ dryRun: true });
    expect(dry.counts.cases.created).toBe(4);
    expect(await db.selectFrom('projects').select('prefix').where('prefix', '=', 'MA').execute()).toEqual([]);
    expect(await db.selectFrom('compat_ids').select('int_id').execute()).toEqual([]);

    // Using the compatible API first numbers Tessick's own project 1.
    const key = (await api('POST', '/api/v1/auth/me/testlink-key')).plaintext;
    await get('/testprojects', key);
    await expect(migrate()).rejects.toThrow(MigrationError);
    await expect(migrate()).rejects.toThrow(/number Tessick already gave/);
  });
});
