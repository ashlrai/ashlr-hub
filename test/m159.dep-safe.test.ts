/**
 * M159 dep-safe scanner tests — hermetic, READ-ONLY invariants.
 *
 * Covers the M159 changes to scanDeps in src/core/portfolio/scanners.ts:
 *   - Emits WorkItems with exact title format:
 *       "bump <pkg> <from> → <to> in package.json (patch|minor)"
 *   - Skips major-version bumps entirely (no WorkItem, no 'major' tag)
 *   - Tags patch bumps with 'patch', minor bumps with 'minor'
 *   - Outdated dep WorkItems have effort === 1
 *   - Prefers wanted version over latest when wanted differs from current
 *
 * SAFETY GUARDRAILS (mirrors m22.scanners.test.ts):
 *   - All tests operate on a TMP git repo created fresh per-suite.
 *   - HOME is overridden to a tmp dir so ~/.ashlr/enrollment.json is isolated.
 *   - child_process.execFile is mocked to prevent ANY real subprocess.
 *   - After every scanner call, repo files are verified byte-for-byte unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// HOME isolation (must be set before any module import)
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// execFile mock — intercept all subprocess calls
// ---------------------------------------------------------------------------

let _execFileImpl: Mock;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Mirror real execFile's promisify.custom so `const { stdout } = await execFileAsync(...)`
  // destructuring works correctly in scanners.ts (same pattern as m22).
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
    spawnSync: () => ({ pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }),
  };
});

// ---------------------------------------------------------------------------
// Lazy import — module must be loaded AFTER vi.mock is hoisted
// ---------------------------------------------------------------------------

import { scanDeps } from '../src/core/portfolio/scanners.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot of all files under a directory (relative path -> Buffer). */
function snapshotDir(dir: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        snap.set(path.relative(dir, full), fs.readFileSync(full));
      }
    }
  }
  walk(dir);
  return snap;
}

/** Assert that the repo directory is byte-identical to the snapshot. */
function assertUnchanged(dir: string, before: Map<string, Buffer>): void {
  const after = snapshotDir(dir);
  for (const k of after.keys()) {
    expect(before.has(k), `Scanner created a new file: ${k}`).toBe(true);
  }
  for (const [k, buf] of before) {
    expect(after.has(k), `Scanner deleted file: ${k}`).toBe(true);
    expect(Buffer.compare(buf, after.get(k)!), `Scanner modified file: ${k}`).toBe(0);
  }
}

/** Create a minimal bare git repo (just .git dir) so git commands do not fail. */
function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

/**
 * Stub execFile: first call returns outdated JSON (via error with exit code 1,
 * mirroring real npm outdated behaviour), second call returns empty audit JSON.
 */
function stubOutdated(outdatedJson: string): void {
  let callCount = 0;
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: (Error & { stdout?: string; stderr?: string }) | null,
      stdout: string,
      stderr: string,
    ) => void;
    if (typeof cb !== 'function') return;
    callCount++;
    if (callCount === 1) {
      // npm outdated exits 1 when packages are outdated but stdout is valid JSON
      const err = Object.assign(new Error('outdated'), { code: 1, stdout: outdatedJson, stderr: '' });
      cb(err, outdatedJson, '');
    } else {
      // npm audit — return empty (no vulns)
      cb(null, '{}', '');
    }
  });
}

/** Build a minimal npm outdated JSON entry. */
function outdatedEntry(opts: {
  current: string;
  wanted: string;
  latest: string;
  type?: string;
}): Record<string, unknown> {
  return {
    current: opts.current,
    wanted: opts.wanted,
    latest: opts.latest,
    dependent: 'test-pkg',
    location: 'node_modules/pkg',
    type: opts.type ?? 'dependency',
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach — fresh tmp dirs + HOME isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m159-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m159-repo-'));
  process.env.HOME = tmpHome;

  // Default: always errors (safe baseline — no real subprocesses)
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile stubbed error'), '', '');
  });

  initBareGitDir(tmpRepo);

  // All scanDeps tests need a package.json so the scanner does not short-circuit
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ name: 'test-pkg', version: '1.0.0', scripts: { test: 'vitest run' } }),
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// A: exact title format — patch and minor bumps
// ===========================================================================

describe('M159-A scanDeps — exact title format for patch and minor bumps', () => {
  it('patch bump title is "bump lodash 4.17.20 -> 4.17.21 in package.json (patch)"', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
    }));

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);

    const item = items.find(i => i.title.includes('lodash'));
    expect(item, 'expected a WorkItem for lodash').toBeDefined();
    expect(item!.title).toBe('bump lodash 4.17.20 → 4.17.21 in package.json (patch)');
  });

  it('minor bump title is "bump express 4.17.0 -> 4.18.2 in package.json (minor)"', async () => {
    stubOutdated(JSON.stringify({
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);

    const item = items.find(i => i.title.includes('express'));
    expect(item, 'expected a WorkItem for express').toBeDefined();
    expect(item!.title).toBe('bump express 4.17.0 → 4.18.2 in package.json (minor)');
  });

  it('title uses "wanted" version (not latest) when wanted differs from current', async () => {
    // wanted = 4.17.21 (patch vs current), latest = 4.18.0 (minor vs current)
    // title must target wanted (4.17.21), not latest (4.18.0)
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.18.0' }),
    }));

    const items = await scanDeps(tmpRepo);
    const item = items.find(i => i.title.includes('lodash'));
    expect(item).toBeDefined();
    expect(item!.title).toContain('4.17.21');
    expect(item!.title).not.toContain('4.18.0');
  });

  it('multiple packages each get correctly-formatted titles', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const items = await scanDeps(tmpRepo);
    const lodashItem = items.find(i => i.title.includes('lodash'));
    const expressItem = items.find(i => i.title.includes('express'));

    expect(lodashItem).toBeDefined();
    expect(expressItem).toBeDefined();
    expect(lodashItem!.title).toBe('bump lodash 4.17.20 → 4.17.21 in package.json (patch)');
    expect(expressItem!.title).toBe('bump express 4.17.0 → 4.18.2 in package.json (minor)');
  });
});

// ===========================================================================
// B: major-version bumps are SKIPPED entirely
// ===========================================================================

describe('M159-B scanDeps — major-version bumps are skipped entirely', () => {
  it('major bump (webpack 4->5) emits no WorkItem', async () => {
    stubOutdated(JSON.stringify({
      webpack: outdatedEntry({ current: '4.46.0', wanted: '4.46.0', latest: '5.91.0' }),
    }));

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items.filter(i => i.title.includes('webpack') || i.id.includes('webpack'))).toHaveLength(0);
  });

  it('no item is ever tagged "major"', async () => {
    stubOutdated(JSON.stringify({
      webpack: outdatedEntry({ current: '4.46.0', wanted: '4.46.0', latest: '5.91.0' }),
      react: outdatedEntry({ current: '17.0.2', wanted: '17.0.2', latest: '18.3.1' }),
    }));

    const items = await scanDeps(tmpRepo);
    for (const item of items) {
      expect(item.tags, `item "${item.title}" must not carry 'major' tag`).not.toContain('major');
    }
  });

  it('mixed major+minor — only the minor bump surfaces, major is absent', async () => {
    stubOutdated(JSON.stringify({
      webpack: outdatedEntry({ current: '4.46.0', wanted: '4.46.0', latest: '5.91.0' }),
      axios: outdatedEntry({ current: '1.5.0', wanted: '1.6.8', latest: '1.6.8' }),
    }));

    const items = await scanDeps(tmpRepo);

    expect(items.some(i => i.title.includes('webpack'))).toBe(false);

    const axiosItem = items.find(i => i.title.includes('axios'));
    expect(axiosItem, 'axios minor bump must surface').toBeDefined();
    expect(axiosItem!.title).toBe('bump axios 1.5.0 → 1.6.8 in package.json (minor)');
  });

  it('all-major outdated list produces zero outdated WorkItems', async () => {
    stubOutdated(JSON.stringify({
      webpack: outdatedEntry({ current: '4.0.0', wanted: '4.0.0', latest: '5.0.0' }),
      react: outdatedEntry({ current: '17.0.0', wanted: '17.0.0', latest: '18.0.0' }),
      typescript: outdatedEntry({ current: '4.0.0', wanted: '4.0.0', latest: '5.0.0' }),
    }));

    const items = await scanDeps(tmpRepo);
    expect(items.filter(i => i.tags.includes('outdated'))).toHaveLength(0);
  });
});

// ===========================================================================
// C: tag correctness — patch -> 'patch', minor -> 'minor', never 'major'
// ===========================================================================

describe('M159-C scanDeps — tags match bump classification', () => {
  it('patch bump carries "patch" tag, not "minor" or "major"', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
    }));

    const items = await scanDeps(tmpRepo);
    const item = items.find(i => i.title.includes('lodash'));
    expect(item).toBeDefined();
    expect(item!.tags).toContain('patch');
    expect(item!.tags).not.toContain('minor');
    expect(item!.tags).not.toContain('major');
  });

  it('minor bump carries "minor" tag, not "patch" or "major"', async () => {
    stubOutdated(JSON.stringify({
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const items = await scanDeps(tmpRepo);
    const item = items.find(i => i.title.includes('express'));
    expect(item).toBeDefined();
    expect(item!.tags).toContain('minor');
    expect(item!.tags).not.toContain('patch');
    expect(item!.tags).not.toContain('major');
  });

  it('all outdated items carry "dep" and "outdated" base tags', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const items = await scanDeps(tmpRepo);
    const outdatedItems = items.filter(i => i.tags.includes('outdated'));
    expect(outdatedItems.length).toBeGreaterThan(0);
    for (const item of outdatedItems) {
      expect(item.tags).toContain('dep');
      expect(item.tags).toContain('outdated');
    }
  });

  it('"major" tag never appears on any item (invariant across mix of patch+minor)', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const items = await scanDeps(tmpRepo);
    for (const item of items) {
      expect(item.tags, `item "${item.title}" must not carry 'major' tag`).not.toContain('major');
    }
  });
});

// ===========================================================================
// D: effort === 1 for all outdated dep WorkItems
// ===========================================================================

describe('M159-D scanDeps — outdated dep WorkItems have effort === 1', () => {
  it('patch bump item has effort === 1', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
    }));

    const items = await scanDeps(tmpRepo);
    const item = items.find(i => i.title.includes('lodash'));
    expect(item).toBeDefined();
    expect(item!.effort).toBe(1);
  });

  it('minor bump item has effort === 1', async () => {
    stubOutdated(JSON.stringify({
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
    }));

    const items = await scanDeps(tmpRepo);
    const item = items.find(i => i.title.includes('express'));
    expect(item).toBeDefined();
    expect(item!.effort).toBe(1);
  });

  it('all outdated items have effort === 1 (multi-package invariant)', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
      express: outdatedEntry({ current: '4.17.0', wanted: '4.18.2', latest: '4.18.2' }),
      axios: outdatedEntry({ current: '1.5.0', wanted: '1.6.8', latest: '1.6.8' }),
    }));

    const items = await scanDeps(tmpRepo);
    const outdatedItems = items.filter(i => i.tags.includes('outdated'));
    expect(outdatedItems.length).toBeGreaterThan(0);
    for (const item of outdatedItems) {
      expect(item.effort, `effort must be 1 for "${item.title}"`).toBe(1);
    }
  });

  it('WorkItem shape is fully valid for outdated items', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
    }));

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);

    const outdatedItems = items.filter(i => i.tags.includes('outdated'));
    expect(outdatedItems.length).toBeGreaterThan(0);

    for (const item of outdatedItems) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.repo).toBe(tmpRepo);
      expect(item.source).toBe('dep');
      expect(typeof item.title).toBe('string');
      expect(typeof item.detail).toBe('string');
      expect(item.effort).toBe(1);
      expect(item.value).toBeGreaterThanOrEqual(1);
      expect(item.score).toBeGreaterThan(0);
      expect(Array.isArray(item.tags)).toBe(true);
      expect(typeof item.ts).toBe('string');
      expect(() => new Date(item.ts)).not.toThrow();
    }
  });
});

// ===========================================================================
// E: repo files are READ-ONLY (byte-unchanged after every scan)
// ===========================================================================

describe('M159 scanDeps — repo files are READ-ONLY', () => {
  it('repo byte-unchanged after a patch bump scan', async () => {
    stubOutdated(JSON.stringify({
      lodash: outdatedEntry({ current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' }),
    }));

    const before = snapshotDir(tmpRepo);
    await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });

  it('repo byte-unchanged when all bumps are major (all skipped)', async () => {
    stubOutdated(JSON.stringify({
      webpack: outdatedEntry({ current: '4.0.0', wanted: '4.0.0', latest: '5.0.0' }),
    }));

    const before = snapshotDir(tmpRepo);
    await scanDeps(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });
});
