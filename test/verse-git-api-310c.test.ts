/**
 * V3.10 unit C5 — `/api/verse/git*` (src/core/verse/git-api.ts).
 *
 * Drives the real handler with in-memory request/response objects (no
 * listening socket) and a fake git/gh runner, under a relocated HOME. Checks
 * the route contract SPEC-310C §7 sets for every workbench family: strict
 * query and body keys, the dispatch + mutation-token gate, roots limited to
 * folders Verse already knows (and never the home directory itself), and the
 * busy-root 409 while a chat runs in the repository.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleGitApi, setGitApiDepsForTest } from '../src/core/verse/git-api.js';
import { invalidateGitCaches, type GitRunResult, type GitRunner } from '../src/core/verse/git-ops.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'c5-test-token';
const SHA = 'd'.repeat(40);

let home: string;
let savedHome: string | undefined;
let repo: string;
let other: string;
let running: string[];
let calls: string[][];

function ok(stdout = ''): GitRunResult {
  return { code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false };
}

const runner: GitRunner = async (bin, args) => {
  calls.push([bin, ...args]);
  if (bin === 'gh') return { ...ok(), code: 1, stderr: 'no pull requests found for branch "feat/x"' };
  const a = [...args];
  while (a[0] === '-c') a.splice(0, 2);
  switch (a[0]) {
    case 'rev-parse':
      if (a[1] === '--show-toplevel') return ok(`${repo}\n`);
      if (a[1] === '--git-path') return ok('.git/index.lock\n');
      return ok(`${SHA}\n`);
    case 'status':
      return ok([`# branch.oid ${SHA}`, '# branch.head feat/x', '# branch.upstream origin/feat/x', '# branch.ab +0 -0', '1 .M N... 1 1 1 a b src/a.ts', ''].join('\0'));
    case 'symbolic-ref':
      return ok('origin/main\n');
    case 'merge-base':
      return ok(`${'e'.repeat(40)}\n`);
    case 'rev-list':
      return ok('2\n');
    case 'log':
      return ok('subject\n');
    case 'diff':
      if (a.includes('--numstat')) return ok(['3\t1\tsrc/a.ts', ''].join('\0'));
      if (a.includes('--name-status')) return ok(['M', 'src/a.ts', ''].join('\0'));
      return ok('diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    default:
      return ok('');
  }
};

function ctx(over: Partial<VerseApiContext> = {}): VerseApiContext {
  return { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true, ...over };
}

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, c = ctx()): Promise<{ handled: boolean; res: Captured }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json', 'x-ashlr-token': TOKEN } : {}),
      ...headers,
    },
  });
  const captured: Captured = { status: 0, body: {} };
  const fake: { headersSent: boolean; writableEnded: boolean; writeHead: (status: number) => unknown; setHeader: () => void; end: (chunk?: string) => void } = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      captured.status = status;
      fake.headersSent = true;
      return fake;
    },
    setHeader() {},
    end(chunk?: string) {
      fake.writableEnded = true;
      if (chunk) captured.body = JSON.parse(chunk) as Record<string, unknown>;
    },
  };
  const res = fake as unknown as ServerResponse;
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleGitApi(c, req, res, path, method);
  return { handled, res: captured };
}

const q = (root: string) => encodeURIComponent(root);

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'c5-git-api-'));
  process.env['HOME'] = home;
  repo = join(home, 'code', 'repo');
  other = join(home, 'code', 'other');
  mkdirSync(repo, { recursive: true });
  mkdirSync(other, { recursive: true });
  running = [];
  calls = [];
  invalidateGitCaches();
  setGitApiDepsForTest({
    ops: { runner, countUntracked: async () => ({ lines: 0, binary: false }), exists: () => false },
    knownRoots: () => [repo],
    runningRoots: () => running,
  });
});

afterEach(() => {
  setGitApiDepsForTest(null);
  invalidateGitCaches();
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('GET /api/verse/git/status', () => {
  it('answers for a known root, accepting the ~ spelling the page reads back', async () => {
    const { handled, res } = await call('GET', `/api/verse/git/status?root=${q('~/code/repo')}`);
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ branch: 'feat/x', base: 'main', dirty: 1, suggested: 'commit' });
    // sanitizePublicJson turned the home back into ~ — the page's own key.
    expect(res.body['root']).toBe('~/code/repo');
    expect(res.body['diffstat']).toEqual({ files: 1, additions: 3, deletions: 1 });
  });

  it('refuses a folder Verse does not know, the same way whether or not it exists', async () => {
    const a = await call('GET', `/api/verse/git/status?root=${q(other)}`);
    const b = await call('GET', `/api/verse/git/status?root=${q(join(home, 'nope'))}`);
    expect(a.res.status).toBe(409);
    expect(b.res.status).toBe(409);
    expect(a.res.body['code']).toBe('VERSE_GIT_REFUSED');
    expect(calls).toEqual([]);
  });

  it('refuses the home directory even when it is listed', async () => {
    setGitApiDepsForTest({ ops: { runner }, knownRoots: () => [home] });
    const { res } = await call('GET', `/api/verse/git/status?root=${q(home)}`);
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('400s unknown, repeated or missing parameters', async () => {
    expect((await call('GET', `/api/verse/git/status?root=${q(repo)}&x=1`)).res.status).toBe(400);
    expect((await call('GET', `/api/verse/git/status?root=${q(repo)}&root=${q(repo)}`)).res.status).toBe(400);
    expect((await call('GET', '/api/verse/git/status')).res.status).toBe(400);
    expect((await call('GET', '/api/verse/git/status?root=relative/path')).res.status).toBe(400);
  });

  it('declines paths it does not own, so the mount answers 404', async () => {
    expect((await call('GET', '/api/verse/git/nope')).handled).toBe(false);
    expect((await call('POST', `/api/verse/git/status?root=${q(repo)}`, {})).handled).toBe(false);
    expect((await call('GET', '/api/verse/git/commit')).handled).toBe(false);
  });
});

describe('GET /api/verse/git/diff', () => {
  it('lists files, and a patch for one of them', async () => {
    const list = await call('GET', `/api/verse/git/diff?root=${q(repo)}&scope=branch`);
    expect(list.res.status).toBe(200);
    expect(list.res.body['files']).toEqual([{ path: 'src/a.ts', oldPath: null, status: 'M', additions: 3, deletions: 1, binary: false }]);
    const one = await call('GET', `/api/verse/git/diff?root=${q(repo)}&scope=working&file=src%2Fa.ts`);
    expect((one.res.body['patch'] as { text: string }).text).toContain('+b');
  });

  it('refuses a bad scope, a traversal, and a file with no changes', async () => {
    expect((await call('GET', `/api/verse/git/diff?root=${q(repo)}&scope=all`)).res.status).toBe(400);
    expect((await call('GET', `/api/verse/git/diff?root=${q(repo)}&scope=working&file=..%2F..%2Fetc%2Fpasswd`)).res.status).toBe(400);
    const r = await call('GET', `/api/verse/git/diff?root=${q(repo)}&scope=working&file=README.md`);
    expect(r.res.status).toBe(409);
  });
});

describe('POST gates', () => {
  it('is a 404 without dispatch, 401 without the token, 415 without JSON', async () => {
    const off = await call('POST', '/api/verse/git/push', { root: repo }, {}, ctx({ allowDispatch: false }));
    expect(off.res.status).toBe(404);
    expect((await call('POST', '/api/verse/git/push', { root: repo }, { 'x-ashlr-token': 'wrong' })).res.status).toBe(401);
    expect((await call('POST', '/api/verse/git/push', { root: repo }, { 'content-type': 'text/plain' })).res.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('400s an unknown body key or a malformed field', async () => {
    expect((await call('POST', '/api/verse/git/push', { root: repo, force: true })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/commit', { root: repo, message: '   ' })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/commit', { root: repo, message: 'x', paths: ['../x'] })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/pr', { root: repo, title: 'x', base: 'a b' })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/pr', { root: repo, title: 'x', draft: 'yes' })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/pr/merge', { root: repo, number: 1, headSha: 'HEAD' })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/pr/merge', { root: repo, number: 1.5, headSha: SHA })).res.status).toBe(400);
    expect((await call('POST', '/api/verse/git/worktree', { root: repo, name: '../../x' })).res.status).toBe(400);
  });
});

describe('POST /api/verse/git/commit', () => {
  it('commits and answers with the fresh status', async () => {
    const r = await call('POST', '/api/verse/git/commit', { root: repo, message: 'feat: bar' });
    expect(r.res.status).toBe(200);
    expect(r.res.body['ok']).toBe(true);
    expect((r.res.body['status'] as { branch: string }).branch).toBe('feat/x');
    expect(calls.some((c) => c.includes('commit') && c.includes('feat: bar'))).toBe(true);
  });

  it('is a 409 while a chat turn runs in the same repository', async () => {
    running = [join(repo, 'packages', 'web')];
    const r = await call('POST', '/api/verse/git/commit', { root: repo, message: 'x' });
    expect(r.res.status).toBe(409);
    expect(r.res.body['code']).toBe('VERSE_GIT_BUSY');
    expect(calls.some((c) => c.includes('commit'))).toBe(false);
  });

  it('a chat running in another repository does not block it', async () => {
    running = [other];
    expect((await call('POST', '/api/verse/git/commit', { root: repo, message: 'x' })).res.status).toBe(200);
  });
});
