/**
 * 3.15 — Claude, Codex and Devin as equal partners (Mason, 2026-09-27).
 *
 *   - ONE tier model (routing/tiers.ts): elite = Claude, Codex, Devin (and the
 *     local Qwen 3.8 27B); fast = Grok and Devin's free SWE; free = other
 *     local models. Per model, with a separate cost basis.
 *   - The router orders TIERS, never providers: inside a tier, headroom, then
 *     marginal cost (subscription before credits), then latency decide.
 *   - Devin is routable for Mason's own work like any elite seat; the fleet
 *     never routes to it (its own lane, grant and ACU reserve are unchanged).
 *   - The Auto seat, Compare and the handoff alternatives include Devin; a
 *     seat's cheaper-tier model (Devin SWE) competes for cheap work.
 *   - Unchanged on purpose: Devin is never auto-picked as a REVIEWER.
 *
 * Pure: no I/O, no model calls, fixed clock.
 */
import { describe, expect, it } from 'vitest';

import { capacityFromSeat, type CapacityWindow, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { rankAlternatives, routeSeat } from '../src/core/routing/router.js';
import {
  costBasisOf,
  engineTier,
  isEliteLocalModel,
  orderByTier,
  RESOURCE_TIERS,
  seatTier,
  type ModelTierSource,
} from '../src/core/routing/tiers.js';
import { adviseSeat, type AdvisorSeat } from '../src/core/verse/multimodel/advisor.js';
import { classifyPrompt } from '../src/core/verse/multimodel/classify.js';
import { crossFamilyReviewer, defaultCompareSet } from '../src/core/verse/multimodel/compare.js';
import { rankSeatAlternatives } from '../src/core/verse/seat-readiness.js';
import type { SeatAdviceOption } from '../src/core/verse/multimodel/types.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const IN_3H = new Date(NOW + 3 * 3_600_000).toISOString();
const POLICY: BudgetPolicy = defaultBudgetPolicy();
const opts = { nowMs: NOW };

function win(id: string, usedPercent: number): CapacityWindow {
  return { id, usedPercent, resetsAt: IN_3H, resetDescription: null, limitReached: usedPercent >= 100 };
}

function cap(seatId: string, engine: SeatCapacity['engine'], windows: CapacityWindow[], extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId, engine, label: seatId, free: engine === 'local', windows, signedOut: false,
    reachable: engine === 'local' ? true : null, contextWindow: engine === 'local' ? 65_536 : 1_000_000,
    observedAt: engine === 'local' ? null : FRESH, spentTodayUsd: null, ...extra,
  };
}

const claude = (used: number) => cap('claude', 'claude', [win('five_hour', used)]);
const codex = (id: string, used: number) => cap(id, 'codex', [win('codex_primary', used)]);
const grok = (used: number) => cap('grok', 'grok', [win('grok_unified_weekly', used)]);
const devinCloud = () => cap('devin', 'devin', [], { windowless: true, costBasis: 'credits', tier: 'elite' });
const devinCli = () => cap('devin-cli', 'devin', [], { windowless: true, costBasis: 'subscription', tier: 'elite' });
const interactive = { task: 'code' as const, difficulty: 'high' as const, autonomous: false };

// ---------------------------------------------------------------------------
// The tier model
// ---------------------------------------------------------------------------

describe('one tier model', () => {
  it('Claude, Codex and Devin are elite; Grok is fast; local is free — by engine', () => {
    expect(['claude', 'codex', 'devin'].map(engineTier)).toEqual(['elite', 'elite', 'elite']);
    expect(engineTier('grok')).toBe('fast');
    expect(engineTier('local')).toBe('free');
    // An unknown engine is never assumed free.
    expect(engineTier('mystery')).toBe('elite');
    expect(RESOURCE_TIERS).toEqual(['elite', 'fast', 'free']);
  });

  it('tier is per MODEL: Devin SWE is fast, the local Qwen 3.8 27B is elite, other local tags stay free', () => {
    expect(seatTier('devin', 'devin')).toBe('elite');
    expect(seatTier('devin', 'opus')).toBe('elite');
    for (const swe of ['swe', 'SWE-2', 'swe-1.5', 'swe_2']) expect(seatTier('devin', swe)).toBe('fast');
    expect(seatTier('devin', 'sweeper')).toBe('elite');
    expect(seatTier('local', 'qwen3.8:27b-ctx64k')).toBe('elite');
    expect(seatTier('local', 'library/qwen3.8:27b')).toBe('elite');
    expect(seatTier('local', 'qwen/qwen3.8-27b-instruct')).toBe('elite');
    expect(isEliteLocalModel('qwen3.8:270b')).toBe(false);
    expect(seatTier('local', 'qwen3.6:27b')).toBe('free');
    expect(seatTier('local', 'gpt-oss:20b')).toBe('free');
  });

  it('a model catalog can supply its own answer through ModelTierSource', () => {
    const source: ModelTierSource = { tierOf: (engine, id) => (engine === 'devin' && id === 'swe-3-preview' ? 'fast' : null) };
    expect(seatTier('devin', 'swe-3-preview', source)).toBe('fast');
    expect(seatTier('devin', 'kimi-k3', source)).toBe('elite');
  });

  it('cost basis is its own axis', () => {
    expect(costBasisOf('claude')).toBe('subscription');
    expect(costBasisOf('claude', { cloud: true })).toBe('credits');
    expect(costBasisOf('devin', { cloud: true })).toBe('credits');
    expect(costBasisOf('devin', { modelId: 'swe' })).toBe('free');
    expect(costBasisOf('local')).toBe('free');
    expect(costBasisOf('codex', { apiKey: true })).toBe('per-token');
  });

  it('orderByTier is stable inside a tier (no provider ever jumps another)', () => {
    const engines = ['local', 'grok', 'devin', 'codex', 'claude'];
    expect(orderByTier(engines, engineTier)).toEqual(['devin', 'codex', 'claude', 'grok', 'local']);
  });

  it('capacityFromSeat carries tier, cost basis and windowless for the model a turn would run', () => {
    const base: Omit<VerseSeat, 'id' | 'engine' | 'label' | 'accountId' | 'models'> = {
      contextWindow: null,
      health: { state: 'ready', summary: null, windows: [], observedAt: FRESH },
    };
    const cloud: VerseSeat = { ...base, id: 'devin', engine: 'devin', label: 'Devin (cloud)', accountId: 'devin', costBasis: 'credits',
      models: [{ id: 'devin', label: 'Devin', contextWindow: null, windowSource: 'fallback' }] };
    const cli: VerseSeat = { ...base, id: 'devin-cli', engine: 'devin', label: 'Devin (CLI)', accountId: 'devin-cli',
      models: [{ id: 'devin', label: 'Devin default', contextWindow: null, windowSource: 'fallback' }, { id: 'swe', label: 'SWE', contextWindow: null, windowSource: 'fallback' }] };
    expect(capacityFromSeat(cloud)).toMatchObject({ engine: 'devin', tier: 'elite', costBasis: 'credits', windowless: true, free: false });
    expect(capacityFromSeat(cli)).toMatchObject({ tier: 'elite', costBasis: 'subscription', windowless: true });
    expect(capacityFromSeat(cli, undefined, 'swe')).toMatchObject({ tier: 'fast', costBasis: 'free' });
  });
});

// ---------------------------------------------------------------------------
// The router: tiers, never providers
// ---------------------------------------------------------------------------

describe('routeSeat — equal partners', () => {
  it('inside the elite tier, headroom picks — Claude, Codex or Devin, whichever has room', () => {
    expect(routeSeat(interactive, [claude(20), codex('codex-personal', 60), grok(0)], POLICY, opts).candidates)
      .toEqual(['claude', 'codex-personal', 'grok']);
    expect(routeSeat(interactive, [claude(80), codex('codex-personal', 10), grok(0)], POLICY, opts).candidates)
      .toEqual(['codex-personal', 'claude', 'grok']);
  });

  it('Devin is a candidate for Mason’s own work: a windowless seat ranks as neutral headroom, not the worst', () => {
    const d = routeSeat(interactive, [claude(70), devinCli(), grok(0)], POLICY, opts);
    // Claude has 30% left; Devin has no window (neutral 50%) → Devin first, then Claude, then the fast tier.
    expect(d.candidates).toEqual(['devin-cli', 'claude', 'grok']);
    expect(d.why).toMatch(/prefers the elite tier/);
    // A roomier Claude wins back.
    expect(routeSeat(interactive, [claude(10), devinCli()], POLICY, opts).seatId).toBe('claude');
  });

  it('marginal cost: at equal headroom a subscription seat beats a credits seat of the same tier', () => {
    const d = routeSeat(interactive, [devinCloud(), devinCli()], POLICY, opts);
    expect(d.candidates).toEqual(['devin-cli', 'devin']);
    // …but a credits seat with clearly more room still wins (the term is ~20 points of headroom).
    const roomy = routeSeat(interactive, [claude(90), devinCloud()], POLICY, opts);
    expect(roomy.seatId).toBe('devin');
  });

  it('the fleet never routes to Devin — its own lane, grant and ACU reserve are unchanged', () => {
    const d = routeSeat({ task: 'code', difficulty: 'high', autonomous: true }, [claude(10), devinCloud(), devinCli()], POLICY, opts);
    expect(d.candidates).toEqual(['claude']);
    const held = d.exclusions.find((e) => e.seatId === 'devin')!;
    expect(held.details?.[0]?.kind).toBe('lane');
    expect(held.reasons[0]).toMatch(/fleet runs Devin as its own session lane/);
  });

  it('the elite local Qwen competes for elite work (free, all headroom) — for the fleet too', () => {
    const qwen = cap('local:qwen3.8:27b-ctx64k', 'local', [], { tier: 'elite' });
    const d = routeSeat({ task: 'code', difficulty: 'high', autonomous: true }, [claude(10), grok(0), qwen], POLICY, opts);
    expect(d.candidates[0]).toBe('local:qwen3.8:27b-ctx64k');
    expect(d.candidates.at(-1)).toBe('grok');
  });

  it('handoff alternatives include Devin like any other seat', () => {
    const alts = rankAlternatives('claude', [claude(100), grok(0), devinCli(), codex('codex-cmp', 50)], POLICY, opts);
    expect(alts).toEqual(['devin-cli', 'codex-cmp', 'grok']);
  });
});

// ---------------------------------------------------------------------------
// The Auto seat, Compare, review
// ---------------------------------------------------------------------------

function advisor(c: SeatCapacity, over: Partial<AdvisorSeat> = {}): AdvisorSeat {
  return {
    seatId: c.seatId, engine: c.engine, label: c.seatId, model: `${c.engine}-model`, local: c.engine === 'local',
    private: c.engine === 'local', supportsTools: true, capacity: c, ...over,
  };
}

describe('adviseSeat — Devin is an equal partner', () => {
  it('hard work can land on Devin when it has the room', () => {
    const a = adviseSeat({
      classification: classifyPrompt('architect the new billing system'),
      seats: [advisor(claude(90)), advisor(codex('codex-personal', 95)), advisor(devinCli(), { label: 'Devin (CLI)' }), advisor(grok(0))],
      policy: POLICY, mode: 'auto', nowMs: NOW,
    });
    expect(a.choice?.seatId).toBe('devin-cli');
    expect(a.choice?.tier).toBe('elite');
    expect(a.why).toBe('Devin (CLI) — architecture planning needs the strongest model; subscription · no usage window reported.');
  });

  it('cheap work uses a seat’s cheaper-tier model: Devin CLI on its free SWE', () => {
    const cli = devinCli();
    const seat = advisor(cli, { label: 'Devin (CLI)', model: 'devin', cheaper: { model: 'swe', capacity: { ...cli, tier: 'fast', costBasis: 'free' } } });
    const a = adviseSeat({ classification: classifyPrompt('what does this regex match?'), seats: [advisor(claude(10)), seat], policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(a.choice).toMatchObject({ seatId: 'devin-cli', model: 'swe', tier: 'fast' });
    expect(a.choice?.note).toBe('free on your plan');
    // Hard work on the same seat uses its elite default.
    const hard = adviseSeat({ classification: classifyPrompt('architect the new billing system'), seats: [advisor(claude(99)), seat], policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(hard.choice).toMatchObject({ seatId: 'devin-cli', model: 'devin', tier: 'elite' });
  });

  it('eligible elite local Qwen competes for cheap and hard work without assumed hosted speed', () => {
    const qwen = advisor(cap('local:qwen3.8:27b-ctx64k', 'local', [], { tier: 'elite', costBasis: 'free' }), { label: 'Qwen 3.8 27B (local)' });
    const seats = [advisor(claude(40)), qwen, advisor(grok(0))];
    const cheap = adviseSeat({ classification: classifyPrompt('what is a monad?'), seats, policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(cheap.choice?.seatId).toBe('local:qwen3.8:27b-ctx64k');
    const hard = adviseSeat({ classification: classifyPrompt('architect the new billing system'), seats, policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(hard.choice?.seatId).toBe('local:qwen3.8:27b-ctx64k');
    expect(hard.why).not.toMatch(/answers faster|slower/);
    expect(hard.alternatives[0]?.seatId).toBe('claude');
    // A local-only repo still keeps it on this Mac.
    const priv = adviseSeat({ classification: classifyPrompt('architect the new billing system'), seats, policy: POLICY, mode: 'auto', nowMs: NOW, localOnly: { on: true, reason: null } });
    expect(priv.choice?.seatId).toBe('local:qwen3.8:27b-ctx64k');
  });

  it('hard-work locality does not override pins, measured latency or actual eligibility', () => {
    const qwen = advisor(cap('local:qwen3.8:27b-ctx64k', 'local', [], { tier: 'elite', costBasis: 'free' }));
    const hosted = advisor(claude(40));
    const base = { classification: classifyPrompt('architect the new billing system'), seats: [hosted, qwen], policy: POLICY, mode: 'auto' as const, nowMs: NOW };
    expect(adviseSeat({ ...base, pinnedSeatId: 'claude' }).choice?.seatId).toBe('claude');
    const measured = adviseSeat({ ...base, seats: [advisor(claude(0)), qwen], roi: {
      local: { dispatches: 20, shipRate: null, avgLatencyMs: 60_000 },
      claude: { dispatches: 20, shipRate: null, avgLatencyMs: 1_000 },
    } });
    expect(measured.choice?.seatId).toBe('claude');
    expect(measured.why).not.toMatch(/answers faster|slower/);
    for (const capacity of [
      { ...qwen.capacity, contextWindow: 8 },
      { ...qwen.capacity, reachable: false },
    ]) {
      const advice = adviseSeat({ ...base, seats: [hosted, { ...qwen, capacity }], pinnedSeatId: qwen.seatId });
      expect(advice.choice?.seatId).toBe('claude');
      expect(advice.held.map(entry => entry.seatId)).toContain(qwen.seatId);
    }
    const spent = adviseSeat({ ...base, seats: [advisor(codex('codex-personal', 100)), qwen], pinnedSeatId: 'codex-personal' });
    expect(spent.choice?.seatId).toBe(qwen.seatId);
    expect(spent.held[0]?.reason).toContain('Auto does not select Codex credit-funded turns');
  });
});

describe('Compare and review', () => {
  const o = (seatId: string, engine: string, tier: SeatAdviceOption['tier'], local = false): SeatAdviceOption =>
    ({ seatId, label: seatId, engine, model: null, local, note: '', ...(tier ? { tier } : {}) });

  it('elite work pits the elite partners against each other: Claude vs Codex vs Devin', () => {
    const set = defaultCompareSet(o('codex-personal', 'codex', 'elite'), [
      o('codex-cmp', 'codex', 'elite'), o('local:q', 'local', 'free', true), o('claude', 'claude', 'elite'), o('grok', 'grok', 'fast'), o('devin', 'devin', 'elite'),
    ]);
    expect(set.map((x) => x.engine)).toEqual(['codex', 'claude', 'devin']);
  });

  it('non-elite work keeps one local voice', () => {
    const set = defaultCompareSet(o('grok', 'grok', 'fast'), [o('claude', 'claude', 'elite'), o('devin', 'devin', 'elite'), o('local:q', 'local', 'free', true)]);
    expect(set.map((x) => x.seatId)).toEqual(['grok', 'claude', 'local:q']);
  });

  it('Devin is never auto-picked as a cross-family REVIEWER (a decision left to Mason)', () => {
    expect(crossFamilyReviewer('claude', [o('devin', 'devin', 'elite'), o('codex-personal', 'codex', 'elite')])?.seatId).toBe('codex-personal');
    expect(crossFamilyReviewer('claude', [o('devin', 'devin', 'elite')])).toBeNull();
  });
});

describe('seat alternatives ("try X") include a ready Devin seat like any subscription seat', () => {
  it('a ready windowless Devin seat ranks with the measured seats, not behind every unread one', () => {
    const health = { state: 'ready' as const, summary: null, windows: [], observedAt: FRESH };
    const seat = (id: string, engine: VerseSeat['engine'], extra: Partial<VerseSeat> = {}): VerseSeat => ({
      id, engine, label: id, accountId: id, contextWindow: null, health,
      models: [{ id: 'm', label: 'm', contextWindow: null, windowSource: 'fallback' }], ...extra,
    });
    const unread = seat('grok', 'grok');
    const devin = seat('devin-cli', 'devin');
    const blocked = seat('claude', 'claude');
    expect(rankSeatAlternatives('claude', [blocked, unread, devin], null, NOW)).toEqual(['devin-cli', 'grok']);
  });
});
