/**
 * What an evidence file is, decided from its contents, never from its name or the type the
 * uploader declared (docs/rfc_03_api_and_xml_contracts.md §5). Only what Tessick can show safely
 * is kept: PNG, JPEG, GIF and WebP images; MP4 and WebM videos; UTF-8 text logs; and Playwright
 * trace archives. Everything else (SVG, HTML, PDF, executables, other archives) is refused.
 */

export type EvidenceKind = 'image' | 'video' | 'log' | 'trace';

export interface EvidenceType {
  kind: EvidenceKind;
  /** The type it's always served as. */
  media_type: string;
  /** The extension a file name gets when it has none. */
  ext: string;
}

export type SniffResult = ({ ok: true } & EvidenceType) | { ok: false; reason: string };

/** How much of the start of a file sniffing looks at. */
export const SNIFF_BYTES = 64 * 1024;

export const EVIDENCE_TYPES_TEXT = 'PNG, JPEG, GIF or WebP images, MP4 or WebM videos, UTF-8 text logs, or Playwright trace .zip files';

const startsWith = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => head[at + i] === b);
const ascii = (head: Uint8Array, from: number, to: number) => String.fromCharCode(...head.subarray(from, Math.min(to, head.length)));

/** ISO base media brands that are MP4 video (QuickTime's `qt  ` and audio-only brands aren't). */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV', 'mmp4']);

/** Names inside a Playwright trace archive. */
const TRACE_ENTRIES = ['trace.trace', 'trace.network', 'trace.stacks'];

function includesAscii(head: Uint8Array, text: string): boolean {
  const needle = Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= head.length; i++) {
    for (let j = 0; j < needle.length; j++) if (head[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Whether `head` (the file's first bytes) is the start of UTF-8 text without NUL characters. */
function isTextStart(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    // `stream: true`: the head may end in the middle of a character.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** The type of a file from its first bytes (up to SNIFF_BYTES). A log must still pass TextCheck to its end. */
export function sniffEvidence(head: Uint8Array): SniffResult {
  if (head.length === 0) return { ok: false, reason: 'The file is empty' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, kind: 'image', media_type: 'image/png', ext: 'png' };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { ok: true, kind: 'image', media_type: 'image/jpeg', ext: 'jpg' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { ok: true, kind: 'image', media_type: 'image/gif', ext: 'gif' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { ok: true, kind: 'image', media_type: 'image/webp', ext: 'webp' };
  if (ascii(head, 4, 8) === 'ftyp') {
    if (MP4_BRANDS.has(ascii(head, 8, 12))) return { ok: true, kind: 'video', media_type: 'video/mp4', ext: 'mp4' };
    return { ok: false, reason: `This kind of video or media file (${ascii(head, 8, 12).trim() || 'unknown'}) isn't accepted: use MP4 or WebM` };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (includesAscii(head.subarray(0, 64), 'webm')) return { ok: true, kind: 'video', media_type: 'video/webm', ext: 'webm' };
    return { ok: false, reason: "Matroska video isn't accepted: use MP4 or WebM" };
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (TRACE_ENTRIES.some((name) => includesAscii(head, name))) return { ok: true, kind: 'trace', media_type: 'application/zip', ext: 'zip' };
    return { ok: false, reason: "Only Playwright trace archives are accepted as .zip files; this one isn't a trace" };
  }
  if (isTextStart(head)) return { ok: true, kind: 'log', media_type: 'text/plain; charset=utf-8', ext: 'log' };
  return { ok: false, reason: `This kind of file isn't accepted as evidence: send ${EVIDENCE_TYPES_TEXT}` };
}

/**
 * Checks a log to its end as it streams by: UTF-8 throughout, and no NUL characters (a binary
 * file can start like text). `push` each chunk, then `end`; either returns a reason to refuse.
 */
export class TextCheck {
  private decoder = new TextDecoder('utf-8', { fatal: true });

  push(chunk: Uint8Array): string | undefined {
    if (chunk.includes(0)) return "The log contains NUL characters, so it isn't text";
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      return "The log isn't valid UTF-8 text";
    }
    return undefined;
  }

  end(): string | undefined {
    try {
      this.decoder.decode();
    } catch {
      return "The log ends in the middle of a character, so it isn't valid UTF-8 text";
    }
    return undefined;
  }
}
