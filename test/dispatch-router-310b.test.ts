/**
 * V3.10 Track B (U5): the fleet dispatch router — SPEC-310B §3 "Routing" /
 * "Lanes" / §7 U5 key tests:
 *   - Claude is excluded while its 5-hour window is above 70%;
 *   - Codex waits for its machine `resetsAt`, and stays off until the Leader
 *     enables its lanes;
 *   - an item that fits no seat is split — NEVER sent to a local model;
 *   - presence caps (local 2, Claude producer slice closed; unknown = present);
 *   - lanes outside the grant, seats without the producer role, demoted routes.
 * Pure: no I/O, fixed clock.
 */
import { describe, expect, it } from 'vitest';

import {
  FLEET_LOCAL_SEAT_ID,
  LANE_DEFAULT_SLOTS,
  FANOUT_LOCAL_EXTRA_MAX,
  anyFanoutCandidate,
  bestOfNCandidates,
  difficultyOf,
  fitBestOfNToLanes,
  fleetLaneOf,
  planFanoutReserve,
  planStandingBestOfN,
  grantSeatFor,
  planLanes,
  resolveLaneEngines,
  routeWorkItem,
  routingRequestFor,
  type DispatchRouterContext,
  type LanePlan,
  type LegacyRoute,
  type OperatorPresence,
} from '../src/core/fleet/dispatch-router.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { standingSeatFor } from '../src/core/authority/effective-config.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { EffectivePolicy, EffectiveSeatPolicy } from '../src/core/authority/types.js';
import type { FleetEngine } from '../src/core/fleet/fleet-types.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const IN_3H = new Date(NOW + 3 * 3_600_000).toISOString();
const REPO = 'ashlrai/binshield';
const REPO_PATH = '/tmp/mirrors/ashlrai__binshield';

function claude(fiveHour: number, weekly: number): SeatCapacity {
  return {
    seatId: 'claude',
    engine: 'claude',
    label: 'Claude',
    free: false,
    windows: [
      { id: 'five_hour', usedPercent: fiveHour, resetsAt: null, resetDescription: 'in 3 hours', limitReached: false },
      { id: 'seven_day', usedPercent: weekly, resetsAt: null, resetDescription: 'Friday 7pm', limitReached: false },
    ],
    signedOut: false,
    reachable: null,
    contextWindow: 200_000,
    observedAt: NOW_ISO,
    spentTodayUsd: null,
  };
}

function grok(used = 10, observedAt: string | null = NOW_ISO): SeatCapacity {
  return {
    seatId: 'grok',
    engine: 'grok',
    label: 'Grok',
    free: false,
    windows: [{ id: 'grok_billing', usedPercent: used, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(), resetDescription: null, limitReached: false }],
    signedOut: false,
    reachable: null,
    contextWindow: 256_000,
    observedAt,
    spentTodayUsd: null,
  };
}

function codex(used: number, resetsAt: string): SeatCapacity {
  return {
    seatId: 'codex-personal',
    engine: 'codex',
    label: 'Codex',
    free: false,
    windows: [{ id: 'codex_personal_secondary', usedPercent: used, resetsAt, resetDescription: null, limitReached: used >= 100 }],
    signedOut: false,
    reachable: null,
    contextWindow: 400_000,
    observedAt: NOW_ISO,
    spentTodayUsd: null,
  };
}

function local(window = 65_536): SeatCapacity {
  return {
    seatId: FLEET_LOCAL_SEAT_ID,
    engine: 'local',
    label: 'Local fleet',
    free: true,
    windows: [],
    signedOut: false,
    reachable: true,
    contextWindow: window,
    observedAt: null,
    spentTodayUsd: null,
  };
}

function seat(seatId: string, roles: EffectiveSeatPolicy['roles'], enabled = true): EffectiveSeatPolicy {
  return { seatId, enabled, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles };
}

function policy(over: Partial<Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'>> = {}): Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'> {
  return {
    engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        claude: seat('claude', ['producer', 'judge', 'leader']),
        grok: seat('grok', ['producer', 'judge']),
        'codex-personal': seat('codex-personal', ['producer']),
        local: seat('local', ['producer']),
      },
    },
    repos: [{
      nameWithOwner: REPO,
      stage: 'merge',
      enforcement: 'server',
      maxRisk: 'low',
      maxFiles: 4,
      maxLines: 150,
      maxMergesPerDay: 6,
      selfRepo: null,
    }],
    ...over,
  };
}

const ABSENT: OperatorPresence = { present: false, reason: 'Nobody is at the keyboard.', evidenceAt: null };

function lanes(over: Partial<Record<FleetEngine, number>> = {}): Record<FleetEngine, LanePlan> {
  const out = {} as Record<FleetEngine, LanePlan>;
  for (const lane of ['local', 'grok-cli', 'claude-cli', 'codex'] as FleetEngine[]) {
    out[lane] = { lane, slots: over[lane] ?? LANE_DEFAULT_SLOTS[lane], capReason: null };
  }
  return out;
}

function ctx(capacity: SeatCapacity[], over: Partial<DispatchRouterContext> = {}): DispatchRouterContext {
  const budget: BudgetPolicy = defaultBudgetPolicy();
  return {
    nowMs: NOW,
    policy: policy(),
    budget,
    capacity,
    lanes: lanes(),
    laneEngines: { local: 'llama-server' as EngineId, 'grok-cli': 'grok-cli' as EngineId, 'claude-cli': 'claude' as EngineId, codex: 'codex' as EngineId },
    demotions: [],
    repoOf: (path) => (path === REPO_PATH ? REPO : null),
    tierOf: (engine) => {
      // Registry ids beyond the EngineId union (llama-server, grok-cli) are compared as strings.
      const id: string = engine;
      return id === 'llama-server' || id === 'local-coder' ? 'mid' : id === 'builtin' ? 'local' : 'frontier';
    },
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    repo: REPO_PATH,
    source: 'todo',
    title: 'Fix the parser edge case',
    detail: 'Short detail.',
    value: 3,
    effort: 3,
    score: 1,
    tags: [],
    ts: NOW_ISO,
    ...over,
  };
}

const LEGACY_LOCAL: LegacyRoute = { backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy: builtin' };

describe('Claude and the 5-hour window (balanced: 70% ceiling, 40% weekly reserve)', () => {
  it('excludes Claude while its 5-hour window is above 70% and routes hard work elsewhere', () => {
    const route = routeWorkItem(item({ tags: ['difficulty:high'] }), LEGACY_LOCAL, ctx([claude(75, 20), grok(), local()]));
    expect(route.hold).toBeNull();
    expect(route.backend).toBe('grok-cli');
    expect(route.lane).toBe('grok-cli');
    const excluded = route.seatDecision?.exclusions.find((e) => e.seatId === 'claude');
    expect(excluded?.reasons.join(' ')).toMatch(/5-hour window is 75% used; autonomy stops at 70%/);
  });

  it('uses Claude for hard work when the 5-hour window is under the ceiling and the reserve holds', () => {
    const route = routeWorkItem(item({ tags: ['difficulty:high'] }), LEGACY_LOCAL, ctx([claude(40, 30), grok(), local()], {
      lanes: lanes({ 'claude-cli': 1 }),
    }));
    expect(route.backend).toBe('claude');
    expect(route.lane).toBe('claude-cli');
  });

  it('keeps Claude off when the grant gives claude-a no producer role, even with headroom', () => {
    const base = policy();
    const p = { ...base, spend: { ...base.spend, seats: { ...base.spend.seats, claude: seat('claude', ['judge', 'leader']) } } };
    const route = routeWorkItem(item({ tags: ['difficulty:high'] }), LEGACY_LOCAL, ctx([claude(10, 10), grok(), local()], { policy: p }));
    expect(route.backend).toBe('grok-cli');
    const claudeOut = route.seatDecision?.exclusions.find((e) => e.seatId === 'claude');
    expect(claudeOut?.reasons.join(' ')).toMatch(/no producer role/);
    expect(claudeOut?.details?.map((r) => r.kind)).toEqual(['grant']);
  });
});

describe('Codex waits for its reset', () => {
  it('parks work until the spent window\'s machine resetsAt when Codex is the only seat that fits', () => {
    const big = item({ tags: ['difficulty:high', 'context:150000'] });
    // Local cannot fit 150k; Grok is not connected; Codex is spent until IN_3H.
    const budget: BudgetPolicy = { mode: 'balanced', updatedAt: NOW_ISO, seats: { 'codex-personal': { seatId: 'codex-personal', enabled: true, reservePercent: 0 } } };
    const route = routeWorkItem(big, LEGACY_LOCAL, ctx([codex(100, IN_3H), local()], { budget }));
    expect(route.hold?.kind).toBe('park');
    expect(route.hold?.nextEligibleAt).toBe(IN_3H);
    expect(route.backend).not.toBe('llama-server');
  });

  it('stays off (zero Codex slots) until the Leader enables Codex lanes', () => {
    const planned = planLanes({
      policy: policy(),
      directives: null,
      presence: ABSENT,
      localServingSlots: 4,
      engineUnavailable: {},
    });
    expect(planned.codex.slots).toBe(0);
    expect(planned.codex.capReason).toMatch(/until the Leader enables them/);
    const enabled = planLanes({
      policy: policy(),
      directives: { v: 1, updatedAt: NOW_ISO, routerTuning: null, grokLanes: null, codexEnabled: true },
      presence: ABSENT,
      localServingSlots: 4,
      engineUnavailable: {},
    });
    expect(enabled.codex.slots).toBe(2);
  });

  it('routes to Codex once its window has headroom and its lane is open', () => {
    const budget: BudgetPolicy = { mode: 'balanced', updatedAt: NOW_ISO, seats: { 'codex-personal': { seatId: 'codex-personal', enabled: true, reservePercent: 0 } } };
    const route = routeWorkItem(item({ tags: ['difficulty:high', 'context:150000'] }), LEGACY_LOCAL, ctx([codex(20, IN_3H), local()], { budget }));
    expect(route.hold).toBeNull();
    expect(route.backend).toBe('codex');
  });
});

describe('split items never go local', () => {
  it('holds as `split` when the work fits no seat at all — never downgraded to a local model', () => {
    const route = routeWorkItem(item({ tags: ['context:900000'] }), LEGACY_LOCAL, ctx([claude(10, 10), grok(), local()]));
    expect(route.hold?.kind).toBe('split');
    expect(route.hold?.reason).toMatch(/never handed to a local model/);
    expect(route.lane).toBeNull();
  });

  it('parks (not local) when only a budget-held frontier seat could fit it', () => {
    // 120k fits Grok's 256k window but not the 64k local slot; Grok's reading is stale.
    const stale = new Date(NOW - 60 * 60_000).toISOString();
    const route = routeWorkItem(item({ tags: ['context:120000'] }), LEGACY_LOCAL, ctx([grok(10, stale), local()]));
    expect(route.hold?.kind).toBe('park');
    expect(route.backend).toBe('builtin');
    expect(route.lane).toBeNull();
    expect(route.seatDecision?.exclusions.find((e) => e.seatId === FLEET_LOCAL_SEAT_ID)?.reasons.join(' ')).toMatch(/context/);
  });

  it('sends small work to the local fleet (free, fits)', () => {
    const route = routeWorkItem(item({ effort: 1 }), LEGACY_LOCAL, ctx([grok(), local()]));
    expect(route.hold).toBeNull();
    expect(route.lane).toBe('local');
    // The legacy engine is kept when it already dispatches through the chosen lane.
    expect(route.backend).toBe('builtin');
  });

  it('uses the lane engine when the legacy engine is in another lane', () => {
    const legacyCloud: LegacyRoute = { backend: 'claude' as EngineId, tier: 'frontier', reason: 'legacy: claude' };
    const route = routeWorkItem(item({ effort: 1 }), legacyCloud, ctx([grok(), local()]));
    expect(route.lane).toBe('local');
    expect(route.backend).toBe('llama-server');
  });
});

describe('presence caps', () => {
  it('holds the local lane to 2 and closes the Claude producer slice while Mason is present', () => {
    const present: OperatorPresence = { present: true, reason: 'A Verse chat turn is running.', evidenceAt: NOW_ISO };
    const planned = planLanes({ policy: policy(), directives: null, presence: present, localServingSlots: 4, engineUnavailable: {} });
    expect(planned.local.slots).toBe(2);
    expect(planned.local.capReason).toMatch(/You are active/);
    expect(planned['claude-cli'].slots).toBe(0);
  });

  it('treats unknown presence as present', () => {
    const unknown: OperatorPresence = { present: null, reason: 'Claude Code activity could not be read.', evidenceAt: null };
    const planned = planLanes({ policy: policy(), directives: null, presence: unknown, localServingSlots: 4, engineUnavailable: {} });
    expect(planned.local.slots).toBe(2);
    expect(planned.local.capReason).toMatch(/Presence is unknown/);
  });

  it('runs the full local width when absent, bounded by the runtime\'s serving slots', () => {
    const full = planLanes({ policy: policy(), directives: null, presence: ABSENT, localServingSlots: 4, engineUnavailable: {} });
    expect(full.local.slots).toBe(4);
    expect(full.local.capReason).toBeNull();
    const three = planLanes({ policy: policy(), directives: null, presence: ABSENT, localServingSlots: 3, engineUnavailable: {} });
    expect(three.local.slots).toBe(3);
  });

  it('lets the Leader set 1–4 grok lanes, clamped', () => {
    const planned = planLanes({
      policy: policy(),
      directives: { v: 1, updatedAt: NOW_ISO, routerTuning: null, grokLanes: 9, codexEnabled: null },
      presence: ABSENT,
      localServingSlots: 4,
      engineUnavailable: {},
    });
    expect(planned['grok-cli'].slots).toBe(4);
  });

  it('closes every lane outside the grant\'s current stage', () => {
    const planned = planLanes({ policy: policy({ engines: ['local'] }), directives: null, presence: ABSENT, localServingSlots: 4, engineUnavailable: {} });
    expect(planned['grok-cli'].slots).toBe(0);
    expect(planned['grok-cli'].capReason).toMatch(/does not include grok-cli/);
    expect(planned.local.slots).toBe(4);
  });

  it('closes a lane whose engine is not installed or allowed', () => {
    const engines = resolveLaneEngines({ allowedBackends: ['builtin', 'claude'], installed: () => true, localFleetEngine: null });
    expect(engines.engines['grok-cli']).toBeNull();
    expect(engines.unavailable['grok-cli']).toMatch(/not in foundry.allowedBackends/);
    expect(engines.engines.local).toBe('builtin');
    const planned = planLanes({ policy: policy(), directives: null, presence: ABSENT, localServingSlots: 4, engineUnavailable: engines.unavailable });
    expect(planned['grok-cli'].slots).toBe(0);
  });
});

describe('grant scope and backpressure demotion', () => {
  it('holds work for a repo outside the current rollout stage', () => {
    const other = item({ repo: '/tmp/mirrors/ashlrai__other' });
    const route = routeWorkItem(other, LEGACY_LOCAL, ctx([grok(), local()], {
      repoOf: (path) => (path === '/tmp/mirrors/ashlrai__other' ? 'ashlrai/other' : REPO),
    }));
    expect(route.hold?.kind).toBe('park');
    expect(route.hold?.reason).toMatch(/not in the grant's current rollout stage/);
  });

  it('holds work whose repo has no GitHub identity', () => {
    const route = routeWorkItem(item({ repo: '/tmp/unknown' }), LEGACY_LOCAL, ctx([grok(), local()]));
    expect(route.hold?.reason).toMatch(/no GitHub identity/);
  });

  it('skips a demoted engine × repo × kind route and takes the next candidate', () => {
    const route = routeWorkItem(item({ effort: 3 }), LEGACY_LOCAL, ctx([grok(), local()], {
      demotions: [{ engine: 'grok-cli', repo: REPO, kind: 'todo', since: NOW_ISO, until: IN_3H, reason: '3 consecutive rejects.' }],
    }));
    expect(route.lane).toBe('local');
    const grokOut = route.seatDecision?.exclusions.find((e) => e.seatId === 'grok');
    expect(grokOut?.reasons.join(' ')).toMatch(/demoted until/);
    // 3.10.1: the same reason as data — its end is `resetsAt`, not prose.
    expect(grokOut?.details).toEqual([{ kind: 'demoted', text: `This route (grok-cli on ${REPO} for todo work) is demoted: 3 consecutive rejects.`, resetsAt: IN_3H }]);
  });
});

describe('routing weights reach the seat ranking', () => {
  // Medium work in balanced mode prefers Grok, then local. The λ weights the
  // tick resolves (Leader › harness › baseline) used to stop at best-of-N.
  it('keeps Grok at the baseline weights and leans to the free local lane when lambdaCost rises', () => {
    const baseline = routeWorkItem(item({ effort: 3 }), LEGACY_LOCAL, ctx([grok(), local()], {
      weights: { lambdaCost: 1, lambdaPressure: 1, lambdaLatency: 0.25 },
    }));
    expect(baseline.lane).toBe('grok-cli');
    const cheap = routeWorkItem(item({ effort: 3 }), LEGACY_LOCAL, ctx([grok(), local()], {
      weights: { lambdaCost: 3, lambdaPressure: 1, lambdaLatency: 0.25 },
    }));
    expect(cheap.lane).toBe('local');
    expect(cheap.seatDecision?.candidates).toEqual([FLEET_LOCAL_SEAT_ID, 'grok']);
  });
});

describe('lanes and requests', () => {
  const cfg = { user: { id: 't', name: 'T' } } as unknown as AshlrConfig;

  it('maps engines to lanes by locality AND spend', () => {
    expect(fleetLaneOf('grok-cli', cfg)).toBe('grok-cli');
    expect(fleetLaneOf('claude', cfg)).toBe('claude-cli');
    expect(fleetLaneOf('codex', cfg)).toBe('codex');
    // The per-token xAI API is never a fleet lane.
    expect(fleetLaneOf('grok', cfg)).toBeNull();
    // Local process, but handed paid credentials: not local capacity.
    expect(fleetLaneOf('ashlrcode', cfg)).toBeNull();
    expect(fleetLaneOf('builtin', cfg)).toBe('local');
    expect(fleetLaneOf('llama-server', cfg)).toBe('local');
    const remote = {
      foundry: {
        engines: {
          'local-coder': {
            id: 'local-coder', kind: 'api-model', tier: 'mid',
            api: { envKey: '', defaultBaseUrl: 'https://api.example.com/v1', defaultModel: 'm', protocol: 'openai' },
          },
        },
      },
    } as unknown as AshlrConfig;
    expect(fleetLaneOf('local-coder', remote)).toBeNull();
  });

  it('derives difficulty from tags, effort and source', () => {
    expect(difficultyOf({ effort: 1, source: 'todo', tags: [] })).toBe('low');
    expect(difficultyOf({ effort: 3, source: 'todo', tags: [] })).toBe('medium');
    expect(difficultyOf({ effort: 4, source: 'todo', tags: [] })).toBe('high');
    expect(difficultyOf({ effort: 1, source: 'invent', tags: [] })).toBe('high');
    expect(difficultyOf({ effort: 5, source: 'todo', tags: ['difficulty:low'] })).toBe('low');
  });

  it('builds an autonomous request with a context estimate (or the tagged size)', () => {
    const request = routingRequestFor(item({ source: 'lint', effort: 1 }));
    expect(request.autonomous).toBe(true);
    expect(request.task).toBe('bulk');
    expect(request.contextTokens).toBeGreaterThan(8_000);
    expect(routingRequestFor(item({ tags: ['context:42000'] })).contextTokens).toBe(42_000);
  });

  it('picks best-of-N candidates from distinct engines, grok first', () => {
    const open = lanes();
    const engines = { local: 'llama-server' as EngineId, 'grok-cli': 'grok-cli' as EngineId, 'claude-cli': null, codex: null };
    expect(bestOfNCandidates(open, engines, ['llama-server' as EngineId, 'local-coder' as EngineId])).toEqual(['grok-cli', 'llama-server', 'local-coder']);
    expect(bestOfNCandidates(open, engines, ['llama-server' as EngineId, 'llama-server' as EngineId])).toEqual(['grok-cli', 'llama-server']);
    expect(bestOfNCandidates(lanes({ 'grok-cli': 0 }), engines, ['llama-server' as EngineId])).toEqual([]);
  });
});

describe('grant seats (mirrors B-U1 standingSeatFor)', () => {
  it('answers exactly like authority/effective-config.ts standingSeatFor', () => {
    const withWildcard = policy().spend;
    const { local: _wildcard, ...rest } = withWildcard.seats;
    const withoutWildcard = { ...withWildcard, seats: rest };
    const exactLocal = { ...withWildcard, seats: { ...withWildcard.seats, 'local:qwen': seat('local:qwen', ['judge']) } };
    const ids = ['claude', 'claude-b', 'grok', 'grok-2', 'codex-personal', 'codex-work', 'local', 'local:qwen', 'local:other', 'mystery', 'LOCAL:caps'];
    for (const spend of [withWildcard, withoutWildcard, exactLocal]) {
      for (const id of ids) expect(grantSeatFor(spend, id)).toEqual(standingSeatFor(spend, id));
    }
    // A local-runtime seat falls back to the `local` wildcard; a paid one never does.
    expect(grantSeatFor(withWildcard, 'local:other')?.seatId).toBe('local');
    expect(grantSeatFor(withWildcard, 'claude-b')).toBeNull();
    // An exact entry wins over the wildcard.
    expect(grantSeatFor(exactLocal, 'local:qwen')?.roles).toEqual(['judge']);
  });

  it('routes to a local seat the grant covers only through its `local` wildcard', () => {
    const tagged: SeatCapacity = { ...local(), seatId: 'local:qwen' };
    const route = routeWorkItem(item({ effort: 1 }), LEGACY_LOCAL, ctx([tagged]));
    expect(route.hold).toBeNull();
    expect(route.lane).toBe('local');
    expect(route.seatDecision?.seatId).toBe('local:qwen');
  });
});

// ---------------------------------------------------------------------------
// Review c15: best-of-N candidates are charged against the lanes.
// ---------------------------------------------------------------------------

describe('best-of-N lane accounting (review c15)', () => {
  const CFG15 = { foundry: { models: { 'llama-server': 'qwen3-coder' } } } as unknown as AshlrConfig;
  const planned = {
    run: true as const,
    reason: 'planned' as const,
    candidates: [
      { engine: 'grok-cli' as EngineId },
      { engine: 'llama-server' as EngineId, model: 'q' },
      { engine: 'llama-server' as EngineId, model: 'q' },
    ],
  };
  const zero = { local: 0, 'grok-cli': 0, 'claude-cli': 0, codex: 0 };

  it('reserves fan-out slots only when a fan-out is plausible, always leaving the pool a local slot', () => {
    expect(planFanoutReserve(lanes({ local: 2 }), false)).toEqual(zero);
    expect(planFanoutReserve(lanes({ local: 2 }), true)).toMatchObject({ local: 1, 'grok-cli': 1, 'claude-cli': 0, codex: 0 });
    expect(planFanoutReserve(lanes({ local: 4 }), true).local).toBe(FANOUT_LOCAL_EXTRA_MAX);
    expect(planFanoutReserve(lanes({ local: 1, 'grok-cli': 1 }), true)).toEqual(zero);
  });

  it('a grok-routed item uses its own slot for Grok and only reserved turns for local candidates', () => {
    const fitted = fitBestOfNToLanes(planned, 'grok-cli', { ...zero, local: 1 }, CFG15);
    expect(fitted.run).toBe(true);
    expect(fitted.candidates.map((c) => c.engine)).toEqual(['grok-cli', 'llama-server']);
    expect(fitted.laneCharge).toEqual({ ...zero, local: 1 });
  });

  it('a local-routed item runs one local candidate on its own slot and charges the frontier lane', () => {
    const fitted = fitBestOfNToLanes(planned, 'local', { ...zero, 'grok-cli': 1 }, CFG15);
    expect(fitted.candidates.map((c) => c.engine)).toEqual(['grok-cli', 'llama-server']);
    expect(fitted.laneCharge).toEqual({ ...zero, 'grok-cli': 1 });
  });

  it('no reserve ⇒ no fan-out (engine diversity cannot be met), never an over-cap run', () => {
    expect(fitBestOfNToLanes(planned, 'grok-cli', zero, CFG15)).toMatchObject({ run: false, reason: 'no-engine-diversity', candidates: [], laneCharge: zero });
  });

  it('planStandingBestOfN applies the budget when given one', () => {
    const plan = planStandingBestOfN({
      item: { effort: 5, source: 'todo', tags: [] },
      route: { hold: null, lane: 'grok-cli' },
      lanes: lanes({ local: 2 }),
      laneEngines: { local: 'llama-server' as EngineId, 'grok-cli': 'grok-cli' as EngineId, 'claude-cli': null, codex: null },
      mode: 'balanced',
      weights: { lambdaCost: 1, lambdaPressure: 1, lambdaLatency: 1, bonThreshold: 'high' },
      priorFailures: 0,
      grokAllowed: true,
      claudeAllowed: false,
      fanoutBudget: { ...zero, local: 1 },
      cfg: CFG15,
    });
    expect(plan.run).toBe(true);
    expect(plan.candidates.filter((c) => String(c.engine) === 'llama-server')).toHaveLength(1);
    expect(plan.laneCharge.local).toBe(1);
  });

  it('predicts a fan-out from difficulty or a prior failure', () => {
    expect(anyFanoutCandidate([{ id: 'a', effort: 1, source: 'todo', tags: [] }], 'high', () => 0)).toBe(false);
    expect(anyFanoutCandidate([{ id: 'a', effort: 5, source: 'todo', tags: [] }], 'high', () => 0)).toBe(true);
    expect(anyFanoutCandidate([{ id: 'a', effort: 1, source: 'todo', tags: [] }], 'high', () => 1)).toBe(true);
    expect(anyFanoutCandidate([{ id: 'a', effort: 3, source: 'todo', tags: [] }], 'medium', () => 0)).toBe(true);
  });
});
