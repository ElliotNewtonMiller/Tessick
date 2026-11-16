import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { LogController, type FastifyInstance } from 'fastify';
import type { Database } from '@tessick/db';
import { healthSchema } from './openapi/areas/other.js';

/** How long the health check waits for the database before calling it unreachable. */
export const HEALTH_DB_TIMEOUT_MS = 3000;

export const HEALTH_PATH = '/api/v1/health';

/**
 * Fastify's logger options: one JSON line per request (written by `registerRequestLogging`, not
 * Fastify's own two-lines-per-request logging), and request ids that are unique across restarts
 * so a reported id can be found in the log.
 */
export function loggerOptions(level: string, stream?: NodeJS.WritableStream) {
  return {
    logger: level === 'silent' ? false : { level, ...(stream ? { stream } : {}) },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
  };
}

/**
 * One log line per finished request: method, address, status, time taken, and who made it (user
 * or API token id) when known. Headers and bodies are never logged, so cookies, tokens and
 * passwords stay out of the log. Successful health checks are logged at `debug` only, since a
 * load balancer probes them every few seconds. Every reply carries its request id in
 * X-Request-Id, the same id an unexpected-error reply and its log line show.
 */
/**
 * A URL as it may be logged: an evidence upload link's token is its only credential, so it's
 * replaced (routes/evidence.ts; the link is single-use and expires in 15 minutes anyway).
 */
export function loggableUrl(url: string): string {
  return url.replace(/^(\/api\/v1\/evidence-uploads\/)(?!.*\/complete)[A-Za-z0-9_-]+/, '$1[token]');
}

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const user = request.user;
    const line = {
      method: request.method,
      url: loggableUrl(request.url),
      status_code: reply.statusCode,
      response_time_ms: Math.round(reply.elapsedTime * 10) / 10,
      ...(user?.api_token ? { api_token_id: user.api_token.id } : user ? { user_id: user.id } : {}),
    };
    const quiet = reply.statusCode < 400 && request.url.split('?')[0] === HEALTH_PATH;
    if (quiet) request.log.debug(line, 'request');
    else request.log.info(line, 'request');
  });
}

/**
 * GET /api/v1/health (no sign-in): 200 when the server is up and its database answers, 503
 * otherwise -- for load balancers, container health checks and uptime monitors. Says nothing
 * about the data or the version.
 */
export function registerHealthRoute(app: FastifyInstance, db: Kysely<Database>): void {
  const startedAt = Date.now();
  app.get(HEALTH_PATH, { schema: healthSchema }, async (request, reply) => {
    let timer: NodeJS.Timeout | undefined;
    const database = await Promise.race([
      sql`select 1`.execute(db).then(() => 'ok' as const),
      new Promise<'unreachable'>((resolve) => {
        timer = setTimeout(() => resolve('unreachable'), HEALTH_DB_TIMEOUT_MS);
      }),
    ])
      .catch((err) => {
        request.log.error({ err }, 'Health check: the database query failed');
        return 'unreachable' as const;
      })
      .finally(() => clearTimeout(timer));
    reply.header('Cache-Control', 'no-store');
    const uptime_seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (database !== 'ok') {
      return reply.status(503).send({ status: 'unavailable', database, uptime_seconds });
    }
    return { status: 'ok', database, uptime_seconds };
  });
}

/** How often, at most, the HTTPS-on-the-HTTP-port hint is logged (a client retrying would repeat it). */
const HTTPS_HINT_INTERVAL_MS = 60_000;

/**
 * Tessick serves plain HTTP (HTTPS is a reverse proxy's job, docs/deployment.md). A client sent to
 * `https://` on its port starts a TLS handshake, which fails on the client's side with an unhelpful
 * "TLS handshake failed" / EPROTO, and on Tessick's side as a request it can't parse. Recognise that
 * (a TLS handshake record starts with byte 0x16) and say plainly in the log what to change.
 */
export function registerHttpsOnHttpHint(app: FastifyInstance): void {
  let lastLoggedAt = 0;
  app.server.on('clientError', (err: Error & { rawPacket?: Buffer }) => {
    if (err.rawPacket?.[0] !== 0x16) return;
    const now = Date.now();
    if (now - lastLoggedAt < HTTPS_HINT_INTERVAL_MS) return;
    lastLoggedAt = now;
    app.log.warn(
      { event: 'https_on_http_port' },
      'A client spoke HTTPS (TLS) to this plain-HTTP port. Tessick serves HTTP: use an http:// address (e.g. http://localhost:3001/mcp), or put an HTTPS reverse proxy in front (docs/deployment.md).'
    );
  });
}
