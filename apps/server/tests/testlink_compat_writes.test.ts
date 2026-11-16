import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CompatPlatformRepository } from '@tessick/db';
import { testLinkFixture } from './testlinkFixture.js';

/**
 * The TestLink-compatible API, phase 3: writes. Each goes through Tessick's own route as the
 * key's user and answers as TestLink does: 200 with the row's TestLink id, or `id: -1`. A
 * refusal has the HTTP code Dave's spec documents for the route, otherwise 200 with
 * `status: "ko"` (as TestLink's PHP answers). (The data is in testlinkFixture.ts.)
 */
describe('TestLink-compatible API: writes', () => {
  let fx: Awaited<ReturnType<typeof testLinkFixture>>;
  let project: number;
  let rootSuite: number;
  let plan: { id: number; api_key: string };

  beforeEach(async () => {
    fx = await testLinkFixture();
    project = (await fx.ok('/testprojects/SHOP')).item.id;
    rootSuite = (await fx.ok('/testprojects/SHOP/testsuites')).items[0].id;
    plan = (await fx.ok('/testprojects/SHOP/testplans')).items[0];
  });
  afterEach(async () => {
    await fx.app.close();
  });

  const created = async (path: string, payload: unknown, version = 'custom') => {
    const res = await fx.post(path, payload, version);
    expect([res.status, res.body.status, res.body.message], `${path}: ${JSON.stringify(res.body)}`).toEqual([200, 'ok', 'ok']);
    expect(res.body.id).toEqual(expect.any(Number));
    return res.body.id as number;
  };
  const caseNamed = async (name: string) => (await fx.ok('/testprojects/SHOP/testcases')).items.find((c: any) => c.name === name);
  const versionsOf = async (external: string) => (await fx.call(fx.admin, 'GET', `/api/v1/cases/${external}/versions`)).versions;

  it('creates a project, and plans in it (an inactive plan is archived); changes a plan', async () => {
    const id = await created('/testprojects', { name: 'Mobile App', prefix: 'MA', notes: '<p>Phones</p>', active: 1, public: 1, options: { automationEnabled: 1 } }, 'v1');
    expect((await fx.ok(`/testprojects/${id}`)).item).toMatchObject({ id, name: 'Mobile App', prefix: 'MA', notes: 'Phones' });
    const dup = await fx.post('/testprojects', { name: 'Mobile App', prefix: 'MA' });
    expect([dup.status, dup.body.status, dup.body.id]).toEqual([200, 'ko', -1]);
    expect((await fx.post('/testprojects', { prefix: 'X' })).body).toEqual({ status: 'ko', message: 'Missing required property: name', id: -1 });

    const p1 = await created('/testplans', { name: 'Release 2.0', testProjectID: id, notes: 'Full regression', active: 1, is_public: 1 });
    const p2 = await created('/testplans', { name: 'Old release', testProjectID: id, active: 0 }, 'v1');
    const plans = (await fx.ok(`/testprojects/${id}/testplans`)).items;
    expect(plans.map((p: any) => [p.id, p.name, p.active, p.is_open])).toEqual([
      [p2, 'Old release', 0, 0],
      [p1, 'Release 2.0', 1, 1],
    ]);
    expect(await created(`/testplans/${p1}`, { name: 'Release 2.0 (smoke)', notes: 'Narrowed' })).toBe(p1);
    expect(await created(`/testplans/${p2}`, { active: 1 })).toBe(p2);
    expect((await fx.ok(`/testprojects/${id}/testplans`)).items.map((p: any) => [p.name, p.notes, p.active])).toEqual([
      ['Old release', '', 1],
      ['Release 2.0 (smoke)', 'Narrowed', 1],
    ]);
    const unknown = await fx.post('/testplans', { name: 'x', testProjectID: 999999 });
    expect([unknown.status, unknown.body.id]).toEqual([200, -1]);
  });

  it('creates builds by plan id or API key, refuses a duplicate name, and opens and closes them', async () => {
    const b1 = await fx.post('/builds', { testplan: plan.id, name: 'Build 2.0.1', notes: 'Nightly', releasedate: '2026-06-01' });
    expect(b1).toEqual({ status: 200, body: { status: 'ok', message: 'ok', details: [], id: expect.any(Number) } });
    const b2 = await created('/builds', { testplan: plan.api_key, name: 'Build 2.0.2', is_open: 0 });
    const dup = await fx.post('/builds', { testplan: plan.id, name: 'Build 2.0.1' });
    expect([dup.status, dup.body]).toEqual([409, { status: 'ko', message: `Build name 'Build 2.0.1' already exists (id ${b1.body.id})`, details: [], id: -1 }]);
    const noPlan = await fx.post('/builds', { testplan: 999999, name: 'x' });
    expect([noPlan.status, noPlan.body]).toEqual([404, { status: 'ko', message: 'ko', details: ['Test plan ID 999999 does not exist'], id: -1 }]);

    const builds = async () => (await fx.ok(`/testplans/${plan.api_key}/builds`)).items;
    expect((await builds()).find((b: any) => b.id === b2)).toMatchObject({ is_open: 0 });
    expect((await fx.post(`/builds/${b2}`, { is_open: 1, name: 'Build 2.0.2-rc', releasedate: '2026-06-02' })).body).toEqual({ status: 'ok', message: 'ok', details: [], id: b2 });
    expect((await builds()).find((b: any) => b.id === b2)).toMatchObject({ name: 'Build 2.0.2-rc', is_open: 1, release_date: '2026-06-02' });
    const invalid = await fx.post('/builds/999999', { name: 'x' });
    expect([invalid.status, invalid.body.message]).toEqual([404, 'Invalid build id 999999']);
    // Builds aren't in v1.
    expect((await fx.post('/builds', { testplan: plan.id, name: 'v1' }, 'v1')).status).toBe(404);
  });

  it('creates suites at the top or nested, with the project or a suite as parent', async () => {
    const top = await created('/testsuites', { name: 'Checkout', testProjectID: project, parentID: project, notes: '<p>Payments</p>', order: 3 }, 'v1');
    const omitted = await created('/testsuites', { name: 'Search', testProjectID: project });
    const nested = await created('/testsuites', { name: 'Cards', testProjectID: project, parentID: top });
    const tree = (await fx.ok('/testprojects/SHOP/testsuites')).items;
    expect(tree.find((s: any) => s.id === top)).toMatchObject({ parent_id: project, node_order: 3, children: [expect.objectContaining({ id: nested, parent_id: top })] });
    expect(tree.find((s: any) => s.id === omitted)).toMatchObject({ parent_id: project });
    const bad = await fx.post('/testsuites', { name: 'x', testProjectID: project, parentID: 999999 });
    expect([bad.status, bad.body]).toEqual([200, { status: 'error', message: "No Test Project or Test Suite identified by '999999' to use as parent!", id: -1 }]);
  });

  it("creates a case from Dave's example: HTML as text, steps, keywords and custom fields; draft unless status 7", async () => {
    const smoke = (await fx.ok('/testprojects/SHOP/keywords')).items.find((k: any) => k.keyword === 'smoke').id;
    const id = await created('/testcases', {
      name: 'Login with valid credentials',
      testSuite: { id: rootSuite },
      testProject: { prefix: 'SHOP' },
      author: { login: 'qa.engineer' },
      summary: '<p>Verify a user can log in with valid credentials</p>',
      preconditions: '<p>A user account exists &amp; is active</p>',
      importance: 3,
      executionType: 2,
      status: 1,
      estimatedExecDuration: 5,
      order: 1,
      steps: [
        { step_number: 1, actions: '<p>Navigate to the login page</p>', expected_results: '<p>Login form is displayed</p>', execution_type: 1 },
        { step_number: 2, actions: '<p>Enter valid credentials and submit</p>', expected_results: '<p>User lands on the dashboard</p>', execution_type: 2 },
      ],
      keywords: [smoke, 999999],
      customFields: { automationStatus: 'To Do', Type: 'Functional', jiraKey: 'SAND-100' },
    });
    const c = await caseNamed('Login with valid credentials');
    expect(c).toMatchObject({
      id,
      summary: 'Verify a user can log in with valid credentials',
      preconditions: 'A user account exists & is active',
      importance: 3,
      execution_type: 2,
      // The admin may auto-approve, but TestLink asked for a draft.
      status: 1,
      steps: [
        { step_number: 1, actions: 'Navigate to the login page', expected_results: 'Login form is displayed', execution_type: 1 },
        { step_number: 2, actions: 'Enter valid credentials and submit', expected_results: 'User lands on the dashboard', execution_type: 2 },
      ],
      keywords: { [smoke]: 'smoke' },
    });
    expect(Object.values(c.customfields)).toContainEqual(expect.objectContaining({ name: 'automationStatus', value: 'To Do' }));

    const approved = await created('/testcases', { name: 'Logout', testSuite: { id: rootSuite }, testProject: { id: project }, status: 7 }, 'v1');
    expect((await caseNamed('Logout'))).toMatchObject({ id: approved, status: 7 });

    const dup = await fx.post('/testcases', { name: 'Logout', testSuite: { id: rootSuite }, testProject: { id: project } });
    expect([dup.status, dup.body]).toEqual([409, { status: 'ko', message: 'Test case name already exists on this suite', id: -1 }]);
    const badValue = await fx.post('/testcases', { name: 'Bad', testSuite: { id: rootSuite }, testProject: { id: project }, customFields: { automationStatus: 'Maybe' } });
    expect([badValue.status, badValue.body.message]).toEqual([200, expect.stringMatching(/^customFields\.automationStatus: /)]);
    expect(await caseNamed('Bad')).toBeUndefined();
  });

  it('a tester may create drafts but not approve them', async () => {
    const tester = await fx.userWithKey('tess', 'Tester');
    const draft = await fx.post('/testcases', { name: 'By a tester', testSuite: { id: rootSuite }, testProject: { id: project } }, 'custom', tester);
    expect([draft.status, draft.body.status]).toEqual([200, 'ok']);
    const final = await fx.post('/testcases', { name: 'Approved by a tester', testSuite: { id: rootSuite }, testProject: { id: project }, status: 7 }, 'custom', tester);
    expect([final.status, final.body]).toMatchObject([200, { status: 'ko', message: 'Insufficient rights', id: -1 }]);
    const viewer = await fx.userWithKey('vic', 'Viewer');
    const refused = await fx.post('/testsuites', { name: 'By a viewer', testProjectID: project }, 'custom', viewer);
    expect([refused.status, refused.body.message, refused.body.id]).toEqual([200, 'Insufficient rights', -1]);
  });

  it('updates a case: an approved one gets a new draft (approved too with status 7); fields change in place', async () => {
    // SHOP-101 is approved, version 1.
    expect(await created('/testcases/SHOP-101', { customFields: { automationStatus: 'Done' }, importance: 1 })).toEqual(expect.any(Number));
    expect((await versionsOf('SHOP-101')).length).toBe(1);
    let c = (await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-101');
    expect(c).toMatchObject({ importance: 1, status: 7, version: 1 });
    expect(Object.values(c.customfields)).toContainEqual(expect.objectContaining({ name: 'automationStatus', value: 'Done' }));

    await created('/testcases/SHOP-101', { summary: '<p>Changed</p>' });
    c = (await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-101');
    expect(c).toMatchObject({ version: 2, status: 1, summary: 'Changed' });
    // A second change edits the same draft; status 7 approves it.
    await created(`/testcases/${c.id}`, { steps: [{ step_number: 1, actions: 'Only step', expected_results: 'ok' }], status: 7, name: 'OAuth2 PKCE (renamed)' });
    c = (await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-101');
    expect(c).toMatchObject({ version: 2, status: 7, name: 'OAuth2 PKCE (renamed)', steps: [{ step_number: 1, actions: 'Only step', expected_results: 'ok', execution_type: 1 }] });
    // Keywords: [] clears them.
    expect(c.keywords).toEqual({ [Object.keys(c.keywords)[0]]: 'smoke' });
    await created('/testcases/SHOP-101', { keywords: [] });
    expect((await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-101').keywords).toEqual({});

    // Inactive is deprecated; content can't change until it's active again.
    await created('/testcases/SHOP-102', { active: 0 });
    expect((await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-102')).toMatchObject({ status: 5, active: 0 });
    const locked = await fx.post('/testcases/SHOP-102', { summary: 'nope' });
    expect([locked.status, locked.body.id]).toEqual([409, -1]);
    await created('/testcases/SHOP-102', { active: 1, summary: 'Back' });
    expect((await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-102')).toMatchObject({ status: 1, active: 1, summary: 'Back' });

    const missing = await fx.post('/testcases/SHOP-999', { importance: 2 });
    expect([missing.status, missing.body]).toEqual([404, { status: 'error', message: "No Test Case identified by 'SHOP-999'!" }]);
    expect((await fx.post('/testcases/SHOP-101', { importance: 2 }, 'v2')).status).toBe(404);
  });

  it('moves cases and suites within their project', async () => {
    const target = await created('/testsuites', { name: 'Target', testProjectID: project });
    const c = (await fx.ok('/testprojects/SHOP/testcases')).items.find((x: any) => x.external_id === 'SHOP-103');
    expect(await created('/testcases/SHOP-103/move', { testSuiteID: target })).toBe(c.id);
    expect((await fx.ok(`/testsuites/${target}/testcases`)).items.map((x: any) => x.external_id)).toEqual(['SHOP-103']);
    expect(await created(`/testcases/${c.id}/move`, { testSuiteID: target })).toBe(c.id); // no-op
    expect((await fx.post('/testcases/SHOP-103/move', {})).body).toEqual({ status: 'ko', message: 'Missing required property: testSuiteID', id: -1 });
    expect((await fx.post('/testcases/SHOP-103/move', { testSuiteID: 999999 })).body).toEqual({ status: 'error', message: "No Test Suite identified by '999999'!" });

    const other = await created('/testprojects', { name: 'Other', prefix: 'OTH' });
    const otherSuite = await created('/testsuites', { name: 'Elsewhere', testProjectID: other });
    const cross = await fx.post('/testcases/SHOP-103/move', { testSuiteID: otherSuite });
    expect([cross.status, cross.body.message]).toEqual([409, 'Target test suite must belong to the same project as the test case']);

    // Suites: under another suite, back to the top, never into themselves.
    expect(await created(`/testsuites/${target}/move`, { parentID: rootSuite })).toBe(target);
    expect((await fx.ok('/testprojects/SHOP/testsuites')).items[0].children.map((s: any) => s.id)).toContain(target);
    const loop = await fx.post(`/testsuites/${rootSuite}/move`, { parentID: target });
    expect([loop.status, loop.body.message]).toEqual([409, 'A test suite cannot be moved into one of its own descendants']);
    expect(await created(`/testsuites/${target}/move`, { parentID: project })).toBe(target);
    expect((await fx.ok('/testprojects/SHOP/testsuites')).items.map((s: any) => s.id)).toContain(target);
    const crossSuite = await fx.post(`/testsuites/${target}/move`, { parentID: otherSuite });
    expect([crossSuite.status, crossSuite.body.status]).toEqual([409, 'error']);
  });

  it('creates keywords as options of the keywords field; their ids last', async () => {
    const other = await created('/testprojects', { name: 'Fresh', prefix: 'FR' });
    // The first keyword makes the project's field.
    const fast = await created('/keywords', { keyword: 'fast', notes: 'Quick ones', testProject: { prefix: 'FR' } });
    const slow = await created('/keywords', { keyword: 'slow', testProject: { prefix: 'FR' } });
    expect((await fx.ok(`/testprojects/${other}/keywords`)).items).toEqual([
      { id: fast, keyword: 'fast', notes: '' },
      { id: slow, keyword: 'slow', notes: '' },
    ]);
    const dup = await fx.post('/keywords', { keyword: 'FAST', testProject: { prefix: 'FR' } });
    expect([dup.status, dup.body.id]).toEqual([200, -1]);
    // SHOP's existing field takes new options, and the old keywords keep their ids.
    const before = (await fx.ok('/testprojects/SHOP/keywords')).items;
    await created('/keywords', { keyword: 'regression', testProject: { prefix: 'SHOP' } });
    const after = (await fx.ok('/testprojects/SHOP/keywords')).items;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((k: any) => k.keyword)).toEqual([...before.map((k: any) => k.keyword), 'regression']);
    // Not on v1.
    expect((await fx.post('/keywords', { keyword: 'x', testProject: { prefix: 'FR' } }, 'v1')).status).toBe(404);
  });

  it('records executions as CI results: no auto-close, closed builds and unlinked cases refused', async () => {
    const build = (await fx.ok(`/testplans/${plan.api_key}/builds`)).items[0];
    const codes = ['p', 'f', 'b', 'p', 'p', 'p', 'p', 'p', 'p', 'p'];
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const ext = `SHOP-10${i + 1}`;
      ids.push(await created('/executions', { testPlanID: plan.id, buildID: build.id, testCaseExternalID: ext, notes: 'via automation', statusCode: codes[i], executionType: 2 }, i === 0 ? 'v1' : 'custom'));
    }
    expect(new Set(ids).size).toBe(10);
    // Every case has a result, and the run stays open (TestLink never closes a build).
    const run = (await fx.call(fx.admin, 'GET', `/api/v1/plans/${fx.seed.planId}/runs`)).runs[0];
    expect(run).toMatchObject({ status: 'OPEN' });
    const results = (await fx.call(fx.admin, 'GET', `/api/v1/runs/${run.id}/results?limit=100`)).results;
    expect(results.find((r: any) => r.test_case_id === fx.seed.caseIds[1])).toMatchObject({ verdict: 'FAILED', notes: 'via automation' });

    const bad = await fx.post('/executions', { testPlanID: plan.id, buildID: build.id, testCaseExternalID: 'SHOP-101', statusCode: 'n' });
    expect([bad.status, bad.body.id]).toEqual([200, -1]);
    const unlinked = await fx.post('/executions', { testPlanID: plan.id, buildID: build.id, testCaseExternalID: 'SHOP-1011', statusCode: 'p' });
    expect([unlinked.status, unlinked.body.message]).toEqual([200, `Test case SHOP-1011 isn't linked to test plan ${plan.id}`]);
    expect((await fx.post('/executions', { testPlanID: plan.id, buildID: build.id, statusCode: 'p' })).body.message).toBe('Missing required property: testCaseExternalID');
    await created(`/builds/${build.id}`, { is_open: 0 });
    const closed = await fx.post('/executions', { testPlanID: plan.id, buildID: build.id, testCaseExternalID: 'SHOP-101', statusCode: 'p' });
    expect([closed.status, closed.body.status]).toEqual([200, 'ko']);
  });

  it('links platforms to a plan; each (build, platform) records into its own run', async () => {
    const platforms = new CompatPlatformRepository(fx.db);
    await platforms.create(fx.seed.projectId, 'iOS');
    await platforms.create(fx.seed.projectId, 'Android');
    const unknown = await fx.post(`/testplans/${plan.id}/platforms`, [{ name: 'iOS' }, { name: 'Windows Phone' }]);
    expect(unknown).toEqual({ status: 200, body: { status: false, message: ["Platform 'Windows Phone' does not exist in this test project"] } });
    expect(await fx.post(`/testplans/${plan.id}/platforms`, [{ name: 'ios' }, { name: 'Android' }])).toEqual({ status: 200, body: { status: true, message: 'ok' } });
    expect((await fx.post(`/testplans/${plan.id}/platforms`, [{ name: 'iOS' }], 'v1')).status).toBe(404);

    const build = await created('/builds', { testplan: plan.id, name: 'Build 3' });
    const needs = await fx.post('/executions', { testPlanID: plan.id, buildID: build, testCaseExternalID: 'SHOP-101', statusCode: 'p' });
    expect([needs.status, needs.body.message]).toEqual([200, `Test plan ${plan.id} has platforms: platformID is required`]);

    // Platform numbers, as the migration's platforms would have them.
    const { CompatIdRepository } = await import('@tessick/db');
    const list = await platforms.platformsOfPlan(fx.seed.planId);
    const numbers = await new CompatIdRepository(fx.db).intIds('platform', list.map((p) => p.id));
    const ios = numbers.get(list.find((p) => p.name === 'iOS')!.id)!;
    const android = numbers.get(list.find((p) => p.name === 'Android')!.id)!;
    await created('/executions', { testPlanID: plan.id, buildID: build, platformID: ios, testCaseExternalID: 'SHOP-101', statusCode: 'p' });
    await created('/executions', { testPlanID: plan.id, buildID: build, platformID: android, testCaseExternalID: 'SHOP-101', statusCode: 'f' });
    await created('/executions', { testPlanID: plan.id, buildID: build, platformID: ios, testCaseExternalID: 'SHOP-102', statusCode: 'p' });

    const runs = (await fx.call(fx.admin, 'GET', `/api/v1/plans/${fx.seed.planId}/runs`)).runs;
    expect(runs.map((r: any) => r.name).sort()).toEqual(['Build 3', 'Build 3 — Android', 'Build 3 — iOS', 'v1.0.0-rc1']);
    expect(runs.find((r: any) => r.name === 'Build 3 — iOS').summary).toMatchObject({ passed: 2 });
    expect(runs.find((r: any) => r.name === 'Build 3 — Android').summary).toMatchObject({ failed: 1 });
    // The builds list shows builds, not their platform runs; renaming a build renames them.
    expect((await fx.ok(`/testplans/${plan.api_key}/builds`)).items.map((b: any) => b.name)).toEqual(['Build 3', 'v1.0.0-rc1']);
    await created(`/builds/${build}`, { name: 'Build 3.1', is_open: 0 });
    const renamed = (await fx.call(fx.admin, 'GET', `/api/v1/plans/${fx.seed.planId}/runs`)).runs;
    expect(renamed.filter((r: any) => r.name.startsWith('Build 3.1')).map((r: any) => r.status)).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);
  });

  it("reads a body whatever its Content-Type, and audits changes as the key's user, via the TestLink API", async () => {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/lib/api/rest/custom/testsuites',
      headers: { apikey: fx.key, 'content-type': 'text/plain', 'user-agent': 'tl-script/1.0' },
      payload: JSON.stringify({ name: 'Plain body', testProjectID: project }),
    });
    expect([res.statusCode, JSON.parse(res.payload).status]).toEqual([200, 'ok']);
    const audit = await fx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'SUITE_CREATED').orderBy('created_at', 'desc').executeTakeFirst();
    expect(audit).toMatchObject({ user_agent: 'tl-script/1.0 (via TestLink API)', actor_type: 'USER' });
    const bad = await fx.app.inject({ method: 'POST', url: '/lib/api/rest/custom/testsuites', headers: { apikey: fx.key, 'content-type': 'application/json' }, payload: '{nope' });
    expect([bad.statusCode, JSON.parse(bad.payload).status]).toEqual([200, 'ko']);
  });
});
