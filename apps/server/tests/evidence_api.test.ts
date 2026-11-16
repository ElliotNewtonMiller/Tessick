import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { MemoryStorageProvider } from '../src/storage/index.js';
import { runStorageSweep } from '../src/services/storageSweeper.js';
import { loggableUrl } from '../src/observability.js';

/**
 * Evidence, phase 2: the REST API. Uploading (multipart, raw, by run for CI, by upload link),
 * reading (lists, metadata, the content with its headers and ranges), deleting, and who may do
 * what when. On the sample project: SHOP-101..SHOP-1010 in run `seed.buildId`.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const PNG2 = Buffer.concat([PNG, Buffer.from([2])]);
const LOG = Buffer.from('10:00:01 opening login page\n10:00:02 FAILED: button not found\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\u0000');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A multipart/form-data body. */
function multipart(parts: Array<{ name: string; filename?: string; content: Buffer | string; type?: string }>) {
  const boundary = `----tessick${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${p.filename !== undefined ? `Content-Type: ${p.type ?? 'application/octet-stream'}\r\n` : ''}\r\n`));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Evidence API', () => {
  let app: any;
  let db: any;
  let seed: any;
  let storage: MemoryStorageProvider;
  let now: Date;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = async (token: string, method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload } : {}) });
    expect(res.statusCode, `${method} ${url}: ${res.payload}`).toBeLessThan(300);
    return body(res);
  };
  const login = async (username: string, password: string) => body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })).token;
  const user = async (username: string, role: string) => {
    await call(admin, 'POST', '/api/v1/admin/users', { username, email: `${username}@example.com`, password: 'Evidence-Test-9!', global_role: role });
    return login(username, 'Evidence-Test-9!');
  };
  const record = async (token: string, ext: string, verdict = 'FAILED') => {
    const out = await call(token, 'POST', `/api/v1/runs/${seed.buildId}/results/batch`, { results: [{ case_identifier: { external_id: ext }, verdict }] });
    return out.results[0].test_result_id as string;
  };
  const upload = (token: string, url: string, parts: Parameters<typeof multipart>[0]) => {
    const m = multipart(parts);
    return app.inject({ method: 'POST', url, headers: { ...auth(token), ...m.headers }, payload: m.payload });
  };
  const raw = (token: string, url: string, content: Buffer, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...auth(token), 'content-type': 'application/octet-stream', ...headers }, payload: content });
  const execUrl = (ext: string) => `/api/v1/runs/${seed.buildId}/cases/${ext}/evidence`;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    now = new Date();
    ({ app, db, seed } = await createServer(undefined, { evidence: { storage, maxFileBytes: 100_000, now: () => now } }));
    admin = await login('admin', 'password');
  });
  afterEach(async () => {
    await app.close();
  });

  it("adds a screenshot to a case's execution, and serves it back safely", async () => {
    const resultId = await record(admin, 'SHOP-101');
    const res = await upload(admin, execUrl('SHOP-101'), [
      { name: 'description', content: 'The login button is missing' },
      { name: 'file', filename: 'C:\\shots\\login failed.png', content: PNG, type: 'image/svg+xml' },
    ]);
    expect(res.statusCode, res.payload).toBe(201);
    const [item] = body(res).evidence;
    expect(item).toMatchObject({
      test_run_id: seed.buildId,
      test_case_id: seed.caseIds[0],
      test_result_id: resultId,
      kind: 'image',
      media_type: 'image/png', // what it is, not what it was sent as
      filename: 'login failed.png',
      description: 'The login button is missing',
      size_bytes: PNG.length,
      sha256: sha(PNG),
      uploaded_by: 'admin',
      uploaded_via: 'API',
      after_close: false,
      duplicate: false,
      content_url: `/api/v1/evidence/${item.id}/content`,
    });
    expect(body(res).refused).toEqual([]);

    const content = await app.inject({ method: 'GET', url: item.content_url, headers: auth(admin) });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.equals(PNG)).toBe(true);
    expect(content.headers).toMatchObject({
      'content-type': 'image/png',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-disposition': `inline; filename="login failed.png"; filename*=UTF-8''login%20failed.png`,
      etag: `"${sha(PNG)}"`,
      'accept-ranges': 'bytes',
    });
    const part = await app.inject({ method: 'GET', url: item.content_url, headers: { ...auth(admin), range: 'bytes=1-3' } });
    expect([part.statusCode, part.headers['content-range'], part.payload]).toEqual([206, `bytes 1-3/${PNG.length}`, 'PNG']);
    expect((await app.inject({ method: 'GET', url: item.content_url, headers: { ...auth(admin), range: 'bytes=999-' } })).statusCode).toBe(416);
    expect((await app.inject({ method: 'GET', url: item.content_url, headers: { ...auth(admin), 'if-none-match': `"${sha(PNG)}"` } })).statusCode).toBe(304);
    expect((await app.inject({ method: 'GET', url: `${item.content_url}?download=1`, headers: auth(admin) })).headers['content-disposition']).toMatch(/^attachment;/);

    // Shown with its result, and in the lists.
    expect((await call(admin, 'GET', `/api/v1/results/${resultId}`)).result.evidence).toEqual([expect.objectContaining({ id: item.id, kind: 'image' })]);
    expect((await call(admin, 'GET', `/api/v1/runs/${seed.buildId}/evidence?test_case_id=SHOP-101`)).evidence.map((e: any) => e.id)).toEqual([item.id]);
    expect((await call(admin, 'GET', execUrl('SHOP-101'))).evidence.map((e: any) => e.id)).toEqual([item.id]);
    expect((await call(admin, 'GET', `/api/v1/evidence/${item.id}`)).evidence.sha256).toBe(sha(PNG));
  });

  it('takes a raw body, checks its checksum, refuses what it must, and adds the same file only once', async () => {
    await record(admin, 'SHOP-101');
    const log = await raw(admin, `${execUrl('SHOP-101')}?filename=run.log`, LOG, { 'x-checksum-sha256': sha(LOG), 'content-type': 'text/plain' });
    expect([log.statusCode, body(log).evidence[0].kind, body(log).evidence[0].media_type]).toEqual([201, 'log', 'text/plain; charset=utf-8']);
    const again = await raw(admin, `${execUrl('SHOP-101')}?filename=again.log`, LOG);
    expect([again.statusCode, body(again).evidence[0].duplicate, body(again).evidence[0].id]).toEqual([200, true, body(log).evidence[0].id]);

    const refusals = [
      [await raw(admin, execUrl('SHOP-101'), PNG2, { 'x-checksum-sha256': sha(PNG) }), 400, 'CHECKSUM_MISMATCH'],
      [await raw(admin, `${execUrl('SHOP-101')}?filename=x.png`, SVG), 415, 'EVIDENCE_TYPE_REFUSED'],
      [await raw(admin, execUrl('SHOP-101'), Buffer.concat([PNG, Buffer.alloc(100_000)])), 413, 'EVIDENCE_TOO_LARGE'],
    ] as const;
    for (const [res, status, code] of refusals) expect([res.statusCode, body(res).code], res.payload).toEqual([status, code]);
    expect(body(refusals[2][0]).limit_bytes).toBe(100_000);
    expect(storage.files.size).toBe(1); // only the log
  });

  it('several files in one request: stored or refused each on its own (207)', async () => {
    await record(admin, 'SHOP-101');
    const res = await upload(admin, execUrl('SHOP-101'), [
      { name: 'file', filename: 'a.png', content: PNG },
      { name: 'file', filename: 'evil.svg', content: SVG },
      { name: 'file', filename: 'b.log', content: LOG },
    ]);
    expect(res.statusCode, res.payload).toBe(207);
    expect(body(res).evidence.map((e: any) => e.filename)).toEqual(['a.png', 'b.log']);
    expect(body(res).refused).toEqual([{ filename: 'evil.svg', test_case_id: seed.caseIds[0], status: 415, code: 'EVIDENCE_TYPE_REFUSED', detail: expect.any(String) }]);
  });

  it('CI: one request for a run, each file named by its case', async () => {
    await record(admin, 'SHOP-101');
    await record(admin, 'SHOP-103', 'PASSED');
    const res = await upload(admin, `/api/v1/runs/${seed.buildId}/evidence`, [
      { name: 'SHOP-101', filename: 'login.png', content: PNG },
      { name: 'SHOP-103', filename: 'run.log', content: LOG },
      { name: 'SHOP-102', filename: 'none.png', content: PNG2 },
      { name: 'NOPE-1', filename: 'x.png', content: PNG2 },
    ]);
    expect(res.statusCode, res.payload).toBe(207);
    expect(body(res).evidence.map((e: any) => [e.test_case_id, e.filename])).toEqual([
      [seed.caseIds[0], 'login.png'],
      [seed.caseIds[2], 'run.log'],
    ]);
    expect(body(res).refused.map((r: any) => [r.filename, r.status, r.code])).toEqual([
      ['none.png', 409, 'NO_RESULT_TO_ATTACH'],
      ['x.png', 404, 'NOT_FOUND'],
    ]);
    // Nothing to attach to: refused before any bytes are kept.
    const none = await upload(admin, execUrl('SHOP-105'), [{ name: 'file', filename: 'x.png', content: PNG }]);
    expect([none.statusCode, body(none).code]).toEqual([409, 'NO_RESULT_TO_ATTACH']);
  });

  it('who may: viewers read, tokens with EXECUTE_RUN upload, other projects see nothing', async () => {
    await record(admin, 'SHOP-101');
    const added = body(await raw(admin, execUrl('SHOP-101'), PNG)).evidence[0];
    const viewer = await user('vera', 'Viewer');
    expect((await app.inject({ method: 'GET', url: added.content_url, headers: auth(viewer) })).statusCode).toBe(200);
    expect((await raw(viewer, execUrl('SHOP-101'), PNG2)).statusCode).toBe(403);

    const token = (await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN'] })).plaintext;
    const ci = await raw(token, `${execUrl('SHOP-101')}?filename=ci.png`, PNG2);
    expect([ci.statusCode, body(ci).evidence[0].uploaded_by]).toEqual([201, 'ci (API token)']);

    const other = (await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const otherToken = (await call(admin, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'other', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN'] })).plaintext;
    expect((await app.inject({ method: 'GET', url: added.content_url, headers: auth(otherToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/evidence/${added.id}`, headers: auth(otherToken) })).statusCode).toBe(404);
  });

  it('after a run closes: only whoever recorded the result, and only for 24 hours', async () => {
    const tester = await user('tess', 'Tester');
    await record(tester, 'SHOP-101');
    await call(admin, 'PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' });
    const own = await raw(tester, execUrl('SHOP-101'), PNG);
    expect([own.statusCode, body(own).evidence?.[0]?.after_close]).toEqual([201, true]);
    const someoneElse = await raw(admin, execUrl('SHOP-101'), PNG2);
    expect([someoneElse.statusCode, body(someoneElse).code]).toEqual([422, 'RUN_CLOSED']);
    now = new Date(now.getTime() + 25 * 3600_000);
    const late = await raw(tester, execUrl('SHOP-101'), PNG2);
    expect([late.statusCode, body(late).code]).toEqual([422, 'RUN_CLOSED']);
  });

  it("a case's evidence list says whether the caller may add and delete, by the upload's and delete's own checks", async () => {
    const tester = await user('tess', 'Tester');
    const viewer = await user('vic', 'Viewer');
    const canAdd = async (token: string, ext = 'SHOP-101') => (await call(token, 'GET', execUrl(ext))).can_add;
    expect(await canAdd(tester)).toMatchObject({ allowed: false, code: 'NO_RESULT_TO_ATTACH' });
    expect(await canAdd(viewer)).toMatchObject({ allowed: false, code: 'FORBIDDEN', reason: expect.stringMatching(/EXECUTE_RUN/) });
    await record(tester, 'SHOP-101');
    expect(await canAdd(tester)).toEqual({ allowed: true, code: null, reason: null });
    await raw(tester, execUrl('SHOP-101'), PNG);
    const listed = async (token: string) => (await call(token, 'GET', execUrl('SHOP-101'))).evidence.map((e: any) => e.can_delete);
    expect([await listed(tester), await listed(admin), await listed(viewer)]).toEqual([[true], [true], [false]]);
    // The run summary report counts each failure's evidence.
    const summary = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/reports/run_summary`, { test_run_id: seed.buildId });
    expect(summary.failures.find((f: any) => f.external_id === 'SHOP-101').evidence_count).toBe(1);
    expect((await call(tester, 'GET', execUrl('SHOP-101'))).evidence[0].uploaded_by_id).toBe(body(await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(tester) })).user.id);

    await call(admin, 'PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' });
    expect([await canAdd(tester), await canAdd(admin)].map((c) => [c.allowed, c.code])).toEqual([[true, null], [false, 'RUN_CLOSED']]);
    expect([await listed(tester), await listed(admin)]).toEqual([[false], [true]]);
    expect(await canAdd(tester, 'SHOP-102')).toMatchObject({ allowed: false, code: 'RUN_CLOSED', reason: expect.stringMatching(/no result/) });
    now = new Date(now.getTime() + 25 * 3600_000);
    expect((await canAdd(tester)).reason).toMatch(/within 24 hours/);
  });

  it('deleting: the uploader while the run is open, or anyone with EXECUTE_OVERWRITE; audited, and the file goes', async () => {
    const tester = await user('tess', 'Tester');
    await record(tester, 'SHOP-101');
    const mine = body(await raw(tester, execUrl('SHOP-101'), PNG)).evidence[0];
    const admins = body(await raw(admin, execUrl('SHOP-101'), PNG2)).evidence[0];
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/evidence/${admins.id}`, headers: auth(tester) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/evidence/${mine.id}`, headers: auth(tester) })).statusCode).toBe(204);
    await call(admin, 'PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/evidence/${admins.id}`, headers: auth(admin) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/evidence/${mine.id}`, headers: auth(admin) })).statusCode).toBe(404);

    const log = (await call(admin, 'GET', '/api/v1/admin/audit-logs?limit=50')).audit_logs ?? (await call(admin, 'GET', '/api/v1/admin/audit-logs?limit=50')).logs;
    const deletions = log.filter((r: any) => r.action === 'EVIDENCE_DELETED');
    expect(deletions).toHaveLength(2);
    const added = await db.selectFrom('audit_logs').select('action').where('action', '=', 'EVIDENCE_ADDED').execute();
    expect(added).toHaveLength(2);
    expect(storage.files.size).toBe(2);
    await runStorageSweep(db, storage);
    expect(storage.files.size).toBe(0);
  });

  it('upload links: one PUT, no sign-in, for that size and checksum, within 15 minutes', async () => {
    await record(admin, 'SHOP-101');
    const make = async (content: Buffer) =>
      body(await app.inject({ method: 'POST', url: `${execUrl('SHOP-101')}/uploads`, headers: auth(admin), payload: { filename: 'run.webm', size_bytes: content.length, sha256: sha(content) } })).upload;
    const link = await make(PNG);
    expect(link).toMatchObject({ method: 'PUT', url: expect.stringMatching(/^http:\/\/localhost(:\d+)?\/api\/v1\/evidence-uploads\/[A-Za-z0-9_-]{43}$/), complete_url: `/api/v1/evidence-uploads/${link.id}/complete` });
    const path = new URL(link.url).pathname;
    const put = (content: Buffer) => app.inject({ method: 'PUT', url: path, headers: link.headers, payload: content });
    const wrong = await put(PNG2);
    expect([wrong.statusCode, body(wrong).code]).toEqual([400, 'SIZE_MISMATCH']);
    const ok = await put(PNG);
    expect([ok.statusCode, body(ok).evidence.kind, body(ok).evidence.filename]).toEqual([201, 'image', 'run.webm']);
    expect((await put(PNG)).statusCode).toBe(404); // used
    // The token is the link's credential, so logs never show it.
    expect(loggableUrl(path)).toBe('/api/v1/evidence-uploads/[token]');
    // Completing answers what the PUT made, for whoever made the link.
    expect((await call(admin, 'POST', link.complete_url)).evidence.id).toBe(body(ok).evidence.id);
    const tester = await user('tess', 'Tester');
    expect((await app.inject({ method: 'POST', url: link.complete_url, headers: auth(tester) })).statusCode).toBe(404);

    const late = await make(PNG2);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await app.inject({ method: 'PUT', url: new URL(late.url).pathname, headers: late.headers, payload: PNG2 })).statusCode).toBe(404);
    const tooBig = await app.inject({ method: 'POST', url: `${execUrl('SHOP-101')}/uploads`, headers: auth(admin), payload: { filename: 'x', size_bytes: 1_000_000, sha256: sha(PNG) } });
    expect([tooBig.statusCode, body(tooBig).code]).toEqual([413, 'EVIDENCE_TOO_LARGE']);
  });

  it('CI: a JUnit report with the screenshots its tests attach, in one request', async () => {
    const report = `<?xml version="1.0"?>
<testsuite name="Authentication &amp; OAuth2 Engine">
  <testcase name="SHOP-101 OAuth2 PKCE Code Exchange Flow" time="1.5">
    <failure message="button not found">stack</failure>
    <system-out>opened page\n[[ATTACHMENT|/builds/42/screenshots/login.png]]\n</system-out>
  </testcase>
  <testcase name="SHOP-102 JWT Refresh Token Rotation">
    <properties><property name="attachment" value="logs/refresh.log"/></properties>
  </testcase>
</testsuite>`;
    const res = await upload(admin, `/api/v1/runs/${seed.buildId}/results/junit`, [
      { name: 'file', filename: 'report.xml', content: report },
      { name: 'shot', filename: 'login.png', content: PNG },
      { name: 'log', filename: 'refresh.log', content: LOG },
      { name: 'extra', filename: 'unrelated.png', content: PNG2 },
    ]);
    expect(res.statusCode, res.payload).toBe(201);
    const out = body(res);
    expect(out.summary).toMatchObject({ successful: 2 });
    expect(out.evidence.evidence.map((e: any) => [e.filename, e.test_case_id, e.test_result_id])).toEqual([
      ['login.png', seed.caseIds[0], out.results[0].test_result_id],
      ['refresh.log', seed.caseIds[1], out.results[1].test_result_id],
    ]);
    expect(out.evidence.refused).toEqual([{ filename: 'unrelated.png', status: 400, code: 'NOT_ATTACHED', detail: expect.any(String) }]);
    expect(storage.files.size).toBe(2);
    // The plain form (just the report) still works.
    const plain = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results/junit`, headers: { ...auth(admin), 'content-type': 'application/xml' }, payload: report });
    expect([plain.statusCode, body(plain).evidence]).toEqual([201, undefined]);
  });

  it("a run deleted with force takes its evidence with it, and the sweeper removes the files", async () => {
    await record(admin, 'SHOP-101');
    await raw(admin, execUrl('SHOP-101'), PNG);
    // The warning names what would be lost.
    const warning = await app.inject({ method: 'DELETE', url: `/api/v1/runs/${seed.buildId}`, headers: auth(admin) });
    expect([warning.statusCode, body(warning).detail]).toEqual([409, expect.stringContaining('1 recorded result and 1 evidence file')]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/runs/${seed.buildId}?force=true`, headers: auth(admin) })).statusCode).toBe(204);
    expect(await db.selectFrom('evidence').select('id').execute()).toEqual([]);
    await runStorageSweep(db, storage);
    expect(storage.files.size).toBe(0);
  });

  it('the Security Audit Log groups evidence additions by uploader, run and hour; each stays listed by action', async () => {
    const tester = await user('tess', 'Tester');
    await record(admin, 'SHOP-101');
    await record(tester, 'SHOP-102');
    for (const [name, file] of [['a.png', PNG], ['b.png', PNG2], ['run.log', LOG]] as const) await raw(admin, `${execUrl('SHOP-101')}?filename=${name}`, file);
    await raw(tester, `${execUrl('SHOP-102')}?filename=mine.png`, PNG);
    // Later, a deletion: an ordinary entry, newer than both.
    now = new Date(now.getTime() + 2 * 3600_000);
    const one = (await call(admin, 'GET', execUrl('SHOP-101'))).evidence[2];
    await call(admin, 'DELETE', `/api/v1/evidence/${one.id}`);

    const log = (await call(admin, 'GET', '/api/v1/admin/audit-logs')).audit_logs.filter((r: any) => r.action.startsWith('EVIDENCE'));
    expect(log.map((r: any) => [r.action, r.grouped_count ?? 1])).toEqual([['EVIDENCE_DELETED', 1], ['EVIDENCE_ADDED', 1], ['EVIDENCE_ADDED', 3]]);
    const group = log[2];
    expect(group).toMatchObject({ resource_type: 'test_run', resource_id: seed.buildId, first_created_at: expect.any(String) });
    expect(JSON.parse(group.diff)).toEqual({ files: 3, total_bytes: PNG.length + PNG2.length + LOG.length, kinds: { image: 2, log: 1 }, after_close: 0, via: 'API', first_files: ['a.png', 'b.png', 'run.log'] });
    expect(JSON.parse(log[1].diff).filename).toBe('mine.png');
    // Each addition is still there, by action.
    expect((await call(admin, 'GET', '/api/v1/admin/audit-logs?action=EVIDENCE_ADDED')).audit_logs).toHaveLength(4);
    // Paging one entry at a time meets each entry once, groups included.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const pageOut: any = await call(admin, 'GET', `/api/v1/admin/audit-logs?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...pageOut.audit_logs.map((r: any) => r.id));
      cursor = pageOut.next_cursor;
    } while (cursor);
    const all = (await call(admin, 'GET', '/api/v1/admin/audit-logs?limit=500')).audit_logs.map((r: any) => r.id);
    expect(seen).toEqual(all);
    expect(all).toContain(group.id);
  });
});
