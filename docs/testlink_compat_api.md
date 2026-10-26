# TestLink-compatible API

Testify answers the requests of Dave's TestLink REST API (the Slim PHP API on TestLink, in its v1, v2 and custom versions) with TestLink's responses. A script, Postman collection or AI tool written for that API keeps working when it's pointed at Testify. **Only the host changes:**

```
https://testlink.example.com/lib/api/rest/custom/testprojects   (TestLink)
https://testify.example.com/lib/api/rest/custom/testprojects    (Testify)
```

Decided with Elliot (2026-10-26):
- **Drop-in:** the same paths, numeric ids, keys, bodies, responses and errors.
- **A per-user key**, as TestLink's.
- **An approved case edited through this API** gets a new DRAFT, as with MCP. Testify keeps its approval rule.
- **TestLink's whole history is migrated**, keeping its ids.

## Status

Built in phases; each is tested and checked live before the next.

| Phase | What | Status |
| :- | :--- | :--- |
| 1 | Foundations: the three version paths, TestLink API keys, the envelope and errors, `/who`, `/whoAmI`, `/superman` | **Done** |
| 2 | Reads: projects, plans, builds, the suite tree, testspec, custom fields, keywords, case lists with the query layer | **Done** |
| 3 | Writes: projects, plans, builds, suites and cases (create, update, move), keywords, platforms, executions | **Done** |
| 4 | `/testcasemetrics` and `/swagfile` | **Done** |
| 5 | The migration from TestLink's database, keeping its ids and keys; ids kept by the XML importer | To do |
| 6 | The parity check: the same requests against TestLink and Testify, the answers compared | To do |

## Keys

TestLink authenticates with a user's API key (TestLink: My Settings → API interface). In Testify, each user makes theirs in **My Account → TestLink API key**:
- It's shown once. Making a new one replaces it.
- An admin can remove anyone's key (Admin Panel → User Roster → Remove TL Key), and disabling a user removes theirs.
- **Through the API:**
  - `GET`, `POST` and `DELETE /api/v1/auth/me/testlink-key`;
  - `DELETE /api/v1/admin/users/{userId}/testlink-key`.
  - API tokens can't use these routes.

The key is sent as TestLink takes it:
- **v2 and custom:** the `APIKEY` header, or, as a fallback, as the HTTP Basic user name.
- **v1:** only as the HTTP Basic user name (`curl -u "<key>:"`), as TestLink's v1 doesn't read the header.

What a key can do:
- **It acts as its user,** with their permissions in each project (project roles and overrides included). Like a TestLink key, it reaches every project the user can see.
- **It works only on the TestLink-compatible paths.** It isn't a credential for Testify's own API or MCP, whose project-bound tokens are unchanged.
- **Its requests count against the user's rate limit** (1,200 a minute).
- **A missing, wrong or removed key, or a disabled user,** gets TestLink's `400 {"status":"ko","message":"authentication error"}`.

The key is 32 hex characters, like TestLink's. It's stored only as a SHA-256 digest. The migration (phase 5) brings over users' existing TestLink keys, so their scripts keep the keys they have.

## Paths and versions

Every route lives under `/lib/api/rest/v1`, `/lib/api/rest/v2` and `/lib/api/rest/custom`, as on a TestLink server.
- Each version has the routes TestLink's has: custom is a superset of v2, which is a superset of v1.
- A route a version lacks answers TestLink's 404, e.g. `/superman` on v1.

## Responses and errors

- **Success:** TestLink's envelope: `{"status": "ok", "message": "ok", ...}` with `id`, `item`, `items`, `details` or `metrics`. `/who` answers plain text, and `/whoAmI` and `/superman` answer `{"name": ...}`.
- **Refusals:** `{"status": "ko", "message": "..."}`, or `"status": "error"` where TestLink uses it (something not found). A write's refusal carries `id: -1`; a build's adds `details`.
- **HTTP codes:** each route answers with the codes Dave's spec documents for it. TestLink's PHP reports most refusals in the body, with 200, so any other refusal is a 200 too. For example, a duplicate project prefix is `200 {"status":"ko",...,"id":-1}`, as `POST /testprojects` documents no 409. `POST /builds` documents 404 and 409, so it answers them. The exceptions, on every route:
  - an authentication error is always 400;
  - the rate limit is 429, with `Retry-After`;
  - a server error is 500 (its message carries the request id; details go only to the log).

  Each route lists its codes (`statuses` in `testlinkCompat/routes/`), and the contract test checks them against the spec.
- **Answers from Testify's shared checks** (a NUL character, a body over the limit, the rate limit) are rewritten into this envelope.
- **Bodies are read as JSON whatever their `Content-Type`** (or none), as TestLink reads them.

## Reads (phase 2)

| Route | Versions | Answers |
| :--- | :--- | :--- |
| `GET /testprojects` | all | `item`: every project the key's user can see, by name |
| `GET /testprojects/{id}` | all | `item`: one project. `{id}` is its number or name; on v2 and custom also its prefix (names and prefixes ignore case) |
| `GET /testprojects/{id}/testplans` | all | `items`: its plans, by name |
| `GET /testplans/{apikey}/builds` | v2, custom | `items`: the plan's builds (Testify's runs), by name. `{apikey}` is the plan's API key, from the plan list |
| `GET /testprojects/{id}/testcases` | all | `items`: every case's latest version; v2 and custom add `keywords` and `customfields`. With the query layer |
| `GET /testsuites/{id}/testcases` | custom | `items`: the suite's cases (`deep=1`: its sub-suites' too); `customfields=1`, `cfName`/`cfValue`/`cfMatch`, `nosteps=1`. With the query layer |
| `GET /testprojects/{id}/testsuites` | custom | `items`: the suite tree; `includeMeta`, `name` and `match`, `activeOnly`, exclusions |
| `GET /testprojects/{id}/testspec` | custom | `project` and `items`: the suite tree with every case in full |
| `GET /testprojects/{id}/keywords` | custom | `items`: the project's keywords |
| `GET /testprojects/{id}/customfields` | custom | `items`: the project's case custom fields |

**The query layer** (Dave's custom-1.4.0, `packages/core/src/testlink/query.ts`) works as his spec describes:
- filters: `executionType`, `active`, `status`, `importance`, `keyword`, `cfFilters`, and `excludeSuiteNames`/`excludeSuiteIds` (a whole subtree, never a requested root);
- shaping: `fields`, `cfCompact`;
- paging by case id: `limit`/`offset`, with `total`, `returned`, `offset`, `has_more` and the ~1 MB cap;
- counting: `countOnly` and `groupBy` (an unset field groups as `"unset"`);
- `suiteIds` on a project's list.

It engages only when one of its parameters has a value. An empty one (Postman sends them all) counts as not given, so the answer is then `items` alone, in tree order.

**Who sees what:**
- A project is visible when the key's user has `SPEC_VIEW` or `EXECUTE_RUN` there, as in Testify's own project list.
- Its plans and builds need only that.
- Its specification (cases, suites, spec, keywords, custom fields) needs `SPEC_VIEW`; without it the answer is `{"status":"ko","message":"Insufficient rights"}`.
- A project the user can't see reads as not found.

**Choices made without TestLink to compare against** (phase 6 checks each against the real server):
- **Not found:** `{"status":"error","message":"No Test Project identified by 'X'!","item":null}` (or `items`), in TestLink's words. It's a 404 only where Dave's spec documents one (a suite's cases).
- **Empty lists** are `[]`, never `null`. A client that handles `null` handles `[]`, but not the other way round.
- **`tc_external_id`** is the number TestLink keeps on the version (`"12"` for MA-12), as TestLink stores it and as the spec says for the spec dump. Every case list also gives `external_id` (`MA-12`).
- **Extra fields beyond Dave's documented ones** (harmless to clients):
  - `active` on cases;
  - `api_key` on projects and plans, which `/testcasemetrics` and the builds list need;
  - `testproject_id` on plans;
  - `testplan_id` on builds.
- **`groupBy`** answers `total` and `groups`, without `items`, largest group first. A `suite` group carries `suite_id` and `suite` (its name).
- **A case without keywords** has `keywords: {}`.
- **Custom field values:**
  - TestLink's strings, with lists and multi-selects joined with `|`;
  - a checkbox is `"1"` or `"0"`;
  - a date is `YYYY-MM-DD` (TestLink keeps dates as timestamps);
  - a value never set reads as the field's default, as Testify shows it.
- **Custom field types:** TEXT is `string` (0), NUMBER `numeric` (1), CHECKBOX `checkbox` (5), SINGLE_SELECT `list` (6), MULTI_SELECT `multiselection list` (7) and DATE `date` (8).
- **Order:** suites follow their position, and a suite's cases their numeric id. In tree order a suite's own cases come before its sub-suites'.

**Checking the answers against Dave's spec:** `apps/server/tests/testlink_compat_contract.test.ts` checks each read, on every version, against his `openapi.yaml`. It runs when given the file, which isn't in the repository: it's his company's, and holds its project keys and hosts.

```bash
TESTLINK_OPENAPI="/path/to/openapi.yaml" npx vitest run apps/server/tests/testlink_compat_contract.test.ts
```

Every read conforms. Where his spec contradicts itself (the 404 example has `items: null`, but the schema says an array), the answer follows the example.

## Writes (phase 3)

| Route | Versions | Does, in Testify |
| :--- | :--- | :--- |
| `POST /testprojects` | all | creates a project. `active`, `public` and `options` aren't kept |
| `POST /testplans`, `/testplans/{id}` | all | creates or changes a plan. `active: 0` archives it, `active: 1` takes it out of the archive |
| `POST /testplans/{id}/platforms` | v2, custom | links platforms (by name or id) to the plan; answers `{"status": true}`, or `false` with a list of problems |
| `POST /builds`, `/builds/{id}` | v2, custom | creates or changes a run. `testplan` is the plan's number or API key, names are unique in a plan, and `is_open` closes or reopens it |
| `POST /testsuites` | all | creates a suite; `parentID` is the project (or missing) for the top level, or a suite |
| `POST /testcases` | all | creates a case, with its steps, keywords, custom fields and status |
| `POST /testcases/{id}` | custom | changes a case; `{id}` is its number or external id |
| `POST /testcases/{id}/move`, `/testsuites/{id}/move` | custom | moves within the project |
| `POST /executions` | all | records a result |
| `POST /keywords` | v2, custom | adds a keyword to the project |

**Every write goes through Testify's own routes,** as the key's user. So Testify's permissions apply:
- `PROJECT_CREATE`, `PLAN_MANAGE`, `RUN_MANAGE`, `SPEC_CREATE`, `SPEC_EDIT`, `SPEC_APPROVE`, `EXECUTE_RUN` and `EXECUTE_OVERWRITE`;
- custom field values need `PLAN_MANAGE`, as everywhere in Testify;
- keywords need `CUSTOM_FIELD_MANAGE`.

Its validation, audit rows (User-Agent "… (via TestLink API)") and webhooks apply too.

**Cases:**
- **Content is versioned.** Summary, preconditions and steps live in a version that's editable only while it's a draft. So changing them on an approved case makes a new DRAFT copying the latest version, as MCP does (decided with Elliot); `status: 7` in the same request approves it. Title, importance, execution type, custom fields, keywords and the estimated duration change in place.
- **`status` and `active` move the case through Testify's lifecycle:**
  - 7 (final) approves;
  - 5 (obsolete) or `active: 0` deprecates;
  - any other status makes or keeps a draft;
  - `active: 1` restores a deprecated case.

  Approving, deprecating and restoring need `SPEC_APPROVE`, checked before anything changes. A deprecated case's content can't change until it's restored.
- **A new case is a DRAFT when the request gives a draft status** (TestLink's default is 1), even for a user who may auto-approve. Without `status`, Testify's rule applies (`SPEC_AUTO_APPROVE`).
- **HTML is stored as text,** cleaned as the TestLink XML importer does.
- **The author is always the key's user**, since Testify records who made each version. `order` isn't kept, since Testify's cases have no order in a suite.
- **A duplicate title in the suite** is refused (409), as TestLink does.
- **`customFields`:**
  - keys are a field's name or its number, and unknown ones are skipped;
  - values are TestLink's strings, with lists joined with `|`, a checkbox as `1`/`0`, and a date as `YYYY-MM-DD` or a Unix timestamp;
  - every value is checked before the case is created or changed.
- **`keywords`** are keyword numbers: unknown ones are skipped, and `[]` clears them.
- **`estimatedExecDuration`** is written when the project has the `estimated_exec_duration` field.

**Executions:**
- **Recorded as a CI result,** so they never auto-close a run, as TestLink never closes a build.
- **Refused** when the code isn't p, f or b, the build is closed or isn't the plan's, or the case isn't linked to the plan.
- **Re-recording a case** that already has a result in the run needs `EXECUTE_OVERWRITE`.
- **In a plan with platforms,** `platformID` is required. Each (build, platform) has its own run, named "Build — Platform" and made on its first result. The builds list shows only the builds, and changing a build's name or `is_open` changes its platform runs too.
- **Platforms aren't a Testify feature,** and won't be (decided with Elliot, 2026-10-26). Testify has no platform screens, fields or reports. A team that wants to tell platforms apart does it its own way, with runs, plans or custom fields. This API only represents TestLink's platform data in Testify's terms, as plain runs, so TestLink clients and migrated history keep working.

**Keywords** are the options of the project's `keywords` field:
- the first keyword creates the field, for that project;
- a keyword's number follows the field and its text, so it doesn't change when other keywords are added;
- a duplicate is refused, and notes aren't kept.

**Not in Dave's API,** so done in Testify:
- adding cases to a plan;
- making platforms (the migration brings TestLink's, phase 5).

## Metrics and the SWAG file (phase 4)

**`GET /testcasemetrics`** (custom) counts a project's cases by their `automationStatus` custom field (by that internal name):
- **The project** is the one `projectApiKey` names (the `api_key` in the project list), or the one `suiteIds` are in.
  - Neither is a 400.
  - An unknown key, or a project the user can't see, is a 404 (`No Test Project found with API key: …`).
  - Suites from two projects are a 400.
- **The cases** are the query layer's, so the metrics count exactly what the case lists count:
  - the filters (`executionType`, `active`, `status`, `importance`, `keyword`, `cfFilters`);
  - `suiteIds` (each deep);
  - the exclusions.

  A suite named **Deprecated** is left out unless `excludeSuiteNames` is given; an empty value leaves out nothing. A requested suite is never left out.
- **The answer** is `metrics`:
  - `projectName` and `total`;
  - `automation_status`: the five known values (N/A, To Do, In Progress, Done, No), each counted, 0 included. Other values count only in `total`.
  - `testcases_without_automation_status`: case ids, ascending;
  - with `includeExecutionType=1`, `byExecutionType` (`{"1": manual, "2": automated}`) and `automated` (automated and Done);
  - `testCoverageSWAGS`: the SWAG file's entry for the project, without its `productKey`, when one matches.

**`GET` and `POST /swagfile`** (custom) read and replace the SWAG file (testCoverageSWAG.json): per product, coverage estimates and the project API key (`productKey`) that ties it to a project.
- Testify keeps it in `system_settings`.
- `GET` answers it as saved (404 `File not found` before the first save).
- `POST` takes a JSON object and stores it pretty-printed. It answers `{"status":"ok","message":"File saved successfully","bytes_written":…}`; anything else is a 400 `Invalid JSON content`.
- Each save writes a `TESTLINK_SWAG_SAVED` audit row.

**Authentication differs from TestLink (to confirm with Dave):**
- **TestLink serves the file to anyone,** read and write, though it holds every project's API key.
- **Testify asks for a TestLink key** to read it, and also `PLAN_MANAGE` (as a Test Lead has) to replace it.
- **Dave's `manageSWAGS.html`** must therefore send an `APIKEY` header.

## How Testify's model maps (phases 2 to 5)

| TestLink | Testify |
| :--- | :--- |
| test project, suite, case, version, plan | project, suite, case, version, plan. Numeric ids in one sequence, as TestLink's `nodes_hierarchy` |
| build | run |
| execution (`p`/`f`/`b`) | a result (PASSED/FAILED/BLOCKED), recorded as a CI result, so it never auto-closes the run (as in TestLink) |
| importance 1/2/3, execution type 1/2 | LOW/MEDIUM/HIGH (CRITICAL reads as 3), MANUAL/AUTOMATED |
| workflow status 1-7, `active` | draft, review, rework and future → DRAFT; final → APPROVED; obsolete or inactive → DEPRECATED |
| custom fields (12 types; pipe-delimited values) | custom fields (6 types; lists) |
| keywords | a project MULTI_SELECT case field named `keywords`, one option per keyword; it isn't listed among the custom fields |
| `estimated_exec_duration` | a NUMBER case field named `estimated_exec_duration`, when the project has one (otherwise `null`); not listed among the custom fields |
| platforms | not a Testify feature (decided with Elliot): one plain run per (build, platform) when a TestLink plan has platforms |
| project and plan API keys | kept as identifiers (`compat_api_keys`) |

Numeric ids:
- Testify's ids are UUIDs. The numeric ids TestLink clients use live beside them (`compat_ids`).
- A row gets one the first time this API shows it, or it keeps TestLink's own from the migration.
- New ones follow the highest in their space.

**What can't be exact:**
- **Lossy round-trips:** TestLink's review statuses (2, 3, 4, 6) read back as 1.
- **Not stored:**
  - project `options` flags;
  - plan and build `active`/`is_public`;
  - `copytestersfrombuild`;
  - keyword notes.
- **Summaries come back as text, not HTML.**
- **Requirements and attachments** don't exist in Testify.
