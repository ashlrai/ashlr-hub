/**
 * 3.15 — private repo wiki: generation with a FAKE model, citation
 * verification, secret scrubbing, incremental (hash-based) regeneration,
 * staleness, budgets, steering (.ashlr/wiki.json + .devin/wiki.json) and the
 * local-only rule. Hermetic: tmp HOME + disposable enrolled git repos.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import { buildWiki, wikiStatus, readPage, readManifest, wikiKey, wikiRoot } from '../src/core/knowledge/wiki/index.js';
import type { WikiEngine, WikiEngineResolver } from '../src/core/knowledge/wiki/model.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

// Assembled at runtime so no secret-shaped literal is committed (push protection).
const SECRET = ['sk', 'live', '51HabcdefghijklmnopQRSTUV'].join('_');

const FILES: Record<string, string> = {
  // The README summary is quoted in the Overview reference (and so its prompt).
  'README.md': `# Demo Service\n\nA tiny HTTP service that stores notes in SQLite. Deploy token ghp_${'Z'.repeat(36)} lives here by mistake.\n`,
  'package.json': JSON.stringify(
    { name: 'demo-service', description: 'Stores notes.', main: 'src/server.ts', scripts: { build: 'tsc', test: 'vitest run', start: 'node dist/server.js' } },
    null,
    2,
  ) + '\n',
  'src/server.ts': [
    "import express from 'express';",
    "import { saveNote } from './store/notes.js';",
    '',
    'const app = express();',
    "app.post('/api/notes', (req, res) => {",
    '  saveNote(req.body);',
    '  res.json({ ok: true });',
    '});',
    'app.listen(Number(process.env.PORT ?? 3000));',
    '',
  ].join('\n'),
  'src/store/notes.ts': [
    "import Database from 'better-sqlite3';",
    "import { validate } from '../util/validate.js';",
    '',
    `const STRIPE = "${SECRET}";`,
    "const db = new Database('notes.sqlite');",
    '',
    'export function saveNote(note: unknown): void {',
    '  validate(note);',
    "  db.prepare('insert into notes values (?)').run(JSON.stringify(note));",
    '}',
    '',
  ].join('\n'),
  'src/store/index.ts': "export * from './notes.js';\n",
  'src/util/validate.ts': 'export function validate(v: unknown): void {\n  if (v === null) throw new Error("empty");\n}\n',
  'test/notes.test.ts': "import { saveNote } from '../src/store/notes.js';\nsaveNote({});\n",
  '.env': 'DATABASE_URL=postgres://user:hunter2@db/prod\n',
};

function makeRepo(files: Record<string, string> = FILES): DisposableRepo {
  const repo = fx.makeRepo({ files });
  repo.enroll();
  return repo;
}

function commitAll(repo: DisposableRepo, message = 'change'): void {
  execFileSync('git', ['-C', repo.dir, 'add', '-A']);
  execFileSync('git', ['-C', repo.dir, 'commit', '--no-verify', '-q', '-m', message]);
}

interface FakeEngine extends WikiEngine {
  prompts: string[];
}

function fakeEngine(reply: (user: string) => string, opts: { local?: boolean; label?: string } = {}): FakeEngine {
  const prompts: string[] = [];
  return {
    label: opts.label ?? 'test:fake',
    kind: 'test',
    local: opts.local ?? true,
    prompts,
    complete: async (_system, user) => {
      prompts.push(user);
      return reply(user);
    },
  };
}

function resolverOf(...engines: WikiEngine[]): WikiEngineResolver {
  return async () => ({ engines, note: null });
}

const citingReply = (): string =>
  JSON.stringify({
    markdown: [
      'The service accepts notes over HTTP (src/server.ts:5) and persists them with SQLite (`src/store/notes.ts:5`).',
      '',
      `It also leaks ${SECRET} in prose, which must be scrubbed.`,
      '',
      'Bogus claims: src/server.ts:999 and src/missing.ts:3 must not survive as citations.',
    ].join('\n'),
  });

describe('buildWiki', () => {
  it('generates the built-in pages with verified citations, privately, at HEAD', async () => {
    const repo = makeRepo();
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.manifest.pages.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['overview', 'modules', 'flows', 'data', 'commands']));
    expect(ids.some((id) => id.startsWith('change-'))).toBe(true);
    const head = execFileSync('git', ['-C', repo.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(res.manifest.commit).toBe(head);

    // Stored under the (tmp) HOME, never in the repo, with private modes.
    const dir = path.join(wikiRoot(), wikiKey(repo.dir));
    expect(dir.startsWith(fx.home)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(repo.gitStatus()).toBe('');

    const overview = (await readPage(wikiKey(repo.dir), 'overview'))!;
    expect(overview).toContain('[src/server.ts:5](#cite:src/server.ts:5)');
    expect(overview).toContain('[src/store/notes.ts:5](#cite:src/store/notes.ts:5)');
    // Unverifiable citations lose their line and are counted.
    expect(overview).not.toContain('#cite:src/server.ts:999');
    expect(overview).not.toContain('#cite:src/missing.ts');
    const meta = res.manifest.pages.find((p) => p.id === 'overview')!;
    expect(meta.droppedCitations).toBeGreaterThanOrEqual(2);
    expect(meta.model).toBe('test:fake');
  }, 30_000);

  it('never stores or sends secrets, and never reads secret files', async () => {
    const repo = makeRepo();
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(res.ok).toBe(true);
    const dir = path.join(wikiRoot(), wikiKey(repo.dir));
    for (const p of (await readManifest(wikiKey(repo.dir)))!.pages) {
      const md = readFileSync(path.join(dir, 'pages', `${p.id}.md`), 'utf8');
      expect(md).not.toContain(SECRET);
      expect(md).not.toContain('ghp_ZZZZ');
      expect(md).not.toContain('hunter2');
    }
    expect(engine.prompts.some((p) => p.includes('A tiny HTTP service'))).toBe(true);
    for (const prompt of engine.prompts) {
      expect(prompt).not.toContain('ghp_ZZZZ');
      expect(prompt).not.toContain(SECRET);
      expect(prompt).not.toContain('hunter2');
      expect(prompt).not.toContain('DATABASE_URL');
    }
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'files.json'), 'utf8')) as object)).not.toContain('.env');
  }, 30_000);

  it('builds a complete facts-only wiki when no model is allowed', async () => {
    const repo = makeRepo();
    const res = await buildWiki({ repo: repo.dir, noModel: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.pages.every((p) => p.model === 'facts-only')).toBe(true);
    const modules = (await readPage(wikiKey(repo.dir), 'modules'))!;
    expect(modules).toContain('| Module |');
    expect(modules).toMatch(/\(#cite:src\/store\/notes\.ts:\d+\)/);
    const data = (await readPage(wikiKey(repo.dir), 'data'))!;
    expect(data).toContain('SQLite');
    expect(data).toContain('`PORT`');
    const commands = (await readPage(wikiKey(repo.dir), 'commands'))!;
    expect(commands).toContain('`vitest run`');
  }, 30_000);

  it('regenerates only stale pages after a commit, and reports staleness first', async () => {
    const repo = makeRepo();
    const engine = fakeEngine(citingReply);
    const first = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(first.ok).toBe(true);
    const calls = engine.prompts.length;

    // No change: everything fresh, no model call.
    const again = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(again.ok && again.summary.generated).toBe(0);
    expect(engine.prompts.length).toBe(calls);
    expect((await wikiStatus(repo.dir)).stalePages).toBe(0);

    // Touch one util file and commit.
    repo.writeFile('src/util/validate.ts', 'export function validate(v: unknown): void {\n  if (v == null) throw new Error("empty note");\n}\n');
    commitAll(repo);
    const status = await wikiStatus(repo.dir);
    expect(status.currentCommit).not.toBe(status.generatedCommit);
    const stale = status.pages.filter((p) => p.stale).map((p) => p.id);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale).not.toContain('commands');
    expect(stale.length).toBeLessThan(status.pages.length);

    const third = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.summary.generated).toBe(stale.length);
    expect(third.summary.skippedFresh).toBe(status.pages.length - stale.length);
    expect((await wikiStatus(repo.dir)).stalePages).toBe(0);
  }, 45_000);

  it('bounds model calls by the page budget and upgrades the rest next run', async () => {
    const repo = makeRepo();
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine), pageBudget: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(engine.prompts.length).toBe(2);
    expect(res.summary.budgetStop).toBe('pages');
    expect(res.manifest.pending.length).toBe(res.manifest.pages.length - 2);
    // Every planned page exists (facts-only past the budget).
    for (const p of res.manifest.pages) expect(await readPage(res.manifest.key, p.id)).toContain('## Reference');
    expect((await wikiStatus(repo.dir)).stalePages).toBe(res.manifest.pending.length);

    const next = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine), pageBudget: 50 });
    expect(next.ok && next.manifest.pending).toEqual([]);
    expect(next.ok && next.manifest.pages.every((p) => p.model === 'test:fake')).toBe(true);
  }, 45_000);

  it('bounds model calls by the token budget', async () => {
    const repo = makeRepo();
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine), tokenBudget: 1_000 });
    expect(res.ok).toBe(true);
    expect(engine.prompts.length).toBe(0);
    expect(res.ok && res.summary.budgetStop).toBe('tokens');
  }, 30_000);

  it('refuses repos that are not enrolled', async () => {
    const repo = fx.makeRepo({ files: FILES });
    const res = await buildWiki({ repo: repo.dir, noModel: true });
    expect(res.ok).toBe(false);
    expect(existsSync(path.join(wikiRoot(), wikiKey(repo.dir), 'manifest.json'))).toBe(false);
  }, 30_000);

  it('keeps local-only repos off remote engines', async () => {
    const repo = makeRepo({ ...FILES, '.ashlr/wiki.json': JSON.stringify({ localOnly: true }) });
    const remote = fakeEngine(citingReply, { local: false, label: 'grok:fake' });
    const local = fakeEngine(citingReply, { local: true, label: 'local:fake' });
    let asked: boolean | null = null;
    const resolver: WikiEngineResolver = async (req) => {
      asked = req.localOnly;
      return { engines: [remote, local], note: null };
    };
    const res = await buildWiki({ repo: repo.dir, resolver });
    expect(res.ok).toBe(true);
    expect(asked).toBe(true);
    expect(remote.prompts.length).toBe(0);
    expect(local.prompts.length).toBeGreaterThan(0);
  }, 30_000);

  it('follows .ashlr/wiki.json steering: exclude, focus, notes and custom pages', async () => {
    const repo = makeRepo({
      ...FILES,
      '.ashlr/wiki.json': JSON.stringify({
        exclude: ['commands'],
        focus: ['src/store'],
        notes: ['Notes are append-only.'],
        pages: [{ title: 'Validation', purpose: 'How input validation works.', parent: 'Overview' }],
      }),
    });
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.manifest.pages.map((p) => p.id);
    expect(ids).not.toContain('commands');
    expect(ids).toContain('change-src-store');
    expect(ids).toContain('custom-validation');
    expect(res.manifest.pages.find((p) => p.id === 'custom-validation')!.parent).toBe('overview');
    expect(engine.prompts.every((p) => p.includes('Notes are append-only.'))).toBe(true);
  }, 30_000);

  it('honours .devin/wiki.json: its page list defines the wiki', async () => {
    const repo = makeRepo({
      ...FILES,
      '.devin/wiki.json': JSON.stringify({
        repo_notes: [{ content: 'Focus on persistence.' }],
        pages: [
          { title: 'Persistence', purpose: 'How notes are stored.' },
          { title: 'HTTP API', purpose: 'The endpoints.', parent: 'Persistence', page_notes: [{ content: 'Mention POST /api/notes.' }] },
        ],
      }),
    });
    const engine = fakeEngine(citingReply);
    const res = await buildWiki({ repo: repo.dir, resolver: resolverOf(engine) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.pages.map((p) => p.id)).toEqual(['overview', 'custom-persistence', 'custom-http-api']);
    expect(res.manifest.pages[2]!.parent).toBe('custom-persistence');
    expect(engine.prompts.some((p) => p.includes('Mention POST /api/notes.'))).toBe(true);
    expect(engine.prompts.every((p) => p.includes('Focus on persistence.'))).toBe(true);
  }, 30_000);

  it('marks every page stale when steering changes', async () => {
    const repo = makeRepo();
    const res = await buildWiki({ repo: repo.dir, noModel: true });
    expect(res.ok).toBe(true);
    repo.writeFile('.ashlr/wiki.json', JSON.stringify({ notes: ['new guidance'] }));
    const status = await wikiStatus(repo.dir);
    expect(status.stalePages).toBe(status.pages.length);
  }, 30_000);
});
