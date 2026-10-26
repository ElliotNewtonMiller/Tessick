# API & MCP Roadmap

The next steps for Testify's API and MCP endpoint, with recommendations, open questions and status. Keep it current as the work happens:
- update each step's **Status** line;
- record decisions in the **Decisions** table;
- add each finished change to `docs/changelog.md` as usual.

Status values: **Not started**, **Planning**, **In progress**, **Done**, **Dropped**.

---

## Where the API stands (2026-10-12)

**Good:**
- **Coverage:** 118 endpoints cover nearly everything the web app does: projects, suites, cases and versions, plans, runs, results, search, import, export, custom fields, admin, API tokens, reports and report emails. The web app itself uses these endpoints, so anything you can click, a script can do.
- **Security:** project-bound API tokens (`tf_ci_...`), permissions checked per project, rate limits and an audit log (RFC 04).
- **CI:** a build uploads its JUnit XML report as it is (up to 20,000 tests), or sends JSON batches of up to 5,000 results, into a run named after the build (step 5).
- **Consistent** (step 1, 2026-10-12): one address style, verbs and status codes, one error format, one name per id, "runs" and "results" throughout.
- **Webhooks:** a project's events reach Slack, CI or your own code as they happen, signed, with retries (step 7).
- **Agents:** `POST /mcp` lets them list projects, search and read cases, run every report, and (with the right token) write cases as DRAFTs, manage plans and record results.

**Weak:**
1. ~~**Mostly undocumented.**~~ Every route is on `/docs` with its fields, allowed values and errors (step 3), with a getting-started guide ([api_getting_started.md](api_getting_started.md)), the conventions in RFC 03 §1-4 and the reports in [reports_api_and_mcp.md](reports_api_and_mcp.md).
2. ~~**Inconsistent, because it grew feature by feature.**~~ Fixed by step 1 (2026-10-11/12). Before, some addresses sat under a project and others didn't, errors came in two shapes, and runs were `builds` in addresses and fields.
3. ~~**No paging.**~~ The lists that grow (a project's cases, a run's results, the audit log, case history) are paged with `limit`/`cursor` (step 4, 2026-10-12). Short lists stay whole.
4. ~~**No machine-readable description.**~~ The OpenAPI spec (`/docs/json`) and docs page (`/docs`) cover every route (step 3). Report outputs are described only at the top level so far.
5. ~~**Agents can only read.**~~ MCP write tools create and edit cases (as DRAFTs), manage plans, start runs and record results, as the caller (step 6, 2026-10-12).
6. ~~**Reads are coarse.**~~ Single items by id, a run's results, a project's cases, version history, and readable ids (SHOP-12) wherever a case id is taken (step 8, 2026-10-12).
7. ~~**API tokens reach global admin routes.**~~ Fixed 2026-10-12 (see below).

---

## Background: what an OpenAPI spec and a "try it" page are

An **OpenAPI spec** is one structured file in a standard format that describes every endpoint:
- the address and verb;
- what it needs (parameters and body, with types, limits and required fields);
- what it returns, with examples;
- its possible errors;
- which permission it requires.

Many tools read that format, so the one file gives:
1. **A documentation page** served by Testify itself (e.g. `/docs`), generated from the file.
2. **"Try it":** on that page, paste an API token, fill in a form for any endpoint, press Send, and see the real answer.
3. **Client libraries:** tools can generate Python, TypeScript or other code for calling the API.
4. **Imports into other tools and agents,** which can read the file to understand the whole API.
5. **Docs that can't go stale:** tests check the server's real answers against the file.

**How it fits Testify:** Fastify (the server framework) has an official plugin that builds the spec from a description (a JSON schema) attached to each route, and another plugin serves the page: Swagger UI, or Scalar. No route has a schema yet; input is checked by hand-written code. Adding schemas route by route is the main work. The same schemas then also do the input checking, so documentation and behavior can't disagree.

---

## Fixed first: API tokens on global admin routes

**Status:** Done (2026-10-12), both parts. Found the same day.

**The problem.** An API token is bound to one project, and the docs promise that binding is "checked centrally for every route". It's only checked when the request names a project. The admin routes (users, roles, custom fields, email settings, the audit log) don't name one, so the binding doesn't apply there. A token whose capabilities include an admin permission works across the whole system. Checked with a token made for one project holding `USER_MANAGE` and `CUSTOM_FIELD_MANAGE`; it could:
- list every user (names, emails, roles, permissions);
- read the whole Security Audit Log, every project's entries included;
- create users, though only with the empty No Access role, since the guard limits it to permissions it has globally (none);
- create a global custom field, which appears in every project and is written into every existing case if it has a default.

**Why it matters even though someone had to grant the permission.** The token does need the permission, granted by someone who holds it. But:
- **Who can grant it:** a token's ceiling is its issuer's permissions *in that project*. Someone who is an admin only in one project (a project role) can therefore make a token that does these things everywhere, which they can't do themselves.
- **Wider reach than the label:** the token is listed under one project's API Tokens and looks project-bound, so a leaked CI token can do far more than its owner expects.

**Recommendation:** refuse API tokens on every route that doesn't belong to a project (`/admin/...`), and stop offering admin-only permissions (`USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, and any others that only gate global routes) as token capabilities. Admin automation, if wanted later, gets its own kind of credential.

**What was done (decided with Elliot: both):**
- **Tokens refused outside a project.** Any route whose address names no project item answers a token with `403 TOKEN_NOT_ALLOWED`: every `/admin/...` route, creating a project, changing your own account. It's deny by default (`tokenMayUseRoute` in `middleware/auth.ts`), so a new route of this kind is closed to tokens without anyone remembering to list it. The exceptions stay within the token's project anyway: `GET /auth/me`, `GET /projects` (only its own project) and `/mcp` (each tool call checks its project).
- **System-wide permissions can't be given to a token:** `USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, `PROJECT_CREATE` and `API_TOKEN_MANAGE` (a token's own tokens would never work, since their issuer isn't a user), on top of `SYSTEM_ADMIN`. Asking for one is `400 CAPABILITY_NOT_GRANTABLE`, the API Tokens tab no longer offers them, and existing tokens lose them on their next use.
- Admin automation, if wanted later, gets its own kind of credential.

## API audit, 2026-10-23

**Status:** done (2026-10-25). Every finding is fixed except 8, which Elliot decided to leave for now.

Elliot asked for a critical look at the whole API. The probing was done live, on a throwaway build with the demo data, the way a script, a CI job, an AI agent and an attacker would use it. What held up well: sign-in and sessions, paging and report parameters, XML parsing (no XXE or entity expansion), the webhook address guard, concurrent runs by name, search escaping, no mass assignment, and one error format throughout.

| # | Finding | Decision | Status |
| :- | :--- | :--- | :--- |
| 1 | Ordinary bad input crashed requests with a 500: a NUL character in text, text over a column's length, numbers past an `integer` column. One bad value failed a whole CI upload. | NULs are refused with 400, or removed in results, imports and MCP. Limits are checked up front, naming the field, with a safety net for the rest. | **Done** (changelog 2026-10-23) |
| 2 | A token could hold `PROJECT_DELETE` and force-delete a whole project, irreversibly; `?force=true` is trivial for a script. | Tokens can never hold `PROJECT_DELETE` (`TOKEN_EXCLUDED_PERMISSIONS`). No trash. | **Done** (changelog 2026-10-23) |
| 3 | Re-sending the same CI upload (a retry after a network error) records every result twice. | An optional `Idempotency-Key` header on the three result routes (one result, JSON batch, JUnit). Keys belong to the caller, the project and the route; only 2xx answers are kept, for 24 hours, in the database; the same key with a different body is `422`, and one still in progress is `409`. | **Done** (changelog 2026-10-23) |
| 4 | Mistakes are silently ignored: an unknown field (`PATCH {"tittle": ...}` answers 200), a report filter under the wrong key (an unfiltered report). | Refuse unknown fields and filter keys with 400 naming them; MCP tool arguments too. | **Done** (changelog 2026-10-23) |
| 5 | JSON bodies are capped at 1 MB, while the docs promise batches of 5,000 results with stack traces up to 100,000 characters; the 413 doesn't say the limit. | JSON batches take 50 MB, like JUnit files; every 413 says the limit. | **Done** (changelog 2026-10-23) |
| 6 | Lists that grow aren't paged: a plan's runs (one per CI build), a plan's cases, the spec tree, users. | A plan's runs are paged, newest first (the web app follows the pages). A plan's cases (the Execute queue), the spec tree and users stay whole: the queue and the tree show everything, and users stay few. | **Done** (changelog 2026-10-23) |
| 7 | The single-result route needs `test_plan_case_id`; elsewhere a case id or readable id works. | It also takes `test_case_id`: the case's id or readable id. | **Done** (changelog 2026-10-23) |
| 8 | No ETag or version check: two editors (or an agent and a person) overwrite each other. | Not now (decided with Elliot): nothing outside Testify uses the API yet, and an optional `If-Match` can be added later without breaking any client. | **Decided: not now** |
| 9 | `executed_at` in the future (2099) is accepted, distorting "latest" and trends. | More than 5 minutes ahead is refused, per item. | **Done** (changelog 2026-10-23) |
| 10 | Signed-in users have no request limit (only API tokens do). | 1,200 a minute per user, like tokens (decided with Elliot). | **Done** (changelog 2026-10-25) |
| 11 | Misleading errors: a malformed token says "your sign-in has ended"; `INVALID_FILTER` has detail `INVALID_FILTER` and a blank field name; the 413 has no limit. | Filter errors (with 4) and the 413 (with 5); something that isn't a token is `INVALID_TOKEN`, not "your sign-in has ended". | **Done** (changelog 2026-10-23) |
| 12 | Missing HTTP basics: no `WWW-Authenticate` on 401, 404 instead of 405 for a wrong method, no expiry in the login answer. | `WWW-Authenticate: Bearer` on every 401; 405 with `Allow`; the login answer gives `expires_at` and `idle_timeout_seconds`. | **Done** (changelog 2026-10-23) |
| 13 | No `operationId` in the spec (poor names in Postman and client generators); 12 write routes don't document their 400. | Every operation's id comes from its summary (`listPlanTestRuns`, `getProject`), a few named by hand; every route with a body or query documents its 400; a test keeps both. | **Done** (changelog 2026-10-23) |
| 14 | A project's `settings` is returned as a JSON string inside the JSON. | `settings` is an object in every project answer. | **Done** (changelog 2026-10-23) |
| 15 | `TOKEN_PROJECT_MISMATCH` confirms another project's plan exists (a missing one is 404). Minor: ids aren't guessable. | 404, as for something that doesn't exist (decided with Elliot). | **Done** (changelog 2026-10-25) |
| 16 | A webhook to an address refused at delivery retries for 11 hours instead of failing at once. | It fails at once, saying why. | **Done** (changelog 2026-10-23) |
| 17 | MCP tools take only internal project ids, not prefixes (`DEMO`); runs carry no result counts, so a dashboard needs a call per run. | MCP's `project_id` takes an id or a prefix; a plan's run list gives each run's `summary` (the run summary report's counts). | **Done** (changelog 2026-10-23) |

## Steps

### 1. Make the API consistent

**Status:** Done (2026-10-12). All four stages finished; see below and the Decisions table.

**What:** decide the conventions, then change the routes to follow them:
- one address style (everything under `/projects/{projectId}/...`, or flat resources);
- one error format (problem details everywhere is the natural choice);
- "run" instead of "build" in addresses and fields;
- naming of fields and query parameters;
- what list, create and update responses look like.

**Why now:** nothing outside Testify depends on the API yet. Once people write scripts against it, every change breaks them.

**Recommendation (followed):** do this first, and write the result into RFC 03 to replace §1-4. The web app changes along with the routes.

**Decided:** shallow addresses, short path names, `builds`/`executions` renamed in the database too, no aliases (see Decisions).

**Stages** (each its own commit, tested by Elliot before the next):
1. **Database rename. Done 2026-10-11.** Migration `007`: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`, with their columns, constraints and indexes. The code that talks to them was renamed to match; the API was unchanged.
2. **One error format. Done 2026-10-12.** Every error is problem details (`application/problem+json`, with `code` and `detail`), sent through `sendError` in `apps/server/src/errors.ts`; unknown addresses and Fastify's own errors too. The web app reads messages through `errorMessage()` in `apps/web/src/api/errors.ts`. `apps/server/tests/api_conventions.test.ts` checks the format for every kind of error.
3. **Addresses, verbs and names. Done 2026-10-12.** The route map in RFC 03 §2; `PATCH` for partial updates; `201`/`200`/`204` for create/update/delete; `?force=true` for "delete anyway"; snake_case bodies; id fields named after the database columns (`test_plan_id`, `test_run_id`, ...); "run" and "result" instead of "build" and "execution" in addresses, fields, error codes and new audit rows (old audit rows keep their names). The web app's addresses move into one file (`apps/web/src/api/routes.ts`). A data migration (`008`) renames `plan_id` to `test_plan_id` inside stored report schedules. Two kept `PUT`, because each replaces the whole thing: updating a report schedule and saving the email settings. Removing a whole suite from a plan answers 200 with counts (`added`, `removed`, `retired`, `skipped`) rather than 204. `api_conventions.test.ts` checks the new shapes, that no response says "build" or "execution", and that the old addresses answer 404.
4. **Documentation. Done 2026-10-12.** RFC 03 §1-4 now describes the API as built: the conventions, the full route map, the CI batch format and the error codes. The other docs use the new addresses and names.

**Route map:** [RFC 03 §2](rfc_03_api_and_xml_contracts.md) (the one place it's kept). With items addressed by their own id, the server works out the project from the ids; a request naming ids from two projects is refused (`400 PROJECTS_DIFFER`).

### 2. Version the API

**Status:** Decided (2026-10-11): the cleaned-up API from step 1 becomes the stable `/api/v1`, with no aliases for old addresses.

**What:** decide how the API changes once it's published.

**Recommendation:** the cleaned-up API from step 1 becomes the stable `/api/v1`; it's safe to change v1 now because nobody depends on it yet. After publishing:
- additions are fine;
- breaking changes go into `/api/v2`, while v1 keeps working for a stated period.

**Open question:** keep the current addresses working temporarily as aliases, or just change them?

### 3. OpenAPI spec and docs page

**Status:** Done (2026-10-12). All four stages finished.

**What:**
- Add a schema to every route (inputs, outputs, errors).
- Generate the spec with `@fastify/swagger`.
- Serve the docs page with "try it" at `/docs`.
- Add a test that real responses match the spec.

**How it works** (`apps/server/src/openapi/`):
- **The page and spec:** Swagger UI at `/docs`, the spec at `/docs/json` and `/docs/yaml`, open to anyone. "Try it out" sends real requests: with the browser's session cookie (the page adds the `X-Testify-Client` header), or with a token entered under "Authorize". Routes without a schema yet are left out of the spec.
- **Route schemas** live in `openapi/areas/<area>.ts`; shared ones (`Problem`, `User`, `Project`, `Plan`, `Run`, ...) in `openapi/schemas.ts`, which become `#/components/schemas/...`.
- **Requests are validated** against them: bodies exactly as sent, query strings and path parameters with type coercion. A mismatch is `400 INVALID_REQUEST` naming each field. Routes that already check their input more precisely (single and batch results) keep their own checks; their body schema is documentation only (`handlerValidated`).
- **Responses aren't changed** by their schemas: they're serialized with plain `JSON.stringify`.
- **Tests keep the spec honest:** in tests every JSON response is checked against its route's schema, undocumented fields included; a mismatch fails the request with a message naming the field. So every existing test is also a contract test.

**Stages** (each its own commit, tested by Elliot before the next):
1. **Infrastructure and the first area. Done 2026-10-12.** The packages, the page, validation, the response check; sign-in, projects, plans, runs and results (18 routes). `apps/server/tests/openapi.test.ts`.
2. **Specification and plans. Done 2026-10-12.** Suites, cases, versions, custom-field values, search, move, the spec tree, plan membership and the Execute queue (27 routes; 45 in all). Every field limited to a set of values now lists them in its description. Found while documenting: a case's `priority` and `execution_type` were stored as sent; they're now checked (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`, `MANUAL`/`AUTOMATED`).
3. **Everything else. Done 2026-10-12.** Reports, report email, import (multipart or JSON), export, API tokens, admin, health and `/mcp` (39 routes; 84 in all). `openapi.test.ts` checks that every route the server registers is in the spec; only `GET`/`DELETE /mcp` are hidden (they just answer 405). Report outputs are described only at the top level (`report`, `generated_at`, `project`); `POST .../reports/{reportId}` lists each report's parameters, and `reports_api_and_mcp.md` and the catalog say what each contains. Found while documenting: creating a user whose username or email was taken answered 500; it's now `409 USER_EXISTS`.
4. **Getting-started guide and docs. Done 2026-10-12.** [api_getting_started.md](api_getting_started.md): making a token (which capabilities for which job), the first call, finding ids, creating or reusing a run per build, sending results and checking what was saved, a GitHub Actions step, reading results back, errors and limits; every command was run against a real server. A shorter version heads the `/docs` page. RFC 03, the README and the reports doc link to it.

**Allowed values:** Swagger UI's "Example Value" view shows only one value per field (e.g. `"verdict": "PASSED"`); the "Schema" view next to it shows them all. Since stage 2, every such field also lists them in its description (`oneOf()` in `openapi/schemas.ts`).

**Open questions:** none.

**Needs:** `@fastify/swagger` and `@fastify/swagger-ui` (installed 2026-10-12, with Elliot's OK); `ajv`, which Fastify already used, is now a direct dependency.

### 4. Paging and filtering for lists

**Status:** Done (2026-10-12, with step 8). Paged: `GET /projects/{id}/cases`, `GET /runs/{id}/results`, `GET /admin/audit-logs`, the case-history report. Filters: cases by readable id, suite (with sub-suites), latest version status, priority; results by verdict, case, source, latest only; audit entries by action, actor, since.

**What:**
- Lists return a page at a time (e.g. 100) with a way to ask for the next page.
- Common filters: status, verdict, "changed since".

**Recommendation:**
- Use cursor paging (a "next page" token), which stays fast on large tables.
- Start with the lists that grow: cases, results, audit log, case history.
- The web app may keep loading whole projects at first.

### 5. Make CI integration easy

**Status:** Done (2026-10-12).
- **JUnit XML upload:** `POST /runs/{id}/results/junit` takes the report test runners already write, matching each test to a case by readable id (a `testify_id` property or an id in the name), otherwise by suite and title, as a JUnit import names cases.
- **Runs by name:** `POST /plans/{id}/results/junit|batch?run_name=` creates the build's run on first use and reuses it after.
- **Guide:** [api_getting_started.md](api_getting_started.md) §5 has examples for GitHub Actions, GitLab CI, Jenkins and Azure DevOps.
- **Not built** (decided with Elliot): a command-line uploader (curl is enough) and generated client libraries (`/docs/json` works with OpenAPI generators).

**What** (as planned):
- A guide and ready-made examples for common setups: GitHub Actions, GitLab CI, JUnit result files.
- Possibly a small command-line uploader.
- Possibly a client library generated from the spec (step 3).

**Recommendation:** after step 3, since the examples and libraries should come from the published spec.

### 6. Write tools for MCP agents

**Status:** Done (2026-10-12, with step 9).
- **Tools:** `create_suite`, `create_case`, `update_case`, `update_cases`, `create_run`, `record_results`, `update_plan_cases`, plus `list_suites` for reading.
- **As the caller:** each calls the REST routes with the caller's credential, so the token's capabilities decide, and a token is offered only the tools it may use.
- **People approve:** agent-made cases are always DRAFT, and editing an approved case makes a new DRAFT. There are no approve, deprecate or delete tools.
- **Audit:** changes are marked "via Testify MCP" in their audit rows, and every call writes an `MCP_WRITE` row to the Security Audit Log.

**What:** MCP tools that change things, such as creating and editing test cases, recording results, creating plans and runs, and adding cases to plans.

**Recommendation:**
- Give agents their own permissions and limits.
- Use a safe default: agents create drafts, and a person approves them. That fits the existing DRAFT → APPROVED lifecycle.
- Mark write tools clearly, and audit-log every agent change. RFC 04 threat vector 7 covers prompt injection risks.

**Open questions** (answered 2026-10-12, see Decisions):
- Which actions should agents be allowed first? Creating suites and cases, editing cases, creating runs, recording results, and adding and removing plan cases; not approving, deprecating or deleting.
- Should agent-created cases always need human approval? Yes: they always start as DRAFT.

### 7. Webhooks

**Status:** Done (2026-10-12), in two parts:
- the server: events, delivery with signing and retries, address rules, the management and delivery-log API;
- the Admin Panel's Webhooks tab: create, edit, pause, test, new secret, delete, and the delivery log with Send again.

**What:** Testify calls other systems when something happens, such as a run finishing, a test failing or a case being approved, so Slack, a bug tracker or CI can react. Each call is signed so the receiver can trust it. Designed in RFC 03 §7.3; not built.

**Recommendation:** after steps 1-3. Needs a settings screen, retries for failed deliveries, and a delivery log.

### 8. Fill the read gaps

**Status:** Done (2026-10-12, with step 4), in three parts: single items by id, version history and readable ids everywhere; a run's results and a project's cases (paged); adding and removing one report-schedule recipient.

**What** (as planned; each is built): reads a script needed and didn't have:
- **Single items by id:** `GET /projects/{id}`, `/plans/{id}`, `/runs/{id}`, `/suites/{id}`, `/cases/{id}` (the case with its latest version and steps), `/results/{id}` (with step results). Today only lists exist, or the whole project's tree.
- **A run's results:** `GET /runs/{id}/results`, every result with its duration, notes, error, step results and who recorded it, filterable by verdict and case; paged (step 4). Today the options are the Execute queue (latest verdict only), the reports, or an export (limited to 120 an hour).
- **Readable ids:** accept a case's external id (SHOP-12) wherever a case id is taken, or add a lookup (`GET /projects/{id}/cases?external_id=SHOP-12`). Today only CI batches and the case-history report accept them.
- **Version history:** `GET /cases/{id}/versions` (every version, not just the latest) and `GET /versions/{id}`.
- **Report schedule recipients:** a way to add or remove one recipient, instead of resending the whole schedule. Built as `POST /report-schedules/{id}/recipients` (`email`) and `DELETE /report-schedules/{id}/recipients/{email}`; the last recipient can't be removed (`409 LAST_RECIPIENT`).

**Why:** with these, a script can find something by its readable id, read it, and act on it in one or two calls, instead of searching, downloading whole lists and chaining lookups.

**Recommendation:** after step 3 stages 2-3, so the new routes get their schemas as they're added; together with step 4 (paging) for the lists. Bulk changes became step 9.

### 9. Bulk changes

**Status:** Done (2026-10-12, with step 6). `POST /projects/{id}/cases/bulk` (update priority, execution type, suite or custom fields; approve, deprecate, restore) and `POST /plans/{id}/cases/bulk` (add, remove, with optional retiring), up to 500 cases. Each case goes through its single-item route and is reported on its own (200/207). There is no all-or-nothing mode: each item is its own transaction, as in the single routes.

**What:** changing many things in one call, where a script would otherwise loop: deprecating, approving or restoring many cases; changing priority or a custom field on many cases; adding or removing many cases from a plan (partly exists: a whole suite, or `case_ids` for moves).

**Recommendation:**
- Take readable ids (they already work in `case_ids`) and answer per item, like the CI batch (`207` when some are refused), with an `all_or_nothing` option.
- One audit row per change, as today.
- Split from step 8 on 2026-10-12, to keep that pass to reads and paging.

### 10. TestLink-compatible API

**Status:** In progress. Phases 1 to 4 of 6 done (2026-10-26): every route in Dave's API. That's the three version paths, TestLink API keys, TestLink's envelope and errors, the test routes, every read (with Dave's query layer), every write, `/testcasemetrics` and the SWAG file. Next: the migration from TestLink's database (phase 5).

**What:** Dave's TestLink REST API (v1, v2, custom: 29 endpoints) answered by Testify as TestLink answers, so his scripts, AI tooling, metrics page and SWAG editor change only the host. The design, phases and what can't be exact are in [testlink_compat_api.md](testlink_compat_api.md).

**How:**
- A translation layer (`apps/server/src/testlinkCompat/`): reads through the repositories, writes through Testify's routes as the key's user (`innerRequest`, `via: 'testlink'`), so permissions, validation, audit and webhooks apply unchanged.
- TestLink's numeric ids kept beside the UUIDs (`compat_ids`), with project, suite, case, version and plan sharing one sequence, as TestLink's nodes do.
- A migration from TestLink's database that keeps its ids and users' keys (phase 5; needs database access and a MySQL client package).

**To settle with Dave:** custom execution status codes; whether platforms are used; database access for the migration; whether Testify serves his HTML pages (they need their own Content-Security-Policy); `/swagfile` requiring a key.

### Related gaps worth doing alongside

- ~~Plan and run create/edit/delete write no audit entry.~~ Done 2026-10-14.
- `allow_draft_plan_linking` has no UI (a project settings form).
- Step-level results can be sent through the API but not recorded in the web app.

---

## Recommended order

1. **Steps 1 and 2:** consistency and versioning. Done.
2. **Fix first:** API tokens on global admin routes. Done.
3. **Step 3:** finish the spec and docs page (stages 2-4). Done.
4. **Steps 8 and 4:** the missing reads and paging, together. Done.
5. **Step 5:** CI integration, built on the published spec. Done.
6. **Steps 9 and 6:** bulk changes and agent writes, together. Done.
7. **Step 7:** webhooks. Done.
8. **Step 10:** the TestLink-compatible API, in six phases.

---

## Decisions

| Date | Decision | Notes |
| :--- | :--- | :--- |
| 2026-10-11 | Prefer an OpenAPI spec with a served docs page over a hand-written reference. | Confirmed 2026-10-12 (step 3). |
| 2026-10-11 | Shallow addresses: lists and creation under the parent (`/projects/{id}/plans`), each item by its own id (`/plans/{id}`). | Chosen over fully nested and flat. |
| 2026-10-11 | Short path names: `/suites`, `/cases`, `/versions`, `/plans`, `/runs`, `/results`. | |
| 2026-10-11 | Rename in the database too: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`. | Migration `007`. |
| 2026-10-11 | Id fields use the database column names (`test_plan_id`, `test_run_id`, ...) everywhere in the API. | One name per id, no translation layer. |
| 2026-10-11 | No aliases: old addresses change outright; the cleaned-up API becomes the stable `/api/v1` (step 2). | Nothing outside Testify uses the API yet. |
| 2026-10-12 | `PUT` stays for updates that replace the whole thing: report schedules and the email settings. Everything else that updates part of an item is `PATCH`. | Found while converting; a missing field in those bodies clears the value. |
| 2026-10-12 | Removing a whole suite from a plan answers 200 with counts, not 204. | The counts (`removed`, `retired`, `skipped`) are what the web app shows. |
| 2026-10-12 | Swagger UI for the docs page. | Chosen over Scalar: it serves all its files from Testify, so it works without internet access. |
| 2026-10-12 | `/docs` and the spec are open to anyone. | They describe the API, not data; "Try it out" still needs a sign-in or token. |
| 2026-10-12 | Schemas validate requests, but don't replace the routes' own checks where those give more specific errors (results, batch). Responses are never reshaped by schemas; tests check them instead. | Keeps behaviour and error codes the same while the spec is added area by area. |
| 2026-10-12 | Report outputs are described only at the top level in the spec, for now. | Each of the six reports has its own deep shape; the catalog and reports_api_and_mcp.md describe them. Full schemas per report are a possible follow-up. |
| 2026-10-12 | Steps 8 and 4 together, in three commits: single items and readable ids; paging and the new lists; changing one report-email recipient. | |
| 2026-10-12 | Readable case ids (SHOP-12) are accepted wherever a case id is, not only through a lookup route. | Imported cases can share a readable id across projects: the request's project decides, otherwise `400 AMBIGUOUS_CASE_ID`. |
| 2026-10-12 | Paging only for lists that grow (cases, a run's results, the audit log, case history); short lists stay whole. | The web app is unchanged. |
| 2026-10-12 | Bulk changes (e.g. deprecating many cases) become their own roadmap step. | Keeps this pass to reads and paging. |
| 2026-10-12 | One recipient at a time: `POST /report-schedules/{id}/recipients` and `DELETE /report-schedules/{id}/recipients/{email}`, rather than a partial `PATCH`. | `PUT` stays for replacing a whole schedule. A schedule keeps at least one recipient (`409 LAST_RECIPIENT`); adding one already there changes nothing. |
| 2026-10-12 | CI uploads JUnit XML to the server as it is (`/results/junit`); no command-line uploader. | Nothing to install in CI; one `curl`. The same file format a JUnit import reads. |
| 2026-10-12 | A JUnit test matches a case by readable id first (a `testify_id` property, or an id in the test name), otherwise by suite and title as a JUnit import names cases. Unmatched tests are reported (207), never created. | "Import the JUnit file once, then upload each build's file" needs no changes to the tests. |
| 2026-10-12 | One call creates or reuses a build's run by name (`run_name` on `POST /plans/{id}/results/junit` and `/results/batch`). | Creating needs `RUN_MANAGE`; reusing only `EXECUTE_RUN`. Concurrent jobs end up in one run. |
| 2026-10-12 | Guide examples for GitHub Actions, GitLab CI, Jenkins and Azure DevOps. | |
| 2026-10-12 | CI results (JSON batches and JUnit uploads) never auto-close a run; `close_run=true` closes it on purpose. | Found while checking the guide live: with auto-linking, the first file of a build filled the plan and closed the run, refusing the build's other files and any re-run. Manual results still auto-close, once. |
| 2026-10-12 | Steps 9 and 6 together; MCP write tools are thin wrappers over the REST routes (including the new bulk ones). | Agents' typical asks ("deprecate these 30", "add everything tagged checkout to the plan") are bulk changes. |
| 2026-10-12 | Bulk changes run each item through its single-item route in-process (`app.inject`), with per-item outcomes (200/207) and no all-or-nothing mode. | Same rules, errors and audit rows as one-at-a-time, with no second copy of the logic. |
| 2026-10-12 | Agents get: create suites and cases, edit cases (one or many), create runs, record results, add and remove plan cases. Not: approve, deprecate, restore, delete. | Decided with Elliot. |
| 2026-10-12 | Cases an agent creates always start as DRAFT, even with `SPEC_AUTO_APPROVE`; editing an approved case's content makes a new DRAFT. | Decided with Elliot: a person approves agents' work, which also limits what prompt injection could do. |
| 2026-10-12 | Every MCP write-tool call writes an `MCP_WRITE` row to the Security Audit Log, and its changes say "(via Testify MCP)" in their User-Agent. | The changes keep their usual audit rows too. |
| 2026-10-12 | Webhooks are managed with a new per-project `WEBHOOK_MANAGE` permission (Admin and Test Lead by default), never grantable to API tokens, in an Admin Panel tab. | Decided with Elliot. A webhook sends project data to any address. |
| 2026-10-12 | Webhook targets: public and private networks yes; loopback and link-local (cloud metadata) no, unless `WEBHOOK_ALLOW_LOCAL=true`. Checked on save and on every connection after DNS; redirects not followed. | Decided with Elliot. |
| 2026-10-12 | Two formats: signed JSON, and Slack-style messages (also Mattermost, Rocket.Chat, Discord's `/slack`). | Decided with Elliot; Teams later if asked for. |
| 2026-10-12 | Nine events: runs (created, closed with summary), results (recorded, failed: one per request), test cases (created, approved, deprecated, restored), imports (completed). | Decided with Elliot. |
| 2026-10-12 | Delivery is an outbox with claimed leases (several instances, at least once), retried after 1 min, 5 min, 30 min, 2 h, 8 h; one sender per webhook, so a dead receiver holds up only itself. | The per-webhook sender came from the live check: sending everything in one queue let one unreachable address delay every other webhook. |
| 2026-10-14 | A webhook is paused automatically when every attempt has failed for 3 days (at least 10 attempts): a `WEBHOOK_AUTO_PAUSED` audit row and a note in the Webhooks tab; turning it on resumes it. | Decided with Elliot. |
| 2026-10-14 | A Teams format: an Adaptive Card for Teams Workflows webhooks (Office 365 connectors are retired), with test content only in plain-text `TextRun`s. | |
| 2026-10-15 | `defer_auto_close` on `POST /runs/{runId}/results`, and `POST /runs/{runId}/auto-close` to finish it: Fail/Block in the web app wait for their notes before the run auto-closes. | Decided with Elliot (over a grace exception for notes on a just-closed run, or recording Fail/Block only on submit): an auto-close that came first refused the notes. Finishing needs your own single result, so CI still never auto-closes. |
| 2026-10-23 | API tokens choose where they work: the REST API and MCP (default), MCP only, or REST only (`interfaces`; `403 TOKEN_INTERFACE_NOT_ALLOWED`). An agent's token should be MCP only, since MCP's limits hold only on `/mcp`. Tokens describe themselves (`/auth/me`; `api_token` on `GET /projects` and MCP `list_projects`). | An agent whose MCP connection failed fell back to the REST API with the same token, stepping outside MCP's limits, and couldn't tell why it saw only one project. |
| 2026-10-23 | NUL characters are refused with 400 naming the field, except on the result routes, imports and `/mcp`, which remove them. Limits (names 255, integers 2,147,483,647, suites 27 deep) are checked up front; a data exception the database still raises answers 400 and is logged. | Audit finding 1. Results and imports carry captured test output and other tools' files, where a stray NUL shouldn't cost the result. |
| 2026-10-23 | API tokens can't hold `PROJECT_DELETE`; no trash for deleted projects. | Decided with Elliot (audit finding 2). |
| 2026-10-23 | Unknown request fields and report filter keys are refused with 400. | Decided with Elliot (audit finding 4): nothing outside Testify uses the API yet, so this is the cheapest time. |
| 2026-10-23 | Repeat uploads are caught with an optional `Idempotency-Key` header on the three result routes, kept 24 hours; no automatic de-duplication by content. | Decided with Elliot (audit finding 3). Content-based de-duplication would silently drop a genuine re-run whose report has no times. |
| 2026-10-25 | No `If-Match`/ETag on edits for now. | Decided with Elliot (audit finding 8): nothing outside Testify uses the API yet, and an optional header can be added later without breaking clients. |
| 2026-10-25 | Signed-in users are limited to 1,200 requests a minute each, like tokens. | Decided with Elliot (audit finding 10). Nobody clicking comes near it; it stops a runaway script on a password sign-in. |
| 2026-10-25 | To an API token, anything in another project is `404`, as if it didn't exist (it was `403 TOKEN_PROJECT_MISMATCH`). | Decided with Elliot (audit finding 15): the 403 confirmed the other project's item existed. The message still says it's not in the token's project. |
| 2026-10-26 | A TestLink-compatible API (step 10): drop-in, only the host changes. | Decided with Elliot, for Dave's TestLink clients: TestLink's paths, numeric ids, bodies, answers and errors. |
| 2026-10-26 | Its credential is a per-user TestLink API key, accepted only on `/lib/api/rest/...`. | Decided with Elliot: TestLink's keys are per user. Keeping it off `/api` and `/mcp` leaves the project-bound tokens and MCP's limits as they are. |
| 2026-10-26 | An approved case edited through it gets a new DRAFT. | Decided with Elliot, as MCP: Testify keeps its approval rule. |
| 2026-10-26 | TestLink's whole history is migrated, keeping its ids and keys. | Decided with Elliot (phase 5). |
| 2026-10-26 | No platforms feature in Testify. The TestLink-compatible API keeps TestLink's platform data as one plain run per (build, platform). | Decided with Elliot: teams that want to tell platforms apart do it their own way; Testify doesn't decipher platforms. |
| 2026-10-26 | The SWAG file (`/swagfile`) needs a TestLink key to read and `PLAN_MANAGE` to replace, though TestLink serves it to anyone. | It holds every project's API key. To confirm with Dave: his `manageSWAGS.html` must send an `APIKEY` header. |
