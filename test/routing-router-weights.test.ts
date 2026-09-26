/**
 * The seat router's λ objective weights (routing/router.ts `seatScore`).
 *
 *   - At the defaults (= BASELINE_HARNESS_CONFIG.routing) the ranking is
 *     exactly the pre-λ explicit order: engine, then more headroom, then the
 *     caller's order, then id — checked against a reference implementation
 *     over a generated grid of fleets, modes and requests.
 *   - Table-driven: moving one λ moves the ranking in the documented
 *     direction (cost → cheaper / pricier, pressure → headroom counts more /
 *     less, latency → faster seats win ties, then more).
 *
 * Pure: no I/O, no model calls, fixed clock.
 */
import { describe, expect, it } from 'vitest';

import { assessSeat, type CapacityWindow, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy, effectiveSeatPolicy } from '../src/core/routing/policy.js';
import {
  DEFAULT_ROUTER_WEIGHTS,
  ROUTER_LAMBDA_MAX,
  enginePreference,
  routeSeat,
  type RouteOptions,
  type RouterWeights,
} from '../src/core/routing/router.js';
import { BASELINE_HARNESS_CONFIG, HARNESS_CONFIG_BOUNDS } from '../src/core/learn/harness-registry.js';
import type { BudgetMode, BudgetPolicy, RoutingRequest } from '../src/core/routing/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const IN_3D = new Date(NOW + 3 * 86_400_000).toISOString();

function win(id: string, usedPercent: number | null): CapacityWindow {
  return { id, usedPercent, resetsAt: IN_3D, resetDescription: null, limitReached: false };
}

function seat(seatId: string, engine: SeatCapacity['engine'], windows: CapacityWindow[]): SeatCapacity {
  return {
    seatId,
    engine,
    label: seatId,
    free: engine === 'local',
    windows,
    signedOut: false,
    reachable: engine === 'local' ? true : null,
    contextWindow: engine === 'local' ? 65_536 : 200_000,
    observedAt: engine === 'local' ? null : NOW_ISO,
    spentTodayUsd: null,
  };
}

const claude = (id: string, session: number | null, weekly: number | null): SeatCapacity =>
  seat(id, 'claude', [win('five_hour', session), win('seven_day', weekly)]);
const codex = (id: string, used: number | null): SeatCapacity => seat(id, 'codex', [win('codex_primary', used)]);
const grok = (used: number | null, id = 'grok'): SeatCapacity => seat(id, 'grok', [win('grok_unified_weekly', used)]);
const local = (tag: string): SeatCapacity => seat(`local:${tag}`, 'local', []);

/** A policy for `mode` with every Codex seat switched on (the defaults keep Codex off). */
function policyFor(mode: BudgetMode, codexIds: readonly string[] = []): BudgetPolicy {
  const base = defaultBudgetPolicy();
  const seats = { ...base.seats };
  for (const id of codexIds) seats[id] = { seatId: id, enabled: true, reservePercent: 10 };
  return { ...base, mode, seats };
}

const auto = (task: RoutingRequest['task'], difficulty: RoutingRequest['difficulty']): RoutingRequest =>
  ({ task, difficulty, autonomous: true });

function route(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  policy: BudgetPolicy,
  extra: Omit<RouteOptions, 'nowMs'> = {},
): string[] {
  return routeSeat(req, capacity, policy, { nowMs: NOW, ...extra }).candidates;
}

// ---------------------------------------------------------------------------
// Defaults keep the explicit order
// ---------------------------------------------------------------------------

/** The pre-λ ranking, restated independently: engine order, more headroom, caller order, id. */
function legacyOrder(req: RoutingRequest, capacity: readonly SeatCapacity[], policy: BudgetPolicy, eligible: readonly string[]): string[] {
  const order = enginePreference(policy.mode, req);
  const rows = capacity
    .map((c, index) => {
      const seatPolicy = req.autonomous
        ? effectiveSeatPolicy(policy, c.seatId, c.engine)
        : { seatId: c.seatId, enabled: true, reservePercent: 0 };
      const headroom = assessSeat(c, seatPolicy, { nowMs: NOW }).headroom.autonomyHeadroomPercent ?? -1;
      return { id: c.seatId, pos: order.indexOf(c.engine), headroom, index };
    })
    .filter((r) => eligible.includes(r.id));
  rows.sort((a, b) => a.pos - b.pos || b.headroom - a.headroom || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((r) => r.id);
}

/** Small deterministic PRNG so the grid is the same on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function usedPercent(rand: () => number): number | null {
  const r = rand();
  if (r < 0.08) return null;
  return Math.round(rand() * 100);
}

function randomFleet(rand: () => number): SeatCapacity[] {
  const fleet: SeatCapacity[] = [];
  if (rand() < 0.8) fleet.push(claude('claude', usedPercent(rand), usedPercent(rand)));
  if (rand() < 0.4) fleet.push(claude('claude-b', usedPercent(rand), usedPercent(rand)));
  if (rand() < 0.7) fleet.push(codex('codex-personal', usedPercent(rand)));
  if (rand() < 0.4) fleet.push(codex('codex-cmp', usedPercent(rand)));
  if (rand() < 0.8) fleet.push(grok(usedPercent(rand)));
  if (rand() < 0.3) fleet.push(grok(usedPercent(rand), 'grok-b'));
  if (rand() < 0.8) fleet.push(local('qwen3.8:27b-ctx64k'));
  if (rand() < 0.4) fleet.push(local('gpt-oss:20b'));
  // Shuffle so caller order is exercised too.
  for (let i = fleet.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [fleet[i], fleet[j]] = [fleet[j]!, fleet[i]!];
  }
  return fleet;
}

const REQUESTS: RoutingRequest[] = [
  auto('code', 'low'),
  auto('code', 'medium'),
  auto('code', 'high'),
  auto('leader', 'medium'),
  auto('bulk', 'high'),
  { task: 'code', difficulty: 'medium', autonomous: false },
];

describe('λ weights at their defaults keep the explicit order', () => {
  it('DEFAULT_ROUTER_WEIGHTS is the harness baseline (one fact, two places)', () => {
    const { lambdaCost, lambdaPressure, lambdaLatency } = BASELINE_HARNESS_CONFIG.routing;
    expect(DEFAULT_ROUTER_WEIGHTS).toEqual({ lambdaCost, lambdaPressure, lambdaLatency });
  });

  it('matches the pre-λ ranking over a generated grid of fleets, modes and requests', () => {
    const rand = prng(20260925);
    let compared = 0;
    for (let i = 0; i < 120; i += 1) {
      const fleet = randomFleet(rand);
      for (const mode of ['all-in', 'balanced', 'reserve'] as const) {
        const policy = policyFor(mode, ['codex-personal', 'codex-cmp']);
        for (const req of REQUESTS) {
          const implicit = route(req, fleet, policy);
          const explicit = route(req, fleet, policy, { weights: { ...DEFAULT_ROUTER_WEIGHTS } });
          expect(explicit).toEqual(implicit);
          expect(implicit).toEqual(legacyOrder(req, fleet, policy, implicit));
          if (implicit.length > 1) compared += 1;
        }
      }
    }
    // The grid must actually exercise multi-seat rankings, not only trivial ones.
    expect(compared).toBeGreaterThan(500);
  });

  it('leaves the `why` sentence unchanged at the defaults and names tuned weights otherwise', () => {
    const fleet = [grok(10), local('qwen3.8:27b-ctx64k')];
    const plain = routeSeat(auto('code', 'medium'), fleet, policyFor('balanced'), { nowMs: NOW });
    const same = routeSeat(auto('code', 'medium'), fleet, policyFor('balanced'), { nowMs: NOW, weights: DEFAULT_ROUTER_WEIGHTS });
    expect(same.why).toBe(plain.why);
    expect(plain.why).not.toMatch(/routing weights/);
    const tuned = routeSeat(auto('code', 'medium'), fleet, policyFor('balanced'), { nowMs: NOW, weights: { lambdaCost: 3 } });
    expect(tuned.why).toMatch(/routing weights cost ×3, headroom ×1, latency ×0\.25/);
  });

  it('ROUTER_LAMBDA_MAX is the harness registry bound (one fact, two places)', () => {
    expect(ROUTER_LAMBDA_MAX).toBe(HARNESS_CONFIG_BOUNDS.lambdaMax);
  });

  it('clamps a λ above the bound, so every score stays finite and ordered', () => {
    // Unclamped, (1e308 − 1) · costStep overflows to Infinity; two seats of
    // one engine would then compare Infinity − Infinity = NaN and headroom
    // would stop ordering them.
    const fleet = [claude('claude', 10, 10), grok(80), grok(20, 'grok-b'), local('qwen3.8:27b-ctx64k')];
    const req = auto('code', 'high');
    for (const key of ['lambdaCost', 'lambdaPressure', 'lambdaLatency'] as const) {
      const huge = route(req, fleet, policyFor('balanced'), { weights: { [key]: 1e308 }, latencyMs: { grok: 1_000, 'grok-b': 9_000 } });
      const atMax = route(req, fleet, policyFor('balanced'), { weights: { [key]: ROUTER_LAMBDA_MAX }, latencyMs: { grok: 1_000, 'grok-b': 9_000 } });
      expect(huge).toEqual(atMax);
    }
    // Same-engine seats still order by headroom at the clamped maximum.
    const cost = route(req, fleet, policyFor('balanced'), { weights: { lambdaCost: 1e308 } });
    expect(cost.indexOf('grok-b')).toBeLessThan(cost.indexOf('grok'));
  });

  it('the full decision (candidates, why, exclusions) is identical with no weights and the baseline weights', () => {
    const rand = prng(7);
    for (let i = 0; i < 40; i += 1) {
      const fleet = randomFleet(rand);
      for (const mode of ['all-in', 'balanced', 'reserve'] as const) {
        const policy = policyFor(mode, ['codex-personal']);
        for (const req of REQUESTS) {
          const none = routeSeat(req, fleet, policy, { nowMs: NOW });
          // The tick passes the whole HarnessRoutingWeights (bonThreshold included).
          const baseline = routeSeat(req, fleet, policy, { nowMs: NOW, weights: BASELINE_HARNESS_CONFIG.routing });
          expect(baseline).toEqual(none);
        }
      }
    }
  });

  it.each([
    ['NaN', { lambdaCost: Number.NaN }],
    ['negative', { lambdaPressure: -2 }],
    ['infinite', { lambdaLatency: Number.POSITIVE_INFINITY }],
  ] as const)('treats a %s λ as its default rather than scrambling the order', (_label, weights) => {
    const fleet = [claude('claude', 10, 10), grok(80), grok(20, 'grok-b'), local('qwen3.8:27b-ctx64k')];
    const req = auto('code', 'high');
    expect(route(req, fleet, policyFor('balanced'), { weights })).toEqual(route(req, fleet, policyFor('balanced')));
  });
});

// ---------------------------------------------------------------------------
// Changing one λ moves the ranking the documented way
// ---------------------------------------------------------------------------

interface WeightCase {
  name: string;
  req: RoutingRequest;
  fleet: SeatCapacity[];
  policy: BudgetPolicy;
  latencyMs?: Record<string, number>;
  weights: Partial<RouterWeights>;
  /** Ranking at the defaults (the explicit order). */
  before: string[];
  /** Ranking with `weights`. */
  after: string[];
}

const LOCAL = 'local:qwen3.8:27b-ctx64k';

const CASES: WeightCase[] = [
  // ── cost ──────────────────────────────────────────────────────────────
  {
    name: 'lambdaCost up: hard work (quality-first) leans to the cheaper engines',
    req: auto('code', 'high'),
    fleet: [claude('claude', 10, 10), grok(10), local('qwen3.8:27b-ctx64k')],
    policy: policyFor('balanced'),
    weights: { lambdaCost: 3 },
    before: ['claude', 'grok', LOCAL],
    // claude 0 + 2·3, grok 2 + 2·1, local 3 + 0 → local, grok, claude.
    after: [LOCAL, 'grok', 'claude'],
  },
  {
    name: 'lambdaCost down: low-difficulty work (cheap-first) leans to the pricier engines',
    req: auto('code', 'low'),
    fleet: [claude('claude', 10, 10), grok(10), local('qwen3.8:27b-ctx64k')],
    policy: policyFor('all-in'),
    weights: { lambdaCost: 0 },
    before: [LOCAL, 'grok', 'claude'],
    // λcost = 0 cancels a pure cost ladder: every engine ties and headroom
    // decides — local (100% left) first, then Claude and Grok (90% each) in
    // caller order, so Claude climbs above Grok.
    after: [LOCAL, 'claude', 'grok'],
  },
  {
    name: 'lambdaCost down past zero influence: medium work pulls Claude above local',
    req: auto('code', 'medium'),
    fleet: [local('qwen3.8:27b-ctx64k'), claude('claude', 10, 10), grok(10)],
    policy: policyFor('balanced'),
    weights: { lambdaCost: 0 },
    before: ['grok', LOCAL, 'claude'],
    // grok 0 − 1, claude 3 − 3, local 1 − 0 → grok, claude, local.
    after: ['grok', 'claude', LOCAL],
  },
  // ── headroom (pressure) ───────────────────────────────────────────────
  {
    name: 'lambdaPressure up: a nearly full preferred seat yields to an emptier next engine',
    req: auto('code', 'medium'),
    fleet: [grok(70), local('qwen3.8:27b-ctx64k')],
    // Balanced medium work: Grok, then local (all-in would put local last).
    policy: policyFor('balanced'),
    weights: { lambdaPressure: 5 },
    before: ['grok', LOCAL],
    // Grok has 30% left for autonomy: 0 + 5·0.5·(100 − 30)/101 ≈ 1.73 is
    // over local's 1 + 0 → local first (at λ = 1 it is 0.35, under 1).
    after: [LOCAL, 'grok'],
  },
  {
    name: 'lambdaPressure zero: headroom stops ordering seats of one engine (caller order decides)',
    req: auto('code', 'medium'),
    fleet: [grok(70), grok(5, 'grok-b')],
    policy: policyFor('all-in'),
    weights: { lambdaPressure: 0 },
    before: ['grok-b', 'grok'],
    after: ['grok', 'grok-b'],
  },
  // ── latency ───────────────────────────────────────────────────────────
  {
    name: 'lambdaLatency default: a faster seat wins a headroom tie',
    req: auto('code', 'medium'),
    fleet: [grok(20), grok(20, 'grok-b')],
    policy: policyFor('all-in'),
    latencyMs: { grok: 9_000, 'grok-b': 3_000 },
    weights: {},
    before: ['grok-b', 'grok'],
    after: ['grok-b', 'grok'],
  },
  {
    name: 'lambdaLatency up: a much faster seat beats a little more headroom',
    req: auto('code', 'medium'),
    fleet: [grok(20), grok(30, 'grok-b')],
    policy: policyFor('all-in'),
    latencyMs: { grok: 9_000, 'grok-b': 3_000 },
    weights: { lambdaLatency: 10 },
    before: ['grok', 'grok-b'],
    after: ['grok-b', 'grok'],
  },
  {
    name: 'lambdaLatency at the maximum still never crosses an engine step',
    req: auto('code', 'medium'),
    fleet: [grok(20), local('qwen3.8:27b-ctx64k')],
    policy: policyFor('all-in'),
    latencyMs: { grok: 60_000, [LOCAL]: 1_000 },
    weights: { lambdaLatency: 10 },
    before: ['grok', LOCAL],
    after: ['grok', LOCAL],
  },
];

describe('changing one λ moves the ranking in the expected direction', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const defaults = route(c.req, c.fleet, c.policy, c.latencyMs ? { latencyMs: c.latencyMs } : {});
    expect(defaults).toEqual(c.before);
    const tuned = route(c.req, c.fleet, c.policy, { weights: c.weights, ...(c.latencyMs ? { latencyMs: c.latencyMs } : {}) });
    expect(tuned).toEqual(c.after);
  });

  it('a 1-point headroom gap beats any latency gap at the default λ (latency is only a tie-breaker)', () => {
    const fleet = [grok(20), grok(21, 'grok-b')];
    const latencyMs = { grok: 60_000, 'grok-b': 1_000 };
    // grok has 1 more point of headroom; grok-b is 60× faster.
    expect(route(auto('code', 'medium'), fleet, policyFor('all-in'), { latencyMs })).toEqual(['grok', 'grok-b']);
  });

  it('is monotone in lambdaCost: the free seat never moves down as λ rises', () => {
    const fleet = [claude('claude', 10, 10), codex('codex-personal', 10), grok(10), local('qwen3.8:27b-ctx64k')];
    const policy = policyFor('balanced', ['codex-personal']);
    let last = Number.POSITIVE_INFINITY;
    for (const lambdaCost of [0, 0.5, 1, 1.5, 2, 3, 5, 10]) {
      const at = route(auto('code', 'high'), fleet, policy, { weights: { lambdaCost } }).indexOf(LOCAL);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(last);
      last = at;
    }
    expect(last).toBe(0);
  });
});
