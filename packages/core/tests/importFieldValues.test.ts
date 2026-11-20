import { describe, it, expect } from 'vitest';
import { collectImportFieldOptions, splitMultiSelectValue, numberFromText, checkboxFromText, projectCaseId, applyProjectCaseIds, type ParsedSuite } from '../src/index.js';

const suite = (cases: Array<Record<string, string>>, sub: ParsedSuite[] = []): ParsedSuite => ({
  name: 'S',
  node_order: 1,
  sub_suites: sub,
  test_cases: cases.map((cf, i) => ({ title: `c${i}`, custom_fields: cf }) as any),
});

describe('import field options', () => {
  it('splitMultiSelectValue trims, drops empties and duplicates, keeps order', () => {
    expect(splitMultiSelectValue(' ui, api ,, ui,slow ')).toEqual(['ui', 'api', 'slow']);
    expect(splitMultiSelectValue('')).toEqual([]);
  });

  it('collects distinct whole values for SINGLE_SELECT across sub-suites, case-insensitive key', () => {
    const tree = [suite([{ Status: 'N/A' }, { status: 'Done' }], [suite([{ STATUS: 'Done' }, { status: ' To Do ' }, { other: 'x' }])])];
    expect(collectImportFieldOptions(tree, 'status', 'SINGLE_SELECT')).toEqual(['N/A', 'Done', 'To Do']);
  });

  it('splits comma-separated values for MULTI_SELECT', () => {
    const tree = [suite([{ tags: 'ui, api' }, { tags: 'api,slow' }, { tags: '' }])];
    expect(collectImportFieldOptions(tree, 'tags', 'MULTI_SELECT')).toEqual(['ui', 'api', 'slow']);
  });
});

describe('numbers for NUMBER fields', () => {
  it('keeps the first number and drops the text around it', () => {
    expect(numberFromText('Sprint 34')).toBe(34);
    expect(numberFromText('2.5 hrs')).toBe(2.5);
    expect(numberFromText('34')).toBe(34);
    expect(numberFromText(' 7 ')).toBe(7);
    expect(numberFromText('v2 of 3')).toBe(2);
    expect(numberFromText(12)).toBe(12);
  });

  it('reads a minus only at the start or after a space', () => {
    expect(numberFromText('-3')).toBe(-3);
    expect(numberFromText('delta -7 points')).toBe(-7);
    expect(numberFromText('Sprint-34')).toBe(34);
  });

  it('gives null when there is no number', () => {
    for (const v of ['none', '', 'N/A', null, undefined, true]) expect(numberFromText(v)).toBeNull();
  });
});

describe('ticks for CHECKBOX fields', () => {
  it('reads yes/no, true/false and 1/0, in any case', () => {
    for (const v of ['Yes', 'yes', ' TRUE ', '1', 1, true]) expect(checkboxFromText(v)).toBe(true);
    for (const v of ['No', 'no', 'False', '0', 0, false]) expect(checkboxFromText(v)).toBe(false);
  });

  it('gives null for anything else', () => {
    for (const v of ['maybe', '', 'N/A', '2', 2, null, undefined]) expect(checkboxFromText(v)).toBeNull();
  });
});

describe("case ids under the project's prefix", () => {
  it('keeps the number and uses the prefix', () => {
    expect(projectCaseId('331', 'CON')).toBe('CON-331');
    expect(projectCaseId('CON-331', 'CON')).toBe('CON-331');
    expect(projectCaseId('con-145', 'CON')).toBe('CON-145');
    expect(projectCaseId('OLD-12', 'CON')).toBe('CON-12');
    expect(projectCaseId(' 0042 ', 'CON')).toBe('CON-42');
  });

  it('keeps any other id as written, and an empty one empty', () => {
    expect(projectCaseId('C501', 'TR')).toBe('C501');
    expect(projectCaseId('TC-AUTH-1', 'CON')).toBe('TC-AUTH-1');
    expect(projectCaseId('', 'CON')).toBeUndefined();
    expect(projectCaseId(undefined, 'CON')).toBeUndefined();
  });

  it('rewrites every case in a parsed tree, sub-suites included', () => {
    const node = (name: string, cases: Array<{ title: string; external_id?: string }>, sub: ParsedSuite[] = []): ParsedSuite =>
      ({ name, node_order: 1, sub_suites: sub, test_cases: cases }) as any;
    const suites = [node('Top', [{ title: 'a', external_id: '1' }], [node('Sub', [{ title: 'b', external_id: 'CON-2' }, { title: 'c' }])])];
    applyProjectCaseIds(suites, 'NEW');
    expect(suites[0].test_cases[0].external_id).toBe('NEW-1');
    expect(suites[0].sub_suites[0].test_cases.map((c) => c.external_id)).toEqual(['NEW-2', undefined]);
  });
});
