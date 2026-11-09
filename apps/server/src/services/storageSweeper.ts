import type { Kysely } from 'kysely';
import { EvidenceUploadRepository, StorageDeletionRepository, type Database } from '@testify/db';
import type { StorageProvider } from '../storage/provider.js';

/**
 * Removes evidence files from storage once their rows are gone. Deleting an evidence row (by
 * itself, or with its result, run, plan case or project) queues its file in storage_deletions
 * (a trigger, migration 018), so files are deleted only after the delete committed, whichever
 * route did it. A failed deletion is kept and retried. Upload links past their expiry go too,
 * with any file they received.
 *
 * Run at startup and every minute (server.ts); tests call it directly.
 */
export async function runStorageSweep(db: Kysely<Database>, storage: StorageProvider, now = new Date()): Promise<{ deleted: number; failed: number; expiredUploads: number }> {
  const deletions = new StorageDeletionRepository(db);
  const uploads = new EvidenceUploadRepository(db);
  let expiredUploads = 0;
  for (const upload of await uploads.expired(now.toISOString())) {
    // Even a pending one: with S3 the client may have put the file in the bucket directly.
    await deletions.queue(upload.storage_key);
    await uploads.delete(upload.id);
    expiredUploads++;
  }
  let deleted = 0;
  let failed = 0;
  for (const { storage_key } of await deletions.due()) {
    try {
      await storage.delete(storage_key);
      await deletions.done(storage_key);
      deleted++;
    } catch (err: any) {
      await deletions.failed(storage_key, String(err?.message ?? err));
      failed++;
    }
  }
  return { deleted, failed, expiredUploads };
}
