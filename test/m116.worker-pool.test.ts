/**
 * m116.worker-pool.test.ts — continuous + tiered worker-pool tests.
 *
 * SCOPE:
 *  1. DEFAULT CONFIG (batch mode) — behavior is byte-identical to pre-M116:
 *     parallel is respected, no continuous dispatching, no per-tier splitting.
 *
 *  2. TIERED CONCURRENCY — local≤N and cloud≤M concurrently, total≤cap.
 *     Assert no tier exceeds its budget under a mixed backlog.
 *
 *  3. CONTINUOUS MODE — runDaemon keeps dispatching until backlog drained /
 *     budget hit / kill-switch set. No fixed inter-tick sleep when work flows.
 *
 *  4. SUBSCRIPTION THROTTLE — throttled cloud engine does NOT block local work.
 *
 *  5. KILL-SWITCH — halts mid-pool in both batch and continuous mode.
 *
 * SAFETY / HERMETICITY (mirrors m85 / m106 / m113):
 *  - HOME overridden to tmp dir — no real ~/.ashlr state touched.
 *  - runSwarm, runGoal, routeBackend, buildBacklog, subscriptionAllows,
 *    withinLimit, engineTierOf ALL MOCKED.
 *  - No real agents, subprocesses, or API calls.
 *  - ASHLR_IN_DAEMON / ASHLR_IN_SWARM cleaned up in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import type { RouteDecision } from '../src/core/fleet/router.js';

// ---------------------------------------------------------------------------
// HOME isolation — before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports (same pattern as m85 / m106 / m113)
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

let routeResult: RouteDecision = { backend: 'builtin', tier: 'local', reason: 'test' };
const mockRouteBackend = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

let backlogItems: WorkItem[] = [];
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock('../src/core/config.js', async () => {
  const real = await vi.importActual<typeof import('../src/core/config.js')>(
    '../src/core/config.js',
  );
  return {
    ...real,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    defaultConfig: () => ({ version: 1 }),
    saveConfig: vi.fn(),
  };
});

// M116: mock engineTierOf so we can control tier routing per-test.
let engineTierOfImpl: (engine: string) => 'local' | 'mid' | 'frontier' =
  () => 'local';
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) => engineTierOfImpl(engine),
  buildContainedEnv: vi.fn(() => ({})),
}));

// Mock subscription check — default: always allowed.
let subscriptionAllowedImpl: () => boolean = () => true;
vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: () =>
    subscriptionAllowedImpl()
      ? { allowed: true, reason: 'ok' }
      : { allowed: false, reason: 'throttled' },
  isSubscriptionEngine: (engine: string) => engine !== 'builtin',
}));

// Mock quota/limit — default: always within limit.
vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: () => true,
  recordUse: vi.fn(),
}));

// Mock supporting modules that are imported transitively.
vi.mock('../src/core/fleet/pulse-export.js', () => ({ exportToPulse: async () => false }));
vi.mock('../src/core/learn/tuning.js', () => ({ emitTuningProposals: vi.fn() }));
vi.mock('../src/core/observability/estimate.js', () => ({
  estimateRun: async () => ({ estCostUsd: { median: 0 } }),
}));
vi.mock('../src/core/observability/forecast.js', () => ({
  buildForecast: () => ({ projectedUsd: 0 }),
}));
vi.mock('../src/core/run/learned-router.js', () => ({
  recommendRoute: async (_item: unknown, _cfg: unknown, opts: { estimate?: unknown }) =>
    ({ backend: 'builtin', tier: 'local', reason: 'mock' }),
  recoverWithinBudget: (_decision: unknown) =>
    ({ action: 'ok', decision: { backend: 'builtin', tier: 'local', reason: 'mock' } }),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { tick, runDaemon } from '../src/core/daemon/loop.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { createProposal } from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<AshlrConfig['daemon']> = {}): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 10,
      parallel: 2,
      intervalMs: 50,
      ...overrides,
    },
  } as AshlrConfig;
}

function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

function makeItem(id: string, repo: string, over?: Partial<WorkItem>): WorkItem {
  return {
    id,
    repo,
    source: 'todo',
    title: `Item ${id}`,
    detail: `detail for ${id}`,
    value: 3,
    effort: 3,
    score: 1,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

/** Stub that records a proposal and resolves after `delayMs`. */
function swarmStub(repo: string, delayMs = 0): () => Promise<unknown> {
  return async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    createProposal({
      repo,
      origin: 'swarm',
      kind: 'patch',
      title: 'Mock swarm proposal',
      summary: 'Generated by mock runSwarm',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    return {
      id: `mock-swarm-${Date.now()}-${Math.random()}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { estCostUsd: 0, totalTokens: 0, steps: 1 },
    };
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m116-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m116-repo-'));
  process.env.HOME = tmpHome;

  initBareGitDir(tmpRepo);
  fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ name: 'r' }), 'utf8');

  // Reset mocks
  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockRouteBackend.mockReset();
  mockRunAutoMergePass.mockReset();
  mockBuildBacklog.mockReset();
  mockLoadConfig.mockReset();

  routeResult = { backend: 'builtin', tier: 'local', reason: 'test' };
  backlogItems = [];
  engineTierOfImpl = () => 'local';
  subscriptionAllowedImpl = () => true;

  mockRouteBackend.mockImplementation(() => routeResult);
  mockRunAutoMergePass.mockImplementation(async () => ({ attempted: 0, merged: 0, results: [] }));
  mockBuildBacklog.mockImplementation(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [tmpRepo],
    items: backlogItems,
  }));
  mockRunSwarm.mockImplementation(swarmStub(tmpRepo));
  mockRunGoal.mockImplementation(async () => ({
    id: `mock-run-${Date.now()}-${Math.random()}`,
    status: 'done',
    usage: { estCostUsd: 0 },
  }));
  mockLoadConfig.mockImplementation(() => makeCfg());

  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });

  process.env.HOME = origHome;
  if (origInDaemon !== undefined) process.env.ASHLR_IN_DAEMON = origInDaemon;
  else delete process.env.ASHLR_IN_DAEMON;
  if (origInSwarm !== undefined) process.env.ASHLR_IN_SWARM = origInSwarm;
  else delete process.env.ASHLR_IN_SWARM;
});

// ---------------------------------------------------------------------------
// Block 1: Default config — batch mode, identical to pre-M116 behavior
// ---------------------------------------------------------------------------

describe('M116 — default config (batch mode)', () => {
  it('processes items up to parallel cap; no continuous looping', async () => {
    enroll(tmpRepo);
    backlogItems = [
      makeItem('i1', tmpRepo),
      makeItem('i2', tmpRepo),
      makeItem('i3', tmpRepo),
      makeItem('i4', tmpRepo),
    ];
    // Default parallel=2, perTickItems=2 (we'll set perTickItems=2)
    const cfg = makeCfg({ parallel: 2, perTickItems: 2 });
    mockLoadConfig.mockReturnValue(cfg);

    const t = await tick(cfg, { dryRun: false });

    // tick() should consider only up to perTickItems=2
    expect(t.itemsConsidered).toBeLessThanOrEqual(2);
    expect(t.reason).toBe('ok');
    // Swarm called at most 2 times (parallel cap)
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('returns kill-switch reason without dispatching any swarms', async () => {
    enroll(tmpRepo);
    setKill(true);
    backlogItems = [makeItem('i1', tmpRepo)];
    const cfg = makeCfg();

    const t = await tick(cfg, { dryRun: false });

    expect(t.reason).toBe('kill-switch');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('returns budget-exhausted when daily spend >= budget', async () => {
    enroll(tmpRepo);
    backlogItems = [makeItem('i1', tmpRepo)];
    // Pre-spend the budget by writing a daemon state that already hit the cap.
    // dailyBudgetUsd must be > 0 (resolveCfg rejects 0); set it to 0.01 and
    // pre-fill state so todaySpentUsd >= budget.
    const cfg = makeCfg({ dailyBudgetUsd: 0.01 });
    // Seed state with spending equal to the budget so the check fires immediately.
    const { saveDaemonState, loadDaemonState, resetDayIfNeeded } = await import('../src/core/daemon/state.js');
    let s = loadDaemonState();
    s = resetDayIfNeeded(s);
    s.todaySpentUsd = 0.01; // already at cap
    saveDaemonState(s);

    const t = await tick(cfg, { dryRun: false });

    expect(t.reason).toBe('budget-exhausted');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('returns no-backlog when backlog is empty', async () => {
    enroll(tmpRepo);
    backlogItems = [];
    const cfg = makeCfg();

    const t = await tick(cfg, { dryRun: false });

    expect(t.reason).toBe('no-backlog');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('returns no-enrolled-repos when nothing is enrolled', async () => {
    // No enroll call
    backlogItems = [makeItem('i1', tmpRepo)];
    const cfg = makeCfg();

    const t = await tick(cfg, { dryRun: false });

    expect(t.reason).toBe('no-enrolled-repos');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Block 2: Tiered concurrency — local and cloud caps respected simultaneously
// ---------------------------------------------------------------------------

describe('M116 — tiered concurrency', () => {
  it('respects local≤2 and cloud≤4 with total≤6 under a mixed backlog', async () => {
    enroll(tmpRepo);

    // 4 items routed to local, 4 to cloud
    backlogItems = [
      makeItem('l1', tmpRepo), makeItem('l2', tmpRepo),
      makeItem('l3', tmpRepo), makeItem('l4', tmpRepo),
      makeItem('c1', tmpRepo), makeItem('c2', tmpRepo),
      makeItem('c3', tmpRepo), makeItem('c4', tmpRepo),
    ];

    // Track peak concurrent dispatches per tier
    let peakLocal = 0;
    let peakCloud = 0;
    let curLocal = 0;
    let curCloud = 0;

    const tierMap: Record<string, 'local' | 'frontier'> = {
      l1: 'local', l2: 'local', l3: 'local', l4: 'local',
      c1: 'frontier', c2: 'frontier', c3: 'frontier', c4: 'frontier',
    };

    engineTierOfImpl = (engine: string) => {
      // engineTierOf is called with the resolved backend; we use the routeBackend mock
      // to embed tier info in the backend name itself for this test.
      return engine.startsWith('cloud-') ? 'frontier' : 'local';
    };

    // Route: local items → 'builtin' (local tier); cloud items → 'cloud-agent' (frontier)
    mockRouteBackend.mockImplementation((item: WorkItem) => {
      const isCloud = item.id.startsWith('c');
      return {
        backend: isCloud ? 'cloud-agent' : 'builtin',
        tier: isCloud ? 'frontier' : 'local',
        reason: 'test',
      };
    });

    // Swarm stub that tracks concurrent execution
    mockRunSwarm.mockImplementation((opts: { goal: string }, _cfg: unknown, runOpts: { project: string }) => {
      curLocal++;
      peakLocal = Math.max(peakLocal, curLocal);
      return swarmStub(tmpRepo, 10)().finally(() => { curLocal--; });
    });
    mockRunGoal.mockImplementation(async (goal: string) => {
      curCloud++;
      peakCloud = Math.max(peakCloud, curCloud);
      await new Promise((r) => setTimeout(r, 10));
      curCloud--;
      createProposal({
        repo: tmpRepo,
        origin: 'swarm',
        kind: 'patch',
        title: 'cloud proposal',
        summary: 'cloud',
        diff: 'diff\n',
      });
      return { id: `cloud-${Date.now()}`, status: 'done', usage: { estCostUsd: 0 } };
    });

    const cfg = makeCfg({
      perTickItems: 8,
      parallel: 6, // batch parallel — should be capped by tier budgets
      concurrency: { local: 2, cloud: 4, total: 6 },
    });

    await tick(cfg, { dryRun: false });

    // Peak local in-flight must never exceed local cap
    expect(peakLocal).toBeLessThanOrEqual(2);
    // Peak cloud in-flight must never exceed cloud cap
    expect(peakCloud).toBeLessThanOrEqual(4);
    // Total dispatches happened
    expect(mockRunSwarm.mock.calls.length + mockRunGoal.mock.calls.length).toBeGreaterThan(0);
  });

  it('cloud throttle does not block local items from dispatching', async () => {
    enroll(tmpRepo);

    backlogItems = [
      makeItem('l1', tmpRepo),
      makeItem('l2', tmpRepo),
      makeItem('c1', tmpRepo), // cloud — will be throttled
    ];

    // Cloud routes → 'claude' (subscription engine)
    mockRouteBackend.mockImplementation((item: WorkItem) => ({
      backend: item.id.startsWith('c') ? 'claude' : 'builtin',
      tier: item.id.startsWith('c') ? 'frontier' : 'local',
      reason: 'test',
    }));
    engineTierOfImpl = (engine) => (engine === 'claude' ? 'frontier' : 'local');

    // Throttle cloud — subscriptionAllows returns false for claude
    subscriptionAllowedImpl = () => false;

    const cfg = makeCfg({ perTickItems: 3, parallel: 3, concurrency: { local: 2, cloud: 2, total: 4 } });

    await tick(cfg, { dryRun: false });

    // Local items were dispatched via runSwarm
    expect(mockRunSwarm.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Cloud item was throttled — runGoal NOT called
    expect(mockRunGoal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Block 3: Continuous mode — drains backlog without fixed inter-tick sleep
// ---------------------------------------------------------------------------

describe('M116 — continuous mode', () => {
  it('runs multiple ticks until backlog empty then kill-switch stops it', async () => {
    enroll(tmpRepo);

    // Provide two batches then empty; kill-switch fires on empty backlog.
    let buildCall = 0;
    mockBuildBacklog.mockImplementation(async () => {
      buildCall++;
      let items: WorkItem[] = [];
      if (buildCall === 1) {
        items = [makeItem('a1', tmpRepo), makeItem('a2', tmpRepo)];
      } else if (buildCall === 2) {
        items = [makeItem('b1', tmpRepo)];
      } else {
        // Empty — set kill-switch so the idle-backoff branch terminates.
        setKill(true);
      }
      return { generatedAt: new Date().toISOString(), repos: [tmpRepo], items };
    });

    const cfg = makeCfg({
      mode: 'continuous',
      perTickItems: 5,
      maxConcurrent: 4,
      concurrency: { local: 2, cloud: 4, total: 4 },
      idleBackoffMs: 10, // very short for test speed
      dailyBudgetUsd: 100,
    });
    mockLoadConfig.mockReturnValue(cfg);

    await runDaemon(cfg, { once: false, dryRun: false });

    // Multiple ticks ran (at least 2 build calls for non-empty batches + 1 empty)
    expect(buildCall).toBeGreaterThanOrEqual(3);
    // Items from both batches were dispatched
    expect(mockRunSwarm.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('continuous mode stops immediately when kill-switch is set between ticks', async () => {
    enroll(tmpRepo);

    let tickCount = 0;
    mockBuildBacklog.mockImplementation(async () => {
      tickCount++;
      if (tickCount >= 2) {
        // Set kill switch so loop halts after second tick
        setKill(true);
      }
      return {
        generatedAt: new Date().toISOString(),
        repos: [tmpRepo],
        items: [makeItem(`i${tickCount}`, tmpRepo)],
      };
    });

    const cfg = makeCfg({
      mode: 'continuous',
      perTickItems: 1,
      idleBackoffMs: 5,
      dailyBudgetUsd: 100,
    });
    mockLoadConfig.mockReturnValue(cfg);

    await runDaemon(cfg, { once: false, dryRun: false });

    // Stopped quickly — no runaway looping
    expect(tickCount).toBeLessThanOrEqual(3);
  });

  it('continuous mode terminates via once=true (single-tick, no loop)', async () => {
    enroll(tmpRepo);
    backlogItems = [makeItem('i1', tmpRepo), makeItem('i2', tmpRepo)];

    const cfg = makeCfg({
      mode: 'continuous',
      perTickItems: 5,
      idleBackoffMs: 5,
      dailyBudgetUsd: 100,
    });
    mockLoadConfig.mockReturnValue(cfg);

    // once=true always exits after one tick regardless of mode
    await runDaemon(cfg, { once: true, dryRun: false });

    // Only one build call (once=true → one tick)
    expect(mockBuildBacklog.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Block 4: Kill-switch halts mid-pool (batch mode)
// ---------------------------------------------------------------------------

describe('M116 — kill-switch halts mid-pool', () => {
  it('items after kill-switch fires are skipped (dispatched=false)', async () => {
    enroll(tmpRepo);

    backlogItems = [
      makeItem('i1', tmpRepo),
      makeItem('i2', tmpRepo),
      makeItem('i3', tmpRepo),
    ];

    let callCount = 0;
    mockRunSwarm.mockImplementation(async () => {
      callCount++;
      // Set kill switch after the first swarm starts
      if (callCount === 1) setKill(true);
      createProposal({
        repo: tmpRepo, origin: 'swarm', kind: 'patch',
        title: 'p', summary: 's', diff: 'd\n',
      });
      return { id: `sw-${Date.now()}`, status: 'done', goal: 'g', result: 'r', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    const cfg = makeCfg({ perTickItems: 3, parallel: 1 });
    await tick(cfg, { dryRun: false });

    // Only the first swarm ran; subsequent items saw kill-switch=ON
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Block 5: Backward-compatibility proof
// ---------------------------------------------------------------------------

describe('M116 — backward-compatible: no new config = identical behavior', () => {
  it('no mode/concurrency config → bounded by parallel only (no tier splitting)', async () => {
    enroll(tmpRepo);

    backlogItems = [
      makeItem('x1', tmpRepo),
      makeItem('x2', tmpRepo),
      makeItem('x3', tmpRepo),
    ];
    // No mode or concurrency keys — strictly the old fields
    const cfg: AshlrConfig = {
      version: 1,
      daemon: {
        dailyBudgetUsd: 10,
        perTickItems: 3,
        parallel: 2,
        intervalMs: 100,
      },
    } as AshlrConfig;
    mockLoadConfig.mockReturnValue(cfg);

    // Track peak concurrent swarm calls (parallel is a concurrency cap, not a total cap)
    let peakConcurrent = 0;
    let concurrent = 0;
    mockRunSwarm.mockImplementation(swarmStub(tmpRepo, 20));
    // Wrap to count concurrency
    const origImpl = mockRunSwarm.getMockImplementation()!;
    mockRunSwarm.mockImplementation(async (...args: unknown[]) => {
      concurrent++;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      try {
        return await origImpl(...args);
      } finally {
        concurrent--;
      }
    });

    const t = await tick(cfg, { dryRun: false });

    expect(t.reason).toBe('ok');
    // Peak concurrent must never exceed parallel=2
    expect(peakConcurrent).toBeLessThanOrEqual(2);
    // All perTickItems=3 may have been dispatched (sequentially after one slot freed)
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(3);
    // itemsConsidered is at most perTickItems=3
    expect(t.itemsConsidered).toBeLessThanOrEqual(3);
  });

  it('runDaemon once=true with no new keys behaves identically to pre-M116', async () => {
    enroll(tmpRepo);
    backlogItems = [makeItem('z1', tmpRepo)];

    const cfg: AshlrConfig = {
      version: 1,
      daemon: {
        dailyBudgetUsd: 5,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 100,
      },
    } as AshlrConfig;
    mockLoadConfig.mockReturnValue(cfg);

    await runDaemon(cfg, { once: true, dryRun: false });

    expect(mockRunSwarm.mock.calls.length).toBe(1);
  });
});
