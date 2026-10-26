import { expect } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * A server with data for the TestLink-compatible API's tests, and helpers to call it.
 *
 * The sample project (SHOP) has one suite with ten approved cases; this adds:
 *   Authentication & OAuth2 Engine   SHOP-101..SHOP-1010 (even ones automated)
 *     Deprecated                     SHOP-1011 (automated, deprecated)
 * a project field automationStatus (Done on SHOP-102 and SHOP-1011, To Do on SHOP-104), and
 * keywords (smoke on SHOP-101). `key` is the admin's TestLink API key.
 */
export async function testLinkFixture() {
  const { app, db, seed } = await createServer();
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = async (token: string, method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as any } : {}) });
    expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBeLessThan(300);
    return res.payload ? JSON.parse(res.payload) : {};
  };
  const admin: string = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  const key: string = (await call(admin, 'POST', '/api/v1/auth/me/testlink-key')).plaintext;

  const p = seed.projectId;
  const deprecatedSuite = (await call(admin, 'POST', `/api/v1/projects/${p}/suites`, { name: 'Deprecated', parent_suite_id: seed.suiteId })).suite.id;
  const old = await call(admin, 'POST', `/api/v1/projects/${p}/cases`, {
    test_suite_id: deprecatedSuite,
    title: 'Old flow',
    execution_type: 'AUTOMATED',
    steps: [{ step_number: 1, action: 'a', expected_result: 'b' }],
  });
  // The sample project approves new cases itself (SPEC_AUTO_APPROVE).
  if (old.version.status === 'DRAFT') await call(admin, 'POST', `/api/v1/versions/${old.version.id}/approve`);
  await call(admin, 'POST', `/api/v1/versions/${old.version.id}/deprecate`);

  const field = async (name: string, label: string, type: string, values: string[]) =>
    (await call(admin, 'POST', '/api/v1/admin/custom-fields', {
      entity_type: 'TestCase',
      name,
      field_label: label,
      field_type: type,
      options: values.map((v) => ({ option_label: v, option_value: v })),
      project_ids: [p],
    })).definition;
  const status = await field('automationStatus', 'Automation Status', 'SINGLE_SELECT', ['N/A', 'To Do', 'Done']);
  const keywords = await field('keywords', 'Keywords', 'MULTI_SELECT', ['smoke', 'nightly']);
  await call(admin, 'PUT', `/api/v1/cases/SHOP-102/custom-fields/${status.id}`, { value: 'Done' });
  await call(admin, 'PUT', `/api/v1/cases/SHOP-104/custom-fields/${status.id}`, { value: 'To Do' });
  await call(admin, 'PUT', `/api/v1/cases/${old.test_case.id}/custom-fields/${status.id}`, { value: 'Done' });
  await call(admin, 'PUT', `/api/v1/cases/SHOP-101/custom-fields/${keywords.id}`, { value: ['smoke'] });

  /** A GET on the compatible API: v1 sends the key as the Basic user name, the others as APIKEY. */
  const tl = (path: string, version = 'custom', apikey = key) =>
    app.inject({
      method: 'GET',
      url: `/lib/api/rest/${version}${path}`,
      headers: version === 'v1' ? { authorization: `Basic ${Buffer.from(`${apikey}:`).toString('base64')}` } : { apikey },
    });
  /** A GET that must succeed with TestLink's ok envelope; its body. */
  const ok = async (path: string, version = 'custom') => {
    const res = await tl(path, version);
    expect(res.statusCode, `${path}: ${res.payload}`).toBe(200);
    const b = body(res);
    expect([b.status, b.message]).toEqual(['ok', 'ok']);
    return b;
  };
  return { app, db, seed, admin, key, body, call, tl, ok };
}

export const q = (params: Record<string, string>) => '?' + new URLSearchParams(params).toString();
