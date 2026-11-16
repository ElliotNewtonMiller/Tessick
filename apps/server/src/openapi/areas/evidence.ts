import { MAX_EVIDENCE_DESCRIPTION, MAX_EVIDENCE_FILENAME, MAX_EVIDENCE_PER_EXECUTION, EVIDENCE_TYPES_TEXT } from '@tessick/core';
import { authedErrors, errors, handlerValidated, idParams, oneOf, pageQuery, NEXT_CURSOR, NO_CONTENT } from '../schemas.js';

const TAGS = ['Evidence'];
const KINDS = ['image', 'video', 'log', 'trace'];

const ABOUT_UPLOADS =
  `Accepted: ${EVIDENCE_TYPES_TEXT}, recognised by their contents (never their name or declared type); anything else is refused (415). ` +
  `Each file is at most the server's limit (EVIDENCE_MAX_FILE_MB, 200 MB by default; 413 says it as \`limit_bytes\`), and an execution holds at most ${MAX_EVIDENCE_PER_EXECUTION}. ` +
  'Sending the same file again (same SHA-256) for the same execution adds nothing and answers the one there (`duplicate: true`), so retries are safe. ' +
  'Needs `EXECUTE_RUN`. While the run is open anyone who may execute can add evidence; for 24 hours after it closes, only whoever recorded the result (`422 RUN_CLOSED` otherwise).';

/** The answer of every upload: what was stored, and what was refused (and why). */
const uploadAnswer = {
  type: 'object',
  required: ['evidence', 'refused'],
  properties: {
    evidence: { type: 'array', items: { $ref: 'Evidence#' } },
    refused: {
      type: 'array',
      items: {
        type: 'object',
        required: ['filename', 'status', 'code', 'detail'],
        properties: {
          filename: { type: 'string' },
          test_case_id: { type: 'string' },
          status: { type: 'integer' },
          code: { type: 'string', description: 'e.g. EVIDENCE_TYPE_REFUSED, EVIDENCE_TOO_LARGE, CHECKSUM_MISMATCH, RUN_CLOSED, NO_RESULT_TO_ATTACH' },
          detail: { type: 'string' },
          limit_bytes: { type: 'integer', description: 'With EVIDENCE_TOO_LARGE: the largest file accepted' },
        },
      },
    },
  },
};
const uploadResponses = {
  201: { description: 'Every file was stored', ...uploadAnswer },
  200: { description: 'Every file was already there (`duplicate: true`)', ...uploadAnswer },
  207: { description: 'Some files were stored and some refused (see `refused`)', ...uploadAnswer },
  ...authedErrors(
    [400, '`CHECKSUM_MISMATCH`, or no file'],
    404,
    [409, '`NO_RESULT_TO_ATTACH` (record a result first), `CASE_RETIRED`, or `EVIDENCE_LIMIT`'],
    [413, '`EVIDENCE_TOO_LARGE`, with `limit_bytes`'],
    [415, '`EVIDENCE_TYPE_REFUSED`'],
    [422, '`RUN_CLOSED`']
  ),
};

const fileBody = {
  content: {
    'multipart/form-data': {
      schema: handlerValidated({
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary', description: 'One or more file parts' },
          description: { type: 'string', maxLength: MAX_EVIDENCE_DESCRIPTION, description: 'Applies to the files after it' },
          sha256: { type: 'string', description: "The next file's SHA-256 (hex), checked (`CHECKSUM_MISMATCH`)" },
        },
      }),
    },
    'application/octet-stream': {
      schema: handlerValidated({ type: 'string', format: 'binary', description: 'The file itself (any Content-Type but JSON and multipart); name it with `?filename=`' }),
    },
  },
};
const rawQuery = {
  filename: { type: 'string', maxLength: 1000, description: 'A raw upload: the file name to show' },
  description: { type: 'string', maxLength: MAX_EVIDENCE_DESCRIPTION, description: 'A raw upload: a description' },
};
const checksumHeader = {
  type: 'object',
  properties: { 'x-checksum-sha256': { type: 'string', description: "A raw upload: the file's SHA-256 (hex), checked" } },
};

export const uploadExecutionSchema = {
  tags: TAGS,
  summary: "Add evidence to a case's execution",
  description: `Adds one or more files to the case's latest result in the run (or \`test_result_id\`'s). Send multipart/form-data file parts, or the file as the body. ${ABOUT_UPLOADS}`,
  params: idParams('runId', 'caseId'),
  querystring: { type: 'object', properties: { test_result_id: { type: 'string', description: "One of this case's results in the run; default its latest" }, ...rawQuery } },
  headers: checksumHeader,
  body: fileBody,
  response: uploadResponses,
};

export const uploadResultSchema = {
  tags: TAGS,
  summary: 'Add evidence to a result',
  description: `Adds one or more files to a given result. Send multipart/form-data file parts, or the file as the body. ${ABOUT_UPLOADS}`,
  params: idParams('resultId'),
  querystring: { type: 'object', properties: rawQuery },
  headers: checksumHeader,
  body: fileBody,
  response: uploadResponses,
};

export const uploadRunSchema = {
  tags: TAGS,
  summary: "Add evidence to a run's cases (CI)",
  description:
    "For CI: one multipart request for a whole run, each file part named by its case's id or readable id (`curl -F \"SHOP-12=@login.png\" -F \"SHOP-14=@trace.zip\"`), added to that case's latest result. " +
    `Each file succeeds or fails on its own (207 lists the refused). ${ABOUT_UPLOADS}`,
  params: idParams('runId'),
  body: {
    content: {
      'multipart/form-data': {
        schema: handlerValidated({ type: 'object', additionalProperties: { type: 'string', format: 'binary' }, description: 'File parts named by case (SHOP-12)' }),
      },
    },
  },
  response: uploadResponses,
};

export const createUploadSchema = {
  tags: TAGS,
  summary: 'Make an upload link',
  description:
    'For a large file, or an AI agent with a file on disk: a single-use link, valid 15 minutes, for one file of this size and SHA-256. ' +
    "PUT the file to `url` with `headers`. Through Tessick's own link the file becomes evidence at once (the PUT answers it); a link to S3 storage needs `POST complete_url` after. " +
    `Same rules as uploading directly. ${ABOUT_UPLOADS}`,
  params: idParams('runId', 'caseId'),
  body: {
    type: 'object',
    required: ['filename', 'size_bytes', 'sha256'],
    properties: {
      filename: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE_FILENAME },
      size_bytes: { type: 'integer', minimum: 1, description: 'The exact size' },
      sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Hex; the file is checked against it' },
      description: { type: 'string', maxLength: MAX_EVIDENCE_DESCRIPTION },
      test_result_id: { type: 'string', description: "One of this case's results in the run; default its latest" },
    },
  },
  response: {
    201: {
      description: 'The link',
      type: 'object',
      required: ['upload'],
      properties: {
        upload: {
          type: 'object',
          required: ['id', 'url', 'method', 'headers', 'expires_at', 'complete_url'],
          properties: {
            id: { type: 'string' },
            url: { type: 'string', description: 'PUT the file here. It is the only credential needed, so keep it private.' },
            method: oneOf(['PUT']),
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Send these with the PUT' },
            expires_at: { type: 'string' },
            complete_url: { type: 'string', description: 'POST here after the PUT when storage is S3 (and safely in any case)' },
          },
        },
      },
    },
    ...authedErrors(404, [409, '`NO_RESULT_TO_ATTACH` or `CASE_RETIRED`'], [413, '`EVIDENCE_TOO_LARGE`'], [422, '`RUN_CLOSED`']),
  },
};

export const putUploadSchema = {
  tags: TAGS,
  summary: 'Upload to a link',
  description:
    "The file, as the body, to an upload link's `url` (Tessick's own links). No sign-in: the link is the credential, used once, within 15 minutes, for the size and SHA-256 it was made for. Answers the evidence.",
  params: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
  security: [],
  body: { content: { 'application/octet-stream': fileBody.content['application/octet-stream'] } },
  response: {
    201: { description: 'Stored', type: 'object', required: ['evidence'], properties: { evidence: { $ref: 'Evidence#' } } },
    200: { description: 'Already there (`duplicate: true`)', type: 'object', required: ['evidence'], properties: { evidence: { $ref: 'Evidence#' } } },
    ...errors(
      [400, '`SIZE_MISMATCH` or `CHECKSUM_MISMATCH` (the link can be used again)'],
      [404, 'An unknown, used or expired link'],
      [409, '`UPLOAD_IN_PROGRESS`'],
      [413, '`EVIDENCE_TOO_LARGE`'],
      [415, '`EVIDENCE_TYPE_REFUSED`'],
      [422, '`RUN_CLOSED`']
    ),
  },
};

export const completeUploadSchema = {
  tags: TAGS,
  summary: 'Complete an upload',
  description:
    "After PUTting a file to an S3 upload link: checks it (size, type, and a log to its end; S3 checked its SHA-256) and records it. For Tessick's own links it answers the evidence the PUT made. Only whoever made the link.",
  params: idParams('uploadId'),
  response: {
    201: { description: 'Recorded', type: 'object', required: ['evidence'], properties: { evidence: { $ref: 'Evidence#' } } },
    200: { description: 'Already recorded', type: 'object', required: ['evidence'], properties: { evidence: { $ref: 'Evidence#' } } },
    ...authedErrors(
      [400, '`SIZE_MISMATCH`'],
      404,
      [409, '`NOT_UPLOADED` (PUT the file first) or `UPLOAD_IN_PROGRESS`'],
      [415, '`EVIDENCE_TYPE_REFUSED`'],
      [422, '`RUN_CLOSED`']
    ),
  },
};

export const listRunSchema = {
  tags: TAGS,
  summary: "A run's evidence",
  description: 'Every evidence file in the run, oldest first, a page at a time. Needs `SPEC_VIEW` or `EXECUTE_RUN`.',
  params: idParams('runId'),
  querystring: {
    type: 'object',
    properties: {
      test_case_id: { type: 'string', description: 'One case: its id or readable id (SHOP-12)' },
      kind: oneOf(KINDS),
      ...pageQuery(100, 500),
    },
  },
  response: {
    200: { description: 'A page of evidence', type: 'object', required: ['evidence', 'next_cursor'], properties: { evidence: { type: 'array', items: { $ref: 'Evidence#' } }, next_cursor: NEXT_CURSOR } },
    ...authedErrors(404),
  },
};

export const listExecutionSchema = {
  tags: TAGS,
  summary: "A case's evidence in a run",
  description:
    "All the evidence for a case's execution in a run, oldest first, across its results, each with `can_delete` for the caller; and `can_add`: whether the caller may add evidence to it now, or why not (the checks an upload makes). Needs `SPEC_VIEW` or `EXECUTE_RUN`.",
  params: idParams('runId', 'caseId'),
  response: {
    200: {
      description: 'The evidence',
      type: 'object',
      required: ['evidence', 'can_add'],
      properties: {
        evidence: { type: 'array', items: { $ref: 'Evidence#' } },
        can_add: {
          type: 'object',
          required: ['allowed', 'code', 'reason'],
          properties: {
            allowed: { type: 'boolean' },
            code: { type: ['string', 'null'], description: 'The code an upload would be refused with (e.g. `NO_RESULT_TO_ATTACH`, `RUN_CLOSED`)' },
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
    ...authedErrors(404),
  },
};

export const getEvidenceSchema = {
  tags: TAGS,
  summary: 'An evidence file',
  description: 'What it is, whose, and where its bytes are. Needs `SPEC_VIEW` or `EXECUTE_RUN`.',
  params: idParams('evidenceId'),
  response: { 200: { description: 'The evidence', type: 'object', required: ['evidence'], properties: { evidence: { $ref: 'Evidence#' } } }, ...authedErrors(404) },
};

export const contentSchema = {
  tags: TAGS,
  summary: "An evidence file's content",
  description:
    'The bytes, as the type its contents showed, with `Content-Security-Policy: sandbox` and `nosniff` so a browser never runs them. Images, videos and logs are shown inline; traces, or anything with `?download=1`, are downloaded. ' +
    'Range requests work (videos seek), and the `ETag` is the SHA-256. Needs `SPEC_VIEW` or `EXECUTE_RUN`; the web app reads it with its sign-in cookie.',
  params: idParams('evidenceId'),
  querystring: { type: 'object', properties: { download: oneOf(['1', 'true', '0', 'false'], 'Download it rather than show it') } },
  response: {
    200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    206: { description: 'Part of the file (a Range request)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    304: { description: 'Not changed (If-None-Match)', type: 'null' },
    ...authedErrors(404, [410, '`EVIDENCE_FILE_MISSING`: its file is gone from storage'], [416, '`RANGE_NOT_SATISFIABLE`']),
  },
};

export const deleteEvidenceSchema = {
  tags: TAGS,
  summary: 'Delete evidence',
  description:
    'Deletes it for good (there is no trash): its uploader while the run is open, or anyone with `EXECUTE_OVERWRITE`. Recorded in the Security Audit Log with its name, size and SHA-256.',
  params: idParams('evidenceId'),
  response: { 204: NO_CONTENT, ...authedErrors(403, 404) },
};
