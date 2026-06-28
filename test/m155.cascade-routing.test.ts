/**
 * test/m155.cascade-routing.test.ts — M155: Cheap-first cascade routing.
 *
 * Proves the following invariants:
 *
 *  1. FLAG-OFF PARITY: when cfg.foundry.cascade is absent/false, routeTaskCascade
 *     is byte-identical to routeTask (same engine, model, reason; attempt=1,
 *     cheapFirst=false).
 *
 *  2. CHEAP-FIRST: when cascade ON, low/mid difficulty tasks route to local/mid
 *     on attempt-1; hard tasks (effort >= 4 or score >= 8) bypass cheap-first.
 *
 *  3. shouldEscalate TRUE on objective failure signals (tests-failed, empty-diff,
 *     apply-failed, judge noise/harmful); FALSE on clean pass.
 *
 *  4. ESCALATION CAP: shouldEscalate never proposes a 4th hop; capped at frontier.
 *     A decision already at frontier never escalates.
 *
 *  5. ESCALATION-RATE METRIC: escalationRate() correctly computes rate from a
 *     ledger; returns 0 for empty ledger.
 *
 *  6. DIFFICULTY SIGNAL (M154): localizedScope on the item nudges away from
 *     cheap-first when fileCount > 5 or symbolCount > 20.
 *
 *  7. SOURCE GREP-GUARD: router.ts carries no auto-apply / gate-bypass primitives
 *     in the M155 section.
 *
 * Mirrors m128/m53 conventions: baseConfig()+withFoundry(), makeItem() with _seq,
 * vi.mock() for engines/quota/subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
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

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import {
  routeTask,
  routeTaskCascade,
  shouldEscalate,
  escalationRate,
  type CascadeDecision,
  type CascadeRunEntry,
  type TaskResult,
  type RoutingContext,
} from '../src/core/run/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

let _seq = 0;
beforeEach(() => { _seq = 0; });

function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `m155-item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 2,   // low by default (below FRONTIER_EFFORT_THRESHOLD=4)
    score: 3,    // low by default (below FRONTIER_SCORE_THRESHOLD=8)
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

/** Config with cascade ON, all backends allowed. */
function cascadeOnCfg(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return withFoundry({
    cascade: true,
    allowedBackends: ['builtin', 'local-coder', 'nim', 'claude', 'codex'] as any,
    routingPolicy: 'balanced',
    ...extra,
  } as any);
}

/** Config with cascade OFF (absent). */
function cascadeOffCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['builtin', 'local-coder', 'nim', 'claude', 'codex'] as any,
    routingPolicy: 'balanced',
  } as any);
}

/** RoutingContext with all engines available. */
const ALL_CTX: RoutingContext = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any[],
};

/** RoutingContext with only local engines. */
const LOCAL_CTX: RoutingContext = {
  availableEngines: ['builtin', 'local-coder'] as any[],
};

/** Build a minimal CascadeDecision for shouldEscalate tests. */
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

/** Build a passing TaskResult. */
function passResult(): TaskResult {
  return {
    hasDiff: true,
    testsPassed: true,
    judgeVerdict: 'ok',
    applySucceeded: true,
  };
}

/** Build a ledger of N first-attempts, M of which were escalated. */
function makeLedger(firstAttempts: number, escalatedCount: number): CascadeRunEntry[] {
  const entries: CascadeRunEntry[] = [];
  for (let i = 0; i < firstAttempts; i++) {
    entries.push({
      taskId: `task-${i}`,
      attempt: 1,
      escalated: i < escalatedCount,
      ts: new Date().toISOString(),
    });
  }
  // Add some attempt-2 entries (should not count in denominator)
  for (let i = 0; i < 5; i++) {
    entries.push({
      taskId: `task-esc-${i}`,
      attempt: 2,
      escalated: false,
      ts: new Date().toISOString(),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 1. FLAG-OFF PARITY
// ---------------------------------------------------------------------------

describe('M155 invariant 1 — flag-off: routeTaskCascade byte-identical to routeTask', () => {
  it('cascade absent: same engine, model, reason; attempt=1, cheapFirst=false', () => {
    const cfg = cascadeOffCfg();
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });

    const base = routeTask(item, cfg, ALL_CTX);
    const cascade = routeTaskCascade(item, cfg, ALL_CTX);

    expect(cascade.engine).toBe(base.engine);
    expect(cascade.model).toBe(base.model);
    expect(cascade.reason).toBe(base.reason);
    expect(cascade.attempt).toBe(1);
    expect(cascade.cheapFirst).toBe(false);
  });

  it('cascade false explicitly: same behavior', () => {
    const cfg = withFoundry({
      cascade: false,
      allowedBackends: ['builtin', 'claude'] as any,
      routingPolicy: 'balanced',
    } as any);
    const item = makeItem({ source: 'lint', effort: 1, score: 2 });

    const base = routeTask(item, cfg, ALL_CTX);
    const cascade = routeTaskCascade(item, cfg, ALL_CTX);

    expect(cascade.engine).toBe(base.engine);
    expect(cascade.attempt).toBe(1);
    expect(cascade.cheapFirst).toBe(false);
  });

  it('cascade off: hard item still routes identically', () => {
    const cfg = cascadeOffCfg();
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });

    const base = routeTask(item, cfg, ALL_CTX);
    const cascade = routeTaskCascade(item, cfg, ALL_CTX);

    expect(cascade.engine).toBe(base.engine);
    expect(cascade.attempt).toBe(1);
    expect(cascade.cheapFirst).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. CHEAP-FIRST — low/mid difficulty prefer local on attempt-1
// ---------------------------------------------------------------------------

describe('M155 invariant 2 — cheap-first: low/mid difficulty routes local when cascade ON', () => {
  it('low-effort item (effort=1, score=2) lands at local/mid tier (not frontier)', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'todo', effort: 1, score: 2 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(true);
    expect(decision.tierLabel).not.toBe('frontier');
    expect(decision.attempt).toBe(1);
  });

  it('mid-effort item (effort=3, score=5) routes cheap-first (at or below threshold)', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'lint', effort: 3, score: 5 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    // effort=3 <= CASCADE_CHEAP_EFFORT_THRESHOLD=3, so cheap-first applies
    expect(decision.cheapFirst).toBe(true);
    expect(decision.attempt).toBe(1);
  });

  it('hard item (effort=5) bypasses cheap-first', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(false);
    expect(decision.attempt).toBe(1);
  });

  it('escalation source bypasses cheap-first regardless of effort', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'escalation' as WorkSource, effort: 1, score: 1 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(false);
  });

  it('cascade ON with only local/mid engines available: routes below frontier', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });
    const decision = routeTaskCascade(item, cfg, LOCAL_CTX);

    // LOCAL_CTX has builtin (local) + local-coder (mid); cheap-first stays below frontier
    expect(decision.tierLabel).not.toBe('frontier');
    expect(decision.cheapFirst).toBe(true);
  });

  it('forceTier=frontier on attempt-2: cheapFirst=false, attempt=2 (escalation re-dispatch)', () => {
    // forceTier biases toward frontier engines in the context, but routeTask's
    // internal policy still applies. The invariant is cheapFirst=false + attempt=2.
    // For a guaranteed frontier engine, use a hard item (effort>=4) so routeTask
    // also selects frontier independently.
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const decision = routeTaskCascade(item, cfg, ALL_CTX, 'frontier', 2);

    expect(decision.tierLabel).toBe('frontier');
    expect(decision.attempt).toBe(2);
    expect(decision.cheapFirst).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. shouldEscalate — TRUE on objective failure, FALSE on clean pass
// ---------------------------------------------------------------------------

describe('M155 invariant 3 — shouldEscalate: true on failure signals, false on pass', () => {
  it('clean pass → escalate=false', () => {
    const decision = makeCascadeDecision('local');
    const result = passResult();
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
  });

  it('tests-failed → escalate=true', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: false, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.toTier).not.toBeNull();
    expect(sig.reason).toMatch(/tests-failed/);
  });

  it('empty-diff → escalate=true', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/empty-diff/);
  });

  it('apply-failed → escalate=true', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: true, applySucceeded: false };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/apply-failed/);
  });

  it('judge=noise → escalate=true', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'noise' };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/judge-noise/);
  });

  it('judge=harmful → escalate=true', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'harmful' };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/judge-harmful/);
  });

  it('judge=uncertain → escalate=false (not an objective failure)', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: true, applySucceeded: true, judgeVerdict: 'uncertain' };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
  });

  it('judge=ok → escalate=false', () => {
    const decision = makeCascadeDecision('mid');
    const result: TaskResult = { hasDiff: true, testsPassed: null, applySucceeded: null, judgeVerdict: 'ok' };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
  });

  it('testsPassed=null (unknown) does not trigger escalation alone', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: true, testsPassed: null, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
  });

  it('multiple failure signals: reason string lists all signals', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: false, testsPassed: false, applySucceeded: false };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.reason).toMatch(/tests-failed/);
    expect(sig.reason).toMatch(/empty-diff/);
    expect(sig.reason).toMatch(/apply-failed/);
  });

  it('local → escalates to mid', () => {
    const decision = makeCascadeDecision('local');
    const result: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('mid');
  });

  it('mid → escalates to frontier', () => {
    const decision = makeCascadeDecision('mid');
    const result: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('frontier');
  });
});

// ---------------------------------------------------------------------------
// 4. ESCALATION CAP — no 4th hop; frontier never escalates
// ---------------------------------------------------------------------------

describe('M155 invariant 4 — escalation cap: frontier never escalates; max 2 hops', () => {
  it('frontier decision: escalate=false even on all failure signals', () => {
    const decision = makeCascadeDecision('frontier');
    const result: TaskResult = { hasDiff: false, testsPassed: false, applySucceeded: false, judgeVerdict: 'noise' };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
    expect(sig.toTier).toBeNull();
  });

  it('attempt >= 3 at any tier: escalate=false (hop cap reached)', () => {
    const decision = makeCascadeDecision('mid', 3);
    const result: TaskResult = { hasDiff: false, testsPassed: false, applySucceeded: false };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
    expect(sig.reason).toMatch(/cap reached/);
  });

  it('attempt=2 at local still escalates (within 2-hop cap)', () => {
    const decision = makeCascadeDecision('local', 2);
    const result: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    // attempt=2 < maxAttempts=3, so escalation is allowed
    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('mid');
  });

  it('attempt=2 at mid still escalates to frontier', () => {
    const decision = makeCascadeDecision('mid', 2);
    const result: TaskResult = { hasDiff: false, testsPassed: true, applySucceeded: true };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(true);
    expect(sig.toTier).toBe('frontier');
  });

  it('attempt=3 at local: cap reached — escalate=false', () => {
    const decision = makeCascadeDecision('local', 3);
    const result: TaskResult = { hasDiff: false, testsPassed: false, applySucceeded: false };
    const sig = shouldEscalate(result, decision);

    expect(sig.escalate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. ESCALATION-RATE METRIC
// ---------------------------------------------------------------------------

describe('M155 invariant 5 — escalationRate: metric computes correctly', () => {
  it('empty ledger → rate=0, counts=0', () => {
    const result = escalationRate([]);
    expect(result.rate).toBe(0);
    expect(result.firstAttempts).toBe(0);
    expect(result.escalatedCount).toBe(0);
  });

  it('10 first-attempts, 1 escalated → rate=0.1 (10%)', () => {
    const ledger = makeLedger(10, 1);
    const result = escalationRate(ledger);

    expect(result.firstAttempts).toBe(10);
    expect(result.escalatedCount).toBe(1);
    expect(result.rate).toBeCloseTo(0.1);
  });

  it('10 first-attempts, 0 escalated → rate=0', () => {
    const ledger = makeLedger(10, 0);
    const result = escalationRate(ledger);

    expect(result.rate).toBe(0);
  });

  it('10 first-attempts, 10 escalated → rate=1.0', () => {
    const ledger = makeLedger(10, 10);
    const result = escalationRate(ledger);

    expect(result.rate).toBe(1.0);
  });

  it('attempt-2 entries do not count toward denominator', () => {
    // makeLedger adds 5 attempt-2 entries; they must not inflate firstAttempts
    const ledger = makeLedger(20, 2);
    const result = escalationRate(ledger);

    expect(result.firstAttempts).toBe(20);
    expect(result.escalatedCount).toBe(2);
    expect(result.rate).toBeCloseTo(0.1);
  });

  it('rate in expected 7-10% band for a realistic ledger', () => {
    const ledger = makeLedger(100, 8);
    const result = escalationRate(ledger);

    expect(result.rate).toBeGreaterThanOrEqual(0.05);
    expect(result.rate).toBeLessThanOrEqual(0.15);
  });
});

// ---------------------------------------------------------------------------
// 6. DIFFICULTY SIGNAL (M154 localizedScope)
// ---------------------------------------------------------------------------

describe('M155 invariant 6 — M154 difficulty signal nudges cheap-first decision', () => {
  it('large fileCount (> 5) suppresses cheap-first even on low effort', () => {
    const cfg = cascadeOnCfg();
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 1, score: 2 }),
      localizedScope: { fileCount: 8, symbolCount: 3 },
    };
    const decision = routeTaskCascade(item as any, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(false);
  });

  it('large symbolCount (> 20) suppresses cheap-first even on low effort', () => {
    const cfg = cascadeOnCfg();
    const item = {
      ...makeItem({ source: 'lint' as WorkSource, effort: 1, score: 2 }),
      localizedScope: { fileCount: 2, symbolCount: 25 },
    };
    const decision = routeTaskCascade(item as any, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(false);
  });

  it('small scope (fileCount=2, symbolCount=5) does not suppress cheap-first', () => {
    const cfg = cascadeOnCfg();
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 1, score: 2 }),
      localizedScope: { fileCount: 2, symbolCount: 5 },
    };
    const decision = routeTaskCascade(item as any, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(true);
  });

  it('absent localizedScope: cheap-first proceeds normally', () => {
    const cfg = cascadeOnCfg();
    const item = makeItem({ source: 'todo', effort: 1, score: 2 });
    // No localizedScope property
    const decision = routeTaskCascade(item, cfg, ALL_CTX);

    expect(decision.cheapFirst).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. SOURCE GREP-GUARD
// ---------------------------------------------------------------------------

describe('M155 invariant 7 — source grep-guard: no auto-apply in router.ts M155 section', () => {
  it('router.ts carries no apply/merge/createPr/push/deploy primitive', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/router.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/\bgit push\b/);
    expect(src).not.toMatch(/gh pr create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/mergeProposal/);
    expect(src).not.toMatch(/autoMerge\s*\(/);
    expect(src).not.toMatch(/\bdeploy\s*\(/);
  });

  it('learned-router.ts re-exports M155 symbols from router.ts', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/learned-router.ts'),
      'utf8',
    );
    expect(src).toMatch(/shouldEscalate/);
    expect(src).toMatch(/escalationRate/);
    expect(src).toMatch(/routeTaskCascade/);
    expect(src).toMatch(/CascadeDecision/);
    expect(src).toMatch(/TaskResult/);
    expect(src).toMatch(/EscalationSignal/);
  });
});
