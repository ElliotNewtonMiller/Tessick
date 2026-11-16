import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@tessick/db';
import { sendError } from '../errors.js';

/**
 * `Idempotency-Key` on the result routes (one result, JSON batches, JUnit uploads): a CI job that
 * retries an upload after a network error sends the same key, and gets the first answer back
 * instead of every result recorded twice. The header is optional; without it nothing changes.
 * Decided with Elliot (API audit, 2026-10-23); the shape follows the IETF httpapi draft.
 *
 * - A key belongs to its caller (a user or an API token), the project and the route, so two
 *   projects' CI jobs both using "build-42" never meet, and nobody else's answer is replayed.
 *   Authentication and permission checks run first: a revoked token gets nothing back.
 * - The first request with a key holds it (IN_PROGRESS) while it runs. A 2xx answer is kept
 *   (COMPLETE) for 24 hours; anything else frees the key, so a retry after fixing it runs.
 * - The same key again: the same request gets the kept answer with `Idempotent-Replayed: true`
 *   (the route doesn't run, so no webhook or audit row repeats); a different request is 422
 *   `IDEMPOTENCY_KEY_REUSED` (a script reusing one key for several files would otherwise lose
 *   their results); one still running is 409 `IDEMPOTENCY_KEY_IN_USE` with `Retry-After`.
 * - A key held for over 10 minutes means its request never finished (the server stopped); the
 *   next request with it runs. Its results may or may not have been saved then.
 */

export const IDEMPOTENCY_KEY_HOURS = 24;
const STALE_AFTER_MS = 10 * 60_000;
export const IDEMPOTENCY_HEADER = 'idempotency-key';

declare module 'fastify' {
  interface FastifyRequest {
    /** The idempotency_keys row this request holds until its answer is sent. */
    idempotencyRowId?: string;
  }
}

/**
 * The key from the header: a plain value, or a quoted string as the IETF draft writes it
 * (`"8e03978e-..."`). Null when there's none; a problem when it can't be used.
 */
export function readIdempotencyKey(raw: unknown): { key: string } | { problem: string } | null {
  if (raw === undefined || raw === null) return null;
  let key = String(Array.isArray(raw) ? raw.join(', ') : raw).trim();
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  if (!key) return { problem: "can't be empty" };
  if (key.length > 255) return { problem: 'can be at most 255 characters' };
  if (!/^[\x20-\x7e]+$/.test(key)) return { problem: 'must be printable ASCII text' };
  return { key };
}

/** What makes two requests "the same": the route's ids, the query string and the body. */
function fingerprint(request: FastifyRequest): string {
  const query = Object.entries((request.query ?? {}) as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null);
  return createHash('sha256').update(JSON.stringify([request.params ?? {}, query])).update('\n').update(body).digest('hex');
}

/** The preHandler (after the permission check) and onSend hook a result route adds. */
export function idempotencyHooks(db: Kysely<Database>) {
  async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const parsed = readIdempotencyKey(request.headers[IDEMPOTENCY_HEADER]);
    if (!parsed) return;
    if ('problem' in parsed) {
      return sendError(reply, 400, `Idempotency-Key ${parsed.problem}`, { invalid_params: [{ name: 'Idempotency-Key', reason: parsed.problem }] });
    }
    const user = request.user;
    const projectId = request.projectId;
    if (!user || !projectId) return;
    const scope = {
      caller: user.api_token ? `token:${user.api_token.id}` : `user:${user.id}`,
      project_id: projectId,
      route: `${request.method} ${request.routeOptions.url}`,
      idempotency_key: parsed.key,
    };
    const print = fingerprint(request);
    const now = new Date();
    const whereScope = (q: any) =>
      q.where('caller', '=', scope.caller).where('project_id', '=', scope.project_id).where('route', '=', scope.route).where('idempotency_key', '=', scope.idempotency_key);

    // An expired key can be used again.
    await whereScope(db.deleteFrom('idempotency_keys')).where('expires_at', '<=', now.toISOString()).execute();
    const id = randomUUID();
    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        id,
        ...scope,
        fingerprint: print,
        status: 'IN_PROGRESS',
        response_status: null,
        response_body: null,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + IDEMPOTENCY_KEY_HOURS * 3_600_000).toISOString(),
      })
      .onConflict((oc) => oc.constraint('uq_idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      request.idempotencyRowId = id;
      return;
    }

    const existing = await whereScope(db.selectFrom('idempotency_keys').selectAll()).executeTakeFirst();
    if (!existing) {
      // Freed a moment ago by a request that failed: this one runs, unkeyed.
      return;
    }
    if (existing.fingerprint !== print) {
      return sendError(
        reply,
        422,
        'This Idempotency-Key was already used for a different request (another body, query or run). Send each different upload with its own key, e.g. the build id, its attempt and the file.',
        { code: 'IDEMPOTENCY_KEY_REUSED' }
      );
    }
    if (existing.status === 'COMPLETE') {
      return reply
        .code(existing.response_status ?? 200)
        .header('content-type', 'application/json; charset=utf-8')
        .header('Idempotent-Replayed', 'true')
        .send(existing.response_body ?? '');
    }
    if (now.getTime() - Date.parse(existing.created_at) > STALE_AFTER_MS) {
      // Its request never finished: this one takes the key over (only one retry can).
      const taken = await db
        .updateTable('idempotency_keys')
        .set({ created_at: now.toISOString() })
        .where('id', '=', existing.id)
        .where('status', '=', 'IN_PROGRESS')
        .where('created_at', '=', existing.created_at)
        .executeTakeFirst();
      if (Number(taken.numUpdatedRows) === 1) {
        request.idempotencyRowId = existing.id;
        return;
      }
    }
    reply.header('Retry-After', '2');
    return sendError(reply, 409, 'A request with this Idempotency-Key is still being handled. Retry in a moment to get its answer.', {
      code: 'IDEMPOTENCY_KEY_IN_USE',
    });
  }

  async function onSend(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
    const id = request.idempotencyRowId;
    if (!id) return payload;
    request.idempotencyRowId = undefined;
    try {
      if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === 'string') {
        await db.updateTable('idempotency_keys').set({ status: 'COMPLETE', response_status: reply.statusCode, response_body: payload }).where('id', '=', id).execute();
      } else {
        await db.deleteFrom('idempotency_keys').where('id', '=', id).execute();
      }
    } catch (err) {
      // The answer still goes out; the key is freed when it goes stale.
      request.log.error({ err }, 'Could not save the Idempotency-Key answer');
    }
    return payload;
  }

  return { preHandler, onSend };
}

/** Deletes expired keys (hourly, from the server's startup). */
export async function purgeExpiredIdempotencyKeys(db: Kysely<Database>): Promise<number> {
  const result = await db.deleteFrom('idempotency_keys').where('expires_at', '<=', new Date().toISOString()).executeTakeFirst();
  return Number(result.numDeletedRows);
}
