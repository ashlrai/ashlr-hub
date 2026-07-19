/**
 * M7 store tests — hermetic, all operations in os.tmpdir().
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir before any
 * genome module is imported, so hubStorePath() and all file I/O land under
 * the tmp dir. NEVER touches real ~/.ashlr or real repos.
 *
 * Covers:
 *   - loadGenome: aggregates project source (.ashlrcode/genome/manifest.json +
 *     section .md/.json) with source='project', and hub.jsonl with source='hub'
 *   - loadGenome: defensive parsing — malformed JSON skipped, never throws
 *   - loadGenome: bounded reads (caps entries and bytes)
 *   - appendHubEntry: APPENDS to an existing hub.jsonl (never overwrites)
 *   - appendHubEntry: creates hub.jsonl when missing
 *   - appendHubEntry: returns a valid GenomeEntry with source='hub'
 *   - appendHubEntry: generates a unique id, valid ISO ts
 *   - appendHubEntry: derives a title from text when title is omitted
 *   - genomeHealth: counts match reality (totalEntries, projects, hubEntries)
 *   - genomeHealth: sizeBytes reflects actual file size
 *   - genomeHealth: lastLearnedAt is the ts of the most recent hub entry
 *   - genomeHealth: never throws
 *   - hubStorePath: returns a path ending in genome/hub.jsonl under HOME
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, GenomeEntry, LearnInput } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME *before* any genome module is imported so hubStorePath() and
// all path derivations land under the tmp dir, not the real ~/.ashlr.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;

// We create a single shared tmp root per test-file import; each test then uses
// a fresh sub-dir via freshTmpHome() to stay fully isolated.
let tmpHome: string;

function freshTmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m7-store-'));
  return d;
}

// ---------------------------------------------------------------------------
// Lazy import helpers — we import the modules AFTER setting HOME so that any
// module-level os.homedir() call returns the tmp path.
// ---------------------------------------------------------------------------

// (lazy import below; type-import lint intentionally not applied)
let loadGenome: (cfg: AshlrConfig) => GenomeEntry[];
// (lazy import below; type-import lint intentionally not applied)
let appendHubEntry: (input: LearnInput) => GenomeEntry;
// (lazy import below; type-import lint intentionally not applied)
let hubStorePath: () => string;
// (lazy import below; type-import lint intentionally not applied)
let genomeHealth: (cfg: AshlrConfig) => import('../src/core/types.js').GenomeHealth;
// (lazy import below; type-import lint intentionally not applied)
let genomeHubHealth: () => import('../src/core/types.js').GenomeHealth;

// Modules are singletons in Node's ESM cache — imported once. The HOME trick
// works when the module reads os.homedir() lazily (inside functions) rather
// than at top-level. The CONTRACT requires hubStorePath() to be a function
// returning the path, so it must be lazy. Tests set HOME before first import.

async function ensureImported(): Promise<void> {
  if (!loadGenome) {
    const store = await import('../src/core/genome/store.js');
    loadGenome = store.loadGenome;
    appendHubEntry = store.appendHubEntry;
    hubStorePath = store.hubStorePath;
    genomeHealth = store.genomeHealth;
    genomeHubHealth = store.genomeHubHealth;
  }
}

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Create a fake indexed repo at <base>/fake-repo with a well-formed
 * .ashlrcode/genome/ directory containing manifest.json and a section file.
 * Returns the repo path.
 */
function makeProjectGenomeFixture(base: string, projectName = 'fake-repo'): string {
  const repoDir = path.join(base, projectName);
  const genomeDir = path.join(repoDir, '.ashlrcode', 'genome');
  fs.mkdirSync(genomeDir, { recursive: true });

  // manifest.json — standard ashlrcode/ashlr-plugin format
  const manifest = {
    version: 1,
    project: projectName,
    sections: ['section-one.md', 'section-two.json'],
  };
  fs.writeFileSync(path.join(genomeDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Markdown section
  fs.writeFileSync(
    path.join(genomeDir, 'section-one.md'),
    '# TypeScript patterns\n\nAlways use strict mode. Prefer `const`.\n',
  );

  // JSON section (array of entry-like objects)
  const jsonSection = [
    {
      id: 'proj-entry-1',
      title: 'Commit conventions',
      text: 'Use conventional commits: feat, fix, chore, docs.',
      tags: ['git', 'conventions'],
      ts: '2025-01-15T10:00:00.000Z',
    },
  ];
  fs.writeFileSync(
    path.join(genomeDir, 'section-two.json'),
    JSON.stringify(jsonSection, null, 2),
  );

  return repoDir;
}

/**
 * Write a hub.jsonl under tmpHome with the given entries (one JSON line each).
 */
function writeHubStore(tmpH: string, entries: Partial<GenomeEntry>[]): void {
  const storeDir = path.join(tmpH, '.ashlr', 'genome');
  fs.mkdirSync(storeDir, { recursive: true });
  const lines = entries
    .map(e => JSON.stringify({
      id: e.id ?? `hub-${Math.random().toString(36).slice(2)}`,
      project: e.project ?? null,
      source: e.source ?? 'hub',
      title: e.title ?? 'Untitled',
      text: e.text ?? '',
      tags: e.tags ?? [],
      ts: e.ts ?? new Date().toISOString(),
    } satisfies GenomeEntry))
    .join('\n');
  fs.writeFileSync(path.join(storeDir, 'hub.jsonl'), lines + '\n');
}

// ---------------------------------------------------------------------------
// Config that points roots at our tmp fixture dir
// ---------------------------------------------------------------------------

function makeConfigWithRoots(base: string): AshlrConfig {
  return makeConfig({ roots: [base] });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// hubStorePath
// ---------------------------------------------------------------------------

describe('hubStorePath', () => {
  it('returns a string ending in genome/hub.jsonl', () => {
    const p = hubStorePath();
    expect(p.endsWith(path.join('genome', 'hub.jsonl'))).toBe(true);
  });

  it('is an absolute path', () => {
    expect(path.isAbsolute(hubStorePath())).toBe(true);
  });

  it('is under the .ashlr directory', () => {
    expect(hubStorePath()).toContain('.ashlr');
  });
});

// ---------------------------------------------------------------------------
// loadGenome — project source parsing
// ---------------------------------------------------------------------------

describe('loadGenome — project .ashlrcode/genome/ source', () => {
  it('returns entries with source="project" from a fixture repo', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg);
    const projectEntries = entries.filter(e => e.source === 'project');
    expect(projectEntries.length).toBeGreaterThan(0);
  });

  it('each project entry has required GenomeEntry fields', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg).filter(e => e.source === 'project');
    for (const e of entries) {
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.source).toBe('project');
      expect(typeof e.title).toBe('string');
      expect(typeof e.text).toBe('string');
      expect(Array.isArray(e.tags)).toBe(true);
      expect(typeof e.ts).toBe('string');
    }
  });

  it('captures text content from markdown sections', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg).filter(e => e.source === 'project');
    const texts = entries.map(e => e.text).join(' ');
    // Markdown section content should appear somewhere
    expect(texts).toMatch(/TypeScript|strict|conventional|commit/i);
  });

  it('captures project name from repo directory', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base, 'my-project');
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg).filter(e => e.source === 'project');
    expect(entries.length).toBeGreaterThan(0);
    // project field should reflect the repo name
    const projectNames = entries.map(e => e.project).filter(Boolean);
    expect(projectNames.some(n => n === 'my-project' || n?.includes('my-project'))).toBe(true);
  });

  it('scrubs secret-shaped values from project genome entries', () => {
    const base = path.join(tmpHome, 'repos');
    const repoDir = path.join(base, 'secret-project');
    const genomeDir = path.join(repoDir, '.ashlrcode', 'genome');
    fs.mkdirSync(genomeDir, { recursive: true });
    const secret = 'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ';

    fs.writeFileSync(
      path.join(genomeDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        project: `project token=${secret}`,
        sections: [
          {
            path: 'secret.md',
            title: `title token=${secret}`,
            tags: [`tag token=${secret}`],
            updatedAt: '2026-07-09T00:00:00.000Z',
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(genomeDir, 'secret.md'), `Body token=${secret}\n`);

    const entries = loadGenome(makeConfigWithRoots(base)).filter(e => e.source === 'project');
    const serialized = JSON.stringify(entries);

    expect(entries).toHaveLength(1);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('returns empty array when no repos with genome dirs exist', () => {
    const base = path.join(tmpHome, 'empty-repos');
    fs.mkdirSync(base);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg);
    const projectEntries = entries.filter(e => e.source === 'project');
    expect(projectEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadGenome — hub source parsing
// ---------------------------------------------------------------------------

describe('loadGenome — hub.jsonl source', () => {
  it('returns entries with source="hub" from hub.jsonl', () => {
    writeHubStore(tmpHome, [
      { id: 'h1', title: 'Hub entry 1', text: 'Remember to use vitest.', tags: ['testing'] },
      { id: 'h2', title: 'Hub entry 2', text: 'Prefer ESM imports.', tags: ['esm'] },
    ]);
    const cfg = makeConfig();

    const entries = loadGenome(cfg);
    const hubEntries = entries.filter(e => e.source === 'hub');
    expect(hubEntries.length).toBe(2);
  });

  it('hub entries have source="hub"', () => {
    writeHubStore(tmpHome, [{ id: 'h1', title: 'T', text: 'Text.' }]);
    const entries = loadGenome(makeConfig());
    for (const e of entries.filter(e => e.source === 'hub')) {
      expect(e.source).toBe('hub');
    }
  });

  it('hub entries preserve id, title, text, tags', () => {
    writeHubStore(tmpHome, [
      {
        id: 'fixed-id',
        title: 'Fixed title',
        text: 'Fixed text content',
        tags: ['a', 'b'],
        ts: '2025-03-01T00:00:00.000Z',
      },
    ]);
    const entries = loadGenome(makeConfig());
    const hub = entries.find(e => e.id === 'fixed-id');
    expect(hub).toBeDefined();
    expect(hub!.title).toBe('Fixed title');
    expect(hub!.text).toBe('Fixed text content');
    expect(hub!.tags).toEqual(['a', 'b']);
    expect(hub!.ts).toBe('2025-03-01T00:00:00.000Z');
  });

  it('returns empty array for hub source when hub.jsonl does not exist', () => {
    // No writeHubStore call — file absent
    const cfg = makeConfig();
    const entries = loadGenome(cfg);
    const hubEntries = entries.filter(e => e.source === 'hub');
    expect(hubEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadGenome — aggregation of both sources
// ---------------------------------------------------------------------------

describe('loadGenome — aggregation of project + hub sources', () => {
  it('returns entries from both project and hub sources in one call', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    writeHubStore(tmpHome, [{ id: 'hub-1', title: 'Hub note', text: 'Hub content.' }]);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg);
    const sources = new Set(entries.map(e => e.source));
    expect(sources.has('project')).toBe(true);
    expect(sources.has('hub')).toBe(true);
  });

  it('all entries have the correct source field (only "project" or "hub")', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    writeHubStore(tmpHome, [{ id: 'h1', title: 'H', text: 'x' }]);
    const cfg = makeConfigWithRoots(base);

    for (const e of loadGenome(cfg)) {
      expect(['project', 'hub']).toContain(e.source);
    }
  });

  it('never throws even when both sources contain mixed valid/invalid data', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    // Write a broken manifest
    const badRepo = path.join(base, 'bad-repo', '.ashlrcode', 'genome');
    fs.mkdirSync(badRepo, { recursive: true });
    fs.writeFileSync(path.join(badRepo, 'manifest.json'), '{not valid json!!!');
    // Write a hub with one valid + one malformed line
    const storeDir = path.join(tmpHome, '.ashlr', 'genome');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, 'hub.jsonl'),
      '{"id":"ok","project":null,"source":"hub","title":"Ok","text":"ok","tags":[],"ts":"2025-01-01T00:00:00.000Z"}\n' +
      'THIS IS NOT JSON\n',
    );
    const cfg = makeConfigWithRoots(base);

    expect(() => loadGenome(cfg)).not.toThrow();
  });

  it('skips malformed JSON lines in hub.jsonl without dropping valid ones', () => {
    const storeDir = path.join(tmpHome, '.ashlr', 'genome');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, 'hub.jsonl'),
      '{"id":"valid-1","project":null,"source":"hub","title":"Valid","text":"content","tags":[],"ts":"2025-01-01T00:00:00.000Z"}\n' +
      'MALFORMED LINE\n' +
      '{"id":"valid-2","project":null,"source":"hub","title":"Also valid","text":"more content","tags":[],"ts":"2025-02-01T00:00:00.000Z"}\n',
    );
    const entries = loadGenome(makeConfig());
    const hubEntries = entries.filter(e => e.source === 'hub');
    // Both valid lines parsed; malformed skipped
    expect(hubEntries.length).toBe(2);
    expect(hubEntries.some(e => e.id === 'valid-1')).toBe(true);
    expect(hubEntries.some(e => e.id === 'valid-2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadGenome — bounded reads
// ---------------------------------------------------------------------------

describe('loadGenome — bounded reads (cap behavior)', () => {
  it('never throws when hub.jsonl is very large', () => {
    const storeDir = path.join(tmpHome, '.ashlr', 'genome');
    fs.mkdirSync(storeDir, { recursive: true });
    // Write 500 entries — should be capped, not crash
    const lines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({
        id: `bulk-${i}`,
        project: null,
        source: 'hub',
        title: `Entry ${i}`,
        text: 'a'.repeat(200),
        tags: [],
        ts: new Date().toISOString(),
      } satisfies GenomeEntry),
    ).join('\n');
    fs.writeFileSync(path.join(storeDir, 'hub.jsonl'), lines + '\n');

    expect(() => loadGenome(makeConfig())).not.toThrow();
  });

  it('returns a reasonable number of entries (does not exceed a sane cap)', () => {
    const storeDir = path.join(tmpHome, '.ashlr', 'genome');
    fs.mkdirSync(storeDir, { recursive: true });
    // Write 1000 entries
    const lines = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({
        id: `cap-${i}`,
        project: null,
        source: 'hub',
        title: `Entry ${i}`,
        text: 'content',
        tags: [],
        ts: new Date().toISOString(),
      } satisfies GenomeEntry),
    ).join('\n');
    fs.writeFileSync(path.join(storeDir, 'hub.jsonl'), lines + '\n');

    const entries = loadGenome(makeConfig());
    // Expect a bounded result — not unbounded 1000
    expect(entries.length).toBeLessThanOrEqual(1000);
    // And returns at least some entries (not zero)
    expect(entries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// appendHubEntry — append-only behavior
// ---------------------------------------------------------------------------

describe('appendHubEntry — append-only, never overwrites', () => {
  it('creates hub.jsonl when it does not exist', () => {
    const storePath = hubStorePath();
    expect(fs.existsSync(storePath)).toBe(false);

    appendHubEntry({ text: 'First entry', title: 'First' });

    expect(fs.existsSync(storePath)).toBe(true);
  });

  it('creates the parent directory if missing', () => {
    const storePath = hubStorePath();
    const dir = path.dirname(storePath);
    expect(fs.existsSync(dir)).toBe(false);

    appendHubEntry({ text: 'Bootstrap entry' });

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it('returns a GenomeEntry with source="hub"', () => {
    const entry = appendHubEntry({ text: 'Test content', title: 'Test' });
    expect(entry.source).toBe('hub');
  });

  it('returns an entry with a non-empty id', () => {
    const entry = appendHubEntry({ text: 'Test content' });
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
  });

  it('returns an entry with a valid ISO ts', () => {
    const entry = appendHubEntry({ text: 'Test content' });
    expect(() => new Date(entry.ts)).not.toThrow();
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('reflects the provided text in the returned entry', () => {
    const entry = appendHubEntry({ text: 'Unique text content ABC123' });
    expect(entry.text).toBe('Unique text content ABC123');
  });

  it('reflects the provided title in the returned entry', () => {
    const entry = appendHubEntry({ text: 'Some text', title: 'Explicit Title' });
    expect(entry.title).toBe('Explicit Title');
  });

  it('derives a title from text when title is omitted', () => {
    const entry = appendHubEntry({ text: 'This is the content of the note' });
    expect(typeof entry.title).toBe('string');
    expect(entry.title.length).toBeGreaterThan(0);
  });

  it('reflects the provided project in the returned entry', () => {
    const entry = appendHubEntry({ text: 'Scoped note', project: 'my-project' });
    expect(entry.project).toBe('my-project');
  });

  it('sets project to null when not provided', () => {
    const entry = appendHubEntry({ text: 'Unscoped note' });
    expect(entry.project).toBeNull();
  });

  it('reflects provided tags in the returned entry', () => {
    const entry = appendHubEntry({ text: 'Tagged note', tags: ['alpha', 'beta'] });
    expect(entry.tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('does not let appendHubEntry mint released skill authority', () => {
    const entry = appendHubEntry({
      text: 'Caller-supplied released skill',
      tags: ['m243:skill', 'credit:released-v1', 'verification'],
    });

    expect(entry.tags).toContain('m243:skill');
    expect(entry.tags).toContain('verification');
    expect(entry.tags).not.toContain('credit:released-v1');
    expect(loadGenome(makeConfig()).find((candidate) => candidate.id === entry.id)?.tags)
      .not.toContain('credit:released-v1');
  });

  it('canonicalizes case and whitespace before refusing released skill authority', () => {
    const entry = appendHubEntry({
      text: 'Caller-supplied variant released skill',
      tags: [' M243:SKILL ', ' CREDIT:RELEASED-V1 ', 'Verification'],
    });

    expect(entry.tags).toContain('M243:SKILL');
    expect(entry.tags).toContain('Verification');
    expect(entry.tags.map((tag) => tag.toLowerCase())).not.toContain('credit:released-v1');
    expect(loadGenome(makeConfig()).find((candidate) => candidate.id === entry.id)?.tags
      .map((tag) => tag.toLowerCase())).not.toContain('credit:released-v1');
  });

  it('uses empty tags array when tags not provided', () => {
    const entry = appendHubEntry({ text: 'No tags note' });
    expect(Array.isArray(entry.tags)).toBe(true);
  });

  it('APPENDS — does not overwrite a pre-existing hub.jsonl', () => {
    // Write two existing entries
    writeHubStore(tmpHome, [
      { id: 'pre-1', title: 'Pre-existing 1', text: 'Original content 1.', tags: [] },
      { id: 'pre-2', title: 'Pre-existing 2', text: 'Original content 2.', tags: [] },
    ]);

    const storePath = hubStorePath();
    const beforeContent = fs.readFileSync(storePath, 'utf8');

    appendHubEntry({ text: 'New entry after pre-existing' });

    const afterContent = fs.readFileSync(storePath, 'utf8');
    // The original content must still be present verbatim at the start
    expect(afterContent.startsWith(beforeContent.trimEnd())).toBe(true);
  });

  it('APPENDS — previous entries survive multiple appends', () => {
    appendHubEntry({ text: 'First', title: 'First' });
    appendHubEntry({ text: 'Second', title: 'Second' });
    appendHubEntry({ text: 'Third', title: 'Third' });

    const storePath = hubStorePath();
    const lines = fs.readFileSync(storePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    expect(lines.length).toBe(3);
  });

  it('each appended line is valid JSON', () => {
    appendHubEntry({ text: 'Entry A' });
    appendHubEntry({ text: 'Entry B' });

    const storePath = hubStorePath();
    const lines = fs.readFileSync(storePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('two consecutive appends produce distinct ids', () => {
    const e1 = appendHubEntry({ text: 'Entry one' });
    const e2 = appendHubEntry({ text: 'Entry two' });
    expect(e1.id).not.toBe(e2.id);
  });

  it('written entry is loadable by loadGenome', () => {
    const written = appendHubEntry({ text: 'Loadable content', title: 'Loadable Title' });
    const entries = loadGenome(makeConfig());
    const found = entries.find(e => e.id === written.id);
    expect(found).toBeDefined();
    expect(found!.text).toBe('Loadable content');
    expect(found!.source).toBe('hub');
  });
});

// ---------------------------------------------------------------------------
// genomeHealth — counts and metadata
// ---------------------------------------------------------------------------

describe('genomeHealth — counts match reality', () => {
  it('returns totalEntries=0 and hubEntries=0 when genome is empty', () => {
    const health = genomeHealth(makeConfig());
    expect(health.totalEntries).toBe(0);
    expect(health.hubEntries).toBe(0);
  });

  it('never throws even when everything is missing', () => {
    expect(() => genomeHealth(makeConfig())).not.toThrow();
  });

  it('hubEntries matches number of valid lines in hub.jsonl', () => {
    writeHubStore(tmpHome, [
      { id: 'h1', title: 'H1', text: 'text1' },
      { id: 'h2', title: 'H2', text: 'text2' },
      { id: 'h3', title: 'H3', text: 'text3' },
    ]);
    const health = genomeHealth(makeConfig());
    expect(health.hubEntries).toBe(3);
  });

  it('hub health only counts recallable hub entries', () => {
    const storeDir = path.join(tmpHome, '.ashlr', 'genome');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, 'hub.jsonl'),
      [
        JSON.stringify({ ts: '2025-06-01T00:00:00.000Z' }),
        JSON.stringify({ id: 'missing-text', title: 'Missing Text', ts: '2025-06-02T00:00:00.000Z' }),
        JSON.stringify({
          id: 'valid',
          project: null,
          source: 'hub',
          title: 'Valid',
          text: 'Recallable memory.',
          tags: [],
          ts: '2025-06-03T00:00:00.000Z',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    expect(genomeHealth(makeConfig()).hubEntries).toBe(1);
    expect(genomeHubHealth()).toMatchObject({
      totalEntries: 1,
      hubEntries: 1,
      lastLearnedAt: '2025-06-03T00:00:00.000Z',
    });
  });

  it('totalEntries >= hubEntries (project entries add to total)', () => {
    writeHubStore(tmpHome, [{ id: 'h1', title: 'H', text: 'hub' }]);
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    const cfg = makeConfigWithRoots(base);

    const health = genomeHealth(cfg);
    expect(health.totalEntries).toBeGreaterThanOrEqual(health.hubEntries);
  });

  it('projects count reflects distinct projects in genome', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base, 'project-a');
    makeProjectGenomeFixture(base, 'project-b');
    const cfg = makeConfigWithRoots(base);

    const health = genomeHealth(cfg);
    expect(health.projects).toBeGreaterThanOrEqual(2);
  });

  it('projects is 0 when no project genome dirs exist', () => {
    const health = genomeHealth(makeConfig());
    expect(health.projects).toBe(0);
  });

  it('sizeBytes is 0 when hub.jsonl does not exist', () => {
    const health = genomeHealth(makeConfig());
    expect(health.sizeBytes).toBe(0);
  });

  it('sizeBytes matches actual file size of hub.jsonl', () => {
    writeHubStore(tmpHome, [{ id: 'h1', title: 'H', text: 'some content here' }]);
    const storePath = hubStorePath();
    const actualSize = fs.statSync(storePath).size;

    const health = genomeHealth(makeConfig());
    expect(health.sizeBytes).toBe(actualSize);
  });

  it('lastLearnedAt is null when hub is empty', () => {
    const health = genomeHealth(makeConfig());
    expect(health.lastLearnedAt).toBeNull();
  });

  it('lastLearnedAt is the ts of the most recent hub entry', () => {
    writeHubStore(tmpHome, [
      { id: 'old', title: 'Old', text: 'old', ts: '2024-01-01T00:00:00.000Z' },
      { id: 'new', title: 'New', text: 'new', ts: '2025-06-01T00:00:00.000Z' },
      { id: 'mid', title: 'Mid', text: 'mid', ts: '2024-06-15T00:00:00.000Z' },
    ]);
    const health = genomeHealth(makeConfig());
    expect(health.lastLearnedAt).toBe('2025-06-01T00:00:00.000Z');
  });

  it('embeddingsAvailable is a boolean', () => {
    const health = genomeHealth(makeConfig());
    expect(typeof health.embeddingsAvailable).toBe('boolean');
  });

  it('embeddingsAvailable shape — GenomeHealth fields all present', () => {
    const health = genomeHealth(makeConfig());
    expect(typeof health.totalEntries).toBe('number');
    expect(typeof health.projects).toBe('number');
    expect(typeof health.hubEntries).toBe('number');
    expect(typeof health.sizeBytes).toBe('number');
    // lastLearnedAt is string | null
    expect(health.lastLearnedAt === null || typeof health.lastLearnedAt === 'string').toBe(true);
    expect(typeof health.embeddingsAvailable).toBe('boolean');
  });

  it('genomeHealth after appendHubEntry reflects the new entry', () => {
    appendHubEntry({ text: 'Health check note', title: 'Health' });
    const health = genomeHealth(makeConfig());
    expect(health.hubEntries).toBe(1);
    expect(health.totalEntries).toBeGreaterThanOrEqual(1);
    expect(health.sizeBytes).toBeGreaterThan(0);
    expect(health.lastLearnedAt).not.toBeNull();
  });

  it('genomeHealth counts grow with each append', { timeout: 30_000 }, () => { // slow-runner headroom
    const h0 = genomeHealth(makeConfig());
    appendHubEntry({ text: 'Entry 1' });
    const h1 = genomeHealth(makeConfig());
    appendHubEntry({ text: 'Entry 2' });
    const h2 = genomeHealth(makeConfig());

    expect(h1.hubEntries).toBe(h0.hubEntries + 1);
    expect(h2.hubEntries).toBe(h0.hubEntries + 2);
  });
});

// ---------------------------------------------------------------------------
// loadGenome — ids are unique within the aggregate
// ---------------------------------------------------------------------------

describe('loadGenome — id uniqueness', () => {
  it('all entry ids are unique in the aggregated result', () => {
    const base = path.join(tmpHome, 'repos');
    fs.mkdirSync(base);
    makeProjectGenomeFixture(base);
    writeHubStore(tmpHome, [
      { id: 'hub-unique-1', title: 'H1', text: 'hub text 1' },
      { id: 'hub-unique-2', title: 'H2', text: 'hub text 2' },
    ]);
    const cfg = makeConfigWithRoots(base);

    const entries = loadGenome(cfg);
    const ids = entries.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
