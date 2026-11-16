import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';

/**
 * Evidence, phase 4: the MCP tools. An agent records a result, attaches a screenshot or a log
 * inline, uploads a large file by link, lists the evidence, and looks at it (an image comes back
 * as image content). Everything goes through the REST routes, so their rules hold.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(500, 1)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('MCP evidence tools', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const rest = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const token = async (capabilities: string[], interfaces = 'BOTH') =>
    body(await rest(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'agent', capabilities, interfaces })).plaintext;

  let rpcId = 0;
  async function call(credential: string, name: string, args: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'user-agent': 'claude-code/2.0' },
      payload: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return body(res).result;
  }
  /** A tool's answer: the parsed JSON of its first block, or { error }. */
  async function tool(credential: string, name: string, args: Record<string, unknown>) {
    const out = await call(credential, name, args);
    return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('records a result, attaches a screenshot and a log inline, lists them, and shows them to the agent', async () => {
    const agent = await token(['SPEC_VIEW', 'EXECUTE_RUN'], 'MCP');
    const p = seed.projectId;
    const recorded = await tool(agent, 'record_results', { project_id: p, test_run_id: seed.buildId, results: [{ test_case_id: 'SHOP-101', verdict: 'FAILED' }] });
    const resultId = recorded.results[0].test_result_id;
    expect(resultId).toMatch(/^[0-9a-f-]{36}$/);

    const shot = await tool(agent, 'add_evidence', { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', filename: 'failed.png', content_base64: PNG.toString('base64'), description: 'At the pay button' });
    expect(shot.evidence[0]).toMatchObject({ kind: 'image', media_type: 'image/png', filename: 'failed.png', test_result_id: resultId, sha256: sha(PNG), description: 'At the pay button' });
    expect(shot.evidence[0]).not.toHaveProperty('storage_key');
    // The same file again adds nothing.
    expect((await tool(agent, 'add_evidence', { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', filename: 'again.png', content_base64: PNG.toString('base64') })).evidence[0]).toMatchObject({ id: shot.evidence[0].id, duplicate: true });
    const log = 'line 1\nERROR: card declined ✗\n'.repeat(5000); // about 130 KB
    const logged = await tool(agent, 'add_evidence', { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', filename: 'console.log', text: log });
    expect(logged.evidence[0]).toMatchObject({ kind: 'log', size_bytes: Buffer.byteLength(log) });

    const listed = await tool(agent, 'list_evidence', { project_id: p, test_run_id: seed.buildId });
    expect([listed.more, listed.evidence.map((e: any) => [e.test_case_id, e.kind])]).toEqual([false, [[seed.caseIds[0], 'image'], [seed.caseIds[0], 'log']]]);
    expect((await tool(agent, 'list_evidence', { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', kind: 'log' })).evidence).toHaveLength(1);

    // An image comes back as image content the agent can look at.
    const image = await call(agent, 'get_evidence', { project_id: p, evidence_id: shot.evidence[0].id });
    expect(image.content.map((c: any) => c.type)).toEqual(['text', 'image']);
    expect(image.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') });
    expect(JSON.parse(image.content[0].text).evidence.filename).toBe('failed.png');
    // A log as text: the first 100 KB, cut on a whole character.
    const text = await call(agent, 'get_evidence', { project_id: p, evidence_id: logged.evidence[0].id });
    expect(text.content[1].text).toMatch(/^line 1\nERROR: card declined ✗\n/);
    expect(text.content[1].text).toMatch(/… \(the first 100 KB of \d+ bytes\)$/);
    expect(text.content[1].text).not.toContain('�');

    // Through MCP, marked as such in the audit log.
    const added = body(await rest(admin, 'GET', '/api/v1/admin/audit-logs?action=EVIDENCE_ADDED')).audit_logs;
    expect(added.map((r: any) => r.user_agent)).toEqual(['claude-code/2.0 (via Tessick MCP)', 'claude-code/2.0 (via Tessick MCP)']);
  });

  it("follows the REST rules: a result first, the type by contents, the inline size, and no other project's run", async () => {
    const agent = await token(['SPEC_VIEW', 'EXECUTE_RUN']);
    const p = seed.projectId;
    const args = { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', filename: 'x.png' };
    expect((await tool(agent, 'add_evidence', { ...args, content_base64: PNG.toString('base64') })).error).toMatch(/NO_RESULT_TO_ATTACH/);
    await tool(agent, 'record_results', { project_id: p, test_run_id: seed.buildId, results: [{ test_case_id: 'SHOP-101', verdict: 'PASSED' }] });
    // An executable isn't evidence, whatever it's called (text, even SVG, would be a log, shown as plain text).
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(200)]);
    expect((await tool(agent, 'add_evidence', { ...args, content_base64: elf.toString('base64') })).error).toMatch(/EVIDENCE_TYPE_REFUSED/);
    expect((await tool(agent, 'add_evidence', { ...args, content_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).error).toMatch(/at most 5 MB.*create_evidence_upload/);
    expect((await tool(agent, 'add_evidence', { ...args })).error).toMatch(/either content_base64 or text/);
    expect((await tool(agent, 'add_evidence', { ...args, test_run_id: 'nope', text: 'x' })).error).toMatch(/not found in this project/);
    expect((await tool(agent, 'get_evidence', { project_id: p, evidence_id: 'nope' })).error).toMatch(/not found in this project/);
    // Without EXECUTE_RUN the write tools aren't offered.
    const reader = await token(['SPEC_VIEW']);
    expect((await tool(reader, 'add_evidence', { ...args, text: 'x' })).error).toMatch(/lacks EXECUTE_RUN/);
    expect((await tool(reader, 'list_evidence', { project_id: p, test_run_id: seed.buildId })).evidence).toEqual([]);
  });

  it('a large file by upload link: a curl command that works with no sign-in, then completed', async () => {
    const agent = await token(['SPEC_VIEW', 'EXECUTE_RUN'], 'MCP');
    const p = seed.projectId;
    await tool(agent, 'record_results', { project_id: p, test_run_id: seed.buildId, results: [{ test_case_id: 'SHOP-101', verdict: 'FAILED' }] });
    const link = await tool(agent, 'create_evidence_upload', { project_id: p, test_run_id: seed.buildId, test_case_id: 'SHOP-101', filename: "it's.webm", size_bytes: WEBM.length, sha256: sha(WEBM) });
    expect(link).toMatchObject({ method: 'PUT', url: expect.stringMatching(/\/api\/v1\/evidence-uploads\/[A-Za-z0-9_-]{43}$/) });
    expect(link.curl).toBe(`curl -sf -X PUT ${Object.entries(link.headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ')} --data-binary @'it'\\''s.webm' '${link.url}'`);
    // What the curl command does: a PUT with only the link (with local storage it records the file at once).
    const put = await app.inject({ method: 'PUT', url: new URL(link.url).pathname, headers: link.headers, payload: WEBM });
    expect(put.statusCode, put.payload).toBe(201);
    const done = await tool(agent, 'complete_evidence_upload', { project_id: p, upload_id: link.upload_id });
    expect(done.evidence).toMatchObject({ kind: 'video', filename: "it's.webm", sha256: sha(WEBM) });
    expect((await tool(agent, 'complete_evidence_upload', { project_id: p, upload_id: link.upload_id })).evidence.id).toBe(done.evidence.id);
    // A video is described, not shown.
    const video = await call(agent, 'get_evidence', { project_id: p, evidence_id: done.evidence.id });
    expect(video.content[1].text).toMatch(/A video can't be shown here/);
  });
});
