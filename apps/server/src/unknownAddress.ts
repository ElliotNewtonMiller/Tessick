import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

/**
 * The answer for a request no route handles. An API address that exists under other methods (a
 * GET on a POST-only route) is 405 with `Allow` listing them; it used to be a 404, which said the
 * address was wrong. Anything else is 404. Both are problem details.
 */
export function sendUnknownAddress(request: FastifyRequest, reply: FastifyReply) {
  const path = request.url.split('?')[0];
  const allowed = /^\/(api|mcp)(\/|$)/.test(path) ? allowedMethods(request.server, path) : [];
  if (allowed.length > 0) {
    reply.header('Allow', allowed.join(', '));
    return sendError(reply, 405, `${request.method} isn't allowed on ${path}; it takes ${allowed.join(', ')}.`, { code: 'METHOD_NOT_ALLOWED' });
  }
  return sendError(reply, 404, `Route ${request.method}:${request.url} not found`);
}

const patterns = new WeakMap<FastifyInstance, Array<{ method: string; re: RegExp }>>();

/** The methods the app's routes take at this path (from the routes registered after OpenAPI's setup). */
function allowedMethods(app: FastifyInstance, path: string): string[] {
  let list = patterns.get(app);
  if (!list) {
    list = (app.openApiRoutes ?? []).map((r) => ({
      method: r.method,
      re: new RegExp(
        '^' +
          r.url
            .split('/')
            .map((part) => (part.startsWith(':') ? '[^/]+' : part === '*' ? '.*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('/') +
          '/?$'
      ),
    }));
    patterns.set(app, list);
  }
  const methods = new Set(list.filter((p) => p.re.test(path)).map((p) => p.method));
  if (methods.has('GET')) methods.add('HEAD');
  const order = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
  return [...methods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
