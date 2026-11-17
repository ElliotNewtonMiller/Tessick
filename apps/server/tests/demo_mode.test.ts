import { describe, it, expect, afterEach } from 'vitest';
import { createDbClient } from '@tessick/db';
import { createServer } from '../src/server.js';
import {
  ConfigError,
  DEMO_ADMIN_PASSWORD,
  resolveDemoMode,
  resolveInitialAdminPassword,
  resolveJwtSecret,
  resolveSecretsKey,
} from '../src/config.js';

describe('Demo mode settings (TESSICK_DEMO)', () => {
  it('is off unless TESSICK_DEMO is true, and refuses anything but true or false', () => {
    expect(resolveDemoMode({})).toBe(false);
    expect(resolveDemoMode({ TESSICK_DEMO: 'false' })).toBe(false);
    expect(resolveDemoMode({ TESSICK_DEMO: ' TRUE ' })).toBe(true);
    expect(() => resolveDemoMode({ TESSICK_DEMO: 'yes' })).toThrow(ConfigError);
  });

  it('lets a real database start without JWT_SECRET or SECRETS_KEY, with random ones', () => {
    expect(() => resolveJwtSecret({ inMemory: false }, {})).toThrow(/JWT_SECRET is not set/);
    const a = resolveJwtSecret({ inMemory: false, demo: true }, {});
    expect(a).toHaveLength(64);
    expect(resolveJwtSecret({ inMemory: false, demo: true }, {})).not.toBe(a);
    expect(resolveJwtSecret({ inMemory: false, demo: true }, { JWT_SECRET: 'x'.repeat(32) })).toBe('x'.repeat(32));
    expect(resolveSecretsKey({ inMemory: false }, {})).toBeNull();
    expect(resolveSecretsKey({ inMemory: false, demo: true }, {})).not.toBeNull();
  });

  it('gives the first admin the demo password, unless ADMIN_PASSWORD chooses one', () => {
    for (const inMemory of [false, true]) {
      expect(resolveInitialAdminPassword({ inMemory, demo: true }, {})).toEqual({
        password: DEMO_ADMIN_PASSWORD,
        mustChangePassword: false,
        source: 'demo',
      });
    }
    expect(resolveInitialAdminPassword({ inMemory: false, demo: true }, { ADMIN_PASSWORD: 'Correct-Horse-Battery-1' }).source).toBe('env');
  });
});

describe('A server in demo mode', () => {
  const saved = { TESSICK_DEMO: process.env.TESSICK_DEMO, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const instance = async (app: any) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/instance' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload);
  };
  const login = async (app: any, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  };
  const demoProjects = async (db: any) => db.selectFrom('projects').select(['id', 'name', 'prefix']).where('name', 'like', 'Report Demo%').execute();

  it('loads the Report Demo project into a fresh database once, and shows the demo sign-in', async () => {
    process.env.TESSICK_DEMO = 'true';
    const db = createDbClient();
    try {
      const first = await createServer(undefined, { db });
      expect(first.demoProject).toMatchObject({ projectName: 'Report Demo', prefix: 'DEMO' });
      expect(first.demoProject!.ciToken).toMatch(/^tk_ci_/);

      // The sign-in page's information needs no sign-in; the demo password works.
      expect(await instance(first.app)).toEqual({ demo: { username: 'admin', password: DEMO_ADMIN_PASSWORD } });
      const token = await login(first.app, DEMO_ADMIN_PASSWORD);

      // The project, as the report demo script makes it: 12 cases in one plan, 8 runs with results.
      const [project] = await demoProjects(db);
      expect(project.prefix).toBe('DEMO');
      const cases = await db.selectFrom('test_cases').select('id').where('project_id', '=', project.id).execute();
      expect(cases).toHaveLength(12);
      const plans = await db.selectFrom('test_plans').select('id').where('project_id', '=', project.id).execute();
      expect(plans).toHaveLength(1);
      const runs = await db.selectFrom('test_runs').select('id').where('test_plan_id', '=', plans[0].id).execute();
      expect(runs).toHaveLength(8);
      const results = await db.selectFrom('test_results').select('id').where('test_run_id', 'in', runs.map((r: any) => r.id)).execute();
      expect(results.length).toBeGreaterThan(70);

      // The token works for reports, e.g. over MCP.
      const overview = await first.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/reports/overview`,
        headers: { authorization: `Bearer ${first.demoProject!.ciToken}` },
        payload: {},
      });
      expect(overview.statusCode).toBe(200);

      // Deleted by someone trying it out, it stays deleted after a restart.
      const deleted = await first.app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${project.id}?force=true`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleted.statusCode).toBe(204);
      await first.app.close();

      const second = await createServer(undefined, { db });
      expect(second.demoProject).toBeNull();
      expect(await demoProjects(db)).toHaveLength(0);
      expect(await instance(second.app)).toEqual({ demo: { username: 'admin', password: DEMO_ADMIN_PASSWORD } });
      await second.app.close();
    } finally {
      await db.destroy();
    }
  }, 60_000);

  it('never shows a password chosen with ADMIN_PASSWORD', async () => {
    process.env.TESSICK_DEMO = 'true';
    process.env.ADMIN_PASSWORD = 'Correct-Horse-Battery-1';
    const { app, db, demoProject } = await createServer();
    try {
      expect(await instance(app)).toEqual({ demo: { username: 'admin', password: null } });
      expect(demoProject).toMatchObject({ projectName: 'Report Demo' });
      await login(app, 'Correct-Horse-Battery-1');
    } finally {
      await app.close();
      await db.destroy();
    }
  }, 60_000);

  it('is off by default: no demo sign-in and no demo project', async () => {
    const { app, db, demoProject } = await createServer();
    try {
      expect(await instance(app)).toEqual({ demo: null });
      expect(demoProject).toBeNull();
      expect(await demoProjects(db)).toHaveLength(0);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
