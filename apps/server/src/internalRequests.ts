import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Requests the server makes to itself on a caller's behalf: each item of a bulk change
 * (routes/bulkChanges.ts) and each change an MCP tool makes (mcp/mcpServer.ts) goes through the
 * ordinary route with `app.inject`, as the caller (their Authorization header or session cookie).
 * So permissions, validation, project binding and audit rows are exactly those of the single-item
 * routes.
 *
 * Such a request carries a secret only this process knows. It isn't counted again against an API
 * token's rate limit (the outer request was), and its `via` (bulk or mcp) is believed: an MCP
 * change is recorded with "via Testify MCP" in its audit rows' User-Agent, and cases it creates
 * start as DRAFT. The secret is random per process and never leaves it (headers aren't logged).
 *
 * The TestLink-compatible API (testlinkCompat/) makes its changes the same way, `via` testlink,
 * as the user whose TestLink API key the outer request carried: that key works only on the
 * compatible paths, so the inner request names the user instead (`asUserId`), which only a
 * request carrying the secret may do.
 */

const INTERNAL_SECRET = randomBytes(32).toString('hex');
const SECRET_HEADER = 'x-testify-internal';
const VIA_HEADER = 'x-testify-via';
const USER_HEADER = 'x-testify-internal-user';
const DRAFT_HEADER = 'x-testify-start-draft';

export type InternalVia = 'bulk' | 'mcp' | 'testlink';

export function isInternalRequest(request: FastifyRequest): boolean {
  return request.headers[SECRET_HEADER] === INTERNAL_SECRET;
}

/** How an internal request was made; null for every request from outside. */
export function internalVia(request: FastifyRequest): InternalVia | null {
  if (!isInternalRequest(request)) return null;
  const via = request.headers[VIA_HEADER];
  return via === 'bulk' || via === 'mcp' || via === 'testlink' ? via : null;
}

/** The user an internal request acts as when it carries no credential of its own (the TestLink-compatible API). */
export function internalUserId(request: FastifyRequest): string | null {
  if (internalVia(request) !== 'testlink') return null;
  const id = request.headers[USER_HEADER];
  return typeof id === 'string' && id ? id : null;
}

/**
 * Whether a case this request creates starts as a DRAFT even for a user who may auto-approve:
 * always through MCP, and through the TestLink-compatible API when the client asked for a
 * draft status (TestLink's default).
 */
export function startsAsDraft(request: FastifyRequest): boolean {
  const via = internalVia(request);
  return via === 'mcp' || (via === 'testlink' && request.headers[DRAFT_HEADER] === '1');
}

export interface InnerResponse {
  status: number;
  body: any;
  /** The bytes as sent (a file's content). */
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

/** Calls one of the server's own routes as the caller of `outer`. */
export async function innerRequest(
  outer: FastifyRequest,
  via: InternalVia,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  options: {
    asUserId?: string;
    startDraft?: boolean;
    /** A Buffer payload is sent as is, with this type (default application/octet-stream). */
    contentType?: string;
    /** Extra request headers (e.g. a Range). */
    headers?: Record<string, string>;
  } = {}
): Promise<InnerResponse> {
  const headers: Record<string, string> = { [SECRET_HEADER]: INTERNAL_SECRET, [VIA_HEADER]: via };
  if (options.startDraft) headers[DRAFT_HEADER] = '1';
  if (options.asUserId) {
    headers[USER_HEADER] = options.asUserId;
  } else {
    for (const name of ['authorization', 'cookie', 'x-testify-client'] as const) {
      const value = outer.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
  }
  const agent = typeof outer.headers['user-agent'] === 'string' ? outer.headers['user-agent'] : '';
  const MARK = via === 'mcp' ? '(via Testify MCP)' : via === 'testlink' ? '(via TestLink API)' : '';
  headers['user-agent'] = MARK && !agent.includes(MARK) ? `${agent} ${MARK}`.trim() : agent;
  // The outer request's address, so links an answer makes (an upload link) point back at this server.
  for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto'] as const) {
    const value = outer.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const raw = Buffer.isBuffer(payload);
  if (payload !== undefined) headers['content-type'] = raw ? (options.contentType ?? 'application/octet-stream') : 'application/json';
  Object.assign(headers, options.headers ?? {});
  const res = await outer.server.inject({
    method,
    url,
    headers,
    remoteAddress: outer.ip,
    ...(payload !== undefined ? { payload: raw ? (payload as Buffer) : JSON.stringify(payload) } : {}),
  });
  let body: any = null;
  try {
    body = res.payload ? JSON.parse(res.payload) : null;
  } catch {
    body = res.payload;
  }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
}
