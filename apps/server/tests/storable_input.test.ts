import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * Values the database can't store -- a NUL character, text over a column's length, a number over
 * an integer column -- answer 400 naming the field (or are cleaned, in CI results and imports),
 * never a 500. The API audit of 2026-10-23 found each of these failing with a 500.
 */
describe("Values the database can't store", () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}`, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const fieldsOf = (res: any) => (body(res).invalid_params ?? []).map((p: any) => p.name);
  const NUL = '\u0000';

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses a NUL character wherever a client typed it, naming the field', async () => {
    const cases: Array<[string, string, unknown, string[]]> = [
      ['POST', `/api/v1/projects/${seed.projectId}/suites`, { name: `Log${NUL}in` }, ['name']],
      ['POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'Plan', description: `x${NUL}` }, ['description']],
      ['PATCH', `/api/v1/projects/${seed.projectId}`, { description: `x${NUL}` }, ['description']],
      ['POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: `CI${NUL}`, capabilities: ['SPEC_VIEW'] }, ['name']],
      ['POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'team', field_label: `Team${NUL}`, field_type: 'TEXT' }, ['field_label']],
      [
        'POST',
        `/api/v1/projects/${seed.projectId}/cases`,
        { test_suite_id: seed.suiteId, title: 'Fine', steps: [{ action: 'ok' }, { action: `bad${NUL}` }] },
        ['steps[1].action'],
      ],
      ['POST', `/api/v1/projects/${seed.projectId}/case-search`, { q: `a${NUL}b` }, ['q']],
      ['GET', `/api/v1/projects/${seed.projectId}/cases?external_id=SHOP%00-1`, undefined, ['external_id']],
      ['GET', '/api/v1/cases/SHOP-101%00', undefined, ['caseId']],
    ];
    for (const [method, url, payload, fields] of cases) {
      const res = await call(method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBe(400);
      expect(body(res).code).toBe('INVALID_REQUEST');
      expect(fieldsOf(res), url).toEqual(fields);
      expect(body(res).invalid_params[0].reason).toMatch(/NUL character/);
    }

    // Signing in, too (it used to be a 500 before the password was even checked).
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: `admin${NUL}`, password: 'password' } });
    expect([login.statusCode, fieldsOf(login)]).toEqual([400, ['username']]);
  });

  it('removes NUL characters from CI results, JUnit files and MCP instead of refusing them', async () => {
    const batch = await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, {
      results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'FAILED', failure_message: `bo${NUL}om`, stack_trace: `at x${NUL}y`, notes: `n${NUL}` }],
    });
    expect(batch.statusCode, batch.payload).toBe(201);

    const xml = `<testsuite name="auth"><testcase name="[SHOP-102] rotates${NUL} tokens"><failure message="m${NUL}">a${NUL}b</failure></testcase></testsuite>`;
    const junit = await call('POST', `/api/v1/runs/${seed.buildId}/results/junit`, xml, { 'content-type': 'application/xml' });
    expect(junit.statusCode, junit.payload).toBe(201);
    expect(body(junit).results[0].test_name).toBe('[SHOP-102] rotates tokens');

    const results = body(await call('GET', `/api/v1/runs/${seed.buildId}/results`)).results;
    const byCase = Object.fromEntries(results.map((r: any) => [r.external_id, r]));
    expect(byCase['SHOP-101']).toMatchObject({ failure_message: 'boom', stack_trace: 'at xy', notes: 'n' });
    expect(byCase['SHOP-102']).toMatchObject({ failure_message: 'm', stack_trace: 'ab' });

    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${admin}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_case', arguments: { project_id: seed.projectId, test_suite_id: seed.suiteId, title: `Drafted${NUL} by an agent` } } },
    });
    const result = JSON.parse(mcp.payload).result;
    expect(result.isError, result.content[0].text).toBeFalsy();
    const drafted = JSON.parse(result.content[0].text).external_id;
    expect(body(await call('GET', `/api/v1/cases/${drafted}`)).test_case.title).toBe('Drafted by an agent');
  });

  it('refuses names longer than the database holds, naming the field', async () => {
    const long = (n: number) => 'x'.repeat(n);
    const cases: Array<[string, string, unknown, string]> = [
      ['POST', '/api/v1/projects', { name: long(256), prefix: 'LONG' }, 'name'],
      ['PATCH', `/api/v1/projects/${seed.projectId}`, { name: long(256) }, 'name'],
      ['POST', `/api/v1/projects/${seed.projectId}/plans`, { name: long(256) }, 'name'],
      ['PATCH', `/api/v1/plans/${seed.planId}`, { name: long(256) }, 'name'],
      ['POST', `/api/v1/plans/${seed.planId}/runs`, { name: long(256) }, 'name'],
      ['POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Fine', release_date: long(31) }, 'release_date'],
      ['PATCH', `/api/v1/runs/${seed.buildId}`, { name: long(256) }, 'name'],
      ['POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'team', field_label: long(256), field_type: 'TEXT' }, 'field_label'],
      ['POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: long(101), field_label: 'Team', field_type: 'TEXT' }, 'name'],
      [
        'POST',
        '/api/v1/admin/custom-fields',
        { entity_type: 'TestCase', name: 'tier', field_label: 'Tier', field_type: 'SINGLE_SELECT', options: [{ option_label: 'Gold', option_value: long(256) }] },
        'options[0].option_value',
      ],
      ['POST', '/api/v1/admin/roles', { name: long(101), permission_keys: ['SPEC_VIEW'] }, 'name'],
      ['POST', '/api/v1/admin/users', { username: long(101), email: 'a@example.com', password: 'Correct-Horse-Battery-9' }, 'username'],
      ['PATCH', '/api/v1/auth/me', { email: `${long(250)}@example.com` }, 'email'],
    ];
    for (const [method, url, payload, field] of cases) {
      const res = await call(method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBe(400);
      expect(fieldsOf(res), url).toEqual([field]);
      expect(body(res).invalid_params[0].reason).toMatch(/at most \d+ characters/);
    }

    // A validation pattern of 256-500 characters passed the old 500-character check, then failed in the database.
    const pattern = await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'code', field_label: 'Code', field_type: 'TEXT', validation_regex: long(300) });
    expect([pattern.statusCode, body(pattern).code]).toEqual([400, 'INVALID_VALIDATION_PATTERN']);
    expect(body(pattern).detail).toMatch(/at most 255 characters/);
  });

  it("checks numbers against integer columns: a batch item's duration, step numbers, suite positions", async () => {
    // Over the limit is that item's problem, not the batch's.
    const batch = await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, {
      results: [
        { case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', duration_ms: 3_000_000_000 },
        { case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED', duration_ms: 1000 },
        { case_identifier: { external_id: 'SHOP-103' }, verdict: 'PASSED', step_results: [{ step_number: 1e12, verdict: 'PASSED' }] },
      ],
    });
    expect(batch.statusCode, batch.payload).toBe(207);
    const items = body(batch).results;
    expect(items.map((r: any) => r.status)).toEqual([400, 201, 400]);
    expect(items[0].invalid_params[0]).toMatchObject({ name: 'results[0].duration_ms', reason: expect.stringMatching(/about 24 days/) });
    expect(items[2].invalid_params[0].name).toBe('results[2].step_results[0].step_number');

    for (const position of [1e12, 1.5, 'abc']) {
      const res = await call('POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Sorted', position });
      expect([res.statusCode, fieldsOf(res)], String(position)).toEqual([400, ['position']]);
      const patch = await call('PATCH', `/api/v1/suites/${seed.suiteId}`, { position });
      expect([patch.statusCode, fieldsOf(patch)], String(position)).toEqual([400, ['position']]);
    }
    expect((await call('POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Sorted', position: 3 })).statusCode).toBe(201);
  });

  it('records a JUnit time it cannot store (likely milliseconds) without a duration, instead of failing the upload', async () => {
    const xml = `<testsuite name="auth">
      <testcase name="[SHOP-101] a" time="3000000"/>
      <testcase name="[SHOP-102] b" time="1e12"/>
      <testcase name="[SHOP-103] c" time="2.5"/>
    </testsuite>`;
    const res = await call('POST', `/api/v1/runs/${seed.buildId}/results/junit`, xml, { 'content-type': 'application/xml' });
    expect(res.statusCode, res.payload).toBe(201);
    const results = body(await call('GET', `/api/v1/runs/${seed.buildId}/results`)).results;
    const duration = Object.fromEntries(results.map((r: any) => [r.external_id, r.duration_ms]));
    expect(duration).toEqual({ 'SHOP-101': null, 'SHOP-102': null, 'SHOP-103': 2500 });
  });

  it('nests suites at most 27 levels deep', async () => {
    let parent: string | null = null;
    for (let depth = 1; depth <= 27; depth++) {
      const res = await call('POST', `/api/v1/projects/${seed.projectId}/suites`, { name: `Level ${depth}`, parent_suite_id: parent });
      expect(res.statusCode, `level ${depth}: ${res.payload}`).toBe(201);
      parent = body(res).suite.id;
    }
    const tooDeep = await call('POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Level 28', parent_suite_id: parent });
    expect(tooDeep.statusCode).toBe(400);
    expect(body(tooDeep).detail).toBe('Suites can be nested at most 27 levels deep.');

    // Moving the seed's suite (which has no children) under the deepest is just as deep.
    const move = await call('PATCH', `/api/v1/suites/${seed.suiteId}`, { parent_suite_id: parent });
    expect([move.statusCode, body(move).detail]).toEqual([400, 'Suites can be nested at most 27 levels deep.']);
  });

  it('stores NUMBER custom field values exactly, large ones included', async () => {
    const created = await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'ticket', field_label: 'Ticket', field_type: 'NUMBER' });
    expect(created.statusCode, created.payload).toBe(201);
    const fieldId = body(created).definition.id;
    const caseId = seed.caseIds[0];
    for (const value of [123456789.25, 1e39]) {
      const set = await call('PUT', `/api/v1/cases/${caseId}/custom-fields/${fieldId}`, { value });
      expect(set.statusCode, set.payload).toBe(200);
      const values = body(await call('GET', `/api/v1/cases/${caseId}/custom-fields`)).values;
      expect(values.find((v: any) => v.definition.id === fieldId).value).toBe(value);
    }
  });

  it('imports: NULs removed, long suite names cut, an over-long case id dropped with a warning, a tree too deep refused', async () => {
    const file = JSON.stringify({
      suites: [
        {
          name: 'S'.repeat(300),
          test_cases: [{ external_id: 'X'.repeat(150), title: `Ti${NUL}tle`, steps: [{ action: `a${NUL}b`, expected_result: 'ok' }] }],
        },
      ],
    });
    const url = (step: string) => `/api/v1/projects/${seed.projectId}/imports/${step}`;
    const dry = await call('POST', url('dry-run'), { file_content: file, format: 'NATIVE_JSON' });
    expect(dry.statusCode, dry.payload).toBe(200);
    expect(body(dry).warnings.map((w: any) => w.code)).toContain('CASE_ID_TOO_LONG');

    const done = await call('POST', url('execute'), { file_content: file, format: 'NATIVE_JSON' });
    expect(done.statusCode, done.payload).toBe(200);
    const cases = body(await call('GET', `/api/v1/projects/${seed.projectId}/cases`)).cases.filter((c: any) => c.title === 'Title');
    expect(cases).toHaveLength(1);
    expect(cases[0].external_id).toMatch(/^SHOP-\d+$/);
    const suite = body(await call('GET', `/api/v1/suites/${cases[0].test_suite_id}`)).suite;
    expect(suite.name).toBe('S'.repeat(255));
    const steps = body(await call('GET', `/api/v1/cases/${cases[0].id}`)).latest_version.steps;
    expect(steps[0].action).toBe('ab');

    // 28 suites, each inside the one before.
    let deep: any = { name: 'Level 28', test_cases: [{ title: 'Deepest' }] };
    for (let depth = 27; depth >= 1; depth--) deep = { name: `Level ${depth}`, sub_suites: [deep] };
    const tooDeep = await call('POST', url('execute'), { file_content: JSON.stringify({ suites: [deep] }), format: 'NATIVE_JSON' });
    expect([tooDeep.statusCode, body(tooDeep).detail]).toEqual([400, 'Suites can be nested at most 27 levels deep.']);
  });

  it("answers 400, not 500, when the database refuses a value a route didn't check", async () => {
    // An import creating a field from a column name longer than a field name can be (100).
    const column = 'c'.repeat(120);
    const file = JSON.stringify({ suites: [{ name: 'Imported', test_cases: [{ title: 'One', custom_fields: { [column]: 'v' } }] }] });
    const res = await call('POST', `/api/v1/projects/${seed.projectId}/imports/execute`, {
      file_content: file,
      format: 'NATIVE_JSON',
      configuration: { field_mappings: [{ incoming_key: column, action: 'AUTO_CREATE', field_type: 'TEXT' }] },
    });
    expect(res.statusCode, res.payload).toBe(400);
    expect(body(res)).toMatchObject({ code: 'INVALID_REQUEST', detail: 'A value in the request is too long to store.' });
    expect(res.payload).not.toContain('character varying');
  });
});
