import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { createDbClient } from '@tessick/db';
import { kyselySource, type TestLinkSource } from '../src/testlinkMigration/source.js';

/**
 * A TestLink 1.9 database, in memory, for the migration's tests.
 *
 * By default it has only the tables and columns the migration reads, written here (TestLink's
 * own install scripts are GPL, so they aren't copied into Tessick). Given TestLink's
 * install/sql/postgres folder (TESTLINK_SQL_DIR), it loads TestLink's real schema and default
 * data instead, so the same tests prove the migration against them.
 *
 * The data (ids as TestLink would number them):
 *   project 1 "Mobile App" (MA)
 *     suite 40 Authentication
 *       suite 41 Login           case 100 "Login with valid credentials": v1 101 (final, step 102), v2 103 (draft, steps 104, 105)
 *       suite 42 Deprecated      case 110 "Old login": v1 111 (final, inactive)
 *     suite 50 Billing           case 120 "Pay by card": v1 121 (final, automated, 5 min); case 130 "Refund": v1 131 (in review)
 *   plan 200 "Release 2.0" (platforms iOS 1, Android 2; cases 100 at v1, 120, 110), builds 30 (open) and 31 (closed)
 *   plan 210 "Old release" (inactive)
 *   executions 5001-5007 (one with an unknown code, one not run, one of a case not in the plan)
 *   custom fields 7 automationStatus (list), 8 jiraKey (string, on the case node), 9 suiteOwner (on suites),
 *   10 releaseDate (date), 11 colour (radio); keywords 12 smoke, 15 regression
 *   users 1 admin, 7 qa.engineer (tester, with an API key; leader in MA), 8 lead (leader, no email), 9 gone (inactive)
 */

export const QA_KEY = '0123456789abcdef0123456789abcdef';
export const PROJECT_KEY = 'a'.repeat(64);
export const PLAN_KEY = 'b'.repeat(64);

const MINIMAL_SCHEMA = `
CREATE TABLE node_types (id BIGINT PRIMARY KEY, description VARCHAR(100));
CREATE TABLE nodes_hierarchy (id BIGINT PRIMARY KEY, name VARCHAR(100), parent_id BIGINT, node_type_id BIGINT NOT NULL, node_order BIGINT);
CREATE TABLE testprojects (id BIGINT PRIMARY KEY, notes TEXT, active SMALLINT NOT NULL DEFAULT 1, prefix VARCHAR(16) NOT NULL, api_key VARCHAR(64) NOT NULL);
CREATE TABLE testsuites (id BIGINT PRIMARY KEY, details TEXT);
CREATE TABLE tcversions (id BIGINT PRIMARY KEY, tc_external_id INT, version INT NOT NULL DEFAULT 1, status INT NOT NULL DEFAULT 1, summary TEXT, preconditions TEXT,
  importance SMALLINT NOT NULL DEFAULT 2, author_id BIGINT, creation_ts TIMESTAMP NOT NULL DEFAULT now(), modification_ts TIMESTAMP, active SMALLINT NOT NULL DEFAULT 1,
  is_open SMALLINT NOT NULL DEFAULT 1, execution_type SMALLINT NOT NULL DEFAULT 1, estimated_exec_duration NUMERIC(6,2));
CREATE TABLE tcsteps (id BIGINT PRIMARY KEY, step_number INT NOT NULL DEFAULT 1, actions TEXT, expected_results TEXT, active SMALLINT NOT NULL DEFAULT 1, execution_type SMALLINT NOT NULL DEFAULT 1);
CREATE TABLE testplans (id BIGINT PRIMARY KEY, testproject_id BIGINT NOT NULL, notes TEXT, active SMALLINT NOT NULL DEFAULT 1, is_open SMALLINT NOT NULL DEFAULT 1, is_public SMALLINT NOT NULL DEFAULT 1, api_key VARCHAR(64) NOT NULL);
CREATE TABLE testplan_tcversions (id BIGSERIAL PRIMARY KEY, testplan_id BIGINT NOT NULL, tcversion_id BIGINT NOT NULL, platform_id BIGINT NOT NULL DEFAULT 0, node_order BIGINT NOT NULL DEFAULT 1);
CREATE TABLE builds (id BIGINT PRIMARY KEY, testplan_id BIGINT NOT NULL, name VARCHAR(100) NOT NULL, notes TEXT, active SMALLINT NOT NULL DEFAULT 1, is_open SMALLINT NOT NULL DEFAULT 1,
  author_id BIGINT, creation_ts TIMESTAMP NOT NULL DEFAULT now(), release_date DATE);
CREATE TABLE platforms (id BIGINT PRIMARY KEY, name VARCHAR(100) NOT NULL, testproject_id BIGINT NOT NULL, notes TEXT NOT NULL);
CREATE TABLE testplan_platforms (id BIGSERIAL PRIMARY KEY, testplan_id BIGINT NOT NULL, platform_id BIGINT NOT NULL);
CREATE TABLE keywords (id BIGINT PRIMARY KEY, keyword VARCHAR(100) NOT NULL, testproject_id BIGINT NOT NULL, notes TEXT);
CREATE TABLE testcase_keywords (id BIGSERIAL PRIMARY KEY, testcase_id BIGINT NOT NULL, tcversion_id BIGINT NOT NULL, keyword_id BIGINT NOT NULL);
CREATE TABLE custom_fields (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL, label VARCHAR(64) NOT NULL, type SMALLINT NOT NULL DEFAULT 0, possible_values VARCHAR(4000) NOT NULL DEFAULT '',
  default_value VARCHAR(4000) NOT NULL DEFAULT '', valid_regexp VARCHAR(255) NOT NULL DEFAULT '');
CREATE TABLE cfield_node_types (field_id INT NOT NULL, node_type_id INT NOT NULL);
CREATE TABLE cfield_testprojects (field_id BIGINT NOT NULL, testproject_id BIGINT NOT NULL, required SMALLINT NOT NULL DEFAULT 0);
CREATE TABLE cfield_design_values (field_id INT NOT NULL, node_id INT NOT NULL, value VARCHAR(4000) NOT NULL DEFAULT '');
CREATE TABLE roles (id BIGINT PRIMARY KEY, description VARCHAR(100) NOT NULL);
CREATE TABLE rights (id BIGINT PRIMARY KEY, description VARCHAR(100) NOT NULL);
CREATE TABLE role_rights (role_id INT NOT NULL, right_id INT NOT NULL);
CREATE TABLE users (id BIGINT PRIMARY KEY, login VARCHAR(100) NOT NULL, password VARCHAR(255) NOT NULL DEFAULT '', role_id SMALLINT NOT NULL DEFAULT 0, email VARCHAR(100) NOT NULL DEFAULT '',
  active SMALLINT NOT NULL DEFAULT 1, script_key VARCHAR(32), cookie_string VARCHAR(64) NOT NULL DEFAULT '', creation_ts TIMESTAMP NOT NULL DEFAULT now());
CREATE TABLE user_testproject_roles (user_id INT NOT NULL, testproject_id INT NOT NULL, role_id INT NOT NULL);
CREATE TABLE executions (id BIGINT PRIMARY KEY, build_id INT NOT NULL, tester_id BIGINT, execution_ts TIMESTAMP, status CHAR(1), testplan_id BIGINT NOT NULL, tcversion_id BIGINT NOT NULL,
  tcversion_number INT NOT NULL DEFAULT 1, platform_id BIGINT NOT NULL DEFAULT 0, execution_type SMALLINT NOT NULL DEFAULT 1, execution_duration NUMERIC(6,2), notes TEXT);
CREATE TABLE execution_tcsteps (id BIGSERIAL PRIMARY KEY, execution_id INT NOT NULL, tcstep_id INT NOT NULL, notes TEXT, status CHAR(1));
INSERT INTO node_types (id, description) VALUES (1,'testproject'),(2,'testsuite'),(3,'testcase'),(4,'testcase_version'),(5,'testplan'),(9,'testcase_step');
INSERT INTO roles (id, description) VALUES (3,'<no rights>'),(5,'guest'),(7,'tester'),(8,'admin'),(9,'leader');
INSERT INTO rights (id, description) VALUES (1,'testplan_execute'),(4,'testplan_planning'),(6,'mgt_view_tc'),(7,'mgt_modify_tc'),(13,'mgt_users');
INSERT INTO role_rights (role_id, right_id) VALUES (5,6),(7,1),(7,6),(7,7),(8,13),(9,1),(9,4),(9,6),(9,7);
INSERT INTO users (id, login, role_id, email) VALUES (1, 'admin', 8, 'admin@example.com');
`;

/** The sample data, as rows TestLink's own schema accepts too (columns named, the rest left to their defaults). */
const DATA = `
INSERT INTO users (id, login, password, role_id, email, active, script_key, cookie_string, creation_ts) VALUES
  (7, 'qa.engineer', 'x', 7, 'qa@example.com', 1, '${QA_KEY}', 'cookie-7', '2024-01-02 09:00:00'),
  (8, 'lead', 'x', 9, '', 1, NULL, 'cookie-8', '2024-01-02 09:00:00'),
  (9, 'gone', 'x', 7, 'gone@example.com', 0, '${'c'.repeat(32)}', 'cookie-9', '2024-01-02 09:00:00');

INSERT INTO nodes_hierarchy (id, name, parent_id, node_type_id, node_order) VALUES
  (1, 'Mobile App', NULL, 1, 1),
  (40, 'Authentication', 1, 2, 1), (41, 'Login', 40, 2, 1), (42, 'Deprecated', 40, 2, 2), (50, 'Billing', 1, 2, 2),
  (100, 'Login with valid credentials', 41, 3, 1), (101, '', 100, 4, 0), (102, '', 101, 9, 0), (103, '', 100, 4, 0), (104, '', 103, 9, 0), (105, '', 103, 9, 0),
  (110, 'Old login', 42, 3, 1), (111, '', 110, 4, 0),
  (120, 'Pay by card', 50, 3, 1), (121, '', 120, 4, 0),
  (130, 'Refund', 50, 3, 2), (131, '', 130, 4, 0),
  (200, 'Release 2.0', 1, 5, 0), (210, 'Old release', 1, 5, 0);
INSERT INTO testprojects (id, notes, active, prefix, api_key) VALUES (1, '<p>Phones &amp; tablets</p>', 1, 'MA', '${PROJECT_KEY}');
INSERT INTO user_testproject_roles (user_id, testproject_id, role_id) VALUES (7, 1, 9);
INSERT INTO testsuites (id, details) VALUES (40, '<p>Signing in</p>'), (41, ''), (42, ''), (50, '');
INSERT INTO tcversions (id, tc_external_id, version, status, summary, preconditions, importance, author_id, creation_ts, active, execution_type, estimated_exec_duration) VALUES
  (101, 1, 1, 7, '<p>Verify login</p>', '<p>An account</p>', 3, 7, '2024-02-01 10:00:00', 1, 1, NULL),
  (103, 1, 2, 1, '<p>Verify login, v2</p>', '', 3, 8, '2024-03-01 10:00:00', 1, 1, NULL),
  (111, 2, 1, 7, 'Old', '', 1, 7, '2024-02-01 10:00:00', 0, 2, NULL),
  (121, 3, 1, 7, 'Card payment', '', 2, 7, '2024-02-01 10:00:00', 1, 2, 5.00),
  (131, 4, 1, 3, 'Refund', '', 1, NULL, '2024-02-01 10:00:00', 1, 1, NULL);
INSERT INTO tcsteps (id, step_number, actions, expected_results, execution_type) VALUES
  (102, 1, '<p>Open the login page</p>', '<p>The form shows</p>', 1),
  (104, 1, 'Open the login page', 'The form shows', 1),
  (105, 2, 'Sign in', 'The dashboard shows', 2);
INSERT INTO testplans (id, testproject_id, notes, active, is_open, api_key) VALUES (200, 1, 'Full regression', 1, 1, '${PLAN_KEY}'), (210, 1, '', 0, 0, '${'d'.repeat(64)}');
INSERT INTO platforms (id, name, testproject_id, notes) VALUES (1, 'iOS', 1, ''), (2, 'Android', 1, '');
INSERT INTO testplan_platforms (testplan_id, platform_id) VALUES (200, 1), (200, 2);
INSERT INTO testplan_tcversions (testplan_id, tcversion_id, platform_id, node_order) VALUES (200, 101, 1, 10), (200, 101, 2, 10), (200, 121, 1, 20), (200, 111, 1, 30);
INSERT INTO builds (id, testplan_id, name, notes, active, is_open, creation_ts, release_date) VALUES
  (30, 200, 'Build 2.0.1', 'Nightly', 1, 1, '2024-06-01 08:00:00', '2024-06-01'),
  (31, 200, 'Build 2.0.0', '', 1, 0, '2024-05-01 08:00:00', NULL);
INSERT INTO executions (id, build_id, tester_id, execution_ts, status, testplan_id, tcversion_id, platform_id, execution_type, execution_duration, notes) VALUES
  (5001, 30, 7, '2024-06-02 10:00:00', 'p', 200, 101, 1, 1, NULL, '<p>Fine on iOS</p>'),
  (5002, 30, 7, '2024-06-02 10:05:00', 'f', 200, 101, 2, 1, NULL, 'Broken on Android'),
  (5003, 30, 99, '2024-06-02 11:00:00', 'b', 200, 121, 1, 2, 2.50, ''),
  (5004, 31, 7, '2024-05-02 10:00:00', 'p', 200, 101, 1, 1, NULL, ''),
  (5005, 30, 7, '2024-06-03 10:00:00', 'x', 200, 121, 1, 1, NULL, ''),
  (5006, 30, 7, '2024-06-03 10:00:00', 'n', 200, 121, 1, 1, NULL, ''),
  (5007, 30, 7, '2024-06-03 11:00:00', 'p', 200, 131, 1, 1, NULL, 'Not in the plan any more');
INSERT INTO execution_tcsteps (execution_id, tcstep_id, notes, status) VALUES (5001, 102, 'Shown', 'p'), (5002, 102, 'Crashed', 'f');
INSERT INTO custom_fields (id, name, label, type, possible_values, default_value, valid_regexp) VALUES
  (7, 'automationStatus', 'Automation Status', 6, 'N/A|To Do|In Progress|Done|No', 'N/A', ''),
  (8, 'jiraKey', 'Jira key', 0, '', '', ''),
  (9, 'suiteOwner', 'Owner', 0, '', '', ''),
  (10, 'releaseDate', 'Release date', 8, '', '', ''),
  (11, 'colour', 'Colour', 9, 'red|blue', '', '');
INSERT INTO cfield_node_types (field_id, node_type_id) VALUES (7, 3), (8, 3), (9, 2), (10, 3), (11, 3);
INSERT INTO cfield_testprojects (field_id, testproject_id, required) VALUES (7, 1, 0), (8, 1, 0), (9, 1, 0), (10, 1, 0), (11, 1, 0);
INSERT INTO cfield_design_values (field_id, node_id, value) VALUES
  (7, 103, 'Done'), (7, 121, 'To Do'), (7, 111, 'Done'), (8, 120, 'MA-999'), (9, 50, 'Billing team'), (10, 121, '1780272000'), (11, 103, 'blue'), (7, 101, 'Maybe');
INSERT INTO keywords (id, keyword, testproject_id, notes) VALUES (12, 'smoke', 1, 'Smoke tests'), (15, 'regression', 1, '');
INSERT INTO testcase_keywords (testcase_id, tcversion_id, keyword_id) VALUES (100, 103, 12), (120, 121, 15), (100, 101, 15);
`;

/** Runs a script of statements one by one (TestLink's scripts have comments and many statements). */
async function runScript(db: Kysely<any>, script: string) {
  const statements = script
    .replace(/\/\*prefix\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.raw(statement).execute(db);
}

export interface TestLinkFixture {
  db: Kysely<any>;
  source: TestLinkSource;
  run: (statements: string) => Promise<void>;
  /** Whether TestLink's own schema was loaded (TESTLINK_SQL_DIR). */
  fullSchema: boolean;
}

export async function testLinkSourceFixture(): Promise<TestLinkFixture> {
  const db = createDbClient() as Kysely<any>;
  const dir = process.env.TESTLINK_SQL_DIR;
  if (dir) {
    await runScript(db, readFileSync(join(dir, 'testlink_create_tables.sql'), 'utf8'));
    await runScript(db, readFileSync(join(dir, 'testlink_create_default_data.sql'), 'utf8'));
  } else {
    await runScript(db, MINIMAL_SCHEMA);
  }
  await runScript(db, DATA);
  return { db, source: kyselySource(db), run: (s) => runScript(db, s), fullSchema: Boolean(dir) };
}
