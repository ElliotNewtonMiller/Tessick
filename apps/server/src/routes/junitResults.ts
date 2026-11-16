import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@tessick/db';
import { JUnitResultsError, junitCaseId, junitSuiteName, parseJUnitResults, type BatchResultsRequest, type JUnitTestResult } from '@tessick/core';
import { requirePermission } from '../middleware/auth.js';
import { sendError } from '../errors.js';
import { BatchRecorded, recordResultsBatch } from '../services/batchResults.js';
import { findOrCreateRun } from '../services/runByName.js';
import { batchOptions } from './batchExecution.js';
import { idempotencyHooks } from '../services/idempotency.js';
import { junitResultsSchema, planJunitResultsSchema, JUNIT_MAX_TESTS, JUNIT_BODY_LIMIT_BYTES } from '../openapi/areas/projects.js';
import { EvidenceRefused, spoolEvidence, type SpooledFile } from '../storage/spool.js';
import { checkWindow, findResultExecution, presentEvidence, storeEvidence, uploaderOf } from '../services/evidence.js';

/**
 * CI results as a JUnit XML file, the report nearly every test runner writes (pytest --junitxml,
 * Maven Surefire, Gradle, Jest/Vitest junit reporters, go-junit-report, ...). The body is the file
 * itself, any content type: `curl --data-binary @report.xml`.
 *
 * Each <testcase> is matched to a case of the project: by a readable id (a `tessick_id` property,
 * or an id like SHOP-101 in the test's name), otherwise by suite name and title, as a JUnit import
 * of the same file would have created them. Matched cases not yet in the plan are added if approved
 * (as for the JSON batch); unmatched tests are reported per item (207) and not recorded.
 *
 * Sent as multipart/form-data instead, the report is the `file` part and any other file parts are
 * evidence: each goes to the result of the test that attached it (`[[ATTACHMENT|path]]` in its
 * output, or an `attachment` property), matched by file name (`evidence` in the answer).
 */

/** The attachments a multipart upload brought, checked and spooled, by file name. */
interface Attachment {
  name: string;
  file?: SpooledFile;
  refused?: EvidenceRefused;
}

const baseName = (path: string) => path.split(/[\\/]/).pop()!.trim();

interface JUnitQuery {
  run_name?: string;
  environment?: string;
  all_or_nothing?: string;
  close_run?: string;
  ci_name?: string;
  ci_run_id?: string;
  ci_job_name?: string;
  ci_url?: string;
  commit_sha?: string;
}

const VERDICT = { PASSED: 'PASSED', FAILED: 'FAILED', ERROR: 'FAILED', SKIPPED: 'SKIPPED' } as const;

/** The JUnit tests as a JSON batch (what services/batchResults.ts records). */
function toBatch(tests: JUnitTestResult[], query: JUnitQuery): BatchResultsRequest {
  return {
    environment: query.environment,
    runner_info: { name: query.ci_name, run_id: query.ci_run_id, job_name: query.ci_job_name, url: query.ci_url, commit_sha: query.commit_sha },
    results: tests.map((t) => {
      const externalId = junitCaseId(t);
      return {
        case_identifier: {
          ...(externalId ? { external_id: externalId } : {}),
          by_path_title: { suite_path: junitSuiteName(t), title: t.name },
        },
        verdict: VERDICT[t.outcome],
        duration_ms: t.duration_ms ?? undefined,
        failure_message: (t.outcome === 'FAILED' || t.outcome === 'ERROR') && t.message ? t.message.slice(0, 2000) : undefined,
        stack_trace: t.outcome === 'SKIPPED' || !t.details ? undefined : t.details.slice(0, 100_000),
        notes: t.outcome === 'ERROR' ? 'The test errored (JUnit <error>) rather than failing an assertion.' : t.outcome === 'SKIPPED' && t.message ? t.message.slice(0, 20_000) : undefined,
      } as BatchResultsRequest['results'][number];
    }),
  };
}

/** How a test is named in the response: classname.name, or just its name. */
const testName = (t: JUnitTestResult) => (t.classname ? `${t.classname}.${t.name}` : t.name);

export async function registerJUnitResultRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  // Its own context, so only these routes take a raw body (of any content type).
  await app.register(async (junit) => {
    // Everything but multipart (the report with evidence files) is the report itself.
    junit.removeContentTypeParser(['application/json', 'text/plain']);
    junit.addContentTypeParser('*', { parseAs: 'string', bodyLimit: JUNIT_BODY_LIMIT_BYTES }, (_req, body, done) => done(null, body));

    /** A multipart upload's report (the `file` part) and its spooled attachments. */
    async function readMultipart(req: FastifyRequest): Promise<{ xml: string; attachments: Attachment[] }> {
      let xml = '';
      const attachments: Attachment[] = [];
      for await (const part of req.parts({ limits: { fileSize: Math.max(JUNIT_BODY_LIMIT_BYTES, req.server.evidence.maxFileBytes + 1), files: 101, fields: 20 } })) {
        if (part.type !== 'file') continue;
        if (part.fieldname === 'file' && !xml) {
          const buffer = await part.toBuffer();
          if (part.file.truncated || buffer.length > JUNIT_BODY_LIMIT_BYTES) throw new JUnitResultsError(`The JUnit file can be at most ${JUNIT_BODY_LIMIT_BYTES / (1024 * 1024)} MB.`);
          xml = buffer.toString('utf8');
          continue;
        }
        const name = baseName(part.filename || part.fieldname);
        try {
          attachments.push({ name, file: await spoolEvidence(part.file, { dir: req.server.evidence.spoolDir, maxBytes: req.server.evidence.maxFileBytes }) });
        } catch (err) {
          if (!(err instanceof EvidenceRefused)) throw err;
          attachments.push({ name, refused: err });
        }
      }
      return { xml, attachments };
    }

    /** Stores each attachment on the result of the test that attached it; answers what happened to each. */
    async function attachEvidence(req: FastifyRequest, tests: JUnitTestResult[], results: Array<{ index: number; status: number; test_result_id?: string }>, attachments: Attachment[]) {
      const out = { evidence: [] as unknown[], refused: [] as Array<Record<string, unknown>> };
      const resultOf = new Map(results.filter((r) => r.status < 300 && r.test_result_id).map((r) => [r.index, r.test_result_id!]));
      const uploader = uploaderOf(req);
      for (const a of attachments) {
        const refuse = (status: number, code: string, detail: string) => out.refused.push({ filename: a.name, status, code, detail });
        if (a.refused) {
          refuse(a.refused.status, a.refused.code, a.refused.message);
          continue;
        }
        const index = tests.findIndex((t) => t.attachments.some((p) => baseName(p) === a.name));
        const resultId = index >= 0 ? resultOf.get(index) : undefined;
        if (!resultId) {
          await a.file!.discard();
          if (index < 0) refuse(400, 'NOT_ATTACHED', `No test attaches '${a.name}' (with [[ATTACHMENT|${a.name}]] in its output, or an attachment property).`);
          else refuse(409, 'NO_RESULT_TO_ATTACH', `The test that attaches '${a.name}' wasn't recorded, so there's no result to add it to.`);
          continue;
        }
        try {
          const target = await findResultExecution(db, resultId);
          const { afterClose } = checkWindow(target, req.user!, req.server.evidence.now());
          const stored = await storeEvidence(db, req.server.evidence.storage, target, a.file!, { filename: a.name, description: null, afterClose, uploader });
          out.evidence.push(...(await presentEvidence(db, [stored.evidence], () => ({ duplicate: stored.duplicate }))));
        } catch (err) {
          await a.file!.discard();
          if (!(err instanceof EvidenceRefused)) throw err;
          refuse(err.status, err.code, err.message);
        }
      }
      return out;
    }

    const executeRun = requirePermission('EXECUTE_RUN', db, jwtSecret);
    // An optional Idempotency-Key makes a retried upload answer as the first did (services/idempotency.ts).
    const idempotency = idempotencyHooks(db);
    // The route's limit is the parser's too, so a 413 can say it.
    const hooks = { preHandler: [executeRun, idempotency.preHandler], onSend: idempotency.onSend, config: { stripNul: true }, bodyLimit: JUNIT_BODY_LIMIT_BYTES };

    /** The parsed file, or null after answering 400. */
    function readJUnit(req: FastifyRequest, reply: FastifyReply, xml = typeof req.body === 'string' ? req.body : ''): JUnitTestResult[] | null {
      let tests: JUnitTestResult[];
      try {
        if (!xml.trim()) throw new JUnitResultsError('The request body is empty: send the JUnit XML file itself, e.g. curl --data-binary @report.xml');
        tests = parseJUnitResults(xml);
      } catch (err) {
        if (!(err instanceof JUnitResultsError)) throw err;
        sendError(reply, 400, err.message, { code: 'INVALID_JUNIT' });
        return null;
      }
      if (tests.length === 0) {
        sendError(reply, 400, 'The JUnit file has no <testcase> elements: nothing to record', { code: 'INVALID_JUNIT' });
        return null;
      }
      if (tests.length > JUNIT_MAX_TESTS) {
        sendError(reply, 400, `The JUnit file has ${tests.length} tests; at most ${JUNIT_MAX_TESTS} can be sent at once. Split it, e.g. one file per test job.`, {
          code: 'INVALID_JUNIT',
        });
        return null;
      }
      return tests;
    }

    async function record(req: FastifyRequest, reply: FastifyReply, runId: string, tests: JUnitTestResult[], extra: object, attachments?: Attachment[]) {
      const options = batchOptions(req, reply);
      if (!options) return reply;
      const outcome = await recordResultsBatch(db, req, reply, req.user!, runId, toBatch(tests, req.query as JUnitQuery), { ...options, maxResults: JUNIT_MAX_TESTS });
      if (!(outcome instanceof BatchRecorded)) return outcome;
      const { payload } = outcome;
      const evidence = attachments ? await attachEvidence(req, tests, payload.results, attachments) : undefined;
      return reply.status(outcome.httpStatus).send({
        ...payload,
        ...extra,
        results: payload.results.map((r) => ({ ...r, test_name: testName(tests[r.index]) })),
        ...(evidence ? { evidence } : {}),
      });
    }

    /** The report (and attachments, from multipart), or null after answering. */
    async function readUpload(req: FastifyRequest, reply: FastifyReply): Promise<{ tests: JUnitTestResult[]; attachments?: Attachment[] } | null> {
      if (!req.isMultipart()) {
        const tests = readJUnit(req, reply);
        return tests ? { tests } : null;
      }
      let upload: Awaited<ReturnType<typeof readMultipart>>;
      try {
        upload = await readMultipart(req);
      } catch (err) {
        if (!(err instanceof JUnitResultsError)) throw err;
        sendError(reply, 400, err.message, { code: 'INVALID_JUNIT' });
        return null;
      }
      const discardAll = () => Promise.all(upload.attachments.map((a) => a.file?.discard()));
      if (!upload.xml) {
        await discardAll();
        sendError(reply, 400, 'Send the JUnit report as the `file` part (and evidence files as other parts).', { code: 'INVALID_JUNIT' });
        return null;
      }
      const tests = readJUnit(req, reply, upload.xml);
      if (!tests) {
        await discardAll();
        return null;
      }
      return { tests, attachments: upload.attachments };
    }

    junit.post('/api/v1/runs/:runId/results/junit', { schema: junitResultsSchema, ...hooks }, async (req, reply) => {
      const upload = await readUpload(req, reply);
      if (!upload) return reply;
      return record(req, reply, (req.params as { runId: string }).runId, upload.tests, {}, upload.attachments);
    });

    junit.post('/api/v1/plans/:planId/results/junit', { schema: planJunitResultsSchema, ...hooks }, async (req, reply) => {
      const upload = await readUpload(req, reply);
      if (!upload || !batchOptions(req, reply)) return reply;
      const run = await findOrCreateRun(db, req, reply, req.user!, (req.params as { planId: string }).planId, (req.query as JUnitQuery).run_name);
      if (!run) return reply;
      return record(req, reply, run.id, upload.tests, { run }, upload.attachments);
    });
  });
}
