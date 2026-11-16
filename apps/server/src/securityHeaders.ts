import type { FastifyInstance } from 'fastify';

/**
 * Browser security headers on every reply.
 * - The web app's page gets a Content-Security-Policy that allows only its own scripts, its own
 *   API, and Google Fonts (index.html's stylesheet). Styles may be inline: index.html has a
 *   <style> block and React sets style attributes. Every other reply (JSON, files) gets one that
 *   allows nothing to load. A reply that already has a policy keeps it (the /docs page sets its
 *   own, @fastify/swagger-ui's `staticCSP`).
 * - No other site may show Tessick in a frame (clickjacking): `frame-ancestors 'none'` and
 *   X-Frame-Options.
 * - Strict-Transport-Security only on replies sent over HTTPS (seen through the proxy's
 *   X-Forwarded-Proto when TRUST_PROXY=true): browsers then refuse plain HTTP to Tessick for a
 *   year. Subdomains are left alone, since they may be other services.
 */
const WEB_APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const NOTHING_CSP = "default-src 'none'; frame-ancestors 'none'";

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (!reply.hasHeader('Content-Security-Policy')) {
      const isPage = String(reply.getHeader('Content-Type') ?? '').startsWith('text/html');
      reply.header('Content-Security-Policy', isPage ? WEB_APP_CSP : NOTHING_CSP);
    }
    if (request.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}
