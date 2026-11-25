import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CompatPlatformRepository } from '@tessick/db';
import { createServer } from '../src/server.js';

/**
 * Importing TestLink's export of a test plan's linked test cases (imports/testlink-plan/...): its
 * cases are found by their TestLink number and added to a plan in TestLink's order, through the
 * ordinary routes; drafts only when the caller approves them.
 */

// The project's test cases, as TestLink exports them: approved (7), draft (1) and obsolete (5).
const spec = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="" name="">
  <testsuite id="10" name="Checkout">
    <testcase internalid="101" name="Logs in"><externalid><![CDATA[3]]></externalid><status>7</status></testcase>
    <testcase internalid="102" name="Pays by card"><externalid><![CDATA[7]]></externalid><status>1</status></testcase>
    <testcase internalid="103" name="Pays by cheque"><externalid><![CDATA[8]]></externalid><status>5</status></testcase>
    <testcase internalid="104" name="Refunds an order"><externalid><![CDATA[9]]></externalid><status>7</status></testcase>
  </testsuite>
</testsuite>`;

const link = (id: string, name: string, order: number, platform = '') => `
	<link>
		<platform><name><![CDATA[${platform}]]></name></platform>
		<testcase>
			<name><![CDATA[${name}]]></name>
			<externalid><![CDATA[${id}]]></externalid>
			<version><![CDATA[1]]></version>
			<execution_order><![CDATA[${order}]]></execution_order>
		</testcase>
</link>`;

// Out of order in the file; one case on two platforms; one renamed since; one not in the project.
const plan = `<?xml version="1.0" encoding="UTF-8"?>
	<testplan>
		<name><![CDATA[Regression]]></name>
<executables>${link('9', 'Refund an order', 30)}${link('7', 'Pays by card', 20, 'Chrome')}${link('7', 'Pays by card', 20, 'Firefox')}${link('3', 'Logs in', 10)}${link('8', 'Pays by cheque', 40)}${link('12', 'Ships abroad', 50)}
</executables>
	</testplan>`;

describe('Importing a TestLink test plan', () => {
  let app: any;
  let db: any;
  let token: string;
  let projectId: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown, as = token) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${as}` }, ...(payload !== undefined ? { payload } : {}) });
  const preview = (configuration: object = {}, as = token) =>
    call('POST', `/api/v1/projects/${projectId}/imports/testlink-plan/dry-run`, { file_content: plan, configuration }, as);
  const execute = (configuration: object = {}, as = token) =>
    call('POST', `/api/v1/projects/${projectId}/imports/testlink-plan/execute`, { file_content: plan, configuration }, as);
  const planCases = async (planId: string) => body(await call('GET', `/api/v1/plans/${planId}/cases`)).cases.map((c: any) => c.external_id);

  /** Signs in a new user whose only role grants these permissions. */
  async function userWith(permissions: string[]): Promise<string> {
    const name = `role_${permissions.length}_${Date.now()}`;
    expect((await call('POST', '/api/v1/admin/roles', { name, permission_keys: permissions })).statusCode).toBe(201);
    const username = `user_${name}`;
    const made = await call('POST', '/api/v1/admin/users', { username, email: `${username}@tessick.local`, password: 'SecurePass123!', global_role: name });
    expect(made.statusCode, made.payload).toBe(201);
    return body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } })).token;
  }

  beforeEach(async () => {
    ({ app, db } = await createServer());
    token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    projectId = body(await call('POST', '/api/v1/projects', { name: 'Shop', prefix: 'TL' })).project.id;
    const imported = await call('POST', `/api/v1/projects/${projectId}/imports/execute`, { file_content: spec, format: 'TESTLINK_XML' });
    expect(imported.statusCode, imported.payload).toBe(200);
  });
  afterEach(async () => {
    await app.close();
  });

  it('previews each case: ready, draft, deprecated, missing, renamed, in TestLink order', async () => {
    const res = await preview();
    expect(res.statusCode, res.payload).toBe(200);
    const p = body(res);
    expect(p.plan_name).toBe('Regression');
    expect(p.matching_plans).toEqual([]);
    expect(p.platforms).toEqual(['Chrome', 'Firefox']);
    expect(p.summary).toEqual({ links: 6, total: 5, ready: 2, draft: 1, deprecated: 1, not_found: 1, already_in_plan: 0, title_differs: 1 });
    expect(p.items.map((i: any) => [i.external_id, i.state, i.title_differs])).toEqual([
      ['TL-3', 'READY', false],
      ['TL-7', 'DRAFT', false],
      ['TL-9', 'READY', true],
      ['TL-8', 'DEPRECATED', false],
      ['TL-12', 'NOT_FOUND', false],
    ]);
    expect(p.items[2]).toMatchObject({ testlink_external_id: '9', file_name: 'Refund an order', title: 'Refunds an order', testlink_version: 1 });
    expect(p.warnings.map((w: any) => w.code)).toEqual(['CASES_NOT_FOUND', 'TITLES_DIFFER', 'DRAFT_CASES', 'DEPRECATED_CASES', 'PLATFORMS']);
    // Nothing was written.
    expect(body(await call('GET', `/api/v1/projects/${projectId}/plans`)).plans).toEqual([]);
  });

  it('creates the plan with its approved cases in order, then adds the drafts it approves on a second import', async () => {
    const first = await execute();
    expect(first.statusCode, first.payload).toBe(200);
    const done = body(first);
    expect(done.plan).toMatchObject({ name: 'Regression', status: 'ACTIVE' });
    expect(done.plan_created).toBe(true);
    expect(done.summary).toEqual({ total: 5, added: 2, approved: 0, already_in_plan: 0, skipped: 3, failed: 0 });
    expect(done.items.map((i: any) => [i.external_id, i.outcome])).toEqual([
      ['TL-3', 'ADDED'],
      ['TL-7', 'SKIPPED'],
      ['TL-9', 'ADDED'],
      ['TL-8', 'SKIPPED'],
      ['TL-12', 'SKIPPED'],
    ]);
    expect(await planCases(done.plan.id)).toEqual(['TL-3', 'TL-9']);
    // Tessick has no platforms: they're linked to the plan for the TestLink-compatible API.
    expect((await new CompatPlatformRepository(db).platformsOfPlan(done.plan.id)).map((p) => p.name)).toEqual(['Chrome', 'Firefox']);

    // The preview now offers the plan of that name, and sees what's in it.
    const again = body(await preview({ test_plan_id: done.plan.id }));
    expect(again.matching_plans).toEqual([{ id: done.plan.id, name: 'Regression', status: 'ACTIVE' }]);
    expect(again.summary).toMatchObject({ ready: 0, draft: 1, already_in_plan: 2 });

    const second = body(await execute({ test_plan_id: done.plan.id, approve_drafts: true }));
    expect(second.plan_created).toBe(false);
    expect(second.summary).toEqual({ total: 5, added: 1, approved: 1, already_in_plan: 2, skipped: 2, failed: 0 });
    expect(second.items.find((i: any) => i.external_id === 'TL-7')).toMatchObject({ outcome: 'ADDED', approved: true });
    expect(await planCases(done.plan.id)).toEqual(['TL-3', 'TL-9', 'TL-7']);
    expect(body(await call('GET', '/api/v1/cases/TL-7')).latest_version.status).toBe('APPROVED');

    const audit = await db.selectFrom('audit_logs').select(['resource_id', 'diff']).where('action', '=', 'IMPORT_EXECUTED').where('resource_type', '=', 'plan').execute();
    expect(audit.map((a: any) => [a.resource_id, JSON.parse(a.diff).added])).toEqual([
      [done.plan.id, 2],
      [done.plan.id, 1],
    ]);
  });

  it('takes a name for the new plan, and refuses a locked plan or both a name and a plan', async () => {
    expect(body(await execute({ plan_name: 'Release 2.0 regression' })).plan.name).toBe('Release 2.0 regression');

    const locked = body(await call('POST', `/api/v1/projects/${projectId}/plans`, { name: 'Old', status: 'LOCKED' })).plan;
    const refused = await execute({ test_plan_id: locked.id });
    expect([refused.statusCode, body(refused).code]).toEqual([422, 'PLAN_LOCKED']);

    const both = await execute({ plan_name: 'X', test_plan_id: locked.id });
    expect(both.statusCode).toBe(400);
    expect(body(both).invalid_params).toEqual([{ name: 'configuration.test_plan_id', reason: expect.stringContaining('not both') }]);

    const missing = await execute({ test_plan_id: 'no-such-plan' });
    expect(missing.statusCode).toBe(404);
  });

  it('needs IMPORT_DATA and PLAN_MANAGE, and SPEC_APPROVE to approve drafts', async () => {
    const importer = await userWith(['SPEC_VIEW', 'IMPORT_DATA']);
    const noPlans = await preview({}, importer);
    expect([noPlans.statusCode, body(noPlans).required_permission]).toEqual([403, 'PLAN_MANAGE']);

    const planner = await userWith(['SPEC_VIEW', 'IMPORT_DATA', 'PLAN_MANAGE']);
    expect((await preview({}, planner)).statusCode).toBe(200);
    const approving = await execute({ approve_drafts: true }, planner);
    expect([approving.statusCode, body(approving).required_permission]).toEqual([403, 'SPEC_APPROVE']);
    expect(body(await execute({}, planner)).summary.added).toBe(2);
  });

  it('refuses a test case export, and the test case import refuses a plan export without changing any case', async () => {
    const wrongWay = await call('POST', `/api/v1/projects/${projectId}/imports/testlink-plan/dry-run`, { file_content: spec });
    expect(wrongWay.statusCode).toBe(400);
    expect(body(wrongWay).detail).toContain('starts with <testsuite>, not <testplan>');

    for (const step of ['dry-run', 'execute']) {
      const res = await call('POST', `/api/v1/projects/${projectId}/imports/${step}`, { file_content: plan });
      expect([res.statusCode, body(res).code], step).toEqual([400, 'TESTLINK_PLAN_FILE']);
    }
    // Before, the plan's case numbers were read as cases, and each got a new, empty version.
    expect(body(await call('GET', '/api/v1/cases/TL-3')).latest_version.version_number).toBe(1);
  });

  it('takes the file as a multipart upload, as the web app sends it', async () => {
    const form = new FormData();
    form.append('configuration', JSON.stringify({ plan_name: 'From the wizard' }));
    form.append('file', new Blob([plan]), 'linkedItems_Regression.xml');
    const req = new Request('http://local/', { method: 'POST', body: form });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/imports/testlink-plan/execute`,
      headers: { authorization: `Bearer ${token}`, 'content-type': req.headers.get('content-type')! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(body(res).plan.name).toBe('From the wizard');

    const bad = new FormData();
    bad.append('configuration', '{not json');
    bad.append('file', new Blob([plan]), 'plan.xml');
    const badReq = new Request('http://local/', { method: 'POST', body: bad });
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/imports/testlink-plan/dry-run`,
      headers: { authorization: `Bearer ${token}`, 'content-type': badReq.headers.get('content-type')! },
      payload: Buffer.from(await badReq.arrayBuffer()),
    });
    expect([refused.statusCode, body(refused).invalid_params]).toEqual([400, [{ name: 'configuration', reason: "isn't readable JSON" }]]);
  });
});
