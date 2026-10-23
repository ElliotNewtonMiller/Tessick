import {
  EMPTINESS_OPS,
  MAX_CASE_FILTERS,
  MAX_CASE_SEARCH_QUERY_LENGTH,
  OPS_BY_KIND,
  type CaseFilterFieldDescriptor,
  type CaseFilterOp,
  type NormalizedCaseFilter,
  type NormalizedCaseFilterRequest,
} from './types.js';

/** One problem with a filter request: the field it's in (`q`, `filters[2].value`) and why. */
export interface CaseFilterProblem {
  name: string;
  reason: string;
}

export type CaseFilterValidationResult =
  | { ok: true; request: NormalizedCaseFilterRequest }
  | { ok: false; errors: CaseFilterProblem[] };

/** What a filter may hold. Anything else is refused: a misspelt key used to be ignored silently. */
const FILTER_KEYS = new Set(['field', 'op', 'value']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceScalar(kind: 'NUMBER' | 'DATE', raw: unknown): number | string | null {
  if (kind === 'NUMBER') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return typeof raw === 'string' && DATE_RE.test(raw) ? raw : null;
}

/** Validates a raw request body against the catalog of filterable fields and returns it
 * normalized (values coerced to each op's shape), or every problem found -- each names the
 * field it's in (`filters[1].op`), so an API caller can tell which one to fix. */
export function validateCaseFilterRequest(
  raw: unknown,
  fields: Map<string, CaseFilterFieldDescriptor>
): CaseFilterValidationResult {
  const errors: CaseFilterProblem[] = [];
  const body = (raw && typeof raw === 'object' ? raw : {}) as { q?: unknown; filters?: unknown };

  let q = '';
  if (body.q !== undefined && body.q !== null) {
    if (typeof body.q !== 'string') errors.push({ name: 'q', reason: 'must be text' });
    else if (body.q.length > MAX_CASE_SEARCH_QUERY_LENGTH) {
      errors.push({ name: 'q', reason: `can be at most ${MAX_CASE_SEARCH_QUERY_LENGTH} characters` });
    } else q = body.q.trim();
  }

  const rawFilters = body.filters ?? [];
  if (!Array.isArray(rawFilters)) {
    return { ok: false, errors: [...errors, { name: 'filters', reason: 'must be a list' }] };
  }
  if (rawFilters.length > MAX_CASE_FILTERS) {
    return { ok: false, errors: [...errors, { name: 'filters', reason: `can have at most ${MAX_CASE_FILTERS} filters` }] };
  }

  const filters: NormalizedCaseFilter[] = [];
  rawFilters.forEach((f: any, i: number) => {
    const at = `filters[${i}]`;
    if (!f || typeof f !== 'object' || typeof f.field !== 'string' || typeof f.op !== 'string') {
      errors.push({ name: at, reason: 'needs a "field" and an "op", as text' });
      return;
    }
    const unknownKeys = Object.keys(f).filter((k) => !FILTER_KEYS.has(k));
    if (unknownKeys.length > 0) {
      for (const k of unknownKeys) errors.push({ name: `${at}.${k}`, reason: "isn't a known field (a filter has field, op and value)" });
      return;
    }
    const descriptor = fields.get(f.field);
    if (!descriptor) {
      errors.push({ name: `${at}.field`, reason: `'${f.field}' isn't a field you can filter on (the fields route lists them)` });
      return;
    }
    const op = f.op as CaseFilterOp;
    const kind = descriptor.kind;
    const inherited = descriptor.source === 'suite_custom_field';
    const push = (value: unknown) => filters.push({ field: f.field, kind, op, inherited, value });

    if (EMPTINESS_OPS.includes(op)) {
      push(null);
      return;
    }
    if (!OPS_BY_KIND[kind].includes(op)) {
      errors.push({ name: `${at}.op`, reason: `'${f.op}' isn't valid for '${f.field}' (allowed: ${[...OPS_BY_KIND[kind], ...EMPTINESS_OPS].join(', ')})` });
      return;
    }

    switch (op) {
      case 'any_of':
      case 'all_of': {
        const v = f.value;
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
          errors.push({ name: `${at}.value`, reason: 'must be a non-empty list of text values' });
          return;
        }
        if (descriptor.strict_options && descriptor.options) {
          const allowed = new Set(descriptor.options.map((o) => o.value));
          const bad = v.filter((x: string) => !allowed.has(x));
          if (bad.length > 0) {
            errors.push({ name: `${at}.value`, reason: `${bad.map((b: string) => `'${b}'`).join(', ')} isn't an option of '${f.field}'` });
            return;
          }
        }
        push([...new Set(v as string[])]);
        return;
      }
      case 'contains': {
        if (typeof f.value !== 'string' || f.value.trim() === '') {
          errors.push({ name: `${at}.value`, reason: 'must be non-empty text' });
          return;
        }
        push(f.value.trim().toLowerCase());
        return;
      }
      case 'is': {
        if (typeof f.value !== 'boolean') {
          errors.push({ name: `${at}.value`, reason: 'must be true or false' });
          return;
        }
        push(f.value);
        return;
      }
      case 'eq':
      case 'gte':
      case 'lte': {
        const v = coerceScalar(kind as 'NUMBER' | 'DATE', f.value);
        if (v === null) {
          errors.push({ name: `${at}.value`, reason: `must be a ${kind === 'NUMBER' ? 'number' : 'YYYY-MM-DD date'}` });
          return;
        }
        push(v);
        return;
      }
      case 'between': {
        const pair = Array.isArray(f.value) && f.value.length === 2 ? f.value : null;
        const lo = pair ? coerceScalar(kind as 'NUMBER' | 'DATE', pair[0]) : null;
        const hi = pair ? coerceScalar(kind as 'NUMBER' | 'DATE', pair[1]) : null;
        if (lo === null || hi === null) {
          errors.push({ name: `${at}.value`, reason: `must be a [min, max] pair of ${kind === 'NUMBER' ? 'numbers' : 'YYYY-MM-DD dates'}` });
          return;
        }
        push(lo <= hi ? [lo, hi] : [hi, lo]);
        return;
      }
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, request: { q, filters } };
}
