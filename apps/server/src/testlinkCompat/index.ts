import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@tessick/db';
import { logServerError } from '../errors.js';
import { compatAuth } from './auth.js';
import { isAuthFailure, problemToEnvelope, tlKo } from './envelope.js';
import { TESTLINK_VERSIONS, versionPrefix, type TestLinkVersion } from './versions.js';
import { basicRoutes } from './routes/basics.js';
import { projectRoutes } from './routes/projects.js';
import { specRoutes } from './routes/spec.js';
import { projectWriteRoutes } from './routes/projectWrites.js';
import { specWriteRoutes } from './routes/specWrites.js';
import { executionRoutes } from './routes/executions.js';
import { metricsRoutes } from './routes/metrics.js';

/**
 * Tessick's TestLink-compatible API: Dave's TestLink REST API (v1, v2 and custom), answered
 * with TestLink's requests, responses, numeric ids and keys, so a client changes only the host.
 * docs/testlink_compat_api.md describes it; Dave's own openapi.yaml documents the routes, so
 * they're left out of Tessick's spec.
 *
 * Each version is its own context under /lib/api/rest/<version>, with TestLink's 404 and error
 * envelope. Changes go through Tessick's own routes, as the key's user (internalRequests.ts), so
 * permissions, validation, audit rows and webhooks are Tessick's.
 */
export interface CompatContext {
  db: Kysely<Database>;
  version: TestLinkVersion;
}

export interface CompatRoute {
  method: 'GET' | 'POST';
  path: string;
  versions: TestLinkVersion[];
  /** Needs a TestLink API key (testlinkCompat/auth.ts). */
  auth: boolean;
  /**
   * The HTTP codes besides 200 Dave's spec documents for the route. TestLink's PHP reports most
   * refusals in the body (`status: "ko"` or `"error"`) with 200, so any other code a handler
   * sends becomes 200, except an authentication error (400), the rate limit (429) and a server
   * error (5xx).
   */
  statuses: number[];
  handle: (request: FastifyRequest, reply: FastifyReply, ctx: CompatContext) => Promise<unknown>;
}

export const COMPAT_ROUTES: CompatRoute[] = [...basicRoutes, ...projectRoutes, ...specRoutes, ...projectWriteRoutes, ...specWriteRoutes, ...executionRoutes, ...metricsRoutes];

export async function registerTestLinkCompat(app: FastifyInstance, db: Kysely<Database>): Promise<void> {
  for (const version of TESTLINK_VERSIONS) {
    await app.register(
      async (scope) => {
        scope.addHook('onSend', problemToEnvelope);
        // TestLink reads every body as JSON, whatever its Content-Type (or none).
        scope.removeContentTypeParser('text/plain');
        scope.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
          const text = String(body ?? '').trim();
          if (!text) return done(null, undefined);
          try {
            done(null, JSON.parse(text));
          } catch {
            done(Object.assign(new Error("The request body isn't valid JSON"), { statusCode: 400 }), undefined);
          }
        });
        scope.setNotFoundHandler((request, reply) => tlKo(reply, 404, `Route ${request.method} ${request.url.split('?')[0]} not found`));
        scope.setErrorHandler((error: any, request, reply) => {
          const status = typeof error?.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
          if (status >= 500) logServerError(error, request);
          return tlKo(reply, status, status >= 500 ? `Server error (request ${request.id})` : String(error?.message ?? 'Bad request'));
        });
        const ctx: CompatContext = { db, version };
        for (const route of COMPAT_ROUTES.filter((r) => r.versions.includes(version))) {
          const documented = new Set([200, ...route.statuses]);
          scope.route({
            method: route.method,
            url: route.path,
            schema: { hide: true },
            onSend: async (_request, reply, payload) => {
              const code = reply.statusCode;
              if (!documented.has(code) && code < 500 && code !== 429 && !isAuthFailure(reply)) reply.code(200);
              return payload;
            },
            ...(route.auth ? { preHandler: compatAuth(db, version) } : {}),
            handler: (request, reply) => route.handle(request, reply, ctx),
          });
        }
      },
      { prefix: versionPrefix(version) }
    );
  }
}
