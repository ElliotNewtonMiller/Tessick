import { TL_NODE } from '@testify/core';
import type { TestLinkSource } from './source.js';

/**
 * Reads what the migration needs from a TestLink 1.9 database (its tables, as TestLink's
 * install/sql scripts create them). Every number comes back as a JS number and every row as a
 * plain object, whichever database and driver it came from (PostgreSQL's driver gives BIGINTs
 * as strings, MySQL's dates as text).
 */

const n = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export interface TlNode {
  id: number;
  name: string;
  parent_id: number;
  node_type_id: number;
  node_order: number;
}

export interface TestLinkData {
  nodes: Map<number, TlNode>;
  projects: Array<{ id: number; notes: string; active: number; prefix: string; api_key: string }>;
  suiteDetails: Map<number, string>;
  versions: Array<{
    id: number;
    tc_external_id: number | null;
    version: number;
    status: number;
    summary: string;
    preconditions: string;
    importance: number;
    author_id: number;
    creation_ts: unknown;
    modification_ts: unknown;
    active: number;
    execution_type: number;
    estimated_exec_duration: number | null;
  }>;
  steps: Array<{ id: number; step_number: number; actions: string; expected_results: string; execution_type: number }>;
  plans: Array<{ id: number; testproject_id: number; notes: string; active: number; is_open: number; api_key: string }>;
  planVersions: Array<{ testplan_id: number; tcversion_id: number; platform_id: number; node_order: number }>;
  builds: Array<{ id: number; testplan_id: number; name: string; notes: string; active: number; is_open: number; creation_ts: unknown; release_date: unknown }>;
  platforms: Array<{ id: number; name: string; testproject_id: number; notes: string }>;
  planPlatforms: Array<{ testplan_id: number; platform_id: number }>;
  keywords: Array<{ id: number; keyword: string; testproject_id: number }>;
  caseKeywords: Array<{ testcase_id: number; tcversion_id: number; keyword_id: number }>;
  customFields: Array<{ id: number; name: string; label: string; type: number; possible_values: string; default_value: string; valid_regexp: string }>;
  fieldNodeTypes: Array<{ field_id: number; node_type_id: number }>;
  fieldProjects: Array<{ field_id: number; testproject_id: number; required: number }>;
  fieldValues: Array<{ field_id: number; node_id: number; value: string }>;
  users: Array<{ id: number; login: string; email: string; role_id: number; active: number; script_key: string; creation_ts: unknown }>;
  roles: Array<{ id: number; description: string }>;
  roleRights: Array<{ role_id: number; right: string }>;
  projectRoles: Array<{ user_id: number; testproject_id: number; role_id: number }>;
  /** What exists in TestLink but not in Testify, so it's counted, not migrated. */
  notMigrated: { requirements: number; attachments: number };
}

export interface TestLinkExecution {
  id: number;
  build_id: number;
  tester_id: number;
  execution_ts: unknown;
  status: string;
  testplan_id: number;
  tcversion_id: number;
  platform_id: number;
  execution_type: number;
  execution_duration: number | null;
  notes: string;
}

export interface TestLinkStepResult {
  execution_id: number;
  tcstep_id: number;
  notes: string;
  status: string;
}

export class TestLinkReader {
  constructor(
    private source: TestLinkSource,
    /** TestLink's optional table prefix (DB_TABLE_PREFIX). */
    private prefix = ''
  ) {}

  private t(name: string) {
    return `${this.prefix}${name}`;
  }

  private async rows(text: string) {
    return this.source.query(text);
  }

  private async count(text: string): Promise<number> {
    try {
      return n((await this.rows(text))[0]?.c);
    } catch {
      return 0; // A table an older TestLink doesn't have.
    }
  }

  async readAll(): Promise<TestLinkData> {
    const t = (name: string) => this.t(name);
    const types = [TL_NODE.project, TL_NODE.suite, TL_NODE.case, TL_NODE.version, TL_NODE.plan, TL_NODE.step].join(',');
    const nodes = new Map<number, TlNode>();
    for (const r of await this.rows(`SELECT id, name, parent_id, node_type_id, node_order FROM ${t('nodes_hierarchy')} WHERE node_type_id IN (${types})`)) {
      nodes.set(n(r.id), { id: n(r.id), name: str(r.name), parent_id: n(r.parent_id), node_type_id: n(r.node_type_id), node_order: n(r.node_order) });
    }
    return {
      nodes,
      projects: (await this.rows(`SELECT id, notes, active, prefix, api_key FROM ${t('testprojects')}`)).map((r) => ({
        id: n(r.id),
        notes: str(r.notes),
        active: n(r.active),
        prefix: str(r.prefix),
        api_key: str(r.api_key),
      })),
      suiteDetails: new Map((await this.rows(`SELECT id, details FROM ${t('testsuites')}`)).map((r) => [n(r.id), str(r.details)])),
      versions: (
        await this.rows(
          `SELECT id, tc_external_id, version, status, summary, preconditions, importance, author_id, creation_ts, modification_ts, active, execution_type, estimated_exec_duration FROM ${t('tcversions')}`
        )
      ).map((r) => ({
        id: n(r.id),
        tc_external_id: num(r.tc_external_id),
        version: n(r.version),
        status: n(r.status),
        summary: str(r.summary),
        preconditions: str(r.preconditions),
        importance: n(r.importance),
        author_id: n(r.author_id),
        creation_ts: r.creation_ts,
        modification_ts: r.modification_ts,
        active: n(r.active),
        execution_type: n(r.execution_type),
        estimated_exec_duration: num(r.estimated_exec_duration),
      })),
      steps: (await this.rows(`SELECT id, step_number, actions, expected_results, execution_type FROM ${t('tcsteps')}`)).map((r) => ({
        id: n(r.id),
        step_number: n(r.step_number),
        actions: str(r.actions),
        expected_results: str(r.expected_results),
        execution_type: n(r.execution_type),
      })),
      plans: (await this.rows(`SELECT id, testproject_id, notes, active, is_open, api_key FROM ${t('testplans')}`)).map((r) => ({
        id: n(r.id),
        testproject_id: n(r.testproject_id),
        notes: str(r.notes),
        active: n(r.active),
        is_open: n(r.is_open),
        api_key: str(r.api_key),
      })),
      planVersions: (await this.rows(`SELECT testplan_id, tcversion_id, platform_id, node_order FROM ${t('testplan_tcversions')}`)).map((r) => ({
        testplan_id: n(r.testplan_id),
        tcversion_id: n(r.tcversion_id),
        platform_id: n(r.platform_id),
        node_order: n(r.node_order),
      })),
      builds: (await this.rows(`SELECT id, testplan_id, name, notes, active, is_open, creation_ts, release_date FROM ${t('builds')}`)).map((r) => ({
        id: n(r.id),
        testplan_id: n(r.testplan_id),
        name: str(r.name),
        notes: str(r.notes),
        active: n(r.active),
        is_open: n(r.is_open),
        creation_ts: r.creation_ts,
        release_date: r.release_date,
      })),
      platforms: (await this.rows(`SELECT id, name, testproject_id, notes FROM ${t('platforms')}`)).map((r) => ({
        id: n(r.id),
        name: str(r.name),
        testproject_id: n(r.testproject_id),
        notes: str(r.notes),
      })),
      planPlatforms: (await this.rows(`SELECT testplan_id, platform_id FROM ${t('testplan_platforms')}`)).map((r) => ({ testplan_id: n(r.testplan_id), platform_id: n(r.platform_id) })),
      keywords: (await this.rows(`SELECT id, keyword, testproject_id FROM ${t('keywords')}`)).map((r) => ({ id: n(r.id), keyword: str(r.keyword), testproject_id: n(r.testproject_id) })),
      caseKeywords: (await this.rows(`SELECT testcase_id, tcversion_id, keyword_id FROM ${t('testcase_keywords')}`)).map((r) => ({
        testcase_id: n(r.testcase_id),
        tcversion_id: n(r.tcversion_id),
        keyword_id: n(r.keyword_id),
      })),
      customFields: (await this.rows(`SELECT id, name, label, type, possible_values, default_value, valid_regexp FROM ${t('custom_fields')}`)).map((r) => ({
        id: n(r.id),
        name: str(r.name),
        label: str(r.label),
        type: n(r.type),
        possible_values: str(r.possible_values),
        default_value: str(r.default_value),
        valid_regexp: str(r.valid_regexp),
      })),
      fieldNodeTypes: (await this.rows(`SELECT field_id, node_type_id FROM ${t('cfield_node_types')}`)).map((r) => ({ field_id: n(r.field_id), node_type_id: n(r.node_type_id) })),
      fieldProjects: (await this.rows(`SELECT field_id, testproject_id, required FROM ${t('cfield_testprojects')}`)).map((r) => ({
        field_id: n(r.field_id),
        testproject_id: n(r.testproject_id),
        required: n(r.required),
      })),
      fieldValues: (await this.rows(`SELECT field_id, node_id, value FROM ${t('cfield_design_values')}`)).map((r) => ({ field_id: n(r.field_id), node_id: n(r.node_id), value: str(r.value) })),
      users: (await this.rows(`SELECT id, login, email, role_id, active, script_key, creation_ts FROM ${t('users')}`)).map((r) => ({
        id: n(r.id),
        login: str(r.login).trim(),
        email: str(r.email).trim(),
        role_id: n(r.role_id),
        active: n(r.active),
        script_key: str(r.script_key).trim(),
        creation_ts: r.creation_ts,
      })),
      roles: (await this.rows(`SELECT id, description FROM ${t('roles')}`)).map((r) => ({ id: n(r.id), description: str(r.description) })),
      roleRights: (
        await this.rows(`SELECT rr.role_id, r.description FROM ${t('role_rights')} rr JOIN ${t('rights')} r ON r.id = rr.right_id`)
      ).map((r) => ({ role_id: n(r.role_id), right: str(r.description) })),
      projectRoles: (await this.rows(`SELECT user_id, testproject_id, role_id FROM ${t('user_testproject_roles')}`)).map((r) => ({
        user_id: n(r.user_id),
        testproject_id: n(r.testproject_id),
        role_id: n(r.role_id),
      })),
      notMigrated: {
        requirements: await this.count(`SELECT COUNT(*) AS c FROM ${t('nodes_hierarchy')} WHERE node_type_id IN (6, 7)`),
        attachments: await this.count(`SELECT COUNT(*) AS c FROM ${t('attachments')}`),
      },
    };
  }

  /** A set of plans' executions, oldest first, with their step results. */
  async executionsOf(planIds: number[]): Promise<{ executions: TestLinkExecution[]; steps: TestLinkStepResult[] }> {
    if (planIds.length === 0) return { executions: [], steps: [] };
    const list = planIds.map((id) => Number(id)).join(',');
    const executions = (
      await this.rows(
        `SELECT id, build_id, tester_id, execution_ts, status, testplan_id, tcversion_id, platform_id, execution_type, execution_duration, notes FROM ${this.t('executions')} WHERE testplan_id IN (${list}) ORDER BY id`
      )
    ).map((r) => ({
      id: n(r.id),
      build_id: n(r.build_id),
      tester_id: n(r.tester_id),
      execution_ts: r.execution_ts,
      status: str(r.status),
      testplan_id: n(r.testplan_id),
      tcversion_id: n(r.tcversion_id),
      platform_id: n(r.platform_id),
      execution_type: n(r.execution_type),
      execution_duration: num(r.execution_duration),
      notes: str(r.notes),
    }));
    const steps = (
      await this.rows(
        `SELECT s.execution_id, s.tcstep_id, s.notes, s.status FROM ${this.t('execution_tcsteps')} s JOIN ${this.t('executions')} e ON e.id = s.execution_id WHERE e.testplan_id IN (${list})`
      )
    ).map((r) => ({ execution_id: n(r.execution_id), tcstep_id: n(r.tcstep_id), notes: str(r.notes), status: str(r.status) }));
    return { executions, steps };
  }
}
