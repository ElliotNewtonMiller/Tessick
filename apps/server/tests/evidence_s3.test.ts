import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';
import { createServer } from '../src/server.js';
import { S3StorageProvider } from '../src/storage/s3.js';
import { newStorageKey } from '../src/storage/provider.js';
import { spoolEvidence } from '../src/storage/spool.js';
import { runStorageSweep } from '../src/services/storageSweeper.js';
import { startFakeS3, type FakeS3 } from './fakeS3.js';

/**
 * Evidence, phase 3: S3 storage. The provider against an in-process S3 (fakeS3.ts), then the
 * routes on top of it: uploads through Testify, and presigned uploads straight to the bucket,
 * completed and checked.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 3)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const credentials = { accessKeyId: 'test', secretAccessKey: 'test-secret' };

describe('Evidence storage: S3', () => {
  let s3: FakeS3;
  let provider: S3StorageProvider;
  beforeEach(async () => {
    s3 = await startFakeS3('evidence');
    provider = new S3StorageProvider(
      { kind: 's3', bucket: 'evidence', region: 'us-east-1', endpoint: s3.endpoint, prefix: 'testify', forcePathStyle: true, sse: 'AES256' },
      { credentials }
    );
  });
  afterEach(async () => {
    await s3.close();
  });

  it('stores an object with its checksum and encryption, reads it whole or in part, and deletes it', async () => {
    await provider.check();
    const spooled = await spoolEvidence(Readable.from([PNG]), { dir: join(tmpdir(), 'testify-evidence'), maxBytes: 10_000 });
    const key = newStorageKey(uuidv7());
    await provider.putFile(key, spooled.path, { size: spooled.size, mediaType: 'image/png', sha256: spooled.sha256 });
    const stored = s3.objects.get(`testify/${key}`);
    expect(stored).toMatchObject({ contentType: 'image/png', sse: 'AES256' });
    expect(stored!.body.equals(PNG)).toBe(true);
    const read = async (range?: { start: number; end: number }) => Buffer.concat(await (await provider.read(key, range)).toArray());
    expect((await read()).equals(PNG)).toBe(true);
    expect((await read({ start: 1, end: 3 })).toString('latin1')).toBe('PNG');
    expect(await provider.head(key)).toEqual({ size: PNG.length });
    await provider.delete(key);
    expect(await provider.head(key)).toBeUndefined();
    await expect(provider.read(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('signs a PUT that the bucket checks against the file it was made for', async () => {
    const key = newStorageKey(uuidv7());
    const link = await provider.presignPut(key, { size: PNG.length, sha256: sha(PNG), expiresInSeconds: 900 });
    expect(link.url).toMatch(new RegExp(`^${s3.endpoint}/evidence/testify/evidence/`));
    expect(link.url).toMatch(/X-Amz-Signature=/);
    expect(link.url).not.toMatch(/x-amz-checksum-crc32/i);
    expect(link.headers).toMatchObject({ 'x-amz-checksum-sha256': Buffer.from(sha(PNG), 'hex').toString('base64') });
    const wrong = await fetch(link.url, { method: 'PUT', headers: link.headers, body: Buffer.concat([PNG, Buffer.from([9])]) });
    expect(wrong.status).toBe(400);
    const ok = await fetch(link.url, { method: 'PUT', headers: link.headers, body: PNG });
    expect(ok.status).toBe(200);
    expect(s3.objects.get(`testify/${key}`)!.body.equals(PNG)).toBe(true);
  });

  it("refuses to start without its bucket", async () => {
    const missing = new S3StorageProvider({ kind: 's3', bucket: 'nope', region: 'us-east-1', endpoint: s3.endpoint, prefix: '', forcePathStyle: true }, { credentials });
    await expect(missing.check()).rejects.toThrow(/The evidence bucket nope can't be reached \(HTTP 404\)/);
  });
});

describe('Evidence API on S3', () => {
  let s3: FakeS3;
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const auth = { authorization: '' };

  beforeEach(async () => {
    s3 = await startFakeS3('evidence');
    const storage = new S3StorageProvider({ kind: 's3', bucket: 'evidence', region: 'us-east-1', endpoint: s3.endpoint, prefix: '', forcePathStyle: true }, { credentials });
    ({ app, db, seed } = await createServer(undefined, { evidence: { storage, maxFileBytes: 100_000 } }));
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    auth.authorization = `Bearer ${admin}`;
    await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results/batch`, headers: auth, payload: { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'FAILED' }] } });
  });
  afterEach(async () => {
    await app.close();
    await s3.close();
  });

  const execUrl = () => `/api/v1/runs/${seed.buildId}/cases/SHOP-101/evidence`;
  const makeLink = async (size: number, digest: string, filename = 'big.png') =>
    body(await app.inject({ method: 'POST', url: `${execUrl()}/uploads`, headers: auth, payload: { filename, size_bytes: size, sha256: digest } })).upload;

  it('uploads through Testify into the bucket, and serves them back from it', async () => {
    const res = await app.inject({ method: 'POST', url: `${execUrl()}?filename=shot.png`, headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: PNG });
    expect(res.statusCode, res.payload).toBe(201);
    const item = body(res).evidence[0];
    expect(s3.objects.size).toBe(1);
    const part = await app.inject({ method: 'GET', url: item.content_url, headers: { ...auth, range: 'bytes=1-3' } });
    expect([part.statusCode, part.payload, part.headers['content-type']]).toEqual([206, 'PNG', 'image/png']);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/evidence/${item.id}`, headers: auth })).statusCode).toBe(204);
    await runStorageSweep(db, app.evidence.storage);
    expect(s3.objects.size).toBe(0);
  });

  it('a presigned upload: PUT straight to the bucket, then completed and checked by Testify', async () => {
    const link = await makeLink(PNG.length, sha(PNG));
    expect(link.url).toMatch(new RegExp(`^${s3.endpoint}/evidence/evidence/`));
    // Not uploaded yet.
    const early = await app.inject({ method: 'POST', url: link.complete_url, headers: auth });
    expect([early.statusCode, body(early).code]).toEqual([409, 'NOT_UPLOADED']);
    expect((await fetch(link.url, { method: 'PUT', headers: link.headers, body: PNG })).status).toBe(200);
    const done = await app.inject({ method: 'POST', url: link.complete_url, headers: auth });
    expect([done.statusCode, body(done).evidence.kind, body(done).evidence.filename, body(done).evidence.sha256]).toEqual([201, 'image', 'big.png', sha(PNG)]);
    // Completing again answers the same evidence.
    expect(body(await app.inject({ method: 'POST', url: link.complete_url, headers: auth })).evidence.id).toBe(body(done).evidence.id);
    const content = await app.inject({ method: 'GET', url: body(done).evidence.content_url, headers: auth });
    expect(content.rawPayload.equals(PNG)).toBe(true);
  });

  it("a presigned upload that isn't evidence Testify accepts is refused, and removed from the bucket", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\u0000');
    const link = await makeLink(svg.length, sha(svg), 'evil.png');
    expect((await fetch(link.url, { method: 'PUT', headers: link.headers, body: svg })).status).toBe(200);
    expect(s3.objects.size).toBe(1);
    const refused = await app.inject({ method: 'POST', url: link.complete_url, headers: auth });
    expect([refused.statusCode, body(refused).code]).toEqual([415, 'EVIDENCE_TYPE_REFUSED']);
    expect(s3.objects.size).toBe(0);
    expect(await db.selectFrom('evidence').select('id').execute()).toEqual([]);
  });
});
