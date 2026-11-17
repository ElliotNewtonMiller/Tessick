/**
 * Fills a running Tessick server with a "Report Demo" project whose history exercises every
 * report (the data is in src/demo/reportDemo.ts, which demo mode loads at startup too).
 *
 * Everything goes through the public API (results via the batch route with a machine API
 * token), so it also exercises the real ingestion path.
 *
 *   npx tsx apps/server/scripts/report-demo.ts
 *
 * Env: TESSICK_URL (default http://localhost:3001), TESSICK_USER / TESSICK_PASSWORD
 * (default admin / password).
 */
import { loadReportDemo, type DemoApi } from '../src/demo/reportDemo.js';

const BASE = (process.env.TESSICK_URL || 'http://localhost:3001').replace(/\/$/, '');

const api: DemoApi = async (method, path, token, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
};

async function main() {
  const demo = await loadReportDemo(
    api,
    { username: process.env.TESSICK_USER || 'admin', password: process.env.TESSICK_PASSWORD || 'password' },
    (line) => console.log(line)
  );
  console.log(`\nDone. Project id: ${demo.projectId}`);
  console.log(`API token (SPEC_VIEW + EXECUTE_RUN, project ${demo.prefix} only):\n  ${demo.ciToken}`);
  console.log(`\nTry:\n  curl -s -X POST ${BASE}/api/v1/projects/${demo.projectId}/reports/overview -H "Authorization: Bearer <token>" -H 'content-type: application/json' -d '{}'`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
