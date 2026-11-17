import type { FastifyInstance } from 'fastify';
import { instanceSchema } from '../openapi/areas/other.js';

/**
 * GET /api/v1/instance: what the sign-in page needs before anyone signs in (no sign-in needed).
 * In demo mode (TESSICK_DEMO) that's the demo admin's sign-in, which the page shows and fills in.
 */
export function registerInstanceRoute(app: FastifyInstance, demoSignIn: { username: string; password: string | null } | null): void {
  app.get('/api/v1/instance', { schema: instanceSchema }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { demo: demoSignIn };
  });
}
