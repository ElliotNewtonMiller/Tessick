import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { logServerError } from '../errors.js';
import { compatAuth } from './auth.js';
import { problemToEnvelope, tlKo } from './envelope.js';
import { TESTLINK_VERSIONS, versionPrefix, type TestLinkVersion } from './versions.js';
import { basicRoutes } from './routes/basics.js';

/**
 * Testify's TestLink-compatible API: Dave's TestLink REST API (v1, v2 and custom), answered
 * with TestLink's requests, responses, numeric ids and keys, so a client changes only the host.
 * docs/testlink_compat_api.md describes it; Dave's own openapi.yaml documents the routes, so
 * they're left out of Testify's spec.
 *
 * Each version is its own context under /lib/api/rest/<version>, with TestLink's 404 and error
 * envelope. Changes go through Testify's own routes, as the key's user (internalRequests.ts), so
 * permissions, validation, audit rows and webhooks are Testify's.
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
  handle: (request: FastifyRequest, reply: FastifyReply, ctx: CompatContext) => Promise<unknown>;
}

export const COMPAT_ROUTES: CompatRoute[] = [...basicRoutes];

export async function registerTestLinkCompat(app: FastifyInstance, db: Kysely<Database>): Promise<void> {
  for (const version of TESTLINK_VERSIONS) {
    await app.register(
      async (scope) => {
        scope.addHook('onSend', problemToEnvelope);
        scope.setNotFoundHandler((request, reply) => tlKo(reply, 404, `Route ${request.method} ${request.url.split('?')[0]} not found`));
        scope.setErrorHandler((error: any, request, reply) => {
          const status = typeof error?.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
          if (status >= 500) logServerError(error, request);
          return tlKo(reply, status, status >= 500 ? `Server error (request ${request.id})` : String(error?.message ?? 'Bad request'));
        });
        const ctx: CompatContext = { db, version };
        for (const route of COMPAT_ROUTES.filter((r) => r.versions.includes(version))) {
          scope.route({
            method: route.method,
            url: route.path,
            schema: { hide: true },
            ...(route.auth ? { preHandler: compatAuth(db, version) } : {}),
            handler: (request, reply) => route.handle(request, reply, ctx),
          });
        }
      },
      { prefix: versionPrefix(version) }
    );
  }
}
