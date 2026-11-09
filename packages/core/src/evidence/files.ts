import type { EvidenceKind } from './sniff.js';

/** How evidence files are named, served and limited (docs/rfc_03_api_and_xml_contracts.md §5). */

export const MAX_EVIDENCE_FILENAME = 255;
export const MAX_EVIDENCE_DESCRIPTION = 2000;
/** At most this many files on one case's execution in a run. */
export const MAX_EVIDENCE_PER_EXECUTION = 50;

/**
 * A file name as kept and shown: the last path segment only, without control characters, cut to
 * 255 characters; `evidence.<ext>` when nothing is left. It's only a label: files are stored
 * under generated keys and served with the type their contents showed.
 */
export function cleanFilename(raw: unknown, ext: string): string {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  const name = base.length > MAX_EVIDENCE_FILENAME ? base.slice(base.length - MAX_EVIDENCE_FILENAME) : base;
  return name || `evidence.${ext}`;
}

/**
 * The Content-Disposition header for a file: an ASCII fallback name, and the real one in
 * RFC 5987 form for browsers that read it. Quotes, backslashes and non-ASCII characters can't
 * break out of the header.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Shown in the browser (images, videos, logs as text); traces are always downloaded. */
export const shownInline = (kind: EvidenceKind) => kind !== 'trace';

/**
 * One byte range from a Range header (`bytes=0-499`, `bytes=500-`, `bytes=-500`), for a file of
 * `size` bytes. Undefined to send the whole file (no header, or one this doesn't serve, such as
 * several ranges); `'unsatisfiable'` for a range outside the file (416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (size === 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** How long after its run closes evidence may still be added, by whoever recorded the result. */
export const EVIDENCE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether evidence may be added to a result now (decided with Elliot): any time while its run is
 * open; after the run closes, for 24 hours, only by the one who recorded the result.
 */
export function evidenceWindow(input: {
  runStatus: string;
  closedAt: string | null;
  callerRecordedResult: boolean;
  now: Date;
}): { allowed: true; afterClose: boolean } | { allowed: false; reason: string } {
  if (input.runStatus !== 'CLOSED') return { allowed: true, afterClose: false };
  const closed = input.closedAt ? Date.parse(input.closedAt) : NaN;
  const within = Number.isFinite(closed) && input.now.getTime() - closed <= EVIDENCE_GRACE_MS;
  if (!within) return { allowed: false, reason: 'The run is closed, and evidence can be added only within 24 hours of its closing.' };
  if (!input.callerRecordedResult) {
    return { allowed: false, reason: 'The run is closed: for 24 hours after it closes, only whoever recorded the result can add evidence to it.' };
  }
  return { allowed: true, afterClose: true };
}
