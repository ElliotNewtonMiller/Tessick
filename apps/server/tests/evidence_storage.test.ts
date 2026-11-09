import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';
import { EvidenceRepository, EvidenceUploadRepository, TestRunRepository, createDbClient } from '@testify/db';
import { createServer } from '../src/server.js';
import { ConfigError, resolveEvidenceConfig } from '../src/config.js';
import { LocalStorageProvider, MemoryStorageProvider, newStorageKey } from '../src/storage/index.js';
import { spoolEvidence, EvidenceRefused } from '../src/storage/spool.js';
import { runStorageSweep } from '../src/services/storageSweeper.js';

/**
 * Evidence, phase 1: where files are kept (config, the local and memory providers), how an upload
 * is checked on its way in (the spool), and how files go when their rows do (the deletion queue,
 * its trigger, the sweeper), plus when a run closed (test_runs.closed_at).
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
const chunks = (...parts: Buffer[]) => Readable.from(parts);

describe('Evidence storage: configuration', () => {
  it('needs storage on a real database, and takes a directory or a bucket', () => {
    expect(resolveEvidenceConfig({ inMemory: true }, {}).storage).toEqual({ kind: 'memory' });
    expect(() => resolveEvidenceConfig({ inMemory: false }, {})).toThrow(/Evidence storage isn't set/);
    expect(() => resolveEvidenceConfig({ inMemory: false }, { EVIDENCE_STORAGE: 'memory' })).toThrow(/only for the in-memory database/);
    expect(resolveEvidenceConfig({ inMemory: false }, { EVIDENCE_DIR: '/data/evidence' })).toEqual({ storage: { kind: 'local', dir: '/data/evidence' }, maxFileBytes: 200 * 1024 * 1024 });
    expect(resolveEvidenceConfig({ inMemory: false }, { EVIDENCE_S3_BUCKET: 'qa', EVIDENCE_S3_REGION: 'eu-west-1', EVIDENCE_S3_PREFIX: '/testify/', EVIDENCE_S3_SSE: 'aws:kms' }).storage).toEqual({
      kind: 's3',
      bucket: 'qa',
      region: 'eu-west-1',
      endpoint: undefined,
      prefix: 'testify',
      forcePathStyle: false,
      sse: 'aws:kms',
    });
    expect(resolveEvidenceConfig({ inMemory: false }, { EVIDENCE_STORAGE: 's3', EVIDENCE_S3_BUCKET: 'qa', EVIDENCE_S3_ENDPOINT: 'http://minio:9000', EVIDENCE_S3_FORCE_PATH_STYLE: 'true' }).storage).toMatchObject({
      region: 'us-east-1',
      forcePathStyle: true,
    });
    for (const env of [{ EVIDENCE_STORAGE: 's3' }, { EVIDENCE_S3_BUCKET: 'qa' }, { EVIDENCE_STORAGE: 'ftp' }, { EVIDENCE_DIR: '/d', EVIDENCE_MAX_FILE_MB: '0' }, { EVIDENCE_S3_BUCKET: 'qa', EVIDENCE_S3_REGION: 'x', EVIDENCE_S3_SSE: 'yes' }]) {
      expect(() => resolveEvidenceConfig({ inMemory: false }, env), JSON.stringify(env)).toThrow(ConfigError);
    }
    expect(resolveEvidenceConfig({ inMemory: true }, { EVIDENCE_MAX_FILE_MB: '5' }).maxFileBytes).toBe(5 * 1024 * 1024);
  });

  it("a server whose evidence directory can't be written to won't start", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'testify-evidence-'));
    const blocked = join(dir, 'file');
    await writeFile(blocked, 'not a directory');
    const db = createDbClient();
    const previous = { JWT_SECRET: process.env.JWT_SECRET, EVIDENCE_DIR: process.env.EVIDENCE_DIR };
    process.env.JWT_SECRET = 'evidence-storage-test-secret-0123456789';
    process.env.EVIDENCE_DIR = blocked;
    try {
      await expect(createServer('postgres://unused/testify', { db })).rejects.toThrow(/EVIDENCE_DIR .* isn't a directory Testify can write to/);
    } finally {
      for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Evidence storage: the local provider and the spool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'testify-evidence-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores a checked file privately under its key, reads it whole or in part, and deletes it', async () => {
    const storage = new LocalStorageProvider(dir);
    await storage.check();
    const spooled = await spoolEvidence(chunks(PNG.subarray(0, 5), PNG.subarray(5)), { dir: storage.incomingDir, maxBytes: 1000 });
    expect(spooled).toMatchObject({ size: PNG.length, type: { kind: 'image', media_type: 'image/png' } });
    const key = newStorageKey(uuidv7());
    await storage.putFile(key, spooled.path, { size: spooled.size, mediaType: 'image/png', sha256: spooled.sha256 });
    const path = join(dir, ...key.split('/'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(storage.incomingDir)).toEqual([]);
    const read = async (range?: { start: number; end: number }) => Buffer.concat(await (await storage.read(key, range)).toArray());
    expect((await read()).equals(PNG)).toBe(true);
    expect((await read({ start: 1, end: 3 })).toString('latin1')).toBe('PNG');
    expect(await storage.head(key)).toEqual({ size: PNG.length });
    await storage.delete(key);
    await storage.delete(key); // gone already: fine
    expect(await storage.head(key)).toBeUndefined();
    // Only keys Testify makes name a file.
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/Not a storage key/);
  });

  it('refuses a file of the wrong kind, too big, or not matching its checksum, leaving nothing behind', async () => {
    const spoolDir = join(dir, 'spool');
    const refusal = async (source: Readable, opts: { maxBytes?: number; expectedSha256?: string; expectedSize?: number } = {}) => {
      try {
        await spoolEvidence(source, { dir: spoolDir, maxBytes: opts.maxBytes ?? 1000, ...opts });
      } catch (err) {
        expect(err).toBeInstanceOf(EvidenceRefused);
        return [(err as EvidenceRefused).status, (err as EvidenceRefused).code, (err as EvidenceRefused).extra];
      }
      throw new Error('not refused');
    };
    expect(await refusal(chunks(Buffer.from('<svg><script>alert(1)</script></svg>'), Buffer.from([0, 0])))).toEqual([415, 'EVIDENCE_TYPE_REFUSED', {}]);
    expect(await refusal(chunks(PNG, PNG), { maxBytes: 150 })).toEqual([413, 'EVIDENCE_TOO_LARGE', { limit_bytes: 150 }]);
    expect(await refusal(chunks(PNG), { expectedSha256: 'a'.repeat(64) })).toEqual([400, 'CHECKSUM_MISMATCH', {}]);
    expect(await refusal(chunks(PNG), { expectedSize: 3 })).toEqual([400, 'SIZE_MISMATCH', {}]);
    // A log that turns binary after the part that was sniffed.
    expect(await refusal(chunks(Buffer.alloc(70_000, 'a'), Buffer.from([0x00])), { maxBytes: 100_000 })).toEqual([415, 'EVIDENCE_TYPE_REFUSED', {}]);
    expect(await readdir(spoolDir)).toEqual([]);
    const log = await spoolEvidence(chunks(Buffer.from('step 1 ok\n'), Buffer.from('step 2 ok\n')), { dir: spoolDir, maxBytes: 1000 });
    expect([log.type.kind, log.size, log.sha256]).toEqual(['log', 20, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    await log.discard();
  });

  it("can't be read by others: a file is 0600 in 0700 directories", async () => {
    const storage = new LocalStorageProvider(dir);
    await storage.check();
    expect((await stat(storage.incomingDir)).mode & 0o777).toBe(0o700);
    await chmod(storage.incomingDir, 0o700);
  });
});

describe('Evidence storage: files go with their rows', () => {
  let app: any;
  let db: any;
  let seed: any;
  let storage: MemoryStorageProvider;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    ({ app, db, seed } = await createServer(undefined, { evidence: { storage } }));
  });
  afterEach(async () => {
    await app.close();
  });

  /** A result for the seed's first case, and a stored evidence file for it. */
  async function evidenceFile() {
    const admin = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results/batch`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { results: [{ case_identifier: { by_uuid: seed.caseIds[0] }, verdict: 'FAILED' }] },
    });
    const resultId = JSON.parse(res.payload).results[0].test_result_id;
    const result = await db.selectFrom('test_results').selectAll().where('id', '=', resultId).executeTakeFirst();
    const spooled = await spoolEvidence(chunks(PNG), { dir: join(tmpdir(), 'testify-evidence'), maxBytes: 1000 });
    const key = newStorageKey(seed.projectId);
    await storage.putFile(key, spooled.path);
    const evidence = await new EvidenceRepository(db).create({
      id: uuidv7(),
      project_id: seed.projectId,
      test_run_id: seed.buildId,
      test_plan_case_id: result.test_plan_case_id,
      test_result_id: resultId,
      kind: 'image',
      media_type: 'image/png',
      filename: 'shot.png',
      description: null,
      size_bytes: spooled.size,
      sha256: spooled.sha256,
      storage_key: key,
      uploaded_by: 'someone',
      actor_type: 'USER',
      uploaded_via: 'API',
      after_close: false,
      created_at: new Date().toISOString(),
    });
    return { evidence, key, resultId };
  }

  it('deleting a run (with force) queues its files, and the sweeper removes them', async () => {
    const { key } = await evidenceFile();
    expect(storage.files.has(key)).toBe(true);
    const deleted = await new TestRunRepository(db).deleteWithForce(seed.buildId, { force: true });
    expect(deleted).toMatchObject({ deleted: true });
    expect(await db.selectFrom('evidence').select('id').execute()).toEqual([]);
    expect((await db.selectFrom('storage_deletions').select('storage_key').execute()).map((r: any) => r.storage_key)).toEqual([key]);
    expect(storage.files.has(key)).toBe(true); // not before the sweep
    expect(await runStorageSweep(db, storage)).toEqual({ deleted: 1, failed: 0, expiredUploads: 0 });
    expect(storage.files.has(key)).toBe(false);
    expect(await db.selectFrom('storage_deletions').selectAll().execute()).toEqual([]);
  });

  it('keeps a failed deletion to retry, and removes expired upload links with their files', async () => {
    const { evidence, resultId } = await evidenceFile();
    const failing = Object.assign(Object.create(storage), { delete: async () => { throw new Error('bucket unreachable'); } });
    await new EvidenceRepository(db).delete(evidence.id);
    expect(await runStorageSweep(db, failing)).toMatchObject({ deleted: 0, failed: 1 });
    expect(await db.selectFrom('storage_deletions').select(['attempts', 'last_error']).execute()).toEqual([{ attempts: 1, last_error: 'bucket unreachable' }]);
    expect(await runStorageSweep(db, storage)).toMatchObject({ deleted: 1 });

    const result = await db.selectFrom('test_results').selectAll().where('id', '=', resultId).executeTakeFirst();
    const key = newStorageKey(seed.projectId);
    const now = new Date();
    await new EvidenceUploadRepository(db).create({
      id: uuidv7(),
      token_hash: 'f'.repeat(64),
      project_id: seed.projectId,
      test_run_id: seed.buildId,
      test_plan_case_id: result.test_plan_case_id,
      test_result_id: resultId,
      created_by: 'someone',
      actor_type: 'USER',
      created_via: 'API',
      filename: 'big.webm',
      description: null,
      size_bytes: 10,
      sha256: 'a'.repeat(64),
      storage_key: key,
      status: 'receiving',
      evidence_id: null,
      expires_at: new Date(now.getTime() - 1000).toISOString(),
      created_at: now.toISOString(),
    });
    storage.files.set(key, Buffer.from('half an upload'));
    expect(await runStorageSweep(db, storage, now)).toEqual({ deleted: 1, failed: 0, expiredUploads: 1 });
    expect(storage.files.has(key)).toBe(false);
    expect(await db.selectFrom('evidence_uploads').selectAll().execute()).toEqual([]);
  });

  it('records when a run closes, however it closes, and forgets it when it reopens', async () => {
    const runs = new TestRunRepository(db);
    expect((await runs.findById(seed.buildId))!.closed_at).toBeNull();
    await runs.updateStatus(seed.buildId, 'CLOSED');
    const closed = (await runs.findById(seed.buildId))!.closed_at;
    expect(Date.now() - Date.parse(closed!)).toBeLessThan(60_000);
    await db.updateTable('test_runs').set({ name: 'renamed' }).where('id', '=', seed.buildId).execute();
    expect((await runs.findById(seed.buildId))!.closed_at).toBe(closed);
    await runs.updateStatus(seed.buildId, 'OPEN');
    expect((await runs.findById(seed.buildId))!.closed_at).toBeNull();
  });
});
