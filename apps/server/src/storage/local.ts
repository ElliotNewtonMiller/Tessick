import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { assertStorageKey, type StorageProvider } from './provider.js';

/**
 * Evidence files in a directory (EVIDENCE_DIR), one file per key. Directories are made 0700 and
 * files 0600, so only Testify's own user reads them. Keys are checked against the pattern Testify
 * makes, so no key can name a path outside the directory. A file arrives complete: it's moved
 * from the spool (on the same disk when possible, `incomingDir`) into place by a rename.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;

  constructor(private root: string) {}

  /** Where uploads are spooled: inside the root, so moving them into place is a rename. */
  get incomingDir(): string {
    return join(this.root, '.incoming');
  }

  private pathOf(key: string): string {
    assertStorageKey(key);
    return join(this.root, ...key.split('/'));
  }

  async putFile(key: string, path: string): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    try {
      await rename(path, target);
    } catch (err: any) {
      // Another disk: copy, then remove the spool file.
      if (err?.code !== 'EXDEV') throw err;
      await copyFile(path, target);
      await unlink(path).catch(() => undefined);
    }
    await chmod(target, 0o600);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.pathOf(key), range ? { start: range.start, end: range.end } : {});
  }

  async head(key: string): Promise<{ size: number } | undefined> {
    try {
      return { size: (await stat(this.pathOf(key))).size };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async check(): Promise<void> {
    try {
      await mkdir(this.incomingDir, { recursive: true, mode: 0o700 });
      const probe = join(this.incomingDir, `.probe-${process.pid}`);
      await writeFile(probe, 'ok', { mode: 0o600 });
      await unlink(probe);
    } catch (err: any) {
      throw new Error(`EVIDENCE_DIR (${this.root}) isn't a directory Testify can write to: ${err?.message ?? err}`);
    }
  }
}
