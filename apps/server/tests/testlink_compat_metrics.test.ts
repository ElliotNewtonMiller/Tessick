import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testLinkFixture, q } from './testlinkFixture.js';

/**
 * The TestLink-compatible API, phase 4: Dave's /testcasemetrics and SWAG file. On the fixture's
 * data (testlinkFixture.ts): SHOP-101..SHOP-1010 in the root suite, even ones automated, with
 * automationStatus Done on SHOP-102 and To Do on SHOP-104; SHOP-1011 (automated, Done,
 * deprecated) in a suite named Deprecated under it.
 */
describe('TestLink-compatible API: metrics and the SWAG file', () => {
  let fx: Awaited<ReturnType<typeof testLinkFixture>>;
  let projectKey: string;

  beforeEach(async () => {
    fx = await testLinkFixture();
    projectKey = (await fx.ok('/testprojects/SHOP')).item.api_key;
  });
  afterEach(async () => {
    await fx.app.close();
  });

  const metrics = async (params: Record<string, string>) => (await fx.ok(`/testcasemetrics${q(params)}`)).metrics;
  const caseId = async (external: string) => (await fx.ok('/testprojects/SHOP/testcases')).items.find((c: any) => c.external_id === external).id;

  it("counts by automationStatus, leaving out the Deprecated suite unless told otherwise", async () => {
    const m = await metrics({ projectApiKey: projectKey });
    expect(m).toEqual({
      projectName: 'E-Commerce Core Platform',
      total: 10,
      automation_status: { 'N/A': 0, 'To Do': 1, 'In Progress': 0, Done: 1, No: 0 },
      testcases_without_automation_status: expect.any(Array),
    });
    expect(m.testcases_without_automation_status).toHaveLength(8);
    expect(m.testcases_without_automation_status).not.toContain(await caseId('SHOP-102'));
    expect(m.testcases_without_automation_status).toEqual([...m.testcases_without_automation_status].sort((a: number, b: number) => a - b));

    // An empty excludeSuiteNames excludes nothing; active=1 then leaves out the deprecated case.
    expect((await metrics({ projectApiKey: projectKey, excludeSuiteNames: '' })).automation_status.Done).toBe(2);
    expect((await metrics({ projectApiKey: projectKey, excludeSuiteNames: '', active: '1' })).total).toBe(10);
    // The query layer's filters apply.
    expect((await metrics({ projectApiKey: projectKey, executionType: '2' })).total).toBe(5);
    expect((await metrics({ projectApiKey: projectKey, cfFilters: '[{"name":"automationStatus","match":"exists"}]' })).total).toBe(2);
    expect((await metrics({ projectApiKey: projectKey, keyword: 'smoke' })).total).toBe(1);
  });

  it('adds counts by execution type, and the automated count (automated and Done)', async () => {
    const m = await metrics({ projectApiKey: projectKey, includeExecutionType: '1' });
    expect([m.byExecutionType, m.automated]).toEqual([{ '1': 5, '2': 5 }, 1]);
    expect(await metrics({ projectApiKey: projectKey, includeExecutionType: '0' })).not.toHaveProperty('automated');
  });

  it('finds the project from suiteIds (a requested suite is never excluded), and refuses what it must', async () => {
    const tree = (await fx.ok('/testprojects/SHOP/testsuites')).items;
    const deprecated = tree[0].children[0].id;
    expect(await metrics({ suiteIds: String(deprecated) })).toMatchObject({ total: 1, automation_status: { Done: 1 } });
    // Requested itself, Deprecated is a root too; alone, the top suite leaves it out.
    expect((await metrics({ projectApiKey: projectKey, suiteIds: `${tree[0].id},${deprecated}` })).total).toBe(11);
    expect((await metrics({ projectApiKey: projectKey, suiteIds: String(tree[0].id) })).total).toBe(10);

    const none = await fx.tl('/testcasemetrics');
    expect([none.statusCode, fx.body(none)]).toEqual([400, { status: 'error', message: 'Missing required parameter: projectApiKey' }]);
    const unknown = await fx.tl('/testcasemetrics?projectApiKey=nope');
    expect([unknown.statusCode, fx.body(unknown)]).toEqual([404, { status: 'error', message: 'No Test Project found with API key: nope' }]);
    const badFilter = await fx.tl(`/testcasemetrics${q({ projectApiKey: projectKey, executionType: '7' })}`);
    expect([badFilter.statusCode, fx.body(badFilter).status]).toEqual([400, 'error']);
    // Only on custom; a user who can't see the project gets the same 404 as an unknown key.
    expect((await fx.tl(`/testcasemetrics${q({ projectApiKey: projectKey })}`, 'v2')).statusCode).toBe(404);
    const outsider = await fx.userWithKey('outsider', 'No Access');
    const hidden = await fx.tl(`/testcasemetrics${q({ projectApiKey: projectKey })}`, 'custom', outsider);
    expect([hidden.statusCode, fx.body(hidden).message]).toEqual([404, `No Test Project found with API key: ${projectKey}`]);
  });

  it('keeps the SWAG file: read with a key, replaced by a manager, merged into its project\'s metrics', async () => {
    const missing = await fx.tl('/swagfile');
    expect([missing.statusCode, fx.body(missing)]).toEqual([404, { status: 'error', message: 'File not found' }]);

    const swag = { MobileApp: { productKey: 'not-ours', api: 10 }, Shop: { productKey: projectKey, api: 80, console: 60, userFacing: 95 } };
    const saved = await fx.post('/swagfile', swag);
    expect(saved).toEqual({ status: 200, body: { status: 'ok', message: 'File saved successfully', bytes_written: Buffer.byteLength(JSON.stringify(swag, null, 4)) } });
    const read = await fx.tl('/swagfile');
    expect([read.statusCode, JSON.parse(read.payload)]).toEqual([200, swag]);
    expect((await metrics({ projectApiKey: projectKey })).testCoverageSWAGS).toEqual({ api: 80, console: 60, userFacing: 95 });

    for (const bad of [[1, 2], 'text']) {
      const res = await fx.post('/swagfile', bad);
      expect([res.status, res.body], JSON.stringify(bad)).toEqual([400, { status: 'error', message: 'Invalid JSON content' }]);
    }
    // A tester can read it but not replace it; without a key, neither.
    const tester = await fx.userWithKey('tess', 'Tester');
    expect((await fx.tl('/swagfile', 'custom', tester)).statusCode).toBe(200);
    expect((await fx.post('/swagfile', { x: 1 }, 'custom', tester)).body).toMatchObject({ status: 'ko', message: 'Insufficient rights' });
    const anonymous = await fx.app.inject({ method: 'GET', url: '/lib/api/rest/custom/swagfile' });
    expect([anonymous.statusCode, fx.body(anonymous).message]).toEqual([400, 'authentication error']);

    const audit = await fx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'TESTLINK_SWAG_SAVED').execute();
    expect(audit).toHaveLength(1);
  });
});
