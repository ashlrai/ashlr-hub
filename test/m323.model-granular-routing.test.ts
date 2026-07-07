/**
 * m323.model-granular-routing.test.ts — M323: cost-aware model-granular routing.
 *
 * Covers:
 *  - buildProducerScores joins judged verdicts to 'proposed' producers by
 *    proposalId (judge-model identity never becomes a key) with canonical
 *    spelling collapse;
 *  - selectCostAwareModel: cheapest-clearing-the-bar, never-into-a-bad-model
 *    floor, thin-sample null;
 *  - routeTask integration: flag on steers AWAY from a bad-ship-rate default
 *    (sonnet-5) to the model that ships (opus); flag off / cold start are
 *    byte-identical to the static M321 decisions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: (engine: string) =>
    engine === 'claude' || engine === 'codex' ? 'frontier'
      : engine === 'local-coder' || engine === 'nim' ? 'mid' : 'local',
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) =>
    engine === 'claude' || engine === 'codex' ? 'frontier'
      : engine === 'local-coder' || engine === 'nim' ? 'mid' : 'local',
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn(() => true),
  evalQuota: vi.fn(() => 'ok'),
  recordUse: vi.fn(),
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock' })),
  isSubscriptionEngine: vi.fn((e: string) => e === 'claude' || e === 'codex'),
  subscriptionUsage: vi.fn(() => null),
}));

// Ledger fixture — swapped per test via `fixture`.
let fixture: Record<string, unknown>[] = [];

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number }) => {
    const since = opts?.sinceMs ?? 0;
    return fixture.filter((d) => Date.parse(String(d['ts'])) >= since);
  }),
  recordDecision: vi.fn(() => {}),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import { routeTask } from '../src/core/run/router.js';
import {
  buildProducerScores,
  selectCostAwareModel,
  LEARNED_ROUTING_MIN_SAMPLES,
} from '../src/core/run/learned-router.js';
import { KNOWN_MODELS } from '../src/core/run/model-catalog.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const ts = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** N proposed+judged chains for one producer model with the given verdicts. */
function chains(
  idPrefix: string,
  model: string,
  verdicts: string[],
  source = 'issue',
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  verdicts.forEach((verdict, i) => {
    const pid = `${idPrefix}-${i}`;
    // judged (newer) first — readDecisions returns newest-first
    out.push({
      ts: ts(1 + i),
      proposalId: pid,
      action: 'judged',
      // the JUDGE's identity — must never become a producer key
      engine: 'claude-fable-5',
      model: 'claude-fable-5',
      verdict,
    });
    out.push({
      ts: ts(2 + i),
      proposalId: pid,
      action: 'proposed',
      engine: 'claude',
      model,
      workSource: source,
    });
  });
  return out;
}

/** sonnet-5 ships badly (1/6), opus ships perfectly (6/6). */
const SONNET_BAD_OPUS_GOOD = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship', 'ship', 'ship', 'ship', 'ship']),
];

/** sonnet-5 ships well (5/6) — cheapest clearing the bar. */
const SONNET_GOOD = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'ship', 'ship', 'ship', 'ship', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship', 'ship', 'ship', 'ship', 'ship']),
];

/** Too few samples on every model. */
const THIN = [
  ...chains('s5', 'claude:claude-sonnet-5', ['ship', 'rejected']),
  ...chains('op', 'claude:claude-opus-4-8', ['ship', 'ship']),
];

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], routing: [] },
  } as unknown as AshlrConfig;
}

function cfgWith(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return {
    ...baseConfig(),
    foundry: { allowedBackends: ['claude', 'builtin'] as never[], ...extra },
  } as AshlrConfig;
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 5,
    score: 9,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  } as WorkItem;
}

const CLAUDE_CTX = { availableEngines: ['claude', 'builtin'] } as never;

beforeEach(() => {
  _seq = 0;
  fixture = [];
});

// ---------------------------------------------------------------------------
// buildProducerScores
// ---------------------------------------------------------------------------

describe('M323 buildProducerScores', () => {
  it('attributes verdicts to the PRODUCER with canonical keys', () => {
    fixture = SONNET_GOOD;
    const scores = buildProducerScores('issue', NOW);
    expect(scores.has('claude:sonnet-5')).toBe(true);
    expect(scores.has('claude:opus')).toBe(true);
    // judge identity never becomes a key
    expect(scores.has('claude-fable-5:claude-fable-5')).toBe(false);
    expect(scores.has('claude-fable-5:fable-5')).toBe(false);
    const s5 = scores.get('claude:sonnet-5')!;
    expect(s5.samples).toBeGreaterThanOrEqual(LEARNED_ROUTING_MIN_SAMPLES);
    expect(s5.score).toBeGreaterThan(0.7);
  });

  it('filters producers by taskClass', () => {
    fixture = chains('s5', 'claude:claude-sonnet-5', ['ship', 'ship', 'ship', 'ship', 'ship'], 'lint');
    expect(buildProducerScores('issue', NOW).size).toBe(0);
    expect(buildProducerScores('lint', NOW).size).toBe(1);
  });

  it('cold start → empty map', () => {
    fixture = [];
    expect(buildProducerScores('issue', NOW).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectCostAwareModel
// ---------------------------------------------------------------------------

describe('M323 selectCostAwareModel', () => {
  const claudeLarge = KNOWN_MODELS.filter(
    (m) => m.engine === 'claude' && m.tier === 'large' && m.id !== 'claude:fable-5',
  );

  it('picks the cheapest candidate clearing the bar', () => {
    fixture = SONNET_GOOD;
    const scores = buildProducerScores('issue', NOW);
    const pick = selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.6 });
    expect(pick?.id).toBe('claude:sonnet-5'); // cheaper than opus, clears 0.6
  });

  it('raising the bar past sonnet-5 selects opus', () => {
    fixture = SONNET_GOOD; // s5 ≈ 0.83, opus = 1.0
    const scores = buildProducerScores('issue', NOW);
    const pick = selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.9 });
    expect(pick?.id).toBe('claude:opus');
  });

  it('never learns INTO a bad model: all sampled < 0.5 → null', () => {
    // M338 (review fix): 8 verdicts so the recency-weighted sample count
    // clears LEARNED_ROUTING_MIN_SAMPLES — 5 verdicts at ages 1–5h decay to
    // ~4.94 weighted samples, which silently exercised the THIN-SAMPLE path
    // instead of the <0.5 floor this test exists to pin.
    fixture = chains('s5', 'claude:claude-sonnet-5', [
      'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'ship',
    ]);
    const scores = buildProducerScores('issue', NOW);
    const s5 = scores.get('claude:sonnet-5')!;
    expect(s5.samples).toBeGreaterThanOrEqual(LEARNED_ROUTING_MIN_SAMPLES); // floor path, not thin-sample
    expect(s5.score).toBeLessThan(0.5);
    const onlySonnet = KNOWN_MODELS.filter((m) => m.id === 'claude:sonnet-5');
    expect(selectCostAwareModel(onlySonnet, scores, { minShipRate: 0.6 })).toBeNull();
  });

  it('thin samples → null (static fallback)', () => {
    fixture = THIN;
    const scores = buildProducerScores('issue', NOW);
    expect(selectCostAwareModel(claudeLarge, scores, { minShipRate: 0.6 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routeTask integration
// ---------------------------------------------------------------------------

describe('M323 routeTask integration', () => {
  const flagOn = { modelGranularRouting: { enabled: true } };

  it('steers AWAY from a bad default: sonnet-5 rejected-heavy → opus wins', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.engine).toBe('claude');
    expect(result.catalogEntry?.id).toBe('claude:opus');
    expect(result.reason).toContain('M323 learned');
  });

  it('good sonnet-5 stays the (cheapest clearing) pick with learned reason', () => {
    fixture = SONNET_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).toContain('M323 learned');
  });

  it('flag OFF: static M321 decision even with a bad-ship-rate ledger', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5'); // static workhorse pick
    expect(result.reason).not.toContain('M323');
  });

  it('flag ON + cold start: byte-identical static decision', () => {
    fixture = [];
    const item = makeItem({ source: 'issue' });
    const on = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    const off = routeTask(item, cfgWith(), CLAUDE_CTX);
    expect(on.engine).toBe(off.engine);
    expect(on.model).toBe(off.model);
    expect(on.reason).toBe(off.reason);
  });

  it('flag ON + thin samples: static decision preserved', () => {
    fixture = THIN;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(item, cfgWith(flagOn), CLAUDE_CTX);
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).not.toContain('M323');
  });

  it('cfg.foundry.models override still beats the learned pick', () => {
    fixture = SONNET_BAD_OPUS_GOOD;
    const item = makeItem({ source: 'issue' });
    const result = routeTask(
      item,
      cfgWith({ ...flagOn, models: { claude: 'opus' } as never }),
      CLAUDE_CTX,
    );
    expect(result.model).toBe('opus');
    expect(result.reason).toContain('cfg override');
  });
});
