import { readFile, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { assertStorageKey, type StorageProvider } from './provider.js';

/**
 * Evidence files in memory: for the in-memory database (development, where everything is
 * thrown away when the server stops anyway) and tests.
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory' as const;
  readonly files = new Map<string, Buffer>();

  async putFile(key: string, path: string): Promise<void> {
    assertStorageKey(key);
    this.files.set(key, await readFile(path));
    await unlink(path).catch(() => undefined);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const file = this.files.get(key);
    if (!file) throw Object.assign(new Error(`No such file: ${key}`), { code: 'ENOENT' });
    return Readable.from([range ? file.subarray(range.start, range.end + 1) : file]);
  }

  async head(key: string): Promise<{ size: number } | undefined> {
    const file = this.files.get(key);
    return file ? { size: file.length } : undefined;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async check(): Promise<void> {}
}
