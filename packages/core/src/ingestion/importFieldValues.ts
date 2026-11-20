import type { ParsedCase, ParsedSuite } from './types.js';
import { MAX_DB_INTEGER, MAX_NAME_LENGTH, withoutNul } from '../limits/index.js';

/** Splits one cell of a multi-select column ("UI, API, Slow") into its options -- trimmed,
 * empties dropped, duplicates removed, order kept. */
export function splitMultiSelectValue(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * The options a new SINGLE_SELECT / MULTI_SELECT field created during import should have:
 * every distinct non-empty value the file holds for that column (case-insensitive key
 * match), in first-seen order. SINGLE_SELECT uses each whole value as one option;
 * MULTI_SELECT splits each value on commas first.
 */
export function collectImportFieldOptions(
  suites: ParsedSuite[],
  incomingKey: string,
  fieldType: 'SINGLE_SELECT' | 'MULTI_SELECT'
): string[] {
  const key = incomingKey.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: string) => {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const walk = (list: ParsedSuite[]) => {
    for (const suite of list) {
      for (const tc of suite.test_cases || []) {
        for (const [k, raw] of Object.entries(tc.custom_fields || {})) {
          if (k.toLowerCase() !== key || raw === null || raw === undefined) continue;
          const value = String(raw).trim();
          if (!value) continue;
          if (fieldType === 'MULTI_SELECT') splitMultiSelectValue(value).forEach(add);
          else add(value);
        }
      }
      walk(suite.sub_suites || []);
    }
  };
  walk(suites);
  return out;
}

/**
 * The number in a value imported into a NUMBER field: "Sprint 34" → 34, "2.5 hrs" → 2.5,
 * "-3" → -3. The first number in the text wins, and the text around it is dropped. A minus
 * counts only at the start or after a space, so "Sprint-34" is 34. null when there's no number.
 */
export function numberFromText(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /(^|\s)?(-?)(\d+(?:\.\d+)?)/.exec(value);
  if (!match) return null;
  const negative = match[2] === '-' && (match.index === 0 || match[1] !== undefined);
  const n = Number(match[3]);
  return negative ? -n : n;
}

/**
 * The value of a CHECKBOX field from imported text: "yes", "true" and "1" are ticked, "no",
 * "false" and "0" aren't (any case, spaces around ignored), which are the values the field-type
 * guess (inferFieldType) reads as a checkbox. null for anything else.
 */
export function checkboxFromText(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return true;
  if (v === 'no' || v === 'false' || v === '0') return false;
  return null;
}

/**
 * A case id from an import file as this project's id: the project's prefix and the file's
 * number. "331" (TestLink exports the number alone), "CON-331" and "OLD-331" all become
 * "CON-331" in a project whose prefix is CON. Anything else (TestRail's "C501", ids with more
 * than one dash) is kept as written.
 */
export function projectCaseId(raw: string | undefined, prefix: string): string | undefined {
  const id = raw?.trim();
  if (!id) return undefined;
  const match = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d+)$/.exec(id);
  return match ? `${prefix}-${Number(match[1])}` : id;
}

/** Rewrites every case's external_id in the parsed tree with projectCaseId. */
export function applyProjectCaseIds(suites: ParsedSuite[], prefix: string): void {
  for (const suite of suites) {
    for (const tc of suite.test_cases || []) tc.external_id = projectCaseId(tc.external_id, prefix);
    applyProjectCaseIds(suite.sub_suites || [], prefix);
  }
}

/** The longest case id the database holds (test_cases.external_id is varchar(100)). */
export const MAX_CASE_ID_LENGTH = 100;

/**
 * The parsed tree as it can be stored: NUL characters removed from all its text (another tool's
 * file may carry them, and PostgreSQL text can't), suite names and case titles cut to 255
 * characters, a case id too long to keep dropped with a CASE_ID_TOO_LONG warning (the case then
 * gets the next PREFIX-n), and a suite order that isn't a storable whole number set to 0. Any of
 * these used to fail the whole import with a 500.
 */
export function storableSuites(suites: ParsedSuite[]): ParsedSuite[] {
  return withoutNul(suites).map(storableSuite);
}

function storableSuite(suite: ParsedSuite): ParsedSuite {
  return {
    ...suite,
    name: cut(suite.name),
    node_order: Number.isInteger(suite.node_order) && Math.abs(suite.node_order) <= MAX_DB_INTEGER ? suite.node_order : 0,
    sub_suites: (suite.sub_suites || []).map(storableSuite),
    test_cases: (suite.test_cases || []).map(storableCase),
  };
}

function storableCase(tc: ParsedCase): ParsedCase {
  const idTooLong = (tc.external_id?.trim().length ?? 0) > MAX_CASE_ID_LENGTH;
  return {
    ...tc,
    title: cut(tc.title),
    ...(idTooLong ? { external_id: undefined, parser_warnings: [...(tc.parser_warnings || []), 'CASE_ID_TOO_LONG'] } : {}),
  };
}

const cut = (text: string) => (typeof text === 'string' && text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH).trimEnd() : text);
