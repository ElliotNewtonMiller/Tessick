import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny S3 for tests, in-process: path-style buckets, and the requests Testify's S3 provider
 * makes (PUT, GET with one Range, HEAD, DELETE, HEAD bucket), presigned PUTs included. Like S3, it
 * refuses a PUT whose `x-amz-checksum-sha256` doesn't match the body (BadDigest). It doesn't check
 * signatures: the SDK's signing isn't what's under test.
 */
export interface FakeS3 {
  endpoint: string;
  objects: Map<string, { body: Buffer; contentType?: string; sse?: string }>;
  requests: Array<{ method: string; path: string; query: string }>;
  close(): Promise<void>;
}

const xmlError = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  // aws-chunked: "<hex size>[;...]\r\n<data>\r\n" ... "0\r\n<trailers>\r\n\r\n"
  if (!String(req.headers['content-encoding'] ?? '').includes('aws-chunked')) return raw;
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', at);
    const size = parseInt(raw.subarray(at, lineEnd).toString().split(';')[0], 16);
    at = lineEnd + 2;
    if (!size) break;
    out.push(raw.subarray(at, at + size));
    at += size + 2;
  }
  return Buffer.concat(out);
}

export async function startFakeS3(bucket: string): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const requests: FakeS3['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, b, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.search });
    if (b !== bucket) {
      res.writeHead(404, { 'content-type': 'application/xml' }).end(req.method === 'HEAD' ? undefined : xmlError('NoSuchBucket', 'No such bucket'));
      return;
    }
    if (!key) {
      res.writeHead(200).end(); // HEAD bucket
      return;
    }
    const found = objects.get(key);
    switch (req.method) {
      case 'PUT': {
        const body = await readBody(req);
        const expected = req.headers['x-amz-checksum-sha256'] ?? url.searchParams.get('x-amz-checksum-sha256');
        if (expected && createHash('sha256').update(body).digest('base64') !== expected) {
          res.writeHead(400, { 'content-type': 'application/xml' }).end(xmlError('BadDigest', 'The SHA256 you specified did not match the calculated checksum.'));
          return;
        }
        objects.set(key, { body, contentType: req.headers['content-type'], sse: req.headers['x-amz-server-side-encryption'] as string | undefined });
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
        return;
      }
      case 'GET': {
        if (!found) {
          res.writeHead(404, { 'content-type': 'application/xml' }).end(xmlError('NoSuchKey', 'The specified key does not exist.'));
          return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), found.body.length - 1);
          res
            .writeHead(206, { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${found.body.length}`, 'content-type': found.contentType ?? 'application/octet-stream' })
            .end(found.body.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, { 'content-length': String(found.body.length), 'content-type': found.contentType ?? 'application/octet-stream' }).end(found.body);
        return;
      }
      case 'HEAD':
        if (!found) res.writeHead(404).end();
        else res.writeHead(200, { 'content-length': String(found.body.length) }).end();
        return;
      case 'DELETE':
        objects.delete(key);
        res.writeHead(204).end();
        return;
      default:
        res.writeHead(405).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
