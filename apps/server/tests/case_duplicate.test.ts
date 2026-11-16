import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * Duplicating a test case (POST /cases/:caseId/duplicate): a new case whose version 1 is a DRAFT copy
 * of the latest version, with the case's fields and custom-field values, and any changes in the body.
 * It numbers the copy through the same locked path as creating a case (external_ids.test.ts).
 */
describe('Duplicating a test case', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const ok = async (token: string, method: string, url: string, payload?: unknown) => {
    const res = await call(token, method, url, payload);
    expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBeLessThan(300);
    return body(res);
  };
  const token = async (capabilities: string[]) => (await ok(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'dup', capabilities })).plaintext;

  /** An approved case with steps and a custom-field value, to copy. */
  async function sourceCase() {
    const field = (await ok(admin, 'POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'component', field_label: 'Component', field_type: 'TEXT' })).definition;
    const created = await ok(admin, 'POST', `/api/v1/projects/${seed.projectId}/cases`, {
      test_suite_id: seed.suiteId,
      title: 'Pays with a saved card',
      priority: 'HIGH',
      execution_type: 'AUTOMATED',
      summary: 'Checkout with a stored card',
      preconditions: 'A saved Visa',
      steps: [
        { action: 'Open checkout', expected_result: 'Card shown' },
        { action: 'Pay', expected_result: 'Paid', execution_type: 'AUTOMATED' },
      ],
    });
    await ok(admin, 'PUT', `/api/v1/cases/${created.test_case.id}/custom-fields/${field.id}`, { value: 'payments' });
    return { ...created, field };
  }

  beforeEach(async () => {
    ({ app, db, seed } = await createServer(undefined, { webhooks: { allowLocal: true, deliverImmediately: false, timeoutMs: 500 } }));
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('copies the fields, the latest content and custom fields into a new DRAFT case, even with SPEC_AUTO_APPROVE', async () => {
    const src = await sourceCase();
    expect(src.version.status).toBe('APPROVED');
    await ok(admin, 'POST', `/api/v1/projects/${seed.projectId}/webhooks`, { name: 'Cases', url: 'https://example.com/hook', format: 'json', events: ['test_case.created'] });

    const res = await call(admin, 'POST', `/api/v1/cases/${src.test_case.external_id}/duplicate`);
    expect(res.statusCode, res.payload).toBe(201);
    const copy = body(res);
    expect(copy.test_case).toMatchObject({ title: 'Pays with a saved card (copy)', test_suite_id: seed.suiteId, priority: 'HIGH', execution_type: 'AUTOMATED' });
    expect(copy.test_case.id).not.toBe(src.test_case.id);
    const n = (id: string) => Number(id.split('-')[1]);
    expect(n(copy.test_case.external_id)).toBe(n(src.test_case.external_id) + 1);
    expect(copy.version).toMatchObject({ version_number: 1, status: 'DRAFT', summary: 'Checkout with a stored card', preconditions: 'A saved Visa' });
    expect(copy.version.steps.map((s: any) => [s.step_number, s.action, s.expected_result, s.execution_type])).toEqual([
      [1, 'Open checkout', 'Card shown', 'MANUAL'],
      [2, 'Pay', 'Paid', 'AUTOMATED'],
    ]);
    expect(copy.duplicated_from).toEqual({ test_case_id: src.test_case.id, external_id: src.test_case.external_id, version_number: 1 });
    const values = (await ok(admin, 'GET', `/api/v1/cases/${copy.test_case.id}/custom-fields`)).values;
    expect(values.find((v: any) => v.definition.name === 'component').value).toBe('payments');

    // The source is unchanged.
    expect((await ok(admin, 'GET', `/api/v1/cases/${src.test_case.id}/versions`)).versions.map((v: any) => v.status)).toEqual(['APPROVED']);
    // Audited as a created case, from its source, with the usual webhook.
    const audit = (await ok(admin, 'GET', '/api/v1/admin/audit-logs?action=CASE_CREATED')).audit_logs.find((r: any) => r.resource_id === copy.test_case.id);
    expect(JSON.parse(audit.diff)).toMatchObject({ external_id: copy.test_case.external_id, duplicated_from: { test_case_id: src.test_case.id, external_id: src.test_case.external_id } });
    const deliveries = await db.selectFrom('webhook_deliveries').select(['event', 'payload']).execute();
    expect(deliveries.map((d: any) => d.event)).toEqual(['test_case.created']);
    expect(deliveries[0].payload).toContain(copy.test_case.external_id);
  });

  it('applies changes sent with it: title, suite, priority, content and steps', async () => {
    const src = await sourceCase();
    const other = (await ok(admin, 'POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Refunds' })).suite;
    const copy = await ok(admin, 'POST', `/api/v1/cases/${src.test_case.id}/duplicate`, {
      title: '  Refunds a saved card  ',
      test_suite_id: other.id,
      priority: 'LOW',
      summary: null,
      steps: [{ action: 'Refund', expected_result: 'Refunded' }],
    });
    expect(copy.test_case).toMatchObject({ title: 'Refunds a saved card', test_suite_id: other.id, priority: 'LOW', execution_type: 'AUTOMATED' });
    expect(copy.version).toMatchObject({ summary: null, preconditions: 'A saved Visa' });
    expect(copy.version.steps.map((s: any) => s.action)).toEqual(['Refund']);
  });

  it("copies the latest version, even a draft or deprecated one, and fits a long title", async () => {
    const src = await sourceCase();
    const draft = (await ok(admin, 'POST', `/api/v1/cases/${src.test_case.id}/versions`)).version;
    await ok(admin, 'PATCH', `/api/v1/versions/${draft.id}`, { summary: 'Being rewritten', steps: [{ action: 'New step' }] });
    const fromDraft = await ok(admin, 'POST', `/api/v1/cases/${src.test_case.id}/duplicate`);
    expect(fromDraft.duplicated_from.version_number).toBe(2);
    expect([fromDraft.version.version_number, fromDraft.version.summary, fromDraft.version.steps.map((s: any) => s.action)]).toEqual([1, 'Being rewritten', ['New step']]);

    await ok(admin, 'POST', `/api/v1/versions/${draft.id}/approve`);
    await ok(admin, 'POST', `/api/v1/versions/${draft.id}/deprecate`);
    expect((await call(admin, 'POST', `/api/v1/cases/${src.test_case.id}/duplicate`)).statusCode).toBe(201);

    const long = await ok(admin, 'PATCH', `/api/v1/cases/${src.test_case.id}`, { title: 'x'.repeat(255) });
    const copy = await ok(admin, 'POST', `/api/v1/cases/${long.test_case.id}/duplicate`);
    expect([copy.test_case.title.length, copy.test_case.title.endsWith(' (copy)')]).toEqual([255, true]);
  });

  it('refuses bad changes, cases and suites it can not see, and callers without SPEC_CREATE or SPEC_VIEW', async () => {
    const src = await sourceCase();
    const url = `/api/v1/cases/${src.test_case.id}/duplicate`;
    expect([(await call(admin, 'POST', url, { title: ' ' })).statusCode, body(await call(admin, 'POST', url, { title: ' ' })).code]).toEqual([400, 'INVALID_NAME']);
    expect(body(await call(admin, 'POST', url, { steps: [{ action: 5 }] })).code).toBe('INVALID_STEPS');
    expect((await call(admin, 'POST', url, { priority: 'URGENT' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', url, { owner: 'me' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/api/v1/cases/SHOP-9999/duplicate')).statusCode).toBe(404);

    const project = (await ok(admin, 'POST', '/api/v1/projects', { name: 'Elsewhere', prefix: 'ELS' })).project;
    const foreignSuite = (await ok(admin, 'POST', `/api/v1/projects/${project.id}/suites`, { name: 'Theirs' })).suite;
    expect((await call(admin, 'POST', url, { test_suite_id: foreignSuite.id })).statusCode).toBe(400);

    const viewer = await ok(admin, 'POST', '/api/v1/admin/users', { username: 'vic', email: 'vic@example.com', password: 'Duplicate-Test-9!', global_role: 'Viewer' });
    expect(viewer.user?.id ?? viewer.id).toBeTruthy();
    const vic = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'vic', password: 'Duplicate-Test-9!' } })).token;
    expect((await call(vic, 'POST', url)).statusCode).toBe(403);

    const blind = await call(await token(['SPEC_CREATE']), 'POST', url);
    expect([blind.statusCode, body(blind).required_permission]).toEqual([403, 'SPEC_VIEW']);
    expect((await call(await token(['SPEC_VIEW', 'SPEC_CREATE']), 'POST', url)).statusCode).toBe(201);

    const otherToken = (await ok(admin, 'POST', `/api/v1/projects/${project.id}/api-tokens`, { name: 'els', capabilities: ['SPEC_VIEW', 'SPEC_CREATE'] })).plaintext;
    expect((await call(otherToken, 'POST', url)).statusCode).toBe(404);
  });

  it('two duplicates made at once get different readable ids', async () => {
    const src = await sourceCase();
    const [a, b] = await Promise.all([1, 2].map(() => ok(admin, 'POST', `/api/v1/cases/${src.test_case.id}/duplicate`)));
    expect(a.test_case.external_id).not.toBe(b.test_case.external_id);
  });
});
