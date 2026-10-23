import { describe, it, expect } from 'vitest';
import { hasNul, nulFields, withoutNul, storableSuites, MAX_DB_INTEGER, parseJUnitResults, type ParsedSuite } from '../src/index.js';

const NUL = '\u0000';

describe('NUL characters', () => {
  it('finds them by field name, in nested objects, lists and keys', () => {
    expect(nulFields({ title: 'ok', steps: [{ action: 'fine' }, { action: `a${NUL}` }], meta: { [`k${NUL}`]: 'v' } })).toEqual(['steps[1].action', 'meta']);
    expect(nulFields(`x${NUL}`)).toEqual(['value']);
    expect(nulFields({ n: 1, b: true, nothing: null })).toEqual([]);
    expect(hasNul('plain')).toBe(false);
  });

  it('looks inside a parsed query string, whose prototype is not Object', () => {
    const Empty = function () {} as unknown as { new (): Record<string, unknown> };
    (Empty as any).prototype = Object.create(null);
    const query = new Empty();
    query.q = `a${NUL}b`;
    expect(nulFields(query)).toEqual(['q']);
    expect(withoutNul(query)).toEqual({ q: 'ab' });
  });

  it('removes them deeply, keys included, leaving other values alone', () => {
    const date = new Date(0);
    expect(withoutNul({ a: `x${NUL}y`, list: [`${NUL}1`, 2], [`k${NUL}`]: null, date })).toEqual({ a: 'xy', list: ['1', 2], k: null, date });
  });
});

describe('storableSuites', () => {
  const tree = (): ParsedSuite[] => [
    {
      name: `Sui${NUL}te`,
      node_order: 1e12,
      sub_suites: [{ name: 'n'.repeat(300), node_order: 2, sub_suites: [], test_cases: [] }],
      test_cases: [
        { external_id: 'X'.repeat(101), title: 't'.repeat(260), importance: 'MEDIUM', execution_type: 'MANUAL', steps: [], custom_fields: { [`f${NUL}`]: `v${NUL}` } },
        { external_id: 'CON-1', title: 'Kept', importance: 'MEDIUM', execution_type: 'MANUAL', steps: [], custom_fields: {} },
      ],
    },
  ];

  it('cuts names to 255, drops an id over 100 with a warning, resets an unstorable order and removes NULs', () => {
    const [top] = storableSuites(tree());
    expect(top.name).toBe('Suite');
    expect(top.node_order).toBe(0);
    expect(top.sub_suites[0]).toMatchObject({ name: 'n'.repeat(255), node_order: 2 });
    expect(top.test_cases[0]).toMatchObject({ external_id: undefined, title: 't'.repeat(255), parser_warnings: ['CASE_ID_TOO_LONG'], custom_fields: { f: 'v' } });
    expect(top.test_cases[1]).toMatchObject({ external_id: 'CON-1', title: 'Kept' });
    expect(top.test_cases[1].parser_warnings).toBeUndefined();
  });

  it('leaves the parsed tree it was given alone', () => {
    const original = tree();
    storableSuites(original);
    expect(original[0].name).toBe(`Sui${NUL}te`);
  });
});

describe('JUnit durations', () => {
  it('drops a time the database cannot store (over about 24 days, e.g. milliseconds sent as seconds)', () => {
    const tests = parseJUnitResults(`<testsuite name="s">
      <testcase name="a" time="2147483.647"/>
      <testcase name="b" time="2147483.648"/>
      <testcase name="c" time="1e12"/>
    </testsuite>`);
    expect(tests.map((t) => t.duration_ms)).toEqual([MAX_DB_INTEGER, null, null]);
  });
});
