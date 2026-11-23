/**
 * Fills a running Tessick server with the "Storefront" showcase project, for filming demo clips
 * and taking screenshots: 34 cases with real steps (cases.ts), a Platforms custom field, and a
 * plan with eight release-candidate runs of history. The last run (2.4.0-rc.8) stays open: CI has
 * recorded its automated cases, and its manual cases are left for a person to execute on camera.
 *
 *   npx tsx apps/server/scripts/showcase/load-showcase.ts
 *
 * Env: TESSICK_URL (default http://localhost:3001), TESSICK_USER / TESSICK_PASSWORD
 * (default admin / password; the user needs to be an admin, for the custom field).
 *
 * Also in this folder: testlink-export.xml (a TestLink project to import on camera),
 * junit-rc9.xml (a CI report for this project; the end of the output shows how to send it), and
 * README.md, the clips and how to record each.
 */
import { CASES, RUNS, runName, type ShowcaseCase } from './cases.js';

const BASE = (process.env.TESSICK_URL || 'http://localhost:3001').replace(/\/$/, '');
const PREFIX = 'SHOP';

async function api<T = any>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** A case's verdict in a run (0-based), with the defaults described in cases.ts. */
function verdictAt(c: ShowcaseCase, run: number): string {
  if (c.history) return c.history[run];
  return !c.auto && run === RUNS - 1 ? '-' : 'P';
}

function durationAt(c: ShowcaseCase, run: number): number {
  const base = c.ms ?? 1000;
  const jitter = ((run * 53 + c.title.length * 17) % 21) - 10; // -10%..+10%, the same on every load
  const grown = c.slowing ? base * (1 + run * 0.35) : base;
  return Math.round(grown * (1 + jitter / 100));
}

async function main() {
  const { token: jwt } = await api<{ token: string }>('POST', '/api/v1/auth/login', null, {
    username: process.env.TESSICK_USER || 'admin',
    password: process.env.TESSICK_PASSWORD || 'password',
  });

  const { projects } = await api<{ projects: Array<{ prefix: string }> }>('GET', '/api/v1/projects', jwt);
  if (projects.some((p) => p.prefix === PREFIX)) {
    throw new Error(`A project with the prefix ${PREFIX} already exists: delete it first (or use a fresh dev server).`);
  }
  const { project } = await api('POST', '/api/v1/projects', jwt, { name: 'Storefront', prefix: PREFIX, description: 'The online shop: web, iOS and Android.' });
  const pid = project.id as string;
  console.log(`Project "Storefront" (${PREFIX})`);

  // Suites, parents first.
  const suiteIds = new Map<string, string>();
  for (const c of CASES) {
    const parts = c.suite.split(' / ');
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join(' / ');
      if (suiteIds.has(path)) continue;
      const parent = depth > 1 ? suiteIds.get(parts.slice(0, depth - 1).join(' / ')) : null;
      const { suite } = await api('POST', `/api/v1/projects/${pid}/suites`, jwt, { name: parts[depth - 1], parent_suite_id: parent });
      suiteIds.set(path, suite.id);
    }
  }

  // The Platforms field, for this project (added to it if an earlier load made the field).
  const { definitions } = await api('GET', '/api/v1/admin/custom-fields?entity_type=TestCase', jwt);
  let platforms = definitions.find((d: any) => d.name === 'platforms');
  if (!platforms) {
    ({ definition: platforms } = await api('POST', '/api/v1/admin/custom-fields', jwt, {
      entity_type: 'TestCase',
      name: 'platforms',
      field_label: 'Platforms',
      field_type: 'MULTI_SELECT',
      default_value: '["web"]',
      options: [
        { option_label: 'Web', option_value: 'web' },
        { option_label: 'iOS', option_value: 'ios' },
        { option_label: 'Android', option_value: 'android' },
      ],
      project_ids: [pid],
    }));
  } else if (!platforms.all_projects) {
    await api('PUT', `/api/v1/admin/custom-fields/${platforms.id}/projects`, jwt, { all_projects: false, project_ids: [...platforms.project_ids, pid] });
  }

  // Cases (an admin's new cases are approved straight away, so they can join the plan).
  const caseIds: string[] = [];
  for (const c of CASES) {
    const { test_case } = await api('POST', `/api/v1/projects/${pid}/cases`, jwt, {
      test_suite_id: suiteIds.get(c.suite),
      title: c.title,
      priority: c.priority ?? 'MEDIUM',
      execution_type: c.auto ? 'AUTOMATED' : 'MANUAL',
      summary: c.summary,
      preconditions: c.preconditions ?? null,
      steps: c.steps.map(([action, expected_result]) => ({ action, expected_result })),
    });
    caseIds.push(test_case.id);
    if (c.platforms) {
      await api('PUT', `/api/v1/cases/${test_case.id}/custom-fields/${platforms.id}`, jwt, { value: c.platforms.map((p) => p.toLowerCase()) });
    }
  }
  console.log(`  ${suiteIds.size} suites, ${CASES.length} cases (${CASES.filter((c) => c.auto).length} automated)`);

  const { plan } = await api('POST', `/api/v1/projects/${pid}/plans`, jwt, { name: 'Release 2.4 Regression', description: 'Everything before 2.4 ships.' });
  for (const id of caseIds) await api('POST', `/api/v1/plans/${plan.id}/cases`, jwt, { test_case_id: id });

  // CI's token: records results, and may create a run by name (for the JUnit clip).
  const tokenRes = await api('POST', `/api/v1/projects/${pid}/api-tokens`, jwt, { name: 'GitHub Actions', capabilities: ['EXECUTE_RUN', 'SPEC_VIEW', 'RUN_MANAGE'] });
  const ciToken = tokenRes.plaintext as string;

  const day = 86_400_000;
  for (let run = 0; run < RUNS; run++) {
    const runStart = Date.now() - (RUNS - run) * 2 * day + 9 * 3_600_000;
    const { run: testRun } = await api('POST', `/api/v1/plans/${plan.id}/runs`, jwt, {
      name: runName(run + 1),
      release_date: new Date(runStart).toISOString().slice(0, 10),
    });
    const at = (offsetMin: number) => new Date(runStart + offsetMin * 60_000).toISOString();

    // Automated cases: one CI batch.
    const results: unknown[] = [];
    CASES.forEach((c, i) => {
      if (!c.auto) return;
      const v = verdictAt(c, run);
      if (v === '-') return;
      const base = { case_identifier: { external_id: `${PREFIX}-${i + 1}` }, duration_ms: durationAt(c, run) };
      const failure = { failure_message: c.message, stack_trace: `Error: ${c.message}\n    at ${c.title.replace(/\W+/g, '_')} (e2e/${c.suite.split(' / ').pop()!.toLowerCase().replace(/\W+/g, '-')}.spec.ts:${20 + i}:9)` };
      if (v === 'R') {
        results.push({ ...base, verdict: 'FAILED', executed_at: at(i / 2), ...failure });
        results.push({ ...base, verdict: 'PASSED', executed_at: at(i / 2 + 1) });
        return;
      }
      const verdict = v === 'P' ? 'PASSED' : v === 'F' ? 'FAILED' : 'BLOCKED';
      results.push({ ...base, verdict, executed_at: at(i / 2), ...(verdict !== 'PASSED' && c.message ? failure : {}) });
    });
    await api('POST', `/api/v1/runs/${testRun.id}/results/batch`, ciToken, {
      environment: 'staging',
      runner_info: { name: 'GitHub Actions', run_id: String(4100 + run), job_name: 'e2e', commit_sha: hex(40), url: `https://ci.example.test/storefront/runs/${4100 + run}` },
      results,
    });

    // Manual cases, as the tester's afternoon. Sent as one batch rather than one at a time: only a
    // batch takes executed_at, and one-at-a-time results all landing on today would make the
    // Overview's activity chart a single spike. So they count as API results, not "by people";
    // the results recorded on camera are the first by people. The batch doesn't close the run.
    const manual: unknown[] = [];
    CASES.forEach((c, i) => {
      const v = verdictAt(c, run);
      if (c.auto || v === '-') return;
      const verdict = v === 'P' ? 'PASSED' : v === 'F' ? 'FAILED' : 'BLOCKED';
      manual.push({ case_identifier: { external_id: `${PREFIX}-${i + 1}` }, verdict, executed_at: at(300 + i * 6), ...(verdict !== 'PASSED' && c.message ? { notes: c.message } : {}) });
    });
    if (manual.length) await api('POST', `/api/v1/runs/${testRun.id}/results/batch`, jwt, { environment: 'staging', results: manual });
    if (run < RUNS - 1) await api('PATCH', `/api/v1/runs/${testRun.id}`, jwt, { status: 'CLOSED' });
    console.log(`  Run ${runName(run + 1)}: ${results.length} CI results, ${manual.length} manual${run < RUNS - 1 ? '' : ' (left open)'}`);
  }

  console.log(`\nDone. Sign in, choose Storefront, and Execute run ${runName(RUNS)}: its manual cases are waiting.`);
  console.log(`\nFor the CI clip, set these off camera:`);
  console.log(`  export TESSICK=${BASE} PLAN_ID=${plan.id}`);
  console.log(`  export TESSICK_TOKEN=${ciToken}`);
  console.log(`then on camera:`);
  console.log(`  curl -s -X POST "$TESSICK/api/v1/plans/$PLAN_ID/results/junit?run_name=2.4.0-rc.9&ci_name=GitHub%20Actions" \\`);
  console.log(`    -H "Authorization: Bearer $TESSICK_TOKEN" --data-binary @apps/server/scripts/showcase/junit-rc9.xml | jq -c '.summary, .run'`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
