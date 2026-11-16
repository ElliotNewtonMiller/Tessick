import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import type { Kysely } from 'kysely';
import {
  COMPAT_ID_SPACES,
  CompatApiKeyRepository,
  CustomFieldRepository,
  MAX_SUITE_DEPTH,
  RoleRepository,
  UserApiKeyRepository,
  type CompatEntityType,
  type CustomFieldDefinition,
  type Database,
} from '@tessick/db';
import {
  MAX_DB_INTEGER,
  TL_DURATION_FIELD,
  TL_KEYWORDS_FIELD,
  TL_NODE,
  checkValidationPattern,
  cleanHtmlText,
  customFieldTypeFromTestLink,
  customFieldValueFromTestLink,
  isTimeZone,
  isoTimestamp,
  wallDate,
  keywordKey,
  optionsFrom,
  parseCustomFieldValue,
  planStatusFromTestLink,
  platformRunName,
  priorityFromImportance,
  resolveDefaultValue,
  stepVerdictFromTestLink,
  tessickRoleFor,
  verdictFromTestLink,
  versionStatusFromTestLink,
  type CustomFieldType,
} from '@tessick/core';
import { TestLinkReader, type TestLinkData, type TlNode } from './read.js';
import type { TestLinkSource } from './source.js';

/**
 * Moves a TestLink 1.9 database into Tessick, keeping TestLink's ids (compat_ids), API keys and
 * history, so clients of the TestLink-compatible API (testlinkCompat/) and Dave's tools see the
 * same numbers after the move. docs/testlink_compat_api.md, "Migration", describes what it
 * brings and what it can't.
 *
 * - **All or nothing:** everything is written in one transaction; a dry run is the same
 *   migration rolled back, so its report is exact.
 * - **Again and again:** what's already migrated (its TestLink id is in compat_ids) is kept as
 *   it is, so a later run brings only what TestLink gained since: a first move early, the rest
 *   at the switch.
 * - **Direct:** rows are written in batches, not through the API's routes (a TestLink can hold
 *   hundreds of thousands of executions); values still go through the custom field checks.
 *   No webhooks are sent; one TESTLINK_MIGRATED audit row records each project.
 */

export interface MigrationOptions {
  /** The Tessick user recorded as making the migration, and as author or tester where TestLink's is unknown. */
  actor: string;
  dryRun?: boolean;
  /** TestLink's table prefix (DB_TABLE_PREFIX), if it has one. */
  tablePrefix?: string;
  /** The zone TestLink's server keeps its times in (an IANA name); UTC by default. */
  timeZone?: string;
  log?: (line: string) => void;
}

export interface Tally {
  testlink: number;
  created: number;
  existing: number;
  skipped: number;
}

export interface MigrationReport {
  dryRun: boolean;
  counts: Record<string, Tally>;
  warnings: string[];
  notMigrated: TestLinkData['notMigrated'];
}

/** A problem that stops the migration (nothing is written). */
export class MigrationError extends Error {}

class DryRunRollback extends Error {}

/** No password matches it: a migrated user signs in once an admin sets one (TestLink's are MD5, not kept). */
export const MIGRATED_PASSWORD_HASH = '!testlink-migrated';

const KINDS = [
  'users',
  'projects',
  'suites',
  'cases',
  'versions',
  'steps',
  'custom_fields',
  'keywords',
  'plans',
  'plan_cases',
  'platforms',
  'builds',
  'executions',
  'step_results',
  'project_roles',
] as const;
type Kind = (typeof KINDS)[number];

const INSERT_CHUNK = 500;
const clean = (html: string) => cleanHtmlText(html).replace(/\u0000/g, '');
const name = (text: string, max = 255) => text.replace(/\u0000/g, '').trim().slice(0, max);

export async function migrateTestLink(db: Kysely<Database>, source: TestLinkSource, opts: MigrationOptions): Promise<MigrationReport> {
  if (opts.timeZone && !isTimeZone(opts.timeZone)) throw new MigrationError(`'${opts.timeZone}' isn't a time zone (use an IANA name such as America/Chicago)`);
  const reader = new TestLinkReader(source, opts.tablePrefix ?? '');
  const data = await reader.readAll();
  const report: MigrationReport = {
    dryRun: Boolean(opts.dryRun),
    counts: Object.fromEntries(KINDS.map((k) => [k, { testlink: 0, created: 0, existing: 0, skipped: 0 }])),
    warnings: [],
    notMigrated: data.notMigrated,
  };
  try {
    await db.transaction().execute(async (trx) => {
      await new Migration(trx, reader, data, report, opts).run();
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

interface Run {
  id: string;
  name: string;
  status: string;
  release_date: string | null;
  created_at: string;
  test_plan_id: string;
}

class Migration {
  private now = new Date().toISOString();
  private actorId = '';
  /** compat_ids, by space and number, and those to add. */
  private compat = new Map<string, Map<number, { type: string; id: string; origin: string }>>();
  private pendingCompat: Array<{ id_space: string; int_id: number; entity_type: string; entity_id: string; origin: string }> = [];

  private children = new Map<number, TlNode[]>();
  private users = new Map<number, string>();
  private createdUsers = new Set<string>();
  private roleNames = new Map<number, string>();
  private projects = new Map<number, { id: string; prefix: string; created: boolean }>();
  /** TestLink field → its Tessick definitions, per entity type. */
  private fields = new Map<number, { TestCase?: CustomFieldDefinition; TestSuite?: CustomFieldDefinition; tlType: number }>();
  private versionCase = new Map<number, number>();
  private versionIds = new Map<number, string>();
  private stepIds = new Map<number, { id: string; step_number: number }>();

  constructor(
    private db: Kysely<Database>,
    private reader: TestLinkReader,
    private data: TestLinkData,
    private report: MigrationReport,
    private opts: MigrationOptions
  ) {
    for (const node of data.nodes.values()) {
      const list = this.children.get(node.parent_id) ?? [];
      list.push(node);
      this.children.set(node.parent_id, list);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.node_order - b.node_order || a.id - b.id);
  }

  /** A TestLink time, in TestLink's zone. */
  private time(value: unknown) {
    return isoTimestamp(value, this.opts.timeZone ?? 'UTC');
  }

  private tally(kind: Kind, field: keyof Tally, by = 1) {
    this.report.counts[kind][field] += by;
  }

  private warn(message: string) {
    this.report.warnings.push(message);
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  private childrenOf(id: number, type: number): TlNode[] {
    return (this.children.get(id) ?? []).filter((n) => n.node_type_id === type);
  }

  // --- compat_ids, kept in memory during the run ------------------------------------------

  private async loadCompat() {
    for (const row of await this.db.selectFrom('compat_ids').selectAll().execute()) {
      const space = this.compat.get(row.id_space) ?? new Map();
      space.set(Number(row.int_id), { type: row.entity_type, id: row.entity_id, origin: row.origin });
      this.compat.set(row.id_space, space);
    }
  }

  /** The Tessick row a TestLink id is already migrated as; refuses a number Tessick gave something else. */
  private claimed(type: CompatEntityType, intId: number): string | undefined {
    const row = this.compat.get(COMPAT_ID_SPACES[type])?.get(intId);
    if (!row) return undefined;
    // Only a number this migration kept means "already migrated": one Tessick gave is another row.
    if (row.type !== type || row.origin !== 'testlink') {
      throw new MigrationError(
        `TestLink's ${type} ${intId} has a number Tessick already gave a ${row.type}. Migrate into a Tessick whose TestLink-compatible API hasn't been used yet.`
      );
    }
    return row.id;
  }

  private record(type: CompatEntityType, intId: number, entityId: string) {
    const space = COMPAT_ID_SPACES[type];
    const ids = this.compat.get(space) ?? new Map();
    ids.set(intId, { type, id: entityId, origin: 'testlink' });
    this.compat.set(space, ids);
    this.pendingCompat.push({ id_space: space, int_id: intId, entity_type: type, entity_id: entityId, origin: 'testlink' });
  }

  private async insertMany(table: keyof Database, rows: Record<string, unknown>[]) {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await this.db.insertInto(table).values(rows.slice(i, i + INSERT_CHUNK) as any).execute();
    }
  }

  private async flushCompat() {
    await this.insertMany('compat_ids', this.pendingCompat);
    this.pendingCompat = [];
  }

  // --- The run ------------------------------------------------------------------------------

  async run() {
    const actor = await this.db.selectFrom('users').select('id').where('username', '=', this.opts.actor).executeTakeFirst();
    if (!actor) throw new MigrationError(`No Tessick user named '${this.opts.actor}' to record the migration as`);
    this.actorId = actor.id;
    await this.loadCompat();
    for (const v of this.data.versions) {
      const node = this.data.nodes.get(v.id);
      if (node) this.versionCase.set(v.id, node.parent_id);
    }
    await this.migrateUsers();
    await this.migrateProjects();
    await this.migrateCustomFields();
    for (const p of [...this.data.projects].sort((a, b) => a.id - b.id)) {
      const target = this.projects.get(p.id);
      if (target) await this.migrateProjectContent(p.id, target);
    }
    await this.migrateProjectRoles();
    await this.flushCompat();
    if (this.data.notMigrated.requirements > 0) this.warn(`${this.data.notMigrated.requirements} requirements and requirement specifications weren't migrated: Tessick has none.`);
    if (this.data.notMigrated.attachments > 0) this.warn(`${this.data.notMigrated.attachments} attachments weren't migrated: Tessick has no file storage.`);
  }

  // --- Users and roles ----------------------------------------------------------------------

  private async migrateUsers() {
    const rights = new Map<number, string[]>();
    for (const rr of this.data.roleRights) rights.set(rr.role_id, [...(rights.get(rr.role_id) ?? []), rr.right]);
    for (const r of this.data.roles) this.roleNames.set(r.id, tessickRoleFor(r.description, rights.get(r.id) ?? []));

    const existing = await this.db.selectFrom('users').select(['id', 'username', 'email']).execute();
    const byName = new Map(existing.map((u) => [u.username.toLowerCase(), u.id]));
    const emails = new Set(existing.map((u) => u.email.toLowerCase()));
    const roles = new RoleRepository(this.db);
    const keys = new UserApiKeyRepository(this.db);

    for (const u of [...this.data.users].sort((a, b) => a.id - b.id)) {
      this.tally('users', 'testlink');
      const login = name(u.login, 100);
      if (!login) {
        this.tally('users', 'skipped');
        this.warn(`TestLink user ${u.id} has no login and wasn't migrated.`);
        continue;
      }
      const found = byName.get(login.toLowerCase());
      if (found) {
        // A Tessick user of that name is taken as the same person, as they are.
        this.users.set(u.id, found);
        this.tally('users', 'existing');
        continue;
      }
      let email = /^[^@\s]+@[^@\s]+$/.test(u.email) && !emails.has(u.email.toLowerCase()) ? u.email : `${login.replace(/[^A-Za-z0-9._-]/g, '_')}@testlink.invalid`;
      for (let i = 2; emails.has(email.toLowerCase()); i++) email = email.replace(/(\+\d+)?@/, `+${i}@`);
      emails.add(email.toLowerCase());
      const id = uuidv7();
      const created = this.time(u.creation_ts) ?? this.now;
      await this.db
        .insertInto('users')
        .values({
          id,
          username: login,
          email,
          password_hash: MIGRATED_PASSWORD_HASH,
          status: u.active ? 'ACTIVE' : 'DISABLED',
          must_change_password: true,
          failed_login_count: 0,
          locked_until: null,
          created_at: created,
          updated_at: created,
        })
        .execute();
      await roles.assignGlobalRole(id, (this.roleNames.get(u.role_id) ?? 'No Access') as any);
      if (u.script_key && u.active) await keys.store(id, u.script_key);
      this.users.set(u.id, id);
      this.createdUsers.add(id);
      byName.set(login.toLowerCase(), id);
      this.tally('users', 'created');
    }
  }

  private async migrateProjectRoles() {
    const roles = new RoleRepository(this.db);
    for (const r of this.data.projectRoles) {
      this.tally('project_roles', 'testlink');
      const user = this.users.get(r.user_id);
      const project = this.projects.get(r.testproject_id);
      const role = this.roleNames.get(r.role_id);
      // Only migrated users' roles: an existing Tessick user's access is left as it is.
      if (!user || !project || !role || !this.createdUsers.has(user)) {
        this.tally('project_roles', 'skipped');
        continue;
      }
      await roles.assignProjectRole(user, project.id, role as any);
      this.tally('project_roles', 'created');
    }
  }

  // --- Projects -----------------------------------------------------------------------------

  private async migrateProjects() {
    const prefixes = new Set((await this.db.selectFrom('projects').select('prefix').execute()).map((p) => p.prefix.toUpperCase()));
    const keys = new CompatApiKeyRepository(this.db);
    for (const p of [...this.data.projects].sort((a, b) => a.id - b.id)) {
      this.tally('projects', 'testlink');
      const done = this.claimed('project', p.id);
      if (done) {
        this.projects.set(p.id, { id: done, prefix: p.prefix, created: false });
        this.tally('projects', 'existing');
        continue;
      }
      const projectName = name(this.data.nodes.get(p.id)?.name ?? `TestLink project ${p.id}`);
      if (prefixes.has(p.prefix.toUpperCase())) {
        throw new MigrationError(`Tessick already has a project with the prefix ${p.prefix} (not one migrated from this TestLink); TestLink's project '${projectName}' needs it.`);
      }
      const id = uuidv7();
      await this.db
        .insertInto('projects')
        .values({ id, name: projectName, prefix: p.prefix, description: clean(p.notes) || null, settings: '{}', created_at: this.now, updated_at: this.now })
        .execute();
      this.record('project', p.id, id);
      if (p.api_key) await keys.assign('project', id, p.api_key);
      if (!p.active) this.warn(`Project ${p.prefix} is inactive in TestLink; Tessick's projects are always active.`);
      this.projects.set(p.id, { id, prefix: p.prefix, created: true });
      prefixes.add(p.prefix.toUpperCase());
      this.tally('projects', 'created');
    }
  }

  // --- Custom fields ------------------------------------------------------------------------

  private async migrateCustomFields() {
    const repo = new CustomFieldRepository(this.db);
    for (const f of this.data.customFields) {
      this.tally('custom_fields', 'testlink');
      const projectIds = [
        ...new Set(this.data.fieldProjects.filter((fp) => fp.field_id === f.id).map((fp) => this.projects.get(fp.testproject_id)?.id).filter((id): id is string => Boolean(id))),
      ];
      const entities = this.data.fieldNodeTypes
        .filter((nt) => nt.field_id === f.id)
        .map((nt) => (nt.node_type_id === TL_NODE.case ? 'TestCase' : nt.node_type_id === TL_NODE.suite ? 'TestSuite' : undefined))
        .filter((e): e is 'TestCase' | 'TestSuite' => Boolean(e));
      if (projectIds.length === 0 || entities.length === 0) {
        this.tally('custom_fields', 'skipped');
        this.warn(`Custom field '${f.name}' isn't used on test cases or suites of a migrated project, so it wasn't migrated.`);
        continue;
      }
      const { field_type, exact } = customFieldTypeFromTestLink(f.type);
      if (!exact) this.warn(`Custom field '${f.name}' (TestLink type ${f.type}) became a ${field_type} field.`);
      const isList = field_type === 'SINGLE_SELECT' || field_type === 'MULTI_SELECT';
      const options = isList ? optionsFrom(f.possible_values) : [];
      const type = isList && options.length === 0 ? 'TEXT' : field_type;
      let regex: string | null = f.valid_regexp || null;
      if (regex && checkValidationPattern(regex)) {
        this.warn(`Custom field '${f.name}': its validation pattern couldn't be kept (${checkValidationPattern(regex)}).`);
        regex = null;
      }
      const optionRows = options.map((v) => ({ option_value: v }));
      const fallback = resolveDefaultValue(type as CustomFieldType, f.default_value || null, { options: optionRows });
      const defaultValue = fallback === null ? null : f.default_value;
      const wantsRequired = this.data.fieldProjects.some((fp) => fp.field_id === f.id && fp.required === 1);
      const required = wantsRequired && defaultValue !== null && type !== 'CHECKBOX';
      if (wantsRequired && !required) this.warn(`Custom field '${f.name}' is required in TestLink, but has no default Tessick can use, so it isn't required in Tessick.`);

      const entry: { TestCase?: CustomFieldDefinition; TestSuite?: CustomFieldDefinition; tlType: number } = { tlType: f.type };
      let created = false;
      for (const entity of [...new Set(entities)]) {
        const same = (await repo.listAllScopes(entity)).find((d) => d.name === f.name);
        if (same) {
          if (same.field_type !== type) {
            throw new MigrationError(`Tessick already has a ${entity} field '${f.name}' of type ${same.field_type}; TestLink's is ${type}. Rename one before migrating.`);
          }
          if (!same.all_projects) {
            const missing = projectIds.filter((id) => !same.project_ids.includes(id));
            if (missing.length) await repo.setProjects(same.id, { all_projects: false, project_ids: [...same.project_ids, ...missing] });
          }
          entry[entity] = (await repo.getDefinitionAnyScope(same.id))!;
        } else {
          entry[entity] = await repo.createDefinition({
            entity_type: entity,
            name: f.name,
            field_label: f.label || f.name,
            field_type: type as CustomFieldType,
            is_required: required,
            default_value: defaultValue,
            validation_regex: regex,
            options: options.map((v) => ({ option_label: v, option_value: v })),
            project_ids: projectIds,
          });
          created = true;
        }
      }
      this.fields.set(f.id, entry);
      if (!this.claimed('customfield', f.id)) this.record('customfield', f.id, (entry.TestCase ?? entry.TestSuite)!.id);
      this.tally('custom_fields', created ? 'created' : 'existing');
    }
  }

  /** A project's own special field (keywords, duration), made or found. */
  private async projectField(projectId: string, fieldName: string, label: string, type: CustomFieldType, options: string[]): Promise<CustomFieldDefinition> {
    const repo = new CustomFieldRepository(this.db);
    const found = (await repo.listVisibleToProject(projectId, 'TestCase')).find((d) => d.name === fieldName);
    if (found) {
      if (found.field_type !== type) throw new MigrationError(`Tessick already has a case field '${fieldName}' of type ${found.field_type}; the migration needs it to be ${type}.`);
      const missing = options.filter((o) => !found.options.some((x) => x.option_value === o));
      if (missing.length === 0) return found;
      return (await repo.updateDefinition(found.id, { options: [...found.options, ...missing.map((v) => ({ option_value: v }))].map((o) => ({ option_label: o.option_value, option_value: o.option_value })) }))!;
    }
    return repo.createDefinition({
      entity_type: 'TestCase',
      name: fieldName,
      field_label: label,
      field_type: type,
      options: options.map((v) => ({ option_label: v, option_value: v })),
      project_ids: [projectId],
    });
  }

  /** A value row for one of an entity's fields: TestLink's value, checked; a missing one is stored as empty (unset, not the default). */
  private valueRow(definition: CustomFieldDefinition, entityType: string, entityId: string, raw: unknown, label: string): Record<string, unknown> | undefined {
    const opts = { options: definition.options, validationRegex: definition.validation_regex, isRequired: definition.is_required };
    let typed;
    try {
      typed = parseCustomFieldValue(definition.field_type as CustomFieldType, raw, opts as any);
    } catch (err: any) {
      if (definition.is_required) return undefined; // the default shows
      this.warn(`${label}: the value of '${definition.name}' wasn't kept (${String(err?.message ?? err).replace(/^[A-Z_]+: /, '')}).`);
      typed = parseCustomFieldValue(definition.field_type as CustomFieldType, null, { ...opts, isRequired: false } as any);
    }
    return { id: uuidv7(), custom_field_definition_id: definition.id, entity_type: entityType, entity_id: entityId, ...typed, created_at: this.now, updated_at: this.now };
  }

  // --- A project's content ------------------------------------------------------------------

  private async migrateProjectContent(tlProjectId: number, project: { id: string; prefix: string }) {
    const counts = Object.fromEntries(KINDS.map((k) => [k, this.report.counts[k].created]));
    const fieldValue = new Map(this.data.fieldValues.map((v) => [`${v.field_id}:${v.node_id}`, v.value]));
    const projectFields = [...this.fields.entries()].filter(([, e]) => (e.TestCase ?? e.TestSuite)!.project_ids.includes(project.id) || (e.TestCase ?? e.TestSuite)!.all_projects);
    const valueRows: Record<string, unknown>[] = [];

    // Suites, breadth first, so a parent is written before its children.
    const suiteIds = new Map<number, { id: string; path: string; depth: number }>();
    const suiteRows: Record<string, unknown>[] = [];
    const queue: Array<{ node: TlNode; parent: { id: string; path: string; depth: number } | null }> = this.childrenOf(tlProjectId, TL_NODE.suite).map((node) => ({ node, parent: null }));
    while (queue.length) {
      const { node, parent } = queue.shift()!;
      this.tally('suites', 'testlink');
      const done = this.claimed('suite', node.id);
      let suite: { id: string; path: string; depth: number };
      if (done) {
        const row = await this.db.selectFrom('test_suites').select('path').where('id', '=', done).executeTakeFirst();
        suite = { id: done, path: row?.path ?? `/${done}`, depth: (row?.path ?? '').split('/').length - 1 };
        this.tally('suites', 'existing');
      } else {
        const id = uuidv7();
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > MAX_SUITE_DEPTH) throw new MigrationError(`Suite '${node.name}' (TestLink ${node.id}) is nested ${depth} levels deep; Tessick allows ${MAX_SUITE_DEPTH}.`);
        suite = { id, path: parent ? `${parent.path}/${id}` : `/${id}`, depth };
        suiteRows.push({
          id,
          project_id: project.id,
          parent_suite_id: parent?.id ?? null,
          name: name(node.name) || `Suite ${node.id}`,
          description: clean(this.data.suiteDetails.get(node.id) ?? '') || null,
          position: node.node_order,
          path: suite.path,
          created_at: this.now,
          updated_at: this.now,
        });
        this.record('suite', node.id, id);
        for (const [fieldId, e] of projectFields) {
          if (!e.TestSuite) continue;
          const row = this.valueRow(e.TestSuite, 'TestSuite', id, customFieldValueFromTestLink(e.TestSuite.field_type, fieldValue.get(`${fieldId}:${node.id}`)), `Suite '${node.name}'`);
          if (row) valueRows.push(row);
        }
        this.tally('suites', 'created');
      }
      suiteIds.set(node.id, suite);
      for (const child of this.childrenOf(node.id, TL_NODE.suite)) queue.push({ node: child, parent: suite });
    }
    await this.insertMany('test_suites', suiteRows);

    // Keywords and the estimated duration are fields of the project's own.
    const versionsById = new Map(this.data.versions.map((v) => [v.id, v]));
    const projectKeywords = this.data.keywords.filter((k) => k.testproject_id === tlProjectId);
    let keywordsField: CustomFieldDefinition | undefined;
    const keywordText = new Map<number, string>();
    if (projectKeywords.length) {
      keywordsField = await this.projectField(project.id, TL_KEYWORDS_FIELD, 'Keywords', 'MULTI_SELECT', [...new Set(projectKeywords.map((k) => name(k.keyword)))]);
      for (const k of projectKeywords) {
        this.tally('keywords', 'testlink');
        keywordText.set(k.id, name(k.keyword));
        if (this.claimed('keyword', k.id)) {
          this.tally('keywords', 'existing');
        } else {
          this.record('keyword', k.id, keywordKey(keywordsField.id, name(k.keyword)));
          this.tally('keywords', 'created');
        }
      }
    }
    const caseNodes = [...suiteIds.keys()].flatMap((s) => this.childrenOf(s, TL_NODE.case));
    const hasDuration = caseNodes.some((c) => this.childrenOf(c.id, TL_NODE.version).some((v) => versionsById.get(v.id)?.estimated_exec_duration != null));
    const durationField = hasDuration ? await this.projectField(project.id, TL_DURATION_FIELD, 'Estimated duration (minutes)', 'NUMBER', []) : undefined;

    // Cases, their versions and steps.
    const externalIds = new Set((await this.db.selectFrom('test_cases').select('external_id').where('project_id', '=', project.id).execute()).map((c) => c.external_id));
    const caseRows: Record<string, unknown>[] = [];
    const versionRows: Record<string, unknown>[] = [];
    const stepRows: Record<string, unknown>[] = [];
    const caseIds = new Map<number, string>();
    const stepsById = new Map(this.data.steps.map((s) => [s.id, s]));
    const keywordsOfCase = new Map<number, TestLinkData['caseKeywords']>();
    for (const k of this.data.caseKeywords) keywordsOfCase.set(k.testcase_id, [...(keywordsOfCase.get(k.testcase_id) ?? []), k]);
    for (const c of caseNodes) {
      this.tally('cases', 'testlink');
      const versions = this.childrenOf(c.id, TL_NODE.version)
        .map((n) => versionsById.get(n.id))
        .filter((v): v is NonNullable<typeof v> => Boolean(v))
        .sort((a, b) => a.version - b.version);
      if (versions.length === 0) {
        this.tally('cases', 'skipped');
        this.warn(`Test case '${c.name}' (TestLink ${c.id}) has no versions and wasn't migrated.`);
        continue;
      }
      const latest = versions[versions.length - 1];
      let caseId = this.claimed('case', c.id);
      const newCase = !caseId;
      if (caseId) {
        this.tally('cases', 'existing');
      } else {
        caseId = uuidv7();
        const number = latest.tc_external_id ?? versions.map((v) => v.tc_external_id).find((x) => x !== null) ?? null;
        const externalId = number !== null ? `${project.prefix}-${number}` : `${project.prefix}-TL${c.id}`;
        if (number === null) this.warn(`Test case '${c.name}' (TestLink ${c.id}) has no external id; it's ${externalId}.`);
        if (externalIds.has(externalId)) throw new MigrationError(`Tessick's project ${project.prefix} already has a case ${externalId} that isn't TestLink's.`);
        externalIds.add(externalId);
        caseRows.push({
          id: caseId,
          project_id: project.id,
          test_suite_id: suiteIds.get(c.parent_id)!.id,
          external_id: externalId,
          title: name(c.name) || externalId,
          priority: priorityFromImportance(latest.importance) ?? 'MEDIUM',
          execution_type: latest.execution_type === 2 ? 'AUTOMATED' : 'MANUAL',
          created_at: this.time(versions[0].creation_ts) ?? this.now,
          updated_at: this.time(latest.modification_ts) ?? this.time(latest.creation_ts) ?? this.now,
        });
        this.record('case', c.id, caseId);
        this.tally('cases', 'created');
      }
      caseIds.set(c.id, caseId);

      for (const v of versions) {
        this.tally('versions', 'testlink');
        const doneVersion = this.claimed('version', v.id);
        if (doneVersion) {
          this.versionIds.set(v.id, doneVersion);
          this.tally('versions', 'existing');
          for (const s of this.childrenOf(v.id, TL_NODE.step)) {
            const doneStep = this.claimed('step', s.id);
            if (doneStep) this.stepIds.set(s.id, { id: doneStep, step_number: stepsById.get(s.id)?.step_number ?? 0 });
          }
          continue;
        }
        const versionId = uuidv7();
        const created = this.time(v.creation_ts) ?? this.now;
        versionRows.push({
          id: versionId,
          test_case_id: caseId,
          version_number: v.version,
          status: versionStatusFromTestLink(v.status, v.active),
          summary: clean(v.summary),
          preconditions: clean(v.preconditions),
          author_id: this.users.get(v.author_id) ?? this.actorId,
          reviewer_id: null,
          created_at: created,
          updated_at: this.time(v.modification_ts) ?? created,
        });
        this.record('version', v.id, versionId);
        this.versionIds.set(v.id, versionId);
        this.tally('versions', 'created');
        for (const s of this.childrenOf(v.id, TL_NODE.step)) {
          const step = stepsById.get(s.id);
          if (!step) continue;
          this.tally('steps', 'testlink');
          const stepId = uuidv7();
          stepRows.push({
            id: stepId,
            test_case_version_id: versionId,
            step_number: Math.min(Math.max(step.step_number, 1), MAX_DB_INTEGER),
            action: clean(step.actions),
            expected_result: clean(step.expected_results),
            execution_type: step.execution_type === 2 ? 'AUTOMATED' : 'MANUAL',
            created_at: created,
            updated_at: created,
          });
          this.record('step', s.id, stepId);
          this.stepIds.set(s.id, { id: stepId, step_number: step.step_number });
          this.tally('steps', 'created');
        }
      }

      // Values only for a case this run made: one migrated earlier may have been changed in Tessick.
      if (newCase) {
        const label = `Test case ${project.prefix} '${c.name}'`;
        for (const [fieldId, e] of projectFields) {
          if (!e.TestCase) continue;
          const stored = fieldValue.get(`${fieldId}:${latest.id}`) ?? fieldValue.get(`${fieldId}:${c.id}`);
          const row = this.valueRow(e.TestCase, 'TestCase', caseId, customFieldValueFromTestLink(e.TestCase.field_type, stored), label);
          if (row) valueRows.push(row);
        }
        if (keywordsField) {
          const own = (keywordsOfCase.get(c.id) ?? []).filter((k) => k.tcversion_id === latest.id || !k.tcversion_id);
          const names = [...new Set(own.map((k) => keywordText.get(k.keyword_id)).filter((k): k is string => Boolean(k)))];
          const row = this.valueRow(keywordsField, 'TestCase', caseId, names, label);
          if (row) valueRows.push(row);
        }
        if (durationField && latest.estimated_exec_duration != null) {
          const row = this.valueRow(durationField, 'TestCase', caseId, latest.estimated_exec_duration, label);
          if (row) valueRows.push(row);
        }
      }
    }
    await this.insertMany('test_cases', caseRows);
    await this.insertMany('test_case_versions', versionRows);
    await this.insertMany('test_steps', stepRows);
    await this.insertMany('custom_field_values', valueRows);

    await this.migratePlans(tlProjectId, project, caseIds);
    await this.flushCompat();

    const made = Object.fromEntries(KINDS.map((k) => [k, this.report.counts[k].created - (counts[k] as number)]).filter(([, v]) => (v as number) > 0));
    await this.db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: this.actorId,
        actor_type: 'USER',
        action: 'TESTLINK_MIGRATED',
        resource_type: 'project',
        resource_id: project.id,
        project_id: project.id,
        diff: JSON.stringify({ testlink_project_id: tlProjectId, created: made, dry_run: Boolean(this.opts.dryRun) }),
        ip_address: null,
        user_agent: 'tessick migrate-testlink',
        created_at: this.now,
      })
      .execute();
    this.log(`Project ${project.prefix}: ${JSON.stringify(made)}`);
  }

  // --- Plans, platforms, builds, executions ---------------------------------------------------

  private async migratePlans(tlProjectId: number, project: { id: string; prefix: string }, caseIds: Map<number, string>) {
    const plans = this.data.plans.filter((p) => p.testproject_id === tlProjectId).sort((a, b) => a.id - b.id);
    const keys = new CompatApiKeyRepository(this.db);
    const planIds = new Map<number, string>();
    for (const p of plans) {
      this.tally('plans', 'testlink');
      const done = this.claimed('plan', p.id);
      if (done) {
        planIds.set(p.id, done);
        this.tally('plans', 'existing');
        continue;
      }
      const id = uuidv7();
      await this.db
        .insertInto('test_plans')
        .values({
          id,
          project_id: project.id,
          name: name(this.data.nodes.get(p.id)?.name ?? `Plan ${p.id}`),
          description: clean(p.notes) || null,
          status: planStatusFromTestLink(p.active, p.is_open),
          created_at: this.now,
          updated_at: this.now,
        })
        .execute();
      this.record('plan', p.id, id);
      if (p.api_key) await keys.assign('plan', id, p.api_key);
      planIds.set(p.id, id);
      this.tally('plans', 'created');
    }
    if (planIds.size === 0) return;

    // Plan contents: one link per case (TestLink lists it once per platform).
    const planCases = new Map<string, string>();
    for (const row of await this.db.selectFrom('test_plan_cases').select(['id', 'test_plan_id', 'test_case_id', 'removed_at']).where('test_plan_id', 'in', [...planIds.values()]).execute()) {
      const key = `${row.test_plan_id}:${row.test_case_id}`;
      if (!planCases.has(key) || row.removed_at === null) planCases.set(key, row.id);
    }
    const linkRows: Record<string, unknown>[] = [];
    for (const pv of this.data.planVersions.filter((x) => planIds.has(x.testplan_id)).sort((a, b) => a.node_order - b.node_order)) {
      const planId = planIds.get(pv.testplan_id)!;
      const caseId = caseIds.get(this.versionCase.get(pv.tcversion_id) ?? -1);
      const versionId = this.versionIds.get(pv.tcversion_id);
      if (!caseId || !versionId) continue;
      const key = `${planId}:${caseId}`;
      if (planCases.has(key)) continue;
      this.tally('plan_cases', 'testlink');
      const id = uuidv7();
      linkRows.push({ id, test_plan_id: planId, test_case_id: caseId, test_case_version_id: versionId, position: Math.min(pv.node_order, MAX_DB_INTEGER), created_at: this.now, updated_at: this.now, removed_at: null, removed_by: null });
      planCases.set(key, id);
      this.tally('plan_cases', 'created');
    }
    await this.insertMany('test_plan_cases', linkRows);

    // Platforms: TestLink's, kept for its API; Tessick itself has none.
    const platformIds = new Map<number, { id: string; name: string }>();
    for (const pl of this.data.platforms.filter((x) => x.testproject_id === tlProjectId)) {
      this.tally('platforms', 'testlink');
      const done = this.claimed('platform', pl.id);
      if (done) {
        platformIds.set(pl.id, { id: done, name: pl.name });
        this.tally('platforms', 'existing');
        continue;
      }
      const id = uuidv7();
      await this.db.insertInto('compat_platforms').values({ id, project_id: project.id, name: name(pl.name), notes: clean(pl.notes) || null, created_at: this.now }).execute();
      this.record('platform', pl.id, id);
      platformIds.set(pl.id, { id, name: name(pl.name) });
      this.tally('platforms', 'created');
    }
    const planPlatformRows = this.data.planPlatforms
      .filter((pp) => planIds.has(pp.testplan_id) && platformIds.has(pp.platform_id))
      .map((pp) => ({ test_plan_id: planIds.get(pp.testplan_id)!, platform_id: platformIds.get(pp.platform_id)!.id, created_at: this.now }));
    if (planPlatformRows.length) {
      await this.db.insertInto('compat_plan_platforms').values(planPlatformRows).onConflict((oc) => oc.columns(['test_plan_id', 'platform_id']).doNothing()).execute();
    }

    // Builds are runs.
    const builds = new Map<number, Run>();
    const runRows: Record<string, unknown>[] = [];
    for (const b of this.data.builds.filter((x) => planIds.has(x.testplan_id)).sort((a, z) => a.id - z.id)) {
      this.tally('builds', 'testlink');
      const done = this.claimed('build', b.id);
      if (done) {
        const row = await this.db.selectFrom('test_runs').selectAll().where('id', '=', done).executeTakeFirst();
        if (row) builds.set(b.id, { id: row.id, name: row.name, status: row.status, release_date: row.release_date, created_at: row.created_at, test_plan_id: row.test_plan_id });
        this.tally('builds', 'existing');
        continue;
      }
      const run: Run = {
        id: uuidv7(),
        name: name(b.name) || `Build ${b.id}`,
        status: b.is_open && b.active ? 'OPEN' : 'CLOSED',
        release_date: wallDate(b.release_date) ?? null,
        created_at: this.time(b.creation_ts) ?? this.now,
        test_plan_id: planIds.get(b.testplan_id)!,
      };
      runRows.push({ ...run, description: clean(b.notes) || null, updated_at: run.created_at });
      this.record('build', b.id, run.id);
      builds.set(b.id, run);
      this.tally('builds', 'created');
    }
    await this.insertMany('test_runs', runRows);

    await this.migrateExecutions([...planIds.keys()], planIds, planCases, builds, platformIds);
  }

  private async migrateExecutions(
    tlPlanIds: number[],
    planIds: Map<number, string>,
    planCases: Map<string, string>,
    builds: Map<number, Run>,
    platformIds: Map<number, { id: string; name: string }>
  ) {
    const { executions, steps } = await this.reader.executionsOf(tlPlanIds);
    const stepsOf = new Map<number, typeof steps>();
    for (const s of steps) stepsOf.set(s.execution_id, [...(stepsOf.get(s.execution_id) ?? []), s]);
    const platformRuns = new Map<string, string>();
    const buildRunIds = [...builds.values()].map((b) => b.id);
    if (buildRunIds.length) {
      for (const r of await this.db.selectFrom('compat_platform_runs').selectAll().where('build_run_id', 'in', buildRunIds).execute()) platformRuns.set(`${r.build_run_id}:${r.platform_id}`, r.run_id);
    }
    const unknownCodes = new Map<string, number>();
    const resultRows: Record<string, unknown>[] = [];
    const stepRows: Record<string, unknown>[] = [];
    const linkRows: Record<string, unknown>[] = [];
    const runRows: Record<string, unknown>[] = [];
    const platformRunRows: Record<string, unknown>[] = [];
    let last = 0;

    // Oldest first, so the newest is the case's verdict in its run, as in TestLink.
    const ordered = executions
      .map((e) => ({ e, at: this.time(e.execution_ts) }))
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.e.id - b.e.id);
    for (const { e, at } of ordered) {
      this.tally('executions', 'testlink');
      if (this.claimed('execution', e.id)) {
        this.tally('executions', 'existing');
        continue;
      }
      const verdict = verdictFromTestLink(e.status);
      const build = builds.get(e.build_id);
      const versionId = this.versionIds.get(e.tcversion_id);
      const caseNode = this.versionCase.get(e.tcversion_id);
      const caseRow = caseNode !== undefined ? this.compat.get('node')?.get(caseNode) : undefined;
      if (!verdict) {
        if (e.status.trim().toLowerCase() !== 'n') unknownCodes.set(e.status, (unknownCodes.get(e.status) ?? 0) + 1);
        this.tally('executions', 'skipped');
        continue;
      }
      if (!build || !versionId || !caseRow) {
        this.tally('executions', 'skipped');
        this.warn(`Execution ${e.id} names a build, test case or version that wasn't migrated, so it wasn't.`);
        continue;
      }
      const planId = planIds.get(e.testplan_id)!;
      const caseId = caseRow.id;

      // The run: the build's, or its run for the platform.
      let runId = build.id;
      const platform = e.platform_id ? platformIds.get(e.platform_id) : undefined;
      if (platform) {
        const key = `${build.id}:${platform.id}`;
        runId = platformRuns.get(key) ?? '';
        if (!runId) {
          runId = uuidv7();
          runRows.push({ id: runId, test_plan_id: build.test_plan_id, name: platformRunName(build.name, platform.name), description: null, status: build.status, release_date: build.release_date, created_at: build.created_at, updated_at: build.created_at });
          platformRunRows.push({ build_run_id: build.id, platform_id: platform.id, run_id: runId });
          platformRuns.set(key, runId);
        }
      }

      // The case's link to the plan; one that left the plan is kept, retired, for its history.
      let planCaseId = planCases.get(`${planId}:${caseId}`);
      if (!planCaseId) {
        planCaseId = uuidv7();
        linkRows.push({ id: planCaseId, test_plan_id: planId, test_case_id: caseId, test_case_version_id: versionId, position: 0, created_at: this.now, updated_at: this.now, removed_at: this.now, removed_by: this.actorId });
        planCases.set(`${planId}:${caseId}`, planCaseId);
      }

      const executedAt = at ?? build.created_at;
      const createdMs = Math.max(Date.parse(executedAt), last + 1);
      last = createdMs;
      const createdAt = new Date(createdMs).toISOString();
      const id = uuidv7();
      resultRows.push({
        id,
        test_run_id: runId,
        test_plan_case_id: planCaseId,
        tester_id: this.users.get(e.tester_id) ?? this.actorId,
        status: 'COMPLETED',
        verdict,
        duration_ms: e.execution_duration != null ? Math.min(Math.round(e.execution_duration * 60_000), MAX_DB_INTEGER) : null,
        notes: clean(e.notes) || null,
        failure_message: null,
        stack_trace: null,
        environment: null,
        runner: null,
        source: e.execution_type === 2 ? 'API' : 'UI',
        executed_at: executedAt,
        created_at: createdAt,
        updated_at: createdAt,
      });
      this.record('execution', e.id, id);
      this.tally('executions', 'created');
      for (const s of stepsOf.get(e.id) ?? []) {
        this.tally('step_results', 'testlink');
        const step = this.stepIds.get(s.tcstep_id);
        if (!step) {
          this.tally('step_results', 'skipped');
          continue;
        }
        stepRows.push({ id: uuidv4(), test_result_id: id, test_step_id: step.id, step_number: step.step_number, verdict: stepVerdictFromTestLink(s.status), actual_result: clean(s.notes) || null, created_at: createdAt });
        this.tally('step_results', 'created');
      }
    }
    await this.insertMany('test_runs', runRows);
    await this.insertMany('compat_platform_runs', platformRunRows);
    await this.insertMany('test_plan_cases', linkRows);
    await this.insertMany('test_results', resultRows);
    await this.insertMany('test_step_results', stepRows);
    for (const [code, count] of unknownCodes) this.warn(`${count} executions with the status code '${code}' weren't migrated: Tessick knows p, f and b.`);
  }
}
