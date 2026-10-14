import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** A TestRail CSV export (the layout with a Step column, one step per line) imported through the API. */
describe('TestRail CSV import', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });

  const file = [
    '"ID","Title","Section","Type","Priority","Estimate","Preconditions","Step","Expected Result"',
    '"C501","Sign in with a valid password","Accounts > Sign-in","Functional","High","2m","An active user.","Open /login.\nEnter the email and password.\nPress Sign in.","The form shows.\nThe password is masked.\nThe dashboard opens."',
    '"C502","Reject a wrong password","Accounts > Sign-in","Security","Critical","1m","","Open /login.\nEnter a wrong password.","An error says the password is wrong."',
    '"C503","Upload results in bulk","Integrations > CI","Automated","Medium","5m","A CI token.","Send a batch of 250 results.","201 Created."',
  ].join('\n');

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('previews and imports every case with its steps, priority, execution type and suite path', async () => {
    const project = body(await call('POST', '/api/v1/projects', { name: 'From TestRail', prefix: 'TR' })).project;
    const dry = body(await call('POST', `/api/v1/projects/${project.id}/imports/dry-run`, { file_content: file, format: 'TESTRAIL_CSV' }));
    expect(dry.dry_run_summary).toMatchObject({ total_cases_detected: 3, cases_to_create: 3 });
    // The second case has 2 steps and 1 expected result: a warning, nothing else.
    expect(dry.warnings.map((w: any) => w.code)).toEqual(['STEP_EXPECTED_MISALIGNED']);

    const done = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, {
      file_content: file,
      format: 'TESTRAIL_CSV',
      configuration: {
        field_mappings: [
          { incoming_key: 'cf_type', action: 'AUTO_CREATE', field_type: 'SINGLE_SELECT' },
          { incoming_key: 'cf_estimate', action: 'AUTO_CREATE', field_type: 'TEXT' },
        ],
        duplicate_resolution: { default_action: 'CREATE_NEW' },
      },
    });
    expect(done.statusCode, done.payload).toBe(200);
    expect(body(done).summary).toMatchObject({ imported_cases_count: 3, imported_suites_count: 4 });

    const cases = body(await call('GET', `/api/v1/projects/${project.id}/cases?limit=10`)).cases;
    const byId = Object.fromEntries(cases.map((c: any) => [c.external_id, c]));
    expect(Object.keys(byId).sort()).toEqual(['C501', 'C502', 'C503']);
    expect([byId.C501.priority, byId.C502.priority, byId.C503.priority]).toEqual(['HIGH', 'CRITICAL', 'MEDIUM']);
    expect([byId.C501.execution_type, byId.C503.execution_type]).toEqual(['MANUAL', 'AUTOMATED']);

    const steps = async (id: string) => body(await call('GET', `/api/v1/cases/${byId[id].id}`)).latest_version.steps.map((s: any) => [s.action, s.expected_result]);
    expect(await steps('C501')).toEqual([
      ['Open /login.', 'The form shows.'],
      ['Enter the email and password.', 'The password is masked.'],
      ['Press Sign in.', 'The dashboard opens.'],
    ]);
    expect(await steps('C502')).toEqual([
      ['Open /login.', ''],
      ['Enter a wrong password.', 'An error says the password is wrong.'],
    ]);
    expect(body(await call('GET', `/api/v1/cases/${byId.C501.id}`)).latest_version.preconditions).toBe('An active user.');

    // TestRail's other columns became custom fields, named readably by default.
    const values = body(await call('GET', `/api/v1/cases/${byId.C503.id}/custom-fields`)).values.map((v: any) => [v.definition.field_label, v.value]);
    expect(values).toEqual(expect.arrayContaining([['Type', 'Automated'], ['Estimate', '5m']]));

    const tree = body(await call('GET', `/api/v1/projects/${project.id}/spec-tree`));
    const names = JSON.stringify(tree);
    for (const suite of ['Accounts', 'Sign-in', 'Integrations', 'CI']) expect(names).toContain(`"${suite}"`);
  });
});
