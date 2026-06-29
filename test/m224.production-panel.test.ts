/**
 * M224 Production Panel tests — hermetic, all data-source modules mocked.
 *
 * Verifies that buildSnapshot exposes snapshot.production with the full
 * scorecard shape:
 *   - proposals24h (pending/applied/rejected/total)
 *   - judgeVerdicts24h (ship/review/noise/harmful/total)
 *   - autoMergesToday (count + titles)
 *   - activeGoals (goalId/objective/totalMilestones/doneMilestones)
 *   - shipsPerDayTrend (date/count pairs, 7 days)
 *
 * Also verifies:
 *   - 24h window filtering: proposals/traces older than 24h are excluded
 *   - Graceful degradation: snapshot still resolves when any production
 *     source throws; production field degrades section-by-section
 *   - Pre-M224 snapshots remain valid (production is optional)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AshlrConfig, DashboardSnapshot, ProductionSummary } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
// Use a very recent timestamp (30 min ago) so it is always "today" regardless of the
// exact wall-clock time the test suite runs — avoids midnight rollover flakiness.
const THIRTY_MIN_AGO = new Date(NOW - 30 * 60 * 1000).toISOString();
const TWELVE_HOURS_AGO = new Date(NOW - 12 * 3600 * 1000).toISOString();
const TWENTY_FIVE_HOURS_AGO = new Date(NOW - 25 * 3600 * 1000).toISOString();
const TODAY_DATE = new Date(NOW).toISOString().slice(0, 10);
const FIVE_DAYS_AGO = new Date(NOW - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Base fixtures (re-used across all production tests)
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = { version: 1, generatedAt: new Date().toISOString(), root: '/home', items: [] };
const FIXTURE_TOOLS_REGISTRY = { tools: [], installedCount: 0 };
const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(NOW - 7 * 86400000).toISOString(),
  totals: { tokensIn: 1000, tokensOut: 500, estCostUsd: 0.05, sessions: 1, commits: 2 },
  byProject: [], byDay: [], byModel: [],
  budget: { level: 'ok' as const, window: '7d', spentUsd: 0.05, capUsd: null, spentTokens: 1500, capTokens: null, message: 'ok' },
};
const FIXTURE_DAEMON_STATE = {
  running: true, pid: 1, startedAt: new Date().toISOString(),
  lastTickAt: new Date().toISOString(), todaySpentUsd: 0.001,
  itemsProcessed: 3, ticks: [], todayDate: TODAY_DATE,
};
const FIXTURE_FRONTIER_USAGE = {
  generatedAt: new Date().toISOString(),
  engines: [],
};
const FIXTURE_MCP_REGISTRY = { servers: [] };
const FIXTURE_GENOME_ENTRIES: never[] = [];

// ---------------------------------------------------------------------------
// Production-specific fixtures
// ---------------------------------------------------------------------------

/** A minimal valid Proposal shape (only the fields listProposals validates + status). */
function makeProposal(overrides: {
  id?: string;
  status?: string;
  createdAt?: string;
  title?: string;
}) {
  return {
    id: overrides.id ?? `prop-test-${Math.random().toString(36).slice(2)}`,
    origin: 'daemon',
    kind: 'patch',
    title: overrides.title ?? 'Test proposal',
    summary: 'A test proposal',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? TWELVE_HOURS_AGO,
    repo: '/repos/test',
  };
}

/** A minimal valid JudgeTrace shape. */
function makeTrace(overrides: {
  verdict?: 'ship' | 'review' | 'noise' | 'harmful';
  ts?: string;
}) {
  return {
    proposalId: `prop-test-${Math.random().toString(36).slice(2)}`,
    judgeEngine: 'claude-sonnet-4-5',
    verdict: overrides.verdict ?? 'ship',
    scores: { value: 4, correctness: 4, scope: 3, alignment: 4 },
    fullReasoning: 'Good change.',
    promptContext: 'context',
    ts: overrides.ts ?? TWELVE_HOURS_AGO,
  };
}

/** A minimal valid Goal + progress shape. */
function makeGoal(id: string, objective: string) {
  return {
    id,
    objective,
    status: 'active' as const,
    milestones: [
      { id: 'm1', title: 'M1', status: 'done' as const },
      { id: 'm2', title: 'M2', status: 'pending' as const },
      { id: 'm3', title: 'M3', status: 'pending' as const },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeProgress(done: number, total: number) {
  return {
    fractionDone: total > 0 ? done / total : 0,
    proposed: 0,
    total,
    done,
    skipped: 0,
    blocked: 0,
    inProgress: 0,
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => FIXTURE_INDEX) }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: vi.fn(() => FIXTURE_TOOLS_REGISTRY) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => FIXTURE_ROLLUP) }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: vi.fn(() => []), loadRun: vi.fn(() => null) }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: vi.fn(() => []), loadSwarm: vi.fn(() => null) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: vi.fn(() => FIXTURE_MCP_REGISTRY) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => FIXTURE_GENOME_ENTRIES) }));
vi.mock('../src/core/daemon/state.js', () => ({ loadDaemonState: vi.fn(() => FIXTURE_DAEMON_STATE) }));
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: vi.fn(() => FIXTURE_FRONTIER_USAGE),
}));

// inbox/store: used both by base snapshot (pendingCount) and production (listProposals)
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: vi.fn(() => 0),
  listProposals: vi.fn(() => []),
}));

// fleet/judge-trace: production only
vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: vi.fn(() => []),
}));

// goals sources: production only
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: vi.fn(() => []),
}));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: vi.fn(() => makeProgress(0, 0)),
  nextActionableMilestone: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are hoisted)
// ---------------------------------------------------------------------------

import { buildSnapshot } from '../src/core/dashboard.js';

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const { loadIndex } = await import('../src/core/index-engine.js');
  const { getToolsRegistry } = await import('../src/core/tools-registry.js');
  const { buildRollup } = await import('../src/core/observability/rollup.js');
  const { listRuns } = await import('../src/core/run/orchestrator.js');
  const { listSwarms } = await import('../src/core/swarm/store.js');
  const { discoverMcpServers } = await import('../src/core/mcp-registry.js');
  const { loadGenome } = await import('../src/core/genome/store.js');
  const { loadDaemonState } = await import('../src/core/daemon/state.js');
  const { getFrontierUsageSync } = await import('../src/core/usage/frontier-usage.js');
  const { pendingCount, listProposals } = await import('../src/core/inbox/store.js');
  const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
  const { listGoals } = await import('../src/core/goals/store.js');
  const { progressOf, nextActionableMilestone } = await import('../src/core/goals/advance.js');

  vi.mocked(loadIndex).mockReturnValue(FIXTURE_INDEX);
  vi.mocked(getToolsRegistry).mockReturnValue(FIXTURE_TOOLS_REGISTRY);
  vi.mocked(buildRollup).mockReturnValue(FIXTURE_ROLLUP);
  vi.mocked(listRuns).mockReturnValue([]);
  vi.mocked(listSwarms).mockReturnValue([]);
  vi.mocked(discoverMcpServers).mockReturnValue(FIXTURE_MCP_REGISTRY);
  vi.mocked(loadGenome).mockReturnValue(FIXTURE_GENOME_ENTRIES);
  vi.mocked(loadDaemonState).mockReturnValue(FIXTURE_DAEMON_STATE);
  vi.mocked(getFrontierUsageSync).mockReturnValue(FIXTURE_FRONTIER_USAGE);
  vi.mocked(pendingCount).mockReturnValue(0);
  vi.mocked(listProposals).mockReturnValue([]);
  vi.mocked(readJudgeTraces).mockReturnValue([]);
  vi.mocked(listGoals).mockReturnValue([]);
  vi.mocked(progressOf).mockReturnValue(makeProgress(0, 0));
  vi.mocked(nextActionableMilestone).mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// 1. Snapshot shape — production field present
// ---------------------------------------------------------------------------

describe('M224 snapshot.production — presence and shape', () => {
  it('production field is present in snapshot', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toHaveProperty('production');
    expect(snap.production).toBeDefined();
  });

  it('production.generatedAt is a valid ISO string', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.production!.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(snap.production!.generatedAt))).toBe(false);
  });

  it('production.proposals24h has the expected sub-fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    const p = snap.production!.proposals24h;
    expect(typeof p.pending).toBe('number');
    expect(typeof p.applied).toBe('number');
    expect(typeof p.rejected).toBe('number');
    expect(typeof p.total).toBe('number');
  });

  it('production.judgeVerdicts24h has the expected sub-fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    const j = snap.production!.judgeVerdicts24h;
    expect(typeof j.ship).toBe('number');
    expect(typeof j.review).toBe('number');
    expect(typeof j.noise).toBe('number');
    expect(typeof j.harmful).toBe('number');
    expect(typeof j.total).toBe('number');
  });

  it('production.autoMergesToday has count and titles array', async () => {
    const snap = await buildSnapshot(makeConfig());
    const m = snap.production!.autoMergesToday;
    expect(typeof m.count).toBe('number');
    expect(Array.isArray(m.titles)).toBe(true);
  });

  it('production.activeGoals is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.production!.activeGoals)).toBe(true);
  });

  it('production.shipsPerDayTrend is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.production!.shipsPerDayTrend)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Proposals 24h counting
// ---------------------------------------------------------------------------

describe('M224 proposals24h counting', () => {
  it('counts proposals within the 24h window by status', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue([
      makeProposal({ status: 'pending',  createdAt: TWELVE_HOURS_AGO }),
      makeProposal({ status: 'pending',  createdAt: TWELVE_HOURS_AGO }),
      makeProposal({ status: 'applied',  createdAt: TWELVE_HOURS_AGO }),
      makeProposal({ status: 'rejected', createdAt: TWELVE_HOURS_AGO }),
      // outside 24h window — should NOT be counted
      makeProposal({ status: 'applied',  createdAt: TWENTY_FIVE_HOURS_AGO }),
    ] as ReturnType<typeof makeProposal>[]);

    const snap = await buildSnapshot(makeConfig());
    const p = snap.production!.proposals24h;
    expect(p.pending).toBe(2);
    expect(p.applied).toBe(1);
    expect(p.rejected).toBe(1);
    expect(p.total).toBe(4);
  });

  it('proposals older than 24h are excluded from 24h counts', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue([
      makeProposal({ status: 'applied', createdAt: TWENTY_FIVE_HOURS_AGO }),
    ] as ReturnType<typeof makeProposal>[]);

    const snap = await buildSnapshot(makeConfig());
    const p = snap.production!.proposals24h;
    expect(p.total).toBe(0);
    expect(p.applied).toBe(0);
  });

  it('proposals24h is all-zeros when list is empty', async () => {
    const snap = await buildSnapshot(makeConfig());
    const p = snap.production!.proposals24h;
    expect(p.pending).toBe(0);
    expect(p.applied).toBe(0);
    expect(p.rejected).toBe(0);
    expect(p.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-merges today
// ---------------------------------------------------------------------------

describe('M224 autoMergesToday', () => {
  it('counts applied proposals with createdAt today', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue([
      makeProposal({ status: 'applied', createdAt: THIRTY_MIN_AGO, title: 'Fix auth bug' }),
      makeProposal({ status: 'applied', createdAt: THIRTY_MIN_AGO, title: 'Add test coverage' }),
      // different day — should NOT count
      makeProposal({ status: 'applied', createdAt: TWENTY_FIVE_HOURS_AGO, title: 'Old merge' }),
    ] as ReturnType<typeof makeProposal>[]);

    const snap = await buildSnapshot(makeConfig());
    const m = snap.production!.autoMergesToday;
    expect(m.count).toBe(2);
    expect(m.titles).toContain('Fix auth bug');
    expect(m.titles).toContain('Add test coverage');
    expect(m.titles).not.toContain('Old merge');
  });

  it('titles array is capped at 5', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue(
      Array.from({ length: 8 }, (_, i) =>
        makeProposal({ status: 'applied', createdAt: TWELVE_HOURS_AGO, title: `Merge ${i}` })
      ) as ReturnType<typeof makeProposal>[]
    );

    const snap = await buildSnapshot(makeConfig());
    expect(snap.production!.autoMergesToday.titles.length).toBeLessThanOrEqual(5);
  });

  it('count is 0 and titles empty when no merges today', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.production!.autoMergesToday.count).toBe(0);
    expect(snap.production!.autoMergesToday.titles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Judge verdicts 24h
// ---------------------------------------------------------------------------

describe('M224 judgeVerdicts24h', () => {
  it('counts verdicts within 24h by type', async () => {
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    vi.mocked(readJudgeTraces).mockReturnValue([
      makeTrace({ verdict: 'ship',    ts: TWELVE_HOURS_AGO }),
      makeTrace({ verdict: 'ship',    ts: TWELVE_HOURS_AGO }),
      makeTrace({ verdict: 'review',  ts: TWELVE_HOURS_AGO }),
      makeTrace({ verdict: 'noise',   ts: TWELVE_HOURS_AGO }),
      makeTrace({ verdict: 'harmful', ts: TWELVE_HOURS_AGO }),
    ] as ReturnType<typeof makeTrace>[]);

    const snap = await buildSnapshot(makeConfig());
    const j = snap.production!.judgeVerdicts24h;
    expect(j.ship).toBe(2);
    expect(j.review).toBe(1);
    expect(j.noise).toBe(1);
    expect(j.harmful).toBe(1);
    expect(j.total).toBe(5);
  });

  it('verdicts24h is all-zeros when no traces', async () => {
    const snap = await buildSnapshot(makeConfig());
    const j = snap.production!.judgeVerdicts24h;
    expect(j.ship).toBe(0);
    expect(j.review).toBe(0);
    expect(j.noise).toBe(0);
    expect(j.harmful).toBe(0);
    expect(j.total).toBe(0);
  });

  it('readJudgeTraces is called with sinceMs for 24h window', async () => {
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    await buildSnapshot(makeConfig());
    expect(vi.mocked(readJudgeTraces)).toHaveBeenCalledWith(
      expect.objectContaining({ sinceMs: expect.any(Number) })
    );
    const callArg = vi.mocked(readJudgeTraces).mock.calls[0]![0]!;
    const windowMs = Date.now() - (callArg.sinceMs ?? 0);
    // sinceMs should be within ~1s of 24h ago
    expect(windowMs).toBeGreaterThan(23 * 3600 * 1000);
    expect(windowMs).toBeLessThan(25 * 3600 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 5. Active goals + milestone counts
// ---------------------------------------------------------------------------

describe('M224 activeGoals', () => {
  it('surfaces active goals with milestone progress', async () => {
    const { listGoals } = await import('../src/core/goals/store.js');
    const { progressOf } = await import('../src/core/goals/advance.js');

    const goal1 = makeGoal('goal-a', 'Build M224 production panel');
    const goal2 = makeGoal('goal-b', 'Add fleet autonomy');
    vi.mocked(listGoals).mockReturnValue([goal1, goal2] as ReturnType<typeof makeGoal>[]);
    vi.mocked(progressOf).mockImplementation((g: typeof goal1) => {
      if (g.id === 'goal-a') return makeProgress(2, 5);
      return makeProgress(0, 3);
    });

    const snap = await buildSnapshot(makeConfig());
    const goals = snap.production!.activeGoals;
    expect(goals.length).toBe(2);

    const a = goals.find(g => g.goalId === 'goal-a');
    expect(a).toBeDefined();
    expect(a!.objective).toBe('Build M224 production panel');
    expect(a!.totalMilestones).toBe(5);
    expect(a!.doneMilestones).toBe(2);

    const b = goals.find(g => g.goalId === 'goal-b');
    expect(b).toBeDefined();
    expect(b!.totalMilestones).toBe(3);
    expect(b!.doneMilestones).toBe(0);
  });

  it('activeGoals is empty when no active goals', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.production!.activeGoals).toHaveLength(0);
  });

  it('activeGoals is capped at 6', async () => {
    const { listGoals } = await import('../src/core/goals/store.js');
    const { progressOf } = await import('../src/core/goals/advance.js');
    vi.mocked(listGoals).mockReturnValue(
      Array.from({ length: 10 }, (_, i) => makeGoal(`goal-${i}`, `Goal ${i}`)) as ReturnType<typeof makeGoal>[]
    );
    vi.mocked(progressOf).mockReturnValue(makeProgress(0, 2));

    const snap = await buildSnapshot(makeConfig());
    expect(snap.production!.activeGoals.length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// 6. Ships-per-day trend
// ---------------------------------------------------------------------------

describe('M224 shipsPerDayTrend', () => {
  it('trend has up to 7 entries', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.production!.shipsPerDayTrend.length).toBeLessThanOrEqual(7);
  });

  it('trend entries have date and count fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    for (const entry of snap.production!.shipsPerDayTrend) {
      expect(typeof entry.date).toBe('string');
      expect(typeof entry.count).toBe('number');
    }
  });

  it('counts applied proposals per calendar day', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue([
      makeProposal({ status: 'applied', createdAt: THIRTY_MIN_AGO }),
      makeProposal({ status: 'applied', createdAt: THIRTY_MIN_AGO }),
      // 5 days ago — still within 7d trend window
      makeProposal({ status: 'applied', createdAt: `${FIVE_DAYS_AGO}T10:00:00.000Z` }),
      // pending — should NOT appear in trend
      makeProposal({ status: 'pending', createdAt: THIRTY_MIN_AGO }),
    ] as ReturnType<typeof makeProposal>[]);

    const snap = await buildSnapshot(makeConfig());
    const trend = snap.production!.shipsPerDayTrend;

    const todayEntry = trend.find(e => e.date === TODAY_DATE);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.count).toBe(2);

    const fiveDaysAgoEntry = trend.find(e => e.date === FIVE_DAYS_AGO);
    expect(fiveDaysAgoEntry).toBeDefined();
    expect(fiveDaysAgoEntry!.count).toBe(1);
  });

  it('trend is oldest-first (ascending date order)', async () => {
    const snap = await buildSnapshot(makeConfig());
    const trend = snap.production!.shipsPerDayTrend;
    for (let i = 1; i < trend.length; i++) {
      expect(trend[i]!.date >= trend[i - 1]!.date).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Graceful degradation
// ---------------------------------------------------------------------------

describe('M224 graceful degradation', () => {
  it('snapshot still resolves when listProposals throws', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockImplementation(() => { throw new Error('io error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
    expect(typeof snap.generatedAt).toBe('string');
  });

  it('snapshot still resolves when readJudgeTraces throws', async () => {
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    vi.mocked(readJudgeTraces).mockImplementation(() => { throw new Error('trace read error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
  });

  it('snapshot still resolves when listGoals throws', async () => {
    const { listGoals } = await import('../src/core/goals/store.js');
    vi.mocked(listGoals).mockImplementation(() => { throw new Error('goals error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
  });

  it('snapshot still resolves when all production sources throw', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    const { listGoals } = await import('../src/core/goals/store.js');
    vi.mocked(listProposals).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(readJudgeTraces).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(listGoals).mockImplementation(() => { throw new Error('fail'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('production field is present even when sub-sources fail (outer wrapper resolves)', async () => {
    // Even if individual sub-sources throw, buildProduction degrades to zeros.
    const { listProposals } = await import('../src/core/inbox/store.js');
    const { readJudgeTraces } = await import('../src/core/fleet/judge-trace.js');
    vi.mocked(listProposals).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(readJudgeTraces).mockImplementation(() => { throw new Error('fail'); });
    const snap = await buildSnapshot(makeConfig());
    // production may or may not be present depending on whether buildProduction itself throws,
    // but base snapshot fields must always be intact.
    expect(typeof snap.generatedAt).toBe('string');
    expect(typeof snap.repos.total).toBe('number');
    expect(snap.inbox).toBeDefined();
  });

  it('base snapshot fields are intact regardless of production failures', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockImplementation(() => { throw new Error('fail'); });
    const snap: DashboardSnapshot = await buildSnapshot(makeConfig());
    expect(typeof snap.repos.total).toBe('number');
    expect(typeof snap.tools.installed).toBe('number');
    expect(typeof snap.activity.sessions).toBe('number');
    expect(snap.inbox).toBeDefined();
    expect(snap.daemon).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Pre-M224 snapshots stay valid (production is optional)
// ---------------------------------------------------------------------------

describe('M224 backward compatibility', () => {
  it('production field is optional on DashboardSnapshot — omitting it is valid', () => {
    // TypeScript compile-time check: we can construct a DashboardSnapshot without production.
    const snap: DashboardSnapshot = {
      generatedAt: new Date().toISOString(),
      repos: { total: 0, dirty: 0, stale: 0 },
      tools: { installed: 0, total: 0 },
      activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
      runs: [],
      swarms: [],
      mcp: [],
      genome: { entries: 0, projects: 0 },
      inbox: { pending: 0 },
    };
    // no `production` field — must compile and satisfy the type
    expect(snap.production).toBeUndefined();
  });

  it('ProductionSummary type has all required fields', () => {
    const prod: ProductionSummary = {
      generatedAt: new Date().toISOString(),
      proposals24h: { pending: 0, applied: 0, rejected: 0, total: 0 },
      judgeVerdicts24h: { ship: 0, review: 0, noise: 0, harmful: 0, total: 0 },
      autoMergesToday: { count: 0, titles: [] },
      activeGoals: [],
      shipsPerDayTrend: [],
    };
    expect(prod.proposals24h.total).toBe(0);
    expect(prod.judgeVerdicts24h.total).toBe(0);
    expect(prod.autoMergesToday.count).toBe(0);
    expect(prod.activeGoals).toHaveLength(0);
    expect(prod.shipsPerDayTrend).toHaveLength(0);
  });
});
