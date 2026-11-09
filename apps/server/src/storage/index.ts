import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceStorageConfig } from '../config.js';
import { LocalStorageProvider } from './local.js';
import { MemoryStorageProvider } from './memory.js';
import type { StorageProvider } from './provider.js';

export * from './provider.js';
export { LocalStorageProvider } from './local.js';
export { MemoryStorageProvider } from './memory.js';

/** The configured storage, and where its uploads are spooled while they're checked. */
export async function createStorage(config: EvidenceStorageConfig): Promise<{ storage: StorageProvider; spoolDir: string }> {
  if (config.kind === 'local') {
    const storage = new LocalStorageProvider(config.dir);
    return { storage, spoolDir: storage.incomingDir };
  }
  if (config.kind === 's3') {
    const { S3StorageProvider } = await import('./s3.js');
    return { storage: new S3StorageProvider(config), spoolDir: join(tmpdir(), 'testify-evidence') };
  }
  return { storage: new MemoryStorageProvider(), spoolDir: join(tmpdir(), 'testify-evidence') };
}

/** What the evidence routes need: the storage, the spool, the file size limit, and the clock. */
export interface EvidenceContext {
  storage: StorageProvider;
  spoolDir: string;
  maxFileBytes: number;
  /** Tests move it to check the 24-hour window after a run closes. */
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    evidence: EvidenceContext;
  }
}
