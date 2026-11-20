# Tessick — Agent / Contributor Guide

This file orients any AI coding agent (Claude, Gemini/Antigravity, etc.) or human contributor working in this repo. It describes how things are **now**. The history behind them -- every change, why it was made and how it was tested -- is in `docs/changelog.md`. Read this file before making changes, and check `docs/changelog.md` before changing something that looks odd: it's often a decision made with Elliot (the project's owner).

## What Tessick is

Tessick is an open-source, self-hosted test case management app meant to replace TestLink. It's feature-complete enough to deploy (README, Docker, CI, production build).

It's dual-licensed (since 2026-11-16; MIT before): `AGPL-3.0-only` (`LICENSE`), or a commercial license from Elliot (see the README's License section).

It was named **Testify** until 2026-11-15 (renamed by Elliot: the name clashed with a popular Go testing library). Older `docs/changelog.md` entries and the `.antigravity/agents/` briefs keep the old name, as history; everything else says Tessick (`@tessick/*` packages, `tessick_session`, `X-Tessick-*` headers, `tk_ci_` tokens).

**Specification:**
- Projects contain a tree of test suites, which contain test cases.
- Each test case has versions (DRAFT → APPROVED → DEPRECATED) holding the summary, preconditions and steps.
- Admins can define custom fields (six types) on cases and suites.

**Execution:**
- A test plan pins a set of cases at a version; a test run belongs to a plan. Runs and results are `test_runs`/`test_results` in the database and "runs"/"results" in the API (older docs and audit rows say "build" and "execution").
- Results are recorded per case in a run: by people with hotkeys in the web app, or by CI through the batch API (JSON, or a JUnit XML file, optionally into a run named by the build and created on first use).

**Everything else:**
- Evidence: screenshots, videos, logs and Playwright traces per executed case, in the web app (the Execute pane's Evidence section and viewer), the API (including CI batches, upload links and JUnit attachments) and MCP, stored on disk or in S3-compatible storage.
- Reports: run summaries and diffs, trends, flaky and slow tests, case history, breakdowns. They're available in the app, the REST API, scheduled email and MCP.
- Webhooks: a project's events (runs, results, test cases, imports) sent as they happen, as signed JSON, Slack-style messages or Teams cards, with retries, a delivery log, and a pause for webhooks that keep failing.
- Import (TestLink XML, JUnit XML, TestRail CSV, CSV, JSON) and export (JSON, CSV).
- Editable roles, per-project roles and permission overrides, and project-scoped API tokens.

Not built:
- A retention purge of old results and evidence, and malware scanning of evidence.
- Detailed schemas for report outputs in the OpenAPI spec (only their top level is described; every route is in it).
- Step-level results in the web app; the API accepts them.

## Running things

```bash
npm install
npm test                                 # every test (Vitest), all workspaces
npm run typecheck                        # tsc --noEmit in all four workspaces
npm run dev --workspace=apps/server      # API on :3001, in-memory database (src/dev.ts sets DATABASE_URL=memory)
npm run dev --workspace=apps/web         # web app on :3000, proxies /api to :3001
npm run build                            # production: apps/web/dist + apps/server/dist/server.js
npm start                                # production: one process serving the API and web app (needs DATABASE_URL, JWT_SECRET)
docker compose up -d                     # Tessick + PostgreSQL; copy .env.example to .env first
docker compose -f docker-compose.demo.yml up   # the demo: published image, demo mode, Report Demo loaded, no .env
npx tsx apps/server/scripts/report-demo.ts   # loads a demo project with 8 runs of results through the API
npx tsx apps/server/scripts/showcase/load-showcase.ts   # the "Storefront" project for filming demo clips (its folder has a TestLink export and a JUnit file to use on camera)
npx tsx apps/server/scripts/migrate-testlink.ts --from <url> --dry-run   # moves a TestLink database in (DATABASE_URL: Tessick's)
```

**Development database:**
- The dev server uses an in-memory database (PGlite), so every restart starts empty and signs everyone out.
- PGlite is one Postgres session, so its driver (`packages/db/src/dialects/postgres.ts`) runs one transaction at a time, and a query outside a transaction waits for the open one. Races between overlapping transactions therefore happen only on PostgreSQL.
- It seeds the role registry, an `admin` / `password` user, and fixture users for each built-in role with password `DevTest123!`: `test_lead`, `tester`, `viewer`, `automation_bot`, `project_admin`, `override_tester`.
- It seeds no projects; run the demo script for data.
- Backend or shared-package changes need a dev-server restart.
- `.claude/launch.json` defines `api-server` and `web` for the preview tools, and `api-server-demo` (the dev server in demo mode, instead of `api-server`).

**Configuration** comes only from environment variables; there's no `.env` loader except Docker Compose's. A bad value stops startup with a `ConfigError` saying what to set. The full table is in `docs/deployment.md`. In short:
- `DATABASE_URL` is required: a Postgres URL, or `memory` (refused with `NODE_ENV=production`).
- `JWT_SECRET` (32+ characters) is required with a real database.
- Evidence storage is required with a real database: `EVIDENCE_DIR` (local) or `EVIDENCE_STORAGE=s3` with `EVIDENCE_S3_*`; the in-memory database uses memory. Startup checks it's writable or reachable.
- Also read: `SECRETS_KEY`, `ADMIN_PASSWORD`, `PORT`, `TRUST_PROXY`, `CORS_ORIGINS`, `LOG_LEVEL`, `WEB_DIST_DIR`, `SEED_SAMPLE_DATA`, `SEED_DEV_FIXTURES`, `WEBHOOK_ALLOW_LOCAL`, `EVIDENCE_MAX_FILE_MB`.
- `TESSICK_DEMO=true` is demo mode (`docker-compose.demo.yml`, `src/demo/`): the first admin's password is `tessick-demo-admin` and `GET /api/v1/instance` gives it to the sign-in page (not when `ADMIN_PASSWORD` chose it); `JWT_SECRET`/`SECRETS_KEY` may be unset (random per start); and a fresh database (the first admin created on this start) gets the Report Demo project, loaded through the routes in-process (`app.inject`). Never for real data.
- CI publishes the image to `ghcr.io/elliotnewtonmiller/tessick` (amd64 + arm64) after the demo has been checked to start with its project: each push to `main` as `latest` and `sha-<commit>`, and a version tag `v1.2.3` as `1.2.3`, `1.2` and `1`. Then it starts the published arm64 image's demo on GitHub's arm64 runner. Releases are git tags `v<version>` with a GitHub release; the root `package.json` version matches. Versions are semantic: a patch (1.0.1) only fixes, a minor (1.1.0) adds without breaking anything, a major (2.0.0) breaks something users rely on (an API field or route, a configuration variable, an upgrade that needs manual steps). 1.0.0 was released on 2026-11-20.
- All of it is parsed in `apps/server/src/config.ts`.

**First admin on a real database:** username `admin`. The password is `ADMIN_PASSWORD` if set; otherwise a random one is printed once in the log, and Tessick makes the admin change it at first sign-in.

## Repo layout

npm workspaces (root `package.json`: `packages/*`, `apps/*`). Use `npm run <script> --workspace=<path>`; no pnpm or Turborepo.

```
apps/server/       Fastify API (TypeScript, ESM). Entry src/server.ts (createServer + startup); src/dev.ts for development.
  src/routes/      One file per area: auth, admin, projects (projects/plans/runs), specEditing (suites/cases/versions/move),
                   testPlanCases (spec tree, plan membership, Execute queue), customFields, caseSearch, ingestion (import),
                   exports, results (one result), batchExecution (CI results as JSON), junitResults (CI results as JUnit XML),
                   bulkChanges (many cases in one call), webhooks, reports, reportEmail, emailAdmin, apiTokens, evidence,
                   instance (what the sign-in page reads first).
  src/services/    Logic shared by routes: adminGuard, caseFilterService, reportService, reportEmailService, mailer,
                   rateLimits, loginThrottle, resultValidation, resultOverwrite, stepValidation, secrets,
                   batchResults (recording a CI batch, JSON or JUnit), runByName (CI's run per build),
                   webhooks (the delivery worker), webhookEvents (what each event sends), webhookTargets (address rules),
                   idempotency (Idempotency-Key on the result routes), storageSweeper (deletes files whose evidence rows went).
  src/middleware/auth.ts   Authentication and permission checks (see "Auth and permissions").
  src/mcp/          mcpServer.ts: POST /mcp, read tools over the same services; evidenceTools.ts: evidence (an image returned as image content); writeTools.ts: write tools that call
                   the REST routes as the caller (internalRequests.ts).
  src/testlinkCompat/  The TestLink-compatible API (/lib/api/rest/{v1,v2,custom}, docs/testlink_compat_api.md):
                   index.ts (mounting per version), auth.ts (TestLink API keys), envelope.ts (TestLink's answers),
                   versions.ts, projectData.ts (Tessick's rows as TestLink rows, with numeric ids), writes.ts (calling
                   Tessick's routes as the key's user, refusals in TestLink's envelope), routes/ (one file per area;
                   reads use the repositories, writes go through innerRequest with via 'testlink').
  src/testlinkMigration/  The migration from TestLink's database: source.ts (PostgreSQL, or MySQL with mysql2),
                   read.ts (portable SELECTs), migrate.ts (one transaction, TestLink's ids kept; scripts/migrate-testlink.ts).
  src/storage/     Evidence files: provider.ts (the interface, generated keys), local.ts, memory.ts, s3.ts,
                   spool.ts (an upload checked on its way in: size, SHA-256, type by contents), index.ts (createStorage).
  src/openapi/     The OpenAPI spec and /docs page: index.ts (setup, validation, test-time response check),
                   schemas.ts (shared schemas, helpers), areas/ (route schemas per area).
  src/demo/        reportDemo.ts (the Report Demo project, loaded over any API caller: scripts/report-demo.ts over HTTP,
                   demo mode in-process), demoMode.ts (loading it at startup, the log block).
  src/{config,errors,audit,observability,securityHeaders,storableInput,unknownAddress,webApp,sessionCookie,sessionLifetime,runAutoClose,internalRequests}.ts
  scripts/build.mjs        esbuild bundle (workspace packages bundled, other dependencies external).
apps/web/          React + Vite. src/App.tsx (~680 lines) calls the hooks, provides the context, lays out panes and modals, wires hotkeys.
  src/hooks/       One hook per feature: useSession, useScope (project/plan/run), useExecutionWorkspace, useSpecTree,
                   useCaseSearch, useExecution, useSpecSelection, useCaseEditor, useSuiteEditor, useHotkeyEngine, useFocusFSM, ...
  src/components/  layout/ (header, banners), workspace/ (panes 1-2), spec/ and execute/ (pane 3), reports/ (Reports view), modals,
                   Admin Panel tabs (AdminPanelModal, EmailSettingsPanel, WebhooksPanel).
  src/api/         routes.ts (every API address, as functions) and errors.ts (reading error messages).
  src/app/         AppContext (useApp) and shared messages. src/utils/ pure helpers. src/types.ts shared types.
  src/assets/      The mark (also the favicon) and the white wordmark; copies of branding/.
packages/core/     Domain logic with no database, each module unit-tested: ingestion/ (parsers), export/, reporting/
                   (report math, catalog, email rendering, schedules), rbac/ (permission registry, default roles),
                   custom-fields/ (validation, defaults, type inference, regex time limit), case-filter/, execution/
                   (verdict and status lists), security/ (JWT, password policy), webhooks/ (events, signing, Slack messages,
                   blocked addresses), limits/ (what the database can store: name and integer limits, NUL helpers),
                   testlink/ (the TestLink-compatible API's value mapping and Dave's query layer),
                   evidence/ (evidence files: sniffing by contents, file names, ranges, the window after a run closes).
packages/db/       Kysely, Postgres-compatible SQL only. createDbClient(): no connection string = in-memory PGlite,
                   otherwise pg. migrations/ (tracked), repositories/, seeds/ (rbac registry, sample project, dev fixtures).
branding/          The logo: the full logo (white and black), the mark and the wordmarks, clean SVGs plus Inkscape sources (README.md says which to use).
docs/              changelog.md, api_roadmap.md, api_getting_started.md, deployment.md, reports_api_and_mcp.md, and the design docs (RFCs, blueprint, roadmap).
```

## Domain rules

**Suites** nest at most 27 levels deep: the materialized `path` is `varchar(1000)` (`MAX_SUITE_DEPTH` in `test_suite.repository.ts`).

**Test case versions:**
- Content (summary, preconditions, steps) is versioned; title, priority and execution type live on the case and stay editable.
- Content is editable only while the latest version is a DRAFT. Editing an APPROVED case means "Edit" (create a draft copying the latest version) and later Approve.
- Lifecycle is DRAFT → APPROVED → DEPRECATED, and Restore goes from DEPRECATED back to APPROVED. There's no IN_REVIEW.
- A deprecated case can't be edited or added to a plan, and is hidden from the spec tree unless "Show deprecated" (`include_deprecated=true`) is on.
- `SPEC_AUTO_APPROVE` makes new cases start APPROVED, unless a required custom field would be unsatisfied.
- Approving or restoring re-pins the case to that version in every **ACTIVE** plan; LOCKED and ARCHIVED plans keep their pin.
- Duplicating a case (`POST /cases/:caseId/duplicate`, the ⧉ Duplicate button, MCP `duplicate_case`) makes a new case whose version 1 is a copy of the latest version, with the case's fields and custom-field values and any changes sent with it. The copy is always a DRAFT, even with `SPEC_AUTO_APPROVE` (decided with Elliot: it's meant to be edited).

**Plans:**
- Only APPROVED cases can be added to a plan, unless the project setting `allow_draft_plan_linking` is true. That setting has no UI.
- Removing a case that has results **retires** the link (`test_plan_cases.removed_at`) after a confirmation, rather than deleting it. Old runs keep the case where it has a result; it's read-only there unless re-added.
- A run's contents follow `TestResultRepository.getFinalResultsForRuns`, the one rule everything uses: reports, the Execute queue, and the verdict filter.

**Results:**
- Results are never edited; a new row becomes the latest.
- Re-recording a case that already has a result in the run needs `EXECUTE_OVERWRITE`. The exception is re-sending your own latest verdict (adding notes).
- Results are refused on a CLOSED run and on retired links.
- A run auto-closes the first time every case has a result, once only (marked by its `RUN_AUTO_CLOSED` audit row; older runs by `BUILD_AUTO_CLOSED`). Only results recorded one at a time trigger it: CI batches and JUnit uploads never auto-close a run (a build may send several files or be re-run); `close_run=true` closes it.
- Fail and Block in the web app send `defer_auto_close`, so a run completed by them waits for their notes. The notes' result closes it, or `POST /runs/:runId/auto-close` does when the person leaves the case without notes (`useExecution`).
- Manual (UI) results are never timed: duration is null. Only batch/CI results carry durations.
- The result routes take an optional `Idempotency-Key` (`services/idempotency.ts`, table `idempotency_keys`): a retry of the same request gets the first answer back (`Idempotent-Replayed: true`), a different request with the key is `422 IDEMPOTENCY_KEY_REUSED`, one still running `409 IDEMPOTENCY_KEY_IN_USE`. Keys belong to the caller, project and route; only 2xx answers are kept, for 24 hours. Decided with Elliot over de-duplicating by content.

**Evidence** (screenshots, videos, logs, Playwright traces; `routes/evidence.ts`, RFC 03 §5):
- It belongs to a case's execution in a run (run + plan link) and names the result it was added with; results read through the API list theirs.
- Files are recognised by their contents only (`packages/core/src/evidence/sniff.ts`). Everything else is refused, and accepted files are always served by Tessick with their sniffed type, `nosniff` and a `sandbox` CSP.
- It can be added while the run is open, and for 24 hours after it closes only by whoever recorded the result (`test_runs.closed_at`, kept by a trigger). Deleting it is for its uploader while the run is open, or `EXECUTE_OVERWRITE` (decided with Elliot).
- Uploads stream through the spool (size, SHA-256, type) before anything is stored. The same file again for the same execution is answered, not added. Every upload route answers `{ evidence, refused }` (201/200/207, or the refusal).
- A deleted evidence row queues its file (`storage_deletions`, a trigger), and `services/storageSweeper.ts` deletes it after commit. So any delete path (run, plan, case, project with `force`) cleans up storage by itself.
- Upload links (`evidence_uploads`) are single-use, 15 minutes, hashed; their token is the PUT's only credential and is kept out of logs (`loggableUrl` in `observability.ts`).
- Every addition writes an `EVIDENCE_ADDED` audit row. The Security Audit Log shows them grouped by uploader, run and clock hour (`services/auditGroups.ts`: one line for a CI build's hundreds of files, expandable in the Admin Panel); `?action=EVIDENCE_ADDED` lists each one. Deletions (`EVIDENCE_DELETED`) show one by one.
- A case's evidence list (`GET /runs/:runId/cases/:caseId/evidence`) answers `can_add` and each file's `can_delete` from the same checks as the upload and delete (`canAddEvidence`, `mayDeleteEvidence`); the web app shows those, rather than working out the rules itself.
- In the web app (`hooks/useEvidence.ts`, `components/execute/EvidencePanel.tsx` and `EvidenceViewer.tsx`), files are added with the button, a drop on the Execute pane, or a pasted screenshot (an image paste anywhere in Execute mode; text pastes are left alone), each a raw upload with progress (XMLHttpRequest). The viewer pauses the hotkeys.

**Custom fields:**
- A field applies to all projects or to chosen ones (`applies_to_all_projects`, `custom_field_projects`); admins set this with the Projects chips in the Admin Panel (`PUT /admin/custom-fields/:id/projects`). Imports create fields for their project. Which fields a project has always comes from `CustomFieldRepository.listVisibleToProject`.
- Values are **not versioned** and not recorded on results. The UI only allows editing them while the case is a DRAFT. Elliot chose this; don't "fix" it unprompted.
- A required field must always have a usable default, enforced on create and update. CHECKBOX fields can't be required.
- Creating a field writes its default into every existing case or suite it applies to; so does adding a project. Removing a project deletes the field's values there (warn first, then `force`). A field keeps at least one project. Making a field required fills blank values with the default. Removing an option deselects it everywhere.
- Validation regexes run in a `node:vm` sandbox with a 50 ms limit.

**Search and ids:**
- Search (`q`) matches a case's external id, title, or the names of its suite and the suites above it, never custom field values.
- Filters (`packages/core/src/case-filter`) are evaluated server-side for the UI, every report's `filter` param and MCP.
- External ids are PREFIX-n, highest + 1, assigned under a per-project advisory lock (`TestCaseRepository.lockExternalIds`). A project's prefix is locked once it has cases.

**Deleting:**
- Projects, suites, cases, plans, runs and custom fields warn first: without `force`, a `409` names what would be lost; with `force=true`, everything is deleted in RESTRICT-safe order.

## Auth and permissions

**Sign-ins:**
- The web app uses an HttpOnly `tessick_session` cookie (`POST /auth/login` with `session: "cookie"`). Its writes must send `X-Tessick-Client: web` (CSRF guard).
- Scripts use `Authorization: Bearer <jwt>` from a plain login.
- Every sign-in is a server-side session (`sessions` table): 8 hours idle, 7 days maximum.
- Passwords are PBKDF2-SHA512 at 210,000 iterations (`hashPassword` in `user.repository.ts`, stored as `pbkdf2_sha512$<iterations>$<salt>$<key>`). Older hashes are upgraded when their user signs in. An unknown username still costs a password check, so timing doesn't reveal accounts.
- Sign-out, a password change (which needs the current password), an admin's password reset, and disabling a user all end sessions.

**Lockouts:**
- 20 wrong passwords lock an account for 15 minutes; an admin can Unlock it.
- 50 failures from one address in 15 minutes block that address.

**API tokens** (`tk_ci_...`):
- Each is bound to one project. Anything in another project is "not found" to it: 404, as if it didn't exist, so a token learns nothing about other projects (`sendNotInTokenProjectError`; it was 403 `TOKEN_PROJECT_MISMATCH`, changed with Elliot on 2026-10-25 after the API audit).
- Routes outside any project (`/admin/...`, creating a project, `PATCH /auth/me`) refuse tokens (`TOKEN_NOT_ALLOWED`); deny by default via `tokenMayUseRoute`, except `GET /auth/me`, `GET /projects` and `/mcp`. A new route outside a project is therefore closed to tokens automatically.
- A token's capabilities are capped by its issuer's **current** permissions, checked on every use. Disabling the issuer revokes their tokens.
- A token works with the REST API and MCP (`BOTH`, the default), `MCP` only or `REST` only (`api_tokens.interfaces`, checked in `authenticateApiToken`; `403 TOKEN_INTERFACE_NOT_ALLOWED`). An MCP-only token also passes on the requests MCP's write tools make for it (`internalVia === 'mcp'`). Give agents MCP-only tokens: MCP's limits hold only on `/mcp`.
- `GET /auth/me` with a token describes it (name, project, capabilities, interfaces, expiry); `GET /projects` and MCP `list_projects` add `api_token` saying the list is limited to the token's project (`apiTokenScope`).
- Some permissions can never be granted to a token: the system-wide `SYSTEM_ADMIN`, `USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, `PROJECT_CREATE`, `API_TOKEN_MANAGE`, `WEBHOOK_MANAGE` (a webhook sends data anywhere), and `PROJECT_DELETE` (it removes everything in the project for good; decided with Elliot, with no trash) (`TOKEN_EXCLUDED_PERMISSIONS` in `packages/core/src/rbac/registry.ts`; existing tokens lose them on use).
- Limit: 1,200 requests per minute per token, and the same per signed-in user (`services/rateLimits.ts`).

**TestLink API keys** (for the TestLink-compatible API, `docs/testlink_compat_api.md`):
- One per user (`user_api_keys`, SHA-256 hashed, 32 hex characters like TestLink's), made in My Account; a new one replaces the old. An admin can remove anyone's (`DELETE /admin/users/:userId/testlink-key`), and disabling a user removes theirs.
- Sent as the `APIKEY` header (v2, custom) or the HTTP Basic user name (every version; v1 takes only that). Accepted **only** on `/lib/api/rest/...` (`testlinkCompat/auth.ts`), never on `/api` or `/mcp`.
- It acts as its user, with their permissions in each project, and counts against the per-user limit. Writes go through Tessick's routes as an inner request carrying the user's id (`innerRequest(..., { asUserId })`, `via: 'testlink'`, honoured only with the per-process secret).
- A missing or wrong key gets TestLink's `400 {"status":"ko","message":"authentication error"}`; every answer on those paths is TestLink's envelope, not problem details.
- Each compat route answers only with the HTTP codes Dave's spec documents for it (`statuses` on the route): any other refusal is a 200 with `status: "ko"`/`"error"`, as TestLink's PHP answers, except auth (400), the rate limit (429) and server errors.
- Editing an approved case's content through it makes a new DRAFT (as MCP; decided with Elliot); `status: 7` approves, `5`/`active: 0` deprecates, both needing SPEC_APPROVE.
- A TestLink key isn't the password: the password-change requirement (`must_change_password`) doesn't hold its requests, so a migrated user's scripts work before an admin sets their password.
- `compat_ids.origin` says whether a number came from TestLink (the migration, an XML import) or was given by Tessick; the migration refuses a number Tessick gave.

**Permissions:**
- The registry is in `packages/core/src/rbac/registry.ts` (20 keys).
- Default roles: Admin, Test Lead, Tester, Viewer, Automation Service and No Access. Roles are editable and deletable once unused. New users default to Tester.
- `SYSTEM_ADMIN` passes every check.
- A project role replaces the global role in that project. Overrides (global or per project) have the final say.
- To limit a user to some projects, give them the No Access global role plus project roles.

**Where permissions are checked** (`apps/server/src/middleware/auth.ts`):
- `authenticateRequest` resolves the request's project from the route's ids (`resolveRequestProject`) and evaluates permissions **in that project**.
- Routes use `requirePermission(key)` or `requireAnyPermission(keys)` as preHandlers.
- Reads needed for executing accept `SPEC_VIEW` or `EXECUTE_RUN` (`EXECUTION_READ_PERMISSIONS`). Without `SPEC_VIEW`, the spec tree only shows the plan's cases.
- `GET /api/v1/projects` lists only projects the caller can view or execute in, with `permissions` for each.
- The web app uses those per-project permissions (`can`); the Admin Panel button and "Create project" use global permissions (`globalCan`).

**Admin changes** go through `services/adminGuard.ts`:
- Nobody can grant a permission they don't hold.
- Nobody can change a user or role that outranks them.
- The last active admin can't be removed.

## Server conventions

- **Routes** (conventions, the full route map and the error codes are in `docs/rfc_03_api_and_xml_contracts.md` §1-4; keep it current when a route changes):
  - Lists and creation sit under the parent (`/projects/:projectId/plans`); each item has its own address (`/plans/:planId`, `/runs/:runId`, `/cases/:caseId`, ...).
  - `authenticateRequest` works out the project from every id the request names (path, query and JSON body) and stores it as `request.projectId`; ids from two projects get `400 PROJECTS_DIFFER`. Routes still check that other ids in the request belong to that project.
  - Verbs: `PATCH` for a partial update; `PUT` only to replace a whole thing (a custom-field value, a user's override set, a report schedule, the email settings); `?force=true` for "delete anyway".
  - Responses: create answers 201 with the item wrapped in its name (`{ "plan": {...} }`), update 200 the same way, delete 204 with no body. Lists are `{ "plans": [...] }`.
  - Lists that grow (a project's cases, a run's results, a plan's runs, the audit log, case history) are paged: `limit` and `cursor` in, `next_cursor` out (null on the last page). Keyset helpers are in `packages/db/src/paging.ts`; routes read the page with `readPage` (`apps/server/src/paging.ts`), which answers `400 INVALID_CURSOR`. Short lists stay whole.
  - Fields are snake_case, and ids are named after their database columns (`test_plan_id`, `test_run_id`, `test_case_id`, ...). Never "build" or "execution" in a new address, field or code.
  - A case may be named by its readable id (SHOP-12) wherever a case id is taken: `authenticateRequest` replaces `:caseId`, `test_case_id` and `case_ids` with internal ids once the caller is known (`caseRefs.ts`). A readable id shared by several projects is settled by the request's project or an API token's, otherwise `400 AMBIGUOUS_CASE_ID`.
  - Bulk changes (`routes/bulkChanges.ts`) and MCP write tools run each change through its ordinary route in-process (`innerRequest` in `internalRequests.ts`, as the caller), so they need no rules of their own. Such requests carry a per-process secret: they aren't rate-limited twice, and `internalVia(request)` says `bulk`, `mcp` or `testlink` (`mcp` makes new cases DRAFT and marks audit User-Agents "(via Tessick MCP)"; `testlink` acts as the key's user, marks them "(via TestLink API)", and starts a case as DRAFT when the client asked for one: `startsAsDraft`).
  - In the web app, take addresses from `apps/web/src/api/routes.ts`.
- **Route schemas (OpenAPI):**
  - A documented route has `schema` (tags, summary, params, query, body, responses) from `apps/server/src/openapi/areas/<area>.ts`; shared schemas and helpers (`wrapped`, `list`, `authedErrors`, `NO_CONTENT`, `FORCE_QUERY`, `handlerValidated`, and `oneOf` for any field limited to a set of values, which also lists them in the description) are in `openapi/schemas.ts`. Routes without a tag stay out of the spec, and `openapi.test.ts` fails if any `/api` or `/mcp` route is missing (or mark it `hide: true`).
  - Request schemas are enforced (bodies without type coercion; query and params with it), giving `400 INVALID_REQUEST` with `invalid_params`. Mark a body `handlerValidated` when the route checks it itself with more specific errors.
  - Every documented route gets an `operationId` made from its summary (`operationIdFrom` in `openapi/index.ts`: "List a plan's test runs" → `listPlanTestRuns`, a noun GET gets `get`; set `operationId` in the schema where that reads badly), and a 400 when it takes a body or query string (`completeOperation`). `openapi.test.ts` checks the ids are unique.
  - A body field the schema doesn't list is refused at any depth ("isn't a known field"), handler-validated bodies included (only that is checked for them: `fieldsOnly` in `openapi/index.ts`). An object stays open only where its schema says `additionalProperties`. So every field a route reads must be in its schema, and the web app sends only those (not, say, an option's `id` it got back). Decided with Elliot (API audit, 2026-10-23). MCP tools refuse arguments their `inputSchema` doesn't list, and report and search filters refuse keys a filter doesn't have.
  - Response schemas never change a response (plain `JSON.stringify`). In tests every JSON response is checked against its schema, undocumented fields included; a mismatch answers 500 and prints `[openapi] ...`. When you change a route's output, change its schema.
- **Errors:**
  - Every error is problem details (`application/problem+json`): `type`, `title`, `status`, `code`, `detail` (the message people see), the request path as `instance`, `timestamp`, optional `invalid_params: [{ name, reason }]`, and extension fields in snake_case (e.g. `required_permission`, `project_ids`).
  - Send errors with `sendError(reply, status, detail, { code?, invalid_params?, ...extensions })` from `errors.ts`, or one of its specific `send*Error` helpers. `code` defaults from the status (404 → `NOT_FOUND`).
  - Throw a plain `Error` only when its message is meant for users (`isPublicError`).
  - Anything else becomes a generic 500 with a `request_id`, and the details go only to the log. Unknown addresses get a 404 in the same format, and an API address under the wrong method a 405 with `Allow` (`unknownAddress.ts`). A 401 carries `WWW-Authenticate: Bearer` (`sendError`).
  - Exceptions: the MCP endpoint answers in JSON-RPC (the protocol requires it); the TestLink-compatible API answers TestLink's `{status:"ko", message}` (problem details from shared checks are rewritten, `problemToEnvelope`); and a batch request's per-item results carry their own `detail`/`code` inside a normal response.
  - In the web app, read error messages with `errorMessage(body)` from `apps/web/src/api/errors.ts`.
- **Audit rows:**
  - Write one for every security-relevant change, with `...requestOrigin(request)` (real address and User-Agent) and `actor_type: actorType(user)` (`SERVICE_ACCOUNT` for an API token).
  - A new action only shows in the Admin Panel's Security Audit Log once it's added to `securityActions` in `routes/admin.ts`.
  - `writeAudit(db, request, {...})` and `changedFields` in `audit.ts` write one for the request's caller (used by plans and runs).
- **Webhook events:** after a change commits, call the matching helper in `services/webhookEvents.ts` (`emitRunClosed`, `emitResultsRecorded`, ...); it queues deliveries for subscribed webhooks and never throws. A new event goes into `WEBHOOK_EVENTS` (`packages/core/src/webhooks/`), the Slack renderer there, and RFC 03 §7.3.
- **Validate input up front** (`resultValidation.ts`, `stepValidation.ts`, `nameProblem` in `specEditing.ts`), so bad input gets a 400 naming each field instead of a database error:
  - **Limits** come from the columns: names 255 (`MAX_NAME_LENGTH`), integers 2,147,483,647 (`MAX_DB_INTEGER`; durations, positions, step numbers), in `packages/core/src/limits`. Put `maxLength`/`maximum` on enforced body schemas; handler-validated bodies check in the route.
  - **NUL characters** are refused before any route runs (`registerNulGuard` in `storableInput.ts`). Routes whose input is other tools' output set `config: { stripNul: true }` to remove them instead: results, imports, `/mcp`. Imported files are cleaned after parsing (`storableSuites`).
  - **Safety net:** a data exception the database still raises (too long, out of range) answers `400 INVALID_REQUEST` and logs `unstorable_value`. Seeing one means a check is missing.
- **Transactions:** group a change into one transaction. Repositories that may run inside a caller's transaction use the `runInTransaction` pattern (if `db.isTransaction`, run directly; otherwise open one). Inside a transaction's callback, use only `trx`: on PostgreSQL a `db` query there runs on another connection, outside the transaction (on PGlite it runs inside it, and a `db.transaction()` there is refused).
- **Schema changes:** a new migration `packages/db/src/migrations/00N_<name>.ts` with `up` and `down`, registered in `MIGRATIONS`. Never edit a migration that has shipped; databases record which ones they ran. Ids are `varchar(36)` UUIDs, so never prefix them.
- **Logging and limits:**
  - Logs are JSON lines to stdout (`observability.ts`). Never log headers or bodies.
  - `GET /api/v1/health` is the health check.
  - Rate limits live in `services/rateLimits.ts`, per process: 120 exports per hour and 60 report emails per hour per caller.
  - Request bodies: 1 MB by default; `/mcp` 8 MB (a 5 MB evidence file as base64); CI uploads (JSON batches and JUnit files) 50 MB; imports 50 MB per file, 2 at a time. A 413 says the route's limit (`limit_bytes`).
  - CSV exports neutralize spreadsheet formulas.
- **Browser security headers** (`securityHeaders.ts`) go on every reply: a Content-Security-Policy (the web app's page: its own scripts and API plus Google Fonts; everything else: nothing; a reply that sets its own, like `/docs`, keeps it), no framing, `nosniff`, `no-referrer`, and HSTS over HTTPS. Anything new the web app loads from elsewhere (a CDN, an image host) must be added to its policy there, or browsers block it.
- **Sending responses:** only set `Content-Type: application/json` when there's a body. Fastify answers 400 to an empty JSON body.

## Web conventions

- **State lives in feature hooks**, each returning one object (`type X = ReturnType<typeof useX>`), passed to panes as props.
- **`useApp()`** gives only app-wide values: `currentUser`, `handleLogout`, `handleAuthExpiry`, `showToast`, `can`, `globalCan`, `scope`.
- **Hook order in `App.tsx` matters:** each hook needs values from the ones above it.
- **Requests:**
  - Use `authHeaders()` / `jsonHeaders()` from `utils/session.ts`; never store a token.
  - Any 401 from `/api` signs the user out with "Your sign-in has ended" (`watchForEndedSession`).
- **Loaders that can race** keep a request-sequence ref and apply only the latest response. Clearing state on an empty selection must happen before an early return.
- **Custom-field inputs:**
  - Text, number and date inputs are uncontrolled. Key them per entity *and* field, and clear values before fetching, or one case's value shows on another.
  - A rejected save remounts the input so it shows the stored value again.
- **UI patterns:**
  - Warnings and confirmations use the amber banner; deletes use the two-step warn-then-"Delete Anyway" flow.
  - Toggles are colored squares or pills, as in `CustomFieldEditor` and the permission grids. Only the email settings and schedule forms use native checkboxes.
  - The app starts in Spec mode.
- **Hotkeys** (`useHotkeyEngine`):
  - `j`/`k` move, `/` focuses search, `[`/`]` collapse and expand the tree.
  - `p`/`f`/`b`/`s` record a verdict in Execute mode, and Ctrl+Enter submits notes and jumps to the next folder.
  - Verdict keys are blocked in Spec mode, on closed runs and without permission.

## Decisions to keep

These were chosen deliberately; don't reverse them without asking Elliot.

- **License: AGPL-3.0-only plus a commercial license** (dual licensing, decided with Elliot on 2026-11-16). Selling the commercial license needs Elliot to hold the rights to everything in the repo, so:
  - New dependencies must have permissive licenses (MIT, Apache-2.0, ISC, BSD, BlueOak and the like). No GPL, LGPL, AGPL or other copyleft code, and no copying code or text from projects under such licenses.
  - Outside contributions aren't accepted for now (decided with Elliot, 2026-11-18): the README says so, and no one else's code is merged. If that changes, a contributor license agreement comes first.
- **PostgreSQL only.** SQLite was dropped (native-binding problems), and PGlite is the zero-setup in-memory option. Don't add a second dialect.
- **No sample projects on startup.** Users and roles are seeded, plus dev fixture users on the in-memory database. The sample project exists only for tests (`SEED_SAMPLE_DATA`). The one exception is opt-in demo mode (`TESSICK_DEMO`, set only by `docker-compose.demo.yml`), which loads the Report Demo into a fresh database (decided with Elliot, 2026-11-16).
- **Role templates and template-based dev accounts stay** (audit scope).
- **Custom field rules:** values are unversioned, required fields always have a default, CHECKBOX fields can't be required (see "Domain rules").
- **Results:** notes are kept for every verdict, manual results aren't timed, auto-close happens once and never from CI uploads, results don't snapshot custom fields.
- **Search** covers ids, titles and suite names, not custom field values.
- **Rate limits are generous**, since CI and agents make many calls.
- **Sign-ins:** 8 hours idle and 7 days at most.
- **The Execute-mode suite filter** (`execSuiteFilterId`) is separate from Spec-mode suite selection.
- **Pane widths aren't persisted.**
- **No platforms feature.** TestLink's platforms are kept by the TestLink-compatible API only as plain runs, one per (build, platform); teams tell platforms apart their own way.
- **AI agents (MCP):** cases they create or duplicate are always DRAFT, and editing an approved case makes a new DRAFT. An agent whose token holds `SPEC_APPROVE` may approve with `approve_cases`; the token form shows an amber warning when that capability is on for a token MCP can use (decided with Elliot, 2026-11-18). There are no MCP tools to deprecate, restore or delete. Write tools act only as the caller, through the REST routes.

## Known gaps

- No UI for `allow_draft_plan_linking`.
- Imports:
  - No remembered field mappings and no per-case duplicate-resolution UI.
  - Files are held in memory, hence the 50 MB cap.
- CSV re-import reads a custom field named like a built-in column (`title`, `suite`, `action`, ...) as that column.
- No "sign out everywhere" button or list of your sessions. Changing `SECRETS_KEY` has no rotation; the SMTP password must be re-entered.
- Several server instances share the database, but rate and sign-in limits are counted per instance.
- A custom-field change made by another admin shows only after the next case or suite switch or a reload; nothing is pushed.
- `AuditLogRepository` is used only by tests; routes insert audit rows directly.
- Recharts 2 is deprecated upstream; the Recharts 3 upgrade hasn't been done.
- The TestLink-compatible API can't add cases to a plan or make platforms (Dave's API has no such calls): that's done in Tessick, or by the migration (phase 5).
- Webhooks:
  - No filters beyond events (e.g. only one plan's runs).
  - Events are queued just after their change commits, so a crash between the two loses one. Order isn't guaranteed across retries.
  - The Admin Panel's Webhooks tab (and the Admin Panel button) follow global permissions, like API Tokens: someone with `WEBHOOK_MANAGE` only through a project role uses the API.

## Testing and verification

- **Commands:** `npm test` runs every test; it must stay green. `npm run typecheck` must stay clean.
- **Test workers:** a worker running server tests uses about 1.5 GB (a PGlite per test), so `vitest.config.ts` starts only as many as free memory allows at 2.5 GB each, at most one per core but one. Without that, an 8-core laptop swapped and the root run looked stalled. Say `--maxWorkers=N` to choose.
- **Where tests live:**
  - Server tests start a real server per test on an in-memory database (`createServer()`) and use `app.inject`.
  - Web tests are pure-logic tests, plus `apps/web/src/tests/app.smoke.test.tsx` (jsdom), which renders `<App />` against a fake API.
- **CI** (`.github/workflows/ci.yml`) also runs the production build against real PostgreSQL and builds the Docker image.
- **Verify browser-visible changes live** in a separate origin (`http://127.0.0.1:3000`), so Elliot's sign-in at `localhost:3000` isn't affected. Never drive automated drags in his browser-pane tab; use a fresh tab.
- **Dev servers** may be restarted at any time; their data is throwaway.

## Workflow

- **Every change gets an entry at the end of `docs/changelog.md`:** what changed, why, decisions made with Elliot, tests added, and how it was verified.
- **Update this file** only when a fact, convention, decision or gap above changes. Keep it describing the present.
- **`AGENTS.md` is an identical copy** of this file for other agents. Update both together.
- **Commits:** Elliot has authorized committing directly to the local repo, in logical commits with clear messages. The repo is on GitHub (`origin`, `ElliotNewtonMiller/Tessick`), where every push runs CI, including the production build on real PostgreSQL. Don't push unless asked.
- **Ask before downloading** packages or images.
- **After a change,** give Elliot a short checklist of what to test, and add it to `docs/manual_test_backlog.md` with what you checked yourself and how. Verify UI changes yourself rather than waiting for him; he catches up on the backlog later (decided with Elliot, 2026-11-09).
- **API work:** `docs/api_roadmap.md` tracks the planned API and MCP steps. Update a step's status and the Decisions table as the work happens.
- **Design docs:** when a change makes an RFC, the blueprint or the roadmap wrong, fix that doc in the same change.

## Doc map

1. `README.md`: overview and quick start. `docs/deployment.md`: running Tessick for real.
2. `docs/changelog.md`: the history and reasoning behind everything.
3. `docs/api_getting_started.md`: the API for scripts and CI, step by step. `docs/reports_api_and_mcp.md`: reports, the results API, MCP. The reference itself is `/docs` on a running server.
4. `docs/manual_test_backlog.md`: the checks Elliot will do himself in the web app, and what the agent already checked; at its end, his other tasks (e.g. what selling a commercial license needs). `docs/api_roadmap.md`: where the API stands, and the planned next steps for the API and MCP, with their status.
5. Design documents, updated 2026-10-11 (RFC 03 §1-4 on 2026-10-12) to match the code (each says plainly what isn't built):
   - `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`: the overview, linking to the RFCs.
   - `docs/rfc_01_domain_model.md` (domain, schema, state machines), `rfc_02` (layout, hotkeys), `rfc_03` (the API: conventions, route map, CI results, errors, import), `rfc_04` (permissions, tokens, audit, threat model).
   - `docs/01_vertical_slices_roadmap.md`: what each build slice planned and delivered.
   - `docs/00_requirements_alignment.md` (identical to `.antigravity/requirements_alignment.md`): the locked intake decisions, with "As built" notes.
   - `.antigravity/agents/*.md`: the original planning briefs; they record what was asked for, not what was built.
6. `docs/testlink_compat_api.md`: the TestLink-compatible API for Dave's TestLink clients: keys, paths, the model mapping, its phases and what can't be exact. `docs/migrating_from_testlink.md`: the guide for TestLink admins moving in (XML export and Import wizard, or the database migration).
