import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { EVIDENCE_TYPES_TEXT, MAX_EVIDENCE_DESCRIPTION, MAX_EVIDENCE_FILENAME } from '@testify/core';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { innerRequest } from '../internalRequests.js';
import { ToolError, json, type JsonSchema, type ToolContent, type ToolDef } from './toolTypes.js';
import type { WriteToolDeps } from './writeTools.js';

/**
 * MCP tools for evidence (docs/rfc_03_api_and_xml_contracts.md §5): screenshots, videos, logs and
 * Playwright traces on a case's execution in a run. Like the other write tools they call the REST
 * routes as the caller (internalRequests.ts), so the same rules apply: what's accepted, the
 * window after a run closes, who may delete (there's no delete tool), and the audit rows.
 *
 * An agent with a small file sends it inline (`add_evidence`, up to 5 MB as base64, or a log as
 * text). For a large one it has on disk, `create_evidence_upload` gives a single-use link and a
 * ready curl command, which works even for an MCP-only token (the link is its own credential);
 * `complete_evidence_upload` then records it. `get_evidence` shows an image to the agent itself.
 */

/** The /mcp body limit: a 5 MB file as base64, with room for the rest of the request. */
export const MCP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SHOWN_BYTES = 2 * 1024 * 1024;
const LOG_PREVIEW_BYTES = 100 * 1024;

const projectId: JsonSchema = { type: 'string', description: 'The project: its id or its prefix (e.g. SHOP), from list_projects.' };
const runId: JsonSchema = { type: 'string', description: 'The test run (see list_plans_and_runs).' };
const caseRef: JsonSchema = { type: 'string', description: 'Case id or readable id such as SHOP-12.' };

function problem(res: { status: number; body: any }): ToolError {
  const b = res.body ?? {};
  const refused = Array.isArray(b.refused) && b.refused.length > 1 ? ` (${b.refused.map((r: any) => `${r.filename}: ${r.detail}`).join('; ')})` : '';
  return new ToolError(`${b.detail ?? `HTTP ${res.status}`}${b.code ? ` [${b.code}]` : ''}${refused}`);
}

/** Evidence as an agent sees it: no internal storage details, and where the bytes are. */
const brief = (e: any) => ({
  id: e.id,
  test_case_id: e.test_case_id,
  test_result_id: e.test_result_id,
  kind: e.kind,
  media_type: e.media_type,
  filename: e.filename,
  description: e.description,
  size_bytes: e.size_bytes,
  sha256: e.sha256,
  uploaded_by: e.uploaded_by,
  after_close: e.after_close,
  created_at: e.created_at,
  content_url: e.content_url,
  ...(e.duplicate ? { duplicate: true } : {}),
});

export function evidenceTools({ db, requireProject }: WriteToolDeps): ToolDef[] {
  async function call(request: FastifyRequest, method: 'GET' | 'POST', url: string, payload?: unknown, options: Parameters<typeof innerRequest>[5] = {}) {
    const res = await innerRequest(request, 'mcp', method, url, payload, options);
    if (res.status >= 400) throw problem(res);
    return res;
  }

  async function runInProject(id: unknown, project: string): Promise<string> {
    const run =
      typeof id === 'string'
        ? await db
            .selectFrom('test_runs')
            .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
            .select(['test_runs.id', 'test_plans.project_id'])
            .where('test_runs.id', '=', id)
            .executeTakeFirst()
        : undefined;
    if (!run || run.project_id !== project) throw new ToolError(`Test run '${String(id)}' not found in this project (see list_plans_and_runs).`);
    return run.id;
  }

  async function evidenceInProject(request: FastifyRequest, id: unknown, project: string) {
    if (typeof id !== 'string' || !id) throw new ToolError('evidence_id is required (see list_evidence).');
    const found = await db.selectFrom('evidence').select('project_id').where('id', '=', id).executeTakeFirst();
    if (!found || found.project_id !== project) throw new ToolError(`Evidence '${id}' not found in this project (see list_evidence).`);
    return (await call(request, 'GET', `/api/v1/evidence/${id}`)).body.evidence;
  }

  const executionPath = (run: string, ref: unknown) => {
    const c = String(ref ?? '').trim();
    if (!c) throw new ToolError('test_case_id is required.');
    return `/api/v1/runs/${run}/cases/${encodeURIComponent(c)}/evidence`;
  };

  return [
    {
      name: 'add_evidence',
      description:
        `Add a file of evidence to a case's latest result in a test run: ${EVIDENCE_TYPES_TEXT}, recognised by contents. Send content_base64 (up to 5 MB), or text for a log. ` +
        "The case needs a result in the run first (record_results). Allowed while the run is open, and for 24 hours after it closes for whoever recorded the result. The same file twice adds nothing. For a larger file on disk use create_evidence_upload.",
      write: { permissions: ['EXECUTE_RUN'], idempotent: true },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_run_id: runId,
          test_case_id: caseRef,
          filename: { type: 'string', maxLength: MAX_EVIDENCE_FILENAME, description: 'e.g. login-failed.png' },
          content_base64: { type: 'string', description: 'The file, base64-encoded (up to 5 MB decoded)' },
          text: { type: 'string', description: 'A log as text, instead of content_base64' },
          description: { type: 'string', maxLength: MAX_EVIDENCE_DESCRIPTION },
        },
        required: ['project_id', 'test_run_id', 'test_case_id', 'filename'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const run = await runInProject(args.test_run_id, project);
        const hasBase64 = typeof args.content_base64 === 'string' && args.content_base64.length > 0;
        const hasText = typeof args.text === 'string' && args.text.length > 0;
        if (hasBase64 === hasText) throw new ToolError('Send either content_base64 or text.');
        const bytes = hasBase64 ? Buffer.from(args.content_base64.replace(/\s+/g, ''), 'base64') : Buffer.from(args.text, 'utf8');
        if (bytes.length === 0) throw new ToolError("content_base64 isn't base64 of a file.");
        if (bytes.length > MAX_INLINE_BYTES) throw new ToolError(`That's ${Math.round(bytes.length / 1024)} KB: inline files can be at most 5 MB. Use create_evidence_upload for larger ones.`);
        const query = new URLSearchParams({ filename: String(args.filename), ...(args.description ? { description: String(args.description) } : {}) });
        const out = await call(request, 'POST', `${executionPath(run, args.test_case_id)}?${query}`, bytes);
        return json({ evidence: out.body.evidence.map(brief), refused: out.body.refused });
      },
    },
    {
      name: 'create_evidence_upload',
      description:
        "For a large evidence file you have on disk (a video, a trace): a single-use upload link, valid 15 minutes, for this exact file. Answers a ready curl command; run it, then call complete_evidence_upload. " +
        'Give the exact size and the SHA-256 (sha256sum). Same rules as add_evidence.',
      write: { permissions: ['EXECUTE_RUN'] },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_run_id: runId,
          test_case_id: caseRef,
          filename: { type: 'string', minLength: 1, maxLength: MAX_EVIDENCE_FILENAME },
          size_bytes: { type: 'integer', minimum: 1 },
          sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Hex' },
          description: { type: 'string', maxLength: MAX_EVIDENCE_DESCRIPTION },
        },
        required: ['project_id', 'test_run_id', 'test_case_id', 'filename', 'size_bytes', 'sha256'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const run = await runInProject(args.test_run_id, project);
        const out = await call(request, 'POST', `${executionPath(run, args.test_case_id)}/uploads`, {
          filename: args.filename,
          size_bytes: args.size_bytes,
          sha256: args.sha256,
          ...(args.description ? { description: args.description } : {}),
        });
        const u = out.body.upload;
        const headerArgs = Object.entries(u.headers as Record<string, string>)
          .map(([k, v]) => `-H '${k}: ${v}'`)
          .join(' ');
        const file = `'${String(args.filename).replace(/'/g, "'\\''")}'`;
        return json({
          upload_id: u.id,
          url: u.url,
          method: u.method,
          headers: u.headers,
          expires_at: u.expires_at,
          curl: `curl -sf -X PUT ${headerArgs} --data-binary @${file} '${u.url}'`,
          next: 'Run the curl command (from the folder with the file), then call complete_evidence_upload with this upload_id. The link is a credential: use it once, and don\'t share it.',
        });
      },
    },
    {
      name: 'complete_evidence_upload',
      description: 'After the file is PUT to its upload link (create_evidence_upload): records it as evidence and answers it.',
      write: { permissions: ['EXECUTE_RUN'], idempotent: true },
      inputSchema: {
        type: 'object',
        properties: { project_id: projectId, upload_id: { type: 'string' } },
        required: ['project_id', 'upload_id'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const upload = typeof args.upload_id === 'string' ? await db.selectFrom('evidence_uploads').select('project_id').where('id', '=', args.upload_id).executeTakeFirst() : undefined;
        if (!upload || upload.project_id !== project) throw new ToolError(`Upload '${String(args.upload_id)}' not found in this project.`);
        const out = await call(request, 'POST', `/api/v1/evidence-uploads/${args.upload_id}/complete`);
        return json({ evidence: brief(out.body.evidence) });
      },
    },
    {
      name: 'list_evidence',
      description: "The evidence in a test run (screenshots, videos, logs, traces), or for one case in it, oldest first, with each file's kind, name, size and result. Use get_evidence to look at one.",
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_run_id: runId,
          test_case_id: caseRef,
          kind: { type: 'string', enum: ['image', 'video', 'log', 'trace'] },
        },
        required: ['project_id', 'test_run_id'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const run = await runInProject(args.test_run_id, project);
        const query = new URLSearchParams({ limit: '200', ...(args.test_case_id ? { test_case_id: String(args.test_case_id) } : {}), ...(args.kind ? { kind: String(args.kind) } : {}) });
        const out = await call(request, 'GET', `/api/v1/runs/${run}/evidence?${query}`);
        return json({ evidence: out.body.evidence.map(brief), more: out.body.next_cursor !== null });
      },
    },
    {
      name: 'get_evidence',
      description:
        'One evidence file: what it is, and its content when it can be shown here. An image of up to 2 MB is returned as an image you can look at; a log as text (the first 100 KB). A video or trace is described only: the user can open it in Testify.',
      inputSchema: {
        type: 'object',
        properties: { project_id: projectId, evidence_id: { type: 'string', description: 'See list_evidence.' } },
        required: ['project_id', 'evidence_id'],
        additionalProperties: false,
      },
      run: async (args, user: AuthenticatedUser, request): Promise<ToolContent> => {
        const project = await requireProject(user, args.project_id);
        const evidence = await evidenceInProject(request, args.evidence_id, project);
        const about = { type: 'text' as const, text: json({ evidence: brief(evidence) }) };
        if (evidence.kind === 'image' && evidence.size_bytes <= MAX_IMAGE_SHOWN_BYTES) {
          const file = await call(request, 'GET', evidence.content_url);
          return { content: [about, { type: 'image', data: file.raw.toString('base64'), mimeType: evidence.media_type }] };
        }
        if (evidence.kind === 'log') {
          const file = await call(request, 'GET', evidence.content_url, undefined, { headers: { range: `bytes=0-${LOG_PREVIEW_BYTES - 1}` } });
          const truncated = evidence.size_bytes > LOG_PREVIEW_BYTES;
          // A cut at 100 KB may split a character: drop a broken one at the end.
          const text = file.raw.toString('utf8').replace(/�$/, '');
          return { content: [about, { type: 'text', text: truncated ? `${text}\n… (the first 100 KB of ${evidence.size_bytes} bytes)` : text }] };
        }
        const note =
          evidence.kind === 'image'
            ? `This image is ${Math.round(evidence.size_bytes / 1024)} KB, too large to show here (at most 2 MB): open it in Testify.`
            : `A ${evidence.kind} can't be shown here: open it in Testify, or download it from content_url with an API token.`;
        return { content: [about, { type: 'text', text: note }] };
      },
    },
  ];
}
