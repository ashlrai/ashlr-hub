/**
 * 3.15 — "Ask the codebase": retrieval over wiki + knowledge index + genome,
 * answers with VERIFIED file:line citations, honest not-found, extractive
 * fallback, local-only routing, and enrollment scoping. Fake model engines;
 * hermetic tmp HOME + disposable enrolled git repos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import { askWiki, buildWiki, wikiKey } from '../src/core/knowledge/wiki/index.js';
import type { WikiEngine, WikiEngineResolver } from '../src/core/knowledge/wiki/model.js';
import { buildKnowledge } from '../src/core/knowledge/index.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fx.cleanup();
});

// Assembled at runtime so no secret-shaped literal is committed (push protection).
const SECRET = ['sk', 'live', '51HabcdefghijklmnopQRSTUV'].join('_');

const FILES: Record<string, string> = {
  'README.md': '# Notes\n\nA tiny HTTP service that stores notes.\n',
  'package.json': JSON.stringify({ name: 'notes', scripts: { test: 'vitest run' } }, null, 2) + '\n',
  'src/server.ts': "import { saveNote } from './store/notes.js';\nexport function handle(body: unknown) {\n  return saveNote(body);\n}\n",
  'src/store/notes.ts': [
    "import Database from 'better-sqlite3';",
    `const KEY = "${SECRET}";`,
    '',
    "const db = new Database('notes.sqlite');",
    'export function saveNote(note: unknown): void {',
    "  db.prepare('insert into notes values (?)').run(JSON.stringify(note));",
    '}',
    '',
  ].join('\n'),
  '.ashlrcode/genome/decisions.md': '# Persistence decision\n\nWe chose SQLite over Postgres because the service is single-node.\n',
};

async function builtRepo(files: Record<string, string> = FILES): Promise<DisposableRepo> {
  const repo = fx.makeRepo({ files });
  repo.enroll();
  const res = await buildWiki({ repo: repo.dir, noModel: true });
  expect(res.ok).toBe(true);
  return repo;
}

function engine(reply: string, opts: { local?: boolean } = {}): WikiEngine & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    label: opts.local === false ? 'grok:fake' : 'local:fake',
    kind: 'test',
    local: opts.local ?? true,
    prompts,
    complete: async (_s, user) => {
      prompts.push(user);
      return reply;
    },
  };
}

const resolverOf = (...engines: WikiEngine[]): WikiEngineResolver => async () => ({ engines, note: null });

describe('askWiki', () => {
  it('answers with verified citations, from passages that never carry secrets', async () => {
    const repo = await builtRepo();
    const e = engine(JSON.stringify({ found: true, answer: 'Notes are written with SQLite in saveNote (src/store/notes.ts:5-6); bogus src/store/notes.ts:500.' }));
    const res = await askWiki({ question: 'How are notes saved to sqlite?', repo: repo.dir, resolver: resolverOf(e) });
    expect(res.status).toBe('answered');
    expect(res.repoKey).toBe(wikiKey(repo.dir));
    expect(res.answer).toContain('[src/store/notes.ts:5-6](#cite:src/store/notes.ts:5-6)');
    expect(res.answer).not.toContain('#cite:src/store/notes.ts:500');
    expect(res.droppedCitations).toBe(1);
    expect(res.local).toBe(true);
    expect(res.sources.length).toBeGreaterThan(0);
    expect(e.prompts).toHaveLength(1);
    expect(e.prompts[0]).not.toContain(SECRET);
  }, 30_000);

  it('uses genome notes as evidence', async () => {
    const repo = await builtRepo();
    const res = await askWiki({ question: 'Why SQLite instead of Postgres?', repo: repo.dir, noModel: true });
    expect(res.status).toBe('extractive');
    expect(res.sources.some((s) => s.via === 'genome')).toBe(true);
  }, 30_000);

  it('says not found — without calling a model — when nothing covers the question', async () => {
    const repo = await builtRepo();
    const e = engine('{"found":true,"answer":"made up"}');
    const res = await askWiki({ question: 'How is the kubernetes helm chart rolled out to production clusters?', repo: repo.dir, resolver: resolverOf(e) });
    expect(res.status).toBe('not-found');
    expect(res.answer).toMatch(/^Not found/);
    expect(e.prompts).toHaveLength(0);
  }, 30_000);

  it('says not found when the model says the passages do not answer it', async () => {
    const repo = await builtRepo();
    const res = await askWiki({ question: 'How are notes saved?', repo: repo.dir, resolver: resolverOf(engine('{"found":false,"answer":"The passages do not say."}')) });
    expect(res.status).toBe('not-found');
  }, 30_000);

  it('withholds an answer that carries no verifiable citation', async () => {
    const repo = await builtRepo();
    const res = await askWiki({ question: 'How are notes saved?', repo: repo.dir, resolver: resolverOf(engine('{"found":true,"answer":"They are saved somewhere, trust me."}')) });
    expect(res.status).toBe('not-found');
    expect(res.answer).toContain('withheld');
    expect(res.answer).not.toContain('trust me');
  }, 30_000);

  it('falls back to extractive passages when no engine is available', async () => {
    const repo = await builtRepo();
    const res = await askWiki({ question: 'How are notes saved?', repo: repo.dir, resolver: async () => ({ engines: [], note: 'No local model is running.' }) });
    expect(res.status).toBe('extractive');
    expect(res.answer).toContain('No local model is running.');
    expect(res.answer).toMatch(/#cite:/);
  }, 30_000);

  it('keeps a local-only repo off remote engines', async () => {
    const repo = await builtRepo({ ...FILES, '.ashlr/wiki.json': JSON.stringify({ localOnly: true }) });
    const remote = engine('{"found":true,"answer":"src/store/notes.ts:5"}', { local: false });
    const res = await askWiki({ question: 'How are notes saved?', repo: repo.dir, resolver: resolverOf(remote) });
    expect(remote.prompts).toHaveLength(0);
    expect(res.status).toBe('extractive');
  }, 30_000);

  it('retrieves from the knowledge index built by `ashlr knowledge build` (path-hash parity)', async () => {
    // No Ollama in tests: the index builds keyword-only without waiting on a probe.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const repo = await builtRepo();
    await buildKnowledge({ repos: [repo.dir] });
    const res = await askWiki({ question: 'insert into notes values', repo: repo.dir, noModel: true });
    expect(res.sources.some((s) => s.via === 'index' && s.file === 'src/store/notes.ts')).toBe(true);
  }, 30_000);

  it('answers from the best-matching repo when no repo is given, and serves only enrolled repos', async () => {
    const a = await builtRepo();
    const b = await builtRepo({
      'README.md': '# Billing\n\nInvoices and Stripe webhooks.\n',
      'src/invoice.ts': 'export function createInvoice(amountCents: number) {\n  return { amountCents, status: "draft" };\n}\n',
    });
    const res = await askWiki({ question: 'How is an invoice created?', noModel: true });
    expect(res.repoKey).toBe(wikiKey(b.dir));

    b.unenroll();
    const after = await askWiki({ question: 'How is an invoice created?', noModel: true });
    expect(after.repoKey === null || after.repoKey === wikiKey(a.dir)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(b.dir);
  }, 45_000);

  it('handles an empty question and a repo with no wiki', async () => {
    expect((await askWiki({ question: '   ' })).status).toBe('not-found');
    const repo = fx.makeRepo({ files: FILES });
    repo.enroll();
    const res = await askWiki({ question: 'anything', repo: repo.dir });
    expect(res.status).toBe('not-found');
    expect(res.answer).toContain('no wiki yet');
  }, 30_000);
});
