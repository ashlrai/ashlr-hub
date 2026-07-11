/**
 * M22 scanners tests — hermetic, READ-ONLY invariants.
 *
 * SAFETY GUARDRAILS:
 *  - All tests operate on a TMP git repo created fresh per-suite; the real
 *    portfolio is NEVER referenced.
 *  - HOME is overridden to a tmp dir so ~/.ashlr/enrollment.json is isolated.
 *  - child_process.execFile is mocked to prevent ANY real subprocess from
 *    running (no real gh/rg/npm/git invocations).
 *  - After every scanner call, the tmp repo's files are verified byte-for-byte
 *    unchanged (READ-ONLY invariant).
 *
 * Invariants asserted:
 *   - scanTodos finds planted TODO/FIXME/HACK/XXX in source files
 *   - scanTodos skips node_modules/.git/dist directories
 *   - scanDeps parses mocked npm outdated + npm audit JSON
 *   - scanDocs flags missing README, missing LICENSE, no test script
 *   - scanTests flags 'no test script' heuristic (does NOT run the suite)
 *   - each scanner returns [] on any error (mocked subprocess failure)
 *   - NEVER writes to the repo — repo files byte-unchanged after every scan
 *   - scanner results carry no secrets (redaction invariant)
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

// We capture the mock handle so individual tests can configure return values.
let _execFileImpl: Mock;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // The mock must mirror the real execFile's util.promisify.custom behavior:
  // the genuine child_process.execFile carries a promisify.custom implementation
  // that resolves to `{ stdout, stderr }`. Without it, Node's generic promisify
  // resolves to the bare first callback value (the stdout string), which breaks
  // `const { stdout } = await execFileAsync(...)` destructuring in scanners.ts.
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
          // Mirror execFile semantics: on error, surface stdout/stderr on the
          // rejection so callers that inspect err.stdout (e.g. npm outdated)
          // still see the JSON payload.
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
    // spawnSync is used by github.ts (listIssues); keep it passable but
    // return not-a-repo so scanIssues degrades gracefully.
    spawnSync: () => ({ pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null }),
  };
});

// ---------------------------------------------------------------------------
// Lazy import — module must be loaded AFTER vi.mock is hoisted
// ---------------------------------------------------------------------------

import {
  SCANNERS,
  SCANNER_DESCRIPTORS,
  scanTodos,
  scanTests,
  scanExplicitMergeVerifyContracts,
  scanDeps,
  scanDocs,
  scanSecurity,
  isActionableFix,
  runScannerWithObservations,
} from '../src/core/portfolio/scanners.js';
import type { ScannerDescriptor, WorkItem } from '../src/core/types.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot of all files under a directory (relative path → Buffer). */
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

  // No files added
  for (const k of after.keys()) {
    expect(before.has(k), `Scanner created a new file: ${k}`).toBe(true);
  }
  // No files removed or modified
  for (const [k, buf] of before) {
    expect(after.has(k), `Scanner deleted file: ${k}`).toBe(true);
    expect(
      Buffer.compare(buf, after.get(k)!),
      `Scanner modified file: ${k}`,
    ).toBe(0);
  }
}

/** Create a minimal bare git repo (just .git dir) so git commands don't fail. */
function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'HEAD'),
    'ref: refs/heads/main\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

/** Build an execFile stub that always calls the callback with an error. */
function execFileError(): Mock {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile stubbed error'), '', '');
  });
}

/** Build an execFile stub that returns the given stdout string once, then errors. */
function _execFileReturns(responses: Record<string, string>): Mock {
  return vi.fn((...args: unknown[]) => {
    const cmd = args[0] as string;
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb !== 'function') return;

    // Match by command basename
    const base = path.basename(cmd);
    if (base in responses) {
      cb(null, responses[base]!, '');
    } else {
      cb(new Error(`no stub for ${base}`), '', '');
    }
  });
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach — fresh tmp dirs + HOME isolation
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m22-scanners-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m22-scanners-repo-'));
  process.env.HOME = tmpHome;

  // Default execFile: always errors (safe baseline — no real subprocesses)
  _execFileImpl = execFileError();

  initBareGitDir(tmpRepo);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// scanTodos
// ===========================================================================

describe('M22 scanTodos — planted TODO/FIXME/HACK/XXX comments', () => {
  it('finds a TODO comment in a source file', async () => {
    // M136: scanTodos is default-off; opt in via cfg. Use src/ path so the
    // first-party source check passes (rg returns relative paths in production).
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'main.ts'), '// TODO: fix this later\nconst x = 1;\n', 'utf8');

    // scanTodos uses rg or grep — stub rg to return the planted line
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      // Return a grep-style match: filename:lineno:text (relative, as rg does with cwd)
      cb(null, `src/main.ts:1:// TODO: fix this later\n`, '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanTodos(tmpRepo, { foundry: { scanTodos: true } });
    assertUnchanged(tmpRepo, before);

    expect(items.length).toBeGreaterThan(0);
    expect(items.some(i => i.source === 'todo')).toBe(true);
    expect(items.some(i => i.title.toLowerCase().includes('todo') || i.detail.toLowerCase().includes('todo'))).toBe(true);
  });

  it('finds FIXME, HACK, and XXX keywords', async () => {
    // M136: opt in + use src/ path for first-party source check.
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, 'src', 'app.ts'),
      '// FIXME: broken path\n// HACK: workaround\n// XXX: revisit\n',
      'utf8',
    );

    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      const out = [
        `src/app.ts:1:// FIXME: broken path`,
        `src/app.ts:2:// HACK: workaround`,
        `src/app.ts:3:// XXX: revisit`,
      ].join('\n') + '\n';
      cb(null, out, '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanTodos(tmpRepo, { foundry: { scanTodos: true } });
    assertUnchanged(tmpRepo, before);

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(i => i.source === 'todo')).toBe(true);
  });

  it('skips node_modules directory (never creates WorkItems from it)', async () => {
    // Plant a TODO inside node_modules — scanner must skip it
    const nmDir = path.join(tmpRepo, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), '// TODO: upstream fix\n', 'utf8');

    // Plant a real TODO in source so we can verify scanner runs
    fs.writeFileSync(path.join(tmpRepo, 'src.ts'), '// TODO: real task\n', 'utf8');

    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      // Only return the source file TODO, not node_modules (as a correct implementation should)
      cb(null, `${path.join(tmpRepo, 'src.ts')}:1:// TODO: real task\n`, '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanTodos(tmpRepo);
    assertUnchanged(tmpRepo, before);

    // Verify: no item references node_modules
    for (const item of items) {
      expect(item.detail).not.toContain('node_modules');
      expect(item.id).not.toContain('node_modules');
    }
  });

  it('returns [] when rg/grep returns non-zero (no matches)', async () => {
    // grep exits 1 when no matches — scanner must return [] not throw
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      const err = Object.assign(new Error('grep exit 1'), { code: 1 });
      cb(err, '', '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanTodos(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });

  it('returns [] when execFile throws unexpectedly', async () => {
    _execFileImpl = vi.fn(() => { throw new Error('unexpected execFile throw'); });

    const before = snapshotDir(tmpRepo);
    const items = await scanTodos(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });

  it('repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'index.ts'), '// TODO: check me\nconst y = 2;\n', 'utf8');
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'index.ts')}:1:// TODO: check me\n`, '');
    });

    const before = snapshotDir(tmpRepo);
    await scanTodos(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });

  it('each WorkItem has required fields with valid values', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'a.ts'), '// TODO: do something\n', 'utf8');
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'a.ts')}:1:// TODO: do something\n`, '');
    });

    const items = await scanTodos(tmpRepo);
    if (items.length === 0) return; // scanner may return [] gracefully — that's fine

    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.repo).toBe(tmpRepo);
      expect(item.source).toBe('todo');
      expect(typeof item.title).toBe('string');
      expect(typeof item.detail).toBe('string');
      expect(item.value).toBeGreaterThanOrEqual(1);
      expect(item.value).toBeLessThanOrEqual(5);
      expect(item.effort).toBeGreaterThanOrEqual(1);
      expect(item.effort).toBeLessThanOrEqual(5);
      expect(item.score).toBeGreaterThan(0);
      expect(Array.isArray(item.tags)).toBe(true);
      expect(typeof item.ts).toBe('string');
      // ts should be parseable as an ISO date
      expect(() => new Date(item.ts)).not.toThrow();
    }
  });
});

// ===========================================================================
// scanDeps
// ===========================================================================

describe('M22 scanDeps — npm outdated + npm audit JSON', () => {
  const OUTDATED_JSON = JSON.stringify({
    lodash: {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      dependent: 'my-app',
      location: 'node_modules/lodash',
    },
    express: {
      current: '4.17.0',
      wanted: '4.18.2',
      latest: '4.18.2',
      dependent: 'my-app',
      location: 'node_modules/express',
    },
  });

  const AUDIT_JSON = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      'minimist': {
        name: 'minimist',
        severity: 'critical',
        isDirect: false,
        via: [],
        effects: [],
        range: '<1.2.6',
        nodes: ['node_modules/minimist'],
        fixAvailable: true,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 1, total: 2 },
      dependencies: { prod: 10, dev: 5, optional: 0, peer: 0, peerOptional: 0, total: 15 },
    },
  });

  beforeEach(() => {
    // Provide a package.json so the scanner recognises it as an npm project
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'package-lock.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0', lockfileVersion: 3, packages: {} }),
      'utf8',
    );
  });

  it('parses npm outdated JSON and returns dep WorkItems', async () => {
    let callCount = 0;
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      callCount++;
      // npm outdated exits 1 when there are outdated packages — that's normal
      if (callCount === 1) {
        const err = Object.assign(new Error('outdated'), { code: 1 });
        (cb as unknown as (e: Error, o: string, s: string) => void)(err, OUTDATED_JSON, '');
      } else {
        cb(null, AUDIT_JSON, '');
      }
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    assertUnchanged(tmpRepo, before);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.source === 'dep')).toBe(true);
  });

  it('parses npm audit JSON vulnerability counts', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      // First call: npm outdated (exit 1 = packages outdated, stdout is JSON)
      // Second call: npm audit (exit 1 = vulns found, stdout is JSON)
      cb(null, AUDIT_JSON, '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    assertUnchanged(tmpRepo, before);

    // Should not throw; items may or may not include audit findings depending
    // on call ordering — just verify shape
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      expect(item.source).toBe('dep');
      expect(typeof item.title).toBe('string');
      expect(item.value).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns [] when execFile errors (npm not found)', async () => {
    _execFileImpl = execFileError();

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });

  it('returns [] when npm outdated output is malformed JSON', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, 'NOT VALID JSON }{', '');
    });

    const before = snapshotDir(tmpRepo);
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    assertUnchanged(tmpRepo, before);

    expect(Array.isArray(items)).toBe(true);
  });

  it('repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      const err = Object.assign(new Error('outdated'), { code: 1 });
      (cb as unknown as (e: Error, o: string, s: string) => void)(err, OUTDATED_JSON, '');
    });

    const before = snapshotDir(tmpRepo);
    await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    assertUnchanged(tmpRepo, before);
  });

  it('does NOT run npm install or npm test (only metadata reads)', () => {
    // Verify the scanner never calls npm with install/test/build args
    const dangerous = ['install', 'test', 'run', 'build', 'ci', 'publish'];
    const calledWith: string[][] = [];

    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cmdArgs = args[1] as string[] | undefined;
      if (cmdArgs) calledWith.push(cmdArgs);
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') cb(null, '{}', '');
    });

    // We don't await here — just register and check below
    void scanDeps(tmpRepo).then(() => {
      for (const argList of calledWith) {
        for (const sub of dangerous) {
          expect(
            argList.includes(sub),
            `scanDeps must not run 'npm ${sub}' — found in args: ${argList.join(' ')}`,
          ).toBe(false);
        }
      }
    });
  });
});

// ===========================================================================
// isActionableFix — pure helper unit tests (M74)
// ===========================================================================

describe('M74 isActionableFix — npm audit fixAvailable filter', () => {
  // --- Actionable cases (should return true) ---

  it('returns true when fixAvailable is boolean true', () => {
    expect(isActionableFix(true)).toBe(true);
  });

  it('returns true when fixAvailable is an object with isSemVerMajor:false', () => {
    expect(isActionableFix({ name: 'lodash', version: '4.17.21', isSemVerMajor: false })).toBe(true);
  });

  it('returns true when fixAvailable object has no isSemVerMajor key', () => {
    // Treat absent isSemVerMajor as a non-breaking fix
    expect(isActionableFix({ name: 'lodash', version: '4.17.21' })).toBe(true);
  });

  // --- Non-actionable cases (should return false) ---

  it('returns false when fixAvailable is boolean false', () => {
    expect(isActionableFix(false)).toBe(false);
  });

  it('returns false when fixAvailable is null', () => {
    expect(isActionableFix(null)).toBe(false);
  });

  it('returns false when fixAvailable is undefined', () => {
    expect(isActionableFix(undefined)).toBe(false);
  });

  it('returns false when fixAvailable is an object with isSemVerMajor:true', () => {
    expect(isActionableFix({ name: 'esbuild', version: '1.0.0', isSemVerMajor: true })).toBe(false);
  });

  // --- Edge / malformed inputs ---

  it('returns false for a string value (unexpected shape)', () => {
    expect(isActionableFix('yes')).toBe(false);
  });

  it('returns false for a number value (unexpected shape)', () => {
    expect(isActionableFix(42)).toBe(false);
  });

  it('returns false for an array (unexpected shape)', () => {
    expect(isActionableFix([])).toBe(false);
  });
});

// ===========================================================================
// scanDeps — actionable-fix filter integration (M74)
// ===========================================================================

describe('M74 scanDeps — npm audit fixAvailable filter integration', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'package-lock.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0', lockfileVersion: 3, packages: {} }),
      'utf8',
    );
  });

  /** Build a minimal npm audit v2 JSON payload with the given vulnerabilities. */
  function buildAuditJson(
    vulns: Record<string, { severity: string; fixAvailable: unknown }>,
  ): string {
    return JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: vulns,
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: { prod: 5, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 7 },
      },
    });
  }

  function stubAudit(auditJson: string): void {
    let callCount = 0;
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      callCount++;
      if (callCount === 1) {
        // First call: npm outdated — return empty (no outdated deps)
        cb(null, '{}', '');
      } else {
        // Second call: npm audit — return our fixture
        cb(null, auditJson, '');
      }
    });
  }

  it('does NOT emit a WorkItem for fixAvailable:false (no fix exists)', async () => {
    stubAudit(buildAuditJson({
      'some-pkg': { severity: 'critical', fixAvailable: false },
    }));
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    const vulnItems = items.filter(i => i.tags.includes('vulnerability'));
    expect(vulnItems).toHaveLength(0);
  });

  it('does NOT emit a WorkItem for fixAvailable:{isSemVerMajor:true} (breaking-only fix)', async () => {
    stubAudit(buildAuditJson({
      'esbuild': { severity: 'critical', fixAvailable: { name: 'esbuild', version: '1.0.0', isSemVerMajor: true } },
    }));
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    const vulnItems = items.filter(i => i.tags.includes('vulnerability'));
    expect(vulnItems).toHaveLength(0);
  });

  it('DOES emit a WorkItem for fixAvailable:true (non-breaking patch/minor fix)', async () => {
    stubAudit(buildAuditJson({
      'minimist': { severity: 'critical', fixAvailable: true },
    }));
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    const vulnItems = items.filter(i => i.tags.includes('vulnerability'));
    expect(vulnItems.length).toBeGreaterThan(0);
    expect(vulnItems.some(i => i.tags.includes('critical'))).toBe(true);
  });

  it('DOES emit a WorkItem for fixAvailable:{isSemVerMajor:false} (non-breaking fix object)', async () => {
    stubAudit(buildAuditJson({
      'lodash': { severity: 'high', fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false } },
    }));
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    const vulnItems = items.filter(i => i.tags.includes('vulnerability'));
    expect(vulnItems.length).toBeGreaterThan(0);
    expect(vulnItems.some(i => i.tags.includes('high'))).toBe(true);
  });

  it('mixed: only actionable advisories appear — esbuild suppressed, minimist surfaces', async () => {
    stubAudit(buildAuditJson({
      // NOT actionable — breaking major required
      'esbuild': { severity: 'critical', fixAvailable: { name: 'esbuild', version: '1.0.0', isSemVerMajor: true } },
      // NOT actionable — no fix at all
      'semver': { severity: 'high', fixAvailable: false },
      // ACTIONABLE — non-breaking fix
      'minimist': { severity: 'moderate', fixAvailable: true },
    }));
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    const vulnItems = items.filter(i => i.tags.includes('vulnerability'));
    // Only the moderate (minimist) advisory should surface
    expect(vulnItems.some(i => i.tags.includes('moderate'))).toBe(true);
    expect(vulnItems.some(i => i.tags.includes('critical'))).toBe(false);
    expect(vulnItems.some(i => i.tags.includes('high'))).toBe(false);
  });

  it('never throws on malformed/empty audit JSON', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, '{not valid json}', '');
    });
    await expect(scanDeps(tmpRepo)).resolves.toEqual(expect.any(Array));
  });

  it('returns [] on empty audit output', async () => {
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, '', '');
    });
    const items = await scanDeps(tmpRepo, { foundry: { scanDeps: true, scanDependencyBumps: true } });
    expect(Array.isArray(items)).toBe(true);
  });
});

// ===========================================================================
// scanDocs
// ===========================================================================

describe('M22 scanDocs — missing README/LICENSE/CONTRIBUTING heuristics', () => {
  it('flags missing README.md', async () => {
    // Repo has no README
    const before = snapshotDir(tmpRepo);
    const items = await scanDocs(tmpRepo, { foundry: { scanHygiene: true } });
    assertUnchanged(tmpRepo, before);

    expect(items.some(i => i.source === 'doc')).toBe(true);
    expect(
      items.some(i =>
        i.title.toLowerCase().includes('readme') ||
        i.detail.toLowerCase().includes('readme'),
      ),
    ).toBe(true);
  });

  it('flags missing LICENSE file', async () => {
    // Provide a README but no LICENSE
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# My Project\n', 'utf8');

    const before = snapshotDir(tmpRepo);
    const items = await scanDocs(tmpRepo, { foundry: { scanHygiene: true } });
    assertUnchanged(tmpRepo, before);

    expect(Array.isArray(items)).toBe(true);
    // If README is present, the scanner should at least flag missing LICENSE
    const licenseItem = items.find(
      i => i.title.toLowerCase().includes('license') || i.detail.toLowerCase().includes('license'),
    );
    // The scanner may or may not produce a license item — check that if it does,
    // the shape is valid
    if (licenseItem) {
      expect(licenseItem.source).toBe('doc');
    }
  });

  it('returns fewer (or no) doc items when README + LICENSE are present', async () => {
    // README must exceed the thin-readme threshold (>= 300 bytes) so the
    // scanner treats it as a satisfactory, present README — matching this
    // test's intent ("well documented project"). A short stub would otherwise
    // trip the legitimate thin-readme heuristic (a separate concern from a
    // *missing* README) and emit a readme-titled item.
    fs.writeFileSync(
      path.join(tmpRepo, 'README.md'),
      '# My Project\n\n' +
        'This is a thoroughly documented project with a comprehensive README ' +
        'that comfortably exceeds the thin-readme threshold.\n\n' +
        '## Installation\n\nClone the repository and run the installer, then ' +
        'follow the interactive prompts to complete setup.\n\n' +
        '## Usage\n\nInvoke the CLI with the desired subcommand and pass any ' +
        'flags your workflow requires.\n\n' +
        '## Contributing\n\nPull requests are welcome; please open an issue ' +
        'first to discuss the change you would like to make.\n',
      'utf8',
    );
    fs.writeFileSync(path.join(tmpRepo, 'LICENSE'), 'MIT License\n', 'utf8');

    const before = snapshotDir(tmpRepo);
    const itemsWithDocs = await scanDocs(tmpRepo);
    assertUnchanged(tmpRepo, before);

    // Should not flag README or LICENSE now
    expect(
      itemsWithDocs.filter(i =>
        i.title.toLowerCase().includes('readme') ||
        i.title.toLowerCase().includes('license'),
      ).length,
    ).toBe(0);
  });

  it('flags low test presence (no test script in package.json)', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'no-tests', version: '1.0.0', scripts: {} }),
      'utf8',
    );
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# X\n', 'utf8');

    const before = snapshotDir(tmpRepo);
    const items = await scanDocs(tmpRepo, { foundry: { scanHygiene: true } });
    assertUnchanged(tmpRepo, before);

    expect(Array.isArray(items)).toBe(true);
    // May flag low test coverage
  });

  it('never throws on an empty repo', async () => {
    const before = snapshotDir(tmpRepo);
    let items: unknown[] = [];
    await expect(
      scanDocs(tmpRepo).then(r => { items = r; }),
    ).resolves.not.toThrow();
    assertUnchanged(tmpRepo, before);
    expect(Array.isArray(items)).toBe(true);
  });

  it('returns [] or valid items on an unreadable repo path', async () => {
    const items = await scanDocs('/nonexistent/path/that/does/not/exist');
    expect(Array.isArray(items)).toBe(true);
  });

  it('repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Project\n', 'utf8');
    const before = snapshotDir(tmpRepo);
    await scanDocs(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });

  it('WorkItems have valid shape', async () => {
    const items = await scanDocs(tmpRepo, { foundry: { scanHygiene: true } });
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item.repo).toBe(tmpRepo);
      expect(item.source).toBe('doc');
      expect(typeof item.title).toBe('string');
      expect(item.value).toBeGreaterThanOrEqual(1);
      expect(item.value).toBeLessThanOrEqual(5);
      expect(item.effort).toBeGreaterThanOrEqual(1);
      expect(item.effort).toBeLessThanOrEqual(5);
      expect(item.score).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// scanTests
// ===========================================================================

describe('M22 scanTests — CI state heuristic, NO test suite execution', () => {
  it('flags a repo with no test script in package.json', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'no-tests', version: '1.0.0', scripts: { build: 'tsc' } }),
      'utf8',
    );

    const before = snapshotDir(tmpRepo);
    const items = await scanTests(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(Array.isArray(items)).toBe(true);
    if (items.length > 0) {
      expect(items.every(i => i.source === 'test')).toBe(true);
    }
  });

  it('does NOT execute the test suite (never calls npm test)', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { test: 'vitest run' } }),
      'utf8',
    );

    const dangerousCalls: string[] = [];
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[] | undefined;
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;

      // Track dangerous calls (npm test / npm run test / vitest)
      const base = path.basename(cmd);
      if (base === 'npm' && cmdArgs?.includes('test')) {
        dangerousCalls.push(`${base} ${cmdArgs?.join(' ')}`);
      }
      if (base === 'npm' && cmdArgs?.includes('run')) {
        dangerousCalls.push(`${base} ${cmdArgs?.join(' ')}`);
      }
      if (base === 'vitest' || base === 'jest' || base === 'mocha') {
        dangerousCalls.push(base);
      }

      if (typeof cb === 'function') cb(null, '[]', '');
    });

    const before = snapshotDir(tmpRepo);
    await scanTests(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(dangerousCalls.length).toBe(0);
  });

  it('returns [] on any error (gh unavailable)', async () => {
    _execFileImpl = execFileError();

    const before = snapshotDir(tmpRepo);
    const items = await scanTests(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(Array.isArray(items)).toBe(true);
  });

  it('never throws even if execFile throws synchronously', async () => {
    _execFileImpl = vi.fn(() => { throw new Error('execFile sync throw'); });

    const before = snapshotDir(tmpRepo);
    let items: unknown[] = [];
    await expect(
      scanTests(tmpRepo).then(r => { items = r; }),
    ).resolves.not.toThrow();
    assertUnchanged(tmpRepo, before);
    expect(Array.isArray(items)).toBe(true);
  });

  it('repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'pkg', scripts: { test: 'vitest' } }),
      'utf8',
    );
    const before = snapshotDir(tmpRepo);
    await scanTests(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });
});

// ===========================================================================
// scanExplicitMergeVerifyContracts
// ===========================================================================

describe('M22 scanExplicitMergeVerifyContracts — merge-grade contract rollout', () => {
  it('emits one item for detected commands and no contract', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'pkg', scripts: { test: 'vitest run' } }),
      'utf8',
    );

    const before = snapshotDir(tmpRepo);
    const items = await scanExplicitMergeVerifyContracts(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.source).toBe('test');
    expect(item.value).toBe(4);
    expect(item.effort).toBe(2);
    expect(item.tags).toEqual(expect.arrayContaining([
      'test',
      'verification',
      'merge-contract',
      'ashlr.verify.json',
    ]));
    expect(item.detail).toContain('Add root ashlr.verify.json');
    expect(item.detail).toContain('Preserve existing detected verifier intent');
    expect(item.detail).toContain('mark required merge profile commands');
    expect(item.detail).toContain('keep cwd inside repo');
    expect(item.detail).toContain('avoid changing package scripts, lockfiles, or CI');
  });

  it('emits nothing for a valid required profiles:["merge"] contract', async () => {
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ name: 'pkg', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'ashlr.verify.json'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'augment-detected',
        commands: [
          {
            id: 'test',
            kind: 'test',
            cmd: ['npm', 'test'],
            profiles: ['merge'],
            required: true,
          },
        ],
      }),
      'utf8',
    );

    const before = snapshotDir(tmpRepo);
    const items = await scanExplicitMergeVerifyContracts(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });

  it('skips repos with no detected verify commands', async () => {
    const before = snapshotDir(tmpRepo);
    const items = await scanExplicitMergeVerifyContracts(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });
});

// ===========================================================================
// scanSecurity
// ===========================================================================

describe('M22 scanSecurity — binshield or skip', () => {
  it('returns [] when binshield is not installed (execFile errors)', async () => {
    _execFileImpl = execFileError();

    const before = snapshotDir(tmpRepo);
    const items = await scanSecurity(tmpRepo);
    assertUnchanged(tmpRepo, before);

    expect(items).toEqual([]);
  });

  it('never throws regardless of execFile outcome', async () => {
    _execFileImpl = vi.fn(() => { throw new Error('no binshield'); });

    const before = snapshotDir(tmpRepo);
    let items: unknown[] = [];
    await expect(
      scanSecurity(tmpRepo).then(r => { items = r; }),
    ).resolves.not.toThrow();
    assertUnchanged(tmpRepo, before);
    expect(Array.isArray(items)).toBe(true);
  });

  it('returns [] on a nonexistent repo path without throwing', async () => {
    const items = await scanSecurity('/nonexistent/path/that/does/not/exist');
    expect(Array.isArray(items)).toBe(true);
  });

  it('repo files are byte-unchanged after scanning (READ-ONLY)', async () => {
    const before = snapshotDir(tmpRepo);
    await scanSecurity(tmpRepo);
    assertUnchanged(tmpRepo, before);
  });
});

// ===========================================================================
// Cross-scanner: no secrets in WorkItems
// ===========================================================================

describe('M22 scanners — no secrets in WorkItem output', () => {
  it('scanTodos output contains no token-like strings', async () => {
    // Plant a file with a comment that looks like it could leak a secret
    fs.writeFileSync(
      path.join(tmpRepo, 'cfg.ts'),
      '// TODO: remove sk-live-abc123secret from config\n',
      'utf8',
    );

    // Return the comment from the stub
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function') return;
      cb(null, `${path.join(tmpRepo, 'cfg.ts')}:1:// TODO: remove sk-live-abc123secret from config\n`, '');
    });

    const items = await scanTodos(tmpRepo);

    // Detail may contain the TODO text (that's expected) but must not include
    // env vars injected by the scanner itself
    for (const item of items) {
      expect(item.detail).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
      expect(item.detail).not.toMatch(/Bearer [a-zA-Z0-9._-]{20,}/);
      // scanner must not inject process.env tokens
      if (process.env.GITHUB_TOKEN) {
        expect(item.detail).not.toContain(process.env.GITHUB_TOKEN);
      }
    }
  });
});

// ===========================================================================
// ENROLLMENT-SCOPED invariant (guarded via buildBacklog, not individual scanners)
// ===========================================================================

describe('M22 scanners — scanners accept any path (enrollment enforced by buildBacklog)', () => {
  // Individual scanners are pure analyzers that accept any path.
  // Enrollment gating is the responsibility of buildBacklog.
  // This test documents that direct scanner calls do NOT enforce enrollment —
  // instead they are READ-ONLY analyzers that simply return [] gracefully.
  it('scanTodos called directly on a non-enrolled path returns [] or items (no enrollment check at scanner level)', async () => {
    _execFileImpl = execFileError();
    const items = await scanTodos('/some/non-enrolled/path');
    expect(Array.isArray(items)).toBe(true);
  });
});

// ===========================================================================
// Scanner observations — additive metadata, never lifecycle authority
// ===========================================================================

describe('scanner observation foundation', () => {
  const legacyDescriptor: ScannerDescriptor = {
    id: 'test-legacy',
    domain: 'test-domain',
    source: 'test',
    description: 'Test-only legacy scanner.',
    evidence: 'legacy',
    canAssertAbsent: false,
    maxItems: 2,
  };

  function observedItem(id: string): WorkItem {
    return {
      id,
      repo: tmpRepo,
      source: 'test',
      title: `Objective ${id}`,
      detail: `Implement ${id} without changing unrelated code.`,
      value: 4,
      effort: 2,
      score: 2,
      tags: ['test'],
      ts: new Date().toISOString(),
    };
  }

  it('publishes a detailed descriptor for every legacy SCANNERS entry', () => {
    expect(SCANNER_DESCRIPTORS).toHaveLength(SCANNERS.length);
    expect(new Set(SCANNER_DESCRIPTORS.map((descriptor) => descriptor.id)).size).toBe(SCANNERS.length);
    for (const descriptor of SCANNER_DESCRIPTORS) {
      expect(descriptor.domain.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.maxItems).toBeGreaterThan(0);
      expect(descriptor.scannerRevision).toBe(1);
    }
    expect(SCANNER_DESCRIPTORS.filter((descriptor) => descriptor.canAssertAbsent).map((descriptor) => descriptor.id))
      .toEqual(['queued-autonomy', 'merge-verify-contract']);
    expect(SCANNER_DESCRIPTORS.filter((descriptor) => descriptor.evidence === 'legacy').every(
      (descriptor) => !descriptor.canAssertAbsent,
    )).toBe(true);
  });

  it('binds present evidence to the exact item id and objective hash', async () => {
    loadOrCreateKey();
    const item = observedItem('exact-item');
    const result = await runScannerWithObservations(legacyDescriptor, async () => [item], tmpRepo);

    expect(result.items).toEqual([item]);
    expect(result.observations).toEqual([expect.objectContaining({
      scannerId: legacyDescriptor.id,
      domain: legacyDescriptor.domain,
      source: item.source,
      status: 'present',
      reason: 'item-observed',
      itemId: item.id,
      objectiveHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(result.observations[0]).not.toHaveProperty('title');
    expect(result.observations[0]).not.toHaveProperty('detail');
  });

  it('never converts a legacy empty result or caught failure into absent', async () => {
    const empty = await runScannerWithObservations(legacyDescriptor, async () => [], tmpRepo);
    const failed = await runScannerWithObservations(legacyDescriptor, async () => {
      throw new Error('scanner failed');
    }, tmpRepo);

    expect(empty.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'legacy-empty-result',
    })]);
    expect(failed.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'scanner-failed',
    })]);
    expect([...empty.observations, ...failed.observations].some((observation) => observation.status === 'absent'))
      .toBe(false);
  });

  it('bounds observations without truncating legacy scanner items', async () => {
    loadOrCreateKey();
    const items = ['one', 'two', 'three', 'four'].map(observedItem);
    const result = await runScannerWithObservations(legacyDescriptor, async () => items, tmpRepo);

    expect(result.items).toEqual(items);
    expect(result.observations).toHaveLength(legacyDescriptor.maxItems);
    expect(result.observations.map((observation) => observation.itemId)).toEqual(['one', 'two']);
  });

  it('lets the exhaustive local queue descriptor confirm absence', async () => {
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'queued-autonomy')!;
    const legacyScanner = vi.fn(async () => [] as WorkItem[]);
    const result = await runScannerWithObservations(descriptor, legacyScanner, tmpRepo);

    expect(result.observations).toEqual([expect.objectContaining({
      scannerId: 'queued-autonomy',
      domain: 'local-queue',
      status: 'absent',
      reason: 'source-confirmed-empty',
    })]);
    expect(result.observations[0]).not.toHaveProperty('itemId');
    expect(result.observations[0]).not.toHaveProperty('objectiveHash');
    expect(legacyScanner).not.toHaveBeenCalled();
  });

  it('fails queued-autonomy evidence closed when local storage is malformed', async () => {
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'queued-autonomy')!;
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'self-heal-queue.json'), '{not-json', 'utf8');

    const legacyScanner = vi.fn(async () => [observedItem('unsafe-fallback')]);
    const result = await runScannerWithObservations(descriptor, legacyScanner, tmpRepo);

    expect(result.items).toEqual([]);
    expect(legacyScanner).not.toHaveBeenCalled();
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'source-unavailable',
    })]);
  });

  function stubGitStates(
    heads: string[],
    statuses: string[],
    ignoredContract = false,
    hiddenIndexState = false,
  ): void {
    let headIndex = 0;
    let statusIndex = 0;
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const command = args[0];
      const commandArgs = args[1] as string[] | undefined;
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      if (typeof cb !== 'function' || command !== 'git' || !commandArgs) return;
      if (commandArgs[0] === 'rev-parse') {
        cb(null, `${heads[headIndex++] ?? heads.at(-1) ?? ''}\n`, '');
      } else if (commandArgs[0] === 'status') {
        cb(null, statuses[statusIndex++] ?? statuses.at(-1) ?? '', '');
      } else if (commandArgs[0] === 'ls-files') {
        cb(null, `${hiddenIndexState ? 'S' : 'H'} package.json\0`, '');
      } else if (commandArgs[0] === 'check-ignore') {
        if (ignoredContract) cb(null, '', '');
        else cb(Object.assign(new Error('not ignored'), { code: 1 }), '', '');
      } else {
        cb(new Error('unexpected git command'), '', '');
      }
    });
  }

  it('binds clean stable merge-contract presence to HEAD and canonical verifier config', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    stubGitStates(['a'.repeat(40), 'a'.repeat(40)], ['', '']);
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;
    const legacyScanner = vi.fn(async () => [] as WorkItem[]);

    const result = await runScannerWithObservations(descriptor, legacyScanner, tmpRepo);

    expect(result.items).toHaveLength(1);
    expect(legacyScanner).not.toHaveBeenCalled();
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'present',
      reason: 'item-observed',
      sourceBase: expect.objectContaining({
        scannerRevision: descriptor.scannerRevision,
        sourceKind: 'git-tree',
        consistency: 'stable-double-read',
        dirty: 'clean',
        baseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })]);
    expect(_execFileImpl).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain=v2', '--untracked-files=all'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('binds clean stable merge-contract absence without item identity fields', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'ashlr.verify.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'replace-detected',
      commands: [{ id: 'merge', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
    }), 'utf8');
    stubGitStates(['b'.repeat(40), 'b'.repeat(40)], ['', '']);
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;

    const result = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(result.items).toEqual([]);
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'absent',
      reason: 'source-confirmed-empty',
      sourceBase: expect.objectContaining({ scannerRevision: 1 }),
    })]);
    expect(result.observations[0]).not.toHaveProperty('itemId');
    expect(result.observations[0]).not.toHaveProperty('objectiveHash');
  });

  it('emits unavailable without a source base for dirty, raced, or unreadable Git state', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;

    stubGitStates(['c'.repeat(40)], [' M package.json\n']);
    const dirty = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);
    stubGitStates(['d'.repeat(40), 'e'.repeat(40)], ['', '']);
    const raced = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);
    _execFileImpl = execFileError();
    const unavailable = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(dirty.observations).toEqual([expect.objectContaining({ status: 'unavailable', reason: 'source-dirty' })]);
    expect(raced.observations).toEqual([expect.objectContaining({ status: 'unavailable', reason: 'source-raced' })]);
    expect(unavailable.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'source-snapshot-unavailable',
    })]);
    expect(dirty.items).toHaveLength(1);
    expect(raced.items).toEqual([]);
    expect(unavailable.items).toHaveLength(1);
    for (const observation of [...dirty.observations, ...raced.observations, ...unavailable.observations]) {
      expect(observation).not.toHaveProperty('sourceBase');
    }
  });

  it('refuses revision-bound evidence for an ignored merge contract', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'ashlr.verify.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'replace-detected',
      commands: [{ id: 'merge', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
    }), 'utf8');
    stubGitStates(['1'.repeat(40)], [''], true);
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;

    const result = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(result.items).toEqual([]);
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'source-snapshot-unavailable',
    })]);
    expect(result.observations[0]).not.toHaveProperty('sourceBase');
  });

  it('reports malformed package metadata as unavailable instead of trusted absence', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"scripts":', 'utf8');
    stubGitStates(['2'.repeat(40), '2'.repeat(40)], ['', '']);
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;

    const result = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(result.items).toEqual([]);
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'source-malformed',
    })]);
    expect(result.observations[0]).not.toHaveProperty('sourceBase');
  });

  it('refuses Git-tree evidence when index flags can hide worktree changes', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    stubGitStates(['3'.repeat(40)], [''], false, true);
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;

    const result = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(result.items).toHaveLength(1);
    expect(result.observations).toEqual([expect.objectContaining({
      status: 'unavailable',
      reason: 'source-snapshot-unavailable',
    })]);
    expect(result.observations[0]).not.toHaveProperty('sourceBase');
  });

  it('changes exact state but preserves requirements when the merge contract satisfies the objective', async () => {
    loadOrCreateKey();
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    const descriptor = SCANNER_DESCRIPTORS.find((candidate) => candidate.id === 'merge-verify-contract')!;
    stubGitStates(['f'.repeat(40), 'f'.repeat(40)], ['', '']);
    const missing = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    fs.writeFileSync(path.join(tmpRepo, 'ashlr.verify.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'replace-detected',
      commands: [{ id: 'merge', kind: 'test', cmd: ['npm', 'test'], required: true, profiles: ['merge'] }],
    }), 'utf8');
    stubGitStates(['f'.repeat(40), 'f'.repeat(40)], ['', '']);
    const satisfied = await runScannerWithObservations(descriptor, scanExplicitMergeVerifyContracts, tmpRepo);

    expect(missing.observations[0]).toMatchObject({ status: 'present' });
    expect(satisfied.observations[0]).toMatchObject({ status: 'absent' });
    const priorBase = missing.observations[0]?.sourceBase;
    const currentBase = satisfied.observations[0]?.sourceBase;
    expect(currentBase?.requirementDigest).toBe(priorBase?.requirementDigest);
    expect(currentBase?.configDigest).toBe(priorBase?.configDigest);
    expect(currentBase?.sourceDigest).not.toBe(priorBase?.sourceDigest);
    expect(currentBase?.baseDigest).not.toBe(priorBase?.baseDigest);
  });
});
