import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * A field the API doesn't take is refused with 400 naming it, instead of being ignored (API audit
 * of 2026-10-23: `PATCH {"tittle": ...}` answered 200 with nothing changed, and a report filter
 * under the wrong key gave an unfiltered report).
 */
describe('Unknown fields are refused', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });
  const unknown = (res: any) => [res.statusCode, body(res).code, (body(res).invalid_params ?? []).map((p: any) => [p.name, p.reason])];
  const NOT_KNOWN = "isn't a known field";

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('in bodies the routes check themselves and in fully described ones, at any depth, changing nothing', async () => {
    const caseId = seed.caseIds[0];
    const before = body(await call('GET', `/api/v1/cases/${caseId}`)).test_case.title;
    expect(unknown(await call('PATCH', `/api/v1/cases/${caseId}`, { tittle: 'Typo' }))).toEqual([400, 'INVALID_REQUEST', [['tittle', NOT_KNOWN]]]);
    expect(body(await call('PATCH', `/api/v1/cases/${caseId}`, { title: before })).test_case.title).toBe(before);

    expect(unknown(await call('PATCH', `/api/v1/plans/${seed.planId}`, { nmae: 'x', status: 'ACTIVE' }))).toEqual([400, 'INVALID_REQUEST', [['nmae', NOT_KNOWN]]]);
    expect(
      unknown(await call('POST', `/api/v1/projects/${seed.projectId}/cases`, { test_suite_id: seed.suiteId, title: 'New', steps: [{ action: 'a', expectd: 'b' }] }))
    ).toEqual([400, 'INVALID_REQUEST', [['steps[0].expectd', NOT_KNOWN]]]);
    // Two at once, both named.
    expect(unknown(await call('POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'P', colour: 'red', owner: 'me' }))[2]).toEqual([
      ['colour', NOT_KNOWN],
      ['owner', NOT_KNOWN],
    ]);
    // Inside a shared schema ($ref).
    const me = body(await call('GET', '/api/v1/auth/me')).user;
    expect(
      unknown(await call('PUT', `/api/v1/admin/users/${me.id}/permission-overrides`, { project_id: null, overrides: [{ permission_key: 'SPEC_VIEW', granted: true }] }))
    ).toEqual([400, 'INVALID_REQUEST', [['overrides[0].is_granted', 'is required'], ['overrides[0].granted', NOT_KNOWN]]]);
    // A select field's options sent back as the server lists them (with id and position) are
    // refused: the Admin Panel sends only label and value, in order.
    const field = body(await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'tier', field_label: 'Tier', field_type: 'SINGLE_SELECT', options: [{ option_label: 'Gold', option_value: 'gold' }] })).definition;
    expect(unknown(await call('PATCH', `/api/v1/admin/custom-fields/${field.id}`, { field_label: 'Tier', options: field.options }))).toEqual([
      400,
      'INVALID_REQUEST',
      [['options[0].id', NOT_KNOWN], ['options[0].position', NOT_KNOWN]],
    ]);
    const options = field.options.map(({ option_label, option_value }: any) => ({ option_label, option_value }));
    expect((await call('PATCH', `/api/v1/admin/custom-fields/${field.id}`, { field_label: 'Customer tier', options })).statusCode).toBe(200);
    // A CI batch with a misspelt field is refused whole: every item comes from the same script.
    const batch = await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', duraton_ms: 5 }] });
    expect(unknown(batch)).toEqual([400, 'INVALID_REQUEST', [['results[0].duraton_ms', NOT_KNOWN]]]);
    expect(body(await call('GET', `/api/v1/runs/${seed.buildId}/results`)).results).toEqual([]);
  });

  it('keeps open what is open: custom field values, environment tags, report parameters', async () => {
    const tags = await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, {
      results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', environment_tags: { browser: 'firefox', anything: 'goes' } }],
    });
    expect(tags.statusCode, tags.payload).toBe(201);
    const bulk = await call('POST', `/api/v1/projects/${seed.projectId}/cases/bulk`, { action: 'update', case_ids: ['SHOP-101'], changes: { custom_fields: { no_such_field: 'x' } } });
    // The field name is checked by the route, which knows the fields (UNKNOWN_FIELD), not by the schema.
    expect(body(bulk).code ?? body(bulk).results?.[0]?.code).toBe('UNKNOWN_FIELD');
  });

  it('report filters: a misspelt key is refused instead of giving an unfiltered report, and errors name the field', async () => {
    const report = (filter: unknown) => call('POST', `/api/v1/projects/${seed.projectId}/reports/run_summary`, { test_run_id: seed.buildId, filter });
    expect(unknown(await report({ filter: [{ field: 'priority', op: 'any_of', value: ['HIGH'] }] }))).toEqual([
      400,
      'INVALID_FILTER',
      [['filter.filter', "isn't a known field (a filter has q and filters)"]],
    ]);
    const typo = await report({ filters: [{ field: 'priority', op: 'any_of', values: ['HIGH'] }] });
    expect(unknown(typo)).toEqual([400, 'INVALID_FILTER', [['filter.filters[0].values', "isn't a known field (a filter has field, op and value)"]]]);
    // The detail says what's wrong (it said only "INVALID_FILTER").
    expect(body(typo).detail).toBe("filter.filters[0].values isn't a known field (a filter has field, op and value)");
    const badOp = await report({ filters: [{ field: 'priority', op: 'between', value: [1, 2] }] });
    expect(body(badOp).invalid_params[0].name).toBe('filter.filters[0].op');

    const fine = await report({ filters: [{ field: 'priority', op: 'any_of', value: ['HIGH'] }] });
    expect(fine.statusCode, fine.payload).toBe(200);
    expect(body(fine).filter_applied).toBe(true);
  });

  it('MCP: a tool argument the tool does not take is refused, naming what it takes', async () => {
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${admin}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      return JSON.parse(res.payload).result;
    };
    const refused = await tool('search_cases', { project_id: seed.projectId, filter: [{ field: 'priority', op: 'any_of', value: ['HIGH'] }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^search_cases doesn't take 'filter'\. Its arguments: .*filters/);
    // Inside a filter, the filter's own check names it.
    const inner = await tool('search_cases', { project_id: seed.projectId, filters: [{ field: 'priority', op: 'any_of', values: ['HIGH'] }] });
    expect(inner.content[0].text).toMatch(/filters\[0\]\.values isn't a known field/);
    expect((await tool('search_cases', { project_id: seed.projectId, q: 'OAuth' })).isError).toBeFalsy();
  });
});
