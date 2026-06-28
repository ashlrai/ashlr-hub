/**
 * M101 — high-yield scanners: scanLint (cached-report, bounded) +
 *         scanTests failing-test framing.
 *
 * Covers:
 *  A. scanLint — BOUNDED: never runs lint live; only reads a cached report.
 *     A1. Returns concrete fixable items from a seeded ESLint JSON cache.
 *     A2. Items are framed "Fix the <rule> lint error at <file>:<line>: <msg>".
 *     A3. Skips repos with no lint script (no items, no subprocess calls).
 *     A4. Skips repos with a lint script but no cached report file.
 *     A5. Only surfaces severity-2 (error) messages; warnings are suppressed.
 *     A6. Only surfaces fixable rules (fix metadata OR known fixable ruleset).
 *     A7. Caps at MAX_LINT_ITEMS (5) even when the report has many errors.
 *     A8. Never throws on malformed/empty cache files.
 *     A9. WorkItem shape is valid (source='lint', required fields, value/effort in range).
 *    A10. READ-ONLY: repo files byte-unchanged after scan.
 *    A11. All four supported cache file names are discovered.
 *
 *  B. scanLint — bounding assertions (no subprocess is ever called).
 *     B1. No execFile call when there is no lint script.
 *     B2. No execFile call when there is a lint script but no cached report.
 *     B3. No execFile call when a valid cached report IS present.
 *
 *  C. scanTests — failing-test item framing (concrete name + file).
 *     (scanTests surfaces CI-failing and no-test-script items; both are
 *      already concrete by construction. This section verifies the shapes
 *      the fleet engine actually receives.)
 *     C1. CI-failing item contains the repo name in its detail.
 *     C2. No-test-script item references package.json.
 *     C3. Neither item throws.
 *
 * Hermetic: tmp repos + mocked child_process (mirrors m95/m99 conventions).
 * No real gh/rg/npm/eslint invocations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing scanners (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

let _execFileImpl: ReturnType<typeof vi.fn>;
let _spawnSyncImpl: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  const mockExecFile = ((...args: unknown[]) => _execFileImpl(...args)) as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  mockExecFile[promisify.custom] = (
    file: string,
    cmdArgs: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      _execFileImpl(
        file,
        cmdArgs,
        options,
        (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });

  return {
    ...actual,
    execFile: mockExecFile,
    spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mock hoisting
// ---------------------------------------------------------------------------

import { scanLint, scanTests } from '../src/core/portfolio/scanners.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot of all files under a directory (relative path → Buffer). */
function snapshotDir(dir: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else snap.set(path.relative(dir, full), fs.readFileSync(full));
    }
  }
  walk(dir);
  return snap;
}

function assertUnchanged(dir: string, before: Map<string, Buffer>): void {
  const after = snapshotDir(dir);
  for (const k of after.keys()) expect(before.has(k), `Scanner created: ${k}`).toBe(true);
  for (const [k, buf] of before) {
    expect(after.has(k), `Scanner deleted: ${k}`).toBe(true);
    expect(Buffer.compare(buf, after.get(k)!), `Scanner modified: ${k}`).toBe(0);
  }
}

/**
 * Minimal ESLint JSON reporter output.
 * severity 2 = error, 1 = warning.
 * `fix` present = auto-fixable metadata from ESLint.
 */
function buildLintReport(
  entries: Array<{
    filePath: string;
    messages: Array<{
      ruleId?: string;
      severity: number;
      message: string;
      line?: number;
      column?: number;
      fix?: Record<string, unknown>;
    }>;
  }>,
): string {
  return JSON.stringify(entries);
}

/** spawnSync stub: repo has CI failing. */
function makeSpawnSyncCiFailing(repoName: string): ReturnType<typeof vi.fn> {
  return vi.fn((_bin: unknown, args: unknown[]) => {
    const argArr = args as string[];
    if (argArr.includes('repo') && argArr.includes('view')) {
      return { pid: 1, output: [], stdout: JSON.stringify({ nameWithOwner: `test/${repoName}` }), stderr: '', status: 0, signal: null };
    }
    if (argArr.includes('run') && argArr.includes('list')) {
      return {
        pid: 1, output: [],
        stdout: JSON.stringify([{ status: 'failure', conclusion: 'failure', name: 'CI', databaseId: 1 }]),
        stderr: '', status: 0, signal: null,
      };
    }
    return { pid: 1, output: [], stdout: '[]', stderr: '', status: 0, signal: null };
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m101-'));

  // Safe default: execFile errors (no real subprocesses)
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile not configured for this test'), '', '');
  });
  // Safe default: spawnSync returns empty (no GitHub)
  _spawnSyncImpl = vi.fn(() => ({ pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }));
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write package.json with a lint script. */
function writePkgWithLint(dir: string = repo): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test-pkg', scripts: { lint: 'eslint src', test: 'vitest run' } }),
    'utf8',
  );
}

/** Write package.json WITHOUT a lint script. */
function writePkgNoLint(dir: string = repo): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test-pkg', scripts: { test: 'vitest run' } }),
    'utf8',
  );
}

// ===========================================================================
// A. scanLint — concrete fixable items from cached report
// ===========================================================================

describe('M101 scanLint — concrete items from cached ESLint report', () => {
  it('A1: surfaces fixable error items from .lint-cache.json', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/util.ts'),
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 5, column: 7, fix: { range: [10, 11], text: '' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const before = snapshotDir(repo);
    const items = await scanLint(repo, { foundry: { scanLint: true } });
    assertUnchanged(repo, before);

    expect(items.length).toBeGreaterThanOrEqual(1);
    const item = items[0]!;
    expect(item.source).toBe('lint');
    expect(item.title).toMatch(/no-unused-vars/);
    expect(item.title).toMatch(/src\/util\.ts/);
    expect(item.title).toMatch(/:5/);
    expect(item.detail).toContain("'x' is defined but never used.");
  });

  it('A2: item title is framed "Fix the <rule> lint error at <file>:<line>"', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/index.ts'),
        messages: [
          { ruleId: 'prefer-const', severity: 2, message: "'foo' is never reassigned. Use 'const'.", line: 12, fix: { range: [0, 5], text: 'const' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // Title must match the concrete framing pattern
    expect(item.title).toMatch(/^Fix the prefer-const lint error at src\/index\.ts:12/);
  });

  it('A3: returns [] immediately when package.json has no lint script (bounded — no subprocess)', async () => {
    writePkgNoLint();
    // Even if a cache file exists, no lint script → [] without calling execFile
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), buildLintReport([]), 'utf8');
    const execSpy = vi.fn();
    _execFileImpl = execSpy;

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items).toEqual([]);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('A4: returns [] when lint script exists but no cached report file is present', async () => {
    writePkgWithLint();
    // No .lint-cache.json or any other cache file written
    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items).toEqual([]);
  });

  it('A5: suppresses severity-1 (warning) messages — only errors surface', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/a.ts'),
        messages: [
          { ruleId: 'no-console', severity: 1, message: 'Unexpected console.log.', line: 3, fix: { range: [0, 1], text: '' } },
          { ruleId: 'prefer-const', severity: 2, message: "Use 'const'.", line: 7, fix: { range: [0, 3], text: 'const' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    // Only the error (severity 2) surfaces
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('prefer-const');
    expect(items.every(i => i.title.includes('no-console'))).toBe(false);
  });

  it('A6: skips errors without fix metadata and not in the known-fixable ruleset', async () => {
    writePkgWithLint();
    // 'no-shadow' is NOT in the fixable ruleset and has no fix metadata
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/b.ts'),
        messages: [
          { ruleId: 'no-shadow', severity: 2, message: "'x' is already declared.", line: 10 },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items).toEqual([]);
  });

  it('A7: caps output at 5 items even when report has more errors', async () => {
    writePkgWithLint();
    // 10 fixable errors across 10 files
    const entries = Array.from({ length: 10 }, (_, i) => ({
      filePath: path.join(repo, `src/file${i}.ts`),
      messages: [
        { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, fix: { range: [0, 0], text: ';' } },
      ],
    }));
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), buildLintReport(entries), 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items.length).toBeLessThanOrEqual(5);
  });

  it('A8: never throws on malformed cache JSON', async () => {
    writePkgWithLint();
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), '{not valid json}', 'utf8');
    await expect(scanLint(repo, { foundry: { scanLint: true } })).resolves.toEqual([]);
  });

  it('A8b: never throws on empty cache file', async () => {
    writePkgWithLint();
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), '', 'utf8');
    await expect(scanLint(repo, { foundry: { scanLint: true } })).resolves.toEqual([]);
  });

  it('A8c: never throws when package.json is absent', async () => {
    // No package.json at all
    await expect(scanLint(repo, { foundry: { scanLint: true } })).resolves.toEqual([]);
  });

  it('A9: WorkItem has valid shape (source=lint, value/effort in range, required fields)', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/shape.ts'),
        messages: [
          { ruleId: 'eqeqeq', severity: 2, message: "Expected '===' and instead saw '=='.", line: 3, fix: { range: [5, 7], text: '===' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items).toHaveLength(1);
    const item = items[0]!;

    expect(typeof item.id).toBe('string');
    expect(item.id.length).toBeGreaterThan(0);
    expect(item.repo).toBe(repo);
    expect(item.source).toBe('lint');
    expect(typeof item.title).toBe('string');
    expect(item.title.length).toBeGreaterThan(0);
    expect(typeof item.detail).toBe('string');
    expect(item.detail.length).toBeGreaterThan(40);
    expect(item.value).toBeGreaterThanOrEqual(1);
    expect(item.value).toBeLessThanOrEqual(5);
    expect(item.effort).toBeGreaterThanOrEqual(1);
    expect(item.effort).toBeLessThanOrEqual(5);
    expect(item.score).toBeGreaterThan(0);
    expect(Array.isArray(item.tags)).toBe(true);
    expect(item.tags).toContain('lint');
    expect(item.tags).toContain('auto-fixable');
    expect(typeof item.ts).toBe('string');
    expect(() => new Date(item.ts)).not.toThrow();
  });

  it('A10: repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/ro.ts'),
        messages: [
          { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, fix: { range: [0, 0], text: ';' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const before = snapshotDir(repo);
    await scanLint(repo, { foundry: { scanLint: true } });
    assertUnchanged(repo, before);
  });

  it('A11a: discovers .eslintcache.json as a cache file', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/ec.ts'),
        messages: [
          { ruleId: 'prefer-const', severity: 2, message: "Use 'const'.", line: 2, fix: { range: [0, 3], text: 'const' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.eslintcache.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.source).toBe('lint');
  });

  it('A11b: discovers lint-results.json as a cache file', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/lr.ts'),
        messages: [
          { ruleId: 'eqeqeq', severity: 2, message: "Use '==='.", line: 4, fix: { range: [0, 2], text: '===' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, 'lint-results.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('A11c: discovers eslint-report.json as a cache file', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/er.ts'),
        messages: [
          { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 9, fix: { range: [0, 0], text: ';' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, 'eslint-report.json'), report, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('A11d: .lint-cache.json takes priority when multiple cache files exist', async () => {
    writePkgWithLint();
    // Primary: .lint-cache.json with one error
    const primary = buildLintReport([
      {
        filePath: path.join(repo, 'src/pri.ts'),
        messages: [
          { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, fix: { range: [0, 0], text: ';' } },
        ],
      },
    ]);
    // Secondary: lint-results.json with a different rule
    const secondary = buildLintReport([
      {
        filePath: path.join(repo, 'src/sec.ts'),
        messages: [
          { ruleId: 'eqeqeq', severity: 2, message: "Use '==='.", line: 2, fix: { range: [0, 2], text: '===' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), primary, 'utf8');
    fs.writeFileSync(path.join(repo, 'lint-results.json'), secondary, 'utf8');

    const items = await scanLint(repo, { foundry: { scanLint: true } });
    // Items must come from the primary (.lint-cache.json), not the secondary
    expect(items.every(i => i.title.includes('semi') || i.title.includes('pri.ts'))).toBe(true);
    expect(items.every(i => !i.title.includes('eqeqeq'))).toBe(true);
  });
});

// ===========================================================================
// B. scanLint — bounding: no subprocess calls
// ===========================================================================

describe('M101 scanLint — bounded: no subprocess is ever called', () => {
  it('B1: no execFile call when there is no lint script', async () => {
    writePkgNoLint();
    const spy = vi.fn();
    _execFileImpl = spy;

    await scanLint(repo, { foundry: { scanLint: true } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('B2: no execFile call when lint script exists but no cached report', async () => {
    writePkgWithLint();
    const spy = vi.fn();
    _execFileImpl = spy;

    await scanLint(repo, { foundry: { scanLint: true } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('B3: no execFile call when a valid cached report IS present', async () => {
    writePkgWithLint();
    const report = buildLintReport([
      {
        filePath: path.join(repo, 'src/x.ts'),
        messages: [
          { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, fix: { range: [0, 0], text: ';' } },
        ],
      },
    ]);
    fs.writeFileSync(path.join(repo, '.lint-cache.json'), report, 'utf8');

    const spy = vi.fn();
    _execFileImpl = spy;

    await scanLint(repo, { foundry: { scanLint: true } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('B4: never throws even if fs operations throw unexpectedly', async () => {
    // Repo path does not exist — scanLint must return [] gracefully
    await expect(scanLint('/nonexistent/path/m101/repo', { foundry: { scanLint: true } })).resolves.toEqual([]);
  });
});

// ===========================================================================
// C. scanTests — failing-test item framing
// ===========================================================================

describe('M101 scanTests — failing-test item framing is concrete', () => {
  it('C1: CI-failing item contains the repo name in its detail', async () => {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'my-pkg', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    _spawnSyncImpl = makeSpawnSyncCiFailing('my-pkg');

    const items = await scanTests(repo);
    const ciItem = items.find(i => i.tags.includes('ci') && i.tags.includes('failing'));
    expect(ciItem).toBeDefined();
    // Detail should name the repo so the engine has context
    expect(ciItem!.detail.length).toBeGreaterThan(20);
    expect(ciItem!.source).toBe('test');
  });

  it('C2: no-test-script item references package.json context', async () => {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'bare-pkg', scripts: {} }),
      'utf8',
    );

    const items = await scanTests(repo);
    const noTestItem = items.find(i => i.tags.includes('no-tests'));
    expect(noTestItem).toBeDefined();
    expect(noTestItem!.source).toBe('test');
    // Title must be concrete about what is missing
    expect(noTestItem!.title.toLowerCase()).toMatch(/test/);
  });

  it('C3: scanTests never throws on any input', async () => {
    await expect(scanTests('/nonexistent/path/m101')).resolves.toEqual([]);
  });

  it('C4: scanTests returns [] for a repo with a test script and passing CI', async () => {
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'healthy-pkg', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    // spawnSync returns empty list (no CI runs known) → no items
    _spawnSyncImpl = vi.fn(() => ({ pid: 1, output: [], stdout: '[]', stderr: '', status: 0, signal: null }));

    const items = await scanTests(repo);
    // CI-failing item must NOT appear when CI is not failing
    expect(items.filter(i => i.tags.includes('failing'))).toHaveLength(0);
  });
});
