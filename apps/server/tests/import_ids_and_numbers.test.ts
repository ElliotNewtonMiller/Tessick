import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** A TestLink export: ids are the bare numbers (TestLink keeps the prefix separately). */
const testlinkXml = (cases: Array<{ id: string; name: string; sprint?: string }>) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="Condor">
${cases
  .map(
    (c) => `  <testcase name="${c.name}">
    <externalid><![CDATA[${c.id}]]></externalid>
    ${c.sprint ? `<custom_fields><custom_field><name><![CDATA[sprint]]></name><value><![CDATA[${c.sprint}]]></value></custom_field></custom_fields>` : ''}
  </testcase>`
  )
  .join('\n')}
</testsuite>`;

describe('Imports keep case ids, NUMBER fields keep the number, and CHECKBOX fields read yes and no', () => {
  let app: any;
  let token: string;

  beforeEach(async () => {
    ({ app } = await createServer());
    token = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
  });
  afterEach(async () => {
    await app.close();
  });

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const body = (res: any) => JSON.parse(res.payload);

  it("a TestLink file's case numbers become the project's ids, duplicates are recognised, and new cases continue after them", async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Condor', prefix: 'CON' })).project;
    const file = testlinkXml([
      { id: '331', name: 'Takeoff checklist' },
      { id: '145', name: 'Landing gear' },
    ]);

    const dry = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: file, format: 'TESTLINK_XML' }));
    expect(dry.dry_run_summary).toMatchObject({ total_cases_detected: 2, cases_to_create: 2 });

    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, { file_content: file, format: 'TESTLINK_XML' });
    expect(done.statusCode, done.payload).toBe(200);
    const cases = body(await call('GET', `/api/v1/projects/${project.id}/cases?limit=10`)).cases;
    expect(Object.fromEntries(cases.map((c: any) => [c.external_id, c.title]))).toEqual({ 'CON-331': 'Takeoff checklist', 'CON-145': 'Landing gear' });

    // Readable ids work everywhere a case id is taken.
    expect(body(await call('GET', '/api/v1/cases/CON-331')).test_case.title).toBe('Takeoff checklist');

    // Importing the same file again finds both as duplicates instead of creating copies.
    const again = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: file, format: 'TESTLINK_XML' }));
    expect(again.dry_run_summary.cases_to_create).toBe(0);

    // A case made afterwards continues from the highest number.
    const suiteId = body(await call('GET', `/api/v1/cases/CON-331`)).test_case.test_suite_id;
    const created = body(await call('POST', `/api/v1/projects/${project.id}/cases`, { test_suite_id: suiteId, title: 'New one' }));
    expect(created.test_case.external_id).toBe('CON-332');
  });

  it('a NUMBER field keeps the number in "Sprint 34" and skips a value with no number', async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Numbers', prefix: 'NUM' })).project;
    const file = testlinkXml([
      { id: '1', name: 'Has a sprint', sprint: 'Sprint 34' },
      { id: '2', name: 'Plain number', sprint: '7' },
      { id: '3', name: 'No number', sprint: 'none' },
    ]);
    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, {
      file_content: file,
      format: 'TESTLINK_XML',
      configuration: { field_mappings: [{ incoming_key: 'sprint', action: 'AUTO_CREATE', field_type: 'NUMBER', field_name: 'Sprint' }] },
    });
    expect(done.statusCode, done.payload).toBe(200);
    const result = body(done);
    expect(result.summary).toMatchObject({ auto_created_custom_fields_count: 1, skipped_custom_field_values_count: 1 });
    expect(result.skipped_custom_field_value_warnings).toEqual([
      expect.objectContaining({ case_external_id_or_title: 'NUM-3', incoming_key: 'sprint', reason: 'No number in "none"' }),
    ]);

    const sprintOf = async (id: string) => {
      const values = body(await call('GET', `/api/v1/cases/${id}/custom-fields`)).values;
      return values.find((v: any) => v.definition.name === 'sprint')?.value ?? null;
    };
    expect(await sprintOf('NUM-1')).toBe(34);
    expect(await sprintOf('NUM-2')).toBe(7);
    expect(await sprintOf('NUM-3')).toBeNull();
  });

  it('a CHECKBOX field reads "Yes" and "No", as TestLink exports them, and skips other text', async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'Checks', prefix: 'CHK' })).project;
    const file = testlinkXml([
      { id: '1', name: 'Regulated', sprint: 'Yes' },
      { id: '2', name: 'Not regulated', sprint: 'No' },
      { id: '3', name: 'Unclear', sprint: 'maybe' },
    ]);
    const preview = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: file, format: 'TESTLINK_XML' }));
    expect(preview.unmapped_custom_fields[0]).toMatchObject({ incoming_key: 'sprint', detected_type: 'TEXT' });
    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, {
      file_content: file,
      format: 'TESTLINK_XML',
      configuration: { field_mappings: [{ incoming_key: 'sprint', action: 'AUTO_CREATE', field_type: 'CHECKBOX', field_name: 'Regulated' }] },
    });
    expect(done.statusCode, done.payload).toBe(200);
    expect(body(done).skipped_custom_field_value_warnings).toEqual([
      expect.objectContaining({ case_external_id_or_title: 'CHK-3', incoming_key: 'sprint', reason: 'Not yes or no: "maybe"' }),
    ]);
    const tickOf = async (id: string) => {
      const values = body(await call('GET', `/api/v1/cases/${id}/custom-fields`)).values;
      return values.find((v: any) => v.definition.name === 'sprint')?.value ?? null;
    };
    expect(await tickOf('CHK-1')).toBe(true);
    expect(await tickOf('CHK-2')).toBe(false);
  });
});
