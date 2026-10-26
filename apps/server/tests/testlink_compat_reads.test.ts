import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testLinkFixture, q } from './testlinkFixture.js';

/**
 * The TestLink-compatible API, phase 2: reads. Projects, plans, builds, the suite tree, the spec
 * dump, keywords, custom fields and both case lists with the query layer, answered in TestLink's
 * shapes with TestLink's numeric ids (the data is in testlinkFixture.ts).
 */
describe('TestLink-compatible API: reads', () => {
  let app: any;
  let seed: any;
  let admin: string;
  let body: Awaited<ReturnType<typeof testLinkFixture>>['body'];
  let call: Awaited<ReturnType<typeof testLinkFixture>>['call'];
  let tl: Awaited<ReturnType<typeof testLinkFixture>>['tl'];
  let ok: Awaited<ReturnType<typeof testLinkFixture>>['ok'];

  beforeEach(async () => {
    ({ app, seed, admin, body, call, tl, ok } = await testLinkFixture());
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists projects with numeric ids, and finds one by id, name or (v2 and custom) prefix', async () => {
    const list = await ok('/testprojects');
    expect(list.item).toEqual([
      { id: expect.any(Number), name: 'E-Commerce Core Platform', prefix: 'SHOP', notes: expect.any(String), active: 1, is_public: 1, api_key: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    const id = list.item[0].id;
    expect((await ok(`/testprojects/${id}`, 'v1')).item).toEqual(list.item[0]);
    expect((await ok(`/testprojects/${encodeURIComponent('e-commerce core platform')}`, 'v1')).item.id).toBe(id);
    expect((await ok('/testprojects/SHOP', 'v2')).item.id).toBe(id);
    // v1 doesn't take a prefix; an unknown project is TestLink's error.
    for (const [path, version] of [['/testprojects/SHOP', 'v1'], ['/testprojects/999999', 'custom'], ['/testprojects/999999/testplans', 'custom']]) {
      const res = await tl(path, version);
      expect([res.statusCode, body(res).status, body(res).message], path).toEqual([404, 'error', `No Test Project identified by '${path.split('/')[2]}'!`]);
    }
  });

  it("lists a project's plans and a plan's builds (by the plan's API key)", async () => {
    const plans = (await ok('/testprojects/SHOP/testplans')).items;
    expect(plans).toEqual([
      { id: expect.any(Number), name: 'Sprint 42 Regression Plan', notes: expect.any(String), active: 1, is_open: 1, is_public: 1, testproject_id: (await ok('/testprojects/SHOP')).item.id, api_key: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    const builds = (await ok(`/testplans/${plans[0].api_key}/builds`)).items;
    expect(builds).toEqual([{ id: 1, testplan_id: plans[0].id, name: 'v1.0.0-rc1', notes: expect.any(String), active: 1, is_open: 1, release_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    // Not on v1; an unknown key is an error.
    expect((await tl(`/testplans/${plans[0].api_key}/builds`, 'v1')).statusCode).toBe(404);
    const unknown = await tl('/testplans/nope/builds');
    expect([unknown.statusCode, body(unknown).status]).toEqual([404, 'error']);
  });

  it("lists a project's cases in TestLink's shape; v1 without keywords and custom fields", async () => {
    const items = (await ok('/testprojects/SHOP/testcases')).items;
    expect(items).toHaveLength(11);
    const first = items.find((c: any) => c.external_id === 'SHOP-101');
    expect(first).toEqual({
      id: expect.any(Number),
      tcversion_id: expect.any(Number),
      name: 'OAuth2 PKCE Code Exchange Flow',
      tc_external_id: '101',
      external_id: 'SHOP-101',
      version: 1,
      summary: expect.stringContaining('OAuth2'),
      preconditions: expect.any(String),
      importance: 3,
      status: 7,
      active: 1,
      execution_type: 1,
      estimated_exec_duration: null,
      steps: [
        { step_number: 1, actions: expect.stringContaining('step 1'), expected_results: expect.any(String), execution_type: 1 },
        { step_number: 2, actions: expect.stringContaining('step 2'), expected_results: expect.any(String), execution_type: 1 },
      ],
      keywords: { [Object.keys(first.keywords)[0]]: 'smoke' },
      customfields: {
        [Object.keys(first.customfields)[0]]: expect.objectContaining({ name: 'automationStatus', label: 'Automation Status', type: 6, type_name: 'list', value: null }),
      },
    });
    const old = items.find((c: any) => c.name === 'Old flow');
    expect([old.status, old.active, old.execution_type, old.tc_external_id]).toEqual([5, 0, 2, '1011']);

    // v1 takes the id or name, not the prefix.
    const projectId = (await ok('/testprojects/SHOP')).item.id;
    const v1 = (await ok(`/testprojects/${projectId}/testcases`, 'v1')).items[0];
    expect(v1).not.toHaveProperty('keywords');
    expect(v1).not.toHaveProperty('customfields');
    // Same ids on every version and every call.
    expect((await ok('/testprojects/SHOP/testcases', 'v2')).items.map((c: any) => c.id)).toEqual(items.map((c: any) => c.id));
  });

  it("runs the query layer on a project's cases: Dave's automated count, groups, pages, fields", async () => {
    const tree = (await ok('/testprojects/SHOP/testsuites')).items;
    const root = tree[0].id;
    // The documented "automated count".
    const automatedDone = await ok(`/testsuites/${root}/testcases${q({ deep: '1', excludeSuiteNames: 'Deprecated', countOnly: '1', executionType: '2', cfFilters: '[{"name":"automationStatus","value":"Done"}]' })}`);
    expect(automatedDone).toEqual({ status: 'ok', message: 'ok', total: 1 });

    const grouped = await ok(`/testprojects/SHOP/testcases${q({ excludeSuiteNames: 'Deprecated', groupBy: 'executionType,cf:automationStatus' })}`);
    expect(grouped.total).toBe(10);
    expect(grouped.groups).toEqual([
      { executionType: 1, automationStatus: 'unset', count: 5 },
      { executionType: 2, automationStatus: 'unset', count: 3 },
      { executionType: 2, automationStatus: 'Done', count: 1 },
      { executionType: 2, automationStatus: 'To Do', count: 1 },
    ]);

    const page = await ok(`/testprojects/SHOP/testcases${q({ limit: '3', offset: '9', fields: 'id,external_id,tsuite_name,customfields', cfCompact: '1' })}`);
    expect(page).toMatchObject({ total: 11, returned: 2, offset: 9, has_more: false });
    expect(page.items[1]).toEqual({ id: expect.any(Number), external_id: 'SHOP-1011', tsuite_name: 'Deprecated', customfields: { automationStatus: 'Done' } });

    expect((await ok(`/testprojects/SHOP/testcases${q({ keyword: 'SMOKE', countOnly: '1' })}`)).total).toBe(1);
    expect((await ok(`/testprojects/SHOP/testcases${q({ active: '1', countOnly: '1' })}`)).total).toBe(10);
    const deprecated = tree[0].children[0].id;
    expect((await ok(`/testprojects/SHOP/testcases${q({ suiteIds: `${deprecated},${root}`, countOnly: '1' })}`)).total).toBe(11);
    expect((await ok(`/testprojects/SHOP/testcases${q({ suiteIds: String(deprecated), nosteps: '1' })}`)).items[0]).not.toHaveProperty('steps');

    // Postman sends every parameter, most of them empty: the answer is unchanged.
    const empty = await ok(`/testprojects/SHOP/testcases${q({ suiteIds: '', executionType: '', groupBy: '', limit: '' })}`);
    expect(Object.keys(empty)).toEqual(['status', 'message', 'items']);

    for (const params of [{ suiteIds: '999999' }, { executionType: '9' }, { cfFilters: '{oops' }, { groupBy: 'colour' }]) {
      const res = await tl(`/testprojects/SHOP/testcases${q(params)}`);
      expect([res.statusCode, body(res).status], JSON.stringify(params)).toEqual([400, 'error']);
    }
  });

  it("lists a suite's cases, deep or not, with cfName filtering", async () => {
    const tree = (await ok('/testprojects/SHOP/testsuites')).items;
    const root = tree[0].id;
    const direct = (await ok(`/testsuites/${root}/testcases`)).items;
    expect(direct).toHaveLength(10);
    expect(direct[0]).toMatchObject({ parent_id: root, tsuite_name: 'Authentication & OAuth2 Engine', external_id: 'SHOP-101' });
    expect(direct[0]).not.toHaveProperty('customfields');
    expect((await ok(`/testsuites/${root}/testcases?deep=1`)).items).toHaveLength(11);
    const done = (await ok(`/testsuites/${root}/testcases${q({ deep: '1', cfName: 'Automation Status', cfValue: 'don', nosteps: '1' })}`)).items;
    expect(done.map((c: any) => c.external_id)).toEqual(['SHOP-102', 'SHOP-1011']);
    expect(Object.values(done[0].customfields)).toContainEqual(expect.objectContaining({ name: 'automationStatus', value: 'Done' }));
    expect(done[0]).not.toHaveProperty('steps');

    const missing = await tl('/testsuites/999999/testcases');
    expect([missing.statusCode, body(missing)]).toEqual([404, { status: 'error', message: "No Test Suite identified by '999999'!", items: null }]);
    // Only on custom.
    expect((await tl(`/testsuites/${root}/testcases`, 'v2')).statusCode).toBe(404);
  });

  it('answers the suite tree, with meta and by name', async () => {
    const projectId = (await ok('/testprojects/SHOP')).item.id;
    const tree = (await ok('/testprojects/SHOP/testsuites')).items;
    expect(tree).toEqual([
      {
        type: 'testsuite',
        id: expect.any(Number),
        name: 'Authentication & OAuth2 Engine',
        parent_id: projectId,
        node_order: 1,
        children: [{ type: 'testsuite', id: expect.any(Number), name: 'Deprecated', parent_id: tree[0].id, node_order: expect.any(Number), children: [] }],
      },
    ]);
    const meta = (await ok(`/testprojects/SHOP/testsuites${q({ excludeSuiteNames: 'deprecated' })}`)).items;
    expect(meta[0]).toMatchObject({ path: 'Authentication & OAuth2 Engine', depth: 0, testcaseCount: { direct: 10, deep: 10 } });
    expect(meta[0].children[0].testcaseCount).toEqual({ direct: 0, deep: 0 });
    const found = (await ok(`/testprojects/SHOP/testsuites${q({ name: 'Deprecated' })}`)).items;
    expect(found).toEqual([
      { type: 'testsuite', id: tree[0].children[0].id, name: 'Deprecated', parent_id: tree[0].id, node_order: expect.any(Number), path: 'Authentication & OAuth2 Engine / Deprecated', depth: 1, testcaseCount: { direct: 1, deep: 1 } },
    ]);
  });

  it('dumps the whole spec, and lists keywords and custom fields without the keyword field', async () => {
    const spec = await ok('/testprojects/SHOP/testspec');
    expect(spec.project).toEqual({ id: expect.any(Number), name: 'E-Commerce Core Platform', prefix: 'SHOP' });
    const top = spec.items[0];
    expect(top).toMatchObject({ type: 'testsuite', name: 'Authentication & OAuth2 Engine' });
    expect(top.testcases).toHaveLength(10);
    expect(top.testcases[0]).toMatchObject({ type: 'testcase', parent_suite_id: top.id, external_id: 'SHOP-101', tc_external_id: '101', steps: expect.any(Array) });
    expect(top.children[0]).toMatchObject({ name: 'Deprecated', testcases: [expect.objectContaining({ name: 'Old flow' })], children: [] });

    expect((await ok('/testprojects/SHOP/keywords')).items).toEqual([
      { id: expect.any(Number), keyword: 'smoke', notes: '' },
      { id: expect.any(Number), keyword: 'nightly', notes: '' },
    ]);
    expect((await ok('/testprojects/SHOP/customfields')).items).toEqual([
      { id: expect.any(Number), name: 'automationStatus', label: 'Automation Status', type: 6, type_name: 'list', possible_values: 'N/A|To Do|Done', default_value: '', required: 0, enabled_on_design: 1 },
    ]);
  });

  it("shows only projects the key's user can see; reading a spec needs SPEC_VIEW", async () => {
    // A tester of no project sees nothing; one who can only execute sees plans, not the spec.
    const user = (await call(admin, 'POST', '/api/v1/admin/users', { username: 'runner', email: 'runner@example.com', password: 'Runner-Key-Test-9', global_role: 'No Access' })).user;
    const runner = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'runner', password: 'Runner-Key-Test-9' } })).token;
    const runnerKey = (await call(runner, 'POST', '/api/v1/auth/me/testlink-key')).plaintext;
    const as = (path: string) => tl(path, 'custom', runnerKey);

    expect(body(await as('/testprojects')).item).toEqual([]);
    expect((await as('/testprojects/SHOP')).statusCode).toBe(404);

    await call(admin, 'POST', '/api/v1/admin/roles', { name: 'Runner only', permission_keys: ['EXECUTE_RUN'] });
    await call(admin, 'PATCH', `/api/v1/admin/users/${user.id}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Runner only' }] });
    expect(body(await as('/testprojects')).item.map((p: any) => p.prefix)).toEqual(['SHOP']);
    expect((await as('/testprojects/SHOP/testplans')).statusCode).toBe(200);
    for (const path of ['/testprojects/SHOP/testcases', '/testprojects/SHOP/testspec', '/testprojects/SHOP/testsuites']) {
      const res = await as(path);
      expect([res.statusCode, body(res)], path).toEqual([403, { status: 'ko', message: 'Insufficient rights' }]);
    }
  });
});
