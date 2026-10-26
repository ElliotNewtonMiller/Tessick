import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CompatIdRepository, CompatApiKeyRepository } from '@testify/db';

/**
 * The TestLink-compatible API, phase 1: the three version paths, TestLink's envelope and errors,
 * the test routes, and TestLink API keys (APIKEY header, HTTP Basic user name).
 */
describe('TestLink-compatible API: paths, keys and envelope', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const tl = (version: string, path: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/lib/api/rest/${version}${path}`, headers });
  const basic = (key: string) => ({ authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` });
  const AUTH_ERROR = { status: 'ko', message: 'authentication error' };

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  async function adminKey(): Promise<string> {
    const res = await call(admin, 'POST', '/api/v1/auth/me/testlink-key');
    expect(res.statusCode, res.payload).toBe(201);
    return body(res).plaintext;
  }

  it('answers the test routes word for word, on each version that has them', async () => {
    const key = await adminKey();
    for (const v of ['v1', 'v2', 'custom']) {
      const who = await tl(v, '/who');
      expect([who.statusCode, who.headers['content-type'], who.payload]).toEqual([200, 'text/plain; charset=utf-8', 'tlRestApi : You have called the Get Route /who']);
      const whoAmI = await tl(v, '/whoAmI', v === 'v1' ? basic(key) : { apikey: key });
      expect([whoAmI.statusCode, body(whoAmI)]).toEqual([200, { name: 'tlRestApi : You have called Get Route /whoAmI' }]);
    }
    expect(body(await tl('custom', '/superman', { apikey: key }))).toEqual({ name: 'tlRestApi : You have called the Get Route /superman' });
    // /superman isn't in v1.
    const v1 = await tl('v1', '/superman', basic(key));
    expect([v1.statusCode, body(v1).status]).toEqual([404, 'ko']);
  });

  it('takes the key as TestLink does: APIKEY or the Basic user name, but only Basic on v1', async () => {
    const key = await adminKey();
    expect((await tl('v2', '/whoAmI', basic(key))).statusCode).toBe(200);
    // v1 doesn't read the APIKEY header.
    const v1 = await tl('v1', '/whoAmI', { apikey: key });
    expect([v1.statusCode, body(v1)]).toEqual([400, AUTH_ERROR]);
    for (const headers of [{}, { apikey: 'wrong' }, { apikey: '' }, basic('wrong'), { authorization: `Bearer ${admin}` }]) {
      const res = await tl('custom', '/whoAmI', headers);
      expect([res.statusCode, body(res)], JSON.stringify(headers)).toEqual([400, AUTH_ERROR]);
    }
  });

  it("a key stops working when it's replaced, removed, or its user is disabled; it works only on the TestLink paths", async () => {
    const first = await adminKey();
    const second = await adminKey();
    expect((await tl('custom', '/whoAmI', { apikey: first })).statusCode).toBe(400);
    expect((await tl('custom', '/whoAmI', { apikey: second })).statusCode).toBe(200);
    // Not a credential for Testify's own API.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { apikey: second } })).statusCode).toBe(401);
    expect((await call(second, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);

    expect((await call(admin, 'DELETE', '/api/v1/auth/me/testlink-key')).statusCode).toBe(204);
    expect((await tl('custom', '/whoAmI', { apikey: second })).statusCode).toBe(400);

    // Another user's key, removed by an admin, and by disabling the user.
    const created = body(await call(admin, 'POST', '/api/v1/admin/users', { username: 'dave', email: 'dave@example.com', password: 'Dave-Scripts-Key-9', global_role: 'Test Lead' })).user;
    const dave = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'dave', password: 'Dave-Scripts-Key-9' } })).token;
    const daveKey = body(await call(dave, 'POST', '/api/v1/auth/me/testlink-key')).plaintext;
    expect((await tl('custom', '/whoAmI', { apikey: daveKey })).statusCode).toBe(200);
    const roster = body(await call(admin, 'GET', '/api/v1/admin/users')).users.find((u: any) => u.id === created.id);
    expect(roster.testlink_key).toMatchObject({ key_prefix: daveKey.slice(0, 6), last_used_at: expect.any(String) });
    expect((await call(admin, 'DELETE', `/api/v1/admin/users/${created.id}/testlink-key`)).statusCode).toBe(204);
    expect((await tl('custom', '/whoAmI', { apikey: daveKey })).statusCode).toBe(400);

    const again = body(await call(dave, 'POST', '/api/v1/auth/me/testlink-key')).plaintext;
    expect((await call(admin, 'PATCH', `/api/v1/admin/users/${created.id}`, { status: 'DISABLED' })).statusCode).toBe(200);
    expect((await tl('custom', '/whoAmI', { apikey: again })).statusCode).toBe(400);

    const actions = (await db.selectFrom('audit_logs').select('action').where('action', 'like', 'TESTLINK_KEY_%').execute()).map((r: any) => r.action);
    expect(actions.filter((a: string) => a === 'TESTLINK_KEY_CREATED')).toHaveLength(4);
    expect(actions.filter((a: string) => a === 'TESTLINK_KEY_REVOKED')).toHaveLength(2);
  });

  it('shows your key without the key itself; API tokens can manage none', async () => {
    expect(body(await call(admin, 'GET', '/api/v1/auth/me/testlink-key'))).toEqual({ testlink_key: null });
    const made = body(await call(admin, 'POST', '/api/v1/auth/me/testlink-key'));
    expect(made.plaintext).toMatch(/^[0-9a-f]{32}$/);
    expect(body(await call(admin, 'GET', '/api/v1/auth/me/testlink-key')).testlink_key).toEqual(made.testlink_key);
    expect(JSON.stringify(body(await call(admin, 'GET', '/api/v1/auth/me/testlink-key')))).not.toContain(made.plaintext);

    const token = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW'] })).plaintext;
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(body(await call(token, method, '/api/v1/auth/me/testlink-key')).code, method).toBe('TOKEN_NOT_ALLOWED');
    }
  });

  it("answers in TestLink's envelope for an unknown path, a NUL character and a rate limit", async () => {
    const key = await adminKey();
    expect(body(await tl('custom', '/no-such-route', { apikey: key }))).toEqual({ status: 'ko', message: 'Route GET /lib/api/rest/custom/no-such-route not found' });
    const nul = await tl('custom', '/whoAmI?x=%00', { apikey: key });
    expect([nul.statusCode, body(nul).status, body(nul).message]).toEqual([400, 'ko', expect.stringMatching(/NUL character/)]);
    const { RateLimiter } = await import('../src/services/rateLimits.js');
    app.rateLimits.user = new RateLimiter(1, 60_000);
    expect((await tl('custom', '/whoAmI', { apikey: key })).statusCode).toBe(200);
    const limited = await tl('custom', '/whoAmI', { apikey: key });
    expect([limited.statusCode, body(limited).status, Number(limited.headers['retry-after'])]).toEqual([429, 'ko', expect.any(Number)]);
  });

  it('numbers rows as TestLink does: projects, suites, cases, versions and plans share one sequence', async () => {
    const ids = new CompatIdRepository(db);
    const project = await ids.intId('project', seed.projectId);
    const suite = await ids.intId('suite', seed.suiteId);
    const plan = await ids.intId('plan', seed.planId);
    expect(new Set([project, suite, plan]).size).toBe(3);
    expect(await ids.intId('project', seed.projectId)).toBe(project); // stable
    const build = await ids.intId('build', seed.buildId);
    expect(build).toBe(1); // its own sequence
    expect(await ids.find(suite, ['project', 'suite'])).toEqual({ entity_type: 'suite', entity_id: seed.suiteId });
    // Kept from TestLink, then new ones carry on above it.
    await ids.assign('case', seed.caseIds[0], 70581);
    expect(await ids.intId('case', seed.caseIds[1])).toBe(70582);
    // Many at once, concurrently, never sharing an id.
    const all = await Promise.all(seed.caseIds.slice(2).map((id: string) => ids.intId('case', id)));
    expect(new Set(all).size).toBe(all.length);

    const keys = new CompatApiKeyRepository(db);
    const planKey = await keys.keyFor('plan', seed.planId);
    expect(planKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await keys.keyFor('plan', seed.planId)).toBe(planKey);
    expect(await keys.entityFor('plan', planKey)).toBe(seed.planId);
  });
});
