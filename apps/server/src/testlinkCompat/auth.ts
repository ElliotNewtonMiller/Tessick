import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { UserApiKeyRepository, UserRepository, RoleRepository, type Database } from '@testify/db';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { tlAuthError, tlKo } from './envelope.js';
import type { TestLinkVersion } from './versions.js';

/**
 * A TestLink-compatible request's key: the user's TestLink API key (user_api_keys), sent as
 * TestLink takes it.
 * - v2 and custom: the `APIKEY` header, or as a fallback the HTTP Basic user name.
 * - v1: only the HTTP Basic user name (TestLink's v1 doesn't read the header).
 *
 * The key works only here, on the compatible paths, and with the user's own permissions in each
 * project (Testify's project-bound tokens and MCP rules are untouched). A missing, unknown or
 * removed key, or a disabled user, gets TestLink's 400 "authentication error". The user's
 * requests count against their per-user rate limit, as a sign-in's do.
 */
export function keyFrom(request: FastifyRequest, version: TestLinkVersion): string | null {
  if (version !== 'v1') {
    const header = request.headers.apikey;
    if (typeof header === 'string' && header.trim()) return header.trim();
  }
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && /^basic\s+/i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
      const user = decoded.split(':')[0]?.trim();
      return user || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** last_used_at is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60_000;

export function compatAuth(db: Kysely<Database>, version: TestLinkVersion) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = keyFrom(request, version);
    if (!key) return tlAuthError(reply);
    const keys = new UserApiKeyRepository(db);
    const found = await keys.findByKey(key);
    if (!found) return tlAuthError(reply);
    const user = await new UserRepository(db).findById(found.user_id);
    if (!user || user.status === 'DISABLED') return tlAuthError(reply);

    const limiter = request.server.rateLimits?.user;
    if (limiter) {
      const limited = limiter.take(`user:${user.id}`);
      if (!limited.allowed) {
        reply.header('Retry-After', String(limited.retryAfterSeconds));
        return tlKo(reply, 429, `Too many requests from this user: try again in ${limited.retryAfterSeconds} s.`);
      }
    }
    const now = new Date();
    if (!found.last_used_at || now.getTime() - Date.parse(found.last_used_at) > TOUCH_EVERY_MS) {
      await keys.touch(found.id, now.toISOString()).catch(() => undefined);
    }

    const roles = new RoleRepository(db);
    const caller: AuthenticatedUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      global_role: await roles.getUserGlobalRole(user.id),
      // Global permissions; a route asks for the project's with permissionsInProject.
      permissions: await roles.evaluatePermissions(user.id, null),
      must_change_password: user.must_change_password,
    };
    request.user = caller;
  };
}
