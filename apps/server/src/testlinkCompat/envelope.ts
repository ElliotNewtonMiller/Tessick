import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * TestLink's response envelope (Dave's TestLink REST API, ICD §3.3): `status` ("ok"/"ko"),
 * `message`, and one of `id`, `item`, `items`, `details` or `metrics`. Errors are the same shape
 * with `status: "ko"`; an authentication failure is HTTP 400, as TestLink answers it.
 */

export const AUTH_ERROR_MESSAGE = 'authentication error';

export function tlOk(reply: FastifyReply, body: Record<string, unknown> = {}, httpStatus = 200) {
  return reply.code(httpStatus).header('content-type', 'application/json; charset=utf-8').send(JSON.stringify({ status: 'ok', message: 'ok', ...body }));
}

export function tlKo(reply: FastifyReply, httpStatus: number, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(httpStatus).header('content-type', 'application/json; charset=utf-8').send(JSON.stringify({ status: 'ko', message, ...extra }));
}

/**
 * TestLink's other failure answer, `status: "error"`, which its reads use for something not
 * found ("No Test Project identified by '9'!") and Dave's custom routes for a bad parameter.
 */
export function tlError(reply: FastifyReply, httpStatus: number, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(httpStatus).header('content-type', 'application/json; charset=utf-8').send(JSON.stringify({ status: 'error', message, ...extra }));
}

export const INSUFFICIENT_RIGHTS = 'Insufficient rights';

export function tlAuthError(reply: FastifyReply) {
  return tlKo(reply, 400, AUTH_ERROR_MESSAGE);
}

/**
 * Answers Testify sends from shared code before a TestLink route runs (the NUL guard, a body
 * over the limit, a rate limit, an unexpected error), which are problem details, rewritten into
 * TestLink's envelope, so a TestLink client sees one format. A 401 is TestLink's 400
 * authentication error.
 */
export async function problemToEnvelope(_request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const type = String(reply.getHeader('content-type') ?? '');
  if (!type.startsWith('application/problem+json') || typeof payload !== 'string') return payload;
  let detail = 'error';
  try {
    detail = String(JSON.parse(payload).detail ?? detail);
  } catch {
    // Not JSON after all: keep the generic message.
  }
  reply.header('content-type', 'application/json; charset=utf-8');
  if (reply.statusCode === 401) {
    reply.code(400);
    return JSON.stringify({ status: 'ko', message: AUTH_ERROR_MESSAGE });
  }
  return JSON.stringify({ status: 'ko', message: detail });
}
