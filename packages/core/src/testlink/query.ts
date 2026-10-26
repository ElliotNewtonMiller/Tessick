import { matchesValidationPattern, VALIDATION_PATTERN_TIME_LIMIT_MS } from '../custom-fields/validationPattern.js';

/**
 * The case lists of the TestLink-compatible API (Dave's "query layer", custom-1.4.0): one filter,
 * projection, paging and aggregation layer shared by GET /testprojects/{id}/testcases,
 * GET /testsuites/{id}/testcases and GET /testcasemetrics, so every tool counts the same cases.
 *
 * It works on a project's cases already shown as TestLink shows them (TlCase, with TestLink's
 * numeric ids and codes), so it needs no database and is unit-tested on its own. Every count
 * uses each case's latest version.
 *
 * As in TestLink, the layer engages only when one of its parameters is given (an empty value is
 * not given): without them a list answers exactly as before, `items` only, in tree order.
 */

export interface TlStep {
  step_number: number;
  actions: string;
  expected_results: string;
  execution_type: number;
}

/** A custom field definition as TestLink lists it (GET /testprojects/{id}/customfields). */
export interface TlCustomFieldDef {
  id: number;
  name: string;
  label: string;
  type: number;
  type_name: string;
  possible_values: string;
  default_value: string;
  required: 0 | 1;
  enabled_on_design: 1;
}

/** A case's custom field: its definition and its value as TestLink stores it (null when unset). */
export interface TlCustomFieldEntry extends TlCustomFieldDef {
  value: string | null;
}

/** A case's latest version, with everything any of the lists can show or filter on. */
export interface TlCase {
  id: number;
  tcversion_id: number;
  name: string;
  /** PREFIX-n. */
  external_id: string;
  /** The number TestLink keeps on the version ("1"). */
  tc_external_id: string;
  version: number;
  summary: string;
  preconditions: string;
  importance: number;
  status: number;
  active: 0 | 1;
  execution_type: number;
  estimated_exec_duration: string | null;
  steps: TlStep[];
  tsuite_id: number;
  tsuite_name: string;
  /** The suite's path: its ancestors' names and its own, joined with " / ". */
  path: string;
  /** Keyword id → keyword. */
  keywords: Record<string, string>;
  /** Custom field id → field and value. */
  customfields: Record<string, TlCustomFieldEntry>;
}

export interface TlSuite {
  id: number;
  name: string;
  /** TestLink's parent node: the project for a top-level suite, otherwise the parent suite. */
  parent_id: number;
  /** The parent suite, or null at the top. */
  parent_suite_id: number | null;
  node_order: number;
}

/** A request TestLink refuses (400, `status: "error"`), with its message. */
export class TestLinkQueryError extends Error {}

type Params = Record<string, unknown>;

/** A query parameter's value: the first if repeated, trimmed; an empty one is absent. */
function param(params: Params, name: string): string | undefined {
  const raw = params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function intParam(params: Params, name: string, allowed?: number[]): number | undefined {
  const text = param(params, name);
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || (allowed && !allowed.includes(Number(text)))) {
    throw new TestLinkQueryError(allowed ? `${name} must be ${allowed.join(' or ')}` : `${name} must be a whole number`);
  }
  return Number(text);
}

const flagParam = (params: Params, name: string) => intParam(params, name, [0, 1]) === 1;

function csvParam(params: Params, name: string): string[] {
  const text = param(params, name);
  return text === undefined ? [] : text.split(',').map((s) => s.trim()).filter(Boolean);
}

function idsParam(params: Params, name: string): number[] {
  return csvParam(params, name).map((s) => {
    if (!/^\d+$/.test(s)) throw new TestLinkQueryError(`${name} must be a comma-separated list of ids`);
    return Number(s);
  });
}

function checkRegex(pattern: string, name: string) {
  try {
    new RegExp(pattern, 'i');
  } catch {
    throw new TestLinkQueryError(`${name}: "${pattern}" isn't a valid regular expression`);
  }
}

/** Case-insensitive regex match, with the same time limit as custom field validation patterns. */
function regexMatches(pattern: string, value: string, name: string): boolean {
  try {
    return matchesValidationPattern(pattern, value, VALIDATION_PATTERN_TIME_LIMIT_MS, 'i');
  } catch {
    throw new TestLinkQueryError(`${name}: matching "${pattern}" took too long; simplify the regular expression`);
  }
}

// --- The suite tree -------------------------------------------------------------------------

/** Suites to skip, with their whole subtree, below the requested roots. */
export interface Exclusions {
  names: string[];
  ids: number[];
}

export function parseExclusions(params: Params): Exclusions {
  return { names: csvParam(params, 'excludeSuiteNames').map((n) => n.toLowerCase()), ids: idsParam(params, 'excludeSuiteIds') };
}

const isExcluded = (suite: TlSuite, ex: Exclusions) => ex.ids.includes(suite.id) || ex.names.includes(suite.name.toLowerCase());

export class SuiteTree {
  readonly byId = new Map<number, TlSuite>();
  private readonly childSuites = new Map<number | null, TlSuite[]>();
  private readonly casesIn = new Map<number, TlCase[]>();

  constructor(suites: TlSuite[], cases: TlCase[] = []) {
    for (const s of suites) {
      this.byId.set(s.id, s);
      const siblings = this.childSuites.get(s.parent_suite_id) ?? [];
      siblings.push(s);
      this.childSuites.set(s.parent_suite_id, siblings);
    }
    for (const list of this.childSuites.values()) list.sort((a, b) => a.node_order - b.node_order || a.name.localeCompare(b.name) || a.id - b.id);
    for (const c of cases) {
      const list = this.casesIn.get(c.tsuite_id) ?? [];
      list.push(c);
      this.casesIn.set(c.tsuite_id, list);
    }
    for (const list of this.casesIn.values()) list.sort((a, b) => a.id - b.id);
  }

  children(suiteId: number | null): TlSuite[] {
    return this.childSuites.get(suiteId) ?? [];
  }

  casesOf(suiteId: number): TlCase[] {
    return this.casesIn.get(suiteId) ?? [];
  }

  ancestors(suiteId: number): TlSuite[] {
    const out: TlSuite[] = [];
    for (let s = this.byId.get(suiteId); s; s = s.parent_suite_id === null ? undefined : this.byId.get(s.parent_suite_id)) out.unshift(s);
    return out;
  }

  path(suiteId: number): string {
    return this.ancestors(suiteId).map((s) => s.name).join(' / ');
  }

  /**
   * The cases under the roots (the whole project when `roots` is null), in tree order: a
   * suite's own cases, then its child suites'. With `deep` false, only the roots' own cases.
   * A suite matching `exclusions` is skipped with its subtree, except a root itself. Each case
   * comes once, however the roots overlap.
   */
  collect(roots: number[] | null, deep: boolean, exclusions: Exclusions): TlCase[] {
    const out: TlCase[] = [];
    const seen = new Set<number>();
    const add = (suiteId: number) => {
      for (const c of this.casesOf(suiteId)) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
    };
    const walk = (suite: TlSuite) => {
      if (isExcluded(suite, exclusions)) return;
      add(suite.id);
      for (const child of this.children(suite.id)) walk(child);
    };
    if (roots === null) {
      for (const top of this.children(null)) walk(top);
      return out;
    }
    for (const root of roots) {
      add(root);
      if (deep) for (const child of this.children(root)) walk(child);
    }
    return out;
  }
}

export interface SuiteTreeQuery {
  includeMeta: boolean;
  name?: string;
  match: 'equals' | 'contains' | 'regex';
  activeOnly: boolean;
  exclusions: Exclusions;
}

/** GET /testprojects/{id}/testsuites's parameters. */
export function parseSuiteTreeQuery(params: Params): SuiteTreeQuery {
  const match = (param(params, 'match') ?? 'equals').toLowerCase();
  if (!['equals', 'contains', 'regex'].includes(match)) throw new TestLinkQueryError('match must be equals, contains or regex');
  const name = param(params, 'name');
  if (name !== undefined && match === 'regex') checkRegex(name, 'name');
  const activeOnly = flagParam(params, 'activeOnly');
  const exclusions = parseExclusions(params);
  const includeMeta = flagParam(params, 'includeMeta') || name !== undefined || activeOnly || exclusions.names.length > 0 || exclusions.ids.length > 0;
  return { includeMeta, name, match: match as SuiteTreeQuery['match'], activeOnly, exclusions };
}

/**
 * The project's suite tree, as GET /testprojects/{id}/testsuites answers it: nested nodes; with
 * meta, each node's path, depth and case counts (an excluded suite and its subtree count 0 and
 * add nothing above them); with `name`, a flat list of the matching suites, with meta and no
 * children.
 */
export function suiteTreeItems(tree: SuiteTree, q: SuiteTreeQuery): Record<string, unknown>[] {
  const counted = (c: TlCase) => !q.activeOnly || c.active === 1;
  const flat: Record<string, unknown>[] = [];
  const nameMatches = (suiteName: string) => {
    if (q.name === undefined) return false;
    if (q.match === 'regex') return regexMatches(q.name, suiteName, 'name');
    const a = suiteName.toLowerCase();
    const b = q.name.toLowerCase();
    return q.match === 'contains' ? a.includes(b) : a === b;
  };

  const node = (suite: TlSuite, depth: number, path: string, excludedAbove: boolean): { out: Record<string, unknown>; deep: number } => {
    const excluded = excludedAbove || isExcluded(suite, q.exclusions);
    const fullPath = path ? `${path} / ${suite.name}` : suite.name;
    const kids = tree.children(suite.id).map((child) => node(child, depth + 1, fullPath, excluded));
    const direct = excluded ? 0 : tree.casesOf(suite.id).filter(counted).length;
    const deep = direct + kids.reduce((sum, k) => sum + k.deep, 0);
    const out: Record<string, unknown> = { type: 'testsuite', id: suite.id, name: suite.name, parent_id: suite.parent_id, node_order: suite.node_order };
    if (q.includeMeta) Object.assign(out, { path: fullPath, depth, testcaseCount: { direct, deep } });
    if (q.name !== undefined) {
      if (nameMatches(suite.name)) flat.push(out);
    } else {
      out.children = kids.map((k) => k.out);
    }
    return { out, deep };
  };
  const roots = tree.children(null).map((top) => node(top, 0, '', false));
  return q.name !== undefined ? flat : roots.map((r) => r.out);
}

// --- Case lists -----------------------------------------------------------------------------

export type CfMatch = 'equals' | 'contains' | 'regex' | 'exists';

export interface CfFilter {
  name: string;
  value: string;
  match: CfMatch;
}

const GROUP_KEYS = ['executionType', 'status', 'active', 'importance', 'suite'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number] | `cf:${string}`;

export interface CaseQuery {
  /** A query-layer parameter was given: answer with totals and paging, ordered by case id. */
  engaged: boolean;
  executionType?: number;
  active?: number;
  status?: number;
  importance?: number;
  /** Keyword names, lower case: a case matches if it has any. */
  keywords: string[];
  cfFilters: CfFilter[];
  exclusions: Exclusions;
  fields?: string[];
  cfCompact: boolean;
  limit: number;
  offset: number;
  countOnly: boolean;
  groupBy?: GroupKey[];
  nosteps: boolean;
  /** Show each case's custom fields (always for a project's list on v2 and custom). */
  customfields: boolean;
  /** A project's list: the suites to start from (each deep), or none for the whole project. */
  suiteIds?: number[];
  /** A suite's list: its sub-suites' cases too. */
  deep: boolean;
}

/** The query layer's own parameters; giving any engages it. */
const LAYER_PARAMS = [
  'excludeSuiteNames',
  'excludeSuiteIds',
  'executionType',
  'active',
  'status',
  'importance',
  'keyword',
  'cfFilters',
  'fields',
  'cfCompact',
  'limit',
  'offset',
  'countOnly',
  'groupBy',
];
/** A project's list had none of its parameters before the layer, so these engage it there too. */
const PROJECT_LAYER_PARAMS = ['suiteIds', 'nosteps'];

const MATCHES: CfMatch[] = ['equals', 'contains', 'regex', 'exists'];

function parseCfFilters(text: string | undefined): CfFilter[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TestLinkQueryError('cfFilters must be a JSON array, e.g. [{"name":"automationStatus","value":"Done","match":"equals"}]');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((entry: any, i) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new TestLinkQueryError(`cfFilters[${i}] needs a "name"`);
    }
    const match = String(entry.match ?? 'equals').toLowerCase() as CfMatch;
    if (!MATCHES.includes(match)) throw new TestLinkQueryError(`cfFilters[${i}].match must be equals, contains, regex or exists`);
    const value = entry.value === undefined || entry.value === null ? '' : String(entry.value);
    if (match === 'regex') checkRegex(value, `cfFilters[${i}]`);
    return { name: entry.name.trim(), value, match };
  });
}

/** A case list's parameters (`route` decides which it takes and what engages the layer). */
export function parseCaseQuery(params: Params, route: 'project' | 'suite', opts: { customfields?: boolean } = {}): CaseQuery {
  const engaged = [...LAYER_PARAMS, ...(route === 'project' ? PROJECT_LAYER_PARAMS : [])].some((name) => param(params, name) !== undefined);
  const cfFilters = parseCfFilters(param(params, 'cfFilters'));

  // A suite's list has had cfName/cfValue/cfMatch longer: one more filter, `contains` by default.
  let legacyFilter = false;
  if (route === 'suite') {
    const cfName = param(params, 'cfName');
    if (cfName !== undefined) {
      legacyFilter = true;
      const cfValue = param(params, 'cfValue');
      const match = (param(params, 'cfMatch') ?? (cfValue === undefined ? 'exists' : 'contains')).toLowerCase() as CfMatch;
      if (!MATCHES.includes(match)) throw new TestLinkQueryError('cfMatch must be contains, equals, regex or exists');
      if (match === 'regex') checkRegex(cfValue ?? '', 'cfValue');
      cfFilters.push({ name: cfName, value: cfValue ?? '', match });
    }
  }

  const groupBy = csvParam(params, 'groupBy');
  for (const key of groupBy) {
    if (!(GROUP_KEYS as readonly string[]).includes(key) && !(key.startsWith('cf:') && key.length > 3)) {
      throw new TestLinkQueryError(`groupBy: "${key}" isn't one of executionType, status, active, importance, suite or cf:<name>`);
    }
  }
  const fields = csvParam(params, 'fields');
  const cfCompact = flagParam(params, 'cfCompact');
  const query: CaseQuery = {
    engaged,
    executionType: intParam(params, 'executionType', [1, 2]),
    active: intParam(params, 'active', [0, 1]),
    status: intParam(params, 'status'),
    importance: intParam(params, 'importance'),
    keywords: csvParam(params, 'keyword').map((k) => k.toLowerCase()),
    cfFilters,
    exclusions: parseExclusions(params),
    fields: fields.length ? fields : undefined,
    cfCompact,
    limit: intParam(params, 'limit') ?? 0,
    offset: intParam(params, 'offset') ?? 0,
    countOnly: flagParam(params, 'countOnly'),
    groupBy: groupBy.length ? (groupBy as GroupKey[]) : undefined,
    nosteps: flagParam(params, 'nosteps'),
    customfields: opts.customfields || flagParam(params, 'customfields') || legacyFilter || cfCompact,
    deep: route === 'suite' && flagParam(params, 'deep'),
  };
  if (route === 'project') {
    const suiteIds = idsParam(params, 'suiteIds');
    if (suiteIds.length) query.suiteIds = suiteIds;
  }
  return query;
}

/** The case's custom field named `name` (its name or label, ignoring case). */
function fieldNamed(c: TlCase, name: string): TlCustomFieldEntry | undefined {
  const wanted = name.toLowerCase();
  return Object.values(c.customfields).find((f) => f.name.toLowerCase() === wanted || f.label.toLowerCase() === wanted);
}

const isSet = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== '';

function cfMatches(c: TlCase, filter: CfFilter, label: string): boolean {
  const value = fieldNamed(c, filter.name)?.value;
  if (filter.match === 'exists') return isSet(value);
  if (value === null || value === undefined) return false;
  if (filter.match === 'regex') return regexMatches(filter.value, value, label);
  const a = value.toLowerCase();
  const b = filter.value.toLowerCase();
  return filter.match === 'contains' ? a.includes(b) : a === b;
}

/** Whether a case passes every filter (they're ANDed). */
export function caseMatches(c: TlCase, q: CaseQuery): boolean {
  if (q.executionType !== undefined && c.execution_type !== q.executionType) return false;
  if (q.active !== undefined && c.active !== q.active) return false;
  if (q.status !== undefined && c.status !== q.status) return false;
  if (q.importance !== undefined && c.importance !== q.importance) return false;
  if (q.keywords.length) {
    const has = Object.values(c.keywords).map((k) => k.toLowerCase());
    if (!q.keywords.some((k) => has.includes(k))) return false;
  }
  return q.cfFilters.every((f, i) => cfMatches(c, f, `cfFilters[${i}]`));
}

/** `customfields` as a flat {name: value} map (cfCompact). */
export function compactCustomFields(c: TlCase): Record<string, string | null> {
  return Object.fromEntries(Object.values(c.customfields).map((f) => [f.name, f.value]));
}

function customfieldsOut(c: TlCase, q: Pick<CaseQuery, 'cfCompact'>) {
  return q.cfCompact ? compactCustomFields(c) : c.customfields;
}

/** Every field a case list can show, for `fields`. */
function fullRow(c: TlCase, q: CaseQuery): Record<string, unknown> {
  return {
    id: c.id,
    external_id: c.external_id,
    name: c.name,
    version: c.version,
    tcversion_id: c.tcversion_id,
    tc_external_id: c.tc_external_id,
    execution_type: c.execution_type,
    active: c.active,
    status: c.status,
    importance: c.importance,
    tsuite_id: c.tsuite_id,
    parent_id: c.tsuite_id,
    tsuite_name: c.tsuite_name,
    path: c.path,
    keywords: c.keywords,
    customfields: customfieldsOut(c, q),
    summary: c.summary,
    preconditions: c.preconditions,
    estimated_exec_duration: c.estimated_exec_duration,
    steps: c.steps,
  };
}

/** The fields every shape starts with. */
function versionFields(c: TlCase) {
  return {
    summary: c.summary,
    preconditions: c.preconditions,
    importance: c.importance,
    status: c.status,
    active: c.active,
    execution_type: c.execution_type,
    estimated_exec_duration: c.estimated_exec_duration,
  };
}

/** An item of GET /testprojects/{id}/testcases (v1 has no keywords or custom fields). */
export function projectCaseItem(c: TlCase, q: CaseQuery): Record<string, unknown> {
  return {
    id: c.id,
    tcversion_id: c.tcversion_id,
    name: c.name,
    tc_external_id: c.tc_external_id,
    external_id: c.external_id,
    version: c.version,
    ...versionFields(c),
    ...(q.nosteps ? {} : { steps: c.steps }),
    ...(q.customfields ? { keywords: c.keywords, customfields: customfieldsOut(c, q) } : {}),
  };
}

/** An item of GET /testsuites/{id}/testcases. */
export function suiteCaseItem(c: TlCase, q: CaseQuery): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    tc_external_id: c.tc_external_id,
    external_id: c.external_id,
    version: c.version,
    tcversion_id: c.tcversion_id,
    parent_id: c.tsuite_id,
    tsuite_name: c.tsuite_name,
    ...versionFields(c),
    ...(q.nosteps ? {} : { steps: c.steps }),
    ...(q.customfields ? { customfields: customfieldsOut(c, q) } : {}),
  };
}

/** A case in GET /testprojects/{id}/testspec. */
export function specCaseItem(c: TlCase): Record<string, unknown> {
  return {
    type: 'testcase',
    id: c.id,
    parent_suite_id: c.tsuite_id,
    name: c.name,
    external_id: c.external_id,
    tc_external_id: c.tc_external_id,
    version: c.version,
    tcversion_id: c.tcversion_id,
    ...versionFields(c),
    steps: c.steps,
  };
}

function groupValue(c: TlCase, key: GroupKey): Record<string, unknown> {
  switch (key) {
    case 'executionType':
      return { executionType: c.execution_type };
    case 'status':
      return { status: c.status };
    case 'active':
      return { active: c.active };
    case 'importance':
      return { importance: c.importance };
    case 'suite':
      return { suite_id: c.tsuite_id, suite: c.tsuite_name };
    default: {
      const name = key.slice(3);
      const value = fieldNamed(c, name)?.value;
      // Unset or empty groups as "unset", which isn't "N/A".
      return { [name]: isSet(value) ? value : 'unset' };
    }
  }
}

/** Counts per combination of the groupBy keys, largest first. */
export function groupCases(cases: TlCase[], keys: GroupKey[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>();
  for (const c of cases) {
    const values = Object.assign({}, ...keys.map((k) => groupValue(c, k)));
    const id = JSON.stringify(values);
    const group = groups.get(id) ?? { ...values, count: 0 };
    group.count = (group.count as number) + 1;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => (b.count as number) - (a.count as number) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** A response is cut at about this size (then has_more is true). */
export const RESPONSE_SIZE_CAP_BYTES = 1_000_000;

/**
 * Filters, then shapes the list's answer. Without the layer: `items` in the order given (tree
 * order). With it: ordered by case id, then `countOnly` (`total`), `groupBy` (`total`, `groups`),
 * or a page of `items` with `total`, `returned`, `offset` and `has_more`, shown with `fields`
 * when given.
 */
export function runCaseQuery(cases: TlCase[], q: CaseQuery, shape: (c: TlCase, q: CaseQuery) => Record<string, unknown>): Record<string, unknown> {
  const matched = cases.filter((c) => caseMatches(c, q));
  if (!q.engaged) return { items: matched.map((c) => shape(c, q)) };

  matched.sort((a, b) => a.id - b.id);
  const total = matched.length;
  if (q.countOnly) return { total };
  if (q.groupBy) return { total, groups: groupCases(matched, q.groupBy) };

  const page = matched.slice(q.offset, q.limit ? q.offset + q.limit : undefined);
  const items: Record<string, unknown>[] = [];
  let size = 0;
  for (const c of page) {
    const item = q.fields ? pick(fullRow(c, q), q.fields) : shape(c, q);
    size += JSON.stringify(item).length + 1;
    if (items.length > 0 && size > RESPONSE_SIZE_CAP_BYTES) break;
    items.push(item);
  }
  return { items, total, returned: items.length, offset: q.offset, has_more: q.offset + items.length < total };
}

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}
