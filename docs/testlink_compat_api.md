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
| 2 | Reads: projects, plans, builds, the suite tree, testspec, custom fields, keywords, case lists with the query layer | To do |
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

## How Testify's model maps (phases 2 to 5)

| TestLink | Testify |
| :--- | :--- |
| test project, suite, case, version, plan | project, suite, case, version, plan. Numeric ids in one sequence, as TestLink's `nodes_hierarchy` |
| build | run |
| execution (`p`/`f`/`b`) | a result (PASSED/FAILED/BLOCKED), recorded as a CI result, so it never auto-closes the run (as in TestLink) |
| importance 1/2/3, execution type 1/2 | LOW/MEDIUM/HIGH (CRITICAL reads as 3), MANUAL/AUTOMATED |
| workflow status 1-7, `active` | draft, review, rework and future → DRAFT; final → APPROVED; obsolete or inactive → DEPRECATED |
| custom fields (12 types; pipe-delimited values) | custom fields (6 types; lists) |
| keywords | a project MULTI_SELECT field "Keywords" |
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
