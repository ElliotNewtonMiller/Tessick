import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePasswordPolicy } from '@testify/core';
import { SecretBox } from './services/secrets.js';

/**
 * Where the server keeps its data, read from DATABASE_URL at startup. There's deliberately no
 * silent default: a missing DATABASE_URL used to fall back to a throwaway in-memory database,
 * so a deployment that forgot to set it looked fine and then lost everything on its first
 * restart.
 *
 * - `postgres://...` / `postgresql://...`: a real PostgreSQL server.
 * - `memory`: a throwaway in-memory database (PGlite). Development only -- all data is lost
 *   when the server stops. `npm run dev` uses it when DATABASE_URL isn't set.
 */
export interface DatabaseConfig {
  /** The PostgreSQL connection string, or undefined for the in-memory database. */
  connectionString: string | undefined;
  inMemory: boolean;
}

export const IN_MEMORY_DATABASE_URL = 'memory';

export class ConfigError extends Error {}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new ConfigError(
      'DATABASE_URL is not set. Set it to your PostgreSQL connection string, ' +
        'e.g. DATABASE_URL=postgres://user:password@localhost:5432/testify. ' +
        `For a throwaway in-memory database (development only; all data is lost when the server stops), set DATABASE_URL=${IN_MEMORY_DATABASE_URL}.`
    );
  }
  if (url === IN_MEMORY_DATABASE_URL) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigError(
        `DATABASE_URL=${IN_MEMORY_DATABASE_URL} isn't allowed when NODE_ENV=production: all data would be lost when the server stops. ` +
          'Set DATABASE_URL to your PostgreSQL connection string.'
      );
    }
    return { connectionString: undefined, inMemory: true };
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new ConfigError(
      'DATABASE_URL must be a PostgreSQL connection string starting with postgres:// or postgresql:// ' +
        `(or "${IN_MEMORY_DATABASE_URL}" for a throwaway in-memory database in development).`
    );
  }
  return { connectionString: url, inMemory: false };
}

/**
 * The password for the first admin user (username `admin`), created only when the database has
 * no users at all. There's no built-in default for a real database:
 *
 * - `ADMIN_PASSWORD` set: that password (it must meet the password policy). Not forced to change.
 * - In-memory database (development/tests): `password`. That data is thrown away anyway.
 * - Otherwise: a random password, printed once at startup, which must be changed at first sign-in.
 */
export interface InitialAdminPassword {
  password: string;
  mustChangePassword: boolean;
  source: 'env' | 'in_memory_default' | 'generated';
}

export function resolveInitialAdminPassword(
  { inMemory }: { inMemory: boolean },
  env: NodeJS.ProcessEnv = process.env
): InitialAdminPassword {
  const fromEnv = env.ADMIN_PASSWORD;
  if (fromEnv) {
    const check = validatePasswordPolicy(fromEnv);
    if (!check.valid) throw new ConfigError(`ADMIN_PASSWORD doesn't meet the password policy: ${check.reason}`);
    return { password: fromEnv, mustChangePassword: false, source: 'env' };
  }
  if (inMemory) return { password: 'password', mustChangePassword: false, source: 'in_memory_default' };
  // 24 characters: long enough that the policy needs no particular character types.
  return { password: randomBytes(18).toString('base64url'), mustChangePassword: true, source: 'generated' };
}

/**
 * Which other web origins may call the API from a browser (CORS), from CORS_ORIGINS: a
 * comma-separated list of exact origins, e.g. "https://testify.example.com". Unset means none --
 * the web app calls the API on its own address (Vite's proxy in development), so it needs no CORS,
 * and neither do API tokens, CI or MCP clients, which aren't browsers. Set it only when the web
 * app is served from a different address than the API. "*" is refused: any page could then read
 * API responses with a token it got hold of.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === '*') {
      throw new ConfigError('CORS_ORIGINS="*" isn\'t allowed: list the exact origins the web app is served from, e.g. CORS_ORIGINS=https://testify.example.com');
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`CORS_ORIGINS: "${entry}" isn't a valid origin. Use e.g. https://testify.example.com`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry.replace(/\/$/, '')) {
      throw new ConfigError(`CORS_ORIGINS: "${entry}" must be just a scheme, host and optional port (no path), e.g. https://testify.example.com`);
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}

/**
 * The key for secrets stored in the database (the SMTP password), from SECRETS_KEY: any string
 * of at least 32 characters, e.g. `openssl rand -hex 32`. Keep it out of the database and the
 * same across restarts and instances -- if it changes, stored secrets must be entered again.
 *
 * - Set: used to encrypt and decrypt.
 * - Unset, in-memory database: a random key for this process (that data is thrown away anyway).
 * - Unset, real database: null -- nothing secret can be stored (saving an SMTP password is refused).
 */
export function resolveSecretsKey({ inMemory }: { inMemory: boolean }, env: NodeJS.ProcessEnv = process.env): SecretBox | null {
  const secret = env.SECRETS_KEY;
  if (secret) {
    if (secret.length < 32) {
      throw new ConfigError('SECRETS_KEY must be at least 32 characters long (e.g. the output of `openssl rand -hex 32`).');
    }
    return SecretBox.fromSecret(secret);
  }
  return inMemory ? SecretBox.ephemeral() : null;
}

/** apps/web/dist: the same place whether this runs from src/ (tsx) or the dist/ bundle. */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/**
 * The built web app for the server to serve alongside the API (`npm run build` makes it).
 * WEB_DIST_DIR points elsewhere and must hold an index.html. Unset, the default location is
 * used if a build is there; otherwise the server serves only the API (in development the web
 * app comes from Vite's dev server instead).
 */
export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env, defaultDir = DEFAULT_WEB_DIST_DIR): string | null {
  const dir = env.WEB_DIST_DIR?.trim();
  if (dir) {
    if (!existsSync(join(dir, 'index.html'))) {
      throw new ConfigError(`WEB_DIST_DIR (${dir}) has no index.html. Point it at the web app's build folder (apps/web/dist after \`npm run build\`).`);
    }
    return dir;
  }
  return existsSync(join(defaultDir, 'index.html')) ? defaultDir : null;
}

/**
 * The secret that signs sign-in tokens (JWT_SECRET): at least 32 characters, e.g.
 * `openssl rand -hex 32`. Every server instance must share it, and it must stay the same
 * across restarts, or everyone is signed out.
 *
 * - Set: used as is.
 * - Unset, in-memory database: a random secret for this process (that data, sessions included,
 *   is thrown away anyway).
 * - Unset, real database: refused. A per-process secret would sign everyone out on every restart
 *   and make several instances reject each other's sign-ins.
 */
export function resolveJwtSecret({ inMemory }: { inMemory: boolean }, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (secret) {
    if (secret.length < 32) {
      throw new ConfigError('JWT_SECRET must be at least 32 characters long (e.g. the output of `openssl rand -hex 32`).');
    }
    return secret;
  }
  if (inMemory) return randomBytes(32).toString('hex');
  throw new ConfigError(
    'JWT_SECRET is not set. Set it to a random string of at least 32 characters (e.g. the output of `openssl rand -hex 32`), ' +
      'the same on every server instance and across restarts -- it signs everyone\'s sign-ins.'
  );
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * How much the server logs (LOG_LEVEL): one JSON line per request at `info` (the default), plus
 * unexpected errors at `error`. `warn` or `error` keeps only problems; `silent` turns it off.
 * The test suite is silent unless LOG_LEVEL is set.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV === 'test' ? 'silent' : 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${env.LOG_LEVEL}").`);
  }
  return raw as LogLevel;
}

/**
 * WEBHOOK_ALLOW_LOCAL=true lets webhooks reach loopback and link-local addresses (localhost,
 * 127.0.0.1, 169.254.x.x), which are refused otherwise (services/webhookTargets.ts). For a
 * receiver on the same machine; `npm run dev` turns it on.
 */
export function resolveWebhookAllowLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WEBHOOK_ALLOW_LOCAL?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new ConfigError(`WEBHOOK_ALLOW_LOCAL must be true or false (got "${env.WEBHOOK_ALLOW_LOCAL}").`);
}

/**
 * Where evidence files are stored (storage/; docs/deployment.md), and how big one may be.
 *
 * - `EVIDENCE_STORAGE=local` with `EVIDENCE_DIR`: a directory (Docker Compose mounts a volume).
 * - `EVIDENCE_STORAGE=s3` with `EVIDENCE_S3_BUCKET` (and `EVIDENCE_S3_REGION`, or
 *   `EVIDENCE_S3_ENDPOINT` for MinIO, R2 and the like): a bucket. Credentials come from AWS's own
 *   variables or an IAM role. `EVIDENCE_S3_PREFIX` puts the files under a prefix,
 *   `EVIDENCE_S3_FORCE_PATH_STYLE=true` suits most S3-compatible servers, and `EVIDENCE_S3_SSE`
 *   (AES256 or aws:kms) asks for server-side encryption.
 * - `memory`: only with the in-memory database, where it's the default.
 *
 * Unset, EVIDENCE_DIR or EVIDENCE_S3_BUCKET picks the kind. A real database needs one of them:
 * there's no silent default that would lose files (as DATABASE_URL has none).
 * `EVIDENCE_MAX_FILE_MB` (default 200) caps one file.
 */
export type EvidenceStorageConfig =
  | { kind: 'memory' }
  | { kind: 'local'; dir: string }
  | { kind: 's3'; bucket: string; region: string; endpoint?: string; prefix: string; forcePathStyle: boolean; sse?: 'AES256' | 'aws:kms' };

export interface EvidenceConfig {
  storage: EvidenceStorageConfig;
  maxFileBytes: number;
}

export const DEFAULT_EVIDENCE_MAX_FILE_MB = 200;

export function resolveEvidenceConfig({ inMemory }: { inMemory: boolean }, env: NodeJS.ProcessEnv = process.env): EvidenceConfig {
  const rawMb = env.EVIDENCE_MAX_FILE_MB?.trim();
  let maxMb = DEFAULT_EVIDENCE_MAX_FILE_MB;
  if (rawMb) {
    maxMb = Number(rawMb);
    if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 5120) {
      throw new ConfigError(`EVIDENCE_MAX_FILE_MB must be a whole number of megabytes from 1 to 5120 (got "${env.EVIDENCE_MAX_FILE_MB}").`);
    }
  }
  const maxFileBytes = maxMb * 1024 * 1024;

  const dir = env.EVIDENCE_DIR?.trim();
  const bucket = env.EVIDENCE_S3_BUCKET?.trim();
  const kind = env.EVIDENCE_STORAGE?.trim().toLowerCase() || (dir ? 'local' : bucket ? 's3' : inMemory ? 'memory' : '');
  const howTo =
    'Set EVIDENCE_DIR to a directory Testify can write to (EVIDENCE_STORAGE=local), or EVIDENCE_STORAGE=s3 with EVIDENCE_S3_BUCKET and EVIDENCE_S3_REGION (see docs/deployment.md).';
  switch (kind) {
    case 'memory':
      if (!inMemory) throw new ConfigError(`EVIDENCE_STORAGE=memory is only for the in-memory database: evidence files would be lost when the server stops. ${howTo}`);
      return { storage: { kind: 'memory' }, maxFileBytes };
    case 'local':
      if (!dir) throw new ConfigError(`EVIDENCE_STORAGE=local needs EVIDENCE_DIR. ${howTo}`);
      return { storage: { kind: 'local', dir }, maxFileBytes };
    case 's3': {
      if (!bucket) throw new ConfigError(`EVIDENCE_STORAGE=s3 needs EVIDENCE_S3_BUCKET. ${howTo}`);
      const endpoint = env.EVIDENCE_S3_ENDPOINT?.trim() || undefined;
      const region = env.EVIDENCE_S3_REGION?.trim() || (endpoint ? 'us-east-1' : '');
      if (!region) throw new ConfigError('EVIDENCE_STORAGE=s3 needs EVIDENCE_S3_REGION (or EVIDENCE_S3_ENDPOINT for an S3-compatible server).');
      if (endpoint && !/^https?:\/\//i.test(endpoint)) throw new ConfigError(`EVIDENCE_S3_ENDPOINT must be an http(s) URL (got "${endpoint}").`);
      const sse = env.EVIDENCE_S3_SSE?.trim();
      if (sse && sse !== 'AES256' && sse !== 'aws:kms') throw new ConfigError(`EVIDENCE_S3_SSE must be AES256 or aws:kms (got "${sse}").`);
      const pathStyle = env.EVIDENCE_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
      if (pathStyle && pathStyle !== 'true' && pathStyle !== 'false') throw new ConfigError(`EVIDENCE_S3_FORCE_PATH_STYLE must be true or false (got "${pathStyle}").`);
      const prefix = (env.EVIDENCE_S3_PREFIX?.trim() ?? '').replace(/^\/+|\/+$/g, '');
      return {
        storage: { kind: 's3', bucket, region, endpoint, prefix, forcePathStyle: pathStyle === 'true', ...(sse ? { sse: sse as 'AES256' | 'aws:kms' } : {}) },
        maxFileBytes,
      };
    }
    case '':
      throw new ConfigError(`Evidence storage isn't set. ${howTo}`);
    default:
      throw new ConfigError(`EVIDENCE_STORAGE must be local, s3 or memory (got "${env.EVIDENCE_STORAGE}").`);
  }
}
