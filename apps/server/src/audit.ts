import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@tessick/db';

/**
 * Where an audited action came from: the client's address and its User-Agent header. These
 * used to be hard-coded ('127.0.0.1' and made-up service names). Behind a reverse proxy set
 * TRUST_PROXY=true, so request.ip is the real client rather than the proxy.
 */
export interface RequestOrigin {
  ip_address: string | null;
  user_agent: string | null;
}

/** For actions with no request behind them (e.g. scheduled report emails). */
export const NO_ORIGIN: RequestOrigin = { ip_address: null, user_agent: null };

const MAX_USER_AGENT_LENGTH = 500;

export function requestOrigin(request: FastifyRequest): RequestOrigin {
  const agent = request.headers['user-agent'];
  return {
    // The column is varchar(45), the longest textual IPv6 address.
    ip_address: request.ip ? request.ip.slice(0, 45) : null,
    user_agent: typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}

/** An audit row's actor_type: SERVICE_ACCOUNT for an API token, USER for a person. */
export function actorType(actor: { api_token?: unknown }): 'USER' | 'SERVICE_ACCOUNT' {
  return actor.api_token ? 'SERVICE_ACCOUNT' : 'USER';
}

/** One audit row for a change made by the request's caller. */
export async function writeAudit(
  db: Kysely<Database>,
  request: FastifyRequest,
  row: { action: string; resourceType: string; resourceId: string; projectId: string | null; diff: Record<string, unknown> }
): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      id: uuidv4(),
      actor_id: request.user!.id,
      actor_type: actorType(request.user!),
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      project_id: row.projectId,
      diff: JSON.stringify(row.diff),
      ...requestOrigin(request),
      created_at: new Date().toISOString(),
    })
    .execute();
}

/** What a change changed: `{ field: { from, to } }` for each field whose value differs. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to !== undefined && before[key] !== to) out[key] = { from: before[key] ?? null, to };
  }
  return out;
}
