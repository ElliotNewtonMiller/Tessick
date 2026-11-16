import { TL_LIST_SEPARATOR, TL_STATUS } from './map.js';

/**
 * How the migration from TestLink's database (apps/server/src/testlinkMigration/) reads
 * TestLink's values: roles, custom field types, statuses and verdicts. Pure, so it's tested here.
 */

/** TestLink's node types (node_types), as its default data numbers them. */
export const TL_NODE = { project: 1, suite: 2, case: 3, version: 4, plan: 5, step: 9 } as const;

/**
 * The Tessick role for a TestLink role, by what it may do: user management makes an admin,
 * planning a test lead, editing or executing a tester, viewing a viewer. TestLink's own
 * "admin" role is always Admin.
 */
export function tessickRoleFor(description: string, rights: string[]): 'Admin' | 'Test Lead' | 'Tester' | 'Viewer' | 'No Access' {
  const has = (r: string) => rights.includes(r);
  if (description.trim().toLowerCase() === 'admin' || has('mgt_users') || has('role_management')) return 'Admin';
  if (has('testplan_planning') || has('mgt_testplan_create') || has('testplan_create_build')) return 'Test Lead';
  if (has('mgt_modify_tc') || has('testplan_execute')) return 'Tester';
  if (has('mgt_view_tc')) return 'Viewer';
  return 'No Access';
}

/**
 * TestLink's custom field type (cfield_mgr) as one of Tessick's six. TestLink's checkboxes are a
 * set of options, so they're a multi-select; radio buttons a single select; email, text area
 * and the script types text; datetime a date. The answer says when the type isn't kept exactly.
 */
export function customFieldTypeFromTestLink(type: number): { field_type: string; exact: boolean } {
  switch (type) {
    case 0:
      return { field_type: 'TEXT', exact: true };
    case 1:
      return { field_type: 'NUMBER', exact: true };
    case 2:
      return { field_type: 'NUMBER', exact: false };
    case 5:
      return { field_type: 'MULTI_SELECT', exact: false };
    case 6:
      return { field_type: 'SINGLE_SELECT', exact: true };
    case 7:
      return { field_type: 'MULTI_SELECT', exact: true };
    case 8:
      return { field_type: 'DATE', exact: true };
    case 9:
      return { field_type: 'SINGLE_SELECT', exact: false };
    case 10:
      return { field_type: 'DATE', exact: false };
    default:
      return { field_type: 'TEXT', exact: type === 0 };
  }
}

/** A list field's options from TestLink's possible_values ("a|b|c"), each once. */
export function optionsFrom(possibleValues: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const v of String(possibleValues ?? '').split(TL_LIST_SEPARATOR).map((s) => s.trim())) if (v) seen.add(v);
  return [...seen];
}

/** A TestLink version's status and active flag as Tessick's: final approved, obsolete or inactive deprecated, the rest draft. */
export function versionStatusFromTestLink(status: number, active: number): 'DRAFT' | 'APPROVED' | 'DEPRECATED' {
  if (Number(active) === 0 || Number(status) === TL_STATUS.obsolete) return 'DEPRECATED';
  if (Number(status) === TL_STATUS.final) return 'APPROVED';
  return 'DRAFT';
}

/** A TestLink plan's flags as a Tessick plan status: inactive archived, closed locked. */
export function planStatusFromTestLink(active: number, isOpen: number): 'ACTIVE' | 'LOCKED' | 'ARCHIVED' {
  if (Number(active) === 0) return 'ARCHIVED';
  return Number(isOpen) === 0 ? 'LOCKED' : 'ACTIVE';
}

/** An execution's status code as a verdict; undefined for "not run" and codes Tessick doesn't know. */
export function verdictFromTestLink(code: string | null | undefined): 'PASSED' | 'FAILED' | 'BLOCKED' | undefined {
  const c = String(code ?? '').trim().toLowerCase();
  return c === 'p' ? 'PASSED' : c === 'f' ? 'FAILED' : c === 'b' ? 'BLOCKED' : undefined;
}

/** A step result's status code as a step verdict (anything else is untested). */
export function stepVerdictFromTestLink(code: string | null | undefined): 'PASSED' | 'FAILED' | 'BLOCKED' | 'UNTESTED' {
  return verdictFromTestLink(code) ?? 'UNTESTED';
}

/**
 * A custom field value as TestLink stored it, for Tessick's field: dates (kept by TestLink as
 * Unix timestamps) as YYYY-MM-DD, lists split on "|", numbers parsed. Empty is null.
 */
export function customFieldValueFromTestLink(fieldType: string, stored: string | null | undefined): unknown {
  const text = String(stored ?? '').trim();
  if (!text) return null;
  switch (fieldType) {
    case 'MULTI_SELECT':
      return optionsFrom(text);
    case 'NUMBER':
      return Number.isFinite(Number(text)) ? Number(text) : text;
    case 'DATE':
      return /^\d{1,11}$/.test(text) ? new Date(Number(text) * 1000).toISOString().slice(0, 10) : text;
    default:
      return text;
  }
}

/**
 * TestLink keeps times without a zone (`timestamp`, `datetime`), in its server's local time.
 * Drivers hand them over differently: PostgreSQL's as a Date made in this machine's zone,
 * MySQL's (dateStrings) as text. Both are read back as the wall-clock time stored, then placed
 * in `timeZone`, TestLink's own (an IANA name; UTC by default).
 */
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

function wallParts(value: unknown): number[] | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    // The driver made it from the stored wall time in this machine's zone: read that back.
    return [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds()];
  }
  const m = WALL.exec(String(value).trim());
  if (!m) return undefined;
  return [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)).concat(Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3)));
}

/** How far `timeZone` is ahead of UTC at instant `t` (ms). */
function zoneOffset(timeZone: string, t: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Whether `timeZone` is an IANA zone name this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A TestLink time as ISO 8601 (UTC); undefined when missing or unreadable. Text with its own offset keeps it. */
export function isoTimestamp(value: unknown, timeZone = 'UTC'): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string' && /([zZ]|[+-]\d\d:?\d\d)$/.test(value.trim())) {
    const t = Date.parse(value.trim().replace(' ', 'T'));
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const p = wallParts(value);
  if (!p) return undefined;
  const wall = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5], p[6]);
  // Twice, so a time near a daylight-saving change takes the offset in force then.
  const first = wall - zoneOffset(timeZone, wall);
  const t = wall - zoneOffset(timeZone, first);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** A TestLink date (or a time's date) as YYYY-MM-DD, as stored: dates have no zone to move them. */
export function wallDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  // A date column comes as midnight: local from node-postgres, UTC from PGlite. Exactly UTC
  // midnight is taken as a UTC date; otherwise the local reading holds.
  if (value instanceof Date && !Number.isNaN(value.getTime()) && value.getTime() % 86_400_000 === 0) return value.toISOString().slice(0, 10);
  const p = wallParts(value);
  return p ? `${String(p[0]).padStart(4, '0')}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}` : undefined;
}
