import { describe, it, expect } from 'vitest';
import {
  buildSuiteNodes,
  expandableSuiteIds,
  findSuiteNode,
  flattenSuiteOptions,
  ownPlanCountsBySuite,
  pruneSuiteTree,
  rangeBetween,
  suiteCountText,
  suiteInfoById,
  suitesContaining,
  visibleSuiteOrder,
  withAllSuitesExpanded,
  withSubtreeTotals,
} from '../utils/suiteTree';
import type { SpecSuiteNode } from '../types';

const node = (id: string, children: SpecSuiteNode[] = [], parent: string | null = null): SpecSuiteNode => ({
  id, name: id.toUpperCase(), path: `/${id}`, parent_suite_id: parent, children, total_case_count: 2, in_plan_count: 1,
});
// a
// ├─ a1
// │  └─ a1x
// └─ a2
// b
const TREE = [node('a', [node('a1', [node('a1x', [], 'a1')], 'a'), node('a2', [], 'a')]), node('b')];

describe('suiteTree', () => {
  it('pruneSuiteTree keeps only the given suites', () => {
    const pruned = pruneSuiteTree(TREE, new Set(['a', 'a2']));
    expect(pruned.map((n) => n.id)).toEqual(['a']);
    expect(pruned[0].children.map((n) => n.id)).toEqual(['a2']);
  });

  it('suitesContaining keeps the suites holding cases and every suite above them', () => {
    expect([...suitesContaining(TREE, new Set(['a1x']))].sort()).toEqual(['a', 'a1', 'a1x']);
    expect([...suitesContaining(TREE, new Set(['a2', 'b']))].sort()).toEqual(['a', 'a2', 'b']);
    expect(suitesContaining(TREE, new Set()).size).toBe(0);
    // Pruned with it, Execute mode's tree drops the suites without the plan's cases.
    const pruned = pruneSuiteTree(TREE, suitesContaining(TREE, new Set(['a1x'])));
    expect(pruned.map((n) => n.id)).toEqual(['a']);
    expect(pruned[0].children.map((n) => n.id)).toEqual(['a1']);
    expect(pruned[0].children[0].children.map((n) => n.id)).toEqual(['a1x']);
  });

  it('buildSuiteNodes carries counts and Execute-mode results per suite', () => {
    const built = buildSuiteNodes(TREE, { execOwn: new Map([['a1', { passed: 1, total: 3 }]]) });
    expect(built[0]).toMatchObject({ id: 'a', name: 'A', parentId: null, passedCount: 0, totalCount: 0, inPlanCount: 1, totalCaseCount: 2 });
    expect(built[0].children?.[0]).toMatchObject({ id: 'a1', parentId: 'a', passedCount: 1, totalCount: 3 });
  });

  it("counts each suite's own cases, and adds up the sub-suites' over the whole tree", () => {
    const own = ownPlanCountsBySuite([
      { test_suite_id: 'a', in_plan: true },
      { test_suite_id: 'a', in_plan: false },
      { test_suite_id: 'a1x', in_plan: true },
      { test_suite_id: 'a2', in_plan: false },
    ]);
    expect(Object.fromEntries(own)).toEqual({ a: { count: 1, total: 2 }, a1x: { count: 1, total: 1 }, a2: { count: 0, total: 1 } });
    // a1 holds no cases itself, but its sub-suite does; b has nothing anywhere.
    expect(Object.fromEntries(withSubtreeTotals(TREE, own))).toEqual({
      a: { count: 2, total: 4 },
      a1: { count: 1, total: 1 },
      a1x: { count: 1, total: 1 },
      a2: { count: 0, total: 1 },
    });

    const built = buildSuiteNodes(TREE, {
      specOwn: own,
      execOwn: new Map([['a1x', { passed: 1, total: 1 }]]),
      execWhole: withSubtreeTotals(TREE, new Map([['a1x', { count: 1, total: 1 }]])),
    });
    expect(built[0]).toMatchObject({ ownInPlanCount: 1, ownCaseCount: 2, passedCount: 0, totalCount: 0, subtreePassedCount: 1, subtreeTotalCount: 1 });
    expect(built[1]).toMatchObject({ ownInPlanCount: 0, ownCaseCount: 0, subtreeTotalCount: 0 });
  });

  it("shows a suite's own count, then the whole suite's when its sub-suites hold cases", () => {
    // A suite without sub-suites with cases: one count.
    expect(suiteCountText('PLAN', { count: 1, total: 6 }, { count: 1, total: 6 })).toEqual({ own: '1/6', whole: null, title: 'Cases: 1 of 6 in the plan' });
    // Its own cases, then everything in it.
    expect(suiteCountText('PLAN', { count: 1, total: 4 }, { count: 76, total: 196 })).toEqual({
      own: '1/4',
      whole: '76/196',
      title: 'Its own cases: 1 of 4 in the plan\nWith its sub-suites: 76 of 196 in the plan',
    });
    // None of its own.
    expect(suiteCountText('PLAN', { count: 0, total: 0 }, { count: 2, total: 20 })).toMatchObject({ own: '—', whole: '2/20' });
    expect(suiteCountText('PLAN', { count: 0, total: 0 }, { count: 2, total: 20 })?.title).toContain('Its own cases: none');
    // No plan chosen: cases only.
    expect(suiteCountText('CASES', { count: 0, total: 4 }, { count: 0, total: 40 })).toMatchObject({ own: '4', whole: '40' });
    // Execute mode: "P" on the last part.
    expect(suiteCountText('PASSED', { count: 2, total: 3 }, { count: 2, total: 3 })).toMatchObject({ own: '2/3 P', whole: null });
    expect(suiteCountText('PASSED', { count: 0, total: 0 }, { count: 5, total: 9 })).toMatchObject({ own: '—', whole: '5/9 P' });
    // Nothing anywhere: no count.
    expect(suiteCountText('PLAN', { count: 0, total: 0 }, { count: 0, total: 0 })).toBeNull();
  });

  it('lists expandable suites, and visible order honours collapsed suites', () => {
    const built = buildSuiteNodes(TREE);
    expect(expandableSuiteIds(built)).toEqual(['a', 'a1']);
    expect(visibleSuiteOrder(built, {})).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
    expect(visibleSuiteOrder(built, { a1: false })).toEqual(['a', 'a1', 'a2', 'b']);
    expect(visibleSuiteOrder(built, { a: false })).toEqual(['a', 'b']);
  });

  it('collapses or expands every suite with sub-suites, keeping other entries', () => {
    const built = buildSuiteNodes(TREE);
    expect(withAllSuitesExpanded({ other: true }, built, false)).toEqual({ other: true, a: false, a1: false });
    expect(withAllSuitesExpanded({ a: false, a1: false }, built, true)).toEqual({ a: true, a1: true });
    expect(visibleSuiteOrder(built, withAllSuitesExpanded({}, built, false))).toEqual(['a', 'b']);
  });

  it('finds suites and flattens them into indented options', () => {
    expect(findSuiteNode(TREE, 'a1x')?.name).toBe('A1X');
    expect(findSuiteNode(TREE, 'nope')).toBeNull();
    expect(suiteInfoById(TREE).get('a2')).toEqual({ path: '/a2', name: 'A2' });
    expect(flattenSuiteOptions(buildSuiteNodes(TREE)).map((o) => o.label)).toEqual([' A', '— A1', '—— A1X', '— A2', ' B']);
  });

  it('rangeBetween spans either direction, or just the target if an end is unknown', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'x', 'c')).toEqual(['c']);
  });
});
