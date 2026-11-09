import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { EvidenceRepository, EvidenceUploadRepository, type Database, type Evidence } from '@testify/db';
import { SNIFF_BYTES, TextCheck, contentDisposition, parseRange, shownInline, sniffEvidence, MAX_EVIDENCE_FILENAME } from '@testify/core';
import { requireAnyPermission, requirePermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { requestOrigin } from '../audit.js';
import { sendError } from '../errors.js';
import { readPage } from '../paging.js';
import { resolveCaseRef } from '../caseRefs.js';
import { newStorageKey } from '../storage/provider.js';
import { EvidenceRefused, spoolEvidence, type SpooledFile } from '../storage/spool.js';
import {
  canAddEvidence,
  checkDescription,
  checkWindow,
  findExecution,
  findResultExecution,
  mayDeleteEvidence,
  presentEvidence,
  storeEvidence,
  uploaderOf,
  type ExecutionTarget,
  type Uploader,
} from '../services/evidence.js';
import * as S from '../openapi/areas/evidence.js';

/**
 * Evidence for test executions (docs/rfc_03_api_and_xml_contracts.md §5): screenshots, videos,
 * logs and Playwright traces, for a case's execution in a run.
 *
 * Uploads stream through the spool (storage/spool.ts), which counts, hashes and sniffs them, so
 * nothing is stored unless it's a file Testify accepts. Every upload route answers one shape:
 * `{ evidence: [...], refused: [...] }`, 201 when all were stored (200 when all were already
 * there), 207 when some were refused, and the refusal itself when all were. Files are always
 * served through Testify, permissions checked, with their sniffed type and a sandboxing CSP.
 */

/** A raw upload body, kept off request.body (the NUL guard walks plain objects). */
const RAW_BODY = Symbol('evidence raw body');
const UPLOAD_LINK_MINUTES = 15;
const EVIDENCE_PAGE = { defaultLimit: 100 };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function refusalReply(reply: FastifyReply, err: unknown) {
  if (err instanceof EvidenceRefused) return sendError(reply, err.status, err.message, { code: err.code, ...err.extra });
  throw err;
}

interface IncomingFile {
  fieldname: string;
  filename: string;
  source: AsyncIterable<Buffer>;
  /** The fields sent before this file (a multipart form): description, sha256. */
  fields: Record<string, string>;
}

/** The files a request carries: multipart file parts, or the raw body as one file. */
async function* incomingFiles(request: FastifyRequest, maxBytes: number): AsyncGenerator<IncomingFile> {
  if (request.isMultipart()) {
    const fields: Record<string, string> = {};
    for await (const part of request.parts({ limits: { fileSize: maxBytes + 1, files: 100, fields: 50, fieldSize: 64 * 1024 } })) {
      if (part.type === 'file') {
        yield { fieldname: part.fieldname, filename: part.filename, source: part.file, fields: { ...fields } };
        delete fields.sha256; // one file's checksum
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    return;
  }
  const raw = (request as any)[RAW_BODY] as AsyncIterable<Buffer> | undefined;
  if (!raw) throw new EvidenceRefused(400, 'INVALID_REQUEST', 'Send the file as the request body, or as multipart/form-data file parts.');
  const query = request.query as Record<string, string | undefined>;
  const checksum = request.headers['x-checksum-sha256'];
  yield {
    fieldname: 'file',
    filename: query.filename ?? '',
    source: raw,
    fields: { ...(query.description ? { description: query.description } : {}), ...(typeof checksum === 'string' ? { sha256: checksum } : {}) },
  };
}

interface UploadOutcome {
  evidence: Array<Record<string, unknown>>;
  refused: Array<{ filename: string; test_case_id?: string; status: number; code: string; detail: string; limit_bytes?: number }>;
  duplicates: number;
}

/** Answers an upload as every upload route does (see the file comment). */
function sendOutcome(reply: FastifyReply, request: FastifyRequest, outcome: UploadOutcome) {
  if (outcome.evidence.length === 0 && outcome.refused.length > 0) {
    const first = outcome.refused[0];
    return sendError(reply, first.status, first.detail, { code: first.code, ...(first.limit_bytes ? { limit_bytes: first.limit_bytes } : {}), refused: outcome.refused });
  }
  if (outcome.evidence.length === 0) return sendError(reply, 400, 'The request carried no file.', { code: 'INVALID_REQUEST' });
  const status = outcome.refused.length ? 207 : outcome.duplicates === outcome.evidence.length ? 200 : 201;
  return reply.status(status).send({ evidence: outcome.evidence, refused: outcome.refused });
}

const refusedEntry = (filename: string, err: EvidenceRefused, testCaseId?: string) => ({
  filename: filename.slice(0, MAX_EVIDENCE_FILENAME),
  ...(testCaseId ? { test_case_id: testCaseId } : {}),
  status: err.status,
  code: err.code,
  detail: err.message,
  ...(typeof err.extra.limit_bytes === 'number' ? { limit_bytes: err.extra.limit_bytes } : {}),
});

export async function registerEvidenceRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  await app.register(async (scope) => {
    // A raw upload's body (any type but JSON and multipart) is the file itself, streamed.
    scope.removeContentTypeParser('text/plain');
    scope.addContentTypeParser('*', (request, payload, done) => {
      (request as any)[RAW_BODY] = payload;
      done(null, undefined);
    });

    const evidence = new EvidenceRepository(db);
    const uploads = new EvidenceUploadRepository(db);
    const executeRun = requirePermission('EXECUTE_RUN', db, jwtSecret);
    const executionRead = requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret);
    const ctx = () => app.evidence;

    /** Spools each file and stores it for the execution `targetFor` names. */
    async function upload(request: FastifyRequest, targetFor: (file: IncomingFile) => Promise<ExecutionTarget>): Promise<UploadOutcome> {
      const outcome: UploadOutcome = { evidence: [], refused: [], duplicates: 0 };
      const uploader = uploaderOf(request);
      for await (const file of incomingFiles(request, ctx().maxFileBytes)) {
        let spooled: SpooledFile | undefined;
        let target: ExecutionTarget | undefined;
        try {
          target = await targetFor(file);
          const { afterClose } = checkWindow(target, request.user!, ctx().now());
          const description = checkDescription(file.fields.description);
          spooled = await spoolEvidence(file.source, { dir: ctx().spoolDir, maxBytes: ctx().maxFileBytes, expectedSha256: file.fields.sha256 || undefined });
          const stored = await storeEvidence(db, ctx().storage, target, spooled, { filename: file.filename, description, afterClose, uploader });
          spooled = undefined;
          if (stored.duplicate) outcome.duplicates++;
          outcome.evidence.push(...(await presentEvidence(db, [stored.evidence], () => ({ duplicate: stored.duplicate }))));
        } catch (err) {
          await spooled?.discard();
          if (!(err instanceof EvidenceRefused)) throw err;
          // A file not read yet (refused before its bytes) is drained, so the next part can be read.
          for await (const _ of file.source) {
            // dropped
          }
          outcome.refused.push(refusedEntry(file.filename, err, target?.testCaseId));
        }
      }
      return outcome;
    }

    // ---- Uploading ----

    scope.post('/api/v1/runs/:runId/cases/:caseId/evidence', { schema: S.uploadExecutionSchema, preHandler: executeRun }, async (request, reply) => {
      const { runId, caseId } = request.params as { runId: string; caseId: string };
      const { test_result_id: resultId } = request.query as { test_result_id?: string };
      try {
        // Checked before any bytes are read: a closed run or a case without a result refuses at once.
        const target = await findExecution(db, { runId, caseId, resultId });
        checkWindow(target, request.user!, ctx().now());
        return sendOutcome(reply, request, await upload(request, async () => target));
      } catch (err) {
        return refusalReply(reply, err);
      }
    });

    scope.post('/api/v1/results/:resultId/evidence', { schema: S.uploadResultSchema, preHandler: executeRun }, async (request, reply) => {
      const { resultId } = request.params as { resultId: string };
      try {
        const target = await findResultExecution(db, resultId);
        checkWindow(target, request.user!, ctx().now());
        return sendOutcome(reply, request, await upload(request, async () => target));
      } catch (err) {
        return refusalReply(reply, err);
      }
    });

    // CI: one request for a run, each file part named by its case (SHOP-12=@login.png).
    scope.post('/api/v1/runs/:runId/evidence', { schema: S.uploadRunSchema, preHandler: executeRun }, async (request, reply) => {
      const { runId } = request.params as { runId: string };
      if (!request.isMultipart()) {
        return sendError(reply, 400, 'Send multipart/form-data, each file part named by its case (e.g. SHOP-12=@login.png).', { code: 'INVALID_REQUEST' });
      }
      const targets = new Map<string, ExecutionTarget>();
      try {
        const outcome = await upload(request, async (file) => {
          const ref = file.fieldname.trim();
          const known = targets.get(ref);
          if (known) return known;
          const resolved = await resolveCaseRef(db, ref, request.projectId ?? null);
          if ('none' in resolved) throw new EvidenceRefused(404, 'NOT_FOUND', `No test case '${ref}': name each file part by its case (e.g. SHOP-12).`);
          if ('ambiguous' in resolved) throw new EvidenceRefused(400, 'AMBIGUOUS_CASE_ID', `'${ref}' names cases in ${resolved.ambiguous} projects; use the case's id.`);
          if (resolved.projectId !== request.projectId) throw new EvidenceRefused(404, 'NOT_FOUND', `No test case '${ref}' in this run's project.`);
          const target = await findExecution(db, { runId, caseId: resolved.id });
          targets.set(ref, target);
          return target;
        });
        return sendOutcome(reply, request, outcome);
      } catch (err) {
        return refusalReply(reply, err);
      }
    });

    // ---- Upload links (large files, MCP agents) ----

    scope.post('/api/v1/runs/:runId/cases/:caseId/evidence/uploads', { schema: S.createUploadSchema, preHandler: executeRun }, async (request, reply) => {
      const { runId, caseId } = request.params as { runId: string; caseId: string };
      const body = request.body as { filename: string; size_bytes: number; sha256: string; description?: string; test_result_id?: string };
      try {
        if (body.size_bytes > ctx().maxFileBytes) {
          throw new EvidenceRefused(413, 'EVIDENCE_TOO_LARGE', `An evidence file can be at most ${Math.round(ctx().maxFileBytes / (1024 * 1024))} MB.`, { limit_bytes: ctx().maxFileBytes });
        }
        const target = await findExecution(db, { runId, caseId, resultId: body.test_result_id });
        checkWindow(target, request.user!, ctx().now());
        const description = checkDescription(body.description);
        const uploader = uploaderOf(request);
        const token = randomBytes(32).toString('base64url');
        const id = uuidv7();
        const storageKey = newStorageKey(target.projectId);
        const now = ctx().now();
        const expiresAt = new Date(now.getTime() + UPLOAD_LINK_MINUTES * 60_000).toISOString();
        await uploads.create({
          id,
          token_hash: hashToken(token),
          project_id: target.projectId,
          test_run_id: target.run.id,
          test_plan_case_id: target.planCaseId,
          test_result_id: target.result.id,
          created_by: uploader.id,
          actor_type: uploader.actorType,
          created_via: uploader.via,
          filename: body.filename,
          description,
          size_bytes: body.size_bytes,
          sha256: body.sha256.toLowerCase(),
          storage_key: storageKey,
          status: 'pending',
          evidence_id: null,
          expires_at: expiresAt,
          created_at: now.toISOString(),
        });
        const storage = ctx().storage;
        const link = storage.presignPut
          ? await storage.presignPut(storageKey, { size: body.size_bytes, sha256: body.sha256.toLowerCase(), expiresInSeconds: UPLOAD_LINK_MINUTES * 60 })
          : { url: `${request.protocol}://${request.host}/api/v1/evidence-uploads/${token}`, headers: { 'content-type': 'application/octet-stream' } };
        return reply.status(201).send({
          upload: {
            id,
            url: link.url,
            method: 'PUT',
            headers: link.headers,
            expires_at: expiresAt,
            complete_url: `/api/v1/evidence-uploads/${id}/complete`,
          },
        });
      } catch (err) {
        return refusalReply(reply, err);
      }
    });

    // The link itself: its token is the only credential (single use, 15 minutes, one file of a
    // known size and checksum). Through Testify, the file becomes evidence at once.
    scope.put('/api/v1/evidence-uploads/:token', { schema: S.putUploadSchema }, async (request, reply) => {
      const { token } = request.params as { token: string };
      const upload = await uploads.findByTokenHash(hashToken(token));
      const now = ctx().now();
      if (!upload || upload.expires_at < now.toISOString() || upload.status === 'done') {
        return sendError(reply, 404, 'This upload link is unknown, used or expired: make a new one.', { code: 'NOT_FOUND' });
      }
      if (!(await uploads.claim(upload.id))) return sendError(reply, 409, 'A file is already being uploaded to this link.', { code: 'UPLOAD_IN_PROGRESS' });
      let spooled: SpooledFile | undefined;
      try {
        const raw = (request as any)[RAW_BODY] as AsyncIterable<Buffer> | undefined;
        if (!raw) throw new EvidenceRefused(400, 'INVALID_REQUEST', 'Send the file as the request body.');
        const target = await findExecution(db, { runId: upload.test_run_id, caseId: await caseOfLink(db, upload.test_plan_case_id), resultId: upload.test_result_id });
        const { afterClose } = checkWindow(target, { id: upload.created_by }, now);
        spooled = await spoolEvidence(raw, { dir: ctx().spoolDir, maxBytes: ctx().maxFileBytes, expectedSize: upload.size_bytes, expectedSha256: upload.sha256 });
        await ctx().storage.putFile(upload.storage_key, spooled.path, { size: spooled.size, mediaType: spooled.type.media_type, sha256: spooled.sha256 });
        const uploader: Uploader = { id: upload.created_by, actorType: upload.actor_type as Uploader['actorType'], via: upload.created_via as Uploader['via'], request };
        const stored = await storeEvidence(db, ctx().storage, target, { storageKey: upload.storage_key, size: spooled.size, sha256: spooled.sha256, type: spooled.type }, {
          filename: upload.filename,
          description: upload.description,
          afterClose,
          uploader,
        });
        if (stored.duplicate) await ctx().storage.delete(upload.storage_key);
        await uploads.done(upload.id, stored.evidence.id);
        return reply.status(stored.duplicate ? 200 : 201).send({ evidence: (await presentEvidence(db, [stored.evidence], () => ({ duplicate: stored.duplicate })))[0] });
      } catch (err) {
        await spooled?.discard();
        await uploads.release(upload.id);
        return refusalReply(reply, err);
      }
    });

    scope.post('/api/v1/evidence-uploads/:uploadId/complete', { schema: S.completeUploadSchema, preHandler: executeRun }, async (request, reply) => {
      const { uploadId } = request.params as { uploadId: string };
      const upload = await uploads.findById(uploadId);
      if (!upload || upload.created_by !== request.user!.id) return sendError(reply, 404, 'Upload not found', { code: 'NOT_FOUND' });
      try {
        if (upload.status === 'done' && upload.evidence_id) {
          const done = await evidence.findById(upload.evidence_id);
          if (done) return reply.status(200).send({ evidence: (await presentEvidence(db, [done]))[0] });
        }
        const storage = ctx().storage;
        if (!storage.presignPut) throw new EvidenceRefused(409, 'NOT_UPLOADED', 'Upload the file to the link first (PUT to its url).');
        if (upload.expires_at < ctx().now().toISOString()) throw new EvidenceRefused(404, 'NOT_FOUND', 'This upload link has expired: make a new one.');
        if (!(await uploads.claim(upload.id))) throw new EvidenceRefused(409, 'UPLOAD_IN_PROGRESS', 'This upload is already being completed.');
        try {
          const stored = await completeDirectUpload(upload);
          await uploads.done(upload.id, stored.evidence.id);
          return reply.status(stored.duplicate ? 200 : 201).send({ evidence: (await presentEvidence(db, [stored.evidence], () => ({ duplicate: stored.duplicate })))[0] });
        } catch (err) {
          await uploads.release(upload.id);
          throw err;
        }
      } catch (err) {
        return refusalReply(reply, err);
      }

      /** A file the client put in the bucket itself: checked there (size; type from its start; a log to its end; S3 checked the SHA-256). */
      async function completeDirectUpload(u: NonNullable<typeof upload>) {
        const storage = ctx().storage;
        const head = await storage.head(u.storage_key);
        if (!head) throw new EvidenceRefused(409, 'NOT_UPLOADED', 'The file isn\'t in storage yet: PUT it to the upload link first.');
        const refuse = async (e: EvidenceRefused) => {
          await storage.delete(u.storage_key);
          throw e;
        };
        if (head.size !== u.size_bytes) await refuse(new EvidenceRefused(400, 'SIZE_MISMATCH', `The file is ${head.size} bytes, not the ${u.size_bytes} the upload was made for.`));
        const start = Buffer.concat(await (await storage.read(u.storage_key, { start: 0, end: Math.min(SNIFF_BYTES, head.size) - 1 })).toArray());
        const sniffed = sniffEvidence(start);
        if (!sniffed.ok) await refuse(new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', (sniffed as { reason: string }).reason));
        const { ok: _ok, ...type } = sniffed as Extract<typeof sniffed, { ok: true }>;
        if (type.kind === 'log') {
          const check = new TextCheck();
          for await (const chunk of await storage.read(u.storage_key)) {
            const problem = check.push(chunk);
            if (problem) await refuse(new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', problem));
          }
          const ended = check.end();
          if (ended) await refuse(new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', ended));
        }
        const target = await findExecution(db, { runId: u.test_run_id, caseId: await caseOfLink(db, u.test_plan_case_id), resultId: u.test_result_id });
        const { afterClose } = checkWindow(target, request.user!, ctx().now());
        const stored = await storeEvidence(db, storage, target, { storageKey: u.storage_key, size: head.size, sha256: u.sha256, type }, {
          filename: u.filename,
          description: u.description,
          afterClose,
          uploader: uploaderOf(request),
        });
        if (stored.duplicate) await storage.delete(u.storage_key);
        return stored;
      }
    });

    // ---- Reading ----

    scope.get('/api/v1/runs/:runId/evidence', { schema: S.listRunSchema, preHandler: executionRead }, async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const query = request.query as { test_case_id?: string; kind?: string };
      const page = readPage(request, reply, EVIDENCE_PAGE.defaultLimit);
      if (!page) return reply;
      const run = await db.selectFrom('test_runs').select(['id', 'test_plan_id']).where('id', '=', runId).executeTakeFirst();
      if (!run) return sendError(reply, 404, 'Run not found');
      const links = query.test_case_id ? await linksOf(db, run.test_plan_id, query.test_case_id) : undefined;
      const { rows, next_cursor } = await evidence.listForRun(runId, { testPlanCaseIds: links, kind: query.kind }, page);
      return { evidence: await presentEvidence(db, rows), next_cursor };
    });

    scope.get('/api/v1/runs/:runId/cases/:caseId/evidence', { schema: S.listExecutionSchema, preHandler: executionRead }, async (request, reply) => {
      const { runId, caseId } = request.params as { runId: string; caseId: string };
      const run = await db.selectFrom('test_runs').select(['id', 'test_plan_id']).where('id', '=', runId).executeTakeFirst();
      if (!run) return sendError(reply, 404, 'Run not found');
      const links = await linksOf(db, run.test_plan_id, caseId);
      if (!links.length) return sendError(reply, 404, "The case isn't in this run's plan.");
      const { rows } = await evidence.listForRun(runId, { testPlanCaseIds: links }, { limit: 1000 });
      const user = request.user!;
      const status = (await db.selectFrom('test_runs').select('status').where('id', '=', runId).executeTakeFirst())?.status;
      return {
        evidence: await presentEvidence(db, rows, (e) => ({ can_delete: mayDeleteEvidence(user, e, status) })),
        can_add: await canAddEvidence(db, user, { runId, caseId }, ctx().now()),
      };
    });

    scope.get('/api/v1/evidence/:evidenceId', { schema: S.getEvidenceSchema, preHandler: executionRead }, async (request, reply) => {
      const found = await evidence.findById((request.params as { evidenceId: string }).evidenceId);
      if (!found) return sendError(reply, 404, 'Evidence not found');
      return { evidence: (await presentEvidence(db, [found]))[0] };
    });

    scope.get('/api/v1/evidence/:evidenceId/content', { schema: S.contentSchema, preHandler: executionRead }, async (request, reply) => {
      const found = await evidence.findById((request.params as { evidenceId: string }).evidenceId);
      if (!found) return sendError(reply, 404, 'Evidence not found');
      return sendContent(request, reply, found);
    });

    /** The file, as its sniffed type, never interpreted by the browser as anything else. */
    async function sendContent(request: FastifyRequest, reply: FastifyReply, file: Evidence) {
      const etag = `"${file.sha256}"`;
      const download = (request.query as { download?: string }).download;
      reply
        .header('content-type', file.media_type)
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cross-origin-resource-policy', 'same-origin')
        .header('content-disposition', contentDisposition(shownInline(file.kind as any) && download !== '1' && download !== 'true' ? 'inline' : 'attachment', file.filename))
        .header('cache-control', 'private, max-age=86400, immutable')
        .header('etag', etag)
        .header('accept-ranges', 'bytes');
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      const range = parseRange(request.headers.range, file.size_bytes);
      if (range === 'unsatisfiable') {
        return reply.status(416).header('content-range', `bytes */${file.size_bytes}`).header('content-type', 'application/problem+json').send(
          JSON.stringify({ type: 'about:blank', title: 'Range Not Satisfiable', status: 416, code: 'RANGE_NOT_SATISFIABLE', detail: `The file is ${file.size_bytes} bytes.`, instance: request.url })
        );
      }
      try {
        const stream = await ctx().storage.read(file.storage_key, range);
        if (range) {
          reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size_bytes}`).header('content-length', String(range.end - range.start + 1));
        } else {
          reply.header('content-length', String(file.size_bytes));
        }
        return reply.send(stream);
      } catch (err: any) {
        if (err?.code === 'ENOENT' || err?.name === 'NoSuchKey') {
          reply.removeHeader('content-disposition');
          return sendError(reply, 410, "The evidence's file is missing from storage.", { code: 'EVIDENCE_FILE_MISSING' });
        }
        throw err;
      }
    }

    // ---- Deleting ----

    // The uploader while the run is open, or anyone with EXECUTE_OVERWRITE (decided with Elliot).
    scope.delete(
      '/api/v1/evidence/:evidenceId',
      { schema: S.deleteEvidenceSchema, preHandler: requireAnyPermission(['EXECUTE_RUN', 'EXECUTE_OVERWRITE'], db, jwtSecret) },
      async (request, reply) => {
        const found = await evidence.findById((request.params as { evidenceId: string }).evidenceId);
        if (!found) return sendError(reply, 404, 'Evidence not found');
        const user = request.user!;
        const run = await db.selectFrom('test_runs').select('status').where('id', '=', found.test_run_id).executeTakeFirst();
        if (!mayDeleteEvidence(user, found, run?.status)) {
          return sendError(reply, 403, "Only its uploader (while the run is open) or someone with EXECUTE_OVERWRITE can delete evidence.", {
            code: 'FORBIDDEN',
            required_permission: 'EXECUTE_OVERWRITE',
          });
        }
        await db.transaction().execute(async (trx) => {
          await new EvidenceRepository(trx).delete(found.id);
          await trx
            .insertInto('audit_logs')
            .values({
              id: uuidv4(),
              actor_id: user.id,
              actor_type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
              action: 'EVIDENCE_DELETED',
              resource_type: 'evidence',
              resource_id: found.id,
              project_id: found.project_id,
              diff: JSON.stringify({
                test_run_id: found.test_run_id,
                test_result_id: found.test_result_id,
                filename: found.filename,
                kind: found.kind,
                size_bytes: found.size_bytes,
                sha256: found.sha256,
                uploaded_by: found.uploaded_by,
                uploaded_at: found.created_at,
              }),
              ...requestOrigin(request),
              created_at: new Date().toISOString(),
            })
            .execute();
        });
        return reply.status(204).send();
      }
    );
  });
}

/** A case's plan links in a plan (its current one and any it left): evidence is kept per link. */
async function linksOf(db: Kysely<Database>, planId: string, caseId: string): Promise<string[]> {
  return (await db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', planId).where('test_case_id', '=', caseId).execute()).map((l) => l.id);
}

async function caseOfLink(db: Kysely<Database>, planCaseId: string): Promise<string> {
  const link = await db.selectFrom('test_plan_cases').select('test_case_id').where('id', '=', planCaseId).executeTakeFirst();
  if (!link) throw new EvidenceRefused(404, 'NOT_FOUND', "The upload's case is no longer in its plan.");
  return link.test_case_id;
}
