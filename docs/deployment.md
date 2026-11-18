# Deploying Tessick

Tessick is one Node.js process that serves the API, the MCP endpoint (`/mcp`) and the web app on one port, on top of PostgreSQL. Database migrations run automatically at startup.

**Requirements**:
- PostgreSQL (tested with 17).
- Node.js 22 or newer, or Docker.

## Trying it: the demo

`docker-compose.demo.yml` starts Tessick and PostgreSQL with nothing to configure, and loads the Report Demo project (12 cases, 8 runs of results):

```bash
curl -fsSLO https://raw.githubusercontent.com/ElliotNewtonMiller/Tessick/main/docker-compose.demo.yml
docker compose -f docker-compose.demo.yml up
```

Open http://localhost:3001 and sign in as `admin` / `tessick-demo-admin`; the sign-in page shows it. The log shows an API token for the demo project, with the command that connects Claude Code to it over MCP. `docker compose -f docker-compose.demo.yml down -v` deletes it all, to start again.

It runs in demo mode (`TESSICK_DEMO=true`): the admin password is well known, and the database password is in the file. It's reachable only from the same machine (`127.0.0.1`). Don't keep real data in it; use `docker-compose.yml` for that.

## With Docker Compose

`docker-compose.yml` runs Tessick and PostgreSQL together, with the database kept in a Docker volume.

1. `cp .env.example .env`, then fill in `POSTGRES_PASSWORD` and `JWT_SECRET`. Generate each with `openssl rand -hex 32`. Also set `SECRETS_KEY` if you'll send email or use webhooks.
2. `docker compose up -d`
3. `docker compose logs tessick` shows the first admin's password. Sign in at http://localhost:3001 as `admin`; you'll be asked to choose a new password.

Tessick listens on port 3001; set `TESSICK_PORT` in `.env` to use another port on the host. To upgrade, pull the new code and run `docker compose up -d --build`.

The image (`Dockerfile`) works on its own too. Each push to `main` publishes it as `ghcr.io/elliotnewtonmiller/tessick`, for amd64 and arm64, tagged `latest` and `sha-<commit>`:

```bash
docker run -p 3001:3001 -e DATABASE_URL=... -e JWT_SECRET=... -e EVIDENCE_DIR=/data/evidence ghcr.io/elliotnewtonmiller/tessick:latest
# or build it yourself: docker build -t tessick .
```

`docker-compose.yml` builds the image from the code (`build: .`); to use the published one instead, replace that line with `image: ghcr.io/elliotnewtonmiller/tessick:latest`.

It runs as the unprivileged `node` user, and Docker checks its health through `GET /api/v1/health`.

## Without Docker

```bash
npm ci
npm run build    # apps/web/dist and apps/server/dist/server.js
DATABASE_URL=postgres://tessick:secret@db.example.com:5432/tessick \
JWT_SECRET=<32+ random characters> \
NODE_ENV=production \
npm start
```

`npm start` runs `node apps/server/dist/server.js`. It needs the repository's `node_modules` (`npm ci --omit=dev` is enough at run time) and `apps/web/dist`. Run it under a process manager such as systemd, and restart it if it exits.

## Configuration

All configuration comes from environment variables; nothing reads a `.env` file except Docker Compose. A value that's wrong stops the server at startup, with a message saying what to set.

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | `postgres://user:password@host:5432/database`. Development only: `memory` for a throwaway in-memory database. |
| `JWT_SECRET` | none (required) | Signs sign-ins. At least 32 characters. Must be the same on every instance and must not change, or everyone is signed out. |
| `SECRETS_KEY` | none | Encrypts the SMTP password saved in Admin Panel → Email and webhooks' signing secrets. At least 32 characters. Without it, no SMTP password can be saved and no webhook created. If it changes, the password must be entered again and webhook secrets rotated. |
| `ADMIN_PASSWORD` | generated | The first admin's password, used only when the database has no users. Unset, a random one is printed once in the log and must be changed at first sign-in. |
| `PORT` | `3001` | The port to listen on. |
| `NODE_ENV` | | Set to `production` to refuse `DATABASE_URL=memory`. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so client addresses and HTTPS come from its `X-Forwarded-*` headers. |
| `WEBHOOK_ALLOW_LOCAL` | `false` | Set `true` to let webhooks reach loopback and link-local addresses (`localhost`, `127.x`, `169.254.x`), e.g. a receiver on the same machine. Private-network addresses (`10.x`, `192.168.x`, ...) work either way. `npm run dev` sets it. |
| `CORS_ORIGINS` | none | Only needed if the web app is served from a different address than the API: a comma-separated list of exact origins. |
| `LOG_LEVEL` | `info` | `info` logs one JSON line per request. `warn` and `error` log only problems; `silent` logs nothing. |
| `WEB_DIST_DIR` | `apps/web/dist` | Where the built web app is. If there's no build, only the API is served. |
| `SEED_SAMPLE_DATA` | `false` | `true` creates a small sample project. |
| `TESSICK_DEMO` | `false` | `true` is demo mode, for trying Tessick (`docker-compose.demo.yml`), never for real data: the first admin's password is `tessick-demo-admin` (unless `ADMIN_PASSWORD` is set) and the sign-in page shows it; `JWT_SECRET` and `SECRETS_KEY` may be left unset (random for each start, so a restart signs everyone out); and a fresh database gets the Report Demo project. |
| `EVIDENCE_STORAGE` | from the settings below | Where evidence files (screenshots, videos, logs, traces uploaded for test executions) are kept: `local` (a directory) or `s3` (a bucket). `memory` only with `DATABASE_URL=memory`. **A real database needs one**: startup stops otherwise. Docker Compose uses `local` on the `evidence-data` volume. |
| `EVIDENCE_DIR` | none | `local`: the directory. Tessick must be able to write to it (checked at startup); it makes its folders 0700 and files 0600. |
| `EVIDENCE_S3_BUCKET` | none | `s3`: the bucket. Credentials come from AWS's own variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, ...) or the server's IAM role. Startup checks the bucket can be reached. |
| `EVIDENCE_S3_REGION` | none | `s3`: the bucket's region (`us-east-1` when `EVIDENCE_S3_ENDPOINT` is set and this isn't). |
| `EVIDENCE_S3_ENDPOINT` | none | `s3`: an S3-compatible server's address (MinIO, Cloudflare R2, ...). |
| `EVIDENCE_S3_FORCE_PATH_STYLE` | `false` | `s3`: `true` for most S3-compatible servers (`https://host/bucket/key`). |
| `EVIDENCE_S3_PREFIX` | none | `s3`: a prefix for Tessick's files in a shared bucket. |
| `EVIDENCE_S3_SSE` | none | `s3`: `AES256` or `aws:kms` to ask for server-side encryption. |
| `EVIDENCE_MAX_FILE_MB` | `200` | The largest evidence file accepted, in MB. |

## HTTPS and reverse proxies

Put Tessick behind a reverse proxy (nginx, Caddy, Traefik, a cloud load balancer) that handles HTTPS. Then:

- **Set `TRUST_PROXY=true`.** Sign-in limits then see real client addresses, the audit log records them, the session cookie is marked `Secure`, and replies over HTTPS carry `Strict-Transport-Security` (browsers then refuse plain HTTP to Tessick for a year, so serve it over HTTPS only from then on).
- **Tessick itself speaks only HTTP.** A client sent to `https://` on Tessick's own port (no proxy in between) fails with "TLS handshake failed". Tessick then logs a warning, at most once a minute: "A client spoke HTTPS (TLS) to this plain-HTTP port". Without a proxy, as on a laptop, use `http://`.
- **Security headers are Tessick's own.** Every reply already has a Content-Security-Policy, no-framing, `nosniff` and referrer headers, so the proxy needn't add them. If it does, keep them no looser.
- **Allow large uploads.** Imports can be up to 50 MB; with nginx, set `client_max_body_size 60m;`.
- **Set the address used in emails.** In Admin Panel → Email, set "Tessick address for links in emails" to the public address, e.g. `https://tessick.example.com`.

The session cookie is `SameSite=Strict`, so serve the web app and the API from the same site. The built-in serving of the web app does that.

## Health and logs

- **API docs:** `/docs` (Swagger UI) and `/docs/json` (the OpenAPI spec) need no sign-in. They describe the API, not your data; "Try it out" still needs a sign-in or API token.
- **Health:** `GET /api/v1/health` needs no sign-in. It returns 200 while the server and its database are up, and 503 otherwise. Point load balancers and uptime monitors at it.
- **Logs:** everything goes to stdout and stderr. Each request is one JSON line with its id, method, address, status, time taken and who made it; headers and request bodies are never logged.
- **Tracing an error:** every reply carries an `X-Request-Id` header. An unexpected error's reply shows the same id, so you can find its log line.

## Backups and upgrades

- **Backups:** the data is in PostgreSQL, and evidence files in their directory or bucket. Back up both, at the same time:
  - the database with `pg_dump`, e.g. `docker compose exec db pg_dump -U tessick tessick > tessick.sql`;
  - the evidence directory (the `evidence-data` volume), or rely on the bucket's own versioning or replication.

  A database restored without its files lists evidence whose files are missing (reading them fails). Files without rows are harmless, but take space. Keep `JWT_SECRET` and `SECRETS_KEY` somewhere safe too; they aren't in the database.
- **Upgrades:** stop Tessick, back up the database, then start the new version. Pending migrations run at startup, and a failed one stops the server with its name. Migrations only move forward; to go back to an older version, restore the backup.

## More than one instance

Several instances can share one database if they share `JWT_SECRET` and `SECRETS_KEY`. Scheduled report emails and webhook deliveries are claimed atomically, so none is sent twice. Some limits are counted per instance, so with N instances they're effectively N times higher:
- sign-in attempts per address;
- API token, export and email rate limits;
- at most 2 imports at a time.

Account lockouts are stored in the database and apply across all instances.

## Moving from TestLink

[migrating_from_testlink.md](migrating_from_testlink.md) is the step-by-step guide: TestLink's XML export through the Import wizard, or the whole database.

To move a TestLink 1.9 database into Tessick, keeping its ids, API keys and history for the TestLink-compatible API, run `apps/server/scripts/migrate-testlink.ts` with `--dry-run` first. The options and what it brings are in [testlink_compat_api.md](testlink_compat_api.md), "Migration". Migrated users have no password until an admin sets one; their TestLink API keys work from the start.

## Security checklist

- Strong, unique `JWT_SECRET`, `SECRETS_KEY` and database password, kept out of version control (`.env` is git-ignored).
- `TESSICK_DEMO` not set: demo mode's admin password is public.
- HTTPS in front, with `TRUST_PROXY=true`.
- Change the first admin's password at first sign-in. Tessick asks for it when it generated the password.
- PostgreSQL reachable only from Tessick, not from the internet.
- Regular database backups, restored at least once to check they work.
