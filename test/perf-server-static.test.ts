/**
 * 3.10 server performance (unit A3) — static asset caching + compression.
 *
 * Hashed Vite chunks are immutable; everything else revalidates via a strong
 * ETag (bodyless 304). Text assets are brotli/gzip-encoded per Accept-Encoding
 * from a threadpool-built cache — the first hit is served identity-encoded.
 */

import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStaticCompressionCache,
  IMMUTABLE_CACHE_CONTROL,
  isImmutableAssetPath,
  negotiateEncoding,
  serveStatic,
} from '../src/core/web/static.js';

let dir: string;
let server: http.Server;
let port: number;
const BIG_JS = `export const x = ${JSON.stringify('lorem ipsum '.repeat(4000))};\n`;

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function get(path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Poll until the threadpool has produced the encoded copy. */
async function getEncoded(path: string, encoding: string): Promise<Reply> {
  for (let i = 0; i < 200; i++) {
    const r = await get(path, { 'Accept-Encoding': encoding });
    if (r.headers['content-encoding']) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('encoded copy never became available');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ashlr-a3-static-'));
  mkdirSync(join(dir, 'next', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>' + '<p>hi</p>'.repeat(300));
  writeFileSync(join(dir, 'next', 'index.html'), '<!doctype html>' + '<p>next</p>'.repeat(300));
  writeFileSync(join(dir, 'next', 'assets', 'App-D2P1AJiD.js'), BIG_JS);
  writeFileSync(join(dir, 'next', 'assets', 'ChatSection-Bp_-OBOU.css'), 'a{color:red}'.repeat(400));
  writeFileSync(join(dir, 'next', 'assets', 'logo.png'), Buffer.alloc(4096, 7));
  writeFileSync(join(dir, 'next', 'assets', 'tiny-AbCdEfGh.js'), 'export{}');
  server = http.createServer((req, res) => {
    if (!serveStatic(req, res, dir)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => clearStaticCompressionCache());

describe('cache policy', () => {
  it('recognises only content-hashed build output as immutable', () => {
    expect(isImmutableAssetPath('/next/assets/App-D2P1AJiD.js')).toBe(true);
    expect(isImmutableAssetPath('/next/assets/IBMPlexSans-B8AMtGvj.ttf')).toBe(true);
    expect(isImmutableAssetPath('/next/assets/App-D2P1AJiD.js.map')).toBe(false);
    expect(isImmutableAssetPath('/next/index.html')).toBe(false);
    expect(isImmutableAssetPath('/app.js')).toBe(false);
    expect(isImmutableAssetPath('/next/assets/logo.png')).toBe(false);
    expect(isImmutableAssetPath('/next/assets/sub/App-D2P1AJiD.js')).toBe(false);
  });

  it('serves hashed chunks immutable and the shell no-cache, both with a strong ETag', async () => {
    const chunk = await get('/next/assets/App-D2P1AJiD.js');
    expect(chunk.status).toBe(200);
    expect(chunk.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(chunk.headers['etag']).toMatch(/^"[0-9a-z]+-[0-9a-z]+-[0-9a-z]+"$/);
    const shell = await get('/verse/');
    expect(shell.headers['cache-control']).toBe('no-cache');
    expect(shell.headers['etag']).toBeTruthy();
    expect(shell.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers a matching If-None-Match with a bodyless 304', async () => {
    const first = await get('/next/index.html');
    const etag = String(first.headers['etag']);
    const again = await get('/next/index.html', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body.byteLength).toBe(0);
    expect(again.headers['etag']).toBe(etag);
    const weak = await get('/next/index.html', { 'If-None-Match': `W/${etag}, "other"` });
    expect(weak.status).toBe(304);
    const miss = await get('/next/index.html', { 'If-None-Match': '"nope"' });
    expect(miss.status).toBe(200);
  });

  it('changes the ETag when the file changes', async () => {
    const p = join(dir, 'changing.txt');
    writeFileSync(p, 'one'.repeat(500));
    const a = await get('/changing.txt');
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(p, 'two!'.repeat(500));
    const b = await get('/changing.txt');
    expect(a.headers['etag']).not.toBe(b.headers['etag']);
    const stale = await get('/changing.txt', { 'If-None-Match': String(a.headers['etag']) });
    expect(stale.status).toBe(200);
    expect(stale.body.toString()).toBe('two!'.repeat(500));
  });
});

describe('compression', () => {
  it('serves identity first, then brotli from the cache, byte-identical when decoded', async () => {
    const first = await get('/next/assets/App-D2P1AJiD.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(first.headers['content-encoding']).toBeUndefined();
    expect(first.headers['vary']).toBe('Accept-Encoding');
    expect(first.body.toString()).toBe(BIG_JS);
    const encoded = await getEncoded('/next/assets/App-D2P1AJiD.js', 'gzip, deflate, br');
    expect(encoded.headers['content-encoding']).toBe('br');
    expect(Number(encoded.headers['content-length'])).toBe(encoded.body.byteLength);
    expect(encoded.body.byteLength).toBeLessThan(BIG_JS.length / 10);
    expect(brotliDecompressSync(encoded.body).toString()).toBe(BIG_JS);
    expect(encoded.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('falls back to gzip, and honours q=0', async () => {
    const gz = await getEncoded('/next/assets/ChatSection-Bp_-OBOU.css', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe('a{color:red}'.repeat(400));
    const refused = await get('/next/assets/ChatSection-Bp_-OBOU.css', { 'Accept-Encoding': 'br;q=0, gzip;q=0' });
    expect(refused.headers['content-encoding']).toBeUndefined();
  });

  it('never encodes images or tiny files', async () => {
    const png = await get('/next/assets/logo.png', { 'Accept-Encoding': 'br, gzip' });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.headers['vary']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    const tiny = await get('/next/assets/tiny-AbCdEfGh.js', { 'Accept-Encoding': 'br, gzip' });
    expect(tiny.headers['content-encoding']).toBeUndefined();
  });

  it('does not serve a stale encoding after the file changes', async () => {
    const p = join(dir, 'mutable.js');
    writeFileSync(p, 'var a = 1;\n'.repeat(400));
    await getEncoded('/mutable.js', 'br');
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(p, 'var b = 2;\n'.repeat(400));
    const after = await get('/mutable.js', { 'Accept-Encoding': 'br' });
    const text = after.headers['content-encoding'] === 'br'
      ? brotliDecompressSync(after.body).toString()
      : after.body.toString();
    expect(text).toBe('var b = 2;\n'.repeat(400));
  });

  it('negotiates encodings from real-world headers', () => {
    expect(negotiateEncoding('gzip, deflate, br, zstd')).toBe('br');
    expect(negotiateEncoding('gzip')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(negotiateEncoding('*')).toBe('br');
    expect(negotiateEncoding('identity')).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding('x'.repeat(2000))).toBeNull();
  });
});
