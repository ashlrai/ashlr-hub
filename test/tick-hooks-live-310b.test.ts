/**
 * V3.10 Track B (U5): the live TickHooks a standing session installs
 * (fleet/tick-hooks-live.ts) — every dependency injected, no seat, no GitHub,
 * no daemon. Proves the fail-closed ladder of beforeTick (no grant, overlay
 * unavailable, holds, backpressure, a broken ledger, the post-merge watch),
 * presence and lane caps, the router seam, the seat gate (grok-cli judged on
 * its seat; claude still passes master's subscription gate), dispatch and
 * landing journaling, fleet-task updates, and the standing-run helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXPERIMENT_LOCAL_SLOTS_BUSY,
  EXPERIMENT_LOCAL_SLOTS_IDLE,
  createLiveTickHooks,
  createStandingRun,
  probeLocalRuntimeDefault,
  probeOperatorPresence,
  type LiveHooksDeps,
} from '../src/core/fleet/tick-hooks-live.js';
import { EXPERIMENT_SLOTS } from '../src/core/learn/experiments.js';
import { fleetLaneOf } from '../src/core/fleet/dispatch-router.js';
import { resolveEngineSpec } from '../src/core/run/engine-registry.js';
import { fleetPrKey, type ObservedPrState, type OpenFleetPrRef } from '../src/core/fleet/backpressure.js';
import { emptyBackpressureState } from '../src/core/fleet/backpressure.js';
import { defaultBudgetPolicy, defaultSeatPolicy } from '../src/core/routing/policy.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { EffectivePolicy, LedgerEntry } from '../src/core/authority/types.js';
import type { DispatchOutcome, FleetTask, LandingRecord, RepoHold, SetRepoHoldRequest } from '../src/core/fleet/fleet-types.js';
import type { FleetJournalRecord, FleetTickStateV1 } from '../src/core/fleet/fleet-runtime-journal.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';
import type { DaemonActivationCapability } from '../src/core/daemon/activation-permit.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const REPO = 'ashlrai/binshield';
const PATH = '/tmp/mirrors/ashlrai__binshield';
const OTHER_PATH = '/tmp/mirrors/ashlrai__other';
const CFG = { foundry: { allowedBackends: ['builtin', 'llama-server', 'grok-cli', 'claude'], fabric: { gateway: true, concurrentDispatch: true } } } as unknown as AshlrConfig;

function policyFixture(over: Partial<EffectivePolicy> = {}): EffectivePolicy {
  const seat = (seatId: string, roles: ('producer' | 'judge' | 'leader')[]) => ({ seatId, enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles });
  return {
    v: 1, grantId: 'g-1', grantSeq: 1, keyId: 'k', issuedAt: NOW_ISO, expiresAt: new Date(NOW + 86_400_000).toISOString(),
    switch: 'autonomous',
    rollout: { stageId: '2b', stageIndex: 2, stageCount: 5, enteredAt: NOW_ISO },
    repos: [{ nameWithOwner: REPO, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }],
    merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats: { grok: seat('grok', ['producer', 'judge']), claude: seat('claude', ['producer', 'judge']), local: seat('local', ['producer']) } },
    engines: ['local', 'grok-cli', 'claude-cli'],
    leader: { classes: ['A'], vetoMinutes: 30 },
    conductorGoals: false,
    computedAt: NOW_ISO,
    ...over,
  };
}

function grokSeat(used = 10): SeatCapacity {
  return {
    seatId: 'grok', engine: 'grok', label: 'Grok', free: false,
    windows: [{ id: 'grok_billing', usedPercent: used, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(), resetDescription: null, limitReached: false }],
    signedOut: false, reachable: null, contextWindow: 256_000, observedAt: NOW_ISO, spentTodayUsd: null,
  };
}

function claudeSeat(fiveHour = 20): SeatCapacity {
  return {
    seatId: 'claude', engine: 'claude', label: 'Claude', free: false,
    windows: [
      { id: 'five_hour', usedPercent: fiveHour, resetsAt: null, resetDescription: 'in 2 hours', limitReached: false },
      { id: 'seven_day', usedPercent: 20, resetsAt: null, resetDescription: 'Friday', limitReached: false },
    ],
    signedOut: false, reachable: null, contextWindow: 200_000, observedAt: NOW_ISO, spentTodayUsd: null,
  };
}

function refusal(proposalId: string, at: string): LedgerEntry {
  return {
    v: 1, seq: 0, at, actor: 'daemon', grantId: 'g-1', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64),
    kind: 'gate:result',
    data: { v: 1, gate: 'G3', proposalId, repo: REPO, headSha: 'a'.repeat(40), verdict: 'refuse', code: 'verify-failed', reason: 'tests failed', at, digest: 'd'.repeat(64) },
  } as LedgerEntry;
}

interface Harness {
  deps: Partial<LiveHooksDeps>;
  ticks: FleetTickStateV1[];
  journal: FleetJournalRecord[];
  holdsSet: SetRepoHoldRequest[];
  audits: string[];
  shadowed: number;
  subscriptionCalls: string[];
  taskUpdates: { taskId: string; kind: string }[];
  insightCalls: number;
  landings: string[];
}

let policy: EffectivePolicy | null;
let holds: RepoHold[];
let ledgerRows: LedgerEntry[];
let ledgerChain: 'ok' | 'empty' | 'broken';
let waiting: number | null;
let watchOk: boolean;
let presenceNow: { present: boolean | null; reason: string; evidenceAt: string | null };
let tasks: FleetTask[];
let subscriptionAllowed: boolean;
let overlayThrows: boolean;
let h: Harness;

function harness(): Harness {
  const out: Harness = { deps: {}, ticks: [], journal: [], holdsSet: [], audits: [], shadowed: 0, subscriptionCalls: [], taskUpdates: [], insightCalls: 0, landings: [] };
  out.deps = {
    now: () => NOW,
    standingPolicy: () => policy,
    applyOverlay: (cfg) => {
      if (overlayThrows) throw new Error('not implemented: applyStandingOverlay');
      return { ...cfg, foundry: { ...cfg.foundry, claimIntegrity: true } } as AshlrConfig;
    },
    clampBudget: (p) => p,
    loadBudget: () => defaultBudgetPolicy(),
    capacitySnapshot: () => ({ v: 1, publishedAt: NOW_ISO, seats: [grokSeat(), claudeSeat()] }),
    probeLocalRuntime: async () => ({ reachable: true, slots: 4, contextPerSlot: 65_536, detail: 'llama-server up with 4 slot(s)' }),
    presence: async () => presenceNow,
    directives: () => null,
    liveLeaderConfig: (cfg) => cfg,
    listHolds: () => holds,
    setHold: (req) => {
      out.holdsSet.push(req);
      const after: RepoHold | null = req.hold
        ? { v: 1, repo: req.repo, kind: req.kind, reason: req.hold.reason, since: NOW_ISO, until: req.hold.until, setBy: req.actor, landingId: null }
        : null;
      return { ok: true, reason: null, before: null, after };
    },
    readLedger: async () => ({ entries: ledgerRows, head: null, chain: ledgerChain, brokenAtSeq: ledgerChain === 'broken' ? 7 : null, reason: ledgerChain === 'broken' ? 'bad hash' : null }),
    ledgerHead: () => ({ seq: 41, hash: 'h'.repeat(64), at: NOW_ISO }),
    listEnrolled: () => [PATH, OTHER_PATH, '/tmp/no-origin'],
    repoIdentity: (path) => (path === PATH ? REPO : path === OTHER_PATH ? 'ashlrai/other' : null),
    waitingVerify: async () => waiting,
    // Never GitHub / the real ledger from a unit test: unknown PR state, no breach rows.
    observeFleetPrs: async () => new Map(),
    recordReserveBreaches: async () => 0,
    installed: () => true,
    tierOf: (engine) => {
      const id: string = engine;
      return id === 'builtin' ? 'local' : id === 'llama-server' ? 'mid' : 'frontier';
    },
    subscriptionAllows: (engine) => {
      out.subscriptionCalls.push(engine);
      return subscriptionAllowed ? { allowed: true, reason: 'ok' } : { allowed: false, reason: `${engine} window 95% used` };
    },
    isSubscriptionEngine: (engine) => {
      const id: string = engine;
      return id === 'claude' || id === 'codex' || id === 'grok-cli';
    },
    legacyRoute: () => ({ backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy' }),
    localFleetEngine: () => 'llama-server' as EngineId,
    readTasks: () => ({ ok: true, tasks }),
    releaseTasks: () => 0,
    recordTask: (taskId, update) => {
      out.taskUpdates.push({ taskId, kind: update.kind });
      return null;
    },
    enqueueInsights: () => {
      out.insightCalls += 1;
      return 0;
    },
    insights: async () => [],
    advanceWatch: async () => ({ ok: watchOk, reason: watchOk ? null : 'the watch store is corrupt', open: 0, finalized: [], reverted: [], escalations: [], softKilled: false, suiteRuns: 0, discovered: 0 }),
    registerLanding: (record) => {
      out.landings.push(record.id);
      return { ok: true, registered: true };
    },
    writeTick: (state) => {
      out.ticks.push(state);
      return true;
    },
    appendJournal: (record) => {
      out.journal.push(record);
      return true;
    },
    readJournalSince: async () => [],
    loadBackpressure: () => emptyBackpressureState(),
    saveBackpressure: () => undefined,
    shadow: () => {
      out.shadowed += 1;
      return true;
    },
    audit: (entry) => {
      out.audits.push(entry.summary);
    },
    // INT1 wiring (U6 mirrors, U4 sweep, B-U8 Leader, B-U9 harness): inert fakes
    // here; test/standing-wiring-310b.test.ts exercises each one.
    prepareMirrors: async () => ({ ready: [], failed: [], pausedRepoPaths: [] }),
    reconcileEnrollment: async () => ({ changed: false, enrolled: [], unenrolled: [], errors: [] }),
    sweepHolds: () => ({ swept: 0, error: null }),
    leaderTick: async () => undefined,
    checkCanary: () => undefined,
    recordHarnessOutcome: () => true,
    runExperiment: async () => null,
    overnightActive: () => false,
  };
  return out;
}

beforeEach(() => {
  policy = policyFixture();
  holds = [];
  ledgerRows = [];
  ledgerChain = 'empty';
  waiting = 0;
  watchOk = true;
  presenceNow = { present: false, reason: 'Nobody is at the keyboard.', evidenceAt: null };
  tasks = [];
  subscriptionAllowed = true;
  overlayThrows = false;
  h = harness();
});

const hookCtx = { nowMs: NOW, cfg: CFG, dryRun: false, capabilityKind: 'resident-standing' as const };

describe('release-backed content maintenance integration', () => {
  it('runs maintenance before reading tasks and skips dry-run observations', async () => {
    const local = harness(); const events: string[] = [];
    local.deps.syncReleaseArticles = async () => { events.push('maintenance'); };
    local.deps.readTasks = () => { events.push('tasks'); return { ok: true, tasks: [] }; };
    await createLiveTickHooks({ deps: local.deps }).beforeTick(hookCtx);
    expect(events).toEqual(['maintenance', 'tasks']); events.length = 0;
    await createLiveTickHooks({ deps: local.deps }).beforeTick({ ...hookCtx, dryRun: true });
    expect(events).toEqual(['tasks']);
  });
  it('maintenance failure leaves the existing engineering task read available', async () => {
    const local = harness(); let reads = 0;
    local.deps.syncReleaseArticles = async () => { throw new Error('public verification unavailable'); };
    local.deps.readTasks = () => { reads++; return { ok: true, tasks: [] }; };
    await createLiveTickHooks({ deps: local.deps }).beforeTick(hookCtx);
    expect(reads).toBe(1);
  });
});

function item(over: Partial<WorkItem> = {}): WorkItem {
  return { id: 'item-1', repo: PATH, source: 'todo', title: 'Fix the parser', detail: 'd', value: 3, effort: 3, score: 1, tags: [], ts: NOW_ISO, ...over };
}

describe('effectiveConfig', () => {
  it('applies the standing overlay, then routes every dispatch through the standing router', () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    const cfg = hooks.effectiveConfig(CFG);
    expect((cfg.foundry as Record<string, unknown>)['claimIntegrity']).toBe(true);
    expect(cfg.foundry?.fabric).toMatchObject({ gateway: false, concurrentDispatch: false, gatewayShadow: false });
  });
});

describe('beforeTick — fail closed', () => {
  it('holds everything when no standing grant is in force', async () => {
    policy = null;
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.holdProduction).toMatch(/standing grant is not in force/);
    expect(result.pausedRepos).toEqual([PATH, OTHER_PATH, '/tmp/no-origin']);
    expect(Object.values(result.laneCaps).every((n) => n === 0)).toBe(true);
    expect(hooks.route(item(), CFG).hold?.reason).toMatch(/No standing tick context/);
    expect(hooks.seatAllows('builtin' as EngineId, { maxPercent: 90 }).allowed).toBe(false);
  });

  it('holds production when the standing overlay is unavailable', async () => {
    overlayThrows = true;
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.holdProduction).toMatch(/standing config overlay is unavailable/);
  });

  it('holds production on a broken ledger, and on a post-merge watch that cannot run', async () => {
    ledgerChain = 'broken';
    let hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).holdProduction).toMatch(/ledger chain is broken at #7/);
    ledgerChain = 'empty';
    watchOk = false;
    hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).holdProduction).toMatch(/post-merge watch could not run/);
  });

  it('holds production while more than 4 proposals wait for verification', async () => {
    waiting = 5;
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).holdProduction).toMatch(/5 proposals are waiting/);
  });

  it('pauses held repos, repos outside the stage and repos with no GitHub identity', async () => {
    holds = [{ v: 1, repo: REPO, kind: 'quarantine', reason: 'red post-merge', since: NOW_ISO, until: new Date(NOW + 3_600_000).toISOString(), setBy: 'post-merge-watch', landingId: 'L1' }];
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.holdProduction).toBeNull();
    expect(result.pausedRepos).toEqual([PATH, OTHER_PATH, '/tmp/no-origin']);
    const state = h.ticks.at(-1)!;
    expect(state.pausedRepos.map((p) => p.reason)).toEqual([
      expect.stringMatching(/On quarantine: red post-merge/),
      expect.stringMatching(/not in the grant's current rollout stage/),
      expect.stringMatching(/no GitHub origin/),
    ]);
  });

  it('sets a 6 h backpressure cooldown after 3 consecutive rejects', async () => {
    ledgerChain = 'ok';
    ledgerRows = [refusal('p-1', new Date(NOW - 30 * 60_000).toISOString()), refusal('p-2', new Date(NOW - 20 * 60_000).toISOString()), refusal('p-3', new Date(NOW - 10 * 60_000).toISOString())];
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(h.holdsSet).toEqual([expect.objectContaining({ repo: REPO, kind: 'cooldown', actor: 'backpressure' })]);
    expect(result.pausedRepos).toContain(PATH);
  });
});

describe('lanes, presence and the router seam', () => {
  it('probes the dispatch endpoint and preserves the original total, activity and time', async () => {
    const health = await import('../src/core/local-runtime/llama/health.js');
    const baseUrl = 'http://127.0.0.1:9864/v1';
    const original = health.composeSnapshot({
      origin: 'http://127.0.0.1:9864', baseUrl, host: '127.0.0.1', port: 9864,
      readings: {
        health: { httpStatus: 200, error: null, body: { status: 'ok' } },
        props: { httpStatus: 200, error: null, body: { total_slots: 2, default_generation_settings: { n_ctx: 65_536 } } },
        slots: { httpStatus: 200, error: null, body: [{ is_processing: true }, { is_processing: false }] },
      }, record: null, ownershipVerified: false, launchAgent: false, killSwitch: false, now: NOW,
    });
    const probe = vi.spyOn(health, 'probeLlamaRuntime').mockResolvedValue(original);
    try {
      const cfg = { ...CFG, foundry: { ...CFG.foundry, localOnly: true }, models: { llamaServer: { baseUrl } } } as unknown as AshlrConfig;
      for (let i = 0; i < 2; i++) {
        expect(await probeLocalRuntimeDefault(cfg, null)).toMatchObject({
          reachable: true, slots: 2, busySlots: 1, idleSlots: 1, observedAt: NOW_ISO, contextPerSlot: 65_536,
        });
      }
      expect(probe.mock.calls).toEqual([[{ baseUrl, timeoutMs: 1_500 }], [{ baseUrl, timeoutMs: 1_500 }]]);
    } finally { probe.mockRestore(); }
  });

  it('allocates only observed free slots and routes overflow to an eligible subscription', async () => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots: 2, idleSlots: 2, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'measured runtime' }),
      legacyRoute: () => ({ backend: 'llama-server' as EngineId, tier: 'mid', reason: 'local runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([item({ effort: 1 })]);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(2);
    hooks.beginDispatchPlan(['first', 'second', 'third']);
    expect(hooks.route(item({ id: 'first', effort: 1 }), CFG).backend).toBe('llama-server');
    expect(hooks.route(item({ id: 'second', effort: 1 }), CFG).backend).toBe('llama-server');
    expect(hooks.route(item({ id: 'third', effort: 1 }), CFG).backend).toBe('grok-cli');
    expect(hooks.route(item({ id: 'first', effort: 1 }), CFG).backend).toBe('llama-server');
  });

  it('parks full-runtime work when no other resource is authorized', async () => {
    policy = policyFixture({ engines: ['local'] });
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots: 4, idleSlots: 0, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'full runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(0);
    expect(hooks.route(item({ effort: 1 }), CFG).hold?.kind).toBe('park');
  });

  it.each([
    { busySlots: null, idleSlots: null, observedAt: NOW_ISO },
    { busySlots: 2, idleSlots: 2, observedAt: null },
    { busySlots: 2, idleSlots: 2, observedAt: 'not a date' },
    { busySlots: 2, idleSlots: 2, observedAt: new Date(NOW - 2_000).toISOString() },
    { busySlots: 2, idleSlots: 2, observedAt: new Date(NOW + 1).toISOString() },
    { busySlots: 1, idleSlots: 2, observedAt: NOW_ISO },
    { busySlots: -1, idleSlots: 5, observedAt: NOW_ISO },
    { busySlots: 1.5, idleSlots: 2.5, observedAt: NOW_ISO },
  ])('preserves configured-only dispatch when occupancy evidence is unknown %j', async (occupancy) => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, ...occupancy, contextPerSlot: 65_536, detail: 'runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(4);
  });

  it('does not renew activity after a slow tick or promote an unavailable runtime', async () => {
    let now = NOW;
    const hooks = createLiveTickHooks({ deps: { ...h.deps, now: () => now,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots: 4, idleSlots: 0, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'runtime' }),
      syncReleaseArticles: async () => { now += 2_001; },
    } });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(4);
    const down = createLiveTickHooks({ deps: { ...h.deps,
      probeLocalRuntime: async () => ({ reachable: false, slots: 4, busySlots: 0, idleSlots: 4, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'down' }),
    } });
    down.effectiveConfig(CFG);
    expect((await down.beforeTick(hookCtx)).laneCaps.local).toBe(0);
  });

  it.each([33, 64])('passes %s fresh measured slots into the standing dispatch pool', async (slots) => {
    presenceNow = { present: false, reason: 'Away', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: {
      ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots, contextPerSlot: 65_536, detail: 'wide runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([item({ id: 'easy-wide', effort: 1 })]);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(slots);
  });

  it('holds the standing local lane when a reachable runtime reports no capacity', async () => {
    const hooks = createLiveTickHooks({ deps: {
      ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots: null, contextPerSlot: 65_536, detail: 'capacity unavailable' }),
    } });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(0);
  });

  it('caps the Ollama fallback to one effective local serving slot', async () => {
    const reading = await probeLocalRuntimeDefault(CFG, {
      v: 1, publishedAt: NOW_ISO,
      seats: [{ ...grokSeat(), engine: 'local', contextWindow: 65_536 }],
    });
    expect(reading).toMatchObject({ reachable: null, slots: 1, contextPerSlot: 65_536 });
  });

  it('reserves available local, Grok and Claude turns before holding overflow', async () => {
    presenceNow = { present: true, reason: 'A Verse chat turn is running.', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: {
      ...h.deps,
      probeLocalRuntime: async () => ({ reachable: null, slots: 1, contextPerSlot: 65_536, detail: 'Ollama serializes Qwen3.8' }),
      legacyRoute: () => ({ backend: 'llama-server' as EngineId, tier: 'mid', reason: 'local runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    const prepared = await hooks.beforeTick(hookCtx);
    expect(prepared.laneCaps.local).toBe(1);

    const preview = hooks.route(item({ id: 'local-1', effort: 2 }), CFG);
    expect(preview.backend).toBe('llama-server');
    expect(hooks.route(item({ id: 'grok-1', effort: 2 }), CFG).backend).toBe('llama-server');
    hooks.beginDispatchPlan(['local-1', 'grok-1', 'grok-2', 'claude-1', 'parked']);
    const first = hooks.route(item({ id: 'local-1', effort: 2 }), CFG);
    const second = hooks.route(item({ id: 'grok-1', effort: 2 }), CFG);
    expect(first.backend).toBe('llama-server');
    expect(fleetLaneOf(first.backend, CFG)).toBe('local');
    expect(second.backend).toBe('grok-cli');
    expect(fleetLaneOf(second.backend, CFG)).toBe('grok-cli');
    expect(hooks.route(item({ id: 'local-1', effort: 2 }), CFG)).toEqual(first);
    expect(hooks.route(item({ id: 'grok-2', effort: 2 }), CFG).backend).toBe('grok-cli');
    const fourth = hooks.route(item({ id: 'claude-1', effort: 2 }), CFG);
    expect(fourth.backend).toBe('claude');
    expect(fleetLaneOf(fourth.backend, CFG)).toBe('claude-cli');
    expect(hooks.route(item({ id: 'claude-1', effort: 2 }), CFG)).toEqual(fourth);
    // All four eligible turns are reserved: local=1, Grok=2, Claude=1.
    expect(hooks.route(item({ id: 'parked', effort: 2 }), CFG).hold?.kind).toBe('park');
  });

  it('holds overflow when the grant has no other producer lane', async () => {
    policy = policyFixture({ engines: ['local'] });
    const hooks = createLiveTickHooks({ deps: {
      ...h.deps,
      probeLocalRuntime: async () => ({ reachable: null, slots: 1, contextPerSlot: 65_536, detail: 'Ollama serializes Qwen3.8' }),
      legacyRoute: () => ({ backend: 'llama-server' as EngineId, tier: 'mid', reason: 'local runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    hooks.beginDispatchPlan(['first', 'second']);
    expect(hooks.route(item({ id: 'first', effort: 2 }), CFG).backend).toBe('llama-server');
    const overflow = hooks.route(item({ id: 'second', effort: 2 }), CFG);
    expect(overflow.hold?.kind).toBe('park');
    expect(overflow.seatDecision?.exclusions.some((x) => x.seatId === 'local')).toBe(true);
  });

  it('returns lane caps with presence applied and records the tick (ledger head included)', async () => {
    presenceNow = { present: true, reason: 'A Verse chat turn is running.', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.laneCaps).toEqual({ local: 2, 'grok-cli': 2, 'claude-cli': 1, codex: 0, 'devin-cli': 0 });
    const state = h.ticks.at(-1)!;
    expect(state).toMatchObject({ standing: { grantId: 'g-1', stageId: '2b', switch: 'autonomous' }, ledgerHead: { seq: 41 }, capabilityKind: 'resident-standing' });
    expect(state.lanes.find((lane) => lane.lane === 'claude-cli')?.slots).toBe(1);
    expect(h.audits.at(-1)).toMatch(/standing tick: lanes local=2 grok-cli=2 claude-cli=1 codex=0/);
  });

  it('clamps the budget over every seat the tick routes across (not only the ones the policy names)', async () => {
    const seen: string[][] = [];
    const hooks = createLiveTickHooks({ deps: { ...h.deps, clampBudget: (p, _standing, ids) => { seen.push([...ids]); return p; } } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(['claude', 'grok', 'local']);
  });

  it('routes through the SeatRouter once per item per tick and logs the shadow decision', async () => {
    const legacy = vi.fn(() => ({ backend: 'builtin' as EngineId, tier: 'local' as const, reason: 'legacy' }));
    const hooks = createLiveTickHooks({ deps: { ...h.deps, legacyRoute: legacy } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const first = hooks.route(item(), CFG);
    const second = hooks.route(item(), CFG);
    expect(first.backend).toBe('grok-cli');
    expect(first.seatDecision?.seatId).toBe('grok');
    expect(second).toEqual(first);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(h.shadowed).toBe(1);
  });
});

describe('seatAllows', () => {
  it('judges grok-cli on its seat — master\'s subscription reader has no Grok signal', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(hooks.seatAllows('grok-cli' as EngineId, { maxPercent: 90 }).allowed).toBe(true);
    expect(h.subscriptionCalls).toEqual([]);
  });

  it('checks only the explicitly bound Grok account while retaining legacy all-account refusal', async () => {
    const p = policyFixture();
    p.spend.seats.grok.enabled = false;
    p.spend.seats['grok-b'] = { seatId: 'grok-b', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] };
    const b = { ...grokSeat(), seatId: 'grok-b' };
    const hooks = createLiveTickHooks({ deps: { ...h.deps, standingPolicy: () => p,
      capacitySnapshot: () => ({ v: 1, publishedAt: NOW_ISO, seats: [grokSeat(), b] }) } });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    expect(hooks.seatAllows('grok-cli', { maxPercent: 90 }).allowed).toBe(false);
    expect(hooks.seatAllows('grok-cli', { maxPercent: 90, seatId: 'grok-b' }).allowed).toBe(true);
    expect(hooks.seatAllows('grok-cli', { maxPercent: 90, seatId: 'missing-account' }).allowed).toBe(false);
    expect(hooks.seatAllows('grok-cli', { maxPercent: 90, seatId: 'claude' }).allowed).toBe(false);
  });

  it.each(['grant', 'capacity', 'missing-capacity', 'duplicate-capacity', 'budget', 'config', 'stop-unreadable'] as const)(
    'refuses a bound Grok account when %s changes after the tick snapshot', async kind => {
      let changed = false;
      const b = { ...grokSeat(), seatId: 'grok-b' };
      const hooks = createLiveTickHooks({ deps: { ...h.deps,
        standingPolicy: () => {
          const p = policyFixture();
          p.spend.seats['grok-b'] = { seatId:'grok-b', enabled:!(changed && kind==='grant'), reserveFloorPercent:0, maxSessionWindowPercent:null, roles:['producer'] };
          return p;
        },
        capacitySnapshot: () => changed && kind==='missing-capacity' ? null : ({v:1,publishedAt:NOW_ISO,
          seats:[grokSeat(),{...b,...(changed && kind==='capacity' ? {windows:grokSeat(100).windows} : {})},
            ...(changed && kind==='duplicate-capacity' ? [b] : [])]}),
        loadBudget: () => ({...defaultBudgetPolicy(),...(changed && kind==='budget' ? {mode:'dormant' as const} : {})}),
        liveLeaderConfig: cfg => {
          if (changed && kind==='config') throw new Error('fixture unavailable');
          return cfg;
        },
        killActive: () => {
          if (changed && kind==='stop-unreadable') throw new Error('fixture unreadable');
          return false;
        },
      } });
      hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
      expect(hooks.seatAllows('grok-cli',{maxPercent:90,seatId:'grok-b'}).allowed).toBe(true);
      changed = true;
      expect(hooks.seatAllows('grok-cli',{maxPercent:90,seatId:'grok-b'}).allowed).toBe(false);
    },
  );

  function selectedClaudeHooks(other: 'disabled' | 'exhausted' = 'disabled') {
    const p = policyFixture({ engines: ['claude-cli'] });
    p.spend.seats.claude.enabled = other !== 'disabled';
    p.spend.seats['claude-b'] = { seatId: 'claude-b', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer'] };
    let clock = NOW;
    let stopped = false;
    let snapshot: ReturnType<LiveHooksDeps['capacitySnapshot']> = { v: 1, publishedAt: NOW_ISO,
      seats: [claudeSeat(other === 'exhausted' ? 100 : 20), { ...claudeSeat(), seatId: 'claude-b' }] };
    const budget = { ...defaultBudgetPolicy(), seats: {
      claude: { seatId: 'claude', enabled: true, reservePercent: 0 },
      'claude-b': { seatId: 'claude-b', enabled: true, reservePercent: 0 },
    } };
    const nativeGate = vi.fn<LiveHooksDeps['subscriptionAllows']>(() => ({ allowed: false, reason: 'ambient account exhausted' }));
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      standingPolicy: () => p, capacitySnapshot: () => snapshot, loadBudget: () => budget, now: () => clock, killActive: () => stopped,
      subscriptionAllows: nativeGate,
      legacyRoute: () => ({ backend: 'claude', tier: 'frontier', model: 'model-a', reason: 'explicit model' }),
    } });
    return { hooks, p, budget, nativeGate, snapshot: () => snapshot,
      setSnapshot: (value: typeof snapshot) => { snapshot = value; }, setClock: (value: number) => { clock = value; }, setStop: () => { stopped = true; } };
  }

  it.each(['disabled', 'exhausted'] as const)('admits the selected Claude account while the other account is %s', async other => {
    const r = selectedClaudeHooks(other);
    r.hooks.effectiveConfig(CFG); await r.hooks.beforeTick(hookCtx);
    const route = r.hooks.route(item(), CFG);
    expect(route).toMatchObject({ backend: 'claude', model: 'model-a', hold: null, seatDecision: { seatId: 'claude-b' } });
    expect(r.hooks.seatAllows('claude', { maxPercent: 90, seatId: 'claude-b', itemId: 'item-1', model: 'model-a' }).allowed).toBe(true);
    expect(r.nativeGate).not.toHaveBeenCalled();
    // The legacy unbound call keeps its conservative all-account gate.
    expect(r.hooks.seatAllows('claude', { maxPercent: 90 }).allowed).toBe(false);
    for (const seatId of ['missing-account', '', 'grok', 'claude']) {
      expect(r.hooks.seatAllows('claude', { maxPercent: 90, seatId, itemId: 'item-1', model: 'model-a' }).allowed).toBe(false);
    }
  });

  it('refuses a different healthy Claude account than the task route selected', async () => {
    const r = selectedClaudeHooks('exhausted');
    r.nativeGate.mockReturnValue({ allowed: true, reason: 'ambient account eligible' });
    r.snapshot()!.seats[0]!.windows = claudeSeat().windows;
    r.hooks.effectiveConfig(CFG); await r.hooks.beforeTick(hookCtx);
    const route = r.hooks.route(item(), CFG);
    expect(route.hold).toBeNull();
    const selected = route.seatDecision!.seatId!;
    expect(['claude', 'claude-b']).toContain(selected);
    const other = selected === 'claude' ? 'claude-b' : 'claude';
    expect(r.hooks.seatAllows('claude', { maxPercent: 90, seatId: other, itemId: 'item-1', model: route.model }).allowed).toBe(false);
  });

  it('admits the cached concrete default model for a manager without a model override', async () => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      legacyRoute: () => ({ backend: 'claude', tier: 'frontier', reason: 'native default' }),
    } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const task = item({ source: 'goal', tags: ['outcome-manager', 'difficulty:high'], effort: 5 });
    const route = hooks.route(task, CFG);
    expect(route).toMatchObject({ backend: 'claude', hold: null, model: resolveEngineSpec('claude', CFG)?.defaultModel });
    const selected = route.seatDecision!.seatId!;
    expect(hooks.seatAllows('claude', { maxPercent: 90, itemId: task.id, seatId: selected, model: route.model }).allowed).toBe(true);
    expect(hooks.seatAllows('claude', { maxPercent: 90, itemId: task.id, seatId: selected, model: 'different-model' }).allowed).toBe(false);
  });

  it.each(['grant', 'producer-role', 'capacity', 'unknown-usage', 'missing-capacity', 'duplicate-capacity', 'stale', 'budget', 'session-ceiling', 'weekly-ceiling', 'stop'] as const)(
    'rechecks the selected Claude account after %s changes', async kind => {
      const r = selectedClaudeHooks();
      r.hooks.effectiveConfig(CFG); await r.hooks.beforeTick(hookCtx);
      expect(r.hooks.seatAllows('claude', { maxPercent: 90, seatId: 'claude-b' }).allowed).toBe(true);
      const snapshot = r.snapshot()!;
      const selected = snapshot.seats.find(seat => seat.seatId === 'claude-b')!;
      if (kind === 'grant') r.p.spend.seats['claude-b']!.enabled = false;
      if (kind === 'producer-role') r.p.spend.seats['claude-b']!.roles = ['judge'];
      if (kind === 'capacity') selected.windows = claudeSeat(100).windows;
      if (kind === 'unknown-usage') selected.windows = [];
      if (kind === 'missing-capacity') r.setSnapshot(null);
      if (kind === 'duplicate-capacity') snapshot.seats.push({ ...selected });
      if (kind === 'stale') r.setClock(NOW + 86_400_000);
      if (kind === 'budget') r.budget.seats['claude-b']!.enabled = false;
      if (kind === 'session-ceiling') selected.windows[0]!.usedPercent = 90;
      if (kind === 'weekly-ceiling') selected.windows[1]!.usedPercent = 90;
      if (kind === 'stop') r.setStop();
      expect(r.hooks.seatAllows('claude', { maxPercent: 90, seatId: 'claude-b' }).allowed).toBe(false);
      expect(r.nativeGate).not.toHaveBeenCalled();
    },
  );

  it('still applies master\'s subscription gate to claude (it only tightens)', async () => {
    subscriptionAllowed = false;
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const verdict = hooks.seatAllows('claude' as EngineId, { maxPercent: 90 });
    expect(verdict).toEqual({ allowed: false, reason: 'claude window 95% used' });
    expect(h.subscriptionCalls).toEqual(['claude']);
  });

  it('refuses unavailable lanes while checking eligible Claude usage despite presence', async () => {
    presenceNow = { present: true, reason: 'here', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(hooks.seatAllows('grok' as EngineId, { maxPercent: 90 }).reason).toMatch(/not a fleet lane/);
    expect(hooks.seatAllows('ashlrcode' as EngineId, { maxPercent: 90 }).allowed).toBe(false);
    // Presence does not close an eligible native seat; its usage gate still runs.
    expect(hooks.seatAllows('claude' as EngineId, { maxPercent: 90 }).allowed).toBe(true);
    expect(h.subscriptionCalls).toEqual(['claude']);
    expect(hooks.seatAllows('codex' as EngineId, { maxPercent: 90 }).reason).toBe("The grant's current rollout stage does not include Codex.");
  });

  it('refuses a seat over its budget', async () => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps, capacitySnapshot: () => ({ v: 1, publishedAt: NOW_ISO, seats: [grokSeat(), claudeSeat(80)] }) } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(hooks.seatAllows('claude' as EngineId, { maxPercent: 90 }).reason).toMatch(/held back by the balanced budget/);
  });
});

describe('afterDispatch / afterLanding', () => {
  function outcome(over: Partial<DispatchOutcome> = {}): DispatchOutcome {
    return {
      itemId: 'item-1', repoPath: PATH, backend: 'grok-cli', model: 'grok-4.7', seatId: null, lane: 'grok-cli',
      dispatched: true, skipReason: null, runId: 'run-1', proposalId: 'p-1', spentUsd: 0, at: NOW_ISO, ...over,
    };
  }

  it('journals the dispatch with the seat decision behind it', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    hooks.route(item(), CFG);
    await hooks.afterDispatch(outcome());
    expect(h.journal.at(-1)).toMatchObject({ type: 'dispatch', repo: REPO, title: 'Fix the parser', source: 'todo', seatId: 'grok', proposalId: 'p-1', seatDecision: { seatId: 'grok' } });
  });

  it('records a held item in the tick state (the parked Gantt)', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const big = item({ id: 'big', tags: ['context:900000'] });
    expect(hooks.route(big, CFG).hold?.kind).toBe('split');
    await hooks.afterDispatch(outcome({ itemId: 'big', dispatched: false, skipReason: 'route-split', proposalId: null, runId: null }));
    expect(h.ticks.at(-1)!.held).toEqual([expect.objectContaining({ itemId: 'big', hold: expect.objectContaining({ kind: 'split' }) })]);
    expect(hooks.lastTickState()?.held).toHaveLength(1);
  });

  it('advances fleet tasks: produced, no-result, and parked on a dated hold', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const taskItem = 'fleet-task:11111111-1111-4111-8111-111111111111';
    await hooks.afterDispatch(outcome({ itemId: taskItem }));
    await hooks.afterDispatch(outcome({ itemId: taskItem, proposalId: null, skipReason: 'empty diff' }));
    expect(h.taskUpdates).toEqual([
      { taskId: '11111111-1111-4111-8111-111111111111', kind: 'produced' },
      { taskId: '11111111-1111-4111-8111-111111111111', kind: 'no-result' },
    ]);
  });

  it('journals a landing and registers it with the post-merge watch', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    const record = { id: 'L1', kind: 'merge', repo: REPO, prNumber: 12, proposalId: 'p-1', landedAt: NOW_ISO } as LandingRecord;
    await hooks.afterLanding(record);
    expect(h.landings).toEqual(['L1']);
    expect(h.journal.at(-1)).toMatchObject({ type: 'landing', landingId: 'L1', kind: 'merge' });
  });

  it('says out loud when a landing could not be registered', async () => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps, registerLanding: () => ({ ok: false, reason: 'store corrupt' }) } });
    await hooks.afterLanding({ id: 'L2', kind: 'merge', repo: REPO, prNumber: 3, proposalId: null, landedAt: NOW_ISO } as LandingRecord);
    expect(h.audits.at(-1)).toMatch(/could not be registered for its post-merge watch: store corrupt/);
  });
});

describe('fleet tasks and insights in the standing backlog', () => {
  it('merges dispatchable fleet tasks for enrolled repos into the backlog', async () => {
    tasks = [{
      v: 1, id: '22222222-2222-4222-8222-222222222222', repo: REPO, source: 'leader', title: 'Add parser tests', detail: 'd',
      difficulty: 'low', value: 5, requestedBy: 'leader', goalId: null, landingId: null, insightId: null, dedupeKey: null,
      status: 'queued', sizeBudget: { files: 4, lines: 150 }, attempts: 0, parkedUntil: null, createdAt: NOW_ISO, updatedAt: NOW_ISO,
    }];
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const scanned = item({ id: 'scanned', score: 0.5 });
    const merged = hooks.standingBacklog([scanned]);
    expect(merged.map((i) => i.id)).toEqual(['fleet-task:22222222-2222-4222-8222-222222222222', 'scanned']);
    expect(merged[0]!.repo).toBe(PATH);
  });

  it('ingests reasoning insights at most once per interval', async () => {
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    await hooks.beforeTick({ ...hookCtx, nowMs: NOW + 60_000 });
    expect(h.insightCalls).toBe(1);
  });
});

describe('createStandingRun', () => {
  const session = { sessionId: 's-1', grantId: 'g-1', openedAt: NOW_ISO };

  it('mints per tick and turns a refusal or a throw into a reason', () => {
    const cap = { kind: 'resident-standing', permitId: 'x' } as unknown as DaemonActivationCapability;
    const ok = createStandingRun({ session, mint: () => ({ ok: true, capability: cap, policy: policyFixture() }), hooks: createLiveTickHooks({ deps: h.deps }), judgeCredentials: null });
    expect(ok.mint()).toEqual({ ok: true, capability: cap });
    const refused = createStandingRun({ session, mint: () => ({ ok: false, reason: 'switch is off' }), hooks: createLiveTickHooks({ deps: h.deps }), judgeCredentials: null });
    expect(refused.mint()).toEqual({ ok: false, reason: 'switch is off' });
    const throws = createStandingRun({ session, mint: () => { throw new Error('not implemented'); }, hooks: createLiveTickHooks({ deps: h.deps }), judgeCredentials: null });
    expect(throws.mint()).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be minted/) });
  });

  it('reads the rows a tick appended and hands its landings to afterLanding', async () => {
    const landing = { v: 1, seq: 42, at: NOW_ISO, actor: 'daemon', grantId: 'g-1', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind: 'merge:landed', data: { id: 'L7', kind: 'merge', repo: REPO, prNumber: 9, proposalId: 'p-9', landedAt: NOW_ISO } } as unknown as LedgerEntry;
    const reads: unknown[] = [];
    const hooks = createLiveTickHooks({ deps: h.deps });
    const run = createStandingRun({
      session,
      mint: () => ({ ok: false, reason: 'x' }),
      hooks,
      judgeCredentials: null,
      deps: {
        ledgerHead: () => ({ seq: 41, hash: 'h', at: NOW_ISO }),
        readLedger: async (opts) => {
          reads.push(opts);
          return { entries: [landing, refusal('p-8', NOW_ISO)], head: null, chain: 'ok', brokenAtSeq: null, reason: null };
        },
      },
    });
    expect(run.headSeq()).toBe(41);
    const rows = await run.rowsSince(41);
    expect(reads[0]).toMatchObject({ sinceSeq: 42 });
    expect(await run.notifyLandings(rows)).toBe(1);
    expect(h.landings).toEqual(['L7']);
    expect(await run.rowsSince(null)).toEqual([]);
  });

  it('closes the session on the record exactly once, and never throws doing it', () => {
    const closes: string[] = [];
    const run = createStandingRun({
      session,
      mint: () => ({ ok: false, reason: 'x' }),
      close: (s) => { closes.push(s.sessionId); throw new Error('ledger is read-only'); },
      hooks: createLiveTickHooks({ deps: h.deps }),
      judgeCredentials: null,
    });
    expect(() => run.close()).not.toThrow();
    run.close();
    expect(closes).toEqual(['s-1']);
    // No close function (an older capability module): still a no-op, not a crash.
    expect(() => createStandingRun({ session, mint: () => ({ ok: false, reason: 'x' }), hooks: createLiveTickHooks({ deps: h.deps }) }).close()).not.toThrow();
  });
});

describe('probeOperatorPresence', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'u5-presence-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('sees a live Verse turn', async () => {
    mkdirSync(join(home, '.ashlr', 'verse'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'verse', 'running.json'), JSON.stringify({ v: 1, entries: [{ kind: 'turn', pid: process.pid }] }));
    expect(await probeOperatorPresence(Date.now(), { home })).toMatchObject({ present: true, reason: 'A Verse chat turn is running.' });
  });

  it('sees a Claude Code transcript under 15 minutes old, deep in a project', async () => {
    const dir = join(home, '.claude', 'projects', '-proj', 'session', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.jsonl'), '{}\n');
    expect((await probeOperatorPresence(Date.now(), { home })).present).toBe(true);
  });

  it('is absent (with the newest evidence time) when every transcript is older', async () => {
    const dir = join(home, '.claude', 'projects', '-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'old.jsonl');
    writeFileSync(file, '{}\n');
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    const presence = await probeOperatorPresence(Date.now(), { home });
    expect(presence.present).toBe(false);
    expect(presence.evidenceAt).not.toBeNull();
  });

  it('is absent when there is no Claude Code or Verse state at all', async () => {
    expect((await probeOperatorPresence(Date.now(), { home })).present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3b: a beforeTick that observes KILL revokes every ARMED host merge
// ---------------------------------------------------------------------------

describe('beforeTick — KILL revokes armed host merges (R3b)', () => {
  let killOn: boolean | 'throws';
  let revokeCalls: string[];
  let revokeResult: { revoked: number; failed: string[] } | 'throws';

  function killDeps(): Partial<LiveHooksDeps> {
    return {
      ...h.deps,
      killActive: () => {
        if (killOn === 'throws') throw new Error('KILL unreadable');
        return killOn;
      },
      revokeArmedMerges: async (reason) => {
        revokeCalls.push(reason);
        if (revokeResult === 'throws') throw new Error('merge state locked');
        return revokeResult;
      },
    };
  }

  beforeEach(() => {
    killOn = false;
    revokeCalls = [];
    revokeResult = { revoked: 2, failed: [] };
  });

  it('revokes on the first tick that sees KILL (policy null ⇒ production held), once per KILL episode', async () => {
    killOn = true;
    policy = null; // KILL makes the standing policy null
    const hooks = createLiveTickHooks({ deps: killDeps() });
    hooks.effectiveConfig(CFG);
    const first = await hooks.beforeTick(hookCtx);
    expect(first.holdProduction).toMatch(/standing grant is not in force/);
    expect(revokeCalls).toEqual(['KILL observed by the standing tick']);
    expect(h.audits).toContain('KILL observed: revoked 2 armed fleet merge(s)');
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toHaveLength(1); // a clean pass is not repeated while KILL stays on
    // KILL clears, then is armed again ⇒ a new episode revokes again.
    killOn = false;
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toHaveLength(1);
    killOn = true;
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toHaveLength(2);
  });

  it('never revokes while KILL is off', async () => {
    const hooks = createLiveTickHooks({ deps: killDeps() });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toEqual([]);
  });

  it('a revocation with failures (or one that throws) is retried on the next tick and audited as an error', async () => {
    killOn = true;
    policy = null;
    revokeResult = { revoked: 1, failed: ['ashlrai/binshield#4: stale receipt'] };
    const hooks = createLiveTickHooks({ deps: killDeps() });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(h.audits.some((a) => a.includes('1 could not be revoked') && a.includes('stale receipt'))).toBe(true);
    revokeResult = 'throws';
    await hooks.beforeTick(hookCtx);
    expect(h.audits.some((a) => a.includes('merge state locked'))).toBe(true);
    revokeResult = { revoked: 0, failed: [] };
    await hooks.beforeTick(hookCtx);
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toHaveLength(3); // retried twice, then clean ⇒ stops
  });

  it('an unreadable KILL counts as ON (lowering authority fails toward revoking)', async () => {
    killOn = 'throws';
    policy = null;
    const hooks = createLiveTickHooks({ deps: killDeps() });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(revokeCalls).toHaveLength(1);
  });

  it('runs in a dry-run tick too (revoking never touches GitHub)', async () => {
    killOn = true;
    policy = null;
    const hooks = createLiveTickHooks({ deps: killDeps() });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick({ ...hookCtx, dryRun: true });
    expect(revokeCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3.10 review regressions (F1-fleet): c5, c9, c15, reserve breaches.
// ---------------------------------------------------------------------------

function prOpened(number: number, at: string): LedgerEntry {
  return {
    v: 1, seq: number, at, actor: 'daemon', grantId: 'g-1', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64),
    kind: 'pr:opened',
    data: { v: 1, repo: REPO, number, proposalId: `p-${number}`, branch: `ashlr/fleet/p-${number}`, headSha: 'a'.repeat(40), kind: 'change', ownerLane: true, at },
  } as LedgerEntry;
}

describe('review c5 — open fleet PRs reconcile with GitHub', () => {
  it('three owner-lane PRs Mason merged on GitHub no longer pause the repo', async () => {
    ledgerChain = 'ok';
    const at = new Date(NOW - 60 * 60_000).toISOString();
    ledgerRows = [prOpened(1, at), prOpened(2, at), prOpened(3, at)];
    const asked: OpenFleetPrRef[][] = [];
    let observed: ObservedPrState = null;
    const deps = {
      ...h.deps,
      observeFleetPrs: async (refs: readonly OpenFleetPrRef[]) => {
        asked.push([...refs]);
        return new Map(refs.map((r) => [fleetPrKey(r.repo, r.number), observed] as const));
      },
    };
    // Unknown (and recent): still counted — fail closed.
    let hooks = createLiveTickHooks({ deps });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).pausedRepos).toContain(PATH);
    expect(h.ticks.at(-1)!.pausedRepos.find((p) => p.repo === REPO)?.reason).toMatch(/3 fleet PRs are already open/);
    expect(asked[0]!.map((r) => r.number)).toEqual([1, 2, 3]);

    // Observed merged on GitHub: the ledger still says open, the count does not.
    observed = 'merged';
    hooks = createLiveTickHooks({ deps });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).pausedRepos).not.toContain(PATH);
    expect(h.ticks.at(-1)!.openPrsByRepo).toEqual({});
  });

  it('an observation failure is unknown, never a crash or a silent zero', async () => {
    ledgerChain = 'ok';
    const at = new Date(NOW - 60 * 60_000).toISOString();
    ledgerRows = [prOpened(1, at), prOpened(2, at), prOpened(3, at)];
    const hooks = createLiveTickHooks({ deps: { ...h.deps, observeFleetPrs: async () => { throw new Error('GitHub 502'); } } });
    hooks.effectiveConfig(CFG);
    expect((await hooks.beforeTick(hookCtx)).pausedRepos).toContain(PATH);
  });
});

describe('review c9 — the Leader\'s class-B Codex enable passes the final seat gate', () => {
  const CODEX_CFG = { foundry: { allowedBackends: ['builtin', 'llama-server', 'grok-cli', 'claude', 'codex'] } } as unknown as AshlrConfig;
  function codexSeat(primary = 5, secondary = 10): SeatCapacity {
    return {
      seatId: 'codex', engine: 'codex', label: 'Codex', free: false,
      windows: [
        { id: 'codex_primary', usedPercent: primary, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(), resetDescription: null, limitReached: false },
        { id: 'codex_secondary', usedPercent: secondary, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(), resetDescription: null, limitReached: false },
      ],
      signedOut: false, reachable: null, contextWindow: 256_000, observedAt: NOW_ISO, spentTodayUsd: null,
    };
  }
  function codexWorld(seat: SeatCapacity) {
    const base = policyFixture();
    policy = {
      ...base,
      engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
      spend: { ...base.spend, seats: { ...base.spend.seats, codex: { seatId: 'codex', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer', 'judge'] } } },
    };
    // A stored legacy Off preference is distinct from the current balanced
    // default. The directive changes this tick while master's mock still reads Off.
    const calls: string[] = [];
    const deps = {
      ...h.deps,
      loadBudget: () => ({ ...defaultBudgetPolicy(), seats: {
        codex: { ...defaultSeatPolicy('balanced', 'codex', 'codex'), enabled: false },
      } }),
      capacitySnapshot: () => ({ v: 1 as const, publishedAt: NOW_ISO, seats: [grokSeat(), claudeSeat(), seat] }),
      directives: () => ({ v: 1 as const, updatedAt: NOW_ISO, routerTuning: null, grokLanes: null, codexEnabled: true }),
      subscriptionAllows: (engine: EngineId) => {
        calls.push(engine);
        return { allowed: false, reason: `${engine} seat codex is held back by the balanced budget: Autonomy is switched off for this seat.` };
      },
    };
    return { deps, calls };
  }

  it('allows Codex under the tick\'s directive-applied budget instead of refusing it every tick', async () => {
    const world = codexWorld(codexSeat());
    const hooks = createLiveTickHooks({ deps: world.deps });
    hooks.effectiveConfig(CODEX_CFG);
    await hooks.beforeTick({ ...hookCtx, cfg: CODEX_CFG });
    const verdict = hooks.seatAllows('codex' as EngineId, { maxPercent: 90 });
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ allowed: true });
    expect(verdict.reason).toMatch(/enabled by the Leader/);
    expect(world.calls).toEqual([]);
    // The router and the gate agree: work routed to Codex is not stranded.
    const routed = hooks.route(item({ id: 'hard', effort: 5 }), CODEX_CFG);
    if (routed.backend === ('codex' as EngineId)) expect(hooks.seatAllows(routed.backend, { maxPercent: 90 }).allowed).toBe(true);
  });

  it('pins the cached Codex hint to the exact routing source and refuses replacement before dispatch', async () => {
    const original = {...codexSeat(),accountHint:'a'.repeat(64)};
    const world = codexWorld(original);
    let snapshot = {v:1 as const,publishedAt:NOW_ISO,seats:[original]};
    const hooks = createLiveTickHooks({deps:{...world.deps,capacitySnapshot:()=>snapshot}});
    hooks.effectiveConfig(CODEX_CFG);await hooks.beforeTick({...hookCtx,cfg:CODEX_CFG});
    // Refresh the mutable capacity container without refreshing router.capacity.
    snapshot = {...snapshot,seats:[{...original,accountHint:'b'.repeat(64)}]};
    expect(hooks.seatAllows('codex',{maxPercent:90,itemId:'unrouted-refresh',seatId:'codex'}).allowed).toBe(false);
    const task = item({id:'original-source',effort:5});
    const route = hooks.route(task,CODEX_CFG);
    expect(route).toMatchObject({backend:'codex',hold:null,seatDecision:{seatId:'codex'},selectedAccountHint:'a'.repeat(64)});
    expect(hooks.route(task,CODEX_CFG).selectedAccountHint).toBe('a'.repeat(64));
    expect(hooks.seatAllows('codex',{maxPercent:90,itemId:task.id,seatId:'codex',model:route.model}).allowed).toBe(false);
    expect(world.calls).toEqual([]);
  });

  it('still applies the window ceiling to a directive-enabled Codex seat', async () => {
    const world = codexWorld(codexSeat(95, 10));
    const hooks = createLiveTickHooks({ deps: world.deps });
    hooks.effectiveConfig(CODEX_CFG);
    await hooks.beforeTick({ ...hookCtx, cfg: CODEX_CFG });
    const verdict = hooks.seatAllows('codex' as EngineId, { maxPercent: 90 });
    expect(verdict.allowed).toBe(false);
  });

  it('without the directive, Codex stays off (no lane slots)', async () => {
    const world = codexWorld(codexSeat());
    const hooks = createLiveTickHooks({ deps: { ...world.deps, directives: () => null } });
    hooks.effectiveConfig(CODEX_CFG);
    await hooks.beforeTick({ ...hookCtx, cfg: CODEX_CFG });
    expect(hooks.seatAllows('codex' as EngineId, { maxPercent: 90 }).allowed).toBe(false);
  });
});

describe('review c15 — best-of-N and experiments stay inside the lane caps', () => {
  function localTurns(plan: { run: boolean; candidates: { engine: string }[] } | null): number {
    return plan?.run ? plan.candidates.filter((c) => fleetLaneOf(c.engine, CFG) === 'local').length : 0;
  }

  it('pins the experiment slot constants to the runner', () => {
    expect(EXPERIMENT_LOCAL_SLOTS_IDLE).toBe(EXPERIMENT_SLOTS.idle);
    expect(EXPERIMENT_LOCAL_SLOTS_BUSY).toBe(EXPERIMENT_SLOTS.fleetBusy);
  });

  it.each([0, 1])('does not start an idle experiment when only %s measured slots are free', async (idleSlots) => {
    const runExperiment = vi.fn(async () => null);
    const hooks = createLiveTickHooks({ deps: { ...h.deps, runExperiment,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots: 4 - idleSlots, idleSlots, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([]);
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(idleSlots);
    expect(runExperiment).not.toHaveBeenCalled();
  });

  it('counts a newly started experiment after observation once, then does not double-count its observed occupancy', async () => {
    let busySlots = 2;
    const runExperiment = vi.fn(() => new Promise<string | null>(() => undefined));
    const hooks = createLiveTickHooks({ deps: { ...h.deps, runExperiment,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots, idleSlots: 4 - busySlots, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([]);
    // Two external requests were observed, then the new pair reserves two more.
    expect((await hooks.beforeTick(hookCtx)).laneCaps.local).toBe(0);
    expect(runExperiment).toHaveBeenCalledTimes(1);
    // Only that experiment remains in the next observation: two free, not zero.
    busySlots = 2;
    expect((await hooks.beforeTick({ ...hookCtx, nowMs: NOW + 1 })).laneCaps.local).toBe(2);
    expect(runExperiment).toHaveBeenCalledTimes(1);
    hooks.stopBackground('test complete');
  });

  it('keeps primary and BON reservations within the measured idle lane', async () => {
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      probeLocalRuntime: async () => ({ reachable: true, slots: 4, busySlots: 2, idleSlots: 2, observedAt: NOW_ISO, contextPerSlot: 65_536, detail: 'runtime' }),
    } });
    hooks.effectiveConfig(CFG);
    const hard = item({ id: 'measured-hard', effort: 5 });
    hooks.standingBacklog([hard]);
    const result = await hooks.beforeTick(hookCtx);
    const lane = hooks.lastTickState()!.lanes.find((l) => l.lane === 'local')!;
    expect(lane.slots).toBe(2);
    const route = hooks.route(hard, CFG);
    const plan = hooks.bestOfNPlan(hard, { maxPercent: 70 });
    const extraLocal = localTurns(plan) - (fleetLaneOf(route.backend, CFG) === 'local' ? 1 : 0);
    expect((result.laneCaps.local ?? 0) + extraLocal).toBeLessThanOrEqual(2);
    expect(hooks.bestOfNPlan(hard, { maxPercent: 70 })).toEqual(plan);
  });

  it('while Mason is present (local cap 2), pool slots + fan-out turns never exceed the cap', async () => {
    presenceNow = { present: true, reason: 'A Verse chat turn is running.', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const hard1 = item({ id: 'hard-1', effort: 5 });
    const hard2 = item({ id: 'hard-2', effort: 5 });
    hooks.standingBacklog([hard1, hard2]); // the previous tick's backlog: hard work is plausible
    const result = await hooks.beforeTick(hookCtx);
    const laneCap = h.ticks.at(-1)!.lanes.find((l) => l.lane === 'local')!.slots;
    expect(laneCap).toBe(2);
    const poolLocal = result.laneCaps.local ?? 0;
    expect(poolLocal).toBeLessThan(laneCap); // a slot is held back for fan-out
    let extraLocal = 0;
    const ran: boolean[] = [];
    for (const it of [hard1, hard2]) {
      const route = hooks.route(it, CFG);
      const plan = hooks.bestOfNPlan(it, { maxPercent: 70 });
      ran.push(plan?.run === true);
      const own = fleetLaneOf(route.backend, CFG) === 'local' && localTurns(plan) > 0 ? 1 : 0;
      extraLocal += localTurns(plan) - own;
      // Asking again for the same item never charges twice.
      expect(hooks.bestOfNPlan(it, { maxPercent: 70 })).toEqual(plan);
    }
    // The first hard item still fans out (Grok + a reserved local turn); the
    // second finds the reserve spent and runs as one attempt.
    expect(ran).toEqual([true, false]);
    expect(poolLocal + extraLocal).toBeLessThanOrEqual(laneCap);
  });

  it('with no plausible fan-out, the pool gets the whole lane and plans cannot spend beyond it', async () => {
    presenceNow = { present: true, reason: 'here', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([item({ id: 'easy', effort: 1 })]);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.laneCaps.local).toBe(2);
    const surprise = item({ id: 'surprise-hard', effort: 5 });
    const route = hooks.route(surprise, CFG);
    const plan = hooks.bestOfNPlan(surprise, { maxPercent: 70 });
    const own = fleetLaneOf(route.backend, CFG) === 'local' ? 1 : 0;
    expect(localTurns(plan)).toBeLessThanOrEqual(own);
  });

  it('a running experiment\'s slots come out of the local lane, and idle means no scanned backlog either', async () => {
    let now = NOW;
    const started: number[] = [];
    const deps = {
      ...h.deps,
      now: () => now,
      runExperiment: (opts: { fleetQueueDepth: () => number; signal: AbortSignal }) => {
        started.push(opts.fleetQueueDepth());
        return new Promise<string | null>(() => undefined); // keeps running
      },
    };
    // Unknown backlog is not idle.
    const cautious = createLiveTickHooks({ deps });
    cautious.effectiveConfig(CFG);
    await cautious.beforeTick(hookCtx);
    expect(started).toEqual([]);
    // A scanned backlog with work is not idle, even with no fleet tasks.
    cautious.standingBacklog([item({ id: 'scanned' })]);
    now += 10 * 60_000;
    await cautious.beforeTick({ ...hookCtx, nowMs: now });
    expect(started).toEqual([]);

    const hooks = createLiveTickHooks({ deps });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([]);
    await hooks.beforeTick({ ...hookCtx, nowMs: now });
    expect(started).toEqual([0]);
    const idleCaps = await hooks.beforeTick({ ...hookCtx, nowMs: now + 1 });
    expect(idleCaps.laneCaps.local).toBe(4 - EXPERIMENT_LOCAL_SLOTS_IDLE);
    // The reason is a plain sentence pluralised by the count — never "slot(s)".
    const localReason = (): string | null | undefined => hooks.lastTickState()?.lanes.find((l) => l.lane === 'local')?.capReason;
    expect(localReason()).toBe('A harness experiment is using 2 local slots.');
    hooks.standingBacklog([item({ id: 'arrived' })]);
    const busyCaps = await hooks.beforeTick({ ...hookCtx, nowMs: now + 2 });
    expect(busyCaps.laneCaps.local).toBe(4 - EXPERIMENT_LOCAL_SLOTS_BUSY);
    expect(localReason()).toBe('A harness experiment is using 1 local slot.');
    hooks.stopBackground('test over');
  });
});

describe('reserve breaches are checked once per standing tick, after dispatch', () => {
  const session = { sessionId: 's', grantId: 'g-1', openedAt: NOW_ISO };

  it('calls recordReserveBreaches with fresh capacity, the live policy and the seats this tick used', async () => {
    const seen: { capacity: unknown; policy: EffectivePolicy; now?: Date; usedSeatIds?: readonly string[] }[] = [];
    const hooks = createLiveTickHooks({ deps: { ...h.deps, recordReserveBreaches: async (input) => { seen.push(input); return 1; } } });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    hooks.route(item(), CFG);
    await hooks.afterDispatch({ itemId: 'item-1', repoPath: PATH, backend: 'grok-cli', model: null, seatId: 'grok', lane: 'grok-cli', dispatched: true, skipReason: null, runId: 'r', proposalId: 'p-1', spentUsd: 0, at: NOW_ISO });
    const run = createStandingRun({ session, mint: () => ({ ok: false, reason: 'x' }), hooks, judgeCredentials: null });
    expect(await run.notifyLedgerRows([])).toEqual({ landings: 0, verdicts: 0, reserveBreaches: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.policy.grantId).toBe('g-1');
    expect(seen[0]!.capacity).toMatchObject({ seats: expect.any(Array) });
    expect(seen[0]!.usedSeatIds).toEqual(['grok']);
    // Once per tick.
    expect((await run.notifyLedgerRows([])).reserveBreaches).toBe(0);
    expect(seen).toHaveLength(1);
    // Next tick: checked again.
    await hooks.beforeTick({ ...hookCtx, nowMs: NOW + 60_000 });
    await run.notifyLedgerRows([]);
    expect(seen).toHaveLength(2);
  });

  it('never runs for a dry run or without a tick context, and a failure is audited, not thrown', async () => {
    let calls = 0;
    const failing = createLiveTickHooks({ deps: { ...h.deps, recordReserveBreaches: async () => { calls += 1; throw new Error('ledger refused'); } } });
    expect(await failing.afterStandingTick()).toBe(0); // no context yet
    failing.effectiveConfig(CFG);
    await failing.beforeTick({ ...hookCtx, dryRun: true });
    expect(await failing.afterStandingTick()).toBe(0);
    expect(calls).toBe(0);
    await failing.beforeTick(hookCtx);
    expect(await failing.afterStandingTick()).toBe(0);
    expect(calls).toBe(1);
    expect(h.audits.some((a) => /reserve breaches could not be checked after the tick: ledger refused/.test(a))).toBe(true);
  });
});

describe('exhausted positive USD allowance maintenance', () => {
  it('keeps watch and intake available while holding unclassified Leader and experiment inference', async () => {
    const leader = vi.fn(async () => undefined);
    const experiment = vi.fn(async () => null);
    const watch = vi.fn(h.deps.advanceWatch!);
    const hooks = createLiveTickHooks({ deps: { ...h.deps, leaderTick: leader, runExperiment: experiment, advanceWatch: watch } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([]);
    const result = await hooks.beforeTick({ ...hookCtx, meteredUsdExhausted: true });
    expect(result.holdProduction).toBeNull();
    expect(watch).toHaveBeenCalledOnce();
    expect(h.insightCalls).toBe(1);
    expect(leader).not.toHaveBeenCalled();
    expect(experiment).not.toHaveBeenCalled();
    expect(h.ticks).toHaveLength(1);
    // Without the narrowing hint the established runners remain available.
    await hooks.beforeTick({ ...hookCtx, nowMs: NOW + 10 * 60_000 });
    expect(leader).toHaveBeenCalledOnce();
    expect(experiment).toHaveBeenCalledOnce();
    hooks.stopBackground('test finished');
  });

  it('aborts a running unclassified experiment without starting another one', async () => {
    let signal: AbortSignal | null = null;
    const experiment = vi.fn((opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<string | null>((resolve) => opts.signal.addEventListener('abort', () => resolve(null), { once: true }));
    });
    const hooks = createLiveTickHooks({ deps: { ...h.deps, runExperiment: experiment } });
    hooks.effectiveConfig(CFG);
    hooks.standingBacklog([]);
    await hooks.beforeTick(hookCtx);
    expect(signal).not.toBeNull();
    await hooks.beforeTick({ ...hookCtx, nowMs: NOW + 1, meteredUsdExhausted: true });
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(experiment).toHaveBeenCalledOnce();
    expect(h.audits.some((a) => a.includes('experiment inference cost is unproven'))).toBe(true);
  });
});

describe('beforeTick — the Devin fleet step (3.15)', () => {
  const DEVIN_CFG = { ...CFG, devin: { enabled: true, fleet: true } } as AshlrConfig;
  const devinCtx = { ...hookCtx, cfg: DEVIN_CFG };

  function withDevin(result: { outcome: 'launched' | 'held' | 'failed' } = { outcome: 'held' }) {
    const calls: Array<{ refresh: boolean }> = [];
    h.deps.launchDevinFleet = async (opts) => {
      calls.push(opts);
      return {
        outcome: result.outcome,
        code: result.outcome === 'launched' ? 'launched' : 'no-work',
        reason: 'r',
        repo: REPO,
        itemId: 'fix-1',
        taskId: result.outcome === 'launched' ? 'dv_20260927T0400_aaaaaa' : null,
      };
    };
    return calls;
  }

  it('runs once per tick when the lane is on and the fleet opted in; refreshes sessions at most every 2 minutes', async () => {
    const calls = withDevin({ outcome: 'launched' });
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(DEVIN_CFG);
    await hooks.beforeTick(devinCtx);
    await hooks.beforeTick(devinCtx);
    expect(calls).toEqual([{ refresh: true }, { refresh: false }]);
    expect(h.audits.some((a) => /Devin launched dv_20260927T0400_aaaaaa for backlog item fix-1/.test(a))).toBe(true);
  });

  it('preserves the independently authorized ACU launcher under exhausted daemon USD', async () => {
    const calls = withDevin();
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(DEVIN_CFG);
    await hooks.beforeTick({ ...devinCtx, meteredUsdExhausted: true });
    expect(calls).toEqual([{ refresh: true }]);
  });

  it('never runs on a dry run, under KILL, without a grant, or without the opt-in', async () => {
    const calls = withDevin();
    const run = async (cfg: AshlrConfig, ctx: typeof hookCtx, deps: Partial<typeof h.deps> = {}) => {
      const hooks = createLiveTickHooks({ deps: { ...h.deps, ...deps } });
      hooks.effectiveConfig(cfg);
      await hooks.beforeTick({ ...ctx, cfg });
    };
    await run(DEVIN_CFG, { ...hookCtx, dryRun: true });
    await run(DEVIN_CFG, hookCtx, { killActive: () => true });
    await run({ ...CFG, devin: { enabled: true, fleet: false } } as AshlrConfig, hookCtx);
    await run({ ...CFG, devin: { enabled: false, fleet: true } } as AshlrConfig, hookCtx);
    policy = null;
    await run(DEVIN_CFG, hookCtx);
    expect(calls).toEqual([]);
  });

  it('a held decision is not audited every tick (the launcher ledgers holds when they change)', async () => {
    withDevin({ outcome: 'held' });
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(DEVIN_CFG);
    await hooks.beforeTick(devinCtx);
    expect(h.audits.some((a) => /Devin/.test(a))).toBe(false);
  });
});


describe('fresh Grok preference and actual admitted dispatch capacity', () => {
  it('allows17 lanes on one admitted account only within the real configured pool/batch', async () => {
    h.deps.directives = () => ({ v: 1, updatedAt: NOW_ISO, routerTuning: null, grokLanes: 17, codexEnabled: null });
    h.deps.liveLeaderConfig = (cfg) => ({ ...cfg, foundry: { ...cfg.foundry, leaderPreferences: { maxGrokLanes: null } } });
    const hooks = createLiveTickHooks({ deps: h.deps });
    const cfg = { ...CFG, daemon: { ...CFG.daemon, perTickItems: 20, parallel: 17 } } as AshlrConfig;
    const before = await hooks.beforeTick({ ...hookCtx, cfg });
    expect(before.laneCaps['grok-cli']).toBe(17);
    h.deps.liveLeaderConfig = (cfg) => ({ ...cfg, daemon: { ...cfg.daemon, parallel: 5 }, foundry: { ...cfg.foundry, leaderPreferences: { maxGrokLanes: null } } });
    const narrowed = await createLiveTickHooks({ deps: h.deps }).beforeTick({ ...hookCtx, cfg });
    expect(narrowed.laneCaps['grok-cli']).toBe(5);
    const actualSmallPool = { ...cfg, daemon: { ...cfg.daemon, parallel: 3 } };
    const cannotRaiseInFlight = await createLiveTickHooks({ deps: h.deps }).beforeTick({ ...hookCtx, cfg: actualSmallPool });
    expect(cannotRaiseInFlight.laneCaps['grok-cli']).toBe(3);
    h.deps.liveLeaderConfig = () => { throw new Error('unreadable live configuration'); };
    const unavailable = await createLiveTickHooks({ deps: h.deps }).beforeTick({ ...hookCtx, cfg });
    expect(unavailable.laneCaps['grok-cli']).toBe(0);
  });
});

describe('reset-aware selected batch — real routing seam with injected advice', () => {
  function batchHarness(advice: NonNullable<LiveHooksDeps['resourceAdvice']>, extra: Partial<LiveHooksDeps> = {}) {
    policy = {...policy!,spend:{...policy!.spend,meteredUsdPerDay:1}};
    const views = [grokSeat(), { ...claudeSeat(), tier: 'fast' as const }];
    const recordScheduling = vi.fn<NonNullable<LiveHooksDeps['recordScheduling']>>(async () => undefined);
    const hooks = createLiveTickHooks({ deps: { ...h.deps,
      killActive: () => false,
      workHistory: async () => [], resourceAdvice: advice, recordScheduling,
      capacitySnapshot: () => ({v:1,publishedAt:NOW_ISO,seats:views}),
      ...extra,
    } });
    return { hooks,recordScheduling,views };
  }
  it('awaits one advice for an actual selected batch and changes the producer lane while preserving reservations', async () => {
    let finish!: (id:string|null) => void;
    const advice = vi.fn(async (candidates: Parameters<NonNullable<LiveHooksDeps['resourceAdvice']>>[0]) =>
      await new Promise<string|null>((resolve) => { finish = () => resolve(candidates.find((v) => v.seatId === 'claude')!.id); }));
    const {hooks,recordScheduling} = batchHarness(advice);
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    const selected=[item({id:'one'}),item({id:'two'})];
    expect(hooks.route(selected[0]!,CFG).backend).toBe('grok-cli');
    let completed=false;
    const preparation=hooks.prepareDispatchPlan!(selected,CFG).then((order)=>{completed=true;return order;});
    await vi.waitFor(()=>expect(advice).toHaveBeenCalledTimes(1));expect(completed).toBe(false);
    finish(null);const order=await preparation;
    expect(order).toEqual(['one','two']);expect(recordScheduling).toHaveBeenCalledTimes(1);
    hooks.beginDispatchPlan(selected.map(v=>v.id));
    const first=hooks.route(selected[0]!,CFG);const second=hooks.route(selected[1]!,CFG);
    expect(first.backend).toBe('claude');expect(first.seatDecision?.seatId).toBe('claude');
    expect(second.backend).toBe('grok-cli');expect(hooks.route(selected[0]!,CFG)).toEqual(first);
    expect(hooks.seatAllows('claude',{maxPercent:90}).allowed).toBe(true);
    expect(hooks.seatAllows('grok-cli',{maxPercent:90}).allowed).toBe(true);
  });
  it('reorders the real selected batch by duration-relative deadline proximity without advice or new tasks',async()=>{
    const claude={...claudeSeat(),tier:'fast' as const};claude.windows[1] = {...claude.windows[1]!,resetsAt:new Date(NOW+660000).toISOString(),
      resetProvenance:{kind:'weekly-deadline',at:new Date(NOW+660000).toISOString(),description:null,source:'claude-native-usage-report',plan:'max'}};
    const advice=vi.fn(async()=>null);
    const {hooks,recordScheduling}=batchHarness(advice,{
      capacitySnapshot:()=>({v:1,publishedAt:NOW_ISO,seats:[claude]}),
      legacyRoute:()=>({backend:'claude',tier:'frontier',model:'model-a',reason:'fixture model'}),
      workHistory:async()=>[
        {id:'short',engine:'claude',model:'model-a',seatId:null,taskKind:'todo',completed:true,durationMs:10000,tokens:1000},
        {id:'near',engine:'claude',model:'model-a',seatId:null,taskKind:'issue',completed:true,durationMs:600000,tokens:1000},
      ],
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    const selected=[item({id:'short',source:'todo'}),item({id:'near',source:'issue'})];
    const order=await hooks.prepareDispatchPlan!(selected,CFG);
    expect(order).toEqual(['near','short']);
    expect(advice).toHaveBeenCalledTimes(1);
    expect(recordScheduling).toHaveBeenCalledTimes(1);
    hooks.beginDispatchPlan(['near','short']);
    expect(hooks.route(selected[1]!,CFG)).toMatchObject({backend:'claude',hold:null,seatDecision:{seatId:'claude'}});
  });
  it.each(['throws','outside-set','null'] as const)('keeps deterministic useful work on advisory %s',async(kind)=>{
    const advice=vi.fn(async()=>{if(kind==='throws')throw new Error('offline');return kind==='outside-set'?'not-a-candidate':null;});
    const {hooks}=batchHarness(advice);hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    await hooks.prepareDispatchPlan!([item()],CFG);hooks.beginDispatchPlan(['item-1']);
    expect(hooks.route(item(),CFG).backend).toBe('grok-cli');expect(advice).toHaveBeenCalledTimes(1);
  });
  it('re-reads capacity after advice and cannot use a now-spent recommended account',async()=>{
    const {hooks,views}=batchHarness(async(candidates)=>{
      for(const window of views[1]!.windows)window.usedPercent=100;
      return candidates.find(v=>v.seatId==='claude')!.id;
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    await hooks.prepareDispatchPlan!([item()],CFG);hooks.beginDispatchPlan(['item-1']);
    expect(hooks.route(item(),CFG).backend).toBe('grok-cli');expect(hooks.seatAllows('claude',{maxPercent:90}).allowed).toBe(false);
  });
  it('holds a revoked grant after the optional wait, without recording display evidence as authority',async()=>{
    const {hooks}=batchHarness(async()=>{policy=null;return null;});
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    hooks.beginDispatchPlan(['item-1']);expect(hooks.route(item(),CFG).hold).not.toBeNull();
  });
  it.each(['grant','budget','config','capacity','stop'] as const)('revalidates %s after history I/O before any paid advisory',async(kind)=>{
    let changed=false;
    const advice=vi.fn(async()=>null);
    const {hooks,views}=batchHarness(advice,{
      workHistory:async()=>{changed=true;if(kind==='grant')policy=null;if(kind==='capacity')for(const s of views)for(const w of s.windows)w.usedPercent=100;return [];},
      loadBudget:()=>({...defaultBudgetPolicy(),...(changed && kind==='budget' ? {mode:'dormant' as const}: {})}),
      liveLeaderConfig:cfg=>changed && kind==='config' ? {...cfg,foundry:{...cfg.foundry,allowedBackends:['builtin']}} : cfg,
      killActive:()=>changed && kind==='stop',
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(advice).not.toHaveBeenCalled();
    if(kind==='capacity'){
      // Paid provider rows became spent; an admitted local producer remains
      // useful and must not be globally parked by advisory freshness checks.
      expect(hooks.route(item(),CFG)).toMatchObject({backend:'builtin',hold:null,seatDecision:{seatId:'local'}});
      expect(hooks.seatAllows('claude',{maxPercent:90}).allowed).toBe(false);
      expect(hooks.seatAllows('grok-cli',{maxPercent:90}).allowed).toBe(false);
    }else expect(hooks.route(item(),CFG).hold).not.toBeNull();
  });
  it.each([0,NaN] as const)('signed metered allowance %s skips paid advice but keeps admitted producers',async(allowance)=>{
    const advice=vi.fn(async()=>null);const {hooks,recordScheduling}=batchHarness(advice);
    policy={...policy!,spend:{...policy!.spend,meteredUsdPerDay:allowance}};
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(advice).not.toHaveBeenCalled();expect(hooks.route(item(),CFG).hold).toBeNull();
    expect(recordScheduling.mock.calls[0]?.[0]).toMatchObject({advisory:{state:'skipped',reason:'signed-metered-unavailable'}});
  });
  it.each(['budget','config','directives','stop'] as const)('does not dispatch an old plan after %s changes during advice',async(kind)=>{
    let changed=false;
    const {hooks,recordScheduling}=batchHarness(async()=>{changed=true;return null;},{
      loadBudget:()=>({...defaultBudgetPolicy(),...(changed && kind==='budget' ? {mode:'dormant' as const}: {})}),
      liveLeaderConfig:cfg=>changed && kind==='config' ? {...cfg,foundry:{...cfg.foundry,allowedBackends:['builtin']}} : cfg,
      directives:()=>changed && kind==='directives' ? ({grokLanes:1} as ReturnType<LiveHooksDeps['directives']>) : null,
      killActive:()=>changed && kind==='stop',
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(hooks.route(item(),CFG).hold).not.toBeNull();
    if(kind==='stop')expect(recordScheduling).toHaveBeenLastCalledWith(expect.objectContaining({advisory:expect.objectContaining({state:'skipped',reason:'stop-active'})}));
    else expect(recordScheduling).not.toHaveBeenCalled();
  });
  it.each(['engine','context','tier'] as const)('drops a same-ID recommendation after capacity %s changes',async(kind)=>{
    const {hooks,views,recordScheduling}=batchHarness(async(candidates)=>{
      const choice=candidates.find(v=>v.seatId==='claude')!.id;
      if(kind==='engine')views[1]!.engine='grok';
      if(kind==='context')views[1]!.contextWindow=10;
      if(kind==='tier')views[1]!.tier='frontier';
      return choice;
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(hooks.route(item(),CFG).backend).toBe('grok-cli');
    expect(recordScheduling.mock.calls[0]?.[0].accounts.find(v=>v.seatId==='claude')?.forecast).toBeNull();
  });
  it.each(['advice','cache'] as const)('rechecks actual same-seat selected model after %s await',async(when)=>{
    let model='model-a';
    const {hooks,recordScheduling}=batchHarness(async(candidates)=>{
      const id=candidates.find(v=>v.seatId==='claude')!.id;if(when==='advice')model='model-b';return id;
    },{
      legacyRoute:()=>({backend:'claude',tier:'frontier',model,reason:'fixture model'}),
      workHistory:async()=>[{id:'completed',engine:'claude',model:'model-a',seatId:null,taskKind:item().source,completed:true,durationMs:10000,tokens:1000}],
      ...(when==='cache' ? {recordScheduling:async()=>{model='model-b';}} : {}),
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(hooks.route(item(),CFG).backend).toBe('grok-cli');
    if(when==='advice')expect(recordScheduling.mock.calls[0]?.[0].accounts.find(v=>v.seatId==='claude')?.forecast).toBeNull();
  });
  it('checks current Stop/authority again after asynchronous display-cache publication',async()=>{
    let stopped=false;
    const {hooks}=batchHarness(async()=>null,{killActive:()=>stopped,recordScheduling:async()=>{stopped=true;}});
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);await hooks.prepareDispatchPlan!([item()],CFG);
    expect(hooks.route(item(),CFG).hold).not.toBeNull();
  });
  it.each(['before','history','advice','cache'] as const)('invalidates routing and seat admission on an unreadable Stop at %s',async(when)=>{
    let unreadable=false;
    const advice=vi.fn(async()=>{if(when==='advice')unreadable=true;return null;});
    const record=vi.fn<NonNullable<LiveHooksDeps['recordScheduling']>>(async()=>{if(when==='cache')unreadable=true;});
    const {hooks}=batchHarness(advice,{
      killActive:()=>{if(unreadable)throw new Error('Stop storage unreadable');return false;},
      workHistory:async()=>{if(when==='history')unreadable=true;return [];},recordScheduling:record,
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    expect(hooks.route(item(),CFG).hold).toBeNull();
    if(when==='before')unreadable=true;
    await expect(hooks.prepareDispatchPlan!([item()],CFG)).resolves.toBeUndefined();
    expect(hooks.route(item(),CFG).hold).not.toBeNull();
    expect(hooks.seatAllows('claude',{maxPercent:90}).allowed).toBe(false);
    expect(hooks.seatAllows('grok-cli',{maxPercent:90}).allowed).toBe(false);
    expect(advice).toHaveBeenCalledTimes(when==='before'||when==='history'?0:1);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({advisory:expect.objectContaining({state:'skipped',reason:'stop-active'})}));
  });
  it.each(['before','history','advice','cache'] as const)('records cancelled preparation and holds routing after abort at %s',async(when)=>{
    const abort=new AbortController();
    const advice=vi.fn(async()=>{if(when==='advice')abort.abort();return null;});
    const record=vi.fn<NonNullable<LiveHooksDeps['recordScheduling']>>(async()=>{if(when==='cache')abort.abort();});
    const {hooks}=batchHarness(advice,{
      workHistory:async()=>{if(when==='history')abort.abort();return [];},recordScheduling:record,
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    if(when==='before')abort.abort();
    await hooks.prepareDispatchPlan!([item()],CFG,abort.signal);
    expect(hooks.route(item(),CFG).hold).not.toBeNull();
    expect(hooks.seatAllows('claude',{maxPercent:90}).allowed).toBe(false);
    expect(advice).toHaveBeenCalledTimes(when==='before'||when==='history'?0:1);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({advisory:expect.objectContaining({state:'skipped',reason:'preparation-cancelled'})}));
  });
  it('ignores injected unlikely reset advice while ordering useful shorter work first',async()=>{
    const claude={...claudeSeat(),tier:'fast' as const};claude.windows[1]={...claude.windows[1]!,resetsAt:new Date(NOW+60000).toISOString(),
      resetProvenance:{kind:'weekly-deadline',at:new Date(NOW+60000).toISOString(),description:null,source:'claude-native-usage-report',plan:'max'}};
    const advice=vi.fn<NonNullable<LiveHooksDeps['resourceAdvice']>>(async(candidates)=>candidates.find(v=>v.taskId==='long')!.id);
    const {hooks,recordScheduling}=batchHarness(advice,{
      capacitySnapshot:()=>({v:1,publishedAt:NOW_ISO,seats:[claude]}),
      legacyRoute:()=>({backend:'claude',tier:'frontier',model:'model-a',reason:'fixture model'}),
      workHistory:async()=>[
        {id:'short-run',engine:'claude',model:'model-a',seatId:null,taskKind:'todo',completed:true,durationMs:10000,tokens:1000},
        {id:'long-run',engine:'claude',model:'model-a',seatId:null,taskKind:'issue',completed:true,durationMs:120000,tokens:1000},
      ],
    });
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    const selected=[item({id:'long',source:'issue'}),item({id:'short',source:'todo'})];
    expect(await hooks.prepareDispatchPlan!(selected,CFG)).toEqual(['short','long']);
    expect(advice.mock.calls[0]![0].find(v=>v.taskId==='long')).toMatchObject({durationP25Ms:120000,durationP75Ms:120000});
    expect(recordScheduling).toHaveBeenLastCalledWith(expect.objectContaining({advisory:expect.objectContaining({state:'fallback',reason:'no-eligible-choice'})}));
    hooks.beginDispatchPlan(['short','long']);
    expect(hooks.route(selected[1]!,CFG)).toMatchObject({backend:'claude',hold:null});
  });
  it('does not call the paid advisory after exhausted USD; verified producer work still routes',async()=>{
    const advice=vi.fn(async()=>null);const {hooks}=batchHarness(advice);
    hooks.effectiveConfig(CFG);await hooks.beforeTick({...hookCtx,meteredUsdExhausted:true});
    await hooks.prepareDispatchPlan!([item()],CFG);hooks.beginDispatchPlan(['item-1']);
    expect(advice).not.toHaveBeenCalled();expect(hooks.route(item(),CFG).hold).toBeNull();
  });
});

describe('task-scoped reset reserve reaches actual dispatch admission',()=>{
  function resetHarness(executionAccountMatches:LiveHooksDeps['executionAccountMatches']|null=()=>true) {
    let clock=NOW; let model='model-a';
    let budget={...defaultBudgetPolicy(),resetSpending:{enabled:true},seats:{claude:{seatId:'claude',enabled:true,reservePercent:40,maxSessionWindowPercent:70}}};
    const hint='a'.repeat(64);
    const capacity={...claudeSeat(),accountHint:hint,subscriptionOnlyBoundary:{source:'claude-native-extra-usage' as const,accountHint:hint,observedAt:NOW_ISO,expiresAt:new Date(NOW+60000).toISOString(),creditsEnabled:false as const}};
    capacity.windows[1]={...capacity.windows[1]!,usedPercent:65,resetsAt:new Date(NOW+45000).toISOString(),
      resetProvenance:{kind:'weekly-deadline',at:new Date(NOW+45000).toISOString(),description:null,source:'claude-native-usage-report',plan:'max'}};
    policy={...policy!,engines:['claude-cli']};
    const nativeGate=vi.fn<LiveHooksDeps['subscriptionAllows']>(()=>({allowed:true,reason:'fixture current native throttle'}));
    const advice=vi.fn(async()=>null);
    const hooks=createLiveTickHooks({deps:{...h.deps,executionAccountMatches:executionAccountMatches??undefined,now:()=>clock,loadBudget:()=>budget,
      capacitySnapshot:()=>({v:1,publishedAt:NOW_ISO,seats:[capacity]}),
      legacyRoute:()=>({backend:'claude',tier:'frontier',model,reason:'explicit fixture model'}),
      subscriptionAllows:nativeGate,resourceAdvice:advice,
      workHistory:async()=>[{id:'completed',engine:'claude',model:'model-a',seatId:null,taskKind:'todo',completed:true,durationMs:30000,tokens:1000}],
    }});
    return {hooks,capacity,nativeGate,advice,budget,setClock:(value:number)=>{clock=value;},setModel:(value:string)=>{model=value;},setOff:()=>{budget={...budget,resetSpending:{enabled:false}};}};
  }
  async function prepare(r:ReturnType<typeof resetHarness>) {
    r.hooks.effectiveConfig(CFG);await r.hooks.beforeTick(hookCtx);
    await r.hooks.prepareDispatchPlan!([item()],CFG);r.hooks.beginDispatchPlan(['item-1']);return r.hooks.route(item(),CFG);
  }
  it('admits eligible work above the saved reserve and passes the derived policy through the native gate',async()=>{
    const r=resetHarness();expect(await prepare(r)).toMatchObject({backend:'claude',hold:null,model:'model-a'});
    expect(r.hooks.seatAllows('claude',{maxPercent:90,itemId:'item-1',model:'model-a'}).allowed).toBe(true);
    expect(r.nativeGate).toHaveBeenLastCalledWith('claude',expect.objectContaining({budget:expect.objectContaining({seats:expect.objectContaining({claude:expect.objectContaining({reservePercent:20})})})}));
    expect(r.budget.seats.claude.reservePercent).toBe(40);
    expect(r.hooks.nextResetWake?.(NOW)).toBe(NOW+15000);
  });
  it.each(['off','account','credits','expired','reset','model','grant'] as const)('revalidates %s before every subsequent provider contact',async(kind)=>{
    const r=resetHarness();expect((await prepare(r)).hold).toBeNull();
    if(kind==='off')r.setOff();
    if(kind==='account')r.capacity.accountHint='b'.repeat(64);
    if(kind==='credits')delete (r.capacity as SeatCapacity).subscriptionOnlyBoundary;
    if(kind==='expired')r.setClock(NOW+60000);
    if(kind==='reset')r.setClock(NOW+45001);
    if(kind==='model')r.setModel('model-b');
    if(kind==='grant')policy=null;
    expect(r.hooks.seatAllows('claude',{maxPercent:90,itemId:'item-1',model:'model-a'}).allowed).toBe(false);
    expect(r.nativeGate).not.toHaveBeenCalled();
    expect(r.hooks.nextResetWake?.(kind==='expired'?NOW+60000:kind==='reset'?NOW+45001:NOW)).toBeNull();
  });
  it('keeps an actual unbound native producer at the saved reserve, regardless of collector billing proof',async()=>{
    const r=resetHarness(null);
    expect((await prepare(r)).hold).not.toBeNull();
    expect(r.nativeGate).not.toHaveBeenCalled();
    expect(r.hooks.nextResetWake?.(NOW)).toBeNull();
  });
  it('keeps the signed floor and every other native account binding',async()=>{
    const r=resetHarness();policy!.spend.seats.claude!.reserveFloorPercent=40;
    expect((await prepare(r)).hold).not.toBeNull();
    expect(r.nativeGate).not.toHaveBeenCalled();
  });
});


describe('independent local task admission',()=>{
  it('keeps local task contacts available without querying unavailable paid telemetry',async()=>{
    const capacity=vi.fn<LiveHooksDeps['capacitySnapshot']>(()=>null);
    const hooks=createLiveTickHooks({deps:{...h.deps,capacitySnapshot:capacity,workHistory:async()=>[]}});
    hooks.effectiveConfig(CFG);await hooks.beforeTick(hookCtx);
    await hooks.prepareDispatchPlan!([item()],CFG);hooks.beginDispatchPlan(['item-1']);
    const route=hooks.route(item(),CFG);expect(route.hold).toBeNull();
    expect(fleetLaneOf(route.backend,CFG)).toBe('local');
    capacity.mockClear();
    expect(hooks.seatAllows(route.backend,{maxPercent:90,itemId:'item-1',model:route.model??null}).allowed).toBe(true);
    expect(capacity).not.toHaveBeenCalled();
  });
});
