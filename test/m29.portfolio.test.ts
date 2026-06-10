/**
 * M29 portfolio tests — hermetic, all portfolio data-source modules mocked.
 *
 * Tests the OPTIONAL `portfolio` section that buildSnapshot() (src/core/
 * dashboard.ts) now populates by READ-ONLY aggregation of the v2 sources:
 *   - health  (M27 computeReport)   — ENROLLMENT-SCOPED
 *   - goals   (M28 listGoals/progressOf/nextActionableMilestone)
 *   - backlog (M22 loadBacklog)
 *   - cost    (M19 buildForecast)
 *   - effectiveness (M26 listReports)
 *
 * Invariants proven here:
 *   - portfolio is populated from seeded sources (correct mapping + caps).
 *   - EMPTY ENROLLMENT => empty health (reposScored:0, worstRepos:[]) and empty
 *     goals, with NO portfolio disk scan (the mocked sources are the only reads).
 *   - A THROWN sub-source degrades only its own section; the whole snapshot
 *     still resolves and the other sections remain intact (never-throws).
 *   - List sizes are bounded by the M29 caps.
 *
 * The base M13 sections are mocked to benign empties; we assert only on the new
 * `portfolio` section. NEVER touches the real ~/.ashlr or any real repo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AshlrConfig,
  HealthReport,
  HealthScore,
  Goal,
  GoalProgress,
  Milestone,
  Backlog,
  WorkItem,
  CostForecast,
  ReflectionReport,
} from '../src/core/types.js';

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
// Portfolio source fixtures
// ---------------------------------------------------------------------------

function makeScore(repo: string, score: number, grade: HealthScore['grade']): HealthScore {
  return {
    repo,
    score,
    grade,
    dimensions: [],
    conventions: [],
    worstOffenders: [],
    ts: '2026-06-08T07:00:00.000Z',
  };
}

const FIXTURE_HEALTH: HealthReport = {
  generatedAt: '2026-06-08T07:00:00.000Z',
  repos: ['/r/a', '/r/b', '/r/c'],
  // computeReport ranks worst-first; supply mixed order to prove our sort.
  scores: [
    makeScore('/r/b', 55, 'F'),
    makeScore('/r/a', 92, 'A'),
    makeScore('/r/c', 71, 'C'),
  ],
  averageScore: 72.67,
  averageGrade: 'C',
  delta: {},
};

const FIXTURE_MILESTONES: Milestone[] = [
  {
    id: 'm1',
    title: 'Scaffold module',
    detail: '',
    order: 0,
    status: 'done',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
  {
    id: 'm2',
    title: 'Wire the API',
    detail: '',
    order: 1,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  },
];

const FIXTURE_GOAL: Goal = {
  id: 'goal-1',
  objective: 'Ship the surfacing pillar',
  project: '/r/a',
  status: 'active',
  milestones: FIXTURE_MILESTONES,
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
};

const FIXTURE_PROGRESS: GoalProgress = {
  goalId: 'goal-1',
  total: 2,
  byStatus: { done: 1, pending: 1 },
  proposed: 0,
  done: 1,
  fractionDone: 0.5,
  nextActionableId: 'm2',
};

function makeWorkItem(id: string, repo: string, title: string, score: number): WorkItem {
  return {
    id,
    repo,
    source: 'todos',
    title,
    detail: '',
    value: 3,
    effort: 2,
    score,
    tags: [],
    ts: '2026-06-08T00:00:00.000Z',
  };
}

const FIXTURE_BACKLOG: Backlog = {
  generatedAt: '2026-06-08T00:00:00.000Z',
  repos: ['/r/a'],
  items: [
    makeWorkItem('w1', '/r/a', 'Low priority', 2),
    makeWorkItem('w2', '/r/a', 'High priority', 9),
    makeWorkItem('w3', '/r/a', 'Mid priority', 5),
  ],
};

const FIXTURE_FORECAST: CostForecast = {
  window: '7d',
  spentUsd: 1.23,
  localSavingsUsd: 4.56,
  projectedMonthlyUsd: 7.89,
};

const FIXTURE_REFLECT: ReflectionReport = {
  generatedAt: '2026-06-08T07:00:00.000Z',
  since: '2026-06-01T07:00:00.000Z',
  window: '7d',
  swarmsAnalyzed: 10,
  swarmsDone: 8,
  swarmsFailed: 2,
  successRate: 0.8,
  avgCostUsd: 0.1,
  avgTokens: 1000,
  totalCostUsd: 1.0,
  localShare: 0.9,
  topFailures: [],
  goalCategories: [],
  delta: {
    previousAt: '2026-06-01T07:00:00.000Z',
    effectivenessPct: 12,
    costPct: -18,
    localSharePct: 5,
    headline: 'Up 12 points more effective',
  },
  genome: { totalEntries: 0, projects: 0, hubEntries: 0, sizeBytes: 0, lastLearnedAt: null, embeddingsAvailable: false },
};

// ---------------------------------------------------------------------------
// Base M13 source mocks (benign empties — we only assert on `portfolio`)
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => null) }));
vi.mock('../src/core/tools-registry.js', () => ({
  getToolsRegistry: vi.fn(() => ({ tools: [], installedCount: 0 })),
}));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: vi.fn(() => []) }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: vi.fn(() => []) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: vi.fn(() => ({ servers: [] })) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => []) }));
vi.mock('../src/core/inbox/store.js', () => ({ pendingCount: vi.fn(() => 0) }));
vi.mock('../src/core/daemon/state.js', () => ({
  loadDaemonState: vi.fn(() => ({ running: false, todaySpentUsd: 0 })),
}));
// rollup is used both by the base activity section AND (indirectly) by forecast;
// forecast is mocked directly below so the rollup stub here only feeds activity.
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => ({
  window: '7d',
  since: '2026-06-01T00:00:00.000Z',
  totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
  byProject: [], byDay: [], byModel: [],
  budget: { level: 'ok', window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: 'ok' },
})) }));

// ---------------------------------------------------------------------------
// M29 portfolio source mocks
// ---------------------------------------------------------------------------

// M29 HIGH-SEV FIX: the portfolio health section now reads the LATEST PERSISTED
// HealthReport via quality/store.loadPreviousReport() (a bounded file read) and
// NEVER runs the live computeReport() scanners on the per-tick snapshot path. We
// mock the store, not health.js, and additionally assert (see "no scan" test
// below) that health.js's computeReport is NEVER imported/called by buildSnapshot.
vi.mock('../src/core/quality/store.js', () => ({
  loadPreviousReport: vi.fn(() => FIXTURE_HEALTH),
}));
const computeReportSpy = vi.fn(async () => FIXTURE_HEALTH);
vi.mock('../src/core/quality/health.js', () => ({
  computeReport: computeReportSpy,
}));
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: vi.fn(() => [FIXTURE_GOAL]),
}));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: vi.fn(() => FIXTURE_PROGRESS),
  nextActionableMilestone: vi.fn(() => FIXTURE_MILESTONES[1]),
}));
vi.mock('../src/core/portfolio/backlog.js', () => ({
  loadBacklog: vi.fn(() => FIXTURE_BACKLOG),
}));
vi.mock('../src/core/observability/forecast.js', () => ({
  buildForecast: vi.fn(() => FIXTURE_FORECAST),
}));
vi.mock('../src/core/learn/store.js', () => ({
  listReports: vi.fn(() => [FIXTURE_REFLECT]),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { buildSnapshot } from '../src/core/dashboard.js';

// ---------------------------------------------------------------------------
// Reset mocks to fixture defaults before each test
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const qualityStore = await import('../src/core/quality/store.js');
  const goalsStore = await import('../src/core/goals/store.js');
  const advance = await import('../src/core/goals/advance.js');
  const backlog = await import('../src/core/portfolio/backlog.js');
  const forecast = await import('../src/core/observability/forecast.js');
  const learn = await import('../src/core/learn/store.js');

  vi.mocked(qualityStore.loadPreviousReport).mockReturnValue(FIXTURE_HEALTH);
  computeReportSpy.mockClear();
  vi.mocked(goalsStore.listGoals).mockReturnValue([FIXTURE_GOAL]);
  vi.mocked(advance.progressOf).mockReturnValue(FIXTURE_PROGRESS);
  vi.mocked(advance.nextActionableMilestone).mockReturnValue(FIXTURE_MILESTONES[1]!);
  vi.mocked(backlog.loadBacklog).mockReturnValue(FIXTURE_BACKLOG);
  vi.mocked(forecast.buildForecast).mockReturnValue(FIXTURE_FORECAST);
  vi.mocked(learn.listReports).mockReturnValue([FIXTURE_REFLECT]);
});

// ---------------------------------------------------------------------------
// Populated portfolio
// ---------------------------------------------------------------------------

describe('buildSnapshot — portfolio (populated)', () => {
  it('attaches a portfolio section when the v2 sources are present', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio).toBeDefined();
  });

  it('maps the M27 health summary (avg + worst-first repos)', async () => {
    const snap = await buildSnapshot(makeConfig());
    const h = snap.portfolio!.health;
    expect(h.reposScored).toBe(3);
    expect(h.averageScore).toBeCloseTo(72.67, 2);
    expect(h.averageGrade).toBe('C');
    // worstRepos must be sorted lowest-score-first.
    expect(h.worstRepos.map((r) => r.repo)).toEqual(['/r/b', '/r/c', '/r/a']);
    expect(h.worstRepos[0]).toEqual({ repo: '/r/b', score: 55, grade: 'F' });
  });

  it('maps in-flight goals via progressOf + nextActionableMilestone', async () => {
    const snap = await buildSnapshot(makeConfig());
    const goals = snap.portfolio!.goalsInFlight;
    expect(goals.length).toBe(1);
    expect(goals[0]).toMatchObject({
      goalId: 'goal-1',
      objective: 'Ship the surfacing pillar',
      status: 'active',
      fractionDone: 0.5,
      proposed: 0,
      totalMilestones: 2,
      nextActionable: 'Wire the API',
    });
  });

  it('maps the top backlog items, highest score first', async () => {
    const snap = await buildSnapshot(makeConfig());
    const top = snap.portfolio!.backlogTop;
    expect(top.map((t) => t.title)).toEqual(['High priority', 'Mid priority', 'Low priority']);
    expect(top[0]).toEqual({ title: 'High priority', repo: '/r/a', score: 9 });
  });

  it('maps the M19 cost + forecast block', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.cost).toEqual({
      window: '7d',
      spentUsd: 1.23,
      localSavingsUsd: 4.56,
      projectedMonthlyUsd: 7.89,
    });
  });

  it('maps the M26 effectiveness headline from the latest report', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.effectiveness).toEqual({
      successRate: 0.8,
      effectivenessDeltaPct: 12,
      headline: 'Up 12 points more effective',
    });
  });

  it('leaves the "today" delta null-filled at snapshot time', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.today).toEqual({
      previousAt: null,
      pendingProposalsDelta: null,
      dirtyReposDelta: null,
      spendUsdDelta: null,
      healthScoreDelta: null,
      goalsInFlightDelta: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Empty enrollment — NO scan
// ---------------------------------------------------------------------------

describe('buildSnapshot — portfolio (empty enrollment)', () => {
  it('empty persisted health report => empty health, NO worst repos', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    vi.mocked(loadPreviousReport).mockReturnValue({
      generatedAt: '2026-06-08T07:00:00.000Z',
      repos: [],
      scores: [],
      averageScore: 0,
      averageGrade: 'F',
      delta: {},
    });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.health.reposScored).toBe(0);
    expect(snap.portfolio!.health.worstRepos).toEqual([]);
    expect(snap.portfolio!.health.averageScore).toBe(0);
  });

  it('no persisted health report (null) => empty health', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    vi.mocked(loadPreviousReport).mockReturnValue(null);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.health.reposScored).toBe(0);
    expect(snap.portfolio!.health.worstRepos).toEqual([]);
    expect(snap.portfolio!.health.averageScore).toBe(0);
  });

  // HIGH-SEV REGRESSION GUARD: buildSnapshot is invoked on EVERY ~2s TUI tick.
  // It must read the PERSISTED snapshot (loadPreviousReport) and must NEVER run
  // the live computeReport() scanners, which spawn ~6 child processes per
  // enrolled repo (incl. `npm outdated`/`npm audit` NETWORK calls). This proves
  // the tick-safe + zero-non-localhost-egress invariant end-to-end.
  it('NEVER calls the live computeReport() scanners on the snapshot path', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    await buildSnapshot(makeConfig());
    expect(vi.mocked(loadPreviousReport)).toHaveBeenCalled();
    expect(computeReportSpy).not.toHaveBeenCalled();
  });

  it('no active goals => empty goalsInFlight', async () => {
    const { listGoals } = await import('../src/core/goals/store.js');
    vi.mocked(listGoals).mockReturnValue([]);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.goalsInFlight).toEqual([]);
  });

  it('null backlog => empty backlogTop', async () => {
    const { loadBacklog } = await import('../src/core/portfolio/backlog.js');
    vi.mocked(loadBacklog).mockReturnValue(null);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.backlogTop).toEqual([]);
  });

  it('no reflection reports => null effectiveness', async () => {
    const { listReports } = await import('../src/core/learn/store.js');
    vi.mocked(listReports).mockReturnValue([]);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.effectiveness).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-source degradation — a thrown source never fails the whole snapshot
// ---------------------------------------------------------------------------

describe('buildSnapshot — portfolio (graceful degradation)', () => {
  it('loadPreviousReport throwing degrades health but keeps the rest', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    vi.mocked(loadPreviousReport).mockImplementation(() => {
      throw new Error('health store blew up');
    });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio).toBeDefined();
    expect(snap.portfolio!.health).toEqual({
      reposScored: 0,
      averageScore: 0,
      averageGrade: 'F',
      worstRepos: [],
    });
    // Other sections still populated from their (unaffected) sources.
    expect(snap.portfolio!.goalsInFlight.length).toBe(1);
    expect(snap.portfolio!.backlogTop.length).toBe(3);
    expect(snap.portfolio!.cost.spentUsd).toBe(1.23);
  });

  it('listGoals throwing degrades goalsInFlight only', async () => {
    const { listGoals } = await import('../src/core/goals/store.js');
    vi.mocked(listGoals).mockImplementation(() => {
      throw new Error('goals store error');
    });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.goalsInFlight).toEqual([]);
    expect(snap.portfolio!.health.reposScored).toBe(3);
  });

  it('buildForecast throwing degrades cost to zeros only', async () => {
    const { buildForecast } = await import('../src/core/observability/forecast.js');
    vi.mocked(buildForecast).mockImplementation(() => {
      throw new Error('forecast error');
    });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.cost).toEqual({
      window: '7d',
      spentUsd: 0,
      localSavingsUsd: 0,
      projectedMonthlyUsd: 0,
    });
    expect(snap.portfolio!.effectiveness).not.toBeNull();
  });

  it('listReports throwing degrades effectiveness to null only', async () => {
    const { listReports } = await import('../src/core/learn/store.js');
    vi.mocked(listReports).mockImplementation(() => {
      throw new Error('learn store error');
    });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.effectiveness).toBeNull();
    expect(snap.portfolio!.backlogTop.length).toBe(3);
  });

  it('resolves (never throws) even when ALL portfolio sources fail', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    const { listGoals } = await import('../src/core/goals/store.js');
    const { loadBacklog } = await import('../src/core/portfolio/backlog.js');
    const { buildForecast } = await import('../src/core/observability/forecast.js');
    const { listReports } = await import('../src/core/learn/store.js');

    vi.mocked(loadPreviousReport).mockImplementation(() => { throw new Error('x'); });
    vi.mocked(listGoals).mockImplementation(() => { throw new Error('x'); });
    vi.mocked(loadBacklog).mockImplementation(() => { throw new Error('x'); });
    vi.mocked(buildForecast).mockImplementation(() => { throw new Error('x'); });
    vi.mocked(listReports).mockImplementation(() => { throw new Error('x'); });

    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio).toBeDefined();
    expect(snap.portfolio!.health.reposScored).toBe(0);
    expect(snap.portfolio!.goalsInFlight).toEqual([]);
    expect(snap.portfolio!.backlogTop).toEqual([]);
    expect(snap.portfolio!.cost.spentUsd).toBe(0);
    expect(snap.portfolio!.effectiveness).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bounded caps
// ---------------------------------------------------------------------------

describe('buildSnapshot — portfolio (bounded caps)', () => {
  it('worstRepos is capped (<=5) and goalsInFlight / backlogTop (<=8)', async () => {
    const { loadPreviousReport } = await import('../src/core/quality/store.js');
    const { listGoals } = await import('../src/core/goals/store.js');
    const { loadBacklog } = await import('../src/core/portfolio/backlog.js');

    const manyScores: HealthScore[] = Array.from({ length: 20 }, (_, i) =>
      makeScore(`/r/${i}`, i, 'F'),
    );
    vi.mocked(loadPreviousReport).mockReturnValue({
      generatedAt: '2026-06-08T07:00:00.000Z',
      repos: manyScores.map((s) => s.repo),
      scores: manyScores,
      averageScore: 10,
      averageGrade: 'F',
      delta: {},
    });

    const manyGoals: Goal[] = Array.from({ length: 20 }, (_, i) => ({
      ...FIXTURE_GOAL,
      id: `goal-${i}`,
    }));
    vi.mocked(listGoals).mockReturnValue(manyGoals);

    const manyItems: WorkItem[] = Array.from({ length: 30 }, (_, i) =>
      makeWorkItem(`w${i}`, '/r/a', `Item ${i}`, i),
    );
    vi.mocked(loadBacklog).mockReturnValue({
      generatedAt: '2026-06-08T00:00:00.000Z',
      repos: ['/r/a'],
      items: manyItems,
    });

    const snap = await buildSnapshot(makeConfig());
    expect(snap.portfolio!.health.worstRepos.length).toBeLessThanOrEqual(5);
    expect(snap.portfolio!.goalsInFlight.length).toBeLessThanOrEqual(8);
    expect(snap.portfolio!.backlogTop.length).toBeLessThanOrEqual(8);
  });
});
