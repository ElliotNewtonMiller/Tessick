import type { Readable } from 'node:stream';
import type { EvidenceStorageConfig } from '../config.js';
import type { StorageProvider } from './provider.js';

/** S3-compatible storage: built in the next step (the AWS SDK isn't installed yet). */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  constructor(_config: Extract<EvidenceStorageConfig, { kind: 's3' }>) {}
  private missing(): never {
    throw new Error('S3 evidence storage is not available in this build yet.');
  }
  async putFile(): Promise<void> {
    this.missing();
  }
  async read(): Promise<Readable> {
    this.missing();
  }
  async head(): Promise<{ size: number } | undefined> {
    this.missing();
  }
  async delete(): Promise<void> {
    this.missing();
  }
  async check(): Promise<void> {
    this.missing();
  }
}
