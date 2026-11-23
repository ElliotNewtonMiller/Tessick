import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * A project that doesn't exist -- deleted, or still shown by a page after a dev server's restart --
 * is a 404 on every route that names one (sendIfProjectMissing in middleware/auth.ts). Creating an
 * API token, a suite or a webhook there was a 500: the insert hit the foreign key.
 */
describe('Routes naming a project that does not exist', () => {
  let app: any;
  let token: string;
  const missing = '01a20000-0000-7000-8000-000000000000';

  beforeEach(async () => {
    ({ app } = await createServer());
    token = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
  });
  afterEach(async () => {
    await app.close();
  });

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });

  it('creating a token, a suite or a webhook answers 404, not a database error', async () => {
    const creates: Array<[string, unknown]> = [
      ['api-tokens', { name: 'CI', capabilities: ['SPEC_VIEW'] }],
      ['suites', { name: 'Checkout' }],
      ['webhooks', { name: 'Slack', url: 'https://example.com/hook', events: ['run.closed'] }],
    ];
    for (const [what, payload] of creates) {
      const res = await call('POST', `/api/v1/projects/${missing}/${what}`, payload);
      expect([what, res.statusCode, JSON.parse(res.payload).detail]).toEqual([what, 404, 'Project not found']);
    }
  });

  it('every documented route under /projects/{projectId} answers 404 (or 400 for a body it refuses first), never 500', async () => {
    const spec = JSON.parse((await app.inject({ method: 'GET', url: '/docs/json' })).payload);
    const answers: string[] = [];
    for (const [path, ops] of Object.entries<Record<string, { responses: Record<string, unknown> }>>(spec.paths)) {
      if (!path.startsWith('/api/v1/projects/{projectId}')) continue;
      for (const [method, op] of Object.entries(ops)) {
        const res = await call(method.toUpperCase(), path.replace(/\{[^}]+\}/g, missing), method === 'get' || method === 'delete' ? undefined : {});
        answers.push(`${method.toUpperCase()} ${path} ${res.statusCode}`);
        expect(op.responses['404'], `${method.toUpperCase()} ${path} documents its 404`).toBeTruthy();
      }
    }
    expect(answers.length).toBeGreaterThan(20);
    expect(answers.filter((a) => !/ (404|400)$/.test(a) || (/^(GET|DELETE) /.test(a) && !a.endsWith(' 404')))).toEqual([]);
  });

  it("someone who isn't signed in still gets 401", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${missing}/plans` });
    expect(res.statusCode).toBe(401);
  });
});
