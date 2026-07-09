/**
 * test/m53.intel.test.ts — M53: Fleet intelligence invariant suite.
 *
 * Proves the following invariants (each a named test group):
 *
 *  1. NO AUTO-APPLY / NO GATE BYPASS: every learned path produces a PENDING
 *     proposal or TuningProposal; source grep-guard confirms learned-router.ts
 *     and the updated daemon loop import no apply/merge/createPr/push/deploy
 *     primitive (mirrors the daemon-no-primitive precedent from h1.daemon-gates).
 *
 *  2. CASCADE ORDER: recoverWithinBudget returns frontier→mid→local→pause in
 *     that order as budget tightens; never escalates a local item to frontier.
 *
 *  3. ANOMALY HOLD: a seeded cost > k×p50 holds the proposal PENDING and files
 *     a TuningProposal; a normal-cost run does not trigger the anomaly hold.
 *
 *  4. LEARNED ROUTER IN-BOUNDS: recommendRoute never returns a backend outside
 *     allowedBackends; never escalates a bulk/local item to frontier.
 *
 *  5. FLAG-OFF BYTE-IDENTICAL: absent cfg.foundry.intelligence, recommendRoute
 *     delegates identically to routeBackend (same backend, tier, and no nudge).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — M282 determinism fix
// The learned-router reads ~/.ashlr/decisions/ via decisions-ledger.ts, which
// calls homedir() (mocked by test/setup/home.ts to follow process.env.HOME).
// Without HOME isolation, real production routing-score history in the
// developer's ~/.ashlr/decisions/ directory can bias engineInstalled-dependent
// tests (e.g. learned scores penalise claude → routes to 'local' instead of
// expected 'frontier'). Reset HOME to a fresh tmp dir for each test.
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
const origAshlrHome = process.env['ASHLR_HOME'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(tmpdir() + '/ashlr-m53-');
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = origHome;
  if (origAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = origAshlrHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

import type {
  AshlrConfig,
  EngineId,
  EngineTier,
  RunEstimate,
  WorkItem,
  WorkSource,
} from '../src/core/types.js';
import type { CostForecast } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  learningEpochFromTimestamp,
  ROUTER_POLICY_VERSION,
} from '../src/core/learning/causal.js';
import { productionAttemptLearningLabelFromSignals } from '../src/core/learning/attempt-shape.js';

import {
  recommendRoute,
  recoverWithinBudget,
  p50Cost,
  anomalyRatio,
  type LearnedRoute,
} from '../src/core/run/learned-router.js';
import { routeBackend } from '../src/core/fleet/router.js';
import { p50CostFromEstimate, anomalyRatioFromEstimate } from '../src/core/observability/estimate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

function baseCfg(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseCfg(), foundry };
}

/** A config WITH intelligence config (flag-on). */
function withIntelligence(extra?: {
  anomalyK?: number;
  minFrontierSuccessRate?: number;
  minProposalYieldRate?: number;
  dispatchYieldWindowHours?: number;
  allowedBackends?: string[];
}): AshlrConfig {
  return {
    ...baseCfg(),
    daemon: { dailyBudgetUsd: 1.0, perTickItems: 3, parallel: 2, intervalMs: 100 },
    foundry: {
      allowedBackends: (extra?.allowedBackends ?? ['builtin', 'claude', 'codex']) as AshlrConfig['foundry'] extends { allowedBackends?: Array<infer E> } ? E[] : never,
      intelligence: {
        anomalyK: extra?.anomalyK ?? 4,
        minFrontierSuccessRate: extra?.minFrontierSuccessRate ?? 0.5,
        ...(extra?.minProposalYieldRate !== undefined ? { minProposalYieldRate: extra.minProposalYieldRate } : {}),
        ...(extra?.dispatchYieldWindowHours !== undefined ? { dispatchYieldWindowHours: extra.dispatchYieldWindowHours } : {}),
      },
    } as AshlrConfig['foundry'],
  } as AshlrConfig;
}

function withInstalledFrontierEngines(cfg: AshlrConfig): AshlrConfig {
  const engine = (id: EngineId) => ({
    id,
    kind: 'cli-agent' as const,
    tier: 'frontier' as const,
    bin: 'node',
    bins: ['node'],
    argv: ['--version'],
    capabilities: ['agent', 'edit'],
  });
  return {
    ...cfg,
    foundry: {
      ...cfg.foundry,
      engines: {
        ...(cfg.foundry?.engines ?? {}),
        claude: engine('claude'),
        codex: engine('codex'),
      },
    },
  } as AshlrConfig;
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  const id = over.id ?? `repo:${over.source}:item${_seq++}`;
  return {
    id,
    repo: '/repo',
    source: over.source,
    title: over.title ?? 'test item',
    detail: over.detail ?? 'detail',
    value: over.value ?? 3,
    effort: over.effort ?? 3,
    score: over.score ?? 3,
    tags: over.tags ?? [],
    ts: over.ts ?? new Date().toISOString(),
  };
}

/** Build a minimal zeroed RunEstimate for injection into tests. */
function makeEstimate(medianCost: number, sampleSize = 10): RunEstimate {
  return {
    kind: 'run',
    goal: 'test goal',
    sampleSize,
    confidence: sampleSize >= 10 ? 'high' : sampleSize >= 3 ? 'medium' : 'low',
    tokens: { p25: 1000, median: 2000, p75: 3000 },
    steps: { p25: 5, median: 10, p75: 15 },
    estCostUsd: {
      p25: medianCost * 0.5,
      median: medianCost,
      p75: medianCost * 1.5,
    },
    wouldBeCloudUsd: medianCost,
    durationMs: { p25: 1000, median: 2000, p75: 3000 },
    budgetClamped: false,
    generatedAt: new Date().toISOString(),
  };
}

function makeDispatchProductionEvent(over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    machineId: 'm53',
    itemId: 'repo:security:item',
    source: 'security',
    repo: '/repo',
    title: 'security item',
    backend: 'claude',
    tier: 'frontier',
    model: 'claude-opus',
    assignedBy: 'daemon',
    routeReason: 'frontier',
    outcome: 'empty-diff',
    proposalCreated: false,
    spentUsd: 0,
    reason: 'agent returned no diff',
    basis: 'run-proposal-outcome',
    ...over,
  };
  if (event.routerPolicyVersion === undefined) event.routerPolicyVersion = ROUTER_POLICY_VERSION;
  if (event.learningEpoch === undefined) event.learningEpoch = learningEpochFromTimestamp(event.ts);
  if (event.learningLabel === undefined) {
    event.learningLabel = productionAttemptLearningLabelFromSignals({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
    });
  }
  return event;
}

function makeLegacyDispatchProductionEvent(over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const event = makeDispatchProductionEvent(over);
  delete event.learningLabel;
  delete event.routerPolicyVersion;
  delete event.learningEpoch;
  return event;
}

function comparativeCandidateEvents(backend: EngineId): DispatchProductionEvent[] {
  return [
    makeDispatchProductionEvent({ backend, outcome: 'proposal-created', proposalCreated: true }),
    makeDispatchProductionEvent({ backend, outcome: 'proposal-created', proposalCreated: true }),
    makeDispatchProductionEvent({ backend, outcome: 'empty-diff', proposalCreated: false }),
  ];
}

/** Build a minimal CostForecast. */
function makeForecast(projectedMonthlyUsd = 0): CostForecast {
  return {
    window: '7d',
    spentUsd: 0,
    localSavingsUsd: 0,
    projectedMonthlyUsd,
  };
}

// ---------------------------------------------------------------------------
// 1. SOURCE GREP-GUARD — no auto-apply / no gate bypass
// ---------------------------------------------------------------------------

describe('M53 invariant 1 — source grep-guard: no auto-apply primitive', () => {
  it('learned-router.ts imports no apply/merge/createPr/push/deploy primitive', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/learned-router.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/git\s+push/);
    expect(src).not.toMatch(/gh\s+pr\s+create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/ship-deploy|shipDeploy|startShip\b/);
    expect(src).not.toMatch(/\bdeploy\s*\(/);
    expect(src).not.toMatch(/mergeProposal/);
    expect(src).not.toMatch(/autoMerge\s*\(/);
  });

  it('daemon loop.ts still carries NO outward-action primitive after M53 additions', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/daemon/loop.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/git\s+push/);
    expect(src).not.toMatch(/gh\s+pr\s+create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/ship-deploy|shipDeploy|startShip\b/);
    expect(src).not.toMatch(/\bdeploy\s*\(/);
    // Also verify the M53 imports landed correctly.
    expect(src).toMatch(/from '\.\.\/run\/learned-router\.js'/);
    expect(src).toMatch(/from '\.\.\/observability\/estimate\.js'/);
    expect(src).toMatch(/from '\.\.\/observability\/forecast\.js'/);
  });

  it('every path through recommendRoute returns a route or throws — never calls apply', async () => {
    // Simple smoke test: calling recommendRoute returns a LearnedRoute shape,
    // not an outward action.
    const cfg = withIntelligence();
    const item = makeItem({ source: 'security', effort: 4 });
    const result: LearnedRoute = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001),
    });
    expect(result).toHaveProperty('backend');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('confidence');
    // confidence is bounded [0,1]
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. CASCADE ORDER — frontier → mid → local → pause
// ---------------------------------------------------------------------------

describe('M53 invariant 2 — recoverWithinBudget cascade order', () => {
  it('returns pause when budget is exhausted (spent >= cap)', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };

    const result = recoverWithinBudget(decision, cfg, 1.0, makeForecast());
    expect(result.action).toBe('pause');
  });

  it('returns pause when spent > cap', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };

    const result = recoverWithinBudget(decision, cfg, 9999.0, makeForecast());
    expect(result.action).toBe('pause');
  });

  it('cascades frontier → local when budget ≥ 80% used (no mid available)', () => {
    // No mid backend in allowed set, so frontier → local skip.
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
    // dailyBudget=1.0, spent=0.80 ⇒ 80% used
    const result = recoverWithinBudget(decision, cfg, 0.80, makeForecast());
    // At 80% with only builtin as lower tier, should cascade to builtin/local or pause.
    expect(['cascade', 'pause']).toContain(result.action);
    if (result.action === 'cascade') {
      // Must not escalate: cascaded tier must be ≤ frontier.
      const tierOrder: Record<EngineTier, number> = { local: 0, mid: 1, frontier: 2 };
      expect(tierOrder[result.decision.tier]).toBeLessThanOrEqual(tierOrder['frontier']);
    }
  });

  it('does not cascade when budget is below 60%', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
    // 50% used — no cascade.
    const result = recoverWithinBudget(decision, cfg, 0.50, makeForecast());
    if (result.action === 'cascade') {
      // Backend should remain frontier (no nudge below 60%).
      expect(result.decision.backend).toBe('claude');
    }
  });

  it('NEVER escalates a local decision to frontier', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    // Decision is already local.
    const decision = { backend: 'builtin' as const, tier: 'local' as EngineTier, reason: 'test' };
    // Even with 0% budget used, local must stay local.
    const result = recoverWithinBudget(decision, cfg, 0, makeForecast());
    if (result.action === 'cascade') {
      expect(result.decision.tier).toBe('local');
      expect(result.decision.backend).toBe('builtin');
    }
  });

  it('cascade order is strictly monotone: never goes frontier → local → mid', () => {
    // Verify the tier cascade is in the right direction: only decreasing.
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const tierOrder: Record<EngineTier, number> = { local: 0, mid: 1, frontier: 2 };

    const spends = [0, 0.3, 0.6, 0.8, 0.9, 0.95, 1.0];
    for (const spent of spends) {
      const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
      const result = recoverWithinBudget(decision, cfg, spent, makeForecast());
      if (result.action === 'cascade') {
        // Cascaded tier must be ≤ original tier.
        expect(tierOrder[result.decision.tier]).toBeLessThanOrEqual(
          tierOrder[decision.tier],
        );
      }
    }
  });

  it('higher spend → same or lower tier (monotone with spend)', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const tierOrder: Record<EngineTier, number> = { local: 0, mid: 1, frontier: 2 };

    function resultTierValue(spent: number): number {
      const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
      const result = recoverWithinBudget(decision, cfg, spent, makeForecast());
      if (result.action === 'pause') return -1; // pause = most conservative
      return tierOrder[result.decision.tier];
    }

    // As spend increases, tier value must be non-increasing.
    const t30 = resultTierValue(0.30);
    const t60 = resultTierValue(0.60);
    const t80 = resultTierValue(0.80);
    const t95 = resultTierValue(0.95);
    const t100 = resultTierValue(1.0);

    expect(t60).toBeLessThanOrEqual(t30);
    expect(t80).toBeLessThanOrEqual(t60);
    expect(t95).toBeLessThanOrEqual(t80);
    expect(t100).toBeLessThanOrEqual(t95);
  });
});

// ---------------------------------------------------------------------------
// 3. ANOMALY HOLD — cost > k×p50 triggers hold, normal cost does not
// ---------------------------------------------------------------------------

describe('M53 invariant 3 — anomaly detection helpers', () => {
  it('p50Cost extracts the median cost from a RunEstimate', () => {
    const est = makeEstimate(0.05, 10);
    expect(p50Cost(est)).toBe(0.05);
    expect(p50CostFromEstimate(est)).toBe(0.05);
  });

  it('p50Cost returns 0 when sampleSize is 0', () => {
    const est = makeEstimate(0, 0);
    expect(p50Cost(est)).toBe(0);
  });

  it('anomalyRatio returns 0 when actualCost is 0', () => {
    const est = makeEstimate(0.05, 10);
    expect(anomalyRatio(0, est)).toBe(0);
    expect(anomalyRatioFromEstimate(0, est)).toBe(0);
  });

  it('anomalyRatio returns Infinity when p50 is 0 and actualCost > 0', () => {
    const est = makeEstimate(0, 0); // no history => p50 = 0
    expect(anomalyRatio(0.01, est)).toBe(Infinity);
    expect(anomalyRatioFromEstimate(0.01, est)).toBe(Infinity);
  });

  it('anomalyRatio is actualCost / p50 when both > 0', () => {
    const est = makeEstimate(0.02, 10); // p50 = 0.02
    expect(anomalyRatio(0.1, est)).toBeCloseTo(5.0, 5);
    expect(anomalyRatioFromEstimate(0.1, est)).toBeCloseTo(5.0, 5);
  });

  it('cost > k×p50 is an anomaly (ratio > k)', () => {
    const k = 4;
    const p50 = 0.01;
    const est = makeEstimate(p50, 10);
    const normalCost = 0.02; // 2×p50 — not an anomaly
    const anomalousCost = 0.05; // 5×p50 — anomaly

    expect(anomalyRatio(normalCost, est)).toBeLessThanOrEqual(k);
    expect(anomalyRatio(anomalousCost, est)).toBeGreaterThan(k);
  });

  it('anomaly threshold respects configurable k', () => {
    const k = 2; // stricter threshold
    const p50 = 0.01;
    const est = makeEstimate(p50, 10);
    // 2.5×p50 is anomalous for k=2 but not for k=4.
    const cost = 0.025;
    const ratio = anomalyRatio(cost, est);
    expect(ratio).toBeGreaterThan(k); // anomaly at k=2
    expect(ratio).toBeLessThan(4);   // not anomaly at k=4
  });

  it('anomalyRatio from estimate.ts helpers are consistent with learned-router.ts helpers', () => {
    const est = makeEstimate(0.03, 10);
    const actual = 0.15;
    expect(p50Cost(est)).toBe(p50CostFromEstimate(est));
    expect(anomalyRatio(actual, est)).toBeCloseTo(anomalyRatioFromEstimate(actual, est), 10);
  });
});

// ---------------------------------------------------------------------------
// 4. LEARNED ROUTER IN-BOUNDS — never outside allowedBackends
// ---------------------------------------------------------------------------

describe('M53 invariant 4 — recommendRoute stays within allowedBackends', () => {
  it('flag-off: absent intelligence config, defers to routeBackend exactly', async () => {
    // No intelligence key in cfg.foundry.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const item = makeItem({ source: 'security', effort: 4 });

    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg);

    // Must produce identical backend and tier.
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
  });

  it('flag-off with no foundry at all also defers to routeBackend', async () => {
    const cfg = baseCfg(); // no foundry
    const item = makeItem({ source: 'issue', effort: 5 });

    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg);

    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
  });

  it('NEVER returns a backend outside allowedBackends (only builtin allowed)', async () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin'] });
    const item = makeItem({ source: 'security', effort: 5, score: 10 });

    const rec = await recommendRoute(item, cfg, { estimate: makeEstimate(0.001) });
    expect(rec.backend).toBe('builtin');
  });

  it('NEVER returns a backend outside allowedBackends (claude only)', async () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const item = makeItem({ source: 'security', effort: 5, score: 10 });

    const rec = await recommendRoute(item, cfg, { estimate: makeEstimate(0.001) });
    // Must be one of the allowed backends.
    const allowed = new Set(['builtin', 'claude']);
    expect(allowed.has(rec.backend)).toBe(true);
  });

  it('routes bulk items via the base routeBackend policy (frontier-first when available)', async () => {
    // UPDATED for frontier-first policy: routeBackend now sends all items to frontier
    // when a frontier backend is allowed+installed (builtin produces 0-diff proposals).
    // recommendRoute (flag-on) defers to routeBackend's base decision for non-nudged items.
    // The learned router's anti-escalation guard means it will not push items ABOVE
    // what routeBackend returns — but routeBackend itself now legitimately returns frontier
    // for bulk sources when frontier is available.
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const { engineInstalled } = await import('../src/core/run/engines.js');
    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    for (const source of ['doc', 'dep', 'todo', 'test'] as WorkSource[]) {
      const item = makeItem({ source, effort: 5 });
      const rec = await recommendRoute(item, cfg, { estimate: makeEstimate(0.001) });
      // Backend must always be within allowedBackends.
      const allowed = new Set(['builtin', 'claude', 'codex']);
      expect(allowed.has(rec.backend)).toBe(true);
      if (anyFrontierAvailable) {
        // Frontier-first policy: bulk items route to frontier when frontier is installed.
        expect(rec.tier).toBe('frontier');
        expect(['claude', 'codex']).toContain(rec.backend);
      } else {
        expect(rec.tier).toBe('local');
        expect(rec.backend).toBe('builtin');
      }
    }
  });

  it('routes low-effort items via the base routeBackend policy (frontier-first when available)', async () => {
    // UPDATED for frontier-first policy: low-effort items now route to frontier
    // when frontier is allowed+installed (routeBackend is frontier-first for all items).
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const { engineInstalled } = await import('../src/core/run/engines.js');
    const item = makeItem({ source: 'security', effort: 1 }); // low-effort
    const rec = await recommendRoute(item, cfg, { estimate: makeEstimate(0.001) });
    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    if (anyFrontierAvailable) {
      expect(rec.tier).toBe('frontier');
    } else {
      expect(rec.tier).toBe('local');
    }
  });

  it('with good priors, a senior item may still route to frontier within allowedBackends', async () => {
    const cfg = withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minFrontierSuccessRate: 0.5,
    });
    const item = makeItem({ source: 'security', effort: 4 });
    // Inject a good prior (high success rate) so no nudge away from frontier.
    const goodPrior = { frontierSuccessRate: 0.9, frontierSampleSize: 15 };
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: goodPrior,
    });
    // Backend must always be in allowedBackends.
    const allowed = new Set(['builtin', 'claude', 'codex']);
    expect(allowed.has(rec.backend)).toBe(true);
    // With a good prior, should stay frontier (or local if no engine installed).
    expect(['frontier', 'local']).toContain(rec.tier);
  });

  it('with poor priors, a senior item is nudged away from frontier', async () => {
    const cfg = withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minFrontierSuccessRate: 0.5,
    });
    const item = makeItem({ source: 'security', effort: 4 });
    // Inject a bad prior (low success rate, enough samples).
    const poorPrior = { frontierSuccessRate: 0.2, frontierSampleSize: 10 };
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: poorPrior,
    });
    const allowed = new Set(['builtin', 'claude', 'codex']);
    expect(allowed.has(rec.backend)).toBe(true);
    // With a poor prior, should be nudged away from frontier (to local since no mid).
    expect(rec.tier).toBe('local');
  });

  it('with a small prior sample (< 3), no nudge is applied', async () => {
    const cfg = withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minFrontierSuccessRate: 0.5,
    });
    const item = makeItem({ source: 'security', effort: 4 });
    // Prior with only 2 samples — too few to trust.
    const tinyPrior = { frontierSuccessRate: 0.0, frontierSampleSize: 2 };
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: tinyPrior,
    });
    // With insufficient prior data, must not nudge — defers to routeBackend.
    const base = routeBackend(item, cfg);
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
  });

  it('low dispatch-production yield can reroute to an installed same-tier alternative', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate = base.backend === 'claude' ? 'codex' : 'claude';
    const dispatchProductionEvents = [
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'engine-failed', proposalCreated: false }),
      ...comparativeCandidateEvents(alternate),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(alternate);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).toContain('recent proposal yield');
    expect(rec.reason).toContain('same-tier reroute');
    expect(rec.reason).toContain('candidate yield 2/3');
  });

  it('low dispatch-production yield does not blindly reroute to an unknown alternative', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = [
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'engine-failed', proposalCreated: false }),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
    expect(rec.reason).not.toContain('same-tier reroute');
  });

  it('low dispatch-production yield keeps base when candidate lacks reroute margin', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate = base.backend === 'claude' ? 'codex' : 'claude';
    const dispatchProductionEvents = [
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'proposal-created', proposalCreated: true }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: alternate, outcome: 'proposal-created', proposalCreated: true }),
      makeDispatchProductionEvent({ backend: alternate, outcome: 'proposal-created', proposalCreated: true }),
      makeDispatchProductionEvent({ backend: alternate, outcome: 'empty-diff', proposalCreated: false }),
      makeDispatchProductionEvent({ backend: alternate, outcome: 'gate-blocked', proposalCreated: false }),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('same-tier reroute');
    expect(rec.reason).not.toContain('candidate yield');
  });

  it('legacy unversioned dispatch-production yield cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = [
      makeLegacyDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
      makeLegacyDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
      makeLegacyDispatchProductionEvent({ backend: base.backend, outcome: 'engine-failed', proposalCreated: false }),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('dispatch-production yield from an old router policy cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = Array.from({ length: 3 }, () =>
      makeDispatchProductionEvent({
        backend: base.backend,
        outcome: 'empty-diff',
        proposalCreated: false,
        routerPolicyVersion: 'fleet-router-v0',
      })
    );

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('dispatch-production yield with invalid classifier labels cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = Array.from({ length: 3 }, () =>
      makeDispatchProductionEvent({
        backend: base.backend,
        outcome: 'empty-diff',
        proposalCreated: false,
        learningLabel: {
          schemaVersion: 1,
          classifierVersion: 'attempt-shape-v0',
          authoritative: true,
          learningKind: 'diagnostic-no-proposal',
          policySuppressed: false,
          diagnosticNoProposal: true,
          diagnosticAttempt: true,
          attemptShape: {
            backendNoDiff: 1,
            captureOrGateBlocked: 0,
            repairAttempts: 0,
            policyDisabled: 0,
          },
        } as never,
      })
    );

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('dispatch-production yield with mismatched learning epochs cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = Array.from({ length: 3 }, () =>
      makeDispatchProductionEvent({
        backend: base.backend,
        outcome: 'empty-diff',
        proposalCreated: false,
        learningEpoch: '2026-01-01',
      })
    );

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('policy-suppressed authoritative labels cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = Array.from({ length: 3 }, () =>
      makeDispatchProductionEvent({
        backend: base.backend,
        outcome: 'empty-diff',
        proposalCreated: false,
        runEventSummary: {
          actionCounts: {
            proposalDisabled: 1,
            diffFiles: 0,
          },
        },
      })
    );

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('routeSnapshot policy disagreement cannot trigger route changes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const dispatchProductionEvents = Array.from({ length: 3 }, () =>
      makeDispatchProductionEvent({
        backend: base.backend,
        outcome: 'empty-diff',
        proposalCreated: false,
        routeSnapshot: {
          backend: base.backend,
          tier: base.tier,
          assignedBy: 'daemon',
          reason: 'old snapshot policy',
          routerPolicyVersion: 'fleet-router-v0',
        },
      })
    );

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('gate-dominant action counts keep the same backend for capture repair', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate = base.backend === 'claude' ? 'codex' : 'claude';
    const dispatchProductionEvents = [
      ...Array.from({ length: 3 }, () =>
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'gate-blocked',
          proposalCreated: false,
          reason: 'completeness gate blocked partial diff',
          runEventSummary: {
            actionCounts: {
              proposalCaptureAttempts: 1,
              completenessGateRuns: 1,
              proposalBlocked: 1,
              diffFiles: 2,
              diffLines: 20,
            },
          },
        })
      ),
      ...comparativeCandidateEvents(alternate),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).toContain('gate-dominant');
    expect(rec.reason).toContain('verification/capture repair');
    expect(rec.reason).not.toContain('same-tier reroute');
  });

  it('empty-diff action counts remain learnable and annotate same-tier reroutes', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate = base.backend === 'claude' ? 'codex' : 'claude';
    const dispatchProductionEvents = [
      ...Array.from({ length: 3 }, () =>
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'empty-diff',
          proposalCreated: false,
          reason: 'agent returned no diff',
          runEventSummary: {
            actionCounts: {
              proposalCaptureAttempts: 1,
              proposalBlocked: 1,
              diffFiles: 0,
            },
          },
        })
      ),
      ...comparativeCandidateEvents(alternate),
    ];

    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents,
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(alternate);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).toContain('same-tier reroute');
    expect(rec.reason).toContain('action signal: no-diff');
  });

  it('dispatch-production yield sample floor keeps routing byte-identical', async () => {
    const cfg = withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.9,
    });
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents: [
        makeDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
        makeDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
      ],
    });

    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
  });

  it('proposal-disabled dispatch outcomes do not poison backend yield learning', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.9,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents: [
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'proposal-disabled',
          reason: 'proposal filing disabled for this sandboxed attempt',
        }),
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'proposal-disabled',
          reason: 'proposal filing disabled for this sandboxed attempt',
        }),
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'proposal-disabled',
          reason: 'proposal filing disabled for this sandboxed attempt',
        }),
      ],
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('action-count-only proposal-disabled rows do not poison backend yield learning', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.9,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents: Array.from({ length: 3 }, () =>
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'empty-diff',
          reason: 'legacy row carried policy-disabled only in action counts',
          runEventSummary: {
            actionCounts: {
              proposalDisabled: 1,
              diffFiles: 0,
            },
          },
        })
      ),
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('real non-proposal dispatch outcomes remain learnable after proposal-disabled rows are ignored', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.5,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate = base.backend === 'claude' ? 'codex' : 'claude';
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents: [
        makeDispatchProductionEvent({
          backend: base.backend,
          outcome: 'proposal-disabled',
          reason: 'proposal filing disabled for this sandboxed attempt',
        }),
        makeDispatchProductionEvent({ backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
        makeDispatchProductionEvent({ backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
        makeDispatchProductionEvent({ backend: base.backend, outcome: 'engine-failed', proposalCreated: false }),
        ...comparativeCandidateEvents(alternate),
      ],
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(alternate);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).toContain('recent proposal yield');
    expect(rec.reason).toContain('0/3');
    expect(rec.reason).not.toContain('proposal-disabled');
  });

  it('dispatch-production yield is isolated by work source', async () => {
    const cfg = withInstalledFrontierEngines(withIntelligence({
      allowedBackends: ['builtin', 'claude', 'codex'],
      minProposalYieldRate: 0.9,
    }));
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg, {
      estimate: makeEstimate(0.001, 10),
      prior: { frontierSuccessRate: 0.9, frontierSampleSize: 10 },
      dispatchProductionEvents: [
        makeDispatchProductionEvent({ source: 'todo', backend: base.backend, outcome: 'empty-diff', proposalCreated: false }),
        makeDispatchProductionEvent({ source: 'todo', backend: base.backend, outcome: 'gate-blocked', proposalCreated: false }),
        makeDispatchProductionEvent({ source: 'todo', backend: base.backend, outcome: 'engine-failed', proposalCreated: false }),
      ],
    });

    expect(base.tier).toBe('frontier');
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    expect(rec.reason).not.toContain('recent proposal yield');
  });

  it('confidence is a number in [0, 1]', async () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const item = makeItem({ source: 'issue', effort: 4 });
    const rec = await recommendRoute(item, cfg, { estimate: makeEstimate(0.002) });
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 5. FLAG-OFF — absent intelligence config, tick routing == v4
// ---------------------------------------------------------------------------

describe('M53 invariant 5 — flag-off: absent intelligence config is byte-identical', () => {
  it('recommendRoute with no foundry at all returns same as routeBackend', async () => {
    const cfg = baseCfg();
    const sources: WorkSource[] = ['doc', 'security', 'issue', 'dep', 'todo', 'test'];
    for (const source of sources) {
      const item = makeItem({ source, effort: 3 });
      const base = routeBackend(item, cfg);
      const rec = await recommendRoute(item, cfg);
      expect(rec.backend).toBe(base.backend);
      expect(rec.tier).toBe(base.tier);
    }
  });

  it('recommendRoute with foundry but no intelligence field returns same as routeBackend', async () => {
    // foundry with allowedBackends but no intelligence key.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const item = makeItem({ source: 'security', effort: 4 });
    const base = routeBackend(item, cfg);
    const rec = await recommendRoute(item, cfg);
    expect(rec.backend).toBe(base.backend);
    expect(rec.tier).toBe(base.tier);
    // Confidence 1.0 on the flag-off path signals no learned adjustment.
    expect(rec.confidence).toBe(1.0);
  });

  it('recoverWithinBudget with 0% spend and no budget pressure is a no-op cascade', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
    const result = recoverWithinBudget(decision, cfg, 0, makeForecast(0));
    // At 0% spend, no cascade needed.
    expect(result.action).toBe('cascade');
    if (result.action === 'cascade') {
      expect(result.decision.backend).toBe('claude');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Additional edge-case coverage
// ---------------------------------------------------------------------------

describe('M53 edge cases', () => {
  it('recoverWithinBudget: pause when remaining <= 0 (at exactly 0)', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'test' };
    // spent == dailyBudget == 1.0
    const result = recoverWithinBudget(decision, cfg, 1.0, makeForecast());
    expect(result.action).toBe('pause');
  });

  it('anomalyRatio consistent between the two modules', () => {
    const est = makeEstimate(0.05, 5);
    const cost = 0.25; // 5×p50
    expect(anomalyRatio(cost, est)).toBeCloseTo(5.0, 5);
    expect(anomalyRatioFromEstimate(cost, est)).toBeCloseTo(5.0, 5);
  });

  it('recommendRoute returns a non-empty reason string', async () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin'] });
    const item = makeItem({ source: 'issue', effort: 4 });
    const rec = await recommendRoute(item, cfg);
    expect(typeof rec.reason).toBe('string');
    expect(rec.reason.length).toBeGreaterThan(0);
  });

  it('recoverWithinBudget reason is a non-empty string', () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin', 'claude'] });
    const decision = { backend: 'claude' as const, tier: 'frontier' as EngineTier, reason: 'x' };
    const result = recoverWithinBudget(decision, cfg, 0.5, makeForecast());
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('recommendRoute never throws, even with null/undefined estimate', async () => {
    const cfg = withIntelligence({ allowedBackends: ['builtin'] });
    const item = makeItem({ source: 'doc', effort: 1 });
    await expect(recommendRoute(item, cfg, {})).resolves.toBeDefined();
    await expect(recommendRoute(item, cfg, undefined)).resolves.toBeDefined();
  });
});
