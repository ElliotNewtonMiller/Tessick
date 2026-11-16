import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { SNIFF_BYTES, TextCheck, sniffEvidence, type EvidenceType } from '@tessick/core';

/**
 * An upload on its way to storage: streamed to a private temporary file while it's counted,
 * hashed (SHA-256) and sniffed, so it's stored only once it's known to be evidence Tessick
 * accepts, of a size it allows, with the checksum the client gave. A refused upload leaves
 * nothing behind.
 */

/** Why an upload was refused: the HTTP status, a code, and the message for the client. */
export class EvidenceRefused extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface SpooledFile {
  path: string;
  size: number;
  sha256: string;
  type: EvidenceType;
  /** Removes the temporary file (when it isn't stored after all). */
  discard(): Promise<void>;
}

const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** Reads what's left of a stream and drops it, so a refused multipart part doesn't stall the request. */
async function drain(source: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _ of source) {
      // dropped
    }
  } catch {
    // the client went away
  }
}

export async function spoolEvidence(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  opts: { dir: string; maxBytes: number; expectedSha256?: string; expectedSize?: number }
): Promise<SpooledFile> {
  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  const path = join(opts.dir, `${uuidv7()}.part`);
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  const discard = () => rm(path, { force: true });
  let size = 0;
  let head: Buffer[] = [];
  let headBytes = 0;
  let type: EvidenceType | undefined;
  let text: TextCheck | undefined;
  const iterator = source[Symbol.asyncIterator]();

  const decide = () => {
    const sniffed = sniffEvidence(Buffer.concat(head));
    if (!sniffed.ok) throw new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', sniffed.reason);
    const { ok: _ok, ...found } = sniffed;
    type = found;
    if (type.kind === 'log') {
      text = new TextCheck();
      for (const chunk of head) {
        const problem = text.push(chunk);
        if (problem) throw new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', problem);
      }
    }
    head = [];
  };

  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      const chunk = typeof next.value === 'string' ? Buffer.from(next.value) : Buffer.from(next.value);
      size += chunk.length;
      if (size > opts.maxBytes) {
        throw new EvidenceRefused(413, 'EVIDENCE_TOO_LARGE', `An evidence file can be at most ${mb(opts.maxBytes)}.`, { limit_bytes: opts.maxBytes });
      }
      hash.update(chunk);
      await file.write(chunk);
      if (!type) {
        head.push(chunk);
        headBytes += chunk.length;
        if (headBytes >= SNIFF_BYTES) decide();
      } else if (text) {
        const problem = text.push(chunk);
        if (problem) throw new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', problem);
      }
    }
    if (!type) decide();
    const ended = text?.end();
    if (ended) throw new EvidenceRefused(415, 'EVIDENCE_TYPE_REFUSED', ended);
    const sha256 = hash.digest('hex');
    if (opts.expectedSize !== undefined && opts.expectedSize !== size) {
      throw new EvidenceRefused(400, 'SIZE_MISMATCH', `The file is ${size} bytes, not the ${opts.expectedSize} the upload was made for.`);
    }
    if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
      throw new EvidenceRefused(400, 'CHECKSUM_MISMATCH', `The file's SHA-256 is ${sha256}, not the ${opts.expectedSha256} it was sent with: it was changed or cut short on the way.`);
    }
    await file.close();
    return { path, size, sha256, type: type!, discard };
  } catch (err) {
    await file.close().catch(() => undefined);
    await discard();
    await drain({ [Symbol.asyncIterator]: () => iterator });
    throw err;
  }
}
