import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

describe('Browser security headers', () => {
  let app: any;
  let webDir: string | undefined;
  let previousTrustProxy: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (webDir) rmSync(webDir, { recursive: true, force: true });
    webDir = undefined;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
  });

  const expectCommonHeaders = (headers: Record<string, unknown>) => {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
  };

  it('API replies (and errors) allow nothing to load and no framing; no HSTS over plain HTTP', async () => {
    ({ app } = await createServer());
    for (const res of [await app.inject({ url: '/api/v1/health' }), await app.inject({ url: '/api/v1/projects' }), await app.inject({ url: '/api/v1/nope' })]) {
      expectCommonHeaders(res.headers);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it("the web app's page gets a policy for its own scripts and API and Google Fonts", async () => {
    webDir = mkdtempSync(path.join(tmpdir(), 'testify-web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Testify</title><div id="root"></div>');
    ({ app } = await createServer(undefined, { webDistDir: webDir }));
    const res = await app.inject({ url: '/reports/run' });
    expect(res.statusCode).toBe(200);
    expectCommonHeaders(res.headers);
    const csp = String(res.headers['content-security-policy']);
    for (const directive of ["default-src 'self'", "script-src 'self'", 'https://fonts.googleapis.com', 'font-src \'self\' https://fonts.gstatic.com', "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });

  it('the /docs page keeps its own policy', async () => {
    ({ app } = await createServer());
    const res = await app.inject({ url: '/docs' });
    expect(res.statusCode).toBe(200);
    expectCommonHeaders(res.headers);
    // @fastify/swagger-ui's own policy (staticCSP), not ours.
    expect(res.headers['content-security-policy']).toContain('validator.swagger.io');
  });

  it('HSTS is sent over HTTPS, as seen through a trusted proxy', async () => {
    previousTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    ({ app } = await createServer());
    const https = await app.inject({ url: '/api/v1/health', headers: { 'x-forwarded-proto': 'https' } });
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000');
    const http = await app.inject({ url: '/api/v1/health', headers: { 'x-forwarded-proto': 'http' } });
    expect(http.headers['strict-transport-security']).toBeUndefined();
  });
});
