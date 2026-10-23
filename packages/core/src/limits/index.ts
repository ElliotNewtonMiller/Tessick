/**
 * What the database can store. Values outside these limits used to reach PostgreSQL and fail
 * there with a 500; the server checks them up front instead (apps/server/src/inputText.ts and the
 * routes), so bad input gets a 400 naming the field.
 */

/** The largest PostgreSQL `integer`: durations in milliseconds (about 24.8 days), positions, step numbers. */
export const MAX_DB_INTEGER = 2_147_483_647;

/** Names and titles are varchar(255): projects, suites, cases, plans, runs, tokens, webhooks, field labels. */
export const MAX_NAME_LENGTH = 255;

/** PostgreSQL text can't hold the NUL character (U+0000): saving or even searching for one fails. */
const NUL = /\u0000/g;

export function hasNul(text: string): boolean {
  return text.includes('\u0000');
}

/**
 * The value with every NUL removed from its text, deeply (strings, lists, plain objects and their
 * keys). For text from other tools -- test output, imported files -- where a stray NUL is common
 * and means nothing.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === 'string') return (hasNul(value) ? value.replace(NUL, '') : value) as T;
  if (Array.isArray(value)) return value.map((v) => withoutNul(v)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[withoutNul(k)] = withoutNul(v);
    return out as T;
  }
  return value;
}

/**
 * Where a value's text holds a NUL, as field names (`title`, `results[3].notes`, `steps[0]`); a
 * key holding one is named by the object it's in. Empty when there's none.
 */
export function nulFields(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return hasNul(value) ? [path || 'value'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => nulFields(v, `${path}[${i}]`));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => {
      const at = path ? `${path}.${k}` : k;
      return hasNul(k) ? [path || 'body'] : nulFields(v, at);
    });
  }
  return [];
}

/**
 * An object holding fields: parsed JSON, or a parsed query string (whose prototype isn't
 * Object's). Not a list, a date or a buffer.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}
