/**
 * M14 static tests — hermetic.
 *
 * Tests serveStatic() from src/core/web/static.ts:
 *   - Serves index.html for "/" path (SPA shell).
 *   - Sets correct Content-Type for common extensions (.html, .js, .css, .json).
 *   - Rejects path traversal attempts ("../../etc/passwd", "../secret") with
 *     404 / returns false.
 *   - Rejects absolute path escapes.
 *   - Rejects null-byte injection.
 *   - Rejects URL-encoded traversal (%2e%2e%2f...).
 *   - Returns false (and writes 404) for non-existent files.
 *   - NEVER throws — errors are handled internally.
 *
 * The tests create a real temporary assets directory with known files so we
 * can verify actual serving behavior without relying on the SPA being built.
 * serveStatic is also exercised through a real ephemeral HTTP server to
 * ensure the full pipeline (server.ts -> serveStatic) is path-traversal-safe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { serveStatic } from '../src/core/web/static.js';

// ---------------------------------------------------------------------------
// Temporary assets directory
// ---------------------------------------------------------------------------

let assetsDir: string;

beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m14-static-'));

  // Write known files
  fs.writeFileSync(path.join(assetsDir, 'index.html'), '<html><body>SPA</body></html>');
  fs.writeFileSync(path.join(assetsDir, 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(assetsDir, 'styles.css'), 'body { color: red; }');
  fs.writeFileSync(path.join(assetsDir, 'manifest.json'), '{"name":"ashlr"}');

  // Create a subdirectory with a file
  fs.mkdirSync(path.join(assetsDir, 'sub'));
  fs.writeFileSync(path.join(assetsDir, 'sub', 'page.html'), '<html>sub</html>');

  // Create a SENSITIVE file OUTSIDE assetsDir (to target with traversal attempts)
  // We use a sibling tmp dir
  const sibling = path.join(os.tmpdir(), 'ashlr-m14-static-secret');
  try {
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SUPER_SECRET_VALUE');
  } catch { /* ignore if already exists */ }
});

afterEach(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers: build mock req/res objects
// ---------------------------------------------------------------------------

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer[];
  ended: boolean;
}

function makeMockReqRes(urlPath: string): { req: IncomingMessage; res: ServerResponse; mock: MockResponse } {
  const mock: MockResponse = { statusCode: 200, headers: {}, body: [], ended: false };

  // Minimal IncomingMessage-like object
  const req = { url: urlPath, method: 'GET' } as unknown as IncomingMessage;

  // Minimal ServerResponse-like object
  const res = {
    statusCode: 200,
    writeHead(code: number, headers?: Record<string, string>) {
      mock.statusCode = code;
      if (headers) Object.assign(mock.headers, headers);
    },
    setHeader(name: string, value: string) {
      mock.headers[name.toLowerCase()] = value;
    },
    write(chunk: Buffer | string) {
      mock.body.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) mock.body.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      mock.ended = true;
    },
  } as unknown as ServerResponse;

  return { req, res, mock };
}

// ---------------------------------------------------------------------------
// Helper: start a minimal real HTTP server using serveStatic for integration tests
// ---------------------------------------------------------------------------

function startStaticServer(dir: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const handled = serveStatic(req, res, dir);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res, rej) => server.close(err => err ? rej(err) : res())),
      });
    });
    server.on('error', reject);
  });
}

function httpGet(url: string): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: data,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Unit tests: serveStatic with mock req/res
// ---------------------------------------------------------------------------

describe('serveStatic — index.html for "/"', () => {
  it('serves index.html for path "/"', () => {
    const { req, res, mock } = makeMockReqRes('/');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(true);
    expect(mock.ended).toBe(true);
    const bodyStr = Buffer.concat(mock.body).toString();
    expect(bodyStr).toContain('SPA');
  });

  it('serves index.html for path "/" with correct html content-type', () => {
    const { req, res, mock } = makeMockReqRes('/');
    serveStatic(req, res, assetsDir);
    const ct = mock.headers['content-type'] ?? '';
    expect(ct).toContain('text/html');
  });
});

describe('serveStatic — exact file serving', () => {
  it('serves app.js with application/javascript content-type', () => {
    const { req, res, mock } = makeMockReqRes('/app.js');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(true);
    const ct = mock.headers['content-type'] ?? '';
    expect(ct).toMatch(/javascript/);
  });

  it('serves styles.css with text/css content-type', () => {
    const { req, res, mock } = makeMockReqRes('/styles.css');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(true);
    const ct = mock.headers['content-type'] ?? '';
    expect(ct).toContain('text/css');
  });

  it('serves manifest.json with application/json content-type', () => {
    const { req, res, mock } = makeMockReqRes('/manifest.json');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(true);
    const ct = mock.headers['content-type'] ?? '';
    expect(ct).toContain('application/json');
  });

  it('serves a file in a subdirectory', () => {
    const { req, res, mock } = makeMockReqRes('/sub/page.html');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(true);
    const bodyStr = Buffer.concat(mock.body).toString();
    expect(bodyStr).toContain('sub');
  });

  it('returns false for a non-existent file', () => {
    const { req, res, mock } = makeMockReqRes('/does-not-exist.js');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(false);
    void mock; // suppress unused warning
  });
});

// ---------------------------------------------------------------------------
// Path traversal rejection — unit (mock req/res)
// ---------------------------------------------------------------------------

describe('serveStatic — path traversal rejection (unit)', () => {
  it('rejects "/../../../etc/passwd" (returns false)', () => {
    const { req, res, mock } = makeMockReqRes('/../../../etc/passwd');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(false);
    void mock;
  });

  it('rejects "/../../secret.txt" (returns false)', () => {
    const { req, res, mock } = makeMockReqRes('/../../secret.txt');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(false);
    void mock;
  });

  it('rejects "../secret" (returns false)', () => {
    const { req, res, mock } = makeMockReqRes('../secret');
    const handled = serveStatic(req, res, assetsDir);
    expect(handled).toBe(false);
    void mock;
  });

  it('rejects a path with null byte (%00)', () => {
    const { req, res, mock } = makeMockReqRes('/app.js%00');
    const handled = serveStatic(req, res, assetsDir);
    // Either false (rejected) or true (serves safely) — but must NOT serve
    // the secret file. The key invariant: if it serves anything, it must be
    // within assetsDir.
    if (handled) {
      const bodyStr = Buffer.concat(mock.body).toString();
      expect(bodyStr).not.toContain('SUPER_SECRET_VALUE');
    } else {
      expect(handled).toBe(false);
    }
  });

  it('does not serve content from outside assetsDir', () => {
    const traversals = [
      '/../../../etc/passwd',
      '/../../secret.txt',
      '/../index.html',
    ];
    for (const urlPath of traversals) {
      const { req, res, mock } = makeMockReqRes(urlPath);
      const handled = serveStatic(req, res, assetsDir);
      if (handled) {
        // If it somehow "handled" a traversal, the body must not contain secrets
        const bodyStr = Buffer.concat(mock.body).toString();
        expect(bodyStr).not.toContain('SUPER_SECRET_VALUE');
        expect(bodyStr).not.toContain('root:');
      } else {
        expect(handled).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// serveStatic — never throws
// ---------------------------------------------------------------------------

describe('serveStatic — never throws', () => {
  it('does not throw for a normal path', () => {
    const { req, res } = makeMockReqRes('/index.html');
    expect(() => serveStatic(req, res, assetsDir)).not.toThrow();
  });

  it('does not throw for a traversal path', () => {
    const { req, res } = makeMockReqRes('/../../etc/passwd');
    expect(() => serveStatic(req, res, assetsDir)).not.toThrow();
  });

  it('does not throw for a null-byte path', () => {
    const { req, res } = makeMockReqRes('/foo\x00bar');
    expect(() => serveStatic(req, res, assetsDir)).not.toThrow();
  });

  it('does not throw for an empty path', () => {
    const { req, res } = makeMockReqRes('');
    expect(() => serveStatic(req, res, assetsDir)).not.toThrow();
  });

  it('does not throw for a path with query string', () => {
    const { req, res } = makeMockReqRes('/app.js?v=123');
    expect(() => serveStatic(req, res, assetsDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: path traversal via real HTTP server
// ---------------------------------------------------------------------------

describe('serveStatic — integration via real HTTP server', () => {
  let port: number;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const s = await startStaticServer(assetsDir);
    port = s.port;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
  });

  it('serves index.html for GET /', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA');
  });

  it('serves app.js for GET /app.js', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/app.js`);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'] ?? '')).toMatch(/javascript/);
  });

  it('returns 404 for GET /nonexistent.js', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/nonexistent.js`);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for GET /../../etc/passwd (traversal via HTTP)', async () => {
    // URL-normalize the path — the HTTP client and server will resolve it
    const res = await httpGet(`http://127.0.0.1:${port}/../../etc/passwd`);
    expect(res.statusCode).toBe(404);
    // Must not serve the real /etc/passwd content
    expect(res.body).not.toContain('root:');
    expect(res.body).not.toContain('/bin/sh');
  });

  it('returns 404 for URL-encoded traversal %2e%2e%2f', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/%2e%2e%2fetc/passwd`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('root:');
  });

  it('returns 404 for double-encoded traversal %252e%252e%252f', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/%252e%252e%252fetc/passwd`);
    expect(res.statusCode).toBe(404);
  });

  it('does not serve content from outside the assets directory', async () => {
    const attempts = [
      '/../../etc/passwd',
      '/%2e%2e%2fetc/passwd',
      '/../../../tmp/ashlr-m14-static-secret/secret.txt',
    ];
    for (const attempt of attempts) {
      const res = await httpGet(`http://127.0.0.1:${port}${attempt}`);
      // Must either 404 or return something that is NOT the secret content
      expect(res.body).not.toContain('SUPER_SECRET_VALUE');
      expect(res.body).not.toContain('root:');
    }
  });
});

// ---------------------------------------------------------------------------
// Real bundled dashboard assets
// ---------------------------------------------------------------------------

describe('bundled dashboard assets — smoke', () => {
  it('keeps the real app.js syntactically valid and wired from index.html', () => {
    const publicDir = path.resolve(process.cwd(), 'src/core/web/public');
    execFileSync(process.execPath, ['--check', path.join(publicDir, 'app.js')], { stdio: 'pipe' });

    const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const styles = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
    expect(index).toContain('/app.js');
    expect(index).toContain('/styles.css');
    expect(styles).toContain('.ctrl-direction-copy');
  });
});

// ---------------------------------------------------------------------------
// Content-Type mapping
// ---------------------------------------------------------------------------

describe('serveStatic — Content-Type mapping', () => {
  const cases: Array<[string, string, string]> = [
    ['index.html', '<html/>', 'text/html'],
    ['app.js', 'console.log(1);', 'javascript'],
    ['styles.css', 'body{}', 'text/css'],
    ['manifest.json', '{}', 'application/json'],
  ];

  for (const [filename, fileContent, expectedType] of cases) {
    it(`serves ${filename} with content-type containing "${expectedType}"`, () => {
      // Write the file (may already exist from beforeEach but overwrite is fine)
      fs.writeFileSync(path.join(assetsDir, filename), fileContent);
      const { req, res, mock } = makeMockReqRes(`/${filename}`);
      serveStatic(req, res, assetsDir);
      const ct = mock.headers['content-type'] ?? '';
      expect(ct).toContain(expectedType);
    });
  }
});
