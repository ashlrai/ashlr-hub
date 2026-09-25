/**
 * V3.10 Tracks B+C integration (INT1 — autonomy wiring in the fleet loop).
 *
 * A standing-session fixture tick that exercises every cross-unit hook the
 * live TickHooks now drive, each through an injected fake (no seat, no
 * GitHub, no model, no git, no custody helper):
 *
 *  U6    prepareMirrorsForTick → a stale mirror pauses its repo; a failed
 *        preparation holds production; enrollment is reconciled only when
 *        its plan is non-empty.
 *  U4    expired holds are swept (throttled); an unreadable hold store and a
 *        watch pass that cannot run still fail closed.
 *  B-U1  a ledger head that throws (broken chain) holds production; a mint
 *        refused as "unknown or closed standing session" reopens once; the
 *        grant's engines filter allowedBackends.
 *  B-U8  leaderTick runs before the directives are read, is bounded, and the
 *        directives are clamped by the grant.
 *  B-U9  the canary is checked every tick, the producer prompt reaches
 *        dispatch, G3 verdicts are credited to the version the dispatch ran
 *        with, experiments run only in idle / overnight windows and stop when
 *        authority is withdrawn.
 *  U7    best-of-N is planned over this tick's lanes (threshold from the
 *        routing weights), low-difficulty grok-cli work takes the fast model,
 *        and the restricted-judge credential source carries the claude-a
 *        token only under a standing policy.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createLiveTickHooks,
  createStandingRun,
  grantAllowedBackends,
  judgeCredentialSourceFor,
  UNKNOWN_SESSION_REASON,
  type JudgeCredentialWiring,
  type LiveHooksDeps,
} from '../src/core/fleet/tick-hooks-live.js';
import {
  clampLeaderDirectives,
  grokFastModel,
  meetsBonThreshold,
  resolveRoutingWeights,
} from '../src/core/fleet/dispatch-router.js';
import { emptyBackpressureState } from '../src/core/fleet/backpressure.js';
import { BASELINE_HARNESS_CONFIG } from '../src/core/learn/harness-registry.js';
import { GROK_CLI_FAST_MODEL } from '../src/core/run/model-catalog.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { EffectivePolicy, LedgerEntry } from '../src/core/authority/types.js';
import type { FleetTask, RepoHold } from '../src/core/fleet/fleet-types.js';
import type { FleetJournalRecord } from '../src/core/fleet/fleet-runtime-journal.js';
import type { LeaderDirectivesV1 } from '../src/core/vision/leader-types.js';
import type { HarnessConfigV1 } from '../src/core/learn/harness-types.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';
import type { DaemonActivationCapability } from '../src/core/daemon/activation-permit.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const REPO = 'ashlrai/binshield';
const PATH = '/tmp/mirrors/ashlrai__binshield';
const STALE_MIRROR = '/tmp/mirrors/ashlrai__stale';
const CFG = {
  foundry: {
    allowedBackends: ['builtin', 'llama-server', 'grok-cli', 'claude', 'nim', 'kimi', 'grok', 'ashlrcode'],
    fabric: { gateway: true, concurrentDispatch: true },
  },
} as unknown as AshlrConfig;

function policyFixture(over: Partial<EffectivePolicy> = {}): EffectivePolicy {
  const seat = (seatId: string, roles: ('producer' | 'judge' | 'leader')[]) => ({ seatId, enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles });
  return {
    v: 1, grantId: 'g-1', grantSeq: 1, keyId: 'k', issuedAt: NOW_ISO, expiresAt: new Date(NOW + 86_400_000).toISOString(),
    switch: 'autonomous',
    rollout: { stageId: '2b', stageIndex: 2, stageCount: 5, enteredAt: NOW_ISO },
    repos: [
      { nameWithOwner: REPO, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null },
      { nameWithOwner: 'ashlrai/stale', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null },
    ],
    merge: { maxFiles: 4, maxLines: 150, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats: { grok: seat('grok', ['producer', 'judge']), claude: seat('claude', ['judge']), local: seat('local', ['producer']) } },
    engines: ['local', 'grok-cli', 'claude-cli'],
    leader: { classes: ['A'], vetoMinutes: 30 },
    conductorGoals: false,
    computedAt: NOW_ISO,
    ...over,
  };
}

function grokSeat(): SeatCapacity {
  return {
    seatId: 'grok', engine: 'grok', label: 'Grok', free: false,
    windows: [{ id: 'grok_billing', usedPercent: 10, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(), resetDescription: null, limitReached: false }],
    signedOut: false, reachable: null, contextWindow: 256_000, observedAt: NOW_ISO, spentTodayUsd: null,
  };
}

function gate(proposalId: string, verdict: 'pass' | 'refuse', gateId: 'G3' | 'G6' = 'G3', headSha = 'a'.repeat(40)): LedgerEntry {
  return {
    v: 1, seq: 0, at: NOW_ISO, actor: 'daemon', grantId: 'g-1', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64),
    kind: 'gate:result',
    data: { v: 1, gate: gateId, proposalId, repo: REPO, headSha, verdict, code: verdict === 'pass' ? 'ok' : 'verify-failed', reason: 'r', at: NOW_ISO, digest: 'd'.repeat(64) },
  } as LedgerEntry;
}

interface World {
  policy: EffectivePolicy | null;
  holds: RepoHold[];
  holdsThrow: boolean;
  headThrows: boolean;
  mirrors: { ready: never[]; failed: { nameWithOwner: string; path: string; reason: string }[]; pausedRepoPaths: string[] } | 'throw';
  enrollmentChanged: boolean;
  enrolled: string[];
  directives: LeaderDirectivesV1 | null;
  leaderNeverResolves: boolean;
  harnessVersion: string | null;
  harnessConfig: HarnessConfigV1;
  harnessThrows: boolean;
  waiting: number | null;
  overnight: boolean;
  tasks: FleetTask[];
  journal: FleetJournalRecord[];
}

interface Calls {
  order: string[];
  sweeps: number;
  reconciles: number;
  canary: number;
  outcomes: { passed: boolean; versionId: string | null }[];
  experiments: { depth: () => number; signal: AbortSignal }[];
  audits: string[];
  journal: FleetJournalRecord[];
}

let w: World;
let calls: Calls;

function deps(): Partial<LiveHooksDeps> {
  return {
    now: () => NOW,
    standingPolicy: () => w.policy,
    applyOverlay: (cfg) => cfg,
    clampBudget: (p) => p,
    loadBudget: () => defaultBudgetPolicy(),
    capacitySnapshot: () => ({ v: 1, publishedAt: NOW_ISO, seats: [grokSeat()] }),
    probeLocalRuntime: async () => ({ reachable: true, slots: 4, contextPerSlot: 65_536, detail: 'llama-server up with 4 slot(s)' }),
    presence: async () => ({ present: false, reason: 'Nobody is at the keyboard.', evidenceAt: null }),
    directives: () => {
      calls.order.push('directives');
      return w.directives;
    },
    listHolds: () => {
      calls.order.push('holds');
      if (w.holdsThrow) throw new Error('hold store corrupt');
      return w.holds;
    },
    setHold: () => ({ ok: true, reason: null, before: null, after: null }),
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    ledgerHead: () => {
      if (w.headThrows) throw new Error('ledger chain broken at #7');
      return { seq: 3, hash: 'h'.repeat(64), at: NOW_ISO };
    },
    listEnrolled: () => [...w.enrolled],
    repoIdentity: (path) => (path === PATH ? REPO : path === STALE_MIRROR ? 'ashlrai/stale' : null),
    waitingVerify: async () => w.waiting,
    // Never GitHub / the real ledger from a unit test: unknown PR state, no breach rows.
    observeFleetPrs: async () => new Map(),
    recordReserveBreaches: async () => 0,
    installed: () => true,
    tierOf: (engine) => {
      const id: string = engine;
      return id === 'builtin' ? 'local' : id === 'llama-server' ? 'mid' : 'frontier';
    },
    subscriptionAllows: () => ({ allowed: true, reason: 'ok' }),
    isSubscriptionEngine: (engine) => {
      const id: string = engine;
      return id === 'claude' || id === 'codex';
    },
    legacyRoute: () => ({ backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy' }),
    localFleetEngine: () => 'llama-server' as EngineId,
    readTasks: () => ({ ok: true, tasks: w.tasks }),
    releaseTasks: () => 0,
    recordTask: () => null,
    enqueueInsights: () => 0,
    insights: async () => [],
    advanceWatch: async () => ({ ok: true, reason: null, open: 0, finalized: [], reverted: [], escalations: [], softKilled: false, suiteRuns: 0, discovered: 0 }),
    registerLanding: () => ({ ok: true, registered: true }),
    writeTick: () => true,
    appendJournal: (record) => {
      calls.journal.push(record);
      return true;
    },
    readJournalSince: async () => w.journal,
    loadBackpressure: () => emptyBackpressureState(),
    saveBackpressure: () => undefined,
    shadow: () => true,
    audit: (entry) => {
      calls.audits.push(entry.summary);
    },
    prepareMirrors: async () => {
      calls.order.push('mirrors');
      if (w.mirrors === 'throw') throw new Error('git fetch timed out');
      return w.mirrors;
    },
    reconcileEnrollment: async () => {
      calls.order.push('enrollment');
      calls.reconciles += 1;
      return w.enrollmentChanged
        ? { changed: true, enrolled: [PATH], unenrolled: ['/Users/mason/code/binshield'], errors: [] }
        : { changed: false, enrolled: [], unenrolled: [], errors: [] };
    },
    sweepHolds: () => {
      calls.sweeps += 1;
      return { swept: 1, error: null };
    },
    leaderTick: async () => {
      calls.order.push('leader');
      if (w.leaderNeverResolves) await new Promise<void>(() => undefined);
    },
    harness: () => {
      calls.order.push('harness');
      if (w.harnessThrows) throw new Error('harness store unreadable');
      return { versionId: w.harnessVersion, config: w.harnessConfig };
    },
    checkCanary: () => {
      calls.order.push('canary');
      calls.canary += 1;
    },
    recordHarnessOutcome: (input) => {
      calls.outcomes.push({ passed: input.passed, versionId: input.versionId });
      return true;
    },
    runExperiment: async (opts) => {
      calls.experiments.push({ depth: opts.fleetQueueDepth, signal: opts.signal });
      await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
      return 'experiment e-1 finished: cancelled';
    },
    overnightActive: () => w.overnight,
  };
}

const ctx = { nowMs: NOW, cfg: CFG, dryRun: false, capabilityKind: 'resident-standing' as const };

function item(over: Partial<WorkItem> = {}): WorkItem {
  return { id: 'item-1', repo: PATH, source: 'todo', title: 'Fix the parser', detail: 'd', value: 3, effort: 3, score: 1, tags: [], ts: NOW_ISO, ...over };
}

function withPrompt(producer: string): HarnessConfigV1 {
  return { ...BASELINE_HARNESS_CONFIG, prompts: { producer } } as HarnessConfigV1;
}

beforeEach(() => {
  w = {
    policy: policyFixture(),
    holds: [],
    holdsThrow: false,
    headThrows: false,
    mirrors: { ready: [], failed: [], pausedRepoPaths: [] },
    enrollmentChanged: false,
    enrolled: [PATH],
    directives: null,
    leaderNeverResolves: false,
    harnessVersion: null,
    harnessConfig: BASELINE_HARNESS_CONFIG,
    harnessThrows: false,
    waiting: 3,
    overnight: false,
    tasks: [],
    journal: [],
  };
  calls = { order: [], sweeps: 0, reconciles: 0, canary: 0, outcomes: [], experiments: [], audits: [], journal: [] };
});

describe('U6 — mirrors and enrollment in beforeTick', () => {
  it('pauses a repo whose mirror is not current (by path, even before it is enrolled)', async () => {
    w.mirrors = { ready: [], failed: [{ nameWithOwner: 'ashlrai/stale', path: STALE_MIRROR, reason: 'fetch failed' }], pausedRepoPaths: [STALE_MIRROR] };
    const hooks = createLiveTickHooks({ deps: deps() });
    const result = await hooks.beforeTick(ctx);
    expect(result.holdProduction).toBeNull();
    expect(result.pausedRepos).toContain(STALE_MIRROR);
    expect(result.pausedRepos).not.toContain(PATH);
    expect(hooks.lastTickState()?.pausedRepos).toContainEqual({ repo: 'ashlrai/stale', reason: 'Its mirror is not current (fetch failed).' });
    // Mirrors are prepared before anything reads holds or directives.
    expect(calls.order.indexOf('mirrors')).toBeLessThan(calls.order.indexOf('holds'));
  });

  it('holds production when the mirrors cannot be prepared at all', async () => {
    w.mirrors = 'throw';
    const result = await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(result.holdProduction).toMatch(/fleet mirrors could not be prepared \(git fetch timed out\)/);
    expect(calls.reconciles).toBe(0);
  });

  it('reconciles enrollment every tick, re-reads it when it changed, and says so', async () => {
    w.enrollmentChanged = true;
    await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(calls.reconciles).toBe(1);
    expect(calls.audits.some((a) => /enrollment reconciled to the grant: \+1 −1/.test(a))).toBe(true);
  });

  it('touches no mirror and no enrollment on a dry run', async () => {
    await createLiveTickHooks({ deps: deps() }).beforeTick({ ...ctx, dryRun: true });
    expect(calls.order).not.toContain('mirrors');
    expect(calls.reconciles).toBe(0);
  });
});

describe('U4 — holds', () => {
  it('sweeps expired holds at most every 10 minutes', async () => {
    let now = NOW;
    const hooks = createLiveTickHooks({ deps: { ...deps(), now: () => now } });
    await hooks.beforeTick({ ...ctx, nowMs: now });
    now += 60_000;
    await hooks.beforeTick({ ...ctx, nowMs: now });
    expect(calls.sweeps).toBe(1);
    now += 10 * 60_000;
    await hooks.beforeTick({ ...ctx, nowMs: now });
    expect(calls.sweeps).toBe(2);
  });

  it('fails closed when the hold store cannot be read (every enrolled repo paused)', async () => {
    w.holdsThrow = true;
    const result = await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(result.holdProduction).toMatch(/Repo holds could not be read/);
    expect(result.pausedRepos).toEqual([PATH]);
  });
});

describe('B-U1 — ledger head, engines, session reopen', () => {
  it('holds production when the ledger head throws (a broken chain)', async () => {
    w.headThrows = true;
    const result = await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(result.holdProduction).toMatch(/ledger head could not be read \(ledger chain broken at #7\)/);
  });

  it('keeps only backends inside the grant\'s engines (no nim, kimi, per-token grok or ashlrcode)', () => {
    expect(grantAllowedBackends(['builtin', 'llama-server', 'grok-cli', 'claude', 'nim', 'kimi', 'grok', 'ashlrcode'], { engines: ['local', 'grok-cli'] }))
      .toEqual(['builtin', 'llama-server', 'grok-cli']);
    const out = createLiveTickHooks({ deps: deps() }).effectiveConfig(CFG);
    expect(out.foundry?.allowedBackends).toEqual(['builtin', 'llama-server', 'grok-cli', 'claude']);
    // No standing policy: the list is left alone (beforeTick holds everything anyway).
    w.policy = null;
    expect(createLiveTickHooks({ deps: deps() }).effectiveConfig(CFG).foundry?.allowedBackends).toEqual(CFG.foundry?.allowedBackends);
  });

  it('reopens a session the capability module no longer knows, once, and mints on the new one', () => {
    const cap = { kind: 'resident-standing', permitId: 'x' } as unknown as DaemonActivationCapability;
    const s1 = { sessionId: 's-1', grantId: 'g-1', openedAt: NOW_ISO };
    const s2 = { sessionId: 's-2', grantId: 'g-1', openedAt: NOW_ISO };
    const minted: string[] = [];
    const run = createStandingRun({
      session: s1,
      mint: (session) => {
        minted.push(session.sessionId);
        return session === s1 ? { ok: false, reason: UNKNOWN_SESSION_REASON } : { ok: true, capability: cap, policy: policyFixture() };
      },
      reopen: () => ({ ok: true, session: s2 }),
      judgeCredentials: null,
      hooks: createLiveTickHooks({ deps: deps() }),
    });
    expect(run.mint()).toEqual({ ok: true, capability: cap });
    expect(run.sessionId).toBe('s-2');
    expect(minted).toEqual(['s-1', 's-2']);
    // Any other refusal is final for the tick — no reopen.
    let reopened = 0;
    const other = createStandingRun({
      session: s1,
      mint: () => ({ ok: false, reason: 'the switch is off' }),
      reopen: () => {
        reopened += 1;
        return { ok: true, session: s2 };
      },
      judgeCredentials: null,
      hooks: createLiveTickHooks({ deps: deps() }),
    });
    expect(other.mint()).toEqual({ ok: false, reason: 'the switch is off' });
    expect(reopened).toBe(0);
  });
});

describe('B-U8 — the Leader', () => {
  it('ticks the Leader before reading its directives, and clamps them by the grant', async () => {
    w.policy = policyFixture({ engines: ['local'] });
    w.directives = { v: 1, updatedAt: NOW_ISO, routerTuning: null, grokLanes: 4, codexEnabled: true };
    const hooks = createLiveTickHooks({ deps: deps() });
    const result = await hooks.beforeTick(ctx);
    expect(calls.order.indexOf('leader')).toBeLessThan(calls.order.indexOf('directives'));
    expect(result.laneCaps['grok-cli']).toBe(0);
    expect(result.laneCaps.codex).toBe(0);
    expect(clampLeaderDirectives(w.directives, { engines: ['local'] })).toMatchObject({ grokLanes: null, codexEnabled: null });
    expect(clampLeaderDirectives(w.directives, { engines: ['local', 'grok-cli', 'codex'] })).toMatchObject({ grokLanes: 4, codexEnabled: true });
    expect(clampLeaderDirectives(null, { engines: ['codex'] })).toBeNull();
  });

  it('never lets a wedged Leader hold the fleet tick', async () => {
    w.leaderNeverResolves = true;
    const hooks = createLiveTickHooks({ deps: deps(), leaderTimeoutMs: 20 });
    const result = await hooks.beforeTick(ctx);
    expect(result.holdProduction).toBeNull();
    expect(calls.audits.some((a) => /Leader tick exceeded 20 ms/.test(a))).toBe(true);
    // Still in flight: the next tick does not start a second one.
    calls.order = [];
    await hooks.beforeTick(ctx);
    expect(calls.order).not.toContain('leader');
  });
});

describe('B-U9 — harness, canary, verdicts, experiments', () => {
  it('checks the canary before reading the harness, and hands the producer prompt to dispatch', async () => {
    w.harnessVersion = 'h-0003';
    w.harnessConfig = withPrompt('Re-run the project tests before claiming success.');
    const hooks = createLiveTickHooks({ deps: deps() });
    expect(hooks.dispatchHarness()).toBeNull();
    await hooks.beforeTick(ctx);
    expect(calls.canary).toBe(1);
    expect(calls.order.indexOf('canary')).toBeLessThan(calls.order.indexOf('harness'));
    expect(hooks.dispatchHarness()).toEqual({ versionId: 'h-0003', producerPrompt: 'Re-run the project tests before claiming success.', effort: {}, sampling: {} });
  });

  it('hands the adopted harness effort and sampling to dispatch (3.10 known gap)', async () => {
    w.harnessVersion = 'h-0004';
    w.harnessConfig = {
      ...BASELINE_HARNESS_CONFIG,
      effort: { codex: 'high', local: 'medium' },
      sampling: { local: { temperature: 0.2, topP: null, maxOutputTokens: 2048 } },
    } as HarnessConfigV1;
    const hooks = createLiveTickHooks({ deps: deps() });
    await hooks.beforeTick(ctx);
    expect(hooks.dispatchHarness()).toEqual({
      versionId: 'h-0004',
      producerPrompt: null,
      effort: { codex: 'high', local: 'medium' },
      sampling: { local: { temperature: 0.2, topP: null, maxOutputTokens: 2048 } },
    });
  });

  it('credits G3 verdicts to the version each dispatch ran with, once', async () => {
    w.harnessVersion = 'h-0003';
    const hooks = createLiveTickHooks({ deps: deps() });
    await hooks.beforeTick(ctx);
    hooks.route(item(), CFG);
    await hooks.afterDispatch({ itemId: 'item-1', repoPath: PATH, runId: 'r', backend: 'builtin', model: null, lane: 'local', seatId: 'local', dispatched: true, skipReason: null, proposalId: 'p-live', spentUsd: 0, at: NOW_ISO });
    const dispatchRow = calls.journal.find((r) => r.type === 'dispatch');
    expect(dispatchRow).toMatchObject({ harnessVersionId: 'h-0003' });
    // A proposal dispatched by an earlier process, found through the journal (baseline).
    w.journal = [{ ...(dispatchRow as FleetJournalRecord & { type: 'dispatch' }), proposalId: 'p-old', harnessVersionId: null }];
    const rows = [gate('p-live', 'pass'), gate('p-old', 'refuse'), gate('p-live', 'pass', 'G6'), gate('p-unknown', 'pass')];
    expect(await hooks.recordVerdicts(rows)).toBe(2);
    expect(calls.outcomes).toEqual([{ passed: true, versionId: 'h-0003' }, { passed: false, versionId: null }]);
    // The same verdict row seen again is not double-counted.
    expect(await hooks.recordVerdicts(rows)).toBe(0);
  });

  it('does not attribute a run to any version when the harness could not be read', async () => {
    w.harnessThrows = true;
    const hooks = createLiveTickHooks({ deps: deps() });
    await hooks.beforeTick(ctx);
    hooks.route(item(), CFG);
    await hooks.afterDispatch({ itemId: 'item-1', repoPath: PATH, runId: 'r', backend: 'builtin', model: null, lane: 'local', seatId: 'local', dispatched: true, skipReason: null, proposalId: 'p-x', spentUsd: 0, at: NOW_ISO });
    expect(calls.journal.find((r) => r.type === 'dispatch')).not.toHaveProperty('harnessVersionId');
    expect(await hooks.recordVerdicts([gate('p-x', 'pass')])).toBe(0);
    // Dispatch still runs on the baseline config.
    expect(hooks.dispatchHarness()).toEqual({ versionId: null, producerPrompt: null, effort: {}, sampling: {} });
  });

  it('runs experiments only in idle or overnight windows, one at a time, and stops them when authority goes', async () => {
    const hooks = createLiveTickHooks({ deps: deps() });
    await hooks.beforeTick(ctx); // 3 proposals wait for verification: not idle, not overnight
    expect(calls.experiments).toHaveLength(0);

    w.waiting = 0;
    let now = NOW;
    const idleHooks = createLiveTickHooks({ deps: { ...deps(), now: () => now } });
    // Review c15: idle also needs the loop's last merged backlog to be empty
    // (an unknown backlog is not idle).
    idleHooks.standingBacklog([]);
    await idleHooks.beforeTick({ ...ctx, nowMs: now });
    expect(calls.experiments).toHaveLength(1);
    expect(calls.experiments[0]!.depth()).toBe(0);
    now += 10 * 60_000;
    await idleHooks.beforeTick({ ...ctx, nowMs: now });
    expect(calls.experiments).toHaveLength(1); // still running: never two

    // Standing authority withdrawn → the runner is aborted.
    w.policy = null;
    await idleHooks.beforeTick({ ...ctx, nowMs: now + 1 });
    expect(calls.experiments[0]!.signal.aborted).toBe(true);
    expect(calls.audits.some((a) => /experiment runner stopped: The standing grant is not in force/.test(a))).toBe(true);
  });

  it('starts an experiment in an overnight window even with work queued, and never while production is held', async () => {
    w.overnight = true;
    await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(calls.experiments).toHaveLength(1);
    calls.experiments[0]!.signal.dispatchEvent(new Event('abort'));

    calls.experiments = [];
    w.headThrows = true; // production held
    await createLiveTickHooks({ deps: deps() }).beforeTick(ctx);
    expect(calls.experiments).toHaveLength(0);
  });

  it('stops a running experiment when a mint is refused', async () => {
    w.waiting = 0;
    const hooks = createLiveTickHooks({ deps: deps() });
    hooks.standingBacklog([]);
    await hooks.beforeTick(ctx);
    const run = createStandingRun({
      session: { sessionId: 's', grantId: 'g', openedAt: NOW_ISO },
      mint: () => ({ ok: false, reason: 'Stop is in force' }),
      judgeCredentials: null,
      hooks,
    });
    expect(run.mint().ok).toBe(false);
    expect(calls.experiments[0]!.signal.aborted).toBe(true);
  });
});

describe('U7 — best-of-N, grok model, routing weights', () => {
  it('plans Grok + 2 local candidates for hard work and one attempt for easy work', async () => {
    const hooks = createLiveTickHooks({ deps: deps() });
    const hard = item({ id: 'hard', effort: 5 });
    // Review c15: the loop's previous backlog showed hard work, so beforeTick
    // held the best-of-N reserve back from the pool's lane caps.
    hooks.standingBacklog([hard]);
    await hooks.beforeTick(ctx);
    hooks.route(hard, CFG);
    const plan = hooks.bestOfNPlan(hard, { maxPercent: 70 });
    expect(plan).toMatchObject({ run: true, reason: 'planned' });
    expect(plan!.candidates.map((c) => c.engine)).toEqual(['grok-cli', 'llama-server', 'llama-server']);
    expect(plan!.candidates.every((c) => String(c.engine) === 'grok-cli' || typeof c.model === 'string')).toBe(true);

    const easy = item({ id: 'easy', effort: 1 });
    hooks.route(easy, CFG);
    expect(hooks.bestOfNPlan(easy, { maxPercent: 70 })).toMatchObject({ run: false, reason: 'not-needed' });
    // Not routed this tick: no plan at all.
    expect(hooks.bestOfNPlan(item({ id: 'never-routed' }), { maxPercent: 70 })).toBeNull();
  });

  it('fans out a task that already failed once, and follows the Leader\'s bonThreshold', async () => {
    const taskId = '44444444-4444-4444-8444-444444444444';
    w.tasks = [{
      v: 1, id: taskId, repo: REPO, title: 'Retry the parser fix', detail: 'd', kind: 'repair', source: { kind: 'backlog', ref: null },
      value: 3, difficulty: 'low', effort: 2, status: 'queued', attempts: 1, parkedUntil: null,
      createdAt: NOW_ISO, updatedAt: NOW_ISO, goalId: null, landingId: null, insightId: null, dedupeKey: null, lastProposalId: null,
    } as unknown as FleetTask];
    const hooks = createLiveTickHooks({ deps: deps() });
    const retried = item({ id: `fleet-task:${taskId}`, effort: 1 });
    hooks.standingBacklog([retried]);
    await hooks.beforeTick(ctx);
    hooks.route(retried, CFG);
    expect(hooks.bestOfNPlan(retried, { maxPercent: 70 })).toMatchObject({ run: true });

    w.directives = { v: 1, updatedAt: NOW_ISO, routerTuning: { bonThreshold: 'medium' }, grokLanes: null, codexEnabled: null };
    const tuned = createLiveTickHooks({ deps: deps() });
    const medium = item({ id: 'medium', effort: 3 });
    tuned.standingBacklog([medium]);
    await tuned.beforeTick(ctx);
    tuned.route(medium, CFG);
    expect(tuned.bestOfNPlan(medium, { maxPercent: 70 })).toMatchObject({ run: true });
  });

  it('resolves routing weights Leader › harness › baseline, skipping malformed fields', () => {
    const base = BASELINE_HARNESS_CONFIG.routing;
    expect(resolveRoutingWeights(base, null, null)).toEqual(base);
    expect(resolveRoutingWeights(base, { lambdaCost: 2, bonThreshold: 'medium' }, { lambdaCost: 3 })).toEqual({ ...base, lambdaCost: 3, bonThreshold: 'medium' });
    expect(resolveRoutingWeights(base, { lambdaCost: -1 }, { bonThreshold: 'extreme' as never })).toEqual(base);
    expect(meetsBonThreshold('high', 'medium')).toBe(true);
    expect(meetsBonThreshold('low', 'medium')).toBe(false);
  });

  it('sends low-difficulty grok-cli work to the fast model, and leaves other work on the default', async () => {
    expect(grokFastModel()).toBe(GROK_CLI_FAST_MODEL);
    w.policy = policyFixture({ engines: ['grok-cli'] });
    const hooks = createLiveTickHooks({ deps: deps() });
    await hooks.beforeTick(ctx);
    const low = hooks.route(item({ id: 'low', effort: 1 }), CFG);
    expect(low).toMatchObject({ backend: 'grok-cli', model: GROK_CLI_FAST_MODEL, hold: null });
    const medium = hooks.route(item({ id: 'medium', effort: 3 }), CFG);
    expect(medium).toMatchObject({ backend: 'grok-cli', hold: null });
    expect(medium.model).toBeUndefined();
  });
});

describe('U7 — restricted-judge credentials', () => {
  function wiring(standing: () => boolean, token: () => Promise<{ token: string }>) {
    const sets: unknown[] = [];
    const wire: JudgeCredentialWiring = { set: (source) => { sets.push(source); }, claudeToken: token, standing };
    return { wire, sets };
  }

  it('attaches the claude-a token only under a standing policy, and refuses (throws) when custody fails', async () => {
    let standing = true;
    const { wire } = wiring(() => standing, async () => ({ token: 'sk-ant-oat-test' }));
    const source = judgeCredentialSourceFor(wire);
    expect(await source('claude')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test' });
    standing = false;
    expect(await source('claude')).toBeNull();
    const failing = judgeCredentialSourceFor(wiring(() => true, async () => { throw new Error('custody helper missing'); }).wire);
    await expect(failing('claude')).rejects.toThrow(/custody helper missing/);
  });

  it('registers the source for the session and clears it on close', async () => {
    const { wire, sets } = wiring(() => true, async () => ({ token: 't' }));
    const run = createStandingRun({
      session: { sessionId: 's', grantId: 'g', openedAt: NOW_ISO },
      mint: () => ({ ok: false, reason: 'x' }),
      judgeCredentials: wire,
      hooks: createLiveTickHooks({ deps: deps() }),
    });
    await expect(run.ready()).resolves.toBeUndefined();
    expect(sets).toHaveLength(1);
    expect(typeof sets[0]).toBe('function');
    run.close();
    expect(sets[1]).toBeNull();
  });

  it('feeds a tick\'s new ledger rows to the post-merge watch and the canary together', async () => {
    const landings: string[] = [];
    const hooks = createLiveTickHooks({ deps: { ...deps(), registerLanding: (record) => { landings.push(record.id); return { ok: true, registered: true }; } } });
    w.harnessVersion = 'h-0009';
    await hooks.beforeTick(ctx);
    hooks.route(item(), CFG);
    await hooks.afterDispatch({ itemId: 'item-1', repoPath: PATH, runId: 'r', backend: 'builtin', model: null, lane: 'local', seatId: 'local', dispatched: true, skipReason: null, proposalId: 'p-1', spentUsd: 0, at: NOW_ISO });
    const landing = { v: 1, seq: 9, at: NOW_ISO, actor: 'daemon', grantId: 'g-1', repo: REPO, prevHash: '0'.repeat(64), hash: '1'.repeat(64), kind: 'merge:landed', data: { id: 'L1', kind: 'merge', repo: REPO, prNumber: 3, proposalId: 'p-1', landedAt: NOW_ISO } } as unknown as LedgerEntry;
    const run = createStandingRun({ session: { sessionId: 's', grantId: 'g', openedAt: NOW_ISO }, mint: () => ({ ok: false, reason: 'x' }), judgeCredentials: null, hooks });
    expect(await run.notifyLedgerRows([gate('p-1', 'pass'), landing])).toEqual({ landings: 1, verdicts: 1, reserveBreaches: 0 });
    expect(landings).toEqual(['L1']);
    expect(calls.outcomes).toEqual([{ passed: true, versionId: 'h-0009' }]);
  });
});
