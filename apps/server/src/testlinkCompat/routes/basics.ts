import type { CompatRoute } from '../index.js';
import { ALL, V2_UP } from '../versions.js';

/** The connectivity and authentication test routes, answered word for word as TestLink does. */
export const basicRoutes: CompatRoute[] = [
  {
    method: 'GET',
    path: '/who',
    statuses: [],
    versions: ALL,
    auth: false,
    // Plain text, no envelope (ICD §3.2).
    handle: async (_request, reply) => reply.type('text/plain; charset=utf-8').send('tlRestApi : You have called the Get Route /who'),
  },
  {
    method: 'GET',
    path: '/whoAmI',
    statuses: [400],
    versions: ALL,
    auth: true,
    handle: async (_request, reply) => reply.send({ name: 'tlRestApi : You have called Get Route /whoAmI' }),
  },
  {
    method: 'GET',
    path: '/superman',
    statuses: [400],
    versions: V2_UP,
    auth: true,
    handle: async (_request, reply) => reply.send({ name: 'tlRestApi : You have called the Get Route /superman' }),
  },
];
