import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { EvidenceStorageConfig } from '../config.js';
import { assertStorageKey, type StorageProvider } from './provider.js';

type S3Config = Extract<EvidenceStorageConfig, { kind: 's3' }>;

/** A SHA-256 in hex as S3 wants it: base64 of the bytes. */
const base64Sha256 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/**
 * Evidence files in an S3 bucket, or an S3-compatible one (MinIO, Cloudflare R2, ...): one object
 * per key, under EVIDENCE_S3_PREFIX. Credentials come from AWS's usual chain (environment, shared
 * files, an IAM role). Every object is written with its SHA-256, so S3 refuses a file changed on
 * the way, and with server-side encryption when EVIDENCE_S3_SSE asks for it.
 *
 * Large files can go straight to the bucket: `presignPut` signs a PUT for one object of an exact
 * length and SHA-256 (the checksum is a signed header, so S3 enforces it), valid for the link's
 * lifetime. Reads always go through Testify, so permissions are checked on each.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  private client: S3Client;

  constructor(
    private config: S3Config,
    /** Tests: credentials and the like. */
    clientOptions: Partial<S3ClientConfig> = {}
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      // Only the checksums Testify asks for: the SDK's default CRC32 on every request would also
      // be signed into presigned URLs, which then fail for the file sent to them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...clientOptions,
    });
  }

  private objectKey(key: string): string {
    assertStorageKey(key);
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }

  private encryption() {
    return this.config.sse ? { ServerSideEncryption: this.config.sse } : {};
  }

  async putFile(key: string, path: string, opts: { size: number; mediaType: string; sha256: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(key),
        Body: createReadStream(path),
        ContentLength: opts.size,
        ContentType: opts.mediaType,
        ChecksumSHA256: base64Sha256(opts.sha256),
        ...this.encryption(),
      })
    );
    await unlink(path).catch(() => undefined);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) })
      );
      return out.Body as Readable;
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) throw Object.assign(new Error(`No such file: ${key}`), { code: 'ENOENT' });
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number } | undefined> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key) }));
      return { size: Number(out.ContentLength ?? 0) };
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // Deleting an object that isn't there succeeds in S3.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key) }));
  }

  async presignPut(key: string, opts: { size: number; sha256: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }> {
    const checksum = base64Sha256(opts.sha256);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(key), ContentLength: opts.size, ChecksumSHA256: checksum, ...this.encryption() }),
      {
        expiresIn: opts.expiresInSeconds,
        // Signed headers the client must send as they are, so S3 checks the file against them.
        unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm', ...(this.config.sse ? ['x-amz-server-side-encryption'] : [])]),
      }
    );
    return {
      url,
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-checksum-sha256': checksum,
        'x-amz-sdk-checksum-algorithm': 'SHA256',
        ...(this.config.sse ? { 'x-amz-server-side-encryption': this.config.sse } : {}),
      },
    };
  }

  async check(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      throw new Error(
        `The evidence bucket ${this.config.bucket} can't be reached${status ? ` (HTTP ${status})` : ''}: ${err?.name ?? ''} ${err?.message ?? err}. Check EVIDENCE_S3_* and the AWS credentials.`.trim()
      );
    }
  }
}
