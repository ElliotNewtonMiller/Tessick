import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CustomFieldRepository } from '@testify/db';

describe('Custom Fields: admin definition CRUD & Spec-mode value CRUD', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<{ token: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    return { token: body.token as string, userId: body.user.id as string };
  }

  async function createAndLoginViewer(app: any, adminToken: string): Promise<{ token: string; userId: string }> {
    const username = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: 'Viewer' },
    });
    expect(createRes.statusCode).toBe(201);
    const userId = JSON.parse(createRes.payload).user.id as string;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId };
  }

  it('every admin custom-fields route requires CUSTOM_FIELD_MANAGE -- a Viewer gets 403 on all of them', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginViewer(app, adminToken);

    const attempts = [
      { method: 'GET', url: '/api/v1/admin/custom-fields' },
      { method: 'POST', url: '/api/v1/admin/custom-fields', payload: { entity_type: 'TestCase', name: 'x', field_label: 'X', field_type: 'TEXT' } },
      { method: 'PATCH', url: '/api/v1/admin/custom-fields/nonexistent', payload: { field_label: 'X' } },
      { method: 'DELETE', url: '/api/v1/admin/custom-fields/nonexistent' },
    ] as const;

    for (const attempt of attempts) {
      const res = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: 'payload' in attempt ? attempt.payload : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('POST/PUT/DELETE definition CRUD happy path', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'story_points', field_label: 'Story Points', field_type: 'NUMBER' },
    });
    expect(createRes.statusCode).toBe(201);
    const definition = JSON.parse(createRes.payload).definition;
    expect(definition.field_type).toBe('NUMBER');

    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { field_label: 'Story Points (Fibonacci)' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.payload).definition.field_label).toBe('Story Points (Fibonacci)');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/custom-fields?entity_type=TestCase',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.payload).definitions.map((d: any) => d.id)).toContain(definition.id);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);
  });

  it('POST rejects an unknown field_type (400) and a duplicate name (409)', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const badType = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'x', field_label: 'X', field_type: 'WEIRD' },
    });
    expect(badType.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner', field_label: 'Owner', field_type: 'TEXT' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner', field_label: 'Owner Again', field_type: 'TEXT' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('DELETE with recorded values returns 409 with a count and leaves data untouched, then force=true actually deletes it', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes CF', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;
    const caseId = seed.caseIds[0];

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'hello' },
    });
    expect(setRes.statusCode).toBe(200);

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(JSON.parse(blockedDelete.payload).blockedByValueCount ?? JSON.parse(blockedDelete.payload).invalid_params).toBeTruthy();

    // Still there.
    const getValuesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cases/${caseId}/custom-fields`,
      headers: { authorization: `Bearer ${token}` },
    });
    const values = JSON.parse(getValuesRes.payload).values;
    expect(values.find((v: any) => v.definition.id === definition.id).value).toBe('hello');

    const forcedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}?force=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forcedDelete.statusCode).toBe(204);
  });

  it('value routes require PLAN_MANAGE for PUT/DELETE, but GET is open to any authenticated user', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginViewer(app, adminToken);
    const caseId = seed.caseIds[0];

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes CF', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const getAsViewer = await app.inject({
      method: 'GET',
      url: `/api/v1/cases/${caseId}/custom-fields`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(getAsViewer.statusCode).toBe(200);

    const putAsViewer = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { value: 'nope' },
    });
    expect(putAsViewer.statusCode).toBe(403);

    const deleteAsViewer = await app.inject({
      method: 'DELETE',
      url: `/api/v1/cases/${caseId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(deleteAsViewer.statusCode).toBe(403);
  });

  it('PUT with an invalid value returns 422', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'points', field_label: 'Points', field_type: 'NUMBER' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'not-a-number' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('editing a custom field value on a case whose latest version is APPROVED (locked) still succeeds', async () => {
    const { app, seed, db } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const versionRow = await db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('test_case_id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(versionRow.status).toBe('APPROVED');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner_cf', field_label: 'Owner', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'Platform Team' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).value).toBe('Platform Team');
  });

  it('value routes work identically for test suites', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const suiteId = seed.suiteId;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestSuite', name: 'owner_team', field_label: 'Owner Team', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/suites/${suiteId}/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'Platform Team' },
    });
    expect(setRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/suites/${suiteId}/custom-fields`,
      headers: { authorization: `Bearer ${token}` },
    });
    const values = JSON.parse(getRes.payload).values;
    expect(values.find((v: any) => v.definition.id === definition.id).value).toBe('Platform Team');
  });

  it("fields made by an import are listed with their project, and can be edited and deleted there", async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });

    const project = JSON.parse((await call('POST', '/api/v1/projects', { name: 'Imported Fields', prefix: 'IMPF' })).payload).project;
    const imported = await call('POST', `/api/v1/projects/${project.id}/imports/execute`, {
      file_content: 'Title,Suite,Team\nLogs in,Login,Platform\n',
      format: 'STANDARD_CSV',
      configuration: { field_mappings: [{ incoming_key: 'cf_team', action: 'AUTO_CREATE', field_type: 'TEXT', field_name: 'Team' }] },
    });
    expect(imported.statusCode, imported.payload).toBe(200);

    // A global field too, to check the order: global first.
    await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'global_area', field_label: 'Area', field_type: 'TEXT' });

    const listed = JSON.parse((await call('GET', '/api/v1/admin/custom-fields?entity_type=TestCase')).payload).definitions;
    expect(listed.map((d: any) => [d.name, d.all_projects, d.projects])).toEqual([
      ['global_area', true, []],
      ['cf_team', false, [{ id: project.id, name: 'Imported Fields' }]],
    ]);
    const field = listed[1];

    // Editable like a global field: relabel it and make it required with a default.
    const patched = await call('PATCH', `/api/v1/admin/custom-fields/${field.id}`, { field_label: 'Owning team', is_required: true, default_value: 'Unassigned' });
    expect(patched.statusCode, patched.payload).toBe(200);
    expect(JSON.parse(patched.payload).definition).toMatchObject({ field_label: 'Owning team', is_required: true, all_projects: false, project_ids: [project.id] });

    // Deletable: it has a value, so it warns first.
    expect((await call('DELETE', `/api/v1/admin/custom-fields/${field.id}`)).statusCode).toBe(409);
    expect((await call('DELETE', `/api/v1/admin/custom-fields/${field.id}?force=true`)).statusCode).toBe(204);
    const after = JSON.parse((await call('GET', '/api/v1/admin/custom-fields')).payload).definitions;
    expect(after.map((d: any) => d.name)).toEqual(['global_area']);
  });

  it("a field's projects can be set: removing one warns first and deletes its values there, adding one gives its cases the default", async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
    const json = (res: any) => JSON.parse(res.payload);

    // A second project with one case (the seed project has ten).
    const other = json(await call('POST', '/api/v1/projects', { name: 'Atlas', prefix: 'ATL' })).project;
    const otherSuite = json(await call('POST', `/api/v1/projects/${other.id}/suites`, { name: 'Flight' })).suite;
    const otherCase = json(await call('POST', `/api/v1/projects/${other.id}/cases`, { test_suite_id: otherSuite.id, title: 'Atlas case' })).test_case;
    const seedCase = seed.caseIds[0];

    const field = json(
      await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'squad', field_label: 'Squad', field_type: 'TEXT', default_value: 'Core' })
    ).definition;
    expect(field).toMatchObject({ all_projects: true, project_ids: [] });
    await call('PUT', `/api/v1/cases/${otherCase.id}/custom-fields/${field.id}`, { value: 'Rockets' });
    const valueOn = async (caseId: string) => json(await call('GET', `/api/v1/cases/${caseId}/custom-fields`)).values.find((v: any) => v.definition.id === field.id);

    // Limiting it to the seed project would delete Atlas's values: a warning first, nothing changed.
    const limit = { all_projects: false, project_ids: [seed.projectId] };
    const warned = await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, limit);
    expect(warned.statusCode).toBe(409);
    expect(json(warned)).toMatchObject({ code: 'CUSTOM_FIELD_PROJECTS_IN_USE', affected_projects: [{ project_id: other.id, project_name: 'Atlas', value_count: 1 }] });
    expect((await valueOn(otherCase.id)).value).toBe('Rockets');

    const limited = await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects?force=true`, limit);
    expect(limited.statusCode, limited.payload).toBe(200);
    expect(json(limited)).toMatchObject({ removed_value_count: 1, definition: { all_projects: false, projects: [{ id: seed.projectId }] } });
    expect(await valueOn(otherCase.id)).toBeUndefined(); // Atlas's cases no longer have the field
    expect((await valueOn(seedCase)).value).toBe('Core');

    // Adding Atlas back gives its case the default.
    const both = await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, { all_projects: false, project_ids: [seed.projectId, other.id] });
    expect(json(both)).toMatchObject({ removed_value_count: 0, seeded_count: 1 });
    expect((await valueOn(otherCase.id)).value).toBe('Core');

    // Back to all projects: nothing to remove.
    expect(json(await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, { all_projects: true })).definition).toMatchObject({ all_projects: true, project_ids: [] });

    // A field needs at least one project, and only real ones.
    expect((await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, { all_projects: false, project_ids: [] })).statusCode).toBe(400);
    expect((await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, { all_projects: false, project_ids: ['nope'] })).statusCode).toBe(400);
    expect((await call('PUT', `/api/v1/admin/custom-fields/${field.id}/projects`, {})).statusCode).toBe(400);
  });

  it('a field can be created for chosen projects; names only clash within a shared project; deleting a project deletes the fields only it had', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
    const json = (res: any) => JSON.parse(res.payload);
    const other = json(await call('POST', '/api/v1/projects', { name: 'Atlas', prefix: 'ATL' })).project;
    const otherSuite = json(await call('POST', `/api/v1/projects/${other.id}/suites`, { name: 'Flight' })).suite;
    const otherCase = json(await call('POST', `/api/v1/projects/${other.id}/cases`, { test_suite_id: otherSuite.id, title: 'Atlas case' })).test_case;
    const create = (name: string, projectIds: string[]) =>
      call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name, field_label: name, field_type: 'TEXT', project_ids: projectIds });

    const onlyAtlas = json(await create('gate', [other.id])).definition;
    expect(onlyAtlas).toMatchObject({ all_projects: false, projects: [{ id: other.id, name: 'Atlas' }] });
    const fieldNames = async (caseId: string) => json(await call('GET', `/api/v1/cases/${caseId}/custom-fields`)).values.map((v: any) => v.definition.name);
    expect(await fieldNames(otherCase.id)).toContain('gate');
    expect(await fieldNames(seed.caseIds[0])).not.toContain('gate');

    // The same name for another project is fine; adding a project where it's taken isn't.
    const seedGate = json(await create('gate', [seed.projectId])).definition;
    expect((await create('gate', [other.id])).statusCode).toBe(409);
    const clash = await call('PUT', `/api/v1/admin/custom-fields/${seedGate.id}/projects`, { all_projects: false, project_ids: [seed.projectId, other.id] });
    expect(clash.statusCode).toBe(409);
    expect(json(clash).code).toBe('FIELD_NAME_TAKEN');
    expect((await create('bad', ['nope'])).statusCode).toBe(400);

    // A field shared by both projects survives Atlas's deletion; Atlas's own goes with it.
    const shared = json(await create('shared', [seed.projectId, other.id])).definition;
    expect((await call('DELETE', `/api/v1/projects/${other.id}?force=true`)).statusCode).toBe(204);
    const left = json(await call('GET', '/api/v1/admin/custom-fields')).definitions;
    expect(left.map((d: any) => d.id).sort()).toEqual([seedGate.id, shared.id].sort());
    expect(left.find((d: any) => d.id === shared.id).project_ids).toEqual([seed.projectId]);
  });

  it('refuses to create OR update a required field without a usable default value', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const noDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'sev', field_label: 'Severity', field_type: 'TEXT', is_required: true },
    });
    expect(noDefault.statusCode).toBe(422);
    expect(JSON.parse(noDefault.payload).detail).toContain('default value');

    const badNumberDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'n', field_label: 'N', field_type: 'NUMBER', is_required: true, default_value: 'abc' },
    });
    expect(badNumberDefault.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'sev', field_label: 'Severity', field_type: 'TEXT', is_required: true, default_value: 'Medium' },
    });
    expect(ok.statusCode).toBe(201);
    const requiredId = JSON.parse(ok.payload).definition.id;

    const optional = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'opt', field_label: 'Optional', field_type: 'TEXT' },
    });
    expect(optional.statusCode).toBe(201);
    const optionalId = JSON.parse(optional.payload).definition.id;

    // A required field must have a default value always, not just at creation: making an
    // existing optional field required with no default is blocked, and so is clearing an
    // already-required field's default.
    const makeRequired = await app.inject({ method: 'PATCH', url: `/api/v1/admin/custom-fields/${optionalId}`, headers: auth, payload: { is_required: true } });
    expect(makeRequired.statusCode).toBe(422);
    const makeRequiredWithDefault = await app.inject({ method: 'PATCH', url: `/api/v1/admin/custom-fields/${optionalId}`, headers: auth, payload: { is_required: true, default_value: 'x' } });
    expect(makeRequiredWithDefault.statusCode).toBe(200);
    const clearDefault = await app.inject({ method: 'PATCH', url: `/api/v1/admin/custom-fields/${requiredId}`, headers: auth, payload: { default_value: null } });
    expect(clearDefault.statusCode).toBe(422);
  });

  it('MULTI_SELECT: a required field needs at least one option toggled on as its default, not just a syntactically valid empty array', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const options = [
      { option_label: 'A', option_value: 'A' },
      { option_label: 'B', option_value: 'B' },
    ];

    const emptyArrayDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'tags_empty', field_label: 'Tags', field_type: 'MULTI_SELECT', is_required: true, default_value: '[]', options },
    });
    expect(emptyArrayDefault.statusCode).toBe(422);
    expect(JSON.parse(emptyArrayDefault.payload).detail).toContain('default value');

    const realDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'tags_real', field_label: 'Tags', field_type: 'MULTI_SELECT', is_required: true, default_value: '["A"]', options },
    });
    expect(realDefault.statusCode).toBe(201);
    const fieldId = JSON.parse(realDefault.payload).definition.id;

    // Same rule on update: flipping to an empty-array default is blocked too.
    const clearedViaUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${fieldId}`,
      headers: auth,
      payload: { default_value: '[]' },
    });
    expect(clearedViaUpdate.statusCode).toBe(422);
  });

  it('MULTI_SELECT: making a field required-with-default switches a case that has no options toggled on to that default', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: {
        entity_type: 'TestCase',
        name: 'tags_switch',
        field_label: 'Tags',
        field_type: 'MULTI_SELECT',
        options: [
          { option_label: 'A', option_value: 'A' },
          { option_label: 'B', option_value: 'B' },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const definitionId = JSON.parse(createRes.payload).definition.id;
    const caseId = seed.caseIds[0];

    // Explicitly deselect every option while the field is still optional -- a real row with
    // json_value null, not "never touched".
    const clearRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definitionId}`,
      headers: auth,
      payload: { value: [] },
    });
    expect(clearRes.statusCode).toBe(200);

    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definitionId}`,
      headers: auth,
      payload: { is_required: true, default_value: '["A","B"]' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.payload).applied_default_count).toBe(1);

    const valuesAfter = JSON.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/custom-fields`, headers: auth })
      ).payload,
    ).values;
    expect(valuesAfter.find((v: any) => v.definition.id === definitionId).value).toEqual(['A', 'B']);
  });

  it('MULTI_SELECT: deleting an option a case has selected deselects it there too, instead of permanently blocking further edits', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: {
        entity_type: 'TestCase',
        name: 'tags_option_removed',
        field_label: 'Tags',
        field_type: 'MULTI_SELECT',
        options: [
          { option_label: 'fire', option_value: 'fire' },
          { option_label: 'water', option_value: 'water' },
          { option_label: 'air', option_value: 'air' },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const definitionId = JSON.parse(createRes.payload).definition.id;
    const caseId = seed.caseIds[0];

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definitionId}`,
      headers: auth,
      payload: { value: ['fire', 'water'] },
    });
    expect(setRes.statusCode).toBe(200);

    // Delete "water" from the field's options (dropping it from the options list entirely).
    const removeOptionRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definitionId}`,
      headers: auth,
      payload: {
        options: [
          { option_label: 'fire', option_value: 'fire' },
          { option_label: 'air', option_value: 'air' },
        ],
      },
    });
    expect(removeOptionRes.statusCode).toBe(200);

    // The case's stored value must already reflect the removal -- "water" dropped, "fire" kept.
    const valuesAfterRemoval = JSON.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/custom-fields`, headers: auth })
      ).payload,
    ).values;
    expect(valuesAfterRemoval.find((v: any) => v.definition.id === definitionId).value).toEqual(['fire']);

    // The real regression: before this fix, a later edit that doesn't even touch the stale
    // selection (here, toggling "air" on alongside the still-valid "fire") would resubmit the
    // now-deleted "water" and fail with INVALID_FIELD_VALUE. It must succeed now.
    const laterEditRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definitionId}`,
      headers: auth,
      payload: { value: ['fire', 'air'] },
    });
    expect(laterEditRes.statusCode).toBe(200);
  });

  it('SINGLE_SELECT: deleting the option a case has selected clears that value to null, and a required field with a default re-applies it', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: {
        entity_type: 'TestCase',
        name: 'severity_option_removed',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        is_required: true,
        default_value: 'Medium',
        options: [
          { option_label: 'Low', option_value: 'Low' },
          { option_label: 'Medium', option_value: 'Medium' },
          { option_label: 'High', option_value: 'High' },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const definitionId = JSON.parse(createRes.payload).definition.id;
    const caseId = seed.caseIds[0];

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definitionId}`,
      headers: auth,
      payload: { value: 'High' },
    });
    expect(setRes.statusCode).toBe(200);

    // Delete "High" -- the case's currently-selected option.
    const removeOptionRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definitionId}`,
      headers: auth,
      payload: {
        options: [
          { option_label: 'Low', option_value: 'Low' },
          { option_label: 'Medium', option_value: 'Medium' },
        ],
      },
    });
    expect(removeOptionRes.statusCode).toBe(200);
    // The field is still required with a usable default ("Medium") -- pruning "High" leaves
    // the case's value blank, and applyDefaultToBlankValues (already run after every update
    // that leaves the field required) re-applies the default immediately in the same request.
    expect(JSON.parse(removeOptionRes.payload).applied_default_count).toBe(1);

    const valuesAfter = JSON.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/custom-fields`, headers: auth })
      ).payload,
    ).values;
    expect(valuesAfter.find((v: any) => v.definition.id === definitionId).value).toBe('Medium');
  });

  it('creating a field with a default seeds a real value for every pre-existing case, frozen against later default edits', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'severity', field_label: 'Severity', field_type: 'TEXT', is_required: true, default_value: 'Medium' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    expect(created.seeded_count).toBe(seed.caseIds.length);

    const caseId = seed.caseIds[0];
    const valuesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/cases/${caseId}/custom-fields`,
      headers: auth,
    });
    const values = JSON.parse(valuesRes.payload).values;
    expect(values.find((v: any) => v.definition.id === created.definition.id).value).toBe('Medium');

    // Editing the field's default afterward must not retroactively change the case's already-
    // frozen value -- the whole point of seeding real rows at creation time.
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${created.definition.id}`,
      headers: auth,
      payload: { default_value: 'High' },
    });
    expect(updateRes.statusCode).toBe(200);

    const valuesAfter = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/cases/${caseId}/custom-fields`,
          headers: auth,
        })
      ).payload,
    ).values;
    expect(valuesAfter.find((v: any) => v.definition.id === created.definition.id).value).toBe('Medium');

    // A brand-new case created AFTER the field exists has no pre-existing value to protect --
    // it still picks up whatever the default is right now (the existing read-time fallback).
    const newCaseRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/cases`,
      headers: auth,
      payload: { test_suite_id: seed.suiteId, title: 'New case after field exists' },
    });
    const newCaseId = JSON.parse(newCaseRes.payload).test_case.id;
    const newCaseValues = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/cases/${newCaseId}/custom-fields`,
          headers: auth,
        })
      ).payload,
    ).values;
    expect(newCaseValues.find((v: any) => v.definition.id === created.definition.id).value).toBe('High');
  });

  it('PUT updating a field to required-with-default switches an existing explicit-blank value to that default', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: {
        entity_type: 'TestCase',
        name: 'severity_switch',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const definitionId = JSON.parse(createRes.payload).definition.id;
    const caseId = seed.caseIds[0];

    // Explicitly clear the value while the field is still optional -- a real row with a null
    // value, not "never touched".
    const clearRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${caseId}/custom-fields/${definitionId}`,
      headers: auth,
      payload: { value: '' },
    });
    expect(clearRes.statusCode).toBe(200);
    const clearedValues = JSON.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/custom-fields`, headers: auth })
      ).payload,
    ).values;
    expect(clearedValues.find((v: any) => v.definition.id === definitionId).value).toBeNull();

    // Flip it to required with a usable default.
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definitionId}`,
      headers: auth,
      payload: { is_required: true, default_value: 'High' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.payload).applied_default_count).toBe(1);

    const valuesAfter = JSON.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/cases/${caseId}/custom-fields`, headers: auth })
      ).payload,
    ).values;
    expect(valuesAfter.find((v: any) => v.definition.id === definitionId).value).toBe('High');
  });

  it('refuses a validation pattern that does not compile or is too long, and stops a catastrophic one from freezing the server', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const create = (name: string, validation_regex: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/custom-fields',
        headers: { authorization: `Bearer ${token}` },
        payload: { entity_type: 'TestCase', name, field_label: name, field_type: 'TEXT', validation_regex },
      });

    const broken = await create('broken_pattern', '([a-z]');
    expect(broken.statusCode).toBe(400);
    expect(JSON.parse(broken.payload).code).toBe('INVALID_VALIDATION_PATTERN');
    expect(JSON.parse(broken.payload).detail).toMatch(/^The validation pattern isn't a valid regular expression/);
    expect((await create('long_pattern', 'a'.repeat(501))).statusCode).toBe(400);

    // A pattern that compiles but backtracks catastrophically can be saved...
    const evil = await create('evil_pattern', '^(a+)+$');
    expect(evil.statusCode).toBe(201);
    const definitionId = JSON.parse(evil.payload).definition.id;

    // ...and can't be changed to a broken one later.
    const badUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${definitionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { validation_regex: '(' },
    });
    expect(badUpdate.statusCode).toBe(400);
    expect(JSON.parse(badUpdate.payload).code).toBe('INVALID_VALIDATION_PATTERN');

    // A value that would make it run for ages is refused quickly (not a 500, not a hang).
    const started = Date.now();
    const slow = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${seed.caseIds[0]}/custom-fields/${definitionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'a'.repeat(40) + '!' },
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(slow.statusCode).toBe(422);
    expect(JSON.stringify(JSON.parse(slow.payload))).toContain('took too long');

    // Ordinary values still work.
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v1/cases/${seed.caseIds[0]}/custom-fields/${definitionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'aaaa' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
