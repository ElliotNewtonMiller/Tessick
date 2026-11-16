import type { Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';

/**
 * Where evidence files are kept (docs/rfc_03_api_and_xml_contracts.md §5): a directory
 * (LocalStorageProvider), an S3-compatible bucket (S3StorageProvider), or memory for the
 * in-memory database and tests (MemoryStorageProvider). The database keeps each file's key,
 * type, size and SHA-256; storage keeps only the bytes, under keys Tessick makes.
 */
export interface StorageProvider {
  readonly name: 'local' | 's3' | 'memory';
  /** Stores a file already checked and spooled to `path` (spool.ts), under `key`. */
  putFile(key: string, path: string, opts: { size: number; mediaType: string; sha256: string }): Promise<void>;
  /** The file's bytes, or one range of them (inclusive). */
  read(key: string, range?: { start: number; end: number }): Promise<Readable>;
  /** The stored size, or undefined when there's no such file. */
  head(key: string): Promise<{ size: number } | undefined>;
  /** Removes the file; a missing one isn't an error. */
  delete(key: string): Promise<void>;
  /**
   * A URL a client can PUT the file to directly (S3), enforcing its length and checksum.
   * Providers without it receive uploads through Tessick's own upload links.
   */
  presignPut?(key: string, opts: { size: number; sha256: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  /** Startup check: the directory is writable, or the bucket reachable. Throws a message to show. */
  check(): Promise<void>;
}

/** A new file's key: generated, never from input (`evidence/<project>/<yyyy>/<mm>/<uuid>`). */
export function newStorageKey(projectId: string, now = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `evidence/${projectId}/${now.getUTCFullYear()}/${month}/${uuidv7()}`;
}

/** The keys this server makes; anything else is refused before it can name a path or object. */
export const STORAGE_KEY_PATTERN = /^evidence\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/;

export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error(`Not a storage key: ${key}`);
}
