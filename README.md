# Tessick

Tessick is an open-source, self-hosted test case management app: a faster, more modern replacement for TestLink.

**Coming from TestLink?** [Moving from TestLink](docs/migrating_from_testlink.md) takes your test cases across with TestLink's own XML export, or your whole database with its history, users and API keys. Scripts written for TestLink's REST API keep working with only the address changed.

- **Specification**: projects, nested test suites and versioned test cases with steps. Each case goes through draft, approved and deprecated, and you can add custom fields of six types, for all projects or chosen ones.
- **Execution**: test plans and test runs, with a keyboard-driven queue (`j`/`k` to move, `p`/`f`/`b`/`s` to record a verdict). CI systems send their JUnit XML reports, or results as JSON, through the API.
- **Reports**: run summaries compared with the previous run, plan trends, flaky and slow tests, case history and breakdowns. They're available in the app, over the REST API, by email and over MCP for AI agents.
- **Evidence**: screenshots, videos, logs and Playwright traces on each executed case. Paste or drop them in the app, or send them from CI (with the results, or the files a JUnit report attaches) or from an AI agent. Files are recognised by their contents and served safely, from disk or S3-compatible storage.
- **Webhooks**: a project's events (a run finishing, tests failing, cases to review, imports) go to Slack, CI or your own code as they happen, signed, with retries.
- **AI agents**: over MCP, an agent can also write test cases (as drafts for a person to approve, or for the agent to approve if its token allows), change many cases at once, manage plans and record results, with only the permissions its token has.
- **Import and export**: TestLink XML, JUnit XML, TestRail CSV, CSV and JSON.
- **Access control**: roles you can edit, per-project roles and overrides, and project-scoped API tokens for CI.

## Try it in a minute

With Docker, and nothing to configure:

```bash
curl -fsSLO https://raw.githubusercontent.com/ElliotNewtonMiller/Tessick/main/docker-compose.demo.yml
docker compose -f docker-compose.demo.yml up
```

Open http://localhost:3001 and sign in as `admin` / `tessick-demo-admin` (the sign-in page shows it). A demo project is loaded, with eight runs of results to explore in Reports and an open run to try the keyboard-driven execution on. If port 3001 is taken, start it with `TESSICK_PORT=3002` in front. `docker compose -f docker-compose.demo.yml down -v` removes it all.

The demo's password is public, so it only listens on your own machine. To keep real data, see [Running it for real](#running-it-for-real).

## Running it for real

Tessick runs as one process that serves both the API and the web app, on top of PostgreSQL. The quickest way to get both is Docker Compose:

```bash
cp .env.example .env    # then fill in POSTGRES_PASSWORD and JWT_SECRET (openssl rand -hex 32)
docker compose up -d
docker compose logs tessick   # shows the first admin's generated password, once
```

Then open http://localhost:3001.

Without Docker:

```bash
npm ci
npm run build
DATABASE_URL=postgres://user:pass@host:5432/tessick JWT_SECRET=$(openssl rand -hex 32) npm start
```

[docs/deployment.md](docs/deployment.md) covers configuration, HTTPS and reverse proxies, backups, upgrades and running more than one instance.

## API and integrations

- **Getting started**: [docs/api_getting_started.md](docs/api_getting_started.md) takes you from making an API token to a CI pipeline that records its results (with examples for GitHub Actions, GitLab CI, Jenkins and Azure DevOps).
- **REST API**: sign in with `POST /api/v1/auth/login`, or use an API token from Admin Panel → API Tokens (`Authorization: Bearer tk_ci_...`).
- **API docs page**: open `/docs` on your server (e.g. `http://localhost:3001/docs`) to browse the routes and try them; the OpenAPI spec is at `/docs/json`. Every route is on it.
- **Results from CI**: upload the JUnit XML report your tests already write (`POST /api/v1/plans/:planId/results/junit?run_name=...`), or send JSON (`POST /api/v1/runs/:runId/results/batch`).
- **API reference**: [docs/rfc_03_api_and_xml_contracts.md](docs/rfc_03_api_and_xml_contracts.md) §1-4 has the conventions, every route and the error codes.
- **Reports and MCP**: [docs/reports_api_and_mcp.md](docs/reports_api_and_mcp.md) describes every report, how to send results that make good reports, and how to connect an AI agent to `/mcp`, and what agents may change.
- **Health check**: `GET /api/v1/health`.

## Development

Needs Node.js 22 or newer. To run it from source:

```bash
npm install
npm run dev --workspace=apps/server   # API on http://localhost:3001
npm run dev --workspace=apps/web      # web app on http://localhost:3000 (in a second terminal)
```

Open http://localhost:3000 and sign in as `admin` / `password`.

The development server uses a throwaway in-memory database, so every restart starts empty. It also creates test users for each built-in role, all with the password `DevTest123!`: `test_lead`, `tester`, `viewer`, `automation_bot`, `project_admin` and `override_tester`. To load a demo project with eight runs of results, run:

```bash
npx tsx apps/server/scripts/report-demo.ts
```

Tests and builds:

```bash
npm test             # every test, in all workspaces (Vitest)
npm run typecheck    # TypeScript, in all workspaces
npm run build        # production build: apps/web/dist and apps/server/dist/server.js
```

The code is split into npm workspaces:

| Path | What's in it |
| --- | --- |
| `apps/server` | The Fastify API server, which also serves the built web app, plus the MCP endpoint at `/mcp`. |
| `apps/web` | The React and Vite web app. |
| `packages/core` | Domain logic with no database: import parsers, report calculations, permissions, custom-field validation. |
| `packages/db` | The Kysely database layer: migrations, repositories and seeds. PostgreSQL in production; in-memory PGlite in development and tests. |

Schema changes always go in a new migration in `packages/db/src/migrations/`; never edit one that has shipped. CI (`.github/workflows/ci.yml`) typechecks, tests and builds every push. It also starts the production build on a real PostgreSQL and checks that the Docker image builds.

`CLAUDE.md` is the detailed guide for AI coding agents and anyone reading the code: what's built, why, and the conventions to follow. The design documents are in `docs/`.

## License

Copyright (c) 2026 Elliot Newton-Miller.

Tessick is dual-licensed:

- **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`; see [LICENSE](LICENSE)). You may use, change and self-host Tessick for free, including inside a company. If you change it and let people use your changed version over a network, you must offer them its source code under the same license.
- **A commercial license**, for organisations that want to use or offer Tessick without the AGPL's terms, for example in a product or hosted service whose source they don't want to publish. To ask about one, contact [Elliot Newton-Miller on GitHub](https://github.com/ElliotNewtonMiller).

Versions published before 2026-11-16 (up to commit `f530a5c`) were released under the MIT license, and remain available under it.

**Contributing:** Tessick isn't accepting outside contributions (pull requests) at this time. Bug reports and ideas are welcome as [issues](https://github.com/ElliotNewtonMiller/Tessick/issues).
