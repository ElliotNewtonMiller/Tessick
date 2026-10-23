import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('API tokens: where they work, and what they say about themselves', () => {
  let app: any;
  let seed: any;
  let adminToken: string;

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    adminToken = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
  });
  afterEach(async () => {
    await app.close();
  });

  const CAPABILITIES = ['SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT'];
  async function mint(interfaces?: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `Agent ${interfaces ?? 'default'}`, capabilities: CAPABILITIES, ...(interfaces ? { interfaces } : {}) },
    });
    expect(res.statusCode, res.payload).toBe(201);
    const body = JSON.parse(res.payload);
    return { plaintext: body.plaintext as string, token: body.token };
  }
  const rest = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  let rpcId = 0;
  const mcp = (token: string, name: string, args: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    });
  const toolResult = (res: any) => JSON.parse(JSON.parse(res.payload).result.content[0].text);

  it('a token works on both by default', async () => {
    const { plaintext, token } = await mint();
    expect(token.interfaces).toBe('BOTH');
    expect((await rest(plaintext, '/api/v1/projects')).statusCode).toBe(200);
    expect((await mcp(plaintext, 'list_projects')).statusCode).toBe(200);
  });

  it("an MCP-only token works through MCP, including MCP's write tools, and is refused on the REST API", async () => {
    const { plaintext, token } = await mint('MCP');
    expect(token.interfaces).toBe('MCP');

    const listed = toolResult(await mcp(plaintext, 'list_projects'));
    expect(listed.projects.map((p: any) => p.id)).toEqual([seed.projectId]);
    expect(listed.api_token).toMatchObject({ project_id: seed.projectId, interfaces: 'MCP' });

    // A write tool calls the REST route on the token's behalf; that's still MCP, so it's allowed.
    const created = await mcp(plaintext, 'create_case', { project_id: seed.projectId, test_suite_id: seed.suiteId, title: 'Drafted by an agent' });
    const result = JSON.parse(created.payload).result;
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(JSON.parse(result.content[0].text).version.status).toBe('DRAFT');

    // The REST API, directly, is refused: there MCP's limits wouldn't apply.
    for (const url of ['/api/v1/projects', '/api/v1/auth/me', `/api/v1/projects/${seed.projectId}/cases`]) {
      const res = await rest(plaintext, url);
      expect(res.statusCode, url).toBe(403);
      expect(JSON.parse(res.payload)).toMatchObject({ code: 'TOKEN_INTERFACE_NOT_ALLOWED', token_interfaces: 'MCP' });
    }
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/cases`,
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { test_suite_id: seed.suiteId, title: 'Around MCP' },
    });
    expect(post.statusCode).toBe(403);
  });

  it('a REST-only token is refused by MCP', async () => {
    const { plaintext } = await mint('REST');
    expect((await rest(plaintext, '/api/v1/projects')).statusCode).toBe(200);
    const res = await mcp(plaintext, 'list_projects');
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload)).toMatchObject({ code: 'TOKEN_INTERFACE_NOT_ALLOWED', token_interfaces: 'REST' });
  });

  it('refuses an unknown interfaces value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Bad', capabilities: ['SPEC_VIEW'], interfaces: 'GRAPHQL' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).invalid_params[0].name).toBe('interfaces');
  });

  it("GET /auth/me describes the token, and GET /projects says it's limited to the token's project", async () => {
    const { plaintext, token } = await mint();
    const me = JSON.parse((await rest(plaintext, '/api/v1/auth/me')).payload).user;
    expect(me.api_token).toEqual({
      id: token.id,
      project_id: seed.projectId,
      name: 'Agent default',
      capabilities: CAPABILITIES,
      interfaces: 'BOTH',
      expires_at: null,
    });

    const listed = JSON.parse((await rest(plaintext, '/api/v1/projects')).payload);
    expect(listed.projects.map((p: any) => p.id)).toEqual([seed.projectId]);
    expect(listed.api_token).toMatchObject({ id: token.id, project_id: seed.projectId, note: expect.stringContaining('bound to one project') });

    // A signed-in user's list says nothing of the sort.
    expect(JSON.parse((await rest(adminToken, '/api/v1/projects')).payload).api_token).toBeUndefined();
  });

  it('the token list shows where each works', async () => {
    await mint('MCP');
    const listed = JSON.parse((await rest(adminToken, `/api/v1/projects/${seed.projectId}/api-tokens`)).payload);
    expect(listed.tokens.map((t: any) => t.interfaces)).toContain('MCP');
  });
});
