/**
 * M9 tests for src/core/index-engine.ts
 *
 * Two behaviours verified:
 *
 *  1. Dotfile skip — walkDesktopRoot must not index entries whose names start
 *     with "." (e.g. .DS_Store, .vscode, .claude, .ashlrcode, .downloads,
 *     .reorg-backup).
 *
 *  2. Incremental mode — when buildIndex is called with opts.previousIndex,
 *     repos whose directory mtime < previousIndex.generatedAt are reused from
 *     the cache (no re-stat/re-git); repos whose mtime >= generatedAt are
 *     rebuilt from scratch.
 *
 * All tests are hermetic: real filesystem under os.tmpdir() only; no network;
 * no ~/.ashlr reads or writes.  The config module is mocked so CONFIG_DIR /
 * INDEX_PATH never point at the real home directory.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { AshlrConfig, AshlrIndex, IndexedItem } from '../src/core/types.js';

// ─── mock config so no real ~/.ashlr paths are touched ───────────────────────
// NOTE: vi.mock factories are hoisted to the top of the file by vitest, so
// they run before any module-level variable initialisation.  Use only literal
// strings here — do not reference constants defined in the outer module scope.

vi.mock('../src/core/config.js', () => ({
  CONFIG_DIR: '/tmp/ashlr-index-engine-test-config',
  CONFIG_PATH: '/tmp/ashlr-index-engine-test-config/config.json',
  INDEX_PATH: '/tmp/ashlr-index-engine-test-config/index.json',
  defaultConfig: () => { throw new Error('not implemented in mock'); },
  loadConfig: () => { throw new Error('not implemented in mock'); },
  saveConfig: () => { /* no-op */ },
}));

// Import after mock so the module picks up the mocked constants.
import { buildIndex } from '../src/core/index-engine.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-idx-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Minimal AshlrConfig pointing at a single desktop root. */
function makeConfig(desktopRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [desktopRoot],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

/** Initialise a bare git repo at `dir` so isRepo() returns true. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'pipe' });
}

/**
 * Set both atime and mtime of `dir` to a specific Date.
 * Used to place a repo's mtime in the past so the incremental cache triggers.
 */
function setMtime(dir: string, date: Date): void {
  utimesSync(dir, date, date);
}

// ─── 1. Dotfile skip ─────────────────────────────────────────────────────────

describe('walkDesktopRoot — dotfile skip', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('excludes .DS_Store from the index', () => {
    writeFileSync(join(tmp, '.DS_Store'), 'bplist garbage');
    const idx = buildIndex(makeConfig(tmp));
    const names = idx.items.map((i) => i.name);
    expect(names).not.toContain('.DS_Store');
  });

  it('excludes .vscode directory', () => {
    mkdirSync(join(tmp, '.vscode'));
    writeFileSync(join(tmp, '.vscode', 'settings.json'), '{}');
    const idx = buildIndex(makeConfig(tmp));
    const names = idx.items.map((i) => i.name);
    expect(names).not.toContain('.vscode');
  });

  it('excludes .claude directory', () => {
    mkdirSync(join(tmp, '.claude'));
    const idx = buildIndex(makeConfig(tmp));
    expect(idx.items.map((i) => i.name)).not.toContain('.claude');
  });

  it('excludes .ashlrcode directory', () => {
    mkdirSync(join(tmp, '.ashlrcode'));
    const idx = buildIndex(makeConfig(tmp));
    expect(idx.items.map((i) => i.name)).not.toContain('.ashlrcode');
  });

  it('excludes .downloads directory', () => {
    mkdirSync(join(tmp, '.downloads'));
    const idx = buildIndex(makeConfig(tmp));
    expect(idx.items.map((i) => i.name)).not.toContain('.downloads');
  });

  it('excludes .reorg-backup directory', () => {
    mkdirSync(join(tmp, '.reorg-backup'));
    const idx = buildIndex(makeConfig(tmp));
    expect(idx.items.map((i) => i.name)).not.toContain('.reorg-backup');
  });

  it('still indexes non-dotfile directories alongside dotfiles', () => {
    // Mix: one dotfile + one real folder.
    writeFileSync(join(tmp, '.DS_Store'), '');
    mkdirSync(join(tmp, 'my-project'));
    const idx = buildIndex(makeConfig(tmp));
    const names = idx.items.map((i) => i.name);
    expect(names).toContain('my-project');
    expect(names).not.toContain('.DS_Store');
  });

  it('produces an empty index when the root contains only dotfiles', () => {
    writeFileSync(join(tmp, '.DS_Store'), '');
    mkdirSync(join(tmp, '.vscode'));
    mkdirSync(join(tmp, '.claude'));
    const idx = buildIndex(makeConfig(tmp));
    expect(idx.items).toHaveLength(0);
  });
});

// ─── 2. Incremental mode ─────────────────────────────────────────────────────

describe('buildIndex incremental mode', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  /**
   * Build a stub AshlrIndex that looks like a previously-persisted index.
   * `generatedAt` is the timestamp the index was built; each item in `items`
   * represents a previously-indexed repo.
   */
  function makePrevIndex(generatedAt: Date, items: IndexedItem[]): AshlrIndex {
    return {
      version: 1,
      generatedAt: generatedAt.toISOString(),
      root: tmp,
      items,
    };
  }

  /** Stub IndexedItem for a repo — only fields that matter for cache lookup. */
  function stubRepoItem(absPath: string, overrides: Partial<IndexedItem> = {}): IndexedItem {
    return {
      id: absPath.replace(/\//g, '-').replace(/^-/, ''),
      name: absPath.split('/').pop() ?? 'repo',
      path: absPath,
      kind: 'repo',
      category: null,
      description: null,
      org: null,
      remote: null,
      language: null,
      lastModified: new Date(0).toISOString(),
      active: true,
      ...overrides,
    };
  }

  it('reuses a cached repo item when directory mtime is older than generatedAt', () => {
    // Create repo directory.
    const repoDir = join(tmp, 'old-repo');
    initRepo(repoDir);

    // Set the repo's mtime to T-2 hours.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    setMtime(repoDir, twoHoursAgo);

    // Previous index was built 1 hour ago (after the repo's mtime).
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);
    const cachedItem = stubRepoItem(repoDir, {
      description: 'cached description from last run',
    });
    const prevIndex = makePrevIndex(oneHourAgo, [cachedItem]);

    const idx = buildIndex(makeConfig(tmp), { previousIndex: prevIndex });

    const found = idx.items.find((i) => i.path === repoDir);
    expect(found).toBeDefined();
    // The cached item is reused — description comes from the cache, not re-scanned.
    expect(found?.description).toBe('cached description from last run');
  });

  it('rebuilds a repo item when directory mtime is newer than generatedAt', () => {
    // Create repo directory.
    const repoDir = join(tmp, 'fresh-repo');
    initRepo(repoDir);

    // Previous index was built 2 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);

    // Repo mtime is 1 hour ago — newer than the previous index.
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);
    setMtime(repoDir, oneHourAgo);

    const cachedItem = stubRepoItem(repoDir, {
      description: 'stale cached description',
    });
    const prevIndex = makePrevIndex(twoHoursAgo, [cachedItem]);

    const idx = buildIndex(makeConfig(tmp), { previousIndex: prevIndex });

    const found = idx.items.find((i) => i.path === repoDir);
    expect(found).toBeDefined();
    // The item was rebuilt from scratch — description is NOT from the cache.
    // (Real buildItem reads README/package.json; since neither exists here
    // description will be null rather than the stale string.)
    expect(found?.description).not.toBe('stale cached description');
  });

  it('performs a full rebuild when no previousIndex is supplied', () => {
    const repoDir = join(tmp, 'any-repo');
    initRepo(repoDir);

    // No previousIndex → full rebuild. The call must succeed and include the repo.
    const idx = buildIndex(makeConfig(tmp));
    const found = idx.items.find((i) => i.path === repoDir);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('repo');
  });

  it('does not cache non-repo items even when previousIndex is provided', () => {
    // A plain directory (not a git repo) should never be returned from the cache.
    const plainDir = join(tmp, 'plain-folder');
    mkdirSync(plainDir);

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    setMtime(plainDir, twoHoursAgo);

    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);

    // Put a 'repo' stub in the cache with the plain folder's path — to check
    // that it is NOT used (the kind check prevents cache hits for non-repos).
    const fakeRepoItem = stubRepoItem(plainDir, { description: 'should not be used' });
    const prevIndex = makePrevIndex(oneHourAgo, [fakeRepoItem]);

    const idx = buildIndex(makeConfig(tmp), { previousIndex: prevIndex });

    const found = idx.items.find((i) => i.path === plainDir);
    // The item is indexed (as a doc-folder or other non-repo kind).
    expect(found).toBeDefined();
    // But it was NOT fetched from the cache — kind should not be 'repo'.
    expect(found?.kind).not.toBe('repo');
  });

  it('handles an empty previousIndex gracefully (no crash)', () => {
    const repoDir = join(tmp, 'new-repo');
    initRepo(repoDir);

    const prevIndex = makePrevIndex(new Date(), []);
    expect(() => buildIndex(makeConfig(tmp), { previousIndex: prevIndex })).not.toThrow();
  });
});
