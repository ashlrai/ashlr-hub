/**
 * h7.preflight.test.ts — Ashlr v2.1 MILESTONE H7, BUILD ITEM 1.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H7.md):
 *  - PREFLIGHT-READ-ONLY: `ashlr preflight` / buildReadiness report readiness
 *    (model reachable, enrollment count, kill-switch, daemon not stuck, ~/.ashlr
 *    writeable, sandbox health, git, phantom) and MUTATE NOTHING — enrollment.json
 *    / KILL / daemon.json / sandboxes/ are byte-identical before/after, and a
 *    fresh home never gains ~/.ashlr. Model DOWN is a warning, never a crash or
 *    a blocker. Valid empty enrollment is fine; degraded enrollment blocks.
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6):
 *  - ISOLATED HOME per test via the H1 fixture (makeFixture): every ~/.ashlr
 *    read/write resolves to a FRESH os.tmpdir() home — NEVER the real one; the
 *    real portfolio ({repos:[]}) is never touched.
 *  - DISPOSABLE REPOS only (fx.makeRepo); DETERMINISTIC — probeEndpoint is
 *    mocked/down-tolerant, NO live model, NO network.
 *  - Every it() ends with a real expect() + expect.hasAssertions().
 *
 * MOCKING: probeEndpoint is mocked (hoisted, before the readiness import) so the
 * suite is deterministic with NO live model and NO network. The default mock is
 * DOWN (the most conservative default); the "ready" test overrides it to UP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const privateStorageMocks = vi.hoisted(() => ({ assure: vi.fn() }));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) =>
      privateStorageMocks.assure.getMockImplementation()
        ? privateStorageMocks.assure(...args)
        : actual.assurePrivateStoragePath(...args),
  };
});

// Hoisted mock of the providers module so buildReadiness/cmdPreflight never make
// a real network probe. Default: every endpoint DOWN (never throws).
const mockProbeEndpoint = vi.fn(
  async (id: string, url: string): Promise<{ id: string; url: string; up: boolean; models: string[]; error?: string }> => ({
    id,
    url,
    up: false,
    models: [],
    error: 'mocked-down (test)',
  }),
);
vi.mock('../src/core/providers.js', () => ({
  probeEndpoint: (...args: [string, string]) => mockProbeEndpoint(...args),
}));

// Post-mock (lazy) imports of the REAL surfaces under test.
import { buildReadiness, checkAshlrWriteable, readEnrollmentState } from '../src/core/readiness.js';
import { cmdPreflight } from '../src/cli/preflight.js';
import { loadConfig } from '../src/core/config.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { withPlatform } from './helpers/platform.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

import { existsSync, readFileSync, readdirSync, chmodSync, statSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let fx: H1Fixture | undefined;

// Capture stdout written by cmdPreflight so we can assert on it without leaking
// to the test runner output.
function captureStdout<T>(fn: () => T | Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  return Promise.resolve()
    .then(() => fn())
    .then((result) => ({ result, out: chunks.join('') }))
    .finally(() => spy.mockRestore());
}

/** Snapshot the on-disk byte-state of the isolated ~/.ashlr state surfaces. */
function snapshotState(ashlrDir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  const files = ['enrollment.json', 'KILL', 'daemon.json'];
  for (const f of files) {
    const p = join(ashlrDir, f);
    snap[f] = existsSync(p) ? readFileSync(p, 'utf8') : '<absent>';
  }
  const sbDir = join(ashlrDir, 'sandboxes');
  snap['sandboxes/'] = existsSync(sbDir)
    ? readdirSync(sbDir).sort().join(',')
    : '<absent>';
  return snap;
}

beforeEach(() => {
  fx = makeFixture();
  privateStorageMocks.assure.mockImplementation((_path, _kind, mode) => ({
    ok: true,
    reason: mode === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
  }));
  // Default: both local model endpoints DOWN.
  mockProbeEndpoint.mockImplementation(async (id: string, url: string) => ({
    id,
    url,
    up: false,
    models: [],
    error: 'mocked-down (test)',
  }));
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  vi.restoreAllMocks();
  mockProbeEndpoint.mockReset();
  privateStorageMocks.assure.mockReset();
});

describe('h7 preflight — READ-ONLY readiness check', () => {
  it('reports ready=true on a healthy isolated install with model mocked up', async () => {
    expect.hasAssertions();
    // Model UP for this test.
    mockProbeEndpoint.mockImplementation(async (id: string, url: string) => ({
      id,
      url,
      up: true,
      models: ['test-model'],
    }));
    const cfg = makeCfg({
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    } as Partial<import('../src/core/types.js').AshlrConfig>);

    const report = await buildReadiness(cfg);

    expect(report.ready).toBe(true);
    expect(report.blockers).toHaveLength(0);
    // The model facet, when up, is an info note (not a warning).
    const modelInfo = report.info.find((f) => f.id === 'model');
    expect(modelInfo).toBeDefined();
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports ready=true with an empty enrollment (fresh install is fine — info, not blocker)', async () => {
    expect.hasAssertions();
    // Fresh isolated home: nothing enrolled.
    expect(existsSync(join(fx!.ashlrDir, 'enrollment.json'))).toBe(false);
    expect(existsSync(fx!.ashlrDir)).toBe(false);
    const cfg = makeCfg({
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    } as Partial<import('../src/core/types.js').AshlrConfig>);

    const report = await buildReadiness(cfg);

    // Empty enrollment must NOT be a blocker — it is an info note.
    const enrollFinding =
      report.blockers.find((f) => f.id === 'enrollment') ??
      report.warnings.find((f) => f.id === 'enrollment') ??
      report.info.find((f) => f.id === 'enrollment');
    expect(enrollFinding).toBeDefined();
    expect(enrollFinding?.severity).toBe('info');
    expect(report.blockers.some((f) => f.id === 'enrollment')).toBe(false);
    expect(report.ready).toBe(true);
    expect(existsSync(fx!.ashlrDir)).toBe(false);
  });

  it('preserves the healthy enrollment shape and blocks a degraded registry exactly', async () => {
    expect.hasAssertions();
    expect(readEnrollmentState()).toEqual({ count: 0 });

    mkdirSync(fx!.ashlrDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx!.ashlrDir, 'enrollment.json'), '{"repos":"invalid"}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });

    expect(readEnrollmentState()).toEqual({
      count: 0,
      degraded: true,
      reason: 'malformed-registry',
    });

    const report = await buildReadiness(makeCfg());
    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual({
      id: 'enrollment',
      severity: 'blocker',
      detail: 'enrollment registry degraded: malformed-registry',
      fix: 'Repair ~/.ashlr/enrollment.json before running autonomy.',
    });
    expect(report.info.some((finding) => finding.id === 'enrollment')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects an unsafe authority directory without writing through it', async () => {
    const redirected = join(fx!.home, 'redirected-authority');
    mkdirSync(redirected, { recursive: true, mode: 0o700 });
    symlinkSync(redirected, fx!.ashlrDir, 'dir');

    const report = await buildReadiness(makeCfg());

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'enrollment', detail: expect.stringContaining('unsafe-ashlr-directory') }),
      expect.objectContaining({ id: 'ashlr-writeable' }),
    ]));
    expect(readdirSync(redirected)).toEqual([]);
  });

  it('checks a fresh home without creating ~/.ashlr or changing its entries', () => {
    const before = readdirSync(fx!.home);

    expect(checkAshlrWriteable()).toBe(true);

    expect(existsSync(fx!.ashlrDir)).toBe(false);
    expect(readdirSync(fx!.home)).toEqual(before);
  });

  it('fails closed and preserves concurrent state when ~/.ashlr appears during a fresh-home probe', () => {
    const concurrent = join(fx!.ashlrDir, 'concurrent-state.json');
    privateStorageMocks.assure.mockImplementation((path, kind, mode) => {
      if (path === fx!.home && kind === 'directory' && mode === 'inspect-owned') {
        mkdirSync(fx!.ashlrDir, { mode: 0o700 });
        writeFileSync(concurrent, '{"preserve":true}\n', 'utf8');
      }
      return { ok: true, reason: 'owned-safe-path' };
    });

    expect(existsSync(fx!.ashlrDir)).toBe(false);
    expect(withPlatform('win32', () => checkAshlrWriteable())).toBe(false);
    expect(privateStorageMocks.assure).toHaveBeenCalledWith(
      fx!.home,
      'directory',
      'inspect-owned',
      { anchorPath: join(fx!.home, '..') },
    );
    expect(readFileSync(concurrent, 'utf8')).toBe('{"preserve":true}\n');
    expect(readdirSync(fx!.ashlrDir)).toEqual(['concurrent-state.json']);
  });

  it('fails closed when Windows authority assurance is unavailable', () => {
    mkdirSync(fx!.ashlrDir, { recursive: true, mode: 0o700 });
    const before = readdirSync(fx!.ashlrDir);
    for (const reason of [
      'untrusted-item-write',
      'wrong-owner',
      'reparse-point',
      'powershell-unavailable',
    ]) {
      privateStorageMocks.assure.mockReset();
      privateStorageMocks.assure.mockReturnValue({ ok: false, reason });
      expect(withPlatform('win32', () => checkAshlrWriteable())).toBe(false);
      expect(privateStorageMocks.assure).toHaveBeenCalledWith(
        fx!.ashlrDir,
        'directory',
        'inspect-owned',
        { anchorPath: fx!.home },
      );
      expect(readdirSync(fx!.ashlrDir)).toEqual(before);
    }
  });

  it('fails closed and preserves both directories when existing authority is replaced mid-probe', () => {
    mkdirSync(fx!.ashlrDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx!.ashlrDir, 'original-state.json'), '{"original":true}\n', 'utf8');
    privateStorageMocks.assure.mockReset();
    const displaced = join(fx!.home, '.ashlr-displaced');
    privateStorageMocks.assure.mockImplementation(() => {
      renameSync(fx!.ashlrDir, displaced);
      mkdirSync(fx!.ashlrDir, { mode: 0o700 });
      writeFileSync(join(fx!.ashlrDir, 'replacement-state.json'), '{"replacement":true}\n', 'utf8');
      return { ok: true, reason: 'mock-assured' };
    });

    expect(withPlatform('win32', () => checkAshlrWriteable())).toBe(false);
    expect(readFileSync(join(displaced, 'original-state.json'), 'utf8')).toBe('{"original":true}\n');
    expect(readFileSync(join(fx!.ashlrDir, 'replacement-state.json'), 'utf8')).toBe('{"replacement":true}\n');
  });

  it.runIf(process.platform === 'win32')('rejects a native permissive authority DACL without changing directory entries', () => {
    privateStorageMocks.assure.mockReset();
    mkdirSync(fx!.ashlrDir, { recursive: true });
    const assurance = assurePrivateStoragePath(
      fx!.ashlrDir,
      'directory',
      'secure-created',
      { anchorPath: fx!.home },
    );
    expect(assurance, assurance.reason).toMatchObject({ ok: true });
    const permissive = spawnSync('icacls.exe', [fx!.ashlrDir, '/grant', '*S-1-1-0:(OI)(CI)M'], {
      windowsHide: true,
      shell: false,
      timeout: 5_000,
      encoding: 'utf8',
    });
    expect(permissive.status, permissive.stderr).toBe(0);

    expect(checkAshlrWriteable()).toBe(false);
    expect(readdirSync(fx!.ashlrDir)).toEqual([]);
  }, 45_000);

  it('tolerates a DOWN local model — surfaces a warning, never crashes, never a blocker', async () => {
    expect.hasAssertions();
    // Default mock is DOWN; assert it was even consulted (no live network).
    const cfg = makeCfg({
      models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    } as Partial<import('../src/core/types.js').AshlrConfig>);

    const report = await buildReadiness(cfg);

    expect(mockProbeEndpoint).toHaveBeenCalled();
    const modelWarn = report.warnings.find((f) => f.id === 'model');
    expect(modelWarn).toBeDefined();
    expect(modelWarn?.severity).toBe('warning');
    // A down model is NEVER a blocker.
    expect(report.blockers.some((f) => f.id === 'model')).toBe(false);
    // ready stays true purely on the strength of the down model (assuming git
    // present + ~/.ashlr writeable in CI, which the fixture guarantees writeable).
    expect(report.ready).toBe(true);
  });

  // Skipped on Windows: this test makes ~/.ashlr non-writeable via chmod(0o500),
  // but Windows ignores POSIX directory permission bits, so the OS access check
  // still succeeds. The POSIX permission path is covered on macOS/Linux CI.
  it.skipIf(process.platform === 'win32')('reports a blocker (ready=false, exit 1) when ~/.ashlr is not writeable', async () => {
    expect.hasAssertions();
    // Force ~/.ashlr to exist but be NON-writeable so the OS access probe fails.
    // (loadConfig() below would otherwise create it; create it ourselves first.)
    const ashlrDir = fx!.ashlrDir;
    if (!existsSync(ashlrDir)) mkdirSync(ashlrDir, { recursive: true });
    const before = statSync(ashlrDir).mode;
    chmodSync(ashlrDir, 0o500); // r-x: no write
    let report: import('../src/core/readiness.js').ReadinessReport;
    try {
      const cfg = makeCfg({
        models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
      } as Partial<import('../src/core/types.js').AshlrConfig>);
      report = await buildReadiness(cfg);
    } finally {
      // Restore writeability so the fixture cleanup (rm -rf) can proceed.
      chmodSync(ashlrDir, before);
    }

    const writeBlocker = report.blockers.find((f) => f.id === 'ashlr-writeable');
    expect(writeBlocker).toBeDefined();
    expect(writeBlocker?.severity).toBe('blocker');
    expect(report.ready).toBe(false);
  });

  it('--json emits a ReadinessReport { ready, blockers, warnings, info, generatedAt } and exit reflects readiness', async () => {
    expect.hasAssertions();
    // Model UP so the only variables are git + writeability (both fine in the
    // isolated fixture) -> ready=true -> exit 0.
    mockProbeEndpoint.mockImplementation(async (id: string, url: string) => ({
      id,
      url,
      up: true,
      models: ['m'],
    }));

    const { result: code, out } = await captureStdout(() => cmdPreflight(['--json']));

    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ready');
    expect(parsed).toHaveProperty('blockers');
    expect(parsed).toHaveProperty('warnings');
    expect(parsed).toHaveProperty('info');
    expect(parsed).toHaveProperty('generatedAt');
    expect(Array.isArray(parsed['blockers'])).toBe(true);
    expect(Array.isArray(parsed['warnings'])).toBe(true);
    expect(Array.isArray(parsed['info'])).toBe(true);
    // ready=true (writeable + git present) -> exit code 0.
    expect(parsed['ready']).toBe(true);
    expect(code).toBe(0);
  });

  it('makes NO outward call beyond the mocked local probeEndpoint (real fetch never invoked)', async () => {
    expect.hasAssertions();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in test'));
    mockProbeEndpoint.mockImplementation(async (id: string, url: string) => ({
      id,
      url,
      up: true,
      models: ['m'],
    }));
    const cfg = loadConfig();

    const report = await buildReadiness(cfg);

    // probeEndpoint is the ONLY model-reachability path and it is mocked — the
    // real fetch must never have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report).toHaveProperty('ready');
  });

  it(
    'PREFLIGHT-READ-ONLY: enrollment.json / KILL / daemon.json / sandboxes/ are ' +
      'byte-identical and authority directory entries are unchanged after a preflight run',
    async () => {
      expect.hasAssertions();
      // Seed some real state: enroll a disposable repo + flip the kill switch on
      // so the snapshot has non-trivial content to compare.
      const repo = fx!.makeRepo();
      repo.enroll();
      fx!.setKill(true);
      loadConfig();

      const ashlrDir = fx!.ashlrDir;
      const before = snapshotState(ashlrDir);
      const entriesBefore = readdirSync(ashlrDir).sort();

      mockProbeEndpoint.mockImplementation(async (id: string, url: string) => ({
        id,
        url,
        up: false,
        models: [],
        error: 'down',
      }));

      // Run the full CLI surface (which loads config + builds readiness).
      await captureStdout(() => cmdPreflight([]));
      await captureStdout(() => cmdPreflight(['--json']));

      const after = snapshotState(ashlrDir);

      // Every tracked state surface is byte-identical before/after.
      expect(after['enrollment.json']).toBe(before['enrollment.json']);
      expect(after['KILL']).toBe(before['KILL']);
      expect(after['daemon.json']).toBe(before['daemon.json']);
      expect(after['sandboxes/']).toBe(before['sandboxes/']);
      expect(readdirSync(ashlrDir).sort()).toEqual(entriesBefore);
      // The enrolled repo is still enrolled (preflight never unenrolled it).
      expect(repo.isEnrolled()).toBe(true);
    },
  );
});
