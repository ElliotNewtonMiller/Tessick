import { describe, it, expect } from 'vitest';
import {
  SuiteTree,
  parseCaseQuery,
  parseSuiteTreeQuery,
  runCaseQuery,
  suiteTreeItems,
  projectCaseItem,
  suiteCaseItem,
  specCaseItem,
  TestLinkQueryError,
  RESPONSE_SIZE_CAP_BYTES,
  importanceCode,
  executionTypeCode,
  versionStatusCodes,
  planFlags,
  buildFlags,
  customFieldTypeCode,
  customFieldValueString,
  externalIdNumber,
  priorityFromImportance,
  executionTypeFromCode,
  statusTarget,
  customFieldValueFromString,
  keywordKey,
  type TlCase,
  type TlSuite,
} from '../src/testlink/index.js';

/**
 * The TestLink-compatible API's query layer (Dave's custom-1.4.0) and value mapping.
 *
 * Project 1:
 *   10 Auth            cases 100 (automated, Done), 101 (manual)
 *     11 Login         case 102 (automated, unset status)
 *     12 Deprecated    case 103 (automated, Done, inactive)
 *   20 Billing         case 104 (manual, To Do, keyword smoke)
 */
const suites: TlSuite[] = [
  { id: 10, name: 'Auth', parent_id: 1, parent_suite_id: null, node_order: 1 },
  { id: 11, name: 'Login', parent_id: 10, parent_suite_id: 10, node_order: 1 },
  { id: 12, name: 'Deprecated', parent_id: 10, parent_suite_id: 10, node_order: 2 },
  { id: 20, name: 'Billing', parent_id: 1, parent_suite_id: null, node_order: 2 },
];
const suiteName = (id: number) => suites.find((s) => s.id === id)!.name;

function tc(id: number, suite: number, opts: { auto?: boolean; automationStatus?: string | null; active?: 0 | 1; keywords?: Record<string, string>; ref?: string } = {}): TlCase {
  return {
    id,
    tcversion_id: id + 1000,
    name: `Case ${id}`,
    external_id: `MA-${id - 99}`,
    tc_external_id: String(id - 99),
    version: 1,
    summary: 'summary',
    preconditions: '',
    importance: 2,
    status: opts.active === 0 ? 5 : 7,
    active: opts.active ?? 1,
    execution_type: opts.auto ? 2 : 1,
    estimated_exec_duration: null,
    steps: [{ step_number: 1, actions: 'do', expected_results: 'done', execution_type: 1 }],
    tsuite_id: suite,
    tsuite_name: suiteName(suite),
    path: suiteName(suite),
    keywords: opts.keywords ?? {},
    customfields: {
      '7': {
        id: 7,
        name: 'automationStatus',
        label: 'Automation Status',
        type: 6,
        type_name: 'list',
        possible_values: 'N/A|To Do|Done',
        default_value: 'N/A',
        required: 0,
        enabled_on_design: 1,
        value: opts.automationStatus === undefined ? null : opts.automationStatus,
      },
      '8': {
        id: 8,
        name: 'automationReference',
        label: 'Automation Reference',
        type: 0,
        type_name: 'string',
        possible_values: '',
        default_value: '',
        required: 0,
        enabled_on_design: 1,
        value: opts.ref ?? null,
      },
    },
  };
}

const cases = [
  tc(100, 10, { auto: true, automationStatus: 'Done', ref: 'Functionize: https://app.functionize.com/test/1' }),
  tc(101, 10, { automationStatus: 'N/A' }),
  tc(102, 11, { auto: true }),
  tc(103, 12, { auto: true, automationStatus: 'Done', active: 0 }),
  tc(104, 20, { automationStatus: 'To Do', keywords: { '3': 'smoke' } }),
];
const tree = new SuiteTree(suites, cases);
const all = () => tree.collect(null, true, { names: [], ids: [] });
const ids = (body: any) => body.items.map((i: any) => i.id);

describe('TestLink query layer', () => {
  it('without its parameters answers items only, in tree order; empty values count as not given', () => {
    const q = parseCaseQuery({ executionType: '', groupBy: '', cfFilters: ' ' }, 'project');
    expect(q.engaged).toBe(false);
    const body = runCaseQuery(all(), q, projectCaseItem);
    expect(Object.keys(body)).toEqual(['items']);
    expect(ids(body)).toEqual([100, 101, 102, 103, 104]);
  });

  it('filters are ANDed: execution type, active, status, importance, keywords and custom fields', () => {
    const run = (params: Record<string, string>) => ids(runCaseQuery(all(), parseCaseQuery(params, 'project'), projectCaseItem));
    expect(run({ executionType: '2' })).toEqual([100, 102, 103]);
    expect(run({ executionType: '2', active: '1' })).toEqual([100, 102]);
    expect(run({ status: '5' })).toEqual([103]);
    expect(run({ importance: '3' })).toEqual([]);
    expect(run({ keyword: 'nightly, SMOKE' })).toEqual([104]);
    expect(run({ cfFilters: '[{"name":"automationStatus","value":"done"}]' })).toEqual([100, 103]);
    // By label, ignoring case; exists, contains and regex.
    expect(run({ cfFilters: '[{"name":"automation status","match":"exists"}]' })).toEqual([100, 101, 103, 104]);
    expect(run({ cfFilters: '[{"name":"automationReference","value":"FUNCTIONIZE","match":"contains"}]' })).toEqual([100]);
    expect(run({ cfFilters: '[{"name":"automationStatus","value":"^(to do|n/a)$","match":"regex"}]' })).toEqual([101, 104]);
    expect(run({ cfFilters: '[{"name":"automationStatus","value":"Done"},{"name":"automationReference","match":"exists"}]' })).toEqual([100]);
  });

  it('excludes a suite and its subtree below the roots, but never a root', () => {
    expect(tree.collect(null, true, { names: ['auth'], ids: [] }).map((c) => c.id)).toEqual([104]);
    expect(tree.collect([10], true, { names: ['auth', 'deprecated'], ids: [] }).map((c) => c.id)).toEqual([100, 101, 102]);
    expect(tree.collect([10], false, { names: [], ids: [] }).map((c) => c.id)).toEqual([100, 101]);
    // Overlapping roots count each case once.
    expect(tree.collect([10, 11], true, { names: [], ids: [12] }).map((c) => c.id)).toEqual([100, 101, 102]);
  });

  it('pages by case id with total, returned, offset and has_more; countOnly; fields; cfCompact', () => {
    const page = runCaseQuery(all(), parseCaseQuery({ limit: '2', offset: '1' }, 'project'), projectCaseItem);
    expect(page).toMatchObject({ total: 5, returned: 2, offset: 1, has_more: true });
    expect(ids(page)).toEqual([101, 102]);
    expect(runCaseQuery(all(), parseCaseQuery({ countOnly: '1', executionType: '2' }, 'project'), projectCaseItem)).toEqual({ total: 3 });

    const projected = runCaseQuery(all(), parseCaseQuery({ fields: 'id,external_id,tsuite_name,path,customfields', cfCompact: '1', limit: '1' }, 'project'), projectCaseItem);
    expect(projected.items).toEqual([
      { id: 100, external_id: 'MA-1', tsuite_name: 'Auth', path: 'Auth', customfields: { automationStatus: 'Done', automationReference: 'Functionize: https://app.functionize.com/test/1' } },
    ]);
  });

  it('groups by execution type and a custom field, unset apart from N/A', () => {
    const body = runCaseQuery(all(), parseCaseQuery({ groupBy: 'executionType,cf:automationStatus' }, 'project'), projectCaseItem);
    expect(body.total).toBe(5);
    expect(body.groups).toEqual([
      { executionType: 2, automationStatus: 'Done', count: 2 },
      { executionType: 1, automationStatus: 'N/A', count: 1 },
      { executionType: 1, automationStatus: 'To Do', count: 1 },
      { executionType: 2, automationStatus: 'unset', count: 1 },
    ]);
    expect(runCaseQuery(all(), parseCaseQuery({ groupBy: 'suite', active: '1' }, 'project'), projectCaseItem).groups).toEqual([
      { suite_id: 10, suite: 'Auth', count: 2 },
      { suite_id: 11, suite: 'Login', count: 1 },
      { suite_id: 20, suite: 'Billing', count: 1 },
    ]);
  });

  it('stops a page at about 1 MB, saying there is more', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ ...tc(100, 10), id: 1000 + i, summary: 'x'.repeat(50_000) }));
    const body: any = runCaseQuery(big, parseCaseQuery({ limit: '0', nosteps: '1' }, 'project'), projectCaseItem);
    expect(body.returned).toBeLessThan(30);
    expect(body.returned).toBeGreaterThan(10);
    expect(body.has_more).toBe(true);
    expect(JSON.stringify(body.items).length).toBeLessThanOrEqual(RESPONSE_SIZE_CAP_BYTES);
  });

  it("a suite's list keeps cfName/cfValue/cfMatch (contains by default), customfields=1 and nosteps", () => {
    const q = parseCaseQuery({ cfName: 'Automation Reference', cfValue: 'functionize' }, 'suite');
    expect(q.engaged).toBe(false);
    const body: any = runCaseQuery(tree.collect([10], false, q.exclusions), q, suiteCaseItem);
    expect(ids(body)).toEqual([100]);
    expect(body.items[0]).toMatchObject({ parent_id: 10, tsuite_name: 'Auth', customfields: { '8': { name: 'automationReference', value: expect.stringContaining('Functionize') } } });
    expect(body.items[0].steps).toHaveLength(1);

    const plain: any = runCaseQuery(tree.collect([10], false, q.exclusions), parseCaseQuery({ nosteps: '1' }, 'suite'), suiteCaseItem);
    expect(plain.items[0]).not.toHaveProperty('steps');
    expect(plain.items[0]).not.toHaveProperty('customfields');
    // nosteps alone doesn't engage the layer on a suite's list; it does on a project's.
    expect(Object.keys(plain)).toEqual(['items']);
    expect(parseCaseQuery({ nosteps: '1' }, 'project').engaged).toBe(true);
  });

  it('refuses bad parameters with a message', () => {
    for (const params of [
      { executionType: '3' },
      { active: 'yes' },
      { limit: '-1' },
      { cfFilters: 'not json' },
      { cfFilters: '[{"value":"x"}]' },
      { cfFilters: '[{"name":"a","match":"like"}]' },
      { cfFilters: '[{"name":"a","value":"(","match":"regex"}]' },
      { groupBy: 'colour' },
      { suiteIds: '1,abc' },
    ]) {
      expect(() => parseCaseQuery(params, 'project'), JSON.stringify(params)).toThrow(TestLinkQueryError);
    }
  });

  it('a regex that runs too long is refused, not left running', () => {
    const slow = [{ ...tc(100, 10), customfields: { ...tc(100, 10).customfields, '8': { ...tc(100, 10).customfields['8'], value: 'a'.repeat(30) + '!' } } }];
    const q = parseCaseQuery({ cfFilters: JSON.stringify([{ name: 'automationReference', value: '^(a+)+$', match: 'regex' }]) }, 'project');
    expect(() => runCaseQuery(slow, q, projectCaseItem)).toThrow(/took too long/);
  });
});

describe('TestLink suite tree', () => {
  it('nests suites; with meta adds path, depth and counts; excluded suites count 0', () => {
    expect(suiteTreeItems(tree, parseSuiteTreeQuery({}))).toEqual([
      {
        type: 'testsuite',
        id: 10,
        name: 'Auth',
        parent_id: 1,
        node_order: 1,
        children: [
          { type: 'testsuite', id: 11, name: 'Login', parent_id: 10, node_order: 1, children: [] },
          { type: 'testsuite', id: 12, name: 'Deprecated', parent_id: 10, node_order: 2, children: [] },
        ],
      },
      { type: 'testsuite', id: 20, name: 'Billing', parent_id: 1, node_order: 2, children: [] },
    ]);
    const meta: any[] = suiteTreeItems(tree, parseSuiteTreeQuery({ excludeSuiteNames: 'Deprecated' }));
    expect(meta[0]).toMatchObject({ path: 'Auth', depth: 0, testcaseCount: { direct: 2, deep: 3 } });
    expect(meta[0].children[1]).toMatchObject({ path: 'Auth / Deprecated', depth: 1, testcaseCount: { direct: 0, deep: 0 } });
    const active: any[] = suiteTreeItems(tree, parseSuiteTreeQuery({ activeOnly: '1' }));
    expect(active[0].testcaseCount).toEqual({ direct: 2, deep: 3 });
  });

  it('finds suites by name as a flat list', () => {
    expect(suiteTreeItems(tree, parseSuiteTreeQuery({ name: 'deprecated' }))).toEqual([
      { type: 'testsuite', id: 12, name: 'Deprecated', parent_id: 10, node_order: 2, path: 'Auth / Deprecated', depth: 1, testcaseCount: { direct: 1, deep: 1 } },
    ]);
    expect(suiteTreeItems(tree, parseSuiteTreeQuery({ name: 'IN', match: 'contains' })).map((s: any) => s.id)).toEqual([11, 20]);
    expect(suiteTreeItems(tree, parseSuiteTreeQuery({ name: '^(auth|billing)$', match: 'regex' })).map((s: any) => s.id)).toEqual([10, 20]);
  });

  it('shows a spec case with its type and suite', () => {
    expect(specCaseItem(cases[2])).toMatchObject({ type: 'testcase', id: 102, parent_suite_id: 11, external_id: 'MA-3', tc_external_id: '3', tcversion_id: 1102 });
  });
});

describe('TestLink value mapping', () => {
  it('maps importance, execution type, statuses and flags', () => {
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'P1', 'P2', 'P3', 'P4'].map(importanceCode)).toEqual([1, 2, 3, 3, 3, 2, 1, 1]);
    expect([executionTypeCode('MANUAL'), executionTypeCode('AUTOMATED')]).toEqual([1, 2]);
    expect(['DRAFT', 'APPROVED', 'DEPRECATED'].map(versionStatusCodes)).toEqual([
      { status: 1, active: 1 },
      { status: 7, active: 1 },
      { status: 5, active: 0 },
    ]);
    expect(['ACTIVE', 'LOCKED', 'ARCHIVED'].map(planFlags)).toEqual([
      { active: 1, is_open: 1 },
      { active: 1, is_open: 0 },
      { active: 0, is_open: 0 },
    ]);
    expect([buildFlags('OPEN'), buildFlags('CLOSED')]).toEqual([
      { active: 1, is_open: 1 },
      { active: 1, is_open: 0 },
    ]);
  });

  it("shows custom fields as TestLink's types and stored strings", () => {
    expect(customFieldTypeCode('SINGLE_SELECT')).toEqual({ type: 6, type_name: 'list' });
    expect(customFieldTypeCode('MULTI_SELECT')).toEqual({ type: 7, type_name: 'multiselection list' });
    expect(customFieldValueString('MULTI_SELECT', ['a', 'b'])).toBe('a|b');
    expect(customFieldValueString('MULTI_SELECT', [])).toBeNull();
    expect(customFieldValueString('NUMBER', 2.5)).toBe('2.5');
    expect(customFieldValueString('CHECKBOX', false)).toBe('0');
    expect(customFieldValueString('TEXT', null)).toBeNull();
    expect([externalIdNumber('MA-12'), externalIdNumber('LEGACY')]).toEqual(['12', 'LEGACY']);
  });

  it("reads TestLink's values back: importance, execution type, status and active, custom field strings", () => {
    expect([1, 2, 3, '3', 4, undefined].map(priorityFromImportance)).toEqual(['LOW', 'MEDIUM', 'HIGH', 'HIGH', undefined, undefined]);
    expect([1, 2, '2', 0].map(executionTypeFromCode)).toEqual(['MANUAL', 'AUTOMATED', 'AUTOMATED', undefined]);
    expect(statusTarget(7, undefined)).toEqual({ target: 'APPROVED', reactivate: false });
    expect(statusTarget(5, 1)).toEqual({ target: 'DEPRECATED', reactivate: false });
    expect(statusTarget(7, 0)).toEqual({ target: 'DEPRECATED', reactivate: false });
    expect([1, 2, 3, 4, 6].map((s) => statusTarget(s, undefined).target)).toEqual(['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT']);
    expect(statusTarget(undefined, 1)).toEqual({ reactivate: true });
    expect(statusTarget('', '')).toEqual({ reactivate: false });

    expect(customFieldValueFromString('MULTI_SELECT', 'a| b |')).toEqual(['a', 'b']);
    expect(customFieldValueFromString('MULTI_SELECT', ['x'])).toEqual(['x']);
    expect(customFieldValueFromString('NUMBER', '5')).toBe(5);
    expect(customFieldValueFromString('NUMBER', 'five')).toBe('five');
    expect(['1', 'Yes', '0', 'off'].map((v) => customFieldValueFromString('CHECKBOX', v))).toEqual([true, true, false, false]);
    expect(customFieldValueFromString('DATE', '1780272000')).toBe('2026-06-01');
    expect(customFieldValueFromString('DATE', '2026-06-01')).toBe('2026-06-01');
    expect(customFieldValueFromString('TEXT', '  ')).toBeNull();
  });

  it('keys a keyword by its field and text, so its id outlives the option row', () => {
    const key = keywordKey('field-1', 'smoke');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(keywordKey('field-1', 'smoke')).toBe(key);
    expect(new Set([key, keywordKey('field-2', 'smoke'), keywordKey('field-1', 'Smoke')]).size).toBe(3);
  });
});
