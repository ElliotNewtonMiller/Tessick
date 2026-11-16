import type { FastifyInstance, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { TestRunRepository, CustomFieldRepository, ProjectRepository, TestCaseVersionRepository, TestPlanRepository, TestSuiteRepository } from '@testify/db';
import { REPORT_CATALOG, REPORT_DEFINITIONS, renderRunSummaryMarkdown, validateReportParams, type ReportDefinition, type RunSummaryReport } from '@testify/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authenticateRequest, canViewProject, apiTokenScope, type AuthenticatedUser } from '../middleware/auth.js';
import { ReportError, ReportService } from '../services/reportService.js';
import { CaseFilterService } from '../services/caseFilterService.js';
import { mcpSchema } from '../openapi/areas/other.js';
import { evidenceTools, MCP_BODY_LIMIT_BYTES } from './evidenceTools.js';
import { requestOrigin } from '../audit.js';
import { ToolError, json, type JsonSchema, type ToolDef } from './toolTypes.js';
import { writeTools } from './writeTools.js';

/** Smaller list sizes than the REST defaults, to keep agent context small. */
const MCP_DEFAULT_LIMIT = 25;

const INSTRUCTIONS = `Testify is a test case management system: projects contain test suites and test cases; a test plan selects cases to run; each test run of a plan records a result per case (PASSED, FAILED, BLOCKED, SKIPPED).
Reading: list_projects -> list_plans_and_runs -> report_run_summary (what broke in a run, compared with the previous run, with error messages and how long each failure has been failing) -> report_case_history for a specific case -> report_test_health for flaky/slow/always-failing/stale cases.
Use search_cases / list_report_fields to find cases, and list_suites for the suite tree; most reports take the same "filter" to limit them to matching cases. report_run_summary accepts format "markdown" for a ready-to-post summary.
Rates are fractions between 0 and 1. ${REPORT_DEFINITIONS.flaky}
Evidence: a case's execution in a run can carry screenshots, videos, logs and Playwright traces. list_evidence lists them and get_evidence shows one (an image you can look at, or a log's text); add_evidence adds a small file (base64, or a log as text) to a case that has a result, and create_evidence_upload + complete_evidence_upload upload a large file from disk with curl.
Changing (the tools with readOnlyHint false, offered when the caller may use them): create_suite, create_case, duplicate_case (a copy of a case, with changes, in one call), update_case, update_cases, create_run, record_results, update_plan_cases, add_evidence, create_evidence_upload, complete_evidence_upload. They act as the caller, with the caller's permissions, and every change is audit-logged as made through MCP. Cases you create start as DRAFT, and editing an approved case's summary, preconditions or steps makes a new DRAFT version: a person reviews and approves them in Testify, so tell the user what you created or changed (readable ids). There are no tools to approve, deprecate or delete. Prefer update_cases and update_plan_cases over one call per case.`;

/** Every tool's project argument: an id or, as people and agents know a project, its prefix. */
const PROJECT_ARG: JsonSchema = { type: 'string', description: 'The project: its id or its prefix (e.g. SHOP), from list_projects.' };

/** The catalog's param schema as plain JSON Schema (nullable -> type: [t, "null"]). */
function toJsonSchema(report: ReportDefinition): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    project_id: PROJECT_ARG,
  };
  for (const [key, p] of Object.entries(report.params.properties)) {
    const { nullable, ...rest } = p;
    properties[key] = nullable ? { ...rest, type: [p.type, 'null'] } : { ...rest };
    if (key === 'limit') properties[key] = { ...properties[key], default: MCP_DEFAULT_LIMIT };
  }
  if (report.formats.includes('markdown')) {
    properties.format = { type: 'string', enum: ['json', 'markdown'], default: 'json', description: 'markdown returns a summary ready to paste into a PR comment or chat.' };
  }
  return { type: 'object', properties, required: ['project_id', ...report.params.required], additionalProperties: false };
}

/**
 * MCP endpoint (Streamable HTTP, stateless, JSON responses) at POST /mcp.
 *
 * Authenticates exactly like the REST API (login JWT or tf_ci_ machine token), and every
 * tool checks SPEC_VIEW for the project it's asked about -- a token only ever sees its own
 * project. Report tools are generated from @testify/core's REPORT_CATALOG and call the same
 * ReportService as the REST routes, so agents get exactly the numbers people see. The write
 * tools (writeTools.ts) call the REST routes as the caller; an API token is offered only the
 * ones its capabilities allow.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http testify http://localhost:3001/mcp --header "Authorization: Bearer tf_ci_..."
 */
/** The arguments a tool's schema doesn't list, when it lists them all (additionalProperties: false). */
function unknownArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  if (schema.additionalProperties !== false) return [];
  const known = new Set(Object.keys((schema.properties ?? {}) as object));
  return Object.keys(args).filter((k) => !known.has(k));
}

export async function registerMcpRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const reports = new ReportService(db);
  const caseFilter = new CaseFilterService(db);
  const projectRepo = new ProjectRepository(db);
  const planRepo = new TestPlanRepository(db);
  const runRepo = new TestRunRepository(db);
  const versionRepo = new TestCaseVersionRepository(db);
  const customFieldRepo = new CustomFieldRepository(db);
  const suiteRepo = new TestSuiteRepository(db);

  const canView = (user: AuthenticatedUser, projectId: string) => canViewProject(user, projectId, db);

  /** A project by id or prefix (DEMO, demo): an agent knows the prefix from case ids like DEMO-8. */
  async function findProject(ref: string) {
    return (await projectRepo.findById(ref)) ?? (await projectRepo.findByPrefix(ref.trim().toUpperCase()));
  }

  async function requireProject(user: AuthenticatedUser, ref: unknown): Promise<string> {
    if (typeof ref !== 'string' || !ref) throw new ToolError('project_id is required: the project\'s id or prefix (see list_projects).');
    const project = await findProject(ref);
    if (user.api_token && (!project || user.api_token.project_id !== project.id)) {
      throw new ToolError(`This API token can only read project '${user.api_token.project_id}'.`);
    }
    if (!project) throw new ToolError(`Project '${ref}' not found: give its id or prefix (see list_projects).`);
    if (!(await canView(user, project.id))) throw new ToolError(`You don't have SPEC_VIEW on project '${project.prefix}'.`);
    return project.id;
  }

  const baseTools: ToolDef[] = [
    {
      name: 'list_projects',
      description: 'Projects you can read (an API token sees only its own project): id, name, prefix (the start of every case external id, e.g. SHOP-12).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, user) => {
        const all = await projectRepo.findAll();
        const visible = [];
        for (const p of all) if (await canView(user, p.id)) visible.push({ id: p.id, name: p.name, prefix: p.prefix, description: p.description });
        return json({ projects: visible, ...apiTokenScope(user) });
      },
    },
    {
      name: 'list_plans_and_runs',
      description: "A project's test plans with their most recent runs (newest first). ARCHIVED plans are left out unless include_archived is true.",
      inputSchema: {
        type: 'object',
        properties: {
          project_id: PROJECT_ARG,
          include_archived: { type: 'boolean', default: false },
          runs_per_plan: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const perPlan = Math.min(Math.max(Number(args.runs_per_plan) || 10, 1), 50);
        const plans = (await planRepo.findByProject(projectId)).filter((p) => args.include_archived || p.status !== 'ARCHIVED');
        const out = [];
        for (const plan of plans) {
          const runs = await runRepo.findByTestPlan(plan.id);
          out.push({
            id: plan.id,
            name: plan.name,
            status: plan.status,
            run_count: runs.length,
            runs: runs.slice(0, perPlan).map((r) => ({ id: r.id, name: r.name, status: r.status, created_at: r.created_at, release_date: r.release_date })),
          });
        }
        return json({ plans: out });
      },
    },
    {
      name: 'list_suites',
      description: "A project's test suites (folders of cases): id, name, full path (e.g. \"Payments / Checkout\"), parent and how many cases each holds directly.",
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ARG }, required: ['project_id'], additionalProperties: false },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const suites = await suiteRepo.findByProject(projectId);
        const byId = new Map(suites.map((s) => [s.id, s]));
        const pathOf = (s: (typeof suites)[number]): string => {
          const names: string[] = [];
          for (let cur: (typeof suites)[number] | undefined = s; cur; cur = cur.parent_suite_id ? byId.get(cur.parent_suite_id) : undefined) names.unshift(cur.name);
          return names.join(' / ');
        };
        const counts = await db.selectFrom('test_cases').select(['test_suite_id', db.fn.countAll<number>().as('n')]).where('project_id', '=', projectId).groupBy('test_suite_id').execute();
        const countBy = new Map(counts.map((c) => [c.test_suite_id, Number(c.n)]));
        return json({
          suites: suites
            .map((s) => ({ id: s.id, name: s.name, path: pathOf(s), parent_suite_id: s.parent_suite_id, case_count: countBy.get(s.id) ?? 0 }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        });
      },
    },
    {
      name: 'list_report_fields',
      description: 'Properties cases can be filtered or grouped by (built-ins and custom fields), with their kind and options -- use the keys in a "filter" ({ q, filters: [{ field, op, value }] }) or as breakdown group_by.',
      inputSchema: { type: 'object', properties: { project_id: PROJECT_ARG }, required: ['project_id'], additionalProperties: false },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        return json({
          fields: await caseFilter.fieldCatalog(projectId),
          operators: {
            any_of: 'ENUM / SINGLE_SELECT / MULTI_SELECT: value is a list of option values',
            all_of: 'MULTI_SELECT: has every listed value',
            contains: 'TEXT: case-insensitive substring',
            is: 'CHECKBOX / BOOLEAN: true or false',
            eq: 'NUMBER / DATE', gte: 'NUMBER / DATE', lte: 'NUMBER / DATE', between: 'NUMBER / DATE: [min, max]',
            is_empty: 'no value', is_not_empty: 'has a value',
          },
        });
      },
    },
    {
      name: 'search_cases',
      description: 'Find test cases by text (external id, title, or the name of a suite they are in) and/or property filters. Returns case ids, external ids, titles, suite paths, priority, execution type and status.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: PROJECT_ARG,
          q: { type: 'string', description: 'Matches external id, title, or the name of the case\'s suite or any suite above it.' },
          filters: { type: 'array', items: { type: 'object' }, description: 'See list_report_fields.' },
          test_plan_id: { type: 'string', description: "Needed for the 'in_plan' filter." },
          test_run_id: { type: 'string', description: "Needed for the 'verdict' filter." },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: MCP_DEFAULT_LIMIT },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const outcome = await caseFilter.evaluate(projectId, { q: args.q, filters: args.filters, test_plan_id: args.test_plan_id, test_run_id: args.test_run_id });
        if (!outcome.ok) throw new ToolError(`${outcome.error}${outcome.details ? `: ${outcome.details.map((d) => `${d.name} ${d.reason}`).join('; ')}` : ''}`);
        const limit = Math.min(Math.max(Number(args.limit) || MCP_DEFAULT_LIMIT, 1), 500);
        return json({
          total_matches: outcome.case_ids.length,
          total_cases: outcome.total_cases,
          cases: await reports.describeCases(projectId, outcome.case_ids.slice(0, limit)),
        });
      },
    },
    {
      name: 'get_case',
      description: "One test case's content: title, suite, priority, latest version (status, summary, preconditions, steps with expected results) and custom field values.",
      inputSchema: {
        type: 'object',
        properties: { project_id: PROJECT_ARG, test_case_id: { type: 'string', description: 'Case id or external id such as SHOP-12.' } },
        required: ['project_id', 'test_case_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const c = await reports.findCase(projectId, String(args.test_case_id ?? ''));
        const [version, values] = await Promise.all([
          versionRepo.findLatestVersion(c.id),
          customFieldRepo.getValuesForEntity('TestCase', c.id, projectId),
        ]);
        return json({
          id: c.id,
          external_id: c.external_id,
          title: c.title,
          suite_path: c.suite_path,
          priority: c.priority,
          execution_type: c.execution_type,
          latest_version: version
            ? {
                version_number: version.version_number,
                status: version.status,
                summary: version.summary,
                preconditions: version.preconditions,
                steps: version.steps.map((s) => ({ step_number: s.step_number, action: s.action, expected_result: s.expected_result })),
              }
            : null,
          custom_fields: values.map((v) => ({ field: v.definition.field_label, value: v.value })),
        });
      },
    },
  ];

  const reportTools: ToolDef[] = REPORT_CATALOG.map((report) => ({
    name: `report_${report.id}`,
    description: `${report.title}: ${report.description}`,
    inputSchema: toJsonSchema(report),
    run: async (args, user) => {
      const projectId = await requireProject(user, args.project_id);
      const { project_id: _p, format, ...rest } = args;
      if ('limit' in report.params.properties && rest.limit === undefined) rest.limit = MCP_DEFAULT_LIMIT;
      const validation = validateReportParams(report, rest);
      if (!validation.ok) throw new ToolError(validation.errors.map((e) => `${e.param} ${e.reason}`).join('; '));
      const output = await reports.run(projectId, report.id, validation.params);
      if (format === 'markdown' && report.id === 'run_summary') return renderRunSummaryMarkdown(output.data as RunSummaryReport);
      return json(output.data);
    },
  }));

  const tools = [
    ...baseTools,
    ...reportTools,
    ...writeTools({ db, requireProject, findCase: (projectId, ref) => reports.findCase(projectId, ref) }),
    ...evidenceTools({ db, requireProject, findCase: (projectId, ref) => reports.findCase(projectId, ref) }),
  ];
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  /** An API token sees only the write tools its capabilities allow (a user's permissions differ per project, so they see all). */
  const offered = (user: AuthenticatedUser, tool: ToolDef) =>
    !tool.write || !user.api_token || tool.write.permissions.every((k) => user.permissions.includes(k) || user.permissions.includes('SYSTEM_ADMIN'));

  /** One Security Audit Log row per write tool call, so what agents did is easy to find. */
  async function auditWrite(request: FastifyRequest, user: AuthenticatedUser, tool: ToolDef, args: Record<string, any>, outcome: { ok: boolean; error?: string }) {
    const project = typeof args.project_id === 'string' && args.project_id ? ((await findProject(args.project_id))?.id ?? null) : null;
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: user.id,
        actor_type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
        action: 'MCP_WRITE',
        resource_type: 'mcp_tool',
        resource_id: tool.name,
        project_id: project,
        diff: JSON.stringify({ tool: tool.name, ok: outcome.ok, ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}) }),
        ...requestOrigin(request),
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  function buildServer(user: AuthenticatedUser, request: FastifyRequest): Server {
    const server = new Server({ name: 'testify', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools
        .filter((t) => offered(user, t))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as any,
          annotations: t.write
            ? { readOnlyHint: false, destructiveHint: Boolean(t.write.destructive), idempotentHint: Boolean(t.write.idempotent), openWorldHint: false }
            : { readOnlyHint: true },
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = toolByName.get(req.params.name);
      if (!tool || !offered(user, tool)) {
        const why = tool ? ` (this API token lacks ${tool.write!.permissions.join(', ')})` : '';
        return { isError: true, content: [{ type: 'text', text: `Unknown tool '${req.params.name}'${why}` }] };
      }
      const args = (req.params.arguments ?? {}) as Record<string, any>;
      // An argument the tool doesn't take is refused, not ignored: an agent that wrote
      // `filter` for `filters` used to get unfiltered results and no hint why.
      const unknown = unknownArguments(tool.inputSchema, args);
      if (unknown.length > 0) {
        const takes = Object.keys((tool.inputSchema.properties ?? {}) as object);
        return {
          isError: true,
          content: [{ type: 'text', text: `${tool.name} doesn't take ${unknown.map((k) => `'${k}'`).join(', ')}. Its arguments: ${takes.join(', ') || 'none'}.` }],
        };
      }
      try {
        const answer = await tool.run(args, user, request);
        if (tool.write) await auditWrite(request, user, tool, args, { ok: true });
        return typeof answer === 'string' ? { content: [{ type: 'text', text: answer }] } : { ...answer };
      } catch (err) {
        if (err instanceof ToolError || err instanceof ReportError) {
          if (tool.write) await auditWrite(request, user, tool, args, { ok: false, error: err.message });
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
        throw err;
      }
    });
    return server;
  }

  // 8 MB: add_evidence takes a file of up to 5 MB as base64.
  app.post('/mcp', { schema: mcpSchema, config: { stripNul: true }, bodyLimit: MCP_BODY_LIMIT_BYTES }, async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return; // 401 already sent

    // Stateless: a fresh server + transport per request, bound to this caller.
    const server = buildServer(user, request);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = async (_request: unknown, reply: any) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
  // Not documented: Streamable HTTP without sessions has no GET or DELETE.
  app.get('/mcp', { schema: { hide: true } }, methodNotAllowed);
  app.delete('/mcp', { schema: { hide: true } }, methodNotAllowed);
}
