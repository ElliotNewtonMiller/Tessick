import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { nulFields, withoutNul } from '@tessick/core';
import { sendError } from './errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The request carries other tools' output (test results, imported files): NUL characters are
     * removed from it rather than refused.
     */
    stripNul?: boolean;
  }
}

/**
 * NUL characters (U+0000) in a request. PostgreSQL text can't hold one: saving it, or searching
 * for it, fails. Every request is checked before its route runs: a NUL in a path parameter, the
 * query string or a JSON body is refused with 400 naming each field, since in text a client
 * typed or built it's a bug worth hearing about. Routes marked `stripNul` (results, imports, MCP)
 * remove them instead, since there the text is captured test output, another tool's file or what
 * an agent read, where a stray NUL is common and the result shouldn't be lost over it. Files sent
 * as multipart (imports) are cleaned after parsing (routes/ingestion.ts).
 */
export function registerNulGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request, reply) => {
    if (request.routeOptions.config?.stripNul) {
      request.params = withoutNul(request.params);
      request.query = withoutNul(request.query);
      request.body = withoutNul(request.body);
      return;
    }
    // A wildcard route's parameter (the web app's files) is named `*`; call it the path.
    const params = nulFields(request.params).map((name) => (name === '*' ? 'path' : name));
    const fields = [...params, ...nulFields(request.query), ...nulFields(request.body)];
    if (fields.length === 0) return;
    const reason = "contains a NUL character (U+0000), which Tessick can't store";
    return sendError(reply, 400, `${fields.join(', ')} ${reason}`, {
      code: 'INVALID_REQUEST',
      invalid_params: [...new Set(fields)].map((name) => ({ name, reason })),
    });
  });
}

/** PostgreSQL's "data exception" codes for a value it can't store, and what to tell the client. */
const UNSTORABLE_VALUE: Record<string, string> = {
  '22001': 'A value in the request is too long to store.',
  '22003': 'A number in the request is too large to store.',
  '22021': "The request contains a character Tessick can't store.",
  '22P02': "A value in the request isn't in the expected form, e.g. text where a whole number belongs.",
  '22007': "A date in the request isn't in the expected form.",
  '22008': 'A date in the request is out of range.',
};

/**
 * The client's message when the database refused one of the request's values, or null. The
 * routes check what they store up front, naming the field; this is the safety net for a value
 * they missed, which answers 400 instead of a 500 and is logged (without the value) so the check
 * can be added.
 */
export function unstorableValueMessage(error: unknown, request: FastifyRequest): string | null {
  const code = (error as FastifyError | undefined)?.code;
  const message = typeof code === 'string' ? UNSTORABLE_VALUE[code] : undefined;
  if (!message) return null;
  request.log.warn({ event: 'unstorable_value', sqlstate: code, route: `${request.method} ${request.routeOptions.url ?? request.url}` }, 'The database refused a value');
  return message;
}
