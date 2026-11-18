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

  it("imports TestLink's export of a whole project with its suites at the top, and single cases into one suite", async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Shop', prefix: 'TL' })).project;
    // TestLink wraps a whole project's export in a nameless <testsuite>, the project itself.
    const whole = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="" name="" >
<node_order><![CDATA[]]></node_order>
<details><![CDATA[]]></details>
${xml.replace(/^<\?xml[^>]*>\n/, '')}
<testsuite id="50" name="Search" >
  <node_order><![CDATA[2]]></node_order>
  <testcase internalid="110" name="Search by name"><externalid><![CDATA[3]]></externalid></testcase>
</testsuite>
</testsuite>`;
    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: whole, format: 'TESTLINK_XML' });
    expect(done.statusCode, done.payload).toBe(200);
    const tree = (await tl('/testprojects/TL/testsuites')).items;
    expect(tree.map((s: any) => [s.id, s.name])).toEqual([[40, 'Authentication'], [50, 'Search']]);

    // TestLink's export of single cases has no suite: the dry run says where they go.
    const single = `<?xml version="1.0" encoding="UTF-8"?>
<testcases>
  <testcase internalid="120" name="Reset a password"><externalid><![CDATA[4]]></externalid></testcase>
</testcases>`;
    const preview = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: single }));
    expect(preview.warnings.map((w: any) => [w.code, w.case_title, w.suite_path])).toEqual(
      expect.arrayContaining([['CASE_OUTSIDE_SUITE', 'Reset a password', 'Imported cases']]),
    );
    expect((await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: single })).statusCode).toBe(200);
    const after = (await tl('/testprojects/TL/testsuites')).items;
    expect(after.map((s: any) => s.name).sort()).toEqual(['Authentication', 'Imported cases', 'Search']);
    const cases = (await tl('/testprojects/TL/testcases')).items;
    expect(cases.find((c: any) => c.id === 120)?.external_id).toBe('TL-4');
  });

  it("keeps each case's TestLink status: drafts stay drafts, and a file without one is approved", async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Statuses', prefix: 'ST' })).project;
    const file = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="" name="" >
<testsuite id="70" name="Mixed" >
  <testcase internalid="140" name="A draft"><externalid><![CDATA[1]]></externalid><status>1</status><active>1</active></testcase>
  <testcase internalid="141" name="A final"><externalid><![CDATA[2]]></externalid><status>7</status><active>1</active></testcase>
  <testcase internalid="142" name="No status"><externalid><![CDATA[3]]></externalid></testcase>
</testsuite>
</testsuite>`;
    expect((await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: file })).statusCode).toBe(200);
    const statuses = [];
    for (const id of ['ST-1', 'ST-2', 'ST-3']) statuses.push(body(await call('GET', `/api/v1/cases/${id}/versions/latest`)));
    expect(statuses.map((v: any) => v.version.status)).toEqual(['DRAFT', 'APPROVED', 'APPROVED']);
  });

  it('keeps two TestLink cases that share a title in one suite apart, on import and re-import', async () => {
    // TestLink allows it; a case with an id in the file is matched by that id alone.
    const project = body(await call('POST', '/api/v1/projects', { name: 'Twins', prefix: 'TW' })).project;
    const twins = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="" name="" >
<testsuite id="60" name="Courses" >
  <testcase internalid="130" name="Credits are routed"><externalid><![CDATA[7]]></externalid><summary><![CDATA[First]]></summary></testcase>
  <testcase internalid="131" name="Credits are routed"><externalid><![CDATA[8]]></externalid><summary><![CDATA[Second]]></summary></testcase>
</testsuite>
</testsuite>`;
    const importTwins = async () => {
      const preview = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: twins }));
      const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: twins });
      expect(done.statusCode, done.payload).toBe(200);
      return { preview: preview.dry_run_summary, done: body(done).summary };
    };

    const first = await importTwins();
    expect([first.preview.cases_to_create, first.done.imported_cases_count, first.done.created_versions_count]).toEqual([2, 2, 2]);
    const again = await importTwins();
    expect([again.preview.cases_to_version_up, again.done.imported_cases_count, again.done.created_versions_count]).toEqual([2, 0, 2]);

    const cases = (await tl('/testprojects/TW/testcases')).items;
    expect(cases.map((c: any) => [c.external_id, c.summary, c.version]).sort()).toEqual([
      ['TW-7', 'First', 2],
      ['TW-8', 'Second', 2],
    ]);
  });
});
