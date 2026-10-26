import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { testLinkFixture, q } from './testlinkFixture.js';
import { COMPAT_ROUTES } from '../src/testlinkCompat/index.js';

/**
 * The TestLink-compatible API's answers against Dave's own description of his TestLink REST API
 * (its openapi.yaml): each implemented route, on every version that has it, must answer with a
 * status code the spec documents and a body its schema accepts.
 *
 * Dave's file isn't in this repository (it's his company's, and holds its project keys and
 * hosts), so this runs only when TESTLINK_OPENAPI names it:
 *   TESTLINK_OPENAPI="/path/to/openapi.yaml" npx vitest run apps/server/tests/testlink_compat_contract.test.ts
 */
const specPath = process.env.TESTLINK_OPENAPI;

/** OpenAPI 3.0's schema dialect as JSON Schema: `nullable` (and an `example: null`) allows null; refs point into the spec. */
function toJsonSchema(node: any): any {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') out.$ref = `tl${v}`;
    else if (k !== 'example' && k !== 'nullable' && !k.startsWith('x-')) out[k] = toJsonSchema(v);
  }
  if ((node.nullable || ('example' in node && node.example === null)) && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

describe.skipIf(!specPath)("TestLink-compatible API against Dave's openapi.yaml", () => {
  let fx: Awaited<ReturnType<typeof testLinkFixture>>;
  let spec: any;
  let ajv: Ajv;

  beforeAll(async () => {
    const text = readFileSync(specPath!, 'utf8');
    spec = specPath!.endsWith('.json') ? JSON.parse(text) : (await import('yaml')).parse(text);
    ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ $id: 'tl', components: toJsonSchema(spec.components) });
    fx = await testLinkFixture();
  });
  afterAll(async () => {
    await fx?.app.close();
  });

  /**
   * Calls `path` on every version the spec gives the operation (or only `versions`), checking
   * each answer against it. A POST's body comes from `payload`, made per call so each may differ.
   */
  async function conforms(method: 'get' | 'post', template: string, path: string, payload?: (version: string) => unknown, versions?: string[]) {
    const op = spec.paths[template]?.[method];
    expect(op, `${method} ${template} isn't in the spec`).toBeDefined();
    for (const version of versions ?? (op['x-versions'] as string[])) {
      const res =
        method === 'get'
          ? await fx.tl(path, version)
          : await fx.app.inject({
              method: 'POST',
              url: `/lib/api/rest/${version}${path}`,
              headers: { 'content-type': 'application/json', ...(version === 'v1' ? { authorization: `Basic ${Buffer.from(`${fx.key}:`).toString('base64')}` } : { apikey: fx.key }) },
              payload: JSON.stringify(payload!(version)),
            });
      const documented = op.responses[String(res.statusCode)];
      expect(documented, `${version} ${path} answered ${res.statusCode}, which the spec doesn't list: ${res.payload}`).toBeDefined();
      const resolved = documented.$ref ? spec.components.responses[documented.$ref.split('/').pop()] : documented;
      const schema = resolved.content?.['application/json']?.schema;
      if (!schema) continue;
      const validate = ajv.compile(toJsonSchema(schema));
      const ok = validate(JSON.parse(res.payload));
      expect(ok, `${version} ${path}: ${ajv.errorsText(validate.errors)}\n${res.payload.slice(0, 2000)}`).toBe(true);
    }
  }

  it('answers every implemented read as the spec describes it', async () => {
    const project = (await fx.ok('/testprojects')).item[0];
    const suites = (await fx.ok(`/testprojects/${project.id}/testsuites`)).items;
    const plan = (await fx.ok(`/testprojects/${project.id}/testplans`)).items[0];
    const root = suites[0].id;
    const cf = '[{"name":"automationStatus","value":"Done","match":"equals"}]';

    await conforms('get', '/testprojects', '/testprojects');
    await conforms('get', '/testprojects/{id}', `/testprojects/${project.id}`);
    await conforms('get', '/testprojects/{id}/testplans', `/testprojects/${project.id}/testplans`);
    await conforms('get', '/testplans/{id}/builds', `/testplans/${plan.api_key}/builds`);
    for (const params of [{}, { nosteps: '1' }, { limit: '2', offset: '1' }, { countOnly: '1' }, { groupBy: 'executionType,cf:automationStatus' }, { fields: 'id,name,customfields', cfCompact: '1' }]) {
      await conforms('get', '/testprojects/{id}/testcases', `/testprojects/${project.id}/testcases${q(params)}`);
    }
    for (const params of [{}, { includeMeta: '1' }, { name: 'Deprecated' }, { excludeSuiteNames: 'Deprecated' }]) {
      await conforms('get', '/testprojects/{id}/testsuites', `/testprojects/${project.id}/testsuites${q(params)}`);
    }
    await conforms('get', '/testprojects/{id}/testspec', `/testprojects/${project.id}/testspec`);
    await conforms('get', '/testprojects/{id}/keywords', `/testprojects/${project.id}/keywords`);
    await conforms('get', '/testprojects/{id}/customfields', `/testprojects/${project.id}/customfields`);
    for (const params of [{}, { deep: '1', customfields: '1' }, { deep: '1', cfName: 'automationStatus', cfValue: 'Done' }, { deep: '1', countOnly: '1', cfFilters: cf }]) {
      await conforms('get', '/testsuites/{id}/testcases', `/testsuites/${root}/testcases${q(params)}`);
    }
    // The documented failures. The spec's 404 example has `items: null` where its schema says
    // an array; the answer follows the example, as TestLink's PHP does.
    const missing = await fx.tl('/testsuites/999/testcases');
    const example = spec.paths['/testsuites/{id}/testcases'].get.responses['404'].content['application/json'].example;
    expect([missing.statusCode, JSON.parse(missing.payload)]).toEqual([404, example]);
    const wrongKey = await fx.tl('/testprojects', 'custom', 'not-a-key');
    expect([wrongKey.statusCode, JSON.parse(wrongKey.payload)]).toEqual([400, spec.components.responses.AuthError.content['application/json'].example]);
  });

  it('answers every implemented write as the spec describes it', async () => {
    const project = (await fx.ok('/testprojects/SHOP')).item.id;
    const root = (await fx.ok('/testprojects/SHOP/testsuites')).items[0].id;
    const plan = (await fx.ok('/testprojects/SHOP/testplans')).items[0];
    let n = 0;
    const fresh = (what: string) => `${what} ${++n}`;

    await conforms('post', '/testprojects', '/testprojects', () => ({ name: fresh('Project'), prefix: `P${n}X`, notes: 'n', active: 1, public: 1 }));
    await conforms('post', '/testprojects', '/testprojects', () => ({ name: 'E-Commerce Core Platform', prefix: 'SHOP' }), ['custom']);
    await conforms('post', '/testplans', '/testplans', () => ({ name: fresh('Plan'), testProjectID: project, notes: 'n' }));
    await conforms('post', '/testplans/{id}', `/testplans/${plan.id}`, () => ({ notes: fresh('notes') }));
    await conforms('post', '/testsuites', '/testsuites', () => ({ name: fresh('Suite'), testProjectID: project, parentID: root }));
    await conforms('post', '/testcases', '/testcases', () => ({ name: fresh('Case'), testSuite: { id: root }, testProject: { id: project }, steps: [{ step_number: 1, actions: 'a', expected_results: 'b' }] }));
    await conforms('post', '/testcases', '/testcases', () => ({ name: 'Case 1', testSuite: { id: root }, testProject: { id: project } }), ['custom']);
    await conforms('post', '/testcases/{id}', '/testcases/SHOP-101', () => ({ importance: 2 }));
    await conforms('post', '/testcases/{id}', '/testcases/SHOP-999', () => ({ importance: 2 }));
    await conforms('post', '/testcases/{id}/move', '/testcases/SHOP-101/move', () => ({ testSuiteID: root }));
    await conforms('post', '/testcases/{id}/move', '/testcases/SHOP-101/move', () => ({}));
    await conforms('post', '/testsuites/{id}/move', `/testsuites/${root}/move`, () => ({ parentID: project }));
    await conforms('post', '/keywords', '/keywords', () => ({ keyword: fresh('kw'), testProject: { prefix: 'SHOP' } }));
    await conforms('post', '/builds', '/builds', () => ({ testplan: plan.id, name: fresh('Build') }));
    await conforms('post', '/builds', '/builds', () => ({ testplan: plan.id, name: 'Build 1' }), ['custom']);
    await conforms('post', '/builds', '/builds', () => ({ testplan: 999999, name: 'x' }), ['custom']);
    const build = (await fx.ok(`/testplans/${plan.api_key}/builds`)).items[0].id;
    await conforms('post', '/builds/{id}', `/builds/${build}`, () => ({ notes: fresh('notes') }));
    await conforms('post', '/builds/{id}', '/builds/999999', () => ({ notes: 'x' }));
    await conforms('post', '/executions', '/executions', () => ({ testPlanID: plan.id, buildID: build, testCaseExternalID: 'SHOP-102', statusCode: 'p' }));
    await conforms('post', '/testplans/{id}/platforms', `/testplans/${plan.id}/platforms`, () => [{ name: 'iOS' }]);
  });

  it('answers the metrics and the SWAG file as the spec describes them', async () => {
    const project = (await fx.ok('/testprojects/SHOP')).item;
    await conforms('post', '/swagfile', '/swagfile', () => ({ Shop: { productKey: project.api_key, api: 80 } }));
    await conforms('post', '/swagfile', '/swagfile', () => [1]);
    await conforms('get', '/swagfile', '/swagfile');
    for (const params of [{ projectApiKey: project.api_key }, { projectApiKey: project.api_key, includeExecutionType: '1', excludeSuiteNames: '' }, {}, { projectApiKey: 'nope' }]) {
      await conforms('get', '/testcasemetrics', `/testcasemetrics${q(params)}`);
    }
  });

  it("gives each route the versions and HTTP codes the spec documents", () => {
    for (const route of COMPAT_ROUTES) {
      const op = spec.paths[route.path.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect([...route.versions].sort(), `${route.method} ${route.path} versions`).toEqual([...op['x-versions']].sort());
      const codes = Object.keys(op.responses).map(Number).filter((c) => c !== 200).sort();
      expect([...route.statuses].sort(), `${route.method} ${route.path} codes`).toEqual(codes);
    }
  });
});
