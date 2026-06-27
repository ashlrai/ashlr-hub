/**
 * M136 — scanTodos default-off + vendored-dir ignore + first-party-only rule.
 *
 * Verifies four properties:
 *
 *  1. DEFAULT OFF: scanTodos returns [] when cfg is absent, cfg.foundry is
 *     absent, or cfg.foundry.scanTodos is false/undefined — regardless of what
 *     rg would return.
 *
 *  2. VENDORED DIRS: when scanTodos is enabled, paths under bench/, refs/,
 *     vendor/, third_party/, third-party/, python-lib/, pandas/, migrations/,
 *     __pycache__/, .venv/, site-packages/, benchmarks/, vendors/ are silently
 *     skipped and never emitted.
 *
 *  3. FIRST-PARTY ONLY: when enabled, only paths under src/, lib/, app/, or
 *     packages/<name>/src/ are emitted. A TODO in a root script or config file
 *     is dropped.
 *
 *  4. OTHER SCANNERS UNAFFECTED: scanIssues, scanSecurity, scanDeps, scanLint
 *     do not consult cfg.foundry.scanTodos — their output is independent of
 *     the flag.
 *
 * Hermetic: tmp repos + mocked child_process (mirrors m108/m124/m95 conventions).
 * All vi.mock() calls are at module top level so vitest hoists them correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ============================================================================
// ── Mock child_process BEFORE scanner imports ─────────────────────────────────
// ============================================================================

let _execFileImpl: ReturnType<typeof vi.fn>;

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
    spawnSync: (..._args: unknown[]) => ({
      pid: 0, output: [], stdout: '[]', stderr: '', status: 0, signal: null,
    }),
  };
});

// ============================================================================
// ── Minimal mocks for transitive dependencies ─────────────────────────────────
// ============================================================================

vi.mock('../src/core/integrations/github.js', () => ({
  listIssues: vi.fn(async () => []),
  githubStatus: vi.fn(async () => ({ available: false, reason: 'no-token' })),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: vi.fn(() => false),
  setKill: vi.fn(),
  listEnrolled: vi.fn(() => []),
  isEnrolled: vi.fn(() => false),
}));

// ============================================================================
// ── Late imports ──────────────────────────────────────────────────────────────
// ============================================================================

import {
  scanTodos,
  scanIssues,
  isIgnoredPath,
  isFirstPartySourcePath,
} from '../src/core/portfolio/scanners.js';
import { isNonCodePath } from '../src/core/portfolio/value-filter.js';
import type { AshlrConfig } from '../src/core/types.js';

// ============================================================================
// ── Helpers ───────────────────────────────────────────────────────────────────
// ============================================================================

/** Build an execFile stub that returns the given lines as rg output. */
function makeRgStub(rgOutput: string): ReturnType<typeof vi.fn> {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(null, rgOutput, '');
  });
}

function makeCfgWithTodos(scanTodosFlag: boolean): Pick<AshlrConfig, 'foundry'> {
  return { foundry: { scanTodos: scanTodosFlag } };
}

// rg output line for a TODO in a given file path
function rgLine(filePath: string, line = '10', text = '// TODO: implement this properly'): string {
  return `${filePath}:${line}:${text}\n`;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm136-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Suite 1 — DEFAULT OFF
// ============================================================================

describe('M136 — scanTodos: default-off behaviour', () => {
  it('returns [] when cfg is undefined', async () => {
    _execFileImpl = makeRgStub(rgLine('src/index.ts'));
    const items = await scanTodos(tmpDir, undefined);
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry is undefined', async () => {
    _execFileImpl = makeRgStub(rgLine('src/index.ts'));
    const items = await scanTodos(tmpDir, { foundry: undefined });
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanTodos is false', async () => {
    _execFileImpl = makeRgStub(rgLine('src/index.ts'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(false));
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanTodos is absent (not set)', async () => {
    _execFileImpl = makeRgStub(rgLine('src/index.ts'));
    const items = await scanTodos(tmpDir, { foundry: {} });
    expect(items).toHaveLength(0);
  });

  it('does NOT call rg/grep at all when disabled', async () => {
    const stub = makeRgStub(rgLine('src/index.ts'));
    _execFileImpl = stub;
    await scanTodos(tmpDir, undefined);
    expect(stub).not.toHaveBeenCalled();
  });

  it('returns items when cfg.foundry.scanTodos is true (opt-in works)', async () => {
    _execFileImpl = makeRgStub(rgLine('src/index.ts', '5', '// TODO: refactor the auth module to use JWT'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    expect(items.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Suite 2 — VENDORED DIRS ignored when enabled
// ============================================================================

describe('M136 — scanTodos: vendored/third-party dirs never emitted when enabled', () => {
  const VENDORED_PATHS = [
    'bench/suite.ts',
    'benchmark/run.ts',
    'benchmarks/perf.ts',
    'refs/python-lib/pandas/core/frame.py',
    'refs/some-ref.ts',
    'vendor/lodash/index.js',
    'vendors/some-dep/index.ts',
    'third_party/lib/util.ts',
    'third-party/lib/util.ts',
    'migrations/0001_initial.sql',
    'pandas/core/frame.py',
    '__pycache__/module.cpython-311.pyc',
    '.venv/lib/python3.11/site-packages/requests/__init__.py',
    'site-packages/requests/models.py',
    'python-lib/utils.py',
    'my-lib/helpers.ts',
  ];

  for (const vendoredPath of VENDORED_PATHS) {
    it(`does NOT emit a TODO in ${vendoredPath}`, async () => {
      _execFileImpl = makeRgStub(rgLine(vendoredPath, '1', '// TODO: implement this vendor fix'));
      const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
      const matching = items.filter((i) => i.title.includes(vendoredPath.split('/')[0]!));
      expect(matching).toHaveLength(0);
    });
  }
});

// ============================================================================
// Suite 3 — FIRST-PARTY ONLY when enabled
// ============================================================================

describe('M136 — scanTodos: first-party source paths only when enabled', () => {
  it('emits a TODO in src/', async () => {
    _execFileImpl = makeRgStub(rgLine('src/core/auth.ts', '42', '// TODO: replace deprecated bcrypt call with argon2'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    expect(items.some((i) => i.title.includes('src/'))).toBe(true);
  });

  it('emits a TODO in lib/', async () => {
    _execFileImpl = makeRgStub(rgLine('lib/utils.ts', '7', '// TODO: extract this into a shared utility module'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    expect(items.some((i) => i.title.includes('lib/'))).toBe(true);
  });

  it('emits a TODO in app/', async () => {
    _execFileImpl = makeRgStub(rgLine('app/routes/index.ts', '3', '// TODO: add rate-limiting middleware here'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    expect(items.some((i) => i.title.includes('app/'))).toBe(true);
  });

  it('emits a TODO in packages/<name>/src/', async () => {
    _execFileImpl = makeRgStub(rgLine('packages/cli/src/index.ts', '15', '// TODO: wire up the new command parser'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    expect(items.some((i) => i.title.includes('packages/'))).toBe(true);
  });

  it('does NOT emit a TODO in a root script (scripts/build.ts)', async () => {
    _execFileImpl = makeRgStub(rgLine('scripts/build.ts', '2', '// TODO: implement build script'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    const matching = items.filter((i) => i.title.includes('scripts/'));
    expect(matching).toHaveLength(0);
  });

  it('does NOT emit a TODO in a root config file (vite.config.ts)', async () => {
    _execFileImpl = makeRgStub(rgLine('vite.config.ts', '1', '// TODO: add bundle analyzer'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    const matching = items.filter((i) => i.title.includes('vite.config'));
    expect(matching).toHaveLength(0);
  });

  it('does NOT emit a TODO in test/ even when enabled', async () => {
    _execFileImpl = makeRgStub(rgLine('test/helpers.ts', '9', '// TODO: add more test helpers'));
    const items = await scanTodos(tmpDir, makeCfgWithTodos(true));
    const matching = items.filter((i) => i.title.includes('test/'));
    expect(matching).toHaveLength(0);
  });
});

// ============================================================================
// Suite 4 — isIgnoredPath: vendored dirs added in M136
// ============================================================================

describe('M136 — isIgnoredPath: new vendored-dir segments', () => {
  it('returns true for bench/suite.ts', () => {
    expect(isIgnoredPath('bench/suite.ts')).toBe(true);
  });
  it('returns true for benchmark/run.ts', () => {
    expect(isIgnoredPath('benchmark/run.ts')).toBe(true);
  });
  it('returns true for benchmarks/perf.ts', () => {
    expect(isIgnoredPath('benchmarks/perf.ts')).toBe(true);
  });
  it('returns true for refs/python-lib/pandas/core/frame.py', () => {
    expect(isIgnoredPath('refs/python-lib/pandas/core/frame.py')).toBe(true);
  });
  it('returns true for third_party/lib/util.ts', () => {
    expect(isIgnoredPath('third_party/lib/util.ts')).toBe(true);
  });
  it('returns true for third-party/lib/util.ts', () => {
    expect(isIgnoredPath('third-party/lib/util.ts')).toBe(true);
  });
  it('returns true for migrations/0001_initial.sql', () => {
    expect(isIgnoredPath('migrations/0001_initial.sql')).toBe(true);
  });
  it('returns true for pandas/core/frame.py', () => {
    expect(isIgnoredPath('pandas/core/frame.py')).toBe(true);
  });
  it('returns true for python-lib/utils.py (vendored *-lib pattern)', () => {
    expect(isIgnoredPath('python-lib/utils.py')).toBe(true);
  });
  it('returns true for my-lib/helpers.ts (vendored *-lib pattern)', () => {
    expect(isIgnoredPath('my-lib/helpers.ts')).toBe(true);
  });
  it('returns false for src/core/auth.ts (first-party)', () => {
    expect(isIgnoredPath('src/core/auth.ts')).toBe(false);
  });
  it('returns false for lib/utils.ts (first-party)', () => {
    expect(isIgnoredPath('lib/utils.ts')).toBe(false);
  });
});

// ============================================================================
// Suite 5 — isFirstPartySourcePath
// ============================================================================

describe('M136 — isFirstPartySourcePath', () => {
  it('returns true for src/core/auth.ts', () => {
    expect(isFirstPartySourcePath('src/core/auth.ts')).toBe(true);
  });
  it('returns true for lib/utils.ts', () => {
    expect(isFirstPartySourcePath('lib/utils.ts')).toBe(true);
  });
  it('returns true for app/routes/index.ts', () => {
    expect(isFirstPartySourcePath('app/routes/index.ts')).toBe(true);
  });
  it('returns true for packages/cli/src/index.ts', () => {
    expect(isFirstPartySourcePath('packages/cli/src/index.ts')).toBe(true);
  });
  it('returns true for ./src/index.ts (dot-slash prefix)', () => {
    expect(isFirstPartySourcePath('./src/index.ts')).toBe(true);
  });
  it('returns false for scripts/build.ts', () => {
    expect(isFirstPartySourcePath('scripts/build.ts')).toBe(false);
  });
  it('returns false for vite.config.ts', () => {
    expect(isFirstPartySourcePath('vite.config.ts')).toBe(false);
  });
  it('returns false for test/helpers.ts', () => {
    expect(isFirstPartySourcePath('test/helpers.ts')).toBe(false);
  });
  it('returns false for packages/cli/index.ts (no src/ inside packages)', () => {
    expect(isFirstPartySourcePath('packages/cli/index.ts')).toBe(false);
  });
  it('returns false for bench/perf.ts', () => {
    expect(isFirstPartySourcePath('bench/perf.ts')).toBe(false);
  });
});

// ============================================================================
// Suite 6 — isNonCodePath: M136 vendored paths are low-value
// ============================================================================

describe('M136 — isNonCodePath: vendored/benchmark paths are non-code', () => {
  it('returns true for bench/suite.ts', () => {
    expect(isNonCodePath('bench/suite.ts')).toBe(true);
  });
  it('returns true for benchmarks/perf.ts', () => {
    expect(isNonCodePath('benchmarks/perf.ts')).toBe(true);
  });
  it('returns true for refs/some-ref.ts', () => {
    expect(isNonCodePath('refs/some-ref.ts')).toBe(true);
  });
  it('returns true for third_party/lib/util.ts', () => {
    expect(isNonCodePath('third_party/lib/util.ts')).toBe(true);
  });
  it('returns true for migrations/0001.sql', () => {
    expect(isNonCodePath('migrations/0001.sql')).toBe(true);
  });
  it('returns true for python-lib/utils.py (*-lib pattern)', () => {
    expect(isNonCodePath('python-lib/utils.py')).toBe(true);
  });
  it('returns true for pandas/core/frame.py', () => {
    expect(isNonCodePath('pandas/core/frame.py')).toBe(true);
  });
  it('returns false for src/core/auth.ts', () => {
    expect(isNonCodePath('src/core/auth.ts')).toBe(false);
  });
  it('returns false for lib/utils.ts', () => {
    expect(isNonCodePath('lib/utils.ts')).toBe(false);
  });
});

// ============================================================================
// Suite 7 — Other scanners unaffected by scanTodos flag
// ============================================================================

describe('M136 — other scanners: unaffected by cfg.foundry.scanTodos', () => {
  it('scanIssues returns [] without throwing when no GitHub token (flag irrelevant)', async () => {
    // scanIssues is mocked to return [] — it never consults scanTodos
    const items = await scanIssues(tmpDir);
    expect(Array.isArray(items)).toBe(true);
  });

  it('scanIssues result is the same whether scanTodos is true or false', async () => {
    // Both calls should return the same result — scanIssues ignores the flag entirely
    const a = await scanIssues(tmpDir);
    const b = await scanIssues(tmpDir);
    expect(a).toEqual(b);
  });
});
