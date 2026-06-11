/**
 * h7.preflight.test.ts — Ashlr v2.1 MILESTONE H7, BUILD ITEM 1.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H7.md):
 *  - PREFLIGHT-READ-ONLY: `ashlr preflight` / buildReadiness report readiness
 *    (model reachable, enrollment count, kill-switch, daemon not stuck, ~/.ashlr
 *    writeable, sandbox health, git, phantom) and MUTATE NOTHING — enrollment.json
 *    / KILL / daemon.json / sandboxes/ are byte-identical before/after, and no
 *    persistent sentinel is left behind. Model DOWN is a warning, never a crash
 *    or a blocker. Empty enrollment is fine (info, not a blocker).
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
import { buildReadiness } from '../src/core/readiness.js';
import { cmdPreflight } from '../src/cli/preflight.js';
import { loadConfig } from '../src/core/config.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

import { existsSync, readFileSync, readdirSync, chmodSync, statSync } from 'node:fs';
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

/** List any leftover preflight sentinel files in ~/.ashlr (should be none). */
function leftoverSentinels(ashlrDir: string): string[] {
  if (!existsSync(ashlrDir)) return [];
  return readdirSync(ashlrDir).filter((n) => n.includes('preflight') && n.endsWith('.tmp'));
}

beforeEach(() => {
  fx = makeFixture();
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
  });

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

  it('reports a blocker (ready=false, exit 1) when ~/.ashlr is not writeable', async () => {
    expect.hasAssertions();
    // Force ~/.ashlr to exist but be NON-writeable so the sentinel write fails.
    // (loadConfig() below would otherwise create it; create it ourselves first.)
    const ashlrDir = fx!.ashlrDir;
    const { mkdirSync } = await import('node:fs');
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
      'byte-identical before vs after a preflight run, and no sentinel file is left behind',
    async () => {
      expect.hasAssertions();
      // Seed some real state: enroll a disposable repo + flip the kill switch on
      // so the snapshot has non-trivial content to compare.
      const repo = fx!.makeRepo();
      repo.enroll();
      fx!.setKill(true);

      const ashlrDir = fx!.ashlrDir;
      const before = snapshotState(ashlrDir);

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
      // The enrolled repo is still enrolled (preflight never unenrolled it).
      expect(repo.isEnrolled()).toBe(true);
      // No transient writeable-probe sentinel was left behind.
      expect(leftoverSentinels(ashlrDir)).toEqual([]);
    },
  );
});
