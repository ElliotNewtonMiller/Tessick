import { describe, it, expect } from 'vitest';
import { sniffEvidence, TextCheck, cleanFilename, contentDisposition, parseRange, evidenceWindow, EVIDENCE_GRACE_MS } from '../src/evidence/index.js';

const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)));

/** Evidence files: what's accepted (by contents alone), how they're named, served and limited. */
describe('evidence: sniffing', () => {
  it('recognises the accepted images, videos, traces and logs by their contents', () => {
    const kinds = (b: Uint8Array) => {
      const r = sniffEvidence(b);
      return r.ok ? [r.kind, r.media_type] : ['refused', r.reason];
    };
    expect(kinds(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toEqual(['image', 'image/png']);
    expect(kinds(bytes([0xff, 0xd8, 0xff, 0xe0]))).toEqual(['image', 'image/jpeg']);
    expect(kinds(bytes('GIF89a', [1, 0]))).toEqual(['image', 'image/gif']);
    expect(kinds(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toEqual(['image', 'image/webp']);
    expect(kinds(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0]))).toEqual(['video', 'video/mp4']);
    expect(kinds(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm'))).toEqual(['video', 'video/webm']);
    expect(kinds(bytes([0x50, 0x4b, 0x03, 0x04], [0, 0, 0, 0], 'trace.trace{...}'))).toEqual(['trace', 'application/zip']);
    expect(kinds(new TextEncoder().encode('2026-11-09 10:00:01 INFO started\nÜnïcødé ✓\n'))).toEqual(['log', 'text/plain; charset=utf-8']);
  });

  it('refuses everything else, whatever it is called', () => {
    for (const b of [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', [0]),
      bytes('%PDF-1.7', [0, 0xff]),
      bytes('MZ', [0x90, 0, 3, 0]),
      bytes([0x7f], 'ELF', [2, 1, 1, 0]),
      bytes([0x50, 0x4b, 0x03, 0x04], 'word/document.xml'),
      bytes([0, 0, 0, 0x14], 'ftypqt  '),
      bytes([0x1a, 0x45, 0xdf, 0xa3], 'matroska'),
      bytes([0xc3, 0x28, 0x41]),
      new Uint8Array(0),
    ]) {
      expect(sniffEvidence(b).ok, Buffer.from(b).toString('latin1')).toBe(false);
    }
  });

  it('checks a log to its end: a NUL or broken UTF-8 later in the file is refused', () => {
    const ok = new TextCheck();
    expect([ok.push(bytes('line one\n')), ok.push(Uint8Array.from([0xc3])), ok.push(Uint8Array.from([0xa9])), ok.end()]).toEqual([undefined, undefined, undefined, undefined]);
    expect(new TextCheck().push(bytes('fine\n', [0], 'binary'))).toMatch(/NUL/);
    const cut = new TextCheck();
    expect(cut.push(Uint8Array.from([0x41, 0xe2, 0x82]))).toBeUndefined();
    expect(cut.end()).toMatch(/middle of a character/);
  });
});

describe('evidence: names, headers, ranges, the grace window', () => {
  it('keeps only the last part of a name, without control characters', () => {
    expect(cleanFilename('C:\\Users\\qa\\login failed.png', 'png')).toBe('login failed.png');
    expect(cleanFilename('../../etc/passwd', 'log')).toBe('passwd');
    expect(cleanFilename('a\u0000b\nc.txt', 'log')).toBe('abc.txt');
    expect(cleanFilename('', 'webm')).toBe('evidence.webm');
    expect(cleanFilename('...', 'png')).toBe('evidence.png');
    expect(cleanFilename(`${'x'.repeat(300)}.png`, 'png')).toHaveLength(255);
  });

  it('writes a Content-Disposition nothing can break out of', () => {
    expect(contentDisposition('inline', 'shot.png')).toBe(`inline; filename="shot.png"; filename*=UTF-8''shot.png`);
    expect(contentDisposition('attachment', 'a"b\\c ü.zip')).toBe(`attachment; filename="a_b_c _.zip"; filename*=UTF-8''a%22b%5Cc%20%C3%BC.zip`);
  });

  it('reads one byte range', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-1', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-9', 100)).toBeUndefined();
    expect(parseRange('items=0-1', 100)).toBeUndefined();
  });

  it('allows evidence while the run is open, and for 24 hours after only by who recorded the result', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const closedAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(evidenceWindow({ runStatus: 'OPEN', closedAt: null, callerRecordedResult: false, now })).toEqual({ allowed: true, afterClose: false });
    expect(evidenceWindow({ runStatus: 'CLOSED', closedAt: closedAgo(3_600_000), callerRecordedResult: true, now })).toEqual({ allowed: true, afterClose: true });
    expect(evidenceWindow({ runStatus: 'CLOSED', closedAt: closedAgo(3_600_000), callerRecordedResult: false, now }).allowed).toBe(false);
    expect(evidenceWindow({ runStatus: 'CLOSED', closedAt: closedAgo(EVIDENCE_GRACE_MS + 1), callerRecordedResult: true, now }).allowed).toBe(false);
    expect(evidenceWindow({ runStatus: 'CLOSED', closedAt: null, callerRecordedResult: true, now }).allowed).toBe(false);
  });
});
