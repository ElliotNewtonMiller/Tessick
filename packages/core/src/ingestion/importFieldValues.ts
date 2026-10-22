import type { ParsedSuite } from './types.js';

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
