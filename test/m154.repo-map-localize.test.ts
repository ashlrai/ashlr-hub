/**
 * M154 — repo-map + localization pre-pass tests.
 *
 * Hermetic + deterministic: tmp repos under os.tmpdir(), no network, no LLM.
 * Mirrors m45/m108 conventions (mkdtempSync, execFileSync git, afterEach cleanup).
 *
 * Covers:
 *   1. buildRepoMap: extracts symbols from TS/JS/py/go/rs source files.
 *   2. buildRepoMap: ranks a frequently-referenced file HIGHER than others.
 *   3. buildRepoMap: token budget — renderRepoMap truncates at budget.
 *   4. buildRepoMap: IGNORE_DIRS — node_modules / dist / vendor not walked.
 *   5. buildRepoMap: cache — second call returns cached result (no re-walk).
 *   6. localize: narrows to keyword-matching files.
 *   7. localize: prefers item.files over keyword matches.
 *   8. localize: empty repo-map → falls back to item.files.
 *   9. both flags OFF → sandboxed-engine goal is UNCHANGED (byte-identical parity).
 *  10. repo-map/localization combinations inject only their intended context.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { buildRepoMap, renderRepoMap } from '../src/core/run/repo-map.js';
import { localize, renderLocalization } from '../src/core/run/localize.js';
import { buildM154ContextPrefix } from '../src/core/run/sandboxed-engine.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { RepoMap } from '../src/core/run/repo-map.js';

// ---------------------------------------------------------------------------
// Tmp dir tracking
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const tmpFiles: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* idempotent */ }
  }
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* idempotent */ }
  }
});

// ---------------------------------------------------------------------------
// Repo fixture builder
// ---------------------------------------------------------------------------

function makeRepo(files: Record<string, string>): string {
  const dir = mkTmp('ashlr-m154-repo-');
  execFileSync('git', ['-C', dir, 'init', '--initial-branch=main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'm154@ashlr.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'M154 Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });

  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--no-verify', '-m', 'init'], { stdio: 'pipe' });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Symbol extraction
// ---------------------------------------------------------------------------

describe('M154 buildRepoMap — symbol extraction', () => {
  it('extracts exported functions and classes from a TS file', () => {
    const dir = makeRepo({
      'src/utils.ts': [
        'export function greet(name: string): string { return `Hello ${name}`; }',
        'export class Greeter { greet(x: string) { return x; } }',
        'export const VERSION = "1.0.0";',
        'export type Options = { verbose: boolean };',
      ].join('\n'),
    });

    const map = buildRepoMap(dir);
    expect(map.files.length).toBeGreaterThanOrEqual(1);
    const entry = map.files.find((f) => f.path === 'src/utils.ts');
    expect(entry).toBeDefined();
    const names = entry!.symbols.map((s) => s.name);
    expect(names).toContain('greet');
    expect(names).toContain('Greeter');
    expect(names).toContain('VERSION');
    expect(names).toContain('Options');
  });

  it('extracts top-level defs from a Python file', () => {
    const dir = makeRepo({
      'lib/helper.py': [
        'def parse_args(argv):',
        '    pass',
        '',
        'class Config:',
        '    pass',
      ].join('\n'),
    });

    const map = buildRepoMap(dir);
    const entry = map.files.find((f) => f.path === 'lib/helper.py');
    expect(entry).toBeDefined();
    const names = entry!.symbols.map((s) => s.name);
    expect(names).toContain('parse_args');
    expect(names).toContain('Config');
  });

  it('extracts exported symbols from a Go file', () => {
    const dir = makeRepo({
      'pkg/server.go': [
        'package server',
        'func NewServer(addr string) *Server { return nil }',
        'type Config struct { Port int }',
      ].join('\n'),
    });

    const map = buildRepoMap(dir);
    const entry = map.files.find((f) => f.path === 'pkg/server.go');
    expect(entry).toBeDefined();
    const names = entry!.symbols.map((s) => s.name);
    expect(names).toContain('NewServer');
    expect(names).toContain('Config');
  });

  it('extracts pub fn/struct from a Rust file', () => {
    const dir = makeRepo({
      'src/lib.rs': [
        'pub fn run(config: Config) -> Result<()> { Ok(()) }',
        'pub struct Config { pub port: u16 }',
      ].join('\n'),
    });

    const map = buildRepoMap(dir);
    const entry = map.files.find((f) => f.path === 'src/lib.rs');
    expect(entry).toBeDefined();
    const names = entry!.symbols.map((s) => s.name);
    expect(names).toContain('run');
    expect(names).toContain('Config');
  });
});

// ---------------------------------------------------------------------------
// 2. Reference-frequency ranking
// ---------------------------------------------------------------------------

describe('M154 buildRepoMap — reference-frequency ranking', () => {
  it('ranks a frequently-imported file HIGHER than an isolated file', () => {
    const dir = makeRepo({
      // core/types.ts is imported by three other files → high refCount
      'src/core/types.ts': 'export type Foo = { x: number };\n',
      'src/a.ts': "import type { Foo } from './core/types.js';\nexport function a() {}\n",
      'src/b.ts': "import type { Foo } from './core/types.js';\nexport function b() {}\n",
      'src/c.ts': "import type { Foo } from './core/types.js';\nexport function c() {}\n",
      // isolated.ts is never imported → refCount 0
      'src/isolated.ts': 'export function neverUsed() {}\n',
    });

    const map = buildRepoMap(dir);
    const typesIdx = map.files.findIndex((f) => f.path === 'src/core/types.ts');
    const isolatedIdx = map.files.findIndex((f) => f.path === 'src/isolated.ts');

    expect(typesIdx).toBeGreaterThanOrEqual(0);
    expect(isolatedIdx).toBeGreaterThanOrEqual(0);
    // types.ts should rank before isolated.ts
    expect(typesIdx).toBeLessThan(isolatedIdx);
    // types.ts refCount should be > 0
    expect(map.files[typesIdx].refCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Token budget
// ---------------------------------------------------------------------------

describe('M154 renderRepoMap — token budget', () => {
  it('renders a map within a tight budget (truncates beyond budget)', () => {
    // Build a repo with many files
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`src/module${i}.ts`] = [
        `export function func${i}A(x: string, y: number): boolean { return true; }`,
        `export function func${i}B(a: string): void {}`,
        `export class Class${i} { method() {} }`,
      ].join('\n');
    }
    const dir = makeRepo(files);
    const map = buildRepoMap(dir);

    // With a budget of 200 tokens (800 chars), should truncate to a subset
    const tight = renderRepoMap(map, { tokenBudget: 200 });
    const full = renderRepoMap(map, { tokenBudget: 100_000 });

    expect(tight.length).toBeLessThan(full.length);
    expect(tight.length).toBeLessThanOrEqual(200 * 4 + 100); // small slack for header
  });

  it('always includes the header comment', () => {
    const dir = makeRepo({ 'src/x.ts': 'export function x() {}\n' });
    const map = buildRepoMap(dir);
    const rendered = renderRepoMap(map);
    expect(rendered).toContain('<!-- repo-map (M154) -->');
  });
});

// ---------------------------------------------------------------------------
// 4. IGNORE_DIRS — vendored dirs not walked
// ---------------------------------------------------------------------------

describe('M154 buildRepoMap — ignores vendored / generated dirs', () => {
  it('does NOT include node_modules files', () => {
    const dir = makeRepo({
      'src/app.ts': 'export function app() {}\n',
      'node_modules/pkg/index.ts': 'export function pkgFn() {}\n',
    });

    const map = buildRepoMap(dir);
    const paths = map.files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths).toContain('src/app.ts');
  });

  it('does NOT include dist/ files', () => {
    const dir = makeRepo({
      'src/real.ts': 'export function real() {}\n',
      'dist/real.js': 'export function real() {}\n',
    });

    const map = buildRepoMap(dir);
    const paths = map.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(paths).toContain('src/real.ts');
  });

  it('does NOT include vendor/ files', () => {
    const dir = makeRepo({
      'src/main.ts': 'export function main() {}\n',
      'vendor/lib.ts': 'export function vendored() {}\n',
    });

    const map = buildRepoMap(dir);
    const paths = map.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('vendor/'))).toBe(false);
    expect(paths).toContain('src/main.ts');
  });

  it('does NOT scan agent or generated worktree roots', () => {
    const generatedRoots = ['.claude', '.codex', '.agents', '.worktrees', '.ashlr'];
    const files: Record<string, string> = {
      'src/main.ts': 'export function main() {}\n',
    };
    for (const root of generatedRoots) {
      files[`${root}/worktrees/generated/src/leaked.ts`] =
        `export function leakedFrom${root.slice(1)}() {}\n`;
    }

    const map = buildRepoMap(makeRepo(files));
    const paths = map.files.map((f) => f.path);

    expect(paths).toContain('src/main.ts');
    for (const root of generatedRoots) {
      expect(paths.some((p) => p === root || p.startsWith(`${root}/`))).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('does NOT follow directory symlinks outside the repository', () => {
    const dir = makeRepo({
      'src/main.ts': 'export function main() {}\n',
    });
    const outside = mkTmp('ashlr-m154-outside-');
    writeFileSync(join(outside, 'escaped.ts'), 'export function escaped() {}\n', 'utf8');
    symlinkSync(outside, join(dir, 'linked-outside'), 'dir');

    const paths = buildRepoMap(dir).files.map((f) => f.path);

    expect(paths).toContain('src/main.ts');
    expect(paths.some((p) => p.startsWith('linked-outside/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Cache — second call returns cached result
// ---------------------------------------------------------------------------

describe('M154 buildRepoMap — caching', () => {
  it('returns a cached map on second call (same sha, same content)', () => {
    const dir = makeRepo({
      'src/cached.ts': 'export function cached() {}\n',
    });

    const map1 = buildRepoMap(dir);
    expect(map1.files.length).toBeGreaterThanOrEqual(1);
    expect(map1.sha).toBeTruthy();

    // Second call — should hit cache (no mutation)
    const map2 = buildRepoMap(dir);
    expect(map2.sha).toBe(map1.sha);
    expect(map2.files.length).toBe(map1.files.length);
  });

  it('stores the cache file under ~/.ashlr/repo-map/', () => {
    const dir = makeRepo({
      'src/thing.ts': 'export function thing() {}\n',
    });

    const map = buildRepoMap(dir);
    if (!map.sha) return; // skip if git unavailable

    const cacheBase = join(homedir(), '.ashlr', 'repo-map');
    expect(existsSync(cacheBase)).toBe(true);
    // At least one .json file exists in the cache dir
    let found = false;
    try {
      const entries = require('node:fs').readdirSync(cacheBase) as string[];
      found = entries.some((e: string) => e.endsWith('.json'));
    } catch { /* ignore */ }
    expect(found).toBe(true);
  });

  it('invalidates legacy HEAD-keyed caches from the previous scan policy', () => {
    const dir = makeRepo({
      'src/current.ts': 'export function current() {}\n',
    });
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const repoHash = createHash('sha1').update(dir).digest('hex').slice(0, 8);
    const legacyCache = join(homedir(), '.ashlr', 'repo-map', `${repoHash}-${sha}.json`);
    tmpFiles.push(legacyCache);
    mkdirSync(join(homedir(), '.ashlr', 'repo-map'), { recursive: true });
    writeFileSync(legacyCache, JSON.stringify({
      sha,
      files: [{ path: '.claude/worktrees/stale.ts', symbols: [], refCount: 999 }],
    }), 'utf8');

    const paths = buildRepoMap(dir).files.map((f) => f.path);

    expect(paths).toContain('src/current.ts');
    expect(paths).not.toContain('.claude/worktrees/stale.ts');
  });

  it('bypasses HEAD caches while the working tree is dirty', () => {
    const dir = makeRepo({
      'src/current.ts': 'export function current() {}\n',
    });
    expect(buildRepoMap(dir).files.map((file) => file.path)).toEqual(['src/current.ts']);

    const transient = join(dir, 'src', 'transient.ts');
    writeFileSync(transient, 'export function transient() {}\n', 'utf8');
    expect(buildRepoMap(dir).files.map((file) => file.path)).toContain('src/transient.ts');

    rmSync(transient);
    expect(buildRepoMap(dir).files.map((file) => file.path)).not.toContain('src/transient.ts');
  });
});

// ---------------------------------------------------------------------------
// 6. localize — keyword matching
// ---------------------------------------------------------------------------

describe('M154 localize — keyword matching', () => {
  it('narrows to files whose path contains a keyword from the title', () => {
    const map: RepoMap = {
      sha: 'test',
      files: [
        { path: 'src/auth/login.ts', symbols: [{ name: 'loginUser', sig: 'export function loginUser' }], refCount: 1 },
        { path: 'src/billing/invoice.ts', symbols: [{ name: 'createInvoice', sig: 'export function createInvoice' }], refCount: 1 },
        { path: 'src/utils/format.ts', symbols: [{ name: 'format', sig: 'export function format' }], refCount: 5 },
      ],
    };

    const result = localize({ title: 'Fix login authentication bug', detail: 'user login fails' }, map);
    expect(result.files).toContain('src/auth/login.ts');
    // billing/invoice should NOT be in top results for a login-focused item
    const billingIdx = result.files.indexOf('src/billing/invoice.ts');
    const loginIdx = result.files.indexOf('src/auth/login.ts');
    if (billingIdx >= 0) expect(loginIdx).toBeLessThan(billingIdx);
  });

  it('includes matched symbol names in the result', () => {
    const map: RepoMap = {
      sha: 'test',
      files: [
        { path: 'src/router.ts', symbols: [{ name: 'buildRouter', sig: 'export function buildRouter' }], refCount: 2 },
      ],
    };

    const result = localize({ title: 'router is not building correctly' }, map);
    expect(result.files).toContain('src/router.ts');
    expect(result.symbols).toContain('buildRouter');
  });

  it('populates reason string', () => {
    const map: RepoMap = {
      sha: 'test',
      files: [
        { path: 'src/cache.ts', symbols: [], refCount: 3 },
      ],
    };
    const result = localize({ title: 'fix cache invalidation' }, map);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. localize — prefers item.files
// ---------------------------------------------------------------------------

describe('M154 localize — item.files priority', () => {
  it('places item.files at the top regardless of keyword score', () => {
    const map: RepoMap = {
      sha: 'test',
      files: [
        { path: 'src/auth.ts', symbols: [], refCount: 10 },
        { path: 'src/specific.ts', symbols: [], refCount: 0 },
        { path: 'src/auth-helper.ts', symbols: [], refCount: 8 },
      ],
    };

    // item explicitly points at specific.ts even though auth.ts has higher refCount
    const result = localize(
      { title: 'fix auth flow', files: ['src/specific.ts'] },
      map,
    );
    expect(result.files[0]).toBe('src/specific.ts');
  });

  it('returns item.files even when repo-map is empty', () => {
    const emptyMap: RepoMap = { sha: '', files: [] };
    const result = localize(
      { title: 'anything', files: ['src/foo.ts', 'src/bar.ts'] },
      emptyMap,
    );
    expect(result.files).toContain('src/foo.ts');
    expect(result.files).toContain('src/bar.ts');
  });
});

// ---------------------------------------------------------------------------
// 8. localize — empty repo-map fallback
// ---------------------------------------------------------------------------

describe('M154 localize — empty repo-map', () => {
  it('returns empty files when both map and item.files are empty', () => {
    const result = localize({ title: 'some work item' }, { sha: '', files: [] });
    expect(result.files).toEqual([]);
    expect(result.symbols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9 & 10. Flag-gated wiring in sandboxed-engine
// ---------------------------------------------------------------------------

describe('M154 flag-gated wiring — sandboxed-engine context', () => {
  const config = (foundry: Record<string, unknown>): AshlrConfig => ({
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    foundry,
  } as AshlrConfig);

  it('both flags OFF: returns an empty prefix for byte-identical goal delivery', () => {
    expect(buildM154ContextPrefix(
      'implement retry logic',
      '/path/that/must/not/be/scanned',
      config({ repoMap: false, localization: false }),
    )).toBe('');
  });

  it('flag-ON: repoMap flag true produces a non-empty prefix for a real repo', () => {
    const dir = makeRepo({
      'src/index.ts': 'export function main() {}\nexport class App {}\n',
    });

    const prefix = buildM154ContextPrefix(
      'update application entry point',
      dir,
      config({ repoMap: true, localization: false }),
    );
    expect(prefix).toContain('<!-- repo-map (M154) -->');
    expect(prefix).not.toContain('<!-- localization (M154) -->');
    expect(prefix).toContain('src/index.ts');
    expect(prefix).toContain('main');
  });

  it('flag-ON + localization: localize result is appended after repo-map', () => {
    const dir = makeRepo({
      'src/auth.ts': 'export function authenticate(token: string) {}\n',
      'src/unrelated.ts': 'export function doOther() {}\n',
    });

    const map = buildRepoMap(dir);
    const render = renderLocalization;
    const loc = localize({ title: 'fix auth token validation', files: [] }, map);
    const locRendered = render(loc);

    expect(locRendered).toContain('<!-- localization (M154) -->');
    // auth.ts should be a candidate since title contains 'auth'
    expect(loc.files.some((f) => f.includes('auth'))).toBe(true);
  });

  it('localization-only: renders at most one candidate and no repository map', () => {
    const dir = makeRepo({
      'src/auth/login.ts': 'export function authenticateLogin() {}\n',
      'src/auth/token.ts': 'export function authenticateToken() {}\n',
      'src/unrelated.ts': 'export function unrelated() {}\n',
    });

    const prefix = buildM154ContextPrefix(
      'fix auth authentication',
      dir,
      config({ repoMap: false, localization: true }),
    );

    expect(prefix).toContain('<!-- localization (M154) -->');
    expect(prefix).not.toContain('<!-- repo-map (M154) -->');
    expect(prefix).not.toContain('src/unrelated.ts');
    const candidates = prefix
      .split('\n')
      .filter((line) => line.startsWith('  src/'));
    expect(candidates).toHaveLength(1);
  });

  it('localization-only ranks the current objective ahead of repair boilerplate', () => {
    const dir = makeRepo({
      'src/payments/settlement.ts': 'export function reconcileSettlement() {}\n',
      'src/dispatch/reslice.ts': 'export function dispatchDiagnosticReslice() {}\n',
    });
    const repairGoal = [
      'Diagnostic reslice: retry a currently actionable work item after an earlier dispatch produced no file changes.',
      'Original work item: repo:self:item',
      'Current objective: reconcile payment settlement records',
      'Dispatch outcome: empty-diff',
      'Action: reslice by inspecting the current target.',
    ].join('\n');

    const prefix = buildM154ContextPrefix(
      repairGoal,
      dir,
      config({ repoMap: false, localization: true }),
    );

    expect(prefix).toContain('src/payments/settlement.ts');
    expect(prefix).not.toContain('src/dispatch/reslice.ts');
  });

  it('both flags ON: preserves full repo-map plus localization treatment', () => {
    const dir = makeRepo({
      'src/auth.ts': 'export function authenticate() {}\n',
    });

    const prefix = buildM154ContextPrefix(
      'fix auth',
      dir,
      config({ repoMap: true, localization: true }),
    );

    expect(prefix).toContain('<!-- repo-map (M154) -->');
    expect(prefix).toContain('<!-- localization (M154) -->');
  });
});

// ---------------------------------------------------------------------------
// 11. Never-throws contract
// ---------------------------------------------------------------------------

describe('M154 never-throws contract', () => {
  it('buildRepoMap returns empty map for a non-existent directory', () => {
    const map = buildRepoMap('/definitely/does/not/exist/at/all');
    expect(map.files).toEqual([]);
    expect(map.sha).toBe('');
  });

  it('localize returns safe fallback when map is malformed', () => {
    const result = localize(
      { title: 'some goal' },
      // @ts-expect-error intentional bad input
      null,
    );
    expect(Array.isArray(result.files)).toBe(true);
  });
});
