/**
 * V3.10 Track B (U5): the daemon/loop.ts seams, driven through the REAL tick()
 * and runDaemon() on disposable repos in an isolated HOME (H1 fixture).
 *
 *  A. PARITY — default hooks produce the same tick as master: a recording
 *     wrapper that delegates to DEFAULT_TICK_HOOKS yields the same tick record
 *     as no hooks at all, and the seams are called where routeBackend /
 *     subscriptionAllows were.
 *  B. A STANDING tick (resident-standing capability) runs through the hooks:
 *     route holds are honoured, the seat gate is asked about every engine,
 *     the fleet's own tasks join the backlog, paused repos drop out, a
 *     production hold drains without producing, and a lane change after
 *     routing is refused.
 *  C. runDaemon: a standing session skips the proposal permit and ticks with
 *     the live hooks; a withdrawn authority parks the loop (resident, not
 *     exited); an API-armed run is adopted mid-run and ends by PAUSING.
 *
 * No model, no seat, no GitHub: runSwarm and buildBacklog are mocked; the
 * activation permit and the standing capability are test seams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

const mockLoadConfig = vi.hoisted(() => vi.fn());
vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return { ...actual, loadConfig: (...args: unknown[]) => mockLoadConfig(...args) };
});

vi.mock('../src/core/daemon/activation-permit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/activation-permit.js')>();
  return {
    ...actual,
    consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'test-authorized' }),
    isDaemonActivationCapability: () => true,
  };
});

const standingHarness = vi.hoisted(() => ({
  open: false,
  mintOk: true,
  mintReason: 'the switch is off',
  mints: 0,
}));
vi.mock('../src/core/authority/capability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/capability.js')>();
  return {
    ...actual,
    openStandingSession: () => (standingHarness.open
      ? { ok: true, session: { sessionId: 's-1', grantId: 'g-test', openedAt: new Date().toISOString() }, policy: {} }
      : { ok: false, reason: 'no grant installed' }),
    mintStandingTickCapability: () => {
      standingHarness.mints += 1;
      return standingHarness.mintOk
        ? { ok: true, capability: { kind: 'resident-standing', permitId: `tick-${standingHarness.mints}` }, policy: {} }
        : { ok: false, reason: standingHarness.mintReason };
    },
  };
});

const quotaHarness = vi.hoisted(() => ({ within: true }));
vi.mock('../src/core/fleet/quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/quota.js')>();
  return {
    ...actual,
    withinLimit: () => quotaHarness.within,
    recordUse: () => undefined,
    reserveFleetQuotaUse: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }),
    reserveFleetQuotaUses: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }),
  };
});

/**
 * The local fleet, faked just enough to reach its concurrency derivation: a
 * 4-slot llama-server that is "up" without any socket being opened. Off by
 * default (the real module runs for every other test).
 */
const fleetHarness = vi.hoisted(() => ({ on: false, laneCaps: [] as unknown[] }));
vi.mock('../src/core/daemon/local-fleet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/local-fleet.js')>();
  return {
    ...actual,
    readLocalFleetSettings: (cfg: Parameters<typeof actual.readLocalFleetSettings>[0]) =>
      (fleetHarness.on ? { ...actual.readLocalFleetSettings(cfg), enabled: true } : actual.readLocalFleetSettings(cfg)),
    resolveServingCapacity: async (...args: Parameters<typeof actual.resolveServingCapacity>) => (fleetHarness.on
      ? {
          runtime: 'llama-server', endpoint: '127.0.0.1:8080', state: 'up', slots: 4, busySlots: 0, model: 'qwen',
          managed: true, startedAt: null, observedAt: new Date().toISOString(), detail: 'llama-server up with 4 slot(s)',
        } as Awaited<ReturnType<typeof actual.resolveServingCapacity>>
      : actual.resolveServingCapacity(...args)),
    deriveLocalFleetConcurrency: (...args: Parameters<typeof actual.deriveLocalFleetConcurrency>) => {
      if (fleetHarness.on) fleetHarness.laneCaps.push(args[2]?.laneCap ?? null);
      return actual.deriveLocalFleetConcurrency(...args);
    },
  };
});

const mockRunSwarm = vi.hoisted(() => vi.fn());
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm: (...args: unknown[]) => mockRunSwarm(...args) }));

const mockBuildBacklog = vi.hoisted(() => vi.fn());
vi.mock('../src/core/portfolio/backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/portfolio/backlog.js')>();
  return { ...actual, buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args) };
});

import { poolTierForBackend, runDaemon, tick } from '../src/core/daemon/loop.js';
import { LOCAL_FLEET_ENGINE } from '../src/core/daemon/local-fleet.js';
import { DEFAULT_TICK_HOOKS, type TickHooks, type TickRouteDecision } from '../src/core/daemon/tick-hooks.js';
import { readDaemonPause } from '../src/core/daemon/pause.js';
import { readOvernightStatus, requestOvernightRun } from '../src/core/daemon/overnight-status.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import { activeEnrollmentLenses, enroll, isEnrolled, listEnrolled } from '../src/core/sandbox/policy.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import type { DaemonActivationCapability } from '../src/core/daemon/activation-permit.js';
import type { AshlrConfig, DaemonTick, EngineId, WorkItem } from '../src/core/types.js';
import type { DispatchOutcome } from '../src/core/fleet/fleet-types.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

function items(repoDir: string, n = 3): WorkItem[] {
  const now = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: `${repoDir}:u5-${i}`,
    repo: repoDir,
    source: 'todo' as const,
    title: `u5 item ${i}`,
    detail: `detail ${i}`,
    value: 3,
    effort: 2,
    score: 1.5 - i * 0.1,
    tags: ['todo'],
    ts: now,
  }));
}

function cfgFor(over: Partial<AshlrConfig['daemon']> = {}): AshlrConfig {
  const cfg = makeCfg({
    daemon: { dailyBudgetUsd: 1.0, perTickItems: 3, parallel: 1, intervalMs: 20, idleBackoffMs: 1, ...over } as AshlrConfig['daemon'],
  });
  mockLoadConfig.mockReturnValue(cfg);
  return cfg;
}

beforeEach(() => {
  fx = makeFixture();
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  quotaHarness.within = true;
  fleetHarness.on = false;
  fleetHarness.laneCaps = [];
  standingHarness.open = false;
  standingHarness.mintOk = true;
  standingHarness.mints = 0;
  mockRunSwarm.mockImplementation(async () => ({ id: 'swarm', status: 'done', goal: '', result: '', usage: { totalTokens: 1, estCostUsd: 0.001, steps: 1 } }));
  mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => ({
    generatedAt: new Date().toISOString(),
    repos: opts?.repos ?? [],
    items: items((opts?.repos ?? [])[0] ?? ''),
  }));
});

afterEach(() => {
  fx.cleanup();
});

/** The comparable part of a tick record (ids and clocks differ run to run). */
function shape(t: DaemonTick) {
  return {
    reason: t.reason,
    itemsConsidered: t.itemsConsidered,
    proposalsCreated: t.proposalsCreated,
    spentUsd: t.spentUsd,
    dispatches: (t.dispatches ?? []).map((d) => ({
      title: d.title, backend: d.backend, tier: d.tier, assignedBy: d.assignedBy, dispatched: d.dispatched, skipReason: d.skipReason ?? null,
    })).sort((a, b) => (a.title < b.title ? -1 : 1)),
  };
}

function recordingHooks(): { hooks: TickHooks; calls: Record<string, number>; outcomes: DispatchOutcome[] } {
  const calls: Record<string, number> = { effectiveConfig: 0, route: 0, seatAllows: 0, beforeTick: 0, afterDispatch: 0 };
  const outcomes: DispatchOutcome[] = [];
  const hooks: TickHooks = {
    effectiveConfig: (cfg) => { calls['effectiveConfig']! += 1; return DEFAULT_TICK_HOOKS.effectiveConfig(cfg); },
    route: (item, cfg) => { calls['route']! += 1; return DEFAULT_TICK_HOOKS.route(item, cfg); },
    seatAllows: (engine, opts) => { calls['seatAllows']! += 1; return DEFAULT_TICK_HOOKS.seatAllows(engine, opts); },
    beforeTick: async (ctx) => { calls['beforeTick']! += 1; return DEFAULT_TICK_HOOKS.beforeTick(ctx); },
    afterDispatch: async (outcome) => { calls['afterDispatch']! += 1; outcomes.push(outcome); },
    afterLanding: async () => undefined,
  };
  return { hooks, calls, outcomes };
}

describe('A · default hooks produce the same tick as master', () => {
  it('a delegating wrapper yields the same tick record as no hooks at all', async () => {
    const repoA = fx.makeRepo();
    repoA.enroll();
    const plain = shape(await tick(cfgFor(), { dryRun: false }));
    const plainSwarms = mockRunSwarm.mock.calls.length;
    fx.cleanup();

    fx = makeFixture();
    const repoB = fx.makeRepo();
    repoB.enroll();
    mockRunSwarm.mockClear();
    const { hooks, calls, outcomes } = recordingHooks();
    const hooked = shape(await tick(cfgFor(), { dryRun: false, hooks }));

    expect(hooked).toEqual(plain);
    expect(mockRunSwarm.mock.calls.length).toBe(plainSwarms);
    expect(plain.reason).toBe('ok');
    // Not a vacuous comparison: the plain tick really dispatched work.
    expect(plainSwarms).toBeGreaterThan(0);
    expect(plain.dispatches.some((d) => d.dispatched)).toBe(true);
    expect(calls['effectiveConfig']).toBe(1);
    expect(calls['beforeTick']).toBe(1);
    // routeBackend's call sites: pool planning + dispatch, once each per worked item.
    expect(calls['route']).toBeGreaterThanOrEqual(plain.dispatches.length);
    // Non-standing ticks ask the seat gate only for subscription engines (none here).
    expect(calls['seatAllows']).toBe(0);
    expect(outcomes).toHaveLength(plain.dispatches.length);
    expect(outcomes.every((o) => o.lane === null)).toBe(true);
  });
});

const STANDING: DaemonActivationCapability = { kind: 'resident-standing', permitId: 'cap' } as unknown as DaemonActivationCapability;

function standingHooks(over: Partial<TickHooks> & { standingBacklog?: (items: WorkItem[]) => WorkItem[] } = {}) {
  const seat: string[] = [];
  const outcomes: DispatchOutcome[] = [];
  const hooks = {
    effectiveConfig: (cfg: AshlrConfig) => cfg,
    route: (item: WorkItem, cfg: AshlrConfig): TickRouteDecision => DEFAULT_TICK_HOOKS.route(item, cfg),
    seatAllows: (engine: EngineId) => { seat.push(engine); return { allowed: true, reason: 'standing test' }; },
    beforeTick: async () => ({ pausedRepos: [], laneCaps: { local: 2 }, holdProduction: null }),
    afterDispatch: async (outcome: DispatchOutcome) => { outcomes.push(outcome); },
    afterLanding: async () => undefined,
    ...over,
  };
  return { hooks, seat, outcomes };
}

describe('B · a standing tick runs through the hooks', () => {
  it('honours route holds, asks the seat gate about every engine, and journals every outcome', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const { hooks, seat, outcomes } = standingHooks({
      route: (item, cfg) => (item.id.endsWith(':u5-1')
        ? { ...DEFAULT_TICK_HOOKS.route(item, cfg), seatDecision: null, hold: { kind: 'split', reason: 'too big for any seat', nextEligibleAt: null } }
        : DEFAULT_TICK_HOOKS.route(item, cfg)),
    });
    const result = await tick(cfgFor({ parallel: 3 }), { dryRun: false, activationCapability: STANDING, hooks });
    expect(result.reason).toBe('ok');
    const held = result.dispatches?.find((d) => d.title === 'u5 item 1');
    expect(held).toMatchObject({ dispatched: false, skipReason: 'route-split', assignedBy: 'standing-router' });
    // builtin is not a subscription engine: only a standing tick asks about it.
    expect(seat.filter((e) => e === 'builtin').length).toBeGreaterThanOrEqual(2);
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.lane)).toContain('local');
  });

  it('merges the fleet\'s own tasks into the backlog and drops paused repos', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const paused = fx.makeRepo();
    paused.enroll();
    mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => ({
      generatedAt: new Date().toISOString(),
      repos: opts?.repos ?? [],
      items: (opts?.repos ?? []).flatMap((dir) => items(dir, 1)),
    }));
    const task: WorkItem = { ...items(repo.dir, 1)[0]!, id: 'fleet-task:33333333-3333-4333-8333-333333333333', title: 'Leader: add parser tests', score: 5 };
    const { hooks } = standingHooks({
      beforeTick: async () => ({ pausedRepos: [paused.dir], laneCaps: {}, holdProduction: null }),
      standingBacklog: (list) => [task, ...list],
    });
    const result = await tick(cfgFor({ parallel: 3 }), { dryRun: false, activationCapability: STANDING, hooks });
    const titles = (result.dispatches ?? []).map((d) => d.title);
    expect(titles).toContain('Leader: add parser tests');
    expect(titles.some((t) => t === 'u5 item 0')).toBe(true);
    expect((result.dispatches ?? []).every((d) => !d.repo.includes(paused.dir.split('/').pop()!))).toBe(true);
  });

  it('drains without producing while production is held', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const { hooks } = standingHooks({
      beforeTick: async () => ({ pausedRepos: [], laneCaps: {}, holdProduction: '5 proposals are waiting for verification (limit 4).' }),
    });
    const result = await tick(cfgFor(), { dryRun: false, activationCapability: STANDING, hooks });
    expect(result.reason).toBe('production-held');
    expect(result.directionReason).toMatch(/waiting for verification/);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('refuses a dispatch whose lane changed after routing (a quota fallback to local)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    quotaHarness.within = false;
    const { hooks } = standingHooks({
      route: (item, cfg) => ({ ...DEFAULT_TICK_HOOKS.route(item, cfg), backend: 'claude' as EngineId, tier: 'frontier', model: null, seatDecision: null, hold: null }),
    });
    const result = await tick(cfgFor(), { dryRun: false, activationCapability: STANDING, hooks });
    expect((result.dispatches ?? []).length).toBeGreaterThan(0);
    for (const d of result.dispatches ?? []) expect(d).toMatchObject({ dispatched: false, skipReason: 'standing-lane-changed' });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('hands the local lane cap and its reason to the local fleet derivation (U6), and nothing on master\'s path', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    fleetHarness.on = true;
    const presence = 'Mason is present (a Verse chat turn is running).';
    const { hooks } = standingHooks({
      beforeTick: async () => ({ pausedRepos: [], laneCaps: { local: 2 }, holdProduction: null }),
      // Every item parks: this test is about the derivation, not a dispatch.
      route: (item, cfg) => ({ ...DEFAULT_TICK_HOOKS.route(item, cfg), seatDecision: null, hold: { kind: 'park', reason: 'test', nextEligibleAt: null } }),
    });
    const withState = Object.assign(hooks, {
      lastTickState: () => ({ lanes: [{ lane: 'local', slots: 2, busy: 0, capReason: presence }] }),
    });
    await tick(cfgFor({ parallel: 3 }), { dryRun: false, activationCapability: STANDING, hooks: withState as unknown as TickHooks });
    expect(fleetHarness.laneCaps).toContainEqual({ limit: 2, reason: presence });
    expect(mockRunSwarm).not.toHaveBeenCalled();

    fleetHarness.laneCaps = [];
    await tick(cfgFor({ parallel: 3 }), { dryRun: false });
    expect(fleetHarness.laneCaps.length).toBeGreaterThan(0);
    expect(fleetHarness.laneCaps.every((cap) => cap === null)).toBe(true);
  });

  it('keeps a proposal-once capability proposal-only (default hooks, one item)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const cap = { kind: 'proposal-once', permitId: 'p' } as unknown as DaemonActivationCapability;
    const result = await tick(cfgFor({ parallel: 3 }), { dryRun: false, activationCapability: cap });
    expect(result.itemsConsidered).toBeLessThanOrEqual(1);
  });
});

function paused(): boolean {
  return readDaemonPause().state === 'paused';
}

function killEngaged(): boolean {
  return existsSync(join(fx.ashlrDir, 'KILL'));
}

describe('C · runDaemon', () => {
  it('opens a standing session instead of consuming the permit, and ticks with the live hooks', async () => {
    standingHarness.open = true;
    // R3f: a standing daemon works only in the fleet's mirrors, so the repo
    // this tick sees must be one (a disposable repo moved to a mirror path).
    const repo = fx.makeRepo();
    const mirror = mirrorPathFor('acme/widget');
    mkdirSync(dirname(mirror), { recursive: true });
    renameSync(repo.dir, mirror);
    enroll(mirror);
    const state = await runDaemon(cfgFor({ mode: 'continuous' }), { once: false, dryRun: false, maxCycles: 1 });
    expect(state.startRefusal).toBeUndefined();
    expect(standingHarness.mints).toBe(1);
    // The live hooks found no standing policy in this isolated HOME (no grant):
    // they fail closed and the tick produces nothing.
    expect(state.ticks.at(-1)?.reason).toBe('production-held');
    expect(state.ticks.at(-1)?.directionReason).toMatch(/standing grant is not in force/);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    const audit = readAudit(50).map((e) => e.summary).join('\n');
    expect(audit).toMatch(/daemon started: .*standing grant=g-test/);
  }, 30_000);

  it('R3f: a standing run never sees Mason’s enrolled checkouts — and never unenrolls them', async () => {
    standingHarness.open = true;
    const checkout = fx.makeRepo();
    checkout.enroll();
    const state = await runDaemon(cfgFor({ mode: 'continuous' }), { once: false, dryRun: false, maxCycles: 1 });
    expect(state.startRefusal).toBeUndefined();
    // Inside the run the lane hid the checkout, so there was nothing to tick…
    expect(state.ticks.at(-1)?.reason).toBe('no-enrolled-repos');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    // …while the registry still holds it, and the lane did not leak out of runDaemon.
    expect(checkout.isEnrolled()).toBe(true);
    expect(isEnrolled(checkout.dir)).toBe(true);
    expect(listEnrolled()).toHaveLength(1);
    expect(activeEnrollmentLenses()).toEqual([]);
  }, 30_000);

  it('R3f: without a standing session runDaemon reads the full registry, as before', async () => {
    standingHarness.open = false;
    const checkout = fx.makeRepo();
    checkout.enroll();
    const state = await runDaemon(cfgFor({ mode: 'continuous' }), { once: false, dryRun: true, maxCycles: 1 });
    expect(state.ticks.at(-1)?.reason).not.toBe('no-enrolled-repos');
    expect(activeEnrollmentLenses()).toEqual([]);
  }, 30_000);

  it('parks — resident, not exited — while standing authority is withdrawn', async () => {
    standingHarness.open = true;
    standingHarness.mintOk = false;
    standingHarness.mintReason = 'the autonomy switch is off';
    const repo = fx.makeRepo();
    repo.enroll();
    const run = runDaemon(cfgFor({ mode: 'continuous' }), { once: false, dryRun: false, maxCycles: 5 });
    // Let it reach the park, then Stop (the kill switch poll wakes the park).
    await new Promise((r) => setTimeout(r, 400));
    fx.setKill(true);
    const state = await run;
    expect(state.ticks).toHaveLength(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    const audit = readAudit(50).map((e) => e.summary).join('\n');
    expect(audit).toMatch(/standing authority withdrawn: the autonomy switch is off; loop parked/);
  }, 30_000);

  it('adopts a run armed from the API and ends it by PAUSING, never by the kill switch', async () => {
    const cfg = cfgFor({ mode: 'continuous' });
    requestOvernightRun({ kind: 'after-iterations', iterations: 2 });
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 20 });
    expect(state.ticks).toHaveLength(2);
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);
    const status = readOvernightStatus();
    expect(status.armed).toBe(false);
    expect(status.run?.startedAt).toBeTruthy();
    expect(status.run?.iterationsDone).toBe(2);
    expect(status.run?.activity).toContain('iterations-reached');
  }, 30_000);

  it('refuses a pending run whose stop time already passed, on the record — never running it unbounded', async () => {
    requestOvernightRun({ kind: 'at-time', at: new Date(Date.now() - 60_000).toISOString() });
    const state = await runDaemon(cfgFor({ mode: 'continuous' }), { once: false, dryRun: false, maxCycles: 2 });
    expect(state.ticks.length).toBeLessThanOrEqual(2);
    const status = readOvernightStatus();
    expect(status.armed).toBe(false);
    expect(status.run?.activity).toMatch(/^not started: .*in the past/);
    expect(paused()).toBe(false);
  }, 30_000);
});

describe('D · m201 B2 — the cloud cap binds every frontier or remote turn', () => {
  // m201 B2: four frontier items ran at once under `concurrency.cloud = 1`
  // because the pool was chosen by the engine ID (LOCAL_ONLY_BACKENDS) and by
  // trust tier, not by what the turn actually spends. The rule is now
  // fail-toward-cloud: the local pool only takes non-frontier turns that
  // policy/local-only.ts says run on this machine.
  it('a frontier-tier backend draws from the CLOUD pool even under a local-only id', () => {
    expect(poolTierForBackend('builtin' as EngineId, 'frontier')).toBe('cloud');
    expect(poolTierForBackend(LOCAL_FLEET_ENGINE, 'frontier')).toBe('cloud');
  });

  it('a backend that reaches a vendor is CLOUD whatever tier the registry gives it', () => {
    // opencode is registered tier 'local' but is a cloud CLI agent.
    expect(poolTierForBackend('opencode' as EngineId, 'local')).toBe('cloud');
    expect(poolTierForBackend('claude' as EngineId, 'mid')).toBe('cloud');
  });

  it('on-device, non-frontier backends stay in the LOCAL pool (the slot ceiling still binds them)', () => {
    expect(poolTierForBackend('builtin' as EngineId, 'local')).toBe('local');
    expect(poolTierForBackend(LOCAL_FLEET_ENGINE, 'mid')).toBe('local');
  });
});
