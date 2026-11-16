import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@tessick/db';
import { TestRunRepository } from '@tessick/db';
import { NO_ORIGIN, type RequestOrigin } from './audit.js';
import { emitRunClosed } from './services/webhookEvents.js';

/**
 * The run closes automatically the FIRST time every case in its plan has a result. Called
 * after one result is recorded (routes/results.ts); CI batches never auto-close a run
 * (services/batchResults.ts). Writes a RUN_AUTO_CLOSED audit
 * row when it fires, and that row is also what makes it once-only: a run that has already
 * auto-closed (and was then reopened to change a result) is never auto-closed again. Audit
 * rows are immutable, so this can't be reset by accident. Returns the run's resulting
 * status so the caller can tell the client.
 *
 * With `defer`, a run that would close now stays OPEN and `deferred` is true: the web app
 * defers for Fail/Block, whose notes are still to come, and either the notes' own result or
 * POST /runs/:runId/auto-close closes it afterwards (a closed run would refuse the notes).
 */
export async function autoCloseRunIfComplete(
  db: Kysely<Database>,
  runId: string,
  actor: { id: string; type: 'USER' | 'SERVICE_ACCOUNT' },
  /** The request whose result completed the run. */
  origin: RequestOrigin = NO_ORIGIN,
  { defer = false }: { defer?: boolean } = {}
): Promise<{ status: 'OPEN' | 'CLOSED'; deferred: boolean }> {
  const runRepo = new TestRunRepository(db);
  const alreadyAutoClosed = await db
    .selectFrom('audit_logs')
    .select('id')
    // RUN_AUTO_CLOSED, or BUILD_AUTO_CLOSED in rows written before the rename (audit rows
    // never change).
    .where('action', 'in', ['RUN_AUTO_CLOSED', 'BUILD_AUTO_CLOSED'])
    .where('resource_id', '=', runId)
    .executeTakeFirst();
  if (defer) {
    const deferred = !alreadyAutoClosed && (await runRepo.isComplete(runId));
    const run = await runRepo.findById(runId);
    return { status: run?.status === 'CLOSED' ? 'CLOSED' : 'OPEN', deferred };
  }
  const closed = alreadyAutoClosed ? false : await runRepo.closeIfComplete(runId);
  if (closed) {
    const info = await db
      .selectFrom('test_runs')
      .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
      .select(['test_plans.project_id', 'test_plans.id as plan_id'])
      .where('test_runs.id', '=', runId)
      .executeTakeFirst();
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: actor.id,
        actor_type: actor.type,
        action: 'RUN_AUTO_CLOSED',
        resource_type: 'run',
        resource_id: runId,
        project_id: info?.project_id ?? null,
        diff: JSON.stringify({ reason: 'ALL_CASES_HAVE_RESULTS', test_plan_id: info?.plan_id ?? null }),
        ...origin,
        created_at: new Date().toISOString(),
      })
      .execute();
    await emitRunClosed(db, { id: actor.id, type: actor.type }, runId, 'auto');
  }
  const run = await runRepo.findById(runId);
  return { status: run?.status === 'CLOSED' ? 'CLOSED' : 'OPEN', deferred: false };
}
