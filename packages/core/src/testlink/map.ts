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

/** The number TestLink keeps on the version ("1" for MA-1); the whole id when it has no number. */
export function externalIdNumber(externalId: string): string {
  const match = /-(\d+)$/.exec(externalId);
  return match ? match[1] : externalId;
}
