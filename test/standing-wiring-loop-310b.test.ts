/**
 * V3.10 Tracks B+C integration (INT1): the loop.ts seams added at
 * integration, driven through the REAL tick() on a disposable repo in an
 * isolated HOME (H1 fixture). No model, no seat, no GitHub:
 *
 *  - U3: the merge pass receives the tick's capability kind
 *    (`resident-standing` on a standing tick, null on master's path).
 *  - U7: a standing tick fans out ONLY on the live hooks' best-of-N plan —
 *    the plan's candidates reach runBestOfN; no plan ⇒ one attempt even when
 *    the config asks for best-of-N; master's path keeps the config's.
 *  - B-U9: the active harness's producer prompt rides on a standing
 *    dispatch's goal; master's goal is untouched.
 *  - A9: master's path logs a SeatRouter shadow decision beside its real
 *    dispatch (from the published capacity snapshot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/daemon/activation-permit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/activation-permit.js')>();
  return {
    ...actual,
    consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'test-authorized' }),
    isDaemonActivationCapability: () => true,
  };
});

const mockRunSwarm = vi.hoisted(() => vi.fn());
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm: (...args: unknown[]) => mockRunSwarm(...args) }));

const mockBuildBacklog = vi.hoisted(() => vi.fn());
vi.mock('../src/core/portfolio/backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/portfolio/backlog.js')>();
  return { ...actual, buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args) };
});

const mockRunGoal = vi.hoisted(() => vi.fn());
vi.mock('../src/core/run/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/orchestrator.js')>();
  return { ...actual, runGoal: (...args: unknown[]) => mockRunGoal(...args) };
});

const mockRunBestOfN = vi.hoisted(() => vi.fn());
vi.mock('../src/core/run/best-of-n.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/best-of-n.js')>();
  return { ...actual, runBestOfN: (...args: unknown[]) => mockRunBestOfN(...args) };
});

const mergePassOpts = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/core/fleet/automerge-pass.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/automerge-pass.js')>();
  return {
    ...actual,
    runAutoMergePass: async (_cfg: unknown, opts?: unknown) => {
      mergePassOpts.push(opts ?? null);
      return { attempted: 0, merged: 0, branched: 0, handoffs: 0, results: [], judged: 0, judgePerPass: 0, judgeCapped: 0, skipped: [] };
    },
  };
});

vi.mock('../src/core/fleet/quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/quota.js')>();
  return {
    ...actual,
    withinLimit: () => true,
    recordUse: () => undefined,
    reserveFleetQuotaUse: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }),
    reserveFleetQuotaUses: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }),
  };
});

import { standingDispatchHarness, tick, withHarnessProducerPrompt } from '../src/core/daemon/loop.js';
import type { HarnessEffort, HarnessSampling } from '../src/core/learn/harness-types.js';
import type { FleetEngine } from '../src/core/fleet/fleet-types.js';
import { DEFAULT_TICK_HOOKS, type TickHooks, type TickRouteDecision } from '../src/core/daemon/tick-hooks.js';
import { readShadowDecisions, writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { DaemonActivationCapability } from '../src/core/daemon/activation-permit.js';
import type { AutonomousBestOfNPlan } from '../src/core/run/best-of-n-policy.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

const STANDING = { kind: 'resident-standing', permitId: 'cap' } as unknown as DaemonActivationCapability;

function cfgFor(foundry: Record<string, unknown> = {}): AshlrConfig {
  return makeCfg({
    daemon: { dailyBudgetUsd: 1.0, perTickItems: 1, parallel: 1, intervalMs: 20, idleBackoffMs: 1 } as AshlrConfig['daemon'],
    // builtin only: master's real router then takes the swarm path for these items.
    foundry: { allowedBackends: ['builtin'], ...foundry } as AshlrConfig['foundry'],
  });
}

/** effort 2 routes to the in-process builtin (swarm) path on master's router. */
function oneItem(repoDir: string): WorkItem {
  return {
    id: `${repoDir}:int1-0`, repo: repoDir, source: 'todo', title: 'int1 item', detail: 'fix the parser', value: 3, effort: 2, score: 3,
    tags: ['todo'], ts: new Date().toISOString(),
  };
}

type PlanFn = (item: WorkItem) => AutonomousBestOfNPlan | null;

function standingHooks(opts: {
  backend: 'builtin' | 'claude';
  plan?: PlanFn;
  harness?: {
    versionId: string | null;
    producerPrompt: string | null;
    effort?: Partial<Record<FleetEngine, HarnessEffort>>;
    sampling?: Partial<Record<FleetEngine, HarnessSampling>>;
  } | null;
}): TickHooks {
  return Object.assign({
    effectiveConfig: (cfg: AshlrConfig) => cfg,
    route: (): TickRouteDecision => (opts.backend === 'builtin'
      ? { backend: 'builtin' as EngineId, tier: 'local', model: null, reason: 'standing test', seatDecision: null, hold: null }
      : { backend: 'claude' as EngineId, tier: 'frontier', model: null, reason: 'standing test', seatDecision: null, hold: null }),
    seatAllows: () => ({ allowed: true, reason: 'standing test' }),
    beforeTick: async () => ({ pausedRepos: [], laneCaps: {}, holdProduction: null }),
    afterDispatch: async () => undefined,
    afterLanding: async () => undefined,
  }, {
    bestOfNPlan: (item: WorkItem) => opts.plan?.(item) ?? null,
    dispatchHarness: () => opts.harness ?? null,
  });
}

const PLAN: AutonomousBestOfNPlan = {
  run: true,
  reason: 'planned',
  candidates: [
    { engine: 'grok-cli' as EngineId },
    { engine: 'llama-server' as EngineId, model: 'qwen3.8:27b-ctx64k' },
    { engine: 'llama-server' as EngineId, model: 'qwen3.8:27b-ctx64k' },
  ],
};

beforeEach(() => {
  fx = makeFixture();
  mergePassOpts.length = 0;
  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockRunBestOfN.mockReset();
  mockBuildBacklog.mockReset();
  mockRunSwarm.mockImplementation(async () => ({ id: 'swarm', status: 'done', goal: '', result: '', usage: { totalTokens: 1, estCostUsd: 0.001, steps: 1 } }));
  mockRunGoal.mockImplementation(async () => ({ id: `run-${Date.now()}`, status: 'done', usage: { totalTokens: 1, estCostUsd: 0.001, steps: 1 } }));
  mockRunBestOfN.mockImplementation(async () => ({
    winner: undefined,
    candidates: [],
    critique: { n: 3, nonEmpty: 0, judged: 0, topScore: 0, winnerIndex: -1, totalCostUsd: 0, billableCostUsd: 0 },
  }));
  mockBuildBacklog.mockImplementation(async (o?: { repos?: string[] }) => ({
    generatedAt: new Date().toISOString(),
    repos: o?.repos ?? [],
    items: [oneItem((o?.repos ?? [])[0] ?? '')],
  }));
});

afterEach(() => {
  fx.cleanup();
});

describe('U3 — the merge pass knows the tick\'s capability kind', () => {
  it('passes resident-standing on a standing tick and null on master\'s path', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor(), { dryRun: false, activationCapability: STANDING, hooks: standingHooks({ backend: 'builtin' }) });
    expect(mergePassOpts).toContainEqual({ capabilityKind: 'resident-standing' });
    mergePassOpts.length = 0;
    await tick(cfgFor(), { dryRun: false });
    expect(mergePassOpts.length).toBeGreaterThan(0);
    expect(mergePassOpts.every((o) => (o as { capabilityKind: unknown }).capabilityKind === null)).toBe(true);
  });
});

describe('U7 — standing best-of-N comes from the plan, never the config', () => {
  it('fans out to exactly the planned candidates', async () => {
    fx.makeRepo().enroll();
    const planned: string[] = [];
    await tick(cfgFor({ allowedBackends: ['builtin', 'claude'] }), {
      dryRun: false,
      activationCapability: STANDING,
      hooks: standingHooks({ backend: 'claude', plan: (item) => { planned.push(item.id); return PLAN; } }),
    });
    expect(planned).toHaveLength(1);
    expect(mockRunBestOfN).toHaveBeenCalledTimes(1);
    const opts = mockRunBestOfN.mock.calls[0]![2] as { n: number; candidates: { engine: string; model?: string }[] };
    expect(opts.n).toBe(3);
    expect(opts.candidates.map((c) => c.engine)).toEqual(['grok-cli', 'llama-server', 'llama-server']);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('runs ONE attempt when the plan declines, even if the config asks for best-of-N', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor({ bestOfN: 3, allowedBackends: ['builtin', 'claude'] }), {
      dryRun: false,
      activationCapability: STANDING,
      hooks: standingHooks({ backend: 'claude', plan: () => ({ run: false, reason: 'not-needed', candidates: [] }) }),
    });
    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('leaves master\'s configured best-of-N alone', async () => {
    fx.makeRepo().enroll();
    const cfg = cfgFor({ bestOfN: 2, allowedBackends: ['claude'] });
    await tick(cfg, {
      dryRun: false,
      hooks: {
        ...DEFAULT_TICK_HOOKS,
        route: (): TickRouteDecision => ({ backend: 'claude' as EngineId, tier: 'frontier', model: null, reason: 'test', seatDecision: null, hold: null }),
        // No subscription reading exists in a test HOME; master's gate would throttle claude.
        seatAllows: () => ({ allowed: true, reason: 'test' }),
      },
    });
    expect(mockRunBestOfN).toHaveBeenCalledTimes(1);
    expect((mockRunBestOfN.mock.calls[0]![2] as { n: number }).n).toBe(2);
  });
});

describe('B-U9 — the harness producer prompt reaches a standing dispatch', () => {
  it('appends the active harness overlay to the goal on a standing tick only', async () => {
    fx.makeRepo().enroll();
    const harness = { versionId: 'h-0002', producerPrompt: 'Run the project tests before you report success.' };
    await tick(cfgFor(), { dryRun: false, activationCapability: STANDING, hooks: standingHooks({ backend: 'builtin', harness }) });
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    const standingGoal = (mockRunSwarm.mock.calls[0]![0] as { goal: string }).goal;
    expect(standingGoal).toContain('## Fleet harness guidance (h-0002)');
    expect(standingGoal).toContain('Run the project tests before you report success.');

    // Master's path, on a fresh fixture (the item above is already worked).
    fx.cleanup();
    fx = makeFixture();
    fx.makeRepo().enroll();
    mockRunSwarm.mockClear();
    await tick(cfgFor(), { dryRun: false });
    const masterGoal = (mockRunSwarm.mock.calls[0]![0] as { goal: string }).goal;
    expect(masterGoal).not.toContain('Fleet harness guidance');
  });

  it('returns the goal unchanged for the default hooks, a baseline harness, or a throwing hook', () => {
    expect(withHarnessProducerPrompt('goal', DEFAULT_TICK_HOOKS)).toBe('goal');
    expect(withHarnessProducerPrompt('goal', standingHooks({ backend: 'builtin', harness: { versionId: null, producerPrompt: null } }))).toBe('goal');
    const throwing = Object.assign({ ...DEFAULT_TICK_HOOKS }, { dispatchHarness: () => { throw new Error('store'); } });
    expect(withHarnessProducerPrompt('goal', throwing)).toBe('goal');
  });
});

describe('V3.11 — the adopted harness effort / sampling reach the engine invocation', () => {
  const TUNED = {
    versionId: 'h-0005',
    producerPrompt: null,
    effort: { 'claude-cli': 'high', local: 'medium' } as Partial<Record<FleetEngine, HarnessEffort>>,
    sampling: { local: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 } } as Partial<Record<FleetEngine, HarnessSampling>>,
  };

  it('forwards the harness on a standing single dispatch', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor({ allowedBackends: ['builtin', 'claude'] }), {
      dryRun: false,
      activationCapability: STANDING,
      hooks: standingHooks({ backend: 'claude', plan: () => ({ run: false, reason: 'not-needed', candidates: [] }), harness: TUNED }),
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const opts = mockRunGoal.mock.calls[0]![2] as { harness?: unknown };
    expect(opts.harness).toEqual({ versionId: 'h-0005', effort: TUNED.effort, sampling: TUNED.sampling });
  });

  it('forwards the harness to every best-of-N candidate', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor({ allowedBackends: ['builtin', 'claude'] }), {
      dryRun: false,
      activationCapability: STANDING,
      hooks: standingHooks({ backend: 'claude', plan: () => PLAN, harness: TUNED }),
    });
    expect(mockRunBestOfN).toHaveBeenCalledTimes(1);
    const opts = mockRunBestOfN.mock.calls[0]![2] as { harness?: unknown };
    expect(opts.harness).toEqual({ versionId: 'h-0005', effort: TUNED.effort, sampling: TUNED.sampling });
  });

  it('forwards nothing for a baseline harness, so the compiled defaults apply', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor({ allowedBackends: ['builtin', 'claude'] }), {
      dryRun: false,
      activationCapability: STANDING,
      hooks: standingHooks({
        backend: 'claude',
        plan: () => ({ run: false, reason: 'not-needed', candidates: [] }),
        harness: { versionId: null, producerPrompt: null, effort: {}, sampling: {} },
      }),
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]![2]).not.toHaveProperty('harness');
  });

  it('never forwards a harness on master\'s (non-standing) path', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor({ allowedBackends: ['claude'] }), {
      dryRun: false,
      hooks: {
        ...standingHooks({ backend: 'claude', harness: TUNED }),
        // No subscription reading exists in a test HOME; master's gate would throttle claude.
        seatAllows: () => ({ allowed: true, reason: 'test' }),
      },
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]![2]).not.toHaveProperty('harness');
  });

  it('standingDispatchHarness is null for default hooks, a throwing hook, or no settings', () => {
    expect(standingDispatchHarness(DEFAULT_TICK_HOOKS)).toBeNull();
    const throwing = Object.assign({ ...DEFAULT_TICK_HOOKS }, { dispatchHarness: () => { throw new Error('store'); } });
    expect(standingDispatchHarness(throwing)).toBeNull();
    expect(standingDispatchHarness(standingHooks({ backend: 'builtin', harness: null }))).toBeNull();
    expect(standingDispatchHarness(standingHooks({ backend: 'builtin', harness: { versionId: 'h-1', producerPrompt: 'x', effort: {}, sampling: {} } }))).toBeNull();
    expect(standingDispatchHarness(standingHooks({ backend: 'builtin', harness: TUNED }))).toEqual({
      versionId: 'h-0005', effort: TUNED.effort, sampling: TUNED.sampling,
    });
  });
});

describe('A9 — a SeatRouter shadow beside master\'s real dispatch', () => {
  it('logs what the SeatRouter would have chosen, from the published snapshot', async () => {
    fx.makeRepo().enroll();
    writeCapacitySnapshot([{
      seatId: 'local', engine: 'local', label: 'Local', free: true, windows: [], signedOut: false, reachable: true,
      contextWindow: 65_536, observedAt: new Date().toISOString(), spentTodayUsd: null,
    }]);
    await tick(cfgFor(), { dryRun: false });
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    let rows = readShadowDecisions(10);
    for (let i = 0; i < 50 && rows.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      rows = readShadowDecisions(10);
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ source: 'daemon', actual: { engine: 'builtin', seatId: null } });
  });

  it('logs nothing when no capacity was ever published, or when turned off', async () => {
    fx.makeRepo().enroll();
    await tick(cfgFor(), { dryRun: false });
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readShadowDecisions(10)).toEqual([]);

    fx.cleanup();
    fx = makeFixture();
    fx.makeRepo().enroll();
    writeCapacitySnapshot([{
      seatId: 'local', engine: 'local', label: 'Local', free: true, windows: [], signedOut: false, reachable: true,
      contextWindow: 65_536, observedAt: new Date().toISOString(), spentTodayUsd: null,
    }]);
    await tick(cfgFor({ seatRouterShadow: false }), { dryRun: false });
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readShadowDecisions(10)).toEqual([]);
  });
});
