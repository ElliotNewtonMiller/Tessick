import type { FastifyInstance } from 'fastify';
import { loadReportDemo, type DemoApi, type ReportDemo } from './reportDemo.js';

/**
 * Demo mode (TESSICK_DEMO=true, config.ts; docker-compose.demo.yml): a fresh database gets the
 * Report Demo project at startup, loaded through the server's own routes in-process, as the
 * first admin. Runs once, when the first admin is created, so a restart (or a demo project
 * someone deleted) never brings a second copy.
 */
export async function loadDemoProject(app: FastifyInstance, admin: { username: string; password: string }): Promise<ReportDemo> {
  const api: DemoApi = async (method, url, token, body) => {
    const res = await app.inject({
      method: method as any,
      url,
      headers: {
        'user-agent': 'Tessick demo loader',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
    return res.body ? JSON.parse(res.body) : {};
  };
  return loadReportDemo(api, admin);
}

/** The block demo mode logs at startup: how to sign in, and (when just loaded) the demo token for MCP. */
export function demoBanner(signIn: { username: string; password: string | null }, loaded: ReportDemo | null): string {
  const lines = [
    '',
    '[tessick] ============================================================',
    '[tessick] DEMO MODE (TESSICK_DEMO=true): for trying Tessick only.',
    '[tessick] Its admin password is well known: never expose this server',
    '[tessick] or keep real data in it.',
    '[tessick]',
    '[tessick] Open http://localhost:3001 (or the port you chose) and sign in:',
    `[tessick]   username: ${signIn.username}`,
    `[tessick]   password: ${signIn.password ?? '(ADMIN_PASSWORD)'}`,
  ];
  if (loaded) {
    lines.push(
      '[tessick]',
      `[tessick] Loaded the "${loaded.projectName}" project (${loaded.prefix}): 12 cases, 8 runs.`,
      '[tessick] Its API token (read and record results, this project only),',
      '[tessick] shown only now. To connect Claude Code over MCP:',
      `[tessick]   claude mcp add --transport http tessick http://localhost:3001/mcp --header "Authorization: Bearer ${loaded.ciToken}"`
    );
  }
  lines.push('[tessick] ============================================================', '');
  return lines.join('\n');
}
