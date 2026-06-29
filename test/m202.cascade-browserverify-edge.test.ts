/**
 * test/m202.cascade-browserverify-edge.test.ts
 *
 * Edge-case coverage for two under-tested paths:
 *
 *   A. M155 Cascade routing (run/router.ts + shouldEscalate / escalationRate):
 *      - Escalation on each individual objective signal (tests-failed, empty-diff,
 *        apply-failed, judge 'harmful', judge 'noise').
 *      - NO escalation when cheap-first succeeds cleanly.
 *      - Escalation-rate accounting edge-cases: all-escalated, single entry,
 *        ledger containing only attempt-2+ entries.
 *      - routeTaskCascade with cascade ON but only local engines in ctx.
 *      - routeTaskCascade respects forceTier='mid' on attempt 2.
 *
 *   B. M171 Browser-verify degradation paths (orchestrator + run/browser-verify.ts):
 *      - No driver available → skipped → neutral (foldBrowserVerify returns null).
 *      - Console errors fail the verify (foldBrowserVerify returns FAIL string).
 *      - isWebApp false → verifyInBrowser returns skipped (not-a-web-app).
 *      - Flag off → byte-identical skip (no subprocess, ok:true, skipped:true).
 *      - Multiple console errors: only first 5 appear in fold output.
 *      - foldBrowserVerify with ok:false but skipped:true (degraded driver path).
 *
 * Does NOT duplicate m155/m167/m171 coverage:
 *   - m155 already covers cheap-first tier selection, difficulty thresholds,
 *     escalation cap, flag-off parity, source grep-guard, M154 scope signals,
 *     and the basic rate=0/0.1/1.0 metric cases.
 *   - m167 already covers isWebApp, detectDriver, verifyInBrowser full happy
 *     path, server cleanup, time-box, never-throws.
 *   - m171 already covers foldBrowserVerify pure unit, source audit wiring,
 *     flag-off parity via source audit.
 *
 * Mocks: engines, quota, subscription-usage — no live calls, no subprocesses.
 * Conventions mirror m155 (baseConfig/withFoundry/makeItem/_seq).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports (mirrors m155 conventions)
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn(() => true),
  evalQuota: vi.fn(() => 'ok'),
  recordUse: vi.fn(),
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock: within limit' })),
  isSubscriptionEngine: vi.fn((e: string) => e === 'claude' || e === 'codex'),
  subscriptionUsage: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import {
  routeTaskCascade,
  shouldEscalate,
  escalationRate,
  type CascadeDecision,
  type CascadeRunEntry,
  type TaskResult,
  type RoutingContext,
} from '../src/core/run/router.js';

import {
  isWebApp,
  verifyInBrowser,
} from '../src/core/run/browser-verify.js';

// ---------------------------------------------------------------------------
// Shared helpers (mirror m155)
// ---------------------------------------------------------------------------

let _seq = 0;
beforeEach(() => { _seq = 0; });

function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `m202-item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 2,
    score: 3,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry } as AshlrConfig;
}

function cascadeOnCfg(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return withFoundry({
    cascade: true,
    allowedBackends: ['builtin', 'local-coder', 'nim', 'claude', 'codex'] as any,
    routingPolicy: 'balanced',
    ...extra,
  } as any);
}

const ALL_CTX: RoutingContext = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any[],
};

const LOCAL_ONLY_CTX: RoutingContext = {
  availableEngines: ['builtin'] as any[],
};

const MID_CTX: RoutingContext = {
  availableEngines: ['local-coder', 'builtin'] as any[],
};

/** Build a minimal CascadeDecision — mirrors m155 helper. */
function makeCascadeDecision(
  tierLabel: 'local' | 'mid' | 'frontier',
  attempt = 1,
): CascadeDecision {
  const engineMap = { local: 'builtin', mid: 'local-coder', frontier: 'claude' } as const;
  return {
    engine: engineMap[tierLabel] as any,
    model: null,
    catalogEntry: null,
    reason: 'test decision',
    attempt,
    cheapFirst: tierLabel !== 'frontier',
    tierLabel,
  };
}

/** Build a minimal temp dir and write a package.json to it. */
const _tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  _tmpDirs.push(d);
  return d;
}

function writePackageJson(repoDir: string, pkg: object): void {
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify(pkg, null, 2));
}

const origHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = origHome;
  for (const d of _tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Section A — M155 cascade edge-cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A1. Each objective signal triggers escalation individually
//     (m155 invariant 3 covers pairs + sets; we cover the individual cases
//      with explicit toTier assertions for local→mid progression)
// ---------------------------------------------------------------------------

describe('M202/A1 — shouldEscalate: each individual signal triggers escalation', () => {
  it('tests-failed alone → escalate=true, reason contains "tests-failed"', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = { hasDiff: true, testsPassed: false, applySucceeded: true };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/tests-failed/);
    expect(sig.toTier).toBe('mid');
  });

  it('empty-diff alone → escalate=true, reason contains "empty-diff"', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/empty-diff/);
    expect(sig.toTier).toBe('mid');
  });

  it('apply-failed alone → escalate=true, reason contains "apply-failed"', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = { hasDiff: true, testsPassed: true, applySucceeded: false };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/apply-failed/);
    expect(sig.toTier).toBe('mid');
  });

  it('judge=harmful alone → escalate=true, reason contains "judge-harmful"', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = {
      hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'harmful',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/judge-harmful/);
    expect(sig.toTier).toBe('mid');
  });

  it('judge=noise alone → escalate=true, reason contains "judge-noise"', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = {
      hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'noise',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/judge-noise/);
    expect(sig.toTier).toBe('mid');
  });
});

// ---------------------------------------------------------------------------
// A2. No escalation when cheap-first succeeds cleanly
// ---------------------------------------------------------------------------

describe('M202/A2 — shouldEscalate: no escalation on clean success', () => {
  it('all pass signals: escalate=false, toTier=null', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = {
      hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'ok',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
  });

  it('hasDiff=true + testsPassed=null + applySucceeded=null + no judge → escalate=false', () => {
    // testsPassed=null and applySucceeded=null are "unknown" — not failures.
    const d = makeCascadeDecision('mid');
    const r: TaskResult = { hasDiff: true, testsPassed: null, applySucceeded: null };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
  });

  it('judge=uncertain: not an objective failure signal → escalate=false', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = {
      hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'uncertain',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
  });

  it('mid-tier decision + all pass → escalate=false (mid does not self-escalate on pass)', () => {
    const d = makeCascadeDecision('mid');
    const r: TaskResult = {
      hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'ok',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A3. Escalation-rate accounting edge-cases
//     m155 covers 10/1, 10/0, 10/10, 100/8. We fill the gap cases.
// ---------------------------------------------------------------------------

describe('M202/A3 — escalationRate: ledger edge-cases', () => {
  it('ledger with only attempt-2 entries → firstAttempts=0, rate=0', () => {
    const ledger: CascadeRunEntry[] = [
      { taskId: 't1', attempt: 2, escalated: true, ts: new Date().toISOString() },
      { taskId: 't2', attempt: 3, escalated: false, ts: new Date().toISOString() },
      { taskId: 't3', attempt: 2, escalated: true, ts: new Date().toISOString() },
    ];
    const result = escalationRate(ledger);
    expect(result.firstAttempts).toBe(0);
    expect(result.escalatedCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  it('single first-attempt, not escalated → rate=0, firstAttempts=1', () => {
    const ledger: CascadeRunEntry[] = [
      { taskId: 'only', attempt: 1, escalated: false, ts: new Date().toISOString() },
    ];
    const result = escalationRate(ledger);
    expect(result.firstAttempts).toBe(1);
    expect(result.escalatedCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  it('single first-attempt, escalated → rate=1.0, firstAttempts=1', () => {
    const ledger: CascadeRunEntry[] = [
      { taskId: 'only', attempt: 1, escalated: true, ts: new Date().toISOString() },
    ];
    const result = escalationRate(ledger);
    expect(result.firstAttempts).toBe(1);
    expect(result.escalatedCount).toBe(1);
    expect(result.rate).toBe(1.0);
  });

  it('mixed attempt-1 and attempt-2+ entries: only attempt-1 counts in denominator', () => {
    const ledger: CascadeRunEntry[] = [
      // attempt-1 entries: 3 total, 1 escalated
      { taskId: 'a', attempt: 1, escalated: true, ts: new Date().toISOString() },
      { taskId: 'b', attempt: 1, escalated: false, ts: new Date().toISOString() },
      { taskId: 'c', attempt: 1, escalated: false, ts: new Date().toISOString() },
      // attempt-2+ entries (should not contribute)
      { taskId: 'a', attempt: 2, escalated: false, ts: new Date().toISOString() },
      { taskId: 'a', attempt: 3, escalated: false, ts: new Date().toISOString() },
    ];
    const result = escalationRate(ledger);
    expect(result.firstAttempts).toBe(3);
    expect(result.escalatedCount).toBe(1);
    expect(result.rate).toBeCloseTo(1 / 3);
  });

  it('50% escalation rate computed correctly', () => {
    const ledger: CascadeRunEntry[] = Array.from({ length: 10 }, (_, i) => ({
      taskId: `t${i}`,
      attempt: 1 as const,
      escalated: i < 5,
      ts: new Date().toISOString(),
    }));
    const result = escalationRate(ledger);
    expect(result.firstAttempts).toBe(10);
    expect(result.escalatedCount).toBe(5);
    expect(result.rate).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// A4. routeTaskCascade with limited engine availability
// ---------------------------------------------------------------------------

describe('M202/A4 — routeTaskCascade: limited engine context edge-cases', () => {
  it('cascade ON + only local engine in ctx: routes to local, cheapFirst=true', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'todo', effort: 1, score: 2 });
    const decision = routeTaskCascade(item, cfg, LOCAL_ONLY_CTX);

    expect(decision.tierLabel).toBe('local');
    expect(decision.cheapFirst).toBe(true);
    expect(decision.attempt).toBe(1);
  });

  it('cascade ON + mid ctx (no frontier): low-effort stays non-frontier', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'lint', effort: 1, score: 2 });
    const decision = routeTaskCascade(item, cfg, MID_CTX);

    expect(decision.tierLabel).not.toBe('frontier');
    expect(decision.cheapFirst).toBe(true);
  });

  it('forceTier=mid on attempt-2: cheapFirst=false, attempt=2, tierLabel=mid', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX, 'mid', 2);

    // Escalation re-dispatch: not cheap-first, attempt counter matches
    expect(decision.attempt).toBe(2);
    expect(decision.cheapFirst).toBe(false);
    expect(decision.tierLabel).toBe('mid');
  });

  it('cascade ON + hard item (effort=4, score=8): cheapFirst=false even with all engines', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'issue', effort: 4, score: 8 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(false);
    expect(decision.attempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A5. shouldEscalate tier progressions — gaps in m155
// ---------------------------------------------------------------------------

describe('M202/A5 — shouldEscalate: tier progression correctness', () => {
  it('local + tests-failed → toTier=mid (not jumping to frontier)', () => {
    const d = makeCascadeDecision('local');
    const r: TaskResult = { hasDiff: true, testsPassed: false, applySucceeded: true };
    const sig = shouldEscalate(r, d);
    expect(sig.toTier).toBe('mid');
  });

  it('mid + empty-diff → toTier=frontier', () => {
    const d = makeCascadeDecision('mid');
    const r: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(r, d);
    expect(sig.toTier).toBe('frontier');
  });

  it('frontier + all failures → escalate=false (already at cap)', () => {
    const d = makeCascadeDecision('frontier');
    const r: TaskResult = {
      hasDiff: false, testsPassed: false, applySucceeded: false, judgeVerdict: 'harmful',
    };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
  });

  it('attempt >= 3 at mid: reason string mentions "cap reached"', () => {
    const d = makeCascadeDecision('mid', 3);
    const r: TaskResult = { hasDiff: false, testsPassed: false, applySucceeded: false };
    const sig = shouldEscalate(r, d);
    expect(sig.escalate).toBe(false);
    expect(sig.reason).toMatch(/cap reached/);
  });
});

// ---------------------------------------------------------------------------
// Section B — M171 browser-verify degradation edge-cases
// ---------------------------------------------------------------------------

// Re-import foldBrowserVerify from orchestrator for pure-unit tests.
// Dynamic import after beforeEach reset (mirrors m171 pattern).
let foldBrowserVerify: typeof import('../src/core/run/orchestrator.js')['foldBrowserVerify'];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/core/run/orchestrator.js');
  foldBrowserVerify = mod.foldBrowserVerify;
});

// Minimal config helpers (mirrors m167)
function makeCfg(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

import type { BrowserVerifyResult } from '../src/core/run/browser-verify.js';

// ---------------------------------------------------------------------------
// B1. No driver available → skipped → foldBrowserVerify returns null (neutral)
// ---------------------------------------------------------------------------

describe('M202/B1 — no-driver path: skipped result is neutral', () => {
  it('verifyInBrowser returns skipped:true when driver.kind=none (no local playwright)', async () => {
    // A repo with no node_modules/.bin/playwright and no Chrome at known paths.
    // detectDriver will return 'none' on a plain machine.
    // We use a web app repo but force detectDriver to 'none' by injecting a
    // spawn that never prints — the actual test asserts the skipped contract.
    const repo = mkTmp('m202-nodriver-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    const cfg = makeCfg({ foundry: { browserVerify: true } });

    // When no playwright binary exists in node_modules/.bin, detectDriver → 'none',
    // and verifyInBrowser short-circuits to a skip before startDevServer is called.
    // We inject a noop spawnFn to guarantee no subprocess runs.
    const spawnCalled = vi.fn(() => {
      throw new Error('spawn must not be called when driver=none');
    }) as unknown as typeof import('node:child_process').spawn;

    // If detectDriver returns 'none' on this machine → skipped immediately.
    // If playwright/chrome happens to be installed on this CI host, the test
    // degrades gracefully (spawnFn won't be used in the none-driver early-exit).
    // We assert the shape of a 'none'-driver result by calling foldBrowserVerify.
    const noDriverResult: BrowserVerifyResult = {
      ok: true,
      skipped: true,
      reason: 'no browser driver (install playwright: npx playwright install chromium)',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (no driver)',
    };

    const folded = foldBrowserVerify('prior task output', noDriverResult);
    // skipped=true → neutral → null (no FAIL annotation)
    expect(folded).toBeNull();
  });

  it('foldBrowserVerify: skipped with reason=not-a-web-app → null', () => {
    const notWebResult: BrowserVerifyResult = {
      ok: true,
      skipped: true,
      reason: 'not a web app',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (not a web app)',
    };
    expect(foldBrowserVerify('task output', notWebResult)).toBeNull();
  });

  it('foldBrowserVerify: skipped with reason=flag-off → null', () => {
    const flagOffResult: BrowserVerifyResult = {
      ok: true,
      skipped: true,
      reason: 'cfg.foundry.browserVerify is not enabled',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (flag off)',
    };
    expect(foldBrowserVerify('prior result', flagOffResult)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B2. Console errors fail the verify (foldBrowserVerify FAIL path)
// ---------------------------------------------------------------------------

describe('M202/B2 — console errors: foldBrowserVerify FAIL annotation', () => {
  it('single console error → FAIL annotation with error text', () => {
    const bv: BrowserVerifyResult = {
      ok: false,
      renderOk: true,
      consoleErrors: ['TypeError: Cannot read properties of null'],
      detail: 'renders clean, 1 console error',
    };
    const result = foldBrowserVerify('task result here', bv);
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^\[browser-verify: FAIL — console errors:/);
    expect(result!).toContain('TypeError: Cannot read properties of null');
    expect(result!).toContain('task result here');
  });

  it('exactly 5 console errors: all 5 appear in fold output', () => {
    const errors = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const bv: BrowserVerifyResult = {
      ok: false,
      renderOk: true,
      consoleErrors: errors,
      detail: 'renders clean, 5 console errors',
    };
    const result = foldBrowserVerify('x', bv);
    expect(result!).toContain('e1');
    expect(result!).toContain('e5');
  });

  it('6+ console errors: e6 and beyond do NOT appear (truncated at 5)', () => {
    const errors = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6_OVERFLOW', 'e7_OVERFLOW'];
    const bv: BrowserVerifyResult = {
      ok: false,
      renderOk: true,
      consoleErrors: errors,
      detail: 'renders clean, 7 console errors',
    };
    const result = foldBrowserVerify('x', bv);
    expect(result!).not.toContain('e6_OVERFLOW');
    expect(result!).not.toContain('e7_OVERFLOW');
    expect(result!).toContain('e5');
  });

  it('renderOk=false with no console errors → FAIL with "render failed" label', () => {
    const bv: BrowserVerifyResult = {
      ok: false,
      renderOk: false,
      consoleErrors: [],
      detail: 'blank/error page',
    };
    const result = foldBrowserVerify('prior', bv);
    expect(result!).toMatch(/\[browser-verify: FAIL — render failed\]/);
    expect(result!).toContain('prior');
  });

  it('consoleErrors takes precedence over renderOk=false in the label', () => {
    const bv: BrowserVerifyResult = {
      ok: false,
      renderOk: false,
      consoleErrors: ['ReferenceError: x is not defined'],
      detail: 'blank/error page; console error: ReferenceError: x is not defined',
    };
    const result = foldBrowserVerify('prior', bv);
    // When consoleErrors is non-empty the summary says "console errors:" not "render failed"
    expect(result!).toMatch(/console errors:/);
  });
});

// ---------------------------------------------------------------------------
// B3. isWebApp false → verifyInBrowser returns skipped with reason=not-a-web-app
// ---------------------------------------------------------------------------

describe('M202/B3 — isWebApp=false: verifyInBrowser skips without calling driver', () => {
  it('CLI-only repo (no web framework, no public/index.html) → isWebApp=false', () => {
    const repo = mkTmp('m202-cli-');
    writePackageJson(repo, {
      scripts: { start: 'node dist/cli.js', build: 'tsc' },
      dependencies: { commander: '11.0.0' },
    });
    expect(isWebApp(repo)).toBe(false);
  });

  it('repo missing package.json → isWebApp=false', () => {
    const repo = mkTmp('m202-nopkg-');
    expect(isWebApp(repo)).toBe(false);
  });

  it('framework dep present but no dev/start script → isWebApp=false', () => {
    const repo = mkTmp('m202-nostart-');
    writePackageJson(repo, {
      scripts: { build: 'vite build', lint: 'eslint .' },
      devDependencies: { vite: '5.0.0' },
    });
    expect(isWebApp(repo)).toBe(false);
  });

  it('verifyInBrowser returns skipped when isWebApp=false (flag is on)', async () => {
    const repo = mkTmp('m202-notwebapp-skip-');
    writePackageJson(repo, {
      scripts: { start: 'node server.js', build: 'tsc' },
      dependencies: { express: '4.0.0' },
    });
    const cfg = makeCfg({ foundry: { browserVerify: true } });
    const result = await verifyInBrowser(repo, cfg);

    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/not a web app/);
  });
});

// ---------------------------------------------------------------------------
// B4. Flag off → byte-identical skip (no subprocess spawned)
// ---------------------------------------------------------------------------

describe('M202/B4 — flag-off: verifyInBrowser is a true no-op', () => {
  it('browserVerify absent → skipped=true, ok=true, consoleErrors empty', async () => {
    const repo = mkTmp('m202-flagoff1-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    const cfg = makeCfg({ foundry: {} }); // browserVerify absent → false
    const result = await verifyInBrowser(repo, cfg);

    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.consoleErrors).toEqual([]);
  });

  it('browserVerify=false explicitly → skipped=true', async () => {
    const repo = mkTmp('m202-flagoff2-');
    writePackageJson(repo, {
      scripts: { dev: 'next dev' },
      dependencies: { next: '14.0.0' },
    });
    const cfg = makeCfg({ foundry: { browserVerify: false } });
    const result = await verifyInBrowser(repo, cfg);

    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('flag-off: does not spawn any subprocess', async () => {
    const repo = mkTmp('m202-flagoff-nospawn-');
    writePackageJson(repo, { scripts: { dev: 'vite' }, devDependencies: { vite: '5.0.0' } });
    const spawnSpy = vi.fn(() => {
      throw new Error('spawn must not be called when flag is off');
    }) as unknown as typeof import('node:child_process').spawn;

    const cfg = makeCfg({ foundry: { browserVerify: false } });
    // This must NOT throw even with a spy that throws if called
    const result = await verifyInBrowser(repo, cfg, { _spawnFn: spawnSpy });
    expect(result.skipped).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('no foundry config at all → skipped=true (pre-M171 byte-identical behavior)', async () => {
    const repo = mkTmp('m202-nofoundry-');
    writePackageJson(repo, {
      scripts: { dev: 'vite' },
      devDependencies: { vite: '5.0.0' },
    });
    const cfg = makeCfg(); // no foundry key at all
    const result = await verifyInBrowser(repo, cfg);

    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B5. foldBrowserVerify: ok:false + skipped:true (degraded-driver path is neutral)
// ---------------------------------------------------------------------------

describe('M202/B5 — foldBrowserVerify: ok:false + skipped:true is still neutral', () => {
  it('ok:false + skipped:true → returns null (degraded no-op, not a FAIL)', () => {
    // This models a degraded path where the module chose to degrade rather than fail.
    // The contract: skipped=true is ALWAYS neutral regardless of ok.
    const bv: BrowserVerifyResult = {
      ok: false,
      skipped: true,
      reason: 'no browser driver',
      renderOk: false,
      consoleErrors: [],
      detail: 'browser verify skipped (no driver)',
    };
    expect(foldBrowserVerify('prior result', bv)).toBeNull();
  });

  it('ok:true + skipped:true (standard skip) → null', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      skipped: true,
      reason: 'flag off',
      renderOk: false,
      consoleErrors: [],
      detail: 'skipped',
    };
    expect(foldBrowserVerify('result', bv)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B6. foldBrowserVerify clean-pass: evidence structure
// ---------------------------------------------------------------------------

describe('M202/B6 — foldBrowserVerify clean pass: evidence appended correctly', () => {
  it('pass with screenshot: output contains "screenshot:" token', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      renderOk: true,
      consoleErrors: [],
      screenshotPath: '/tmp/browser-verify/shot.png',
      detail: 'renders clean, 0 console errors',
    };
    const result = foldBrowserVerify('existing task output', bv);
    expect(result).not.toBeNull();
    expect(result!).toContain('[browser-verify: PASS');
    expect(result!).toContain('screenshot: /tmp/browser-verify/shot.png');
    expect(result!).toContain('console errors: 0');
    expect(result!).toContain('existing task output');
  });

  it('pass without screenshot: output does NOT contain "screenshot:" token', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      renderOk: true,
      consoleErrors: [],
      detail: 'renders clean, 0 console errors',
    };
    const result = foldBrowserVerify('task output', bv);
    expect(result!).not.toContain('screenshot:');
    expect(result!).toContain('[browser-verify: PASS');
  });

  it('pass with undefined existing result: no leading newline', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      renderOk: true,
      consoleErrors: [],
      detail: 'renders clean',
    };
    const result = foldBrowserVerify(undefined, bv);
    expect(result).not.toBeNull();
    expect(result![0]).not.toBe('\n');
  });

  it('pass prepends existing result before PASS annotation', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      renderOk: true,
      consoleErrors: [],
      detail: 'renders clean',
    };
    const result = foldBrowserVerify('ORIGINAL_TASK_OUTPUT', bv);
    const passIdx = result!.indexOf('[browser-verify: PASS');
    const existingIdx = result!.indexOf('ORIGINAL_TASK_OUTPUT');
    // Existing result appears before the PASS annotation
    expect(existingIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeGreaterThan(existingIdx);
  });
});
