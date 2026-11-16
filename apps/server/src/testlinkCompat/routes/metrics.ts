import { CompatApiKeyRepository, CompatIdRepository, ProjectRepository, SystemSettingsRepository, TestSuiteRepository } from '@tessick/db';
import { METRICS_DEFAULT_EXCLUDED_SUITE, TestLinkQueryError, caseMatches, parseCaseQuery, swagProductFor, testCaseMetrics } from '@tessick/core';
import { writeAudit } from '../../audit.js';
import type { CompatRoute } from '../index.js';
import { CUSTOM } from '../versions.js';
import { INSUFFICIENT_RIGHTS, tlError, tlKo, tlOk } from '../envelope.js';
import { loadProjectSpec, projectAccess } from '../projectData.js';

/**
 * Dave's custom metrics and its SWAG file (testCoverageSWAG.json: per product, coverage
 * estimates and the project API key, `productKey`, that ties it to a project).
 *
 * TestLink serves the SWAG file to anyone, read and write, though it holds every project's API
 * key. Tessick asks for a TestLink key to read it, and also a manager's permission
 * (PLAN_MANAGE, as a Test Lead has) to replace it. Dave's manageSWAGS.html then needs to send an
 * APIKEY header (to settle with Dave). The file is kept in system_settings.
 */

export const SWAG_SETTING = 'testlink_swag_file';

export const metricsRoutes: CompatRoute[] = [
  {
    method: 'GET',
    path: '/testcasemetrics',
    versions: CUSTOM,
    statuses: [400, 404],
    auth: true,
    // The project is the one projectApiKey names, or the one suiteIds are in. The configured
    // "Deprecated" suite is left out unless excludeSuiteNames is given (empty: nothing is).
    handle: async (request, reply, ctx) => {
      const params = request.query as Record<string, unknown>;
      try {
        const q = parseCaseQuery(params, 'project');
        if (!('excludeSuiteNames' in params)) q.exclusions.names.push(METRICS_DEFAULT_EXCLUDED_SUITE.toLowerCase());
        const apiKey = typeof params.projectApiKey === 'string' ? params.projectApiKey.trim() : '';
        if (!apiKey && !q.suiteIds) return tlError(reply, 400, 'Missing required parameter: projectApiKey');

        // The project the suites are in.
        let projectId: string | undefined;
        const suiteUuids: string[] = [];
        const ids = new CompatIdRepository(ctx.db);
        for (const n of q.suiteIds ?? []) {
          const uuid = await ids.entityId('suite', n);
          const suite = uuid ? await new TestSuiteRepository(ctx.db).findById(uuid) : undefined;
          if (!suite) return tlError(reply, 400, `No Test Suite identified by '${n}'!`);
          if (projectId && suite.project_id !== projectId) return tlError(reply, 400, 'suiteIds must all be in one test project');
          projectId = suite.project_id;
          suiteUuids.push(suite.id);
        }
        const keys = new CompatApiKeyRepository(ctx.db);
        if (apiKey) {
          const byKey = await keys.entityFor('project', apiKey);
          if (!byKey) return tlError(reply, 404, `No Test Project found with API key: ${apiKey}`);
          if (projectId && projectId !== byKey) return tlError(reply, 400, "suiteIds aren't in the project projectApiKey names");
          projectId = byKey;
        }
        const project = await new ProjectRepository(ctx.db).findById(projectId!);
        const access = project ? await projectAccess(request, ctx, project.id) : undefined;
        if (!project || !access?.visible) return tlError(reply, 404, `No Test Project found with API key: ${apiKey || '(from suiteIds)'}`);
        if (!access.spec) return tlKo(reply, 403, INSUFFICIENT_RIGHTS);

        const spec = await loadProjectSpec(ctx, project.id, { steps: false });
        const cases = spec.tree.collect(q.suiteIds ?? null, true, q.exclusions).filter((c) => caseMatches(c, q));
        const stored = (await new SystemSettingsRepository(ctx.db).getMany([SWAG_SETTING]))[SWAG_SETTING];
        let swag: unknown;
        try {
          swag = stored ? JSON.parse(stored) : undefined;
        } catch {
          swag = undefined;
        }
        const metrics = testCaseMetrics(cases, {
          projectName: project.name,
          includeExecutionType: String(params.includeExecutionType ?? '').trim() === '1',
          swagProduct: swagProductFor(swag, await keys.keyFor('project', project.id)),
        });
        return tlOk(reply, { metrics });
      } catch (err) {
        if (err instanceof TestLinkQueryError) return tlError(reply, 400, err.message);
        throw err;
      }
    },
  },
  {
    method: 'GET',
    path: '/swagfile',
    versions: CUSTOM,
    statuses: [404],
    auth: true,
    // The file as saved.
    handle: async (_request, reply, ctx) => {
      const stored = (await new SystemSettingsRepository(ctx.db).getMany([SWAG_SETTING]))[SWAG_SETTING];
      if (stored === undefined) return tlError(reply, 404, 'File not found');
      return reply.code(200).header('content-type', 'application/json; charset=utf-8').send(stored);
    },
  },
  {
    method: 'POST',
    path: '/swagfile',
    versions: CUSTOM,
    statuses: [400],
    auth: true,
    // Replaces the file with the body, which must be a JSON object.
    handle: async (request, reply, ctx) => {
      const permissions = request.user!.permissions;
      if (!permissions.includes('SYSTEM_ADMIN') && !permissions.includes('PLAN_MANAGE')) return tlKo(reply, 403, INSUFFICIENT_RIGHTS);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return tlError(reply, 400, 'Invalid JSON content');
      const text = JSON.stringify(body, null, 4);
      await new SystemSettingsRepository(ctx.db).setMany({ [SWAG_SETTING]: text });
      const bytes = Buffer.byteLength(text, 'utf8');
      await writeAudit(ctx.db, request, { action: 'TESTLINK_SWAG_SAVED', resourceType: 'setting', resourceId: SWAG_SETTING, projectId: null, diff: { bytes } });
      return tlOk(reply, { message: 'File saved successfully', bytes_written: bytes });
    },
  },
];
