import { describe, it, expect } from 'vitest';
import {
  tessickRoleFor,
  customFieldTypeFromTestLink,
  optionsFrom,
  versionStatusFromTestLink,
  planStatusFromTestLink,
  verdictFromTestLink,
  stepVerdictFromTestLink,
  customFieldValueFromTestLink,
  isoTimestamp,
  wallDate,
  isTimeZone,
} from '../src/testlink/index.js';

/** How the migration from TestLink's database reads TestLink's values. */
describe('TestLink migration mapping', () => {
  it('gives each TestLink role the Tessick role its rights call for', () => {
    expect(tessickRoleFor('admin', [])).toBe('Admin');
    expect(tessickRoleFor('custom', ['mgt_users'])).toBe('Admin');
    expect(tessickRoleFor('leader', ['testplan_planning', 'mgt_view_tc'])).toBe('Test Lead');
    expect(tessickRoleFor('tester', ['testplan_execute', 'mgt_view_tc'])).toBe('Tester');
    expect(tessickRoleFor('test designer', ['mgt_modify_tc'])).toBe('Tester');
    expect(tessickRoleFor('guest', ['mgt_view_tc'])).toBe('Viewer');
    expect(tessickRoleFor('<no rights>', [])).toBe('No Access');
  });

  it("maps TestLink's twelve custom field types to Tessick's six, saying when it isn't exact", () => {
    expect([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 20, 500].map((t) => customFieldTypeFromTestLink(t).field_type)).toEqual([
      'TEXT', 'NUMBER', 'NUMBER', 'TEXT', 'MULTI_SELECT', 'SINGLE_SELECT', 'MULTI_SELECT', 'DATE', 'SINGLE_SELECT', 'DATE', 'TEXT', 'TEXT',
    ]);
    expect([0, 1, 6, 7, 8].every((t) => customFieldTypeFromTestLink(t).exact)).toBe(true);
    expect([2, 4, 5, 9, 10, 20].some((t) => customFieldTypeFromTestLink(t).exact)).toBe(false);
    expect(optionsFrom(' a|b||a| c ')).toEqual(['a', 'b', 'c']);
  });

  it('maps statuses, plan flags and verdicts', () => {
    expect([1, 2, 3, 4, 6].map((s) => versionStatusFromTestLink(s, 1))).toEqual(['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT']);
    expect([versionStatusFromTestLink(7, 1), versionStatusFromTestLink(5, 1), versionStatusFromTestLink(7, 0)]).toEqual(['APPROVED', 'DEPRECATED', 'DEPRECATED']);
    expect([planStatusFromTestLink(1, 1), planStatusFromTestLink(1, 0), planStatusFromTestLink(0, 1)]).toEqual(['ACTIVE', 'LOCKED', 'ARCHIVED']);
    expect(['p', 'F', ' b ', 'n', 'x', null].map(verdictFromTestLink)).toEqual(['PASSED', 'FAILED', 'BLOCKED', undefined, undefined, undefined]);
    expect(['p', 'n'].map(stepVerdictFromTestLink)).toEqual(['PASSED', 'UNTESTED']);
  });

  it('reads stored custom field values: lists, numbers, dates kept as timestamps', () => {
    expect(customFieldValueFromTestLink('MULTI_SELECT', 'a|b')).toEqual(['a', 'b']);
    expect(customFieldValueFromTestLink('NUMBER', '2.50')).toBe(2.5);
    expect(customFieldValueFromTestLink('DATE', '1780272000')).toBe('2026-06-01');
    expect(customFieldValueFromTestLink('TEXT', '')).toBeNull();
  });

  it("reads TestLink's zoneless times in TestLink's zone, from text or a driver's Date", () => {
    expect(isoTimestamp('2024-06-02 10:00:00')).toBe('2024-06-02T10:00:00.000Z');
    expect(isoTimestamp('2024-06-02 10:00:00', 'America/Chicago')).toBe('2024-06-02T15:00:00.000Z'); // CDT
    expect(isoTimestamp('2024-01-02 10:00:00', 'America/Chicago')).toBe('2024-01-02T16:00:00.000Z'); // CST
    expect(isoTimestamp('2024-06-02 10:00:00', 'Australia/Sydney')).toBe('2024-06-02T00:00:00.000Z');
    // A Date made from the wall time in this machine's zone reads back as that wall time.
    expect(isoTimestamp(new Date(2024, 5, 2, 10, 0, 0))).toBe('2024-06-02T10:00:00.000Z');
    expect(isoTimestamp('2024-06-02T10:00:00+02:00')).toBe('2024-06-02T08:00:00.000Z');
    expect([isoTimestamp(null), isoTimestamp('soon')]).toEqual([undefined, undefined]);

    expect(wallDate('2024-06-01')).toBe('2024-06-01');
    expect(wallDate(new Date(2024, 5, 1))).toBe('2024-06-01');
    expect(wallDate(new Date(Date.UTC(2024, 5, 1)))).toBe('2024-06-01');
    expect([isTimeZone('Europe/London'), isTimeZone('Mars/Olympus')]).toEqual([true, false]);
  });
});
