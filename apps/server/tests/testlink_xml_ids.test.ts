import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * A TestLink XML export keeps TestLink's ids for the TestLink-compatible API: a suite's `id`, a
 * case's `internalid`, and the case's keywords (phase 5).
 */
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="40" name="Authentication">
  <node_order><![CDATA[1]]></node_order>
  <details><![CDATA[<p>Signing in</p>]]></details>
  <testsuite id="41" name="Login">
    <testcase internalid="100" name="Login with valid credentials">
      <externalid><![CDATA[1]]></externalid>
      <summary><![CDATA[<p>Verify login</p>]]></summary>
      <keywords>
        <keyword name="smoke"><notes><![CDATA[Smoke tests]]></notes></keyword>
        <keyword name="regression"><notes><![CDATA[]]></notes></keyword>
      </keywords>
    </testcase>
    <testcase internalid="105" name="Lockout">
      <externalid><![CDATA[2]]></externalid>
    </testcase>
  </testsuite>
</testsuite>`;

describe('TestLink XML imports keep TestLink ids and keywords', () => {
  let app: any;
  let token: string;
  let key: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const tl = async (path: string) => body(await app.inject({ method: 'GET', url: `/lib/api/rest/custom${path}`, headers: { apikey: key } }));

  beforeEach(async () => {
    ({ app } = await createServer());
    token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    key = body(await call('POST', '/api/v1/auth/me/testlink-key')).plaintext;
  });
  afterEach(async () => {
    await app.close();
  });

  it("answers with the file's suite and case ids, and its keywords", async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Mobile App', prefix: 'MA' })).project;
    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: xml, format: 'TESTLINK_XML' });
    expect(done.statusCode, done.payload).toBe(200);

    const tree = (await tl('/testprojects/MA/testsuites')).items;
    expect(tree.map((s: any) => [s.id, s.name, s.children.map((c: any) => c.id)])).toEqual([[40, 'Authentication', [41]]]);
    const cases = (await tl('/testprojects/MA/testcases')).items;
    expect(cases.map((c: any) => [c.id, c.external_id, Object.values(c.keywords).sort()])).toEqual([
      [100, 'MA-1', ['regression', 'smoke']],
      [105, 'MA-2', []],
    ]);
    expect((await tl('/testprojects/MA/keywords')).items.map((k: any) => k.keyword)).toEqual(['smoke', 'regression']);

    // The same numbers in a second project are taken: its rows get new ones.
    const other = body(await call('POST', '/api/v1/projects', { name: 'Copy', prefix: 'CP' })).project;
    expect((await call('POST', `/api/v1/projects/${other.id}/imports/execute`, { file_content: xml, format: 'TESTLINK_XML' })).statusCode).toBe(200);
    const copies = (await tl('/testprojects/CP/testcases')).items.map((c: any) => c.id);
    expect(copies.every((id: number) => ![100, 105].includes(id))).toBe(true);
  });
});
