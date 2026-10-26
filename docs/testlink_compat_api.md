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
| 3 | Writes: projects, plans, builds, suites and cases (create, update, move), keywords, platforms, executions | To do |
| 4 | `/testcasemetrics` and `/swagfile` | To do |
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
- **Errors:** `{"status": "ko", "message": "..."}`.
  - 400 for authentication or a bad request;
  - 403 for missing rights;
  - 404 for not found;
  - 409 for a conflict (`id: -1`);
  - 429 when over the rate limit (with `Retry-After`);
  - 500 for a server error (the message carries the request id; details go only to the log).
- **Answers from Testify's shared checks** (a NUL character, a body over the limit, the rate limit) are rewritten into this envelope.

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
- Its specification (cases, suites, spec, keywords, custom fields) needs `SPEC_VIEW`; without it the answer is `403 {"status":"ko","message":"Insufficient rights"}`.
- A project the user can't see reads as not found.

**Choices made without TestLink to compare against** (phase 6 checks each against the real server):
- **Not found:** `404 {"status":"error","message":"No Test Project identified by 'X'!","item":null}` (or `items`), as Dave's spec documents for a suite. TestLink's own code may answer such errors with 200.
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
| platforms | one run per (build, platform) when a plan has platforms |
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
