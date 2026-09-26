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
  probeOperatorPresence,
  type LiveHooksDeps,
} from '../src/core/fleet/tick-hooks-live.js';
import { EXPERIMENT_SLOTS } from '../src/core/learn/experiments.js';
import { fleetLaneOf } from '../src/core/fleet/dispatch-router.js';
import { fleetPrKey, type ObservedPrState, type OpenFleetPrRef } from '../src/core/fleet/backpressure.js';
import { emptyBackpressureState } from '../src/core/fleet/backpressure.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
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
  it('returns lane caps with presence applied and records the tick (ledger head included)', async () => {
    presenceNow = { present: true, reason: 'A Verse chat turn is running.', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    const result = await hooks.beforeTick(hookCtx);
    expect(result.laneCaps).toEqual({ local: 2, 'grok-cli': 2, 'claude-cli': 0, codex: 0 });
    const state = h.ticks.at(-1)!;
    expect(state).toMatchObject({ standing: { grantId: 'g-1', stageId: '2b', switch: 'autonomous' }, ledgerHead: { seq: 41 }, capabilityKind: 'resident-standing' });
    expect(h.audits.at(-1)).toMatch(/standing tick: lanes local=2 grok-cli=2 claude-cli=0 codex=0/);
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

  it('still applies master\'s subscription gate to claude (it only tightens)', async () => {
    subscriptionAllowed = false;
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    const verdict = hooks.seatAllows('claude' as EngineId, { maxPercent: 90 });
    expect(verdict).toEqual({ allowed: false, reason: 'claude window 95% used' });
    expect(h.subscriptionCalls).toEqual(['claude']);
  });

  it('refuses engines that are not fleet lanes and lanes that are closed', async () => {
    presenceNow = { present: true, reason: 'here', evidenceAt: NOW_ISO };
    const hooks = createLiveTickHooks({ deps: h.deps });
    hooks.effectiveConfig(CFG);
    await hooks.beforeTick(hookCtx);
    expect(hooks.seatAllows('grok' as EngineId, { maxPercent: 90 }).reason).toMatch(/not a fleet lane/);
    expect(hooks.seatAllows('ashlrcode' as EngineId, { maxPercent: 90 }).allowed).toBe(false);
    // Presence closes the Claude producer slice.
    expect(hooks.seatAllows('claude' as EngineId, { maxPercent: 90 }).reason).toMatch(/held for your own session/);
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
    // Master's gate re-reads Mason's STORED budget, where Codex is off in every
    // mode — exactly what the real subscriptionAllows answers.
    const calls: string[] = [];
    const deps = {
      ...h.deps,
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
    expect(verdict).toMatchObject({ allowed: true });
    expect(verdict.reason).toMatch(/enabled by the Leader/);
    expect(world.calls).toEqual([]);
    // The router and the gate agree: work routed to Codex is not stranded.
    const routed = hooks.route(item({ id: 'hard', effort: 5 }), CODEX_CFG);
    if (routed.backend === ('codex' as EngineId)) expect(hooks.seatAllows(routed.backend, { maxPercent: 90 }).allowed).toBe(true);
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
