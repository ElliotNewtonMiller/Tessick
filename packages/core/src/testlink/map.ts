import { createHash } from 'node:crypto';

/**
 * Testify's values as TestLink's REST API shows them (docs/testlink_compat_api.md, "How
 * Testify's model maps"), and back. Pure, so the TestLink-compatible API, its migration and its
 * tests share one table.
 */

/** TestLink's importance: 1 low, 2 medium, 3 high. CRITICAL and P1 read as high. */
export function importanceCode(priority: string): 1 | 2 | 3 {
  switch (priority) {
    case 'CRITICAL':
    case 'HIGH':
    case 'P1':
      return 3;
    case 'MEDIUM':
    case 'P2':
      return 2;
    default:
      return 1;
  }
}

/** TestLink's execution_type: 1 manual, 2 automated. */
export function executionTypeCode(executionType: string): 1 | 2 {
  return executionType === 'AUTOMATED' ? 2 : 1;
}

/**
 * TestLink's workflow status codes (tcversions.status). TestLink has seven; Testify keeps three,
 * so TestLink's review states read back as draft.
 */
export const TL_STATUS = {
  draft: 1,
  readyForReview: 2,
  reviewInProgress: 3,
  rework: 4,
  obsolete: 5,
  future: 6,
  final: 7,
} as const;

/** A latest version's status and `active` flag as TestLink shows them. A deprecated case is obsolete and inactive. */
export function versionStatusCodes(status: string): { status: number; active: 0 | 1 } {
  if (status === 'APPROVED') return { status: TL_STATUS.final, active: 1 };
  if (status === 'DEPRECATED') return { status: TL_STATUS.obsolete, active: 0 };
  return { status: TL_STATUS.draft, active: 1 };
}

/** A plan's TestLink flags: an archived plan is inactive, and only an ACTIVE plan is open. */
export function planFlags(status: string): { active: 0 | 1; is_open: 0 | 1 } {
  return { active: status === 'ARCHIVED' ? 0 : 1, is_open: status === 'ACTIVE' ? 1 : 0 };
}

/** A build's (run's) TestLink flags. */
export function buildFlags(status: string): { active: 1; is_open: 0 | 1 } {
  return { active: 1, is_open: status === 'CLOSED' ? 0 : 1 };
}

/** TestLink's custom field types (cfield_mgr) for each of Testify's six. */
export const TL_CUSTOM_FIELD_TYPES: Record<string, { type: number; type_name: string }> = {
  TEXT: { type: 0, type_name: 'string' },
  NUMBER: { type: 1, type_name: 'numeric' },
  CHECKBOX: { type: 5, type_name: 'checkbox' },
  SINGLE_SELECT: { type: 6, type_name: 'list' },
  MULTI_SELECT: { type: 7, type_name: 'multiselection list' },
  DATE: { type: 8, type_name: 'date' },
};

export function customFieldTypeCode(fieldType: string): { type: number; type_name: string } {
  return TL_CUSTOM_FIELD_TYPES[fieldType] ?? TL_CUSTOM_FIELD_TYPES.TEXT;
}

/** The separator TestLink stores list options and multi-select values with. */
export const TL_LIST_SEPARATOR = '|';

/** A custom field value as TestLink stores it: a string, lists joined with "|", or null when unset. */
export function customFieldValueString(fieldType: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.map(String).join(TL_LIST_SEPARATOR) : null;
  if (fieldType === 'CHECKBOX' || typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** The value TestLink lists as a CHECKBOX field's one possible value. */
export const TL_CHECKBOX_VALUE = '1';

/**
 * Fields the compatible API shows as TestLink's own case fields rather than as custom fields:
 * a project's keywords (a MULTI_SELECT field, one option per keyword) and the estimated
 * execution duration (a NUMBER field).
 */
export const TL_KEYWORDS_FIELD = 'keywords';
export const TL_DURATION_FIELD = 'estimated_exec_duration';

/**
 * The stable key a keyword's numeric id hangs on: its field and its text, as a UUID-shaped
 * digest. (A field's options are replaced whole when they change, so their row ids don't last.)
 */
export function keywordKey(fieldId: string, keyword: string): string {
  const hex = createHash('sha256').update(`${fieldId}\u0000${keyword}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The number TestLink keeps on the version ("1" for MA-1); the whole id when it has no number. */
export function externalIdNumber(externalId: string): string {
  const match = /-(\d+)$/.exec(externalId);
  return match ? match[1] : externalId;
}

// --- From TestLink's values (the compatible API's writes) -----------------------------------

/** TestLink's importance (1-3) as a Testify priority; anything else is left unset. */
export function priorityFromImportance(importance: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  const n = Number(importance);
  return n === 1 ? 'LOW' : n === 2 ? 'MEDIUM' : n === 3 ? 'HIGH' : undefined;
}

/** TestLink's execution_type (1, 2) as Testify's. */
export function executionTypeFromCode(code: unknown): 'MANUAL' | 'AUTOMATED' | undefined {
  const n = Number(code);
  return n === 1 ? 'MANUAL' : n === 2 ? 'AUTOMATED' : undefined;
}

/**
 * The lifecycle a TestLink write asks for, from its `status` (1-7) and `active` (0, 1):
 * final is APPROVED, obsolete or inactive DEPRECATED, every other status DRAFT. `reactivate`
 * is `active: 1` without a status: a deprecated case is restored, any other left as it is.
 */
export function statusTarget(status: unknown, active: unknown): { target?: 'DRAFT' | 'APPROVED' | 'DEPRECATED'; reactivate: boolean } {
  const a = active === undefined || active === null || active === '' ? undefined : Number(active);
  const s = status === undefined || status === null || status === '' ? undefined : Number(status);
  if (a === 0 || s === TL_STATUS.obsolete) return { target: 'DEPRECATED', reactivate: false };
  if (s === TL_STATUS.final) return { target: 'APPROVED', reactivate: false };
  if (s !== undefined && Number.isInteger(s) && s >= 1 && s <= 7) return { target: 'DRAFT', reactivate: false };
  return { reactivate: a === 1 };
}

/** TestLink's execution status codes, as Testify verdicts ("n", not run, isn't a result). */
export const TL_EXECUTION_STATUS: Record<string, 'PASSED' | 'FAILED' | 'BLOCKED'> = { p: 'PASSED', f: 'FAILED', b: 'BLOCKED' };

/**
 * A custom field value a TestLink client sent (a string, as TestLink stores it) as the value
 * Testify's field takes: lists split on "|", numbers and checkboxes parsed, and a date given as
 * a Unix timestamp (as TestLink keeps dates) turned into YYYY-MM-DD. What doesn't parse is
 * passed on as given, for Testify's validation to refuse with its own message.
 */
export function customFieldValueFromString(fieldType: string, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (fieldType === 'MULTI_SELECT') {
    const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(TL_LIST_SEPARATOR);
    return parts.map((p) => p.trim()).filter(Boolean);
  }
  const text = String(raw).trim();
  if (text === '') return null;
  switch (fieldType) {
    case 'NUMBER':
      return Number.isFinite(Number(text)) ? Number(text) : text;
    case 'CHECKBOX': {
      const lower = text.toLowerCase();
      if (['1', 'true', 'yes', 'on', 'checked'].includes(lower)) return true;
      if (['0', 'false', 'no', 'off'].includes(lower)) return false;
      return text;
    }
    case 'DATE':
      return /^\d{9,11}$/.test(text) ? new Date(Number(text) * 1000).toISOString().slice(0, 10) : text;
    default:
      return text;
  }
}
