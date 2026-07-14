/**
 * M262 Visibility panel tests — hermetic, all data-source modules mocked.
 *
 * Verifies:
 *   - buildSnapshot exposes snapshot.visibility with the full shape
 *   - buildVisibilitySnapshot: resourceGrid, fleetActivity, costSavings, director
 *   - resourceGrid degrades to [] when resource-monitor throws
 *   - fleetActivity: mergedToday/rejectedToday from decisions ledger (24h)
 *   - costSavings: spend by backend, cacheHitRate, routingSavedUsd
 *   - director: posture, escalationCount, directorEnabled gating
 *   - Graceful degradation: snapshot resolves when any section throws
 *   - Telegram pulse: buildFleetPulseMessage formats correctly
 *   - Telegram gate: sendFleetPulse no-ops when cfg.comms.proactive is false
 *   - Pre-M262 snapshot shape remains valid (visibility is optional)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, DashboardSnapshot } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixed timestamps — no Date.now() flakiness
// ---------------------------------------------------------------------------

const FIXED_NOW_ISO = '2026-06-30T12:00:00.000Z';
const FIXED_NOW_MS  = Date.parse(FIXED_NOW_ISO);
const FIXED_12H_AGO = new Date(FIXED_NOW_MS - 12 * 3600 * 1000).toISOString();
const FIXED_25H_AGO = new Date(FIXED_NOW_MS - 25 * 3600 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

function makeConfig(extra: Record<string, unknown> = {}): AshlrConfig {
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
    __visibilityDecisions: FIXTURE_DECISIONS,
    ...extra,
  } as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Base module mocks required by buildSnapshot (pre-M262 modules)
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = { version: 1, generatedAt: FIXED_NOW_ISO, root: '/home', items: [] };
const FIXTURE_TOOLS_REGISTRY = { tools: [], installedCount: 0 };
const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(FIXED_NOW_MS - 7 * 86400000).toISOString(),
  totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
  byProject: [], byDay: [], byModel: [],
  budget: { level: 'ok' as const, window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: 'ok' },
};
const FIXTURE_DAEMON_STATE = {
  running: false, pid: 0, startedAt: FIXED_NOW_ISO,
  lastTickAt: FIXED_NOW_ISO, todaySpentUsd: 0,
  itemsProcessed: 0, ticks: [], todayDate: FIXED_NOW_ISO.slice(0, 10),
};
const FIXTURE_FRONTIER_USAGE = { generatedAt: FIXED_NOW_ISO, engines: [] };
const FIXTURE_MCP_REGISTRY = { servers: [] };

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: () => FIXTURE_INDEX }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: () => FIXTURE_TOOLS_REGISTRY }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: () => FIXTURE_ROLLUP }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: () => [], runGoal: vi.fn() }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: () => [] }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => FIXTURE_MCP_REGISTRY }));
vi.mock('../src/core/daemon/state.js', () => ({ loadDaemonState: () => FIXTURE_DAEMON_STATE }));
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: () => FIXTURE_FRONTIER_USAGE,
}));
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: () => 0,
  listProposals: () => [{
    id: 'merged-fixture',
    status: 'applied',
    title: 'Witness-backed merge',
    realizedMerge: {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40),
      observedAt: FIXED_12H_AGO,
    },
  }],
  listProposalsDetailed: vi.fn(() => ({
    proposals: [{
      id: 'merged-fixture', status: 'applied', title: 'Witness-backed merge',
      realizedMerge: {
        schemaVersion: 1, source: 'local-default-branch', base: 'main',
        baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40),
        mergeCommitOid: '3'.repeat(40), observedAt: FIXED_12H_AGO,
      },
    }],
    sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
    filesDiscovered: 1, filesRead: 1, bytesRead: 0, invalidFiles: 0, unreadableFiles: 0,
  })),
}));
vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: () => [],
}));
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: () => [],
  createGoal: vi.fn(),
}));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: () => ({ total: 0, done: 0, fractionDone: 0, proposed: 0, byStatus: {} }),
  nextActionableMilestone: () => null,
}));

// M240 learned router
vi.mock('../src/core/run/learned-router.js', () => ({
  buildEngineScores: vi.fn(() => new Map()),
  sortEnginesByScore: vi.fn((engines: string[]) => engines),
  engineScoreFor: vi.fn(() => 0.5),
  LEARNED_ROUTING_MIN_SAMPLES: 5,
  LEARNED_ROUTING_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,
}));

// M235 genome
vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => []),
  appendHubEntry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// M262-specific mocks
// ---------------------------------------------------------------------------

/** Resource monitor fixture */
const FIXTURE_BACKENDS = [
  {
    backend: 'claude',
    availability: 'open',
    usedPct: 42,
    capWindow: '7d',
    costPerMTokenOut: 15,
    p50LatencyMs: 800,
    resetsAt: null,
    reason: 'within budget',
  },
  {
    backend: 'local',
    availability: 'open',
    usedPct: null,
    capWindow: null,
    costPerMTokenOut: 0,
    p50LatencyMs: 120,
    resetsAt: null,
    reason: 'always available',
  },
];

vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: vi.fn(async () => ({ generatedAt: FIXED_NOW_ISO, backends: FIXTURE_BACKENDS })),
}));

/** Decisions ledger fixture for fleet activity + cost */
const FIXTURE_DECISIONS = [
  // dispatches within 24h
  { ts: FIXED_12H_AGO, action: 'dispatched', engine: 'claude', tokensIn: 1000, tokensOut: 500, costUsd: 0.02, cacheHit: false },
  { ts: FIXED_12H_AGO, action: 'dispatched', engine: 'local',  tokensIn: 800,  tokensOut: 400, costUsd: 0,    cacheHit: true },
  { ts: FIXED_12H_AGO, proposalId: 'merged-fixture', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude', tokensIn: 500, tokensOut: 200, costUsd: 0.01, cacheHit: false },
  { ts: FIXED_12H_AGO, action: 'rejected',   engine: 'claude', tokensIn: 300,  tokensOut: 100, costUsd: 0.005, cacheHit: false },
  // older than 24h — excluded from 24h window
  { ts: FIXED_25H_AGO, action: 'dispatched', engine: 'codex',  tokensIn: 200,  tokensOut: 100, costUsd: 0.001, cacheHit: false },
];

const _origHome = process.env.HOME;
const _origAshlrHome = process.env.ASHLR_HOME;
let _tmpHome: string | null = null;

function writeFixtureDecisions(home: string): void {
  const dir = join(home, 'decisions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-06-30.jsonl');
  writeFileSync(
    file,
    FIXTURE_DECISIONS.map((d, idx) => JSON.stringify({
      proposalId: `fixture-${idx}`,
      ...d,
    })).join('\n') + '\n',
    'utf8',
  );
}

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number; limit?: number }) => {
    const since = opts?.sinceMs ?? 0;
    const filtered = FIXTURE_DECISIONS.filter((d) => Date.parse(d.ts) >= since);
    const limit = opts?.limit ?? Infinity;
    return filtered.slice(0, limit);
  }),
  readDecisionsDetailed: vi.fn(() => ({
    decisions: FIXTURE_DECISIONS,
    sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
    filesRead: 1, bytesRead: 0, rowsScanned: FIXTURE_DECISIONS.length,
    invalidRows: 0, unreadableFiles: 0,
  })),
  recordDecision: vi.fn(),
}));

vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: vi.fn(async () => ({
    proposals: { pending: 2, applied: 7, rejected: 1 },
    queue: { backlogItems: 3 },
  })),
}));

vi.mock('../src/core/comms/director-context.js', () => ({
  buildDirectorContext: vi.fn(async () => ({
    resourcePosture: 'preserve',
    goals: { active: [{ objective: 'Ship M262 visibility dashboard' }] },
  })),
}));

vi.mock('../src/core/comms/requests.js', () => ({
  listRequests: vi.fn(() => [
    { kind: 'decision-needed', id: 'req-001' },
  ]),
}));

// Telegram — never actually send
vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  telegramEnabled: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

const { buildSnapshot } = await import('../src/core/dashboard.ts');
const { buildVisibilitySnapshot } = await import('../src/core/web/visibility.ts');
const { buildFleetPulseMessage, sendFleetPulse, dispatchFleetPulse } = await import('../src/core/comms/fleet-pulse.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVisSnap() {
  return buildVisibilitySnapshot(makeConfig(), FIXED_NOW_MS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M262 — visibility snapshot in buildSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m262-home-'));
    process.env.HOME = _tmpHome;
    process.env.ASHLR_HOME = _tmpHome;
    writeFixtureDecisions(_tmpHome);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (_tmpHome) {
      try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
      _tmpHome = null;
    }
    if (_origHome === undefined) delete process.env.HOME;
    else process.env.HOME = _origHome;
    if (_origAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = _origAshlrHome;
  });

  it('snapshot.visibility is present and has the correct shape', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.visibility).toBeDefined();
    const vis = snap.visibility!;
    expect(typeof vis.generatedAt).toBe('string');
    expect(Array.isArray(vis.resourceGrid)).toBe(true);
    expect(typeof vis.fleetActivity).toBe('object');
    expect(typeof vis.costSavings).toBe('object');
    expect(typeof vis.director).toBe('object');
  });

  it('snapshot resolves even when visibility throws', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    vi.mocked(getResourceSnapshot).mockRejectedValueOnce(new Error('monitor exploded'));
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
    expect(snap.generatedAt).toBeTruthy();
    // snapshot still resolves; visibility may degrade
    if (snap.visibility) {
      expect(Array.isArray(snap.visibility.resourceGrid)).toBe(true);
    }
  });

  it('visibility field is optional — pre-M262 snapshot shape is still valid', () => {
    const preM262Snap: DashboardSnapshot = {
      generatedAt: FIXED_NOW_ISO,
      repos: { total: 0, dirty: 0, stale: 0 },
      tools: { installed: 0, total: 0 },
      activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
      runs: [],
      swarms: [],
      mcp: [],
      genome: { entries: 0, projects: 0 },
      inbox: { pending: 0 },
    };
    expect(preM262Snap.visibility).toBeUndefined();
  });
});

describe('M262 — buildVisibilitySnapshot sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── resourceGrid ──────────────────────────────────────────────────────────

  it('resourceGrid maps getResourceSnapshot backends', async () => {
    const vis = await makeVisSnap();
    expect(vis.resourceGrid.length).toBe(2);
    const claude = vis.resourceGrid.find((b) => b.backend === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.availability).toBe('open');
    expect(claude!.usedPct).toBe(42);
    expect(claude!.costPerMTokenOut).toBe(15);
    expect(claude!.p50LatencyMs).toBe(800);
  });

  it('resourceGrid degrades to [] when resource-monitor throws', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    vi.mocked(getResourceSnapshot).mockRejectedValueOnce(new Error('timeout'));
    const vis = await makeVisSnap();
    expect(Array.isArray(vis.resourceGrid)).toBe(true);
    expect(vis.resourceGrid.length).toBe(0);
  });

  // ── fleetActivity ─────────────────────────────────────────────────────────

  it('fleetActivity counts mergedToday and rejectedToday from 24h decisions', async () => {
    const vis = await makeVisSnap();
    const fa = vis.fleetActivity;
    // 1 merged entry within 24h
    expect(fa.mergedToday).toBe(1);
    // 1 rejected entry within 24h
    expect(fa.rejectedToday).toBe(1);
  });

  it('ignores legacy merged rows and deduplicates canonical rows against a current witness', async () => {
    const decisions = [
      { ts: FIXED_12H_AGO, proposalId: 'merged-fixture', action: 'merged', engine: 'legacy' },
      { ts: FIXED_12H_AGO, proposalId: 'merged-fixture', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude' },
      { ts: FIXED_12H_AGO, proposalId: 'merged-fixture', action: 'merged', labelBasis: 'realized-merge-v1', engine: 'claude' },
    ];

    const vis = await buildVisibilitySnapshot(
      makeConfig({ __visibilityDecisions: decisions }),
      FIXED_NOW_MS,
    );

    expect(vis.fleetActivity.mergedToday).toBe(1);
    expect(vis.fleetActivity.totalDispatches).toBe(1);
    expect(vis.fleetActivity.byBackend).toEqual([{ backend: 'claude', count: 1 }]);
  });

  it('fails closed when proposal details are degraded despite optimistic merge rows', async () => {
    const { listProposalsDetailed } = await import('../src/core/inbox/store.js');
    const degradedRead = {
      proposals: [{
        id: 'merged-fixture', status: 'applied', title: 'Partial optimistic merge',
        realizedMerge: {
          schemaVersion: 1, source: 'local-default-branch', base: 'main',
          baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40),
          mergeCommitOid: '3'.repeat(40), observedAt: FIXED_12H_AGO,
        },
      }],
      sourceState: 'degraded' as const,
      sourcePresent: true,
      complete: false,
      stopReasons: ['byte-cap'],
      filesDiscovered: 2,
      filesRead: 1,
      bytesRead: 1024,
      invalidFiles: 0,
      unreadableFiles: 0,
    };
    vi.mocked(listProposalsDetailed)
      .mockReturnValueOnce(degradedRead)
      .mockReturnValueOnce(degradedRead);

    const vis = await makeVisSnap();

    expect(vis.fleetActivity.mergedToday).toBe(0);
    expect(vis.fleetActivity.recentMergeTitles).toEqual([]);
  });

  it('fleetActivity excludes decisions older than 24h', async () => {
    const vis = await makeVisSnap();
    const fa = vis.fleetActivity;
    // codex only dispatched at FIXED_25H_AGO (>24h) — must not appear in byBackend
    const codex = fa.byBackend.find((b) => b.backend === 'codex');
    expect(codex).toBeUndefined();
  });

  it('fleetActivity.proposalsPending comes from fleet status', async () => {
    const vis = await makeVisSnap();
    expect(vis.fleetActivity.proposalsPending).toBe(2);
  });

  it('fleetActivity degrades gracefully when decisions ledger throws', async () => {
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    vi.mocked(readDecisions).mockImplementationOnce(() => { throw new Error('ledger gone'); });
    const vis = await makeVisSnap();
    expect(typeof vis.fleetActivity.totalDispatches).toBe('number');
    expect(typeof vis.fleetActivity.mergedToday).toBe('number');
  });

  // ── costSavings ───────────────────────────────────────────────────────────

  it('costSavings aggregates todaySpendUsd from 24h decisions', async () => {
    const vis = await makeVisSnap();
    const cs = vis.costSavings;
    // 0.02 + 0 + 0.01 + 0.005 = 0.035 (codex at 25h ago excluded)
    expect(cs.todaySpendUsd).toBeCloseTo(0.035, 4);
  });

  it('costSavings spendByBackend sorted by cost desc', async () => {
    const vis = await makeVisSnap();
    const backends = vis.costSavings.spendByBackend;
    expect(backends.length).toBeGreaterThan(0);
    for (let i = 1; i < backends.length; i++) {
      expect(backends[i]!.costUsd).toBeLessThanOrEqual(backends[i - 1]!.costUsd);
    }
  });

  it('costSavings.cacheHitRate is non-negative and <= 1', async () => {
    const vis = await makeVisSnap();
    expect(vis.costSavings.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(vis.costSavings.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it('costSavings.claudeBudgetPreserved is true when usedPct < 80', async () => {
    const vis = await makeVisSnap();
    // FIXTURE_BACKENDS has claude usedPct=42 < 80
    expect(vis.costSavings.claudeBudgetPreserved).toBe(true);
  });

  it('costSavings degrades gracefully when decisions ledger throws', async () => {
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    vi.mocked(readDecisions).mockImplementationOnce(() => { throw new Error('gone'); });
    const vis = await makeVisSnap();
    expect(typeof vis.costSavings.todaySpendUsd).toBe('number');
    expect(typeof vis.costSavings.claudeBudgetPreserved).toBe('boolean');
  });

  // ── director ─────────────────────────────────────────────────────────────

  it('director.resourcePosture comes from buildDirectorContext', async () => {
    const vis = await makeVisSnap();
    expect(vis.director.resourcePosture).toBe('preserve');
  });

  it('director.topGoalObjective comes from context goals.active[0]', async () => {
    const vis = await makeVisSnap();
    expect(vis.director.topGoalObjective).toBe('Ship M262 visibility dashboard');
  });

  it('director.escalationCount counts decision-needed requests', async () => {
    const vis = await makeVisSnap();
    expect(vis.director.escalationCount).toBe(1);
  });

  it('director.directorEnabled is false when cfg.comms.director is not set', async () => {
    const vis = await makeVisSnap();
    expect(vis.director.directorEnabled).toBe(false);
  });

  it('director.directorEnabled is true when cfg.comms.director is true', async () => {
    const cfgWithDirector = { ...makeConfig(), comms: { director: true } } as AshlrConfig;
    const vis = await buildVisibilitySnapshot(cfgWithDirector, FIXED_NOW_MS);
    expect(vis.director.directorEnabled).toBe(true);
  });

  it('director degrades gracefully when context throws', async () => {
    const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
    vi.mocked(buildDirectorContext).mockRejectedValueOnce(new Error('context gone'));
    const vis = await makeVisSnap();
    expect(typeof vis.director.resourcePosture).toBe('string');
    expect(typeof vis.director.directorEnabled).toBe('boolean');
  });

  // ── full snapshot degrades ─────────────────────────────────────────────────

  it('buildVisibilitySnapshot never throws even when all sources fail', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
    vi.mocked(getResourceSnapshot).mockRejectedValueOnce(new Error('fail'));
    vi.mocked(readDecisions).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(buildDirectorContext).mockRejectedValueOnce(new Error('fail'));
    const vis = await makeVisSnap();
    expect(vis).toBeDefined();
    expect(Array.isArray(vis.resourceGrid)).toBe(true);
    expect(typeof vis.fleetActivity.totalDispatches).toBe('number');
    expect(typeof vis.costSavings.todaySpendUsd).toBe('number');
    expect(typeof vis.director.resourcePosture).toBe('string');
  });
});

describe('M262 — buildFleetPulseMessage', () => {
  it('formats a message with posture header and backend grid', () => {
    const snap = {
      generatedAt: FIXED_NOW_ISO,
      resourceGrid: [
        { backend: 'claude', availability: 'open' as const, usedPct: 42, capWindow: '7d', costPerMTokenOut: 15, p50LatencyMs: 800, resetsAt: null, reason: '' },
        { backend: 'local',  availability: 'open' as const, usedPct: null, capWindow: null, costPerMTokenOut: 0, p50LatencyMs: 120, resetsAt: null, reason: '' },
      ],
      fleetActivity: {
        totalDispatches: 10,
        byBackend: [{ backend: 'claude', count: 8 }, { backend: 'local', count: 2 }],
        mergedToday: 3,
        rejectedToday: 1,
        proposalsPending: 2,
        proposalsApplied: 7,
        queueBacklog: 1,
        recentMergeTitles: ['Fix lint errors', 'Update deps'],
      },
      costSavings: {
        todaySpendUsd: 0.035,
        spendByBackend: [{ backend: 'claude', costUsd: 0.03 }],
        pluginSavingsLifetimeTokens: 1_500_000,
        pluginSavingsLifetimeUsd: 4.5,
        routingSavedUsd: 0.12,
        cacheHitRate: 0.25,
        claudeBudgetPreserved: true,
      },
      director: {
        resourcePosture: 'preserve',
        latestDigest: null,
        topGoalObjective: 'Ship M262',
        escalationCount: 0,
        directorEnabled: true,
        lastRunAt: null,
      },
    };

    const msg = buildFleetPulseMessage(snap);
    expect(msg).toContain('Fleet Pulse');
    expect(msg).toContain('POSTURE: preserve');
    expect(msg).toContain('claude');
    expect(msg).toContain('FLEET (24h)');
    expect(msg).toContain('Merged: 3');
    expect(msg).toContain('COST &amp; SAVINGS');
    expect(msg).toContain('DIRECTOR');
    expect(msg).toContain('Ship M262');
    expect(msg).toContain('No escalations pending');
  });

  it('omits FLEET block when no dispatches or merges', () => {
    const snap = {
      generatedAt: FIXED_NOW_ISO,
      resourceGrid: [],
      fleetActivity: {
        totalDispatches: 0, byBackend: [], mergedToday: 0,
        rejectedToday: 0, proposalsPending: 0, proposalsApplied: 0,
        queueBacklog: 0, recentMergeTitles: [],
      },
      costSavings: {
        todaySpendUsd: 0, spendByBackend: [],
        pluginSavingsLifetimeTokens: 0, pluginSavingsLifetimeUsd: 0,
        routingSavedUsd: 0, cacheHitRate: 0, claudeBudgetPreserved: true,
      },
      director: {
        resourcePosture: 'unknown', latestDigest: null,
        topGoalObjective: null, escalationCount: 0,
        directorEnabled: false, lastRunAt: null,
      },
    };
    const msg = buildFleetPulseMessage(snap);
    expect(msg).not.toContain('FLEET (24h)');
    expect(msg).not.toContain('DIRECTOR');
  });

  it('escapes dynamic text for Telegram HTML parse mode', () => {
    const snap = {
      generatedAt: FIXED_NOW_ISO,
      resourceGrid: [
        { backend: 'claude<bad>&codex', availability: 'open' as const, usedPct: 1, capWindow: null, costPerMTokenOut: 0, p50LatencyMs: null, resetsAt: null, reason: '' },
      ],
      fleetActivity: {
        totalDispatches: 1, byBackend: [{ backend: 'claude&codex', count: 1 }],
        mergedToday: 0, rejectedToday: 0, proposalsPending: 0,
        proposalsApplied: 0, queueBacklog: 0, recentMergeTitles: ['Fix <tag> & deps'],
      },
      costSavings: {
        todaySpendUsd: 0, spendByBackend: [],
        pluginSavingsLifetimeTokens: 0, pluginSavingsLifetimeUsd: 0,
        routingSavedUsd: 0, cacheHitRate: 0, claudeBudgetPreserved: true,
      },
      director: {
        resourcePosture: 'custom <mode>', latestDigest: 'Digest <x> & y',
        topGoalObjective: 'Ship <M262>', escalationCount: 0,
        directorEnabled: true, lastRunAt: null,
      },
    };

    const msg = buildFleetPulseMessage(snap);
    expect(msg).toContain('<b>Fleet Pulse</b>');
    expect(msg).toContain('claude&lt;bad&gt;&amp;codex');
    expect(msg).toContain('Fix &lt;tag&gt; &amp; deps');
    expect(msg).toContain('Ship &lt;M262&gt;');
    expect(msg).toContain('<i>Digest &lt;x&gt; &amp; y</i>');
  });
});

describe('M262 — Telegram gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sendFleetPulse no-ops when cfg.comms.proactive is false', async () => {
    const { sendTelegramMessage } = await import('../src/core/integrations/telegram.js');
    const snap = {
      generatedAt: FIXED_NOW_ISO,
      resourceGrid: [], fleetActivity: {
        totalDispatches: 0, byBackend: [], mergedToday: 0,
        rejectedToday: 0, proposalsPending: 0, proposalsApplied: 0,
        queueBacklog: 0, recentMergeTitles: [],
      },
      costSavings: {
        todaySpendUsd: 0, spendByBackend: [],
        pluginSavingsLifetimeTokens: 0, pluginSavingsLifetimeUsd: 0,
        routingSavedUsd: 0, cacheHitRate: 0, claudeBudgetPreserved: true,
      },
      director: {
        resourcePosture: 'unknown', latestDigest: null,
        topGoalObjective: null, escalationCount: 0,
        directorEnabled: false, lastRunAt: null,
      },
    };

    // proactive not set → no-op
    await sendFleetPulse(snap, makeConfig());
    expect(vi.mocked(sendTelegramMessage)).not.toHaveBeenCalled();
  });

  it('sendFleetPulse no-ops when telegramEnabled returns false', async () => {
    const { sendTelegramMessage, telegramEnabled } = await import('../src/core/integrations/telegram.js');
    vi.mocked(telegramEnabled).mockReturnValue(false);

    const snap = {
      generatedAt: FIXED_NOW_ISO,
      resourceGrid: [], fleetActivity: {
        totalDispatches: 0, byBackend: [], mergedToday: 0,
        rejectedToday: 0, proposalsPending: 0, proposalsApplied: 0,
        queueBacklog: 0, recentMergeTitles: [],
      },
      costSavings: {
        todaySpendUsd: 0, spendByBackend: [],
        pluginSavingsLifetimeTokens: 0, pluginSavingsLifetimeUsd: 0,
        routingSavedUsd: 0, cacheHitRate: 0, claudeBudgetPreserved: true,
      },
      director: {
        resourcePosture: 'unknown', latestDigest: null,
        topGoalObjective: null, escalationCount: 0,
        directorEnabled: false, lastRunAt: null,
      },
    };

    const cfgWithProactive = { ...makeConfig(), comms: { proactive: true } } as AshlrConfig;
    await sendFleetPulse(snap, cfgWithProactive);
    expect(vi.mocked(sendTelegramMessage)).not.toHaveBeenCalled();
  });

  it('dispatchFleetPulse no-ops when proactive is false', async () => {
    const { sendTelegramMessage } = await import('../src/core/integrations/telegram.js');
    await dispatchFleetPulse(makeConfig());
    expect(vi.mocked(sendTelegramMessage)).not.toHaveBeenCalled();
  });

  it('dispatchFleetPulse never throws', async () => {
    // Even if everything fails, it should not throw
    await expect(dispatchFleetPulse(makeConfig())).resolves.toBeUndefined();
  });
});
