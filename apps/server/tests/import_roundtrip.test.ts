import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** A Tessick export imported into another project gives back the same cases. */
describe('Export, then import into another project', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    // Every priority, and content on the cases.
    await call('PATCH', '/api/v1/cases/SHOP-101', { priority: 'CRITICAL' });
    await call('PATCH', '/api/v1/cases/SHOP-102', { priority: 'LOW' });
    await call('PATCH', '/api/v1/cases/SHOP-103', { priority: 'HIGH', execution_type: 'AUTOMATED' });
  });
  afterEach(async () => {
    await app.close();
  });

  /** Cases of a project by readable id: priority, execution type, summary, preconditions, step actions. */
  async function snapshot(projectId: string) {
    const cases = body(await call('GET', `/api/v1/projects/${projectId}/cases?limit=100`)).cases;
    const out: Record<string, unknown> = {};
    for (const c of cases) {
      const v = body(await call('GET', `/api/v1/cases/${c.id}`)).latest_version;
      out[c.external_id] = { title: c.title, priority: c.priority, execution_type: c.execution_type, summary: v.summary ?? '', preconditions: v.preconditions ?? '', steps: v.steps.map((s: any) => [s.action, s.expected_result]) };
    }
    return out;
  }

  for (const [exportFormat, importFormat] of [
    ['NATIVE_JSON', 'NATIVE_JSON'],
    ['STANDARD_CSV', 'STANDARD_CSV'],
  ]) {
    it(`${exportFormat}: every case comes back with its priority, content and steps`, async () => {
      const exported = await call('POST', `/api/v1/projects/${seed.projectId}/exports/definitions`, { format: exportFormat });
      expect(exported.statusCode).toBe(200);
      const other = body(await call('POST', '/api/v1/projects', { name: 'Copy', prefix: 'COPY' })).project;
      const imported = await call('POST', `/api/v1/projects/${other.id}/imports/execute`, {
        file_content: exported.payload,
        format: importFormat,
        configuration: { field_mappings: [], duplicate_resolution: { default_action: 'CREATE_NEW' } },
      });
      expect(imported.statusCode, imported.payload).toBe(200);
      expect(body(imported).summary.imported_cases_count).toBe(10);

      const before = await snapshot(seed.projectId);
      const after = await snapshot(other.id);
      // Each case keeps its number under the new project's prefix: SHOP-101 -> COPY-101.
      expect(after).toEqual(Object.fromEntries(Object.entries(before).map(([id, c]) => [id.replace(/^SHOP-/, 'COPY-'), c])));
      expect(Object.values(after).map((c: any) => c.priority)).toEqual(expect.arrayContaining(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']));
    });
  }
});
