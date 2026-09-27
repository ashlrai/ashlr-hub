/**
 * 3.15 — Verse wiki routes (/api/verse/wiki/**): enrolled-only repo keys,
 * page reads (scrubbed, cited), background builds (202 + job, never on the
 * request path), Ask, open-in-editor confinement, and the mutation gate.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { realpathSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createWikiApi, DEFAULT_WIKI_API_DEPS, type WikiApiDeps } from '../src/core/verse/wiki-api.js';
import { askWiki, buildWiki, wikiKey } from '../src/core/knowledge/wiki/index.js';
import { startWikiJob } from '../src/core/knowledge/wiki/jobs.js';
import type { WikiJob } from '../src/core/knowledge/wiki/jobs.js';
import type { WikiAskResult, WikiPageView, WikiRepoView, WikiReposView } from '../src/core/knowledge/wiki/types.js';

const TOKEN = 'wiki-test-token';
// Assembled at runtime so no secret-shaped literal is committed (push protection).
const SECRET = ['sk', 'live', '51HabcdefghijklmnopQRSTUV'].join('_');
const FILES: Record<string, string> = {
  'README.md': '# Notes\n\nStores notes.\n',
  'package.json': JSON.stringify({ name: 'notes', scripts: { test: 'vitest run' } }, null, 2) + '\n',
  'src/server.ts': "import { saveNote } from './store/notes.js';\nexport const handle = (b: unknown) => saveNote(b);\n",
  'src/store/notes.ts': `import Database from 'better-sqlite3';\nconst K = "${SECRET}";\nconst db = new Database('notes.sqlite');\nexport function saveNote(n: unknown) {\n  db.prepare('insert').run(n);\n}\n`,
};

let fx: H1Fixture;
let repo: DisposableRepo;
let server: http.Server;
let base: string;
let allowDispatch = true;
const opened: Array<{ path: string; line: number }> = [];
const settled: Array<Promise<WikiJob>> = [];

const deps: WikiApiDeps = {
  ...DEFAULT_WIKI_API_DEPS,
  // Background builds run for real, facts-only (no model in tests).
  startJob: (r, o) => {
    let resolve!: (j: WikiJob) => void;
    settled.push(new Promise<WikiJob>((res) => { resolve = res; }));
    return startWikiJob(r, { cfg: o.cfg, force: o.force, noModel: true, onSettled: (j) => resolve(j) });
  },
  ask: (o) => askWiki({ ...o, resolver: async () => ({ engines: [{ label: 'local:fake', kind: 'test', local: true, complete: async () => '{"found":true,"answer":"Saved via SQLite (src/store/notes.ts:4)."}' }], note: null }) }),
  openInEditor: (p, line) => { opened.push({ path: p, line }); },
  github: async () => 'acme/notes',
};

beforeAll(async () => {
  const api = createWikiApi(deps);
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

beforeEach(async () => {
  fx = makeFixture();
  repo = fx.makeRepo({ files: FILES });
  repo.enroll();
  allowDispatch = true;
  opened.length = 0;
  settled.length = 0;
});

afterEach(async () => {
  await Promise.all(settled);
  fx.cleanup();
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ashlr-token': token } : {}) },
    body: JSON.stringify(body),
  });

describe('/api/verse/wiki', () => {
  it('declines other paths and lists enrolled repos with their wiki state', async () => {
    expect((await get('/api/verse/wikix')).status).toBe(418);
    let view = (await (await get('/api/verse/wiki')).json()) as WikiReposView;
    expect(view.repos.map((r) => r.key)).toEqual([wikiKey(repo.dir)]);
    expect(view.repos[0]!.exists).toBe(false);
    await buildWiki({ repo: repo.dir, noModel: true });
    view = (await (await get('/api/verse/wiki')).json()) as WikiReposView;
    expect(view.repos[0]!.exists).toBe(true);
    expect(view.repos[0]!.pages).toBeGreaterThan(0);
    expect((await get('/api/verse/wiki?x=1')).status).toBe(400);
  }, 30_000);

  it('serves a repo view with per-page freshness and the GitHub base', async () => {
    await buildWiki({ repo: repo.dir, noModel: true });
    const res = await get(`/api/verse/wiki/repo/${wikiKey(repo.dir)}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as WikiRepoView;
    expect(view.status.exists).toBe(true);
    expect(view.status.stalePages).toBe(0);
    expect(view.status.pages.map((p) => p.id)).toContain('overview');
    expect(view.githubUrl).toBe('https://github.com/acme/notes');
  }, 30_000);

  it('never resolves a key outside enrollment', async () => {
    await buildWiki({ repo: repo.dir, noModel: true });
    const key = wikiKey(repo.dir);
    repo.unenroll();
    expect((await get(`/api/verse/wiki/repo/${key}`)).status).toBe(404);
    expect((await get(`/api/verse/wiki/repo/${key}/page/overview`)).status).toBe(404);
    expect((await get('/api/verse/wiki/repo/..%2F..%2Fetc')).status).toBe(404);
  }, 30_000);

  it('serves page markdown with cited links and no secrets', async () => {
    await buildWiki({ repo: repo.dir, noModel: true });
    const res = await get(`/api/verse/wiki/repo/${wikiKey(repo.dir)}/page/data`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as WikiPageView;
    expect(page.meta.id).toBe('data');
    expect(page.markdown).toContain('(#cite:src/store/notes.ts:');
    expect(page.markdown).not.toContain(SECRET);
    expect((await get(`/api/verse/wiki/repo/${wikiKey(repo.dir)}/page/NOPE`)).status).toBe(404);
    expect((await get(`/api/verse/wiki/repo/${wikiKey(repo.dir)}/page/missing`)).status).toBe(404);
  }, 30_000);

  it('builds in the background: 202 + job at once, then the job settles', async () => {
    const key = wikiKey(repo.dir);
    expect((await post(`/api/verse/wiki/repo/${key}/build`, {}, null)).status).toBe(401);
    expect((await post(`/api/verse/wiki/repo/${key}/build`, { bogus: 1 })).status).toBe(400);
    const res = await post(`/api/verse/wiki/repo/${key}/build`, { force: true });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { job: { state: string } }).job.state).toBe('running');
    const job = await settled[0]!;
    expect(job.state).toBe('done');
    const view = (await (await get(`/api/verse/wiki/repo/${key}`)).json()) as WikiRepoView;
    expect(view.status.exists).toBe(true);
    expect(view.job?.state).toBe('done');
  }, 30_000);

  it('answers Ask with verified citations, behind the mutation gate', async () => {
    await buildWiki({ repo: repo.dir, noModel: true });
    expect((await post('/api/verse/wiki/ask', { question: 'How are notes saved?' }, null)).status).toBe(401);
    expect((await post('/api/verse/wiki/ask', { question: '' })).status).toBe(400);
    expect((await post('/api/verse/wiki/ask', { question: 'x', repoKey: 'nope-000000000000' })).status).toBe(409);
    const res = await post('/api/verse/wiki/ask', { question: 'How are notes saved?', repoKey: wikiKey(repo.dir) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WikiAskResult;
    expect(body.status).toBe('answered');
    expect(body.answer).toContain('(#cite:src/store/notes.ts:4)');
  }, 30_000);

  it('opens only files the wiki listed, inside the repo, at a clamped line', async () => {
    await buildWiki({ repo: repo.dir, noModel: true });
    const key = wikiKey(repo.dir);
    expect((await post('/api/verse/wiki/open', { repoKey: key, file: 'src/store/notes.ts', line: 999 })).status).toBe(200);
    expect(opened).toEqual([{ path: realpathSync(`${repo.dir}/src/store/notes.ts`), line: 6 }]);
    expect((await post('/api/verse/wiki/open', { repoKey: key, file: '../../etc/passwd' })).status).toBe(409);
    expect((await post('/api/verse/wiki/open', { repoKey: key, file: '.env' })).status).toBe(409);
    expect((await post('/api/verse/wiki/open', { repoKey: key, file: 'src/store/notes.ts', line: 0 })).status).toBe(400);
    expect(opened).toHaveLength(1);
  }, 30_000);

  it('is 404 for every POST when the server does not allow dispatch', async () => {
    allowDispatch = false;
    expect((await post('/api/verse/wiki/ask', { question: 'x' })).status).toBe(404);
    expect((await post(`/api/verse/wiki/repo/${wikiKey(repo.dir)}/build`, {})).status).toBe(404);
  }, 30_000);
});
