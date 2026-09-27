/**
 * Verse transcript sources (/api/verse/sources/open): open a file the agent
 * read in the operator's editor — confined to the chat's own roots
 * (primary + extraRoots), realpath'd so symlink escapes are refused, behind
 * the mutation gate.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createSourcesApi, type SourcesApiDeps, type SourcesSession } from '../src/core/verse/sources-api.js';

const TOKEN = 'sources-test-token';
const SESSION = 'sess-1';

let server: http.Server;
let base: string;
let allowDispatch = true;
let tmp: string;
let primary: string;
let extra: string;
let outside: string;
let sessions: Map<string, SourcesSession>;
const opened: Array<{ path: string; line: number }> = [];

const deps: SourcesApiDeps = {
  getSession: async (id) => sessions.get(id) ?? null,
  openInEditor: (p, line) => { opened.push({ path: p, line }); },
};

beforeAll(async () => {
  const api = createSourcesApi(deps);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch };
    void api(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end('{"error":"not mine"}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-sources-'));
  primary = join(tmp, 'primary');
  extra = join(tmp, 'extra');
  outside = join(tmp, 'outside');
  for (const d of [primary, join(primary, 'src'), extra, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(primary, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  writeFileSync(join(extra, 'b.ts'), 'x\ny\n');
  writeFileSync(join(outside, 'secret.txt'), 'nope\n');
  symlinkSync(join(outside, 'secret.txt'), join(primary, 'escape.txt'));
  symlinkSync(outside, join(primary, 'escape-dir'));
  sessions = new Map([[SESSION, { projectPath: primary, extraRoots: [extra] }]]);
  allowDispatch = true;
  opened.length = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const post = (body: unknown, token: string | null = TOKEN, p = '/api/verse/sources/open') =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ashlr-token': token } : {}) },
    body: JSON.stringify(body),
  });

describe('/api/verse/sources/open', () => {
  it('declines other paths and 404s other routes in the family', async () => {
    expect((await post({}, TOKEN, '/api/verse/sourcesx')).status).toBe(418);
    expect((await fetch(`${base}/api/verse/sources/open`)).status).toBe(404);
    expect((await post({}, TOKEN, '/api/verse/sources/other')).status).toBe(404);
  });

  it('is 404 when the server does not allow dispatch', async () => {
    allowDispatch = false;
    expect((await post({ sessionId: SESSION, path: 'src/a.ts' })).status).toBe(404);
    expect(opened).toEqual([]);
  });

  it('sits behind the mutation gate', async () => {
    expect((await post({ sessionId: SESSION, path: 'src/a.ts' }, null)).status).toBe(401);
    expect((await post({ sessionId: SESSION, path: 'src/a.ts' }, 'wrong')).status).toBe(401);
    const res = await fetch(`${base}/api/verse/sources/open`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-ashlr-token': TOKEN },
      body: JSON.stringify({ sessionId: SESSION, path: 'src/a.ts' }),
    });
    expect(res.status).toBe(415);
    expect(opened).toEqual([]);
  });

  it('opens an absolute file under the primary root at the line asked', async () => {
    const res = await post({ sessionId: SESSION, path: join(primary, 'src', 'a.ts'), line: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(opened).toEqual([{ path: realpathSync(join(primary, 'src', 'a.ts')), line: 3 }]);
  });

  it('resolves a relative path against the primary root, defaults line to 1, clamps past the end', async () => {
    expect((await post({ sessionId: SESSION, path: 'src/a.ts' })).status).toBe(200);
    expect((await post({ sessionId: SESSION, path: './src/../src/a.ts', line: 999 })).status).toBe(200);
    const real = realpathSync(join(primary, 'src', 'a.ts'));
    expect(opened).toEqual([{ path: real, line: 1 }, { path: real, line: 5 }]);
  });

  it('allows files under an extra root', async () => {
    expect((await post({ sessionId: SESSION, path: join(extra, 'b.ts'), line: 2 })).status).toBe(200);
    expect(opened).toEqual([{ path: realpathSync(join(extra, 'b.ts')), line: 2 }]);
  });

  it('refuses a path outside every root, including ../ traversal', async () => {
    for (const p of [join(outside, 'secret.txt'), '../outside/secret.txt', '/etc/hosts']) {
      const res = await post({ sessionId: SESSION, path: p });
      expect(res.status, p).toBe(409);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('VERSE_REFUSED');
      expect(body.error).not.toContain(tmp);
    }
    expect(opened).toEqual([]);
  });

  it('refuses a symlink that escapes the root (file or directory link)', async () => {
    expect((await post({ sessionId: SESSION, path: 'escape.txt' })).status).toBe(409);
    expect((await post({ sessionId: SESSION, path: 'escape-dir/secret.txt' })).status).toBe(409);
    expect(opened).toEqual([]);
  });

  it('refuses a missing file, a directory, and the root itself', async () => {
    expect((await post({ sessionId: SESSION, path: 'src/missing.ts' })).status).toBe(409);
    expect((await post({ sessionId: SESSION, path: 'src' })).status).toBe(409);
    expect((await post({ sessionId: SESSION, path: primary })).status).toBe(409);
    expect(opened).toEqual([]);
  });

  it('400s an unknown body key, a bad line, and a malformed path', async () => {
    expect((await post({ sessionId: SESSION, path: 'src/a.ts', bogus: 1 })).status).toBe(400);
    for (const line of [0, -1, 1.5, '3', null]) {
      expect((await post({ sessionId: SESSION, path: 'src/a.ts', line })).status, String(line)).toBe(400);
    }
    expect((await post({ sessionId: SESSION, path: '' })).status).toBe(400);
    expect((await post({ sessionId: SESSION, path: 'src/a.ts\u0000' })).status).toBe(400);
    expect((await post({ sessionId: SESSION, path: 'a'.repeat(4097) })).status).toBe(400);
    expect((await post({ sessionId: '../x', path: 'src/a.ts' })).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it('404s an unknown session', async () => {
    const res = await post({ sessionId: 'no-such-session', path: 'src/a.ts' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('VERSE_SESSION_NOT_FOUND');
    expect(opened).toEqual([]);
  });
});
