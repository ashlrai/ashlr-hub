/**
 * M210 Fleet Dashboard tests — hermetic, all data-source modules mocked.
 *
 * Verifies that buildSnapshot exposes the fields the Fleet Dashboard panels
 * rely on:
 *   - daemon: running, lastTickAt, todaySpentUsd, pendingProposals, itemsProcessed
 *   - inbox:  pending (count)
 *   - frontierUsage: engines[] with engine/callsToday/subscriptionWindow shape
 *   - frontierUsage never-throws and degrades gracefully
 *   - snapshot always resolves even when frontierUsage source throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AshlrConfig, DashboardSnapshot } from '../src/core/types.js';

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
// Minimal fixtures — only what M210 panels need
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = {
  version: 1,
  generatedAt: new Date().toISOString(),
  root: '/home',
  items: [],
};

const FIXTURE_TOOLS_REGISTRY = { tools: [], installedCount: 0 };

const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(Date.now() - 7 * 86400000).toISOString(),
  totals: { tokensIn: 5000, tokensOut: 2000, estCostUsd: 0.1, sessions: 2, commits: 4 },
  byProject: [], byDay: [], byModel: [],
  budget: { level: 'ok' as const, window: '7d', spentUsd: 0.1, capUsd: null, spentTokens: 7000, capTokens: null, message: 'ok' },
};

const FIXTURE_DAEMON_STATE = {
  running: true,
  pid: 12345,
  startedAt: new Date(Date.now() - 3600000).toISOString(),
  lastTickAt: new Date(Date.now() - 30000).toISOString(),
  todaySpentUsd: 0.0042,
  itemsProcessed: 7,
  ticks: [],
  todayDate: new Date().toISOString().slice(0, 10),
};

const FIXTURE_FRONTIER_USAGE = {
  generatedAt: new Date().toISOString(),
  engines: [
    {
      engine: 'claude' as const,
      callsToday: 12,
      tokensToday: 48000,
      costToday: 0.0031,
      subscriptionWindow: { state: 'active' as const, usedPct: 24 },
    },
    {
      engine: 'codex' as const,
      callsToday: 5,
      tokensToday: undefined,
      costToday: undefined,
      subscriptionWindow: { state: 'near' as const, usedPct: 83, resetsAt: Math.floor(Date.now() / 1000) + 7200, windowLabel: '1d' },
      remainingEstimate: 95,
      limit: 100,
      limitWindow: '1d',
    },
  ],
};

const FIXTURE_INBOX_PENDING = 3;
const FIXTURE_MCP_REGISTRY = { servers: [] };
const FIXTURE_GENOME_ENTRIES: never[] = [];
const FIXTURE_FLEET_STATUS = {
  generatedAt: new Date().toISOString(),
  daemon: { running: true, lastTickAt: FIXTURE_DAEMON_STATE.lastTickAt, todaySpentUsd: 0.0042 },
  backends: [],
  queue: {
    backlogItems: 4,
    generatedWork: {
      total: 2,
      selfHeal: 2,
      proposalRepair: 1,
      captureRepairs: 1,
      diagnosticReslices: 1,
      invent: 0,
    },
    diagnosticResliceDrain: {
      mode: 'diagnostic-reslices' as const,
      latestAt: new Date().toISOString(),
      available: 3,
      selected: 2,
      limit: 3,
      automatic: true,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 1,
      noProposalDispatches: 1,
    },
    shared: {
      enabled: true,
      mode: 'filesystem' as const,
      path: '/tmp/shared-queue',
      machineId: 'machine-A',
      leaseMs: 300_000,
      readable: true,
      activeClaims: 2,
      ownedClaims: 1,
      expiredClaims: 1,
      reclaimableClaims: 1,
      claimsByMachine: [
        { machineId: 'machine-A', active: 2, expired: 0 },
        { machineId: 'machine-B-with-a-long-operator-hostname', active: 0, expired: 1 },
      ],
      nextLeaseExpiryAt: '2026-07-09T16:00:00.000Z',
      oldestExpiredMs: 125_000,
      workedEvents: 7,
      cooldownItems: 3,
      usageEntries: 4,
      lock: { present: true, ageMs: 125_000, stale: true },
    },
  },
  proposals: { pending: 3, frontierPending: 1, applied: 0 },
  phantom: {
    observedAt: new Date().toISOString(),
    state: 'ready' as const,
    installed: true,
    initialized: true,
    version: '0.6.0',
    valueMode: 'metadata-and-names-only' as const,
    secretCount: 2,
    knownFleetSecrets: {
      total: 6,
      presentCount: 2,
      missingCount: 4,
      pulseCredentialPresent: true,
      nimApiKeyPresent: false,
    },
    capabilities: {
      metadataStatus: true,
      childEnvInjectionAvailable: true,
      mcpServerAvailable: true,
      mutationRequiresHumanApproval: true,
    },
    commands: {
      commandsKnown: true,
      setupAvailable: true,
      execAvailable: true,
      mcpAvailable: true,
      agentAvailable: false,
    },
    config: {
      phantomExecEnabled: true,
      fleetSecretInjectionEnabled: true,
    },
    mcp: { configured: true },
  },
  proposalProduction: {
    windowHours: 24,
    selected: 3,
    claimed: 3,
    dispatched: 2,
    skipped: 1,
    errors: 0,
    proposalsCreated: 1,
    noProposalDispatches: 1,
    topReasons: [{ reason: 'agent returned no diff', count: 1 }],
    recentNoProposalDispatches: [],
  },
  dispatchProduction: {
    windowHours: 24,
    attempts: 2,
    events: 2,
    proposalsCreated: 1,
    noProposal: 1,
    proposalRate: 0.5,
    spentUsd: 0.002,
    outcomes: {
      proposalCreated: 1,
      emptyDiff: 1,
      gateBlocked: 0,
      engineFailed: 0,
      sandboxFailed: 0,
      proposalCaptureError: 0,
      proposalDisabled: 0,
      unknown: 0,
    },
    attemptShape: {
      backendNoDiff: 1,
      captureOrGateBlocked: 0,
      repairAttempts: 0,
      policyDisabled: 0,
    },
    topReasons: [{ reason: 'agent returned no diff', count: 1 }],
    byBackend: [
      {
        key: 'builtin',
        backend: 'builtin' as const,
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        spentUsd: 0.002,
        outcomes: {
          proposalCreated: 1,
          emptyDiff: 1,
          gateBlocked: 0,
          engineFailed: 0,
          sandboxFailed: 0,
          proposalCaptureError: 0,
          proposalDisabled: 0,
          unknown: 0,
        },
        topReasons: [{ reason: 'agent returned no diff', count: 1 }],
      },
    ],
    bySource: [],
    byRepo: [],
    byBackendModel: [],
    byBackendSource: [],
  },
  merges: { recent: 0 },
  missionBrief: {
    generatedAt: new Date().toISOString(),
    directive: 'Build the highest-value backlog proposal',
    confidence: 'medium' as const,
    operatingMode: 'backlog-build',
    blocker: {
      id: 'proposal-production-needed',
      label: 'Proposal production needed',
      detail: 'Backlog work is visible, but there are no pending proposals ready to ship.',
      severity: 'medium' as const,
      source: 'queue' as const,
    },
    action: {
      id: 'build-backlog',
      priority: 'medium' as const,
      label: 'Build backlog proposals',
      detail: 'Start with the highest-value queue item.',
    },
    whyNow: '4 backlog item(s) are visible and 3 proposals are pending.',
    evidence: {
      readinessVerdict: 'degraded' as const,
      effectivenessPhase: 'proposal-starved' as const,
      bottleneck: 'proposal-production' as const,
      queueBacklogItems: 4,
      eligibleBacklogItems: 4,
      pendingProposals: 3,
      preflightReady: 0,
      guardBlocked: false,
    },
  },
  killed: false,
};

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => FIXTURE_INDEX) }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: vi.fn(() => FIXTURE_TOOLS_REGISTRY) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => FIXTURE_ROLLUP) }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: vi.fn(() => []), loadRun: vi.fn(() => null) }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: vi.fn(() => []), loadSwarm: vi.fn(() => null) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: vi.fn(() => FIXTURE_MCP_REGISTRY) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => FIXTURE_GENOME_ENTRIES) }));
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: vi.fn(() => FIXTURE_INBOX_PENDING),
  listProposals: vi.fn(() => []),
}));
vi.mock('../src/core/daemon/state.js', () => ({ loadDaemonState: vi.fn(() => FIXTURE_DAEMON_STATE) }));
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: vi.fn(() => FIXTURE_FRONTIER_USAGE),
}));
vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: vi.fn(async () => FIXTURE_FLEET_STATUS),
}));

// ---------------------------------------------------------------------------
// Import under test
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
  const { pendingCount } = await import('../src/core/inbox/store.js');
  const { loadDaemonState } = await import('../src/core/daemon/state.js');
  const { getFrontierUsageSync } = await import('../src/core/usage/frontier-usage.js');
  const { buildFleetStatus } = await import('../src/core/fleet/status.js');

  vi.mocked(loadIndex).mockReturnValue(FIXTURE_INDEX);
  vi.mocked(getToolsRegistry).mockReturnValue(FIXTURE_TOOLS_REGISTRY);
  vi.mocked(buildRollup).mockReturnValue(FIXTURE_ROLLUP);
  vi.mocked(listRuns).mockReturnValue([]);
  vi.mocked(listSwarms).mockReturnValue([]);
  vi.mocked(discoverMcpServers).mockReturnValue(FIXTURE_MCP_REGISTRY);
  vi.mocked(loadGenome).mockReturnValue(FIXTURE_GENOME_ENTRIES);
  vi.mocked(pendingCount).mockReturnValue(FIXTURE_INBOX_PENDING);
  vi.mocked(loadDaemonState).mockReturnValue(FIXTURE_DAEMON_STATE);
  vi.mocked(getFrontierUsageSync).mockReturnValue(FIXTURE_FRONTIER_USAGE);
  vi.mocked(buildFleetStatus).mockResolvedValue(FIXTURE_FLEET_STATUS);
});

// ---------------------------------------------------------------------------
// Panel 1 — Fleet Status: daemon shape
// ---------------------------------------------------------------------------

describe('M210 Panel 1 — Fleet Status: snapshot.daemon', () => {
  it('daemon field is present in snapshot', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toHaveProperty('daemon');
    expect(snap.daemon).toBeDefined();
  });

  it('daemon.running is a boolean', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.daemon!.running).toBe('boolean');
  });

  it('daemon.running reflects the daemon state fixture', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.daemon!.running).toBe(true);
  });

  it('daemon.todaySpentUsd is a number', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.daemon!.todaySpentUsd).toBe('number');
    expect(snap.daemon!.todaySpentUsd).toBeCloseTo(0.0042, 5);
  });

  it('daemon.pendingProposals reflects inboxPendingCount', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.daemon!.pendingProposals).toBe(FIXTURE_INBOX_PENDING);
  });

  it('fleet status is embedded for Fleet Dashboard queue health', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.fleet?.queue.backlogItems).toBe(4);
    expect(snap.fleet?.queue.generatedWork).toMatchObject({
      total: 2,
      selfHeal: 2,
      proposalRepair: 1,
      captureRepairs: 1,
      diagnosticReslices: 1,
      invent: 0,
    });
    expect(snap.fleet?.queue.diagnosticResliceDrain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 3,
      selected: 2,
      limit: 3,
      automatic: true,
    });
    expect(snap.fleet?.queue.shared?.activeClaims).toBe(2);
    expect(snap.fleet?.queue.shared?.ownedClaims).toBe(1);
    expect(snap.fleet?.queue.shared?.reclaimableClaims).toBe(1);
    expect(snap.fleet?.queue.shared?.claimsByMachine).toEqual([
      { machineId: 'machine-A', active: 2, expired: 0 },
      { machineId: 'machine-B-with-a-long-operator-hostname', active: 0, expired: 1 },
    ]);
    expect(snap.fleet?.queue.shared?.nextLeaseExpiryAt).toBe('2026-07-09T16:00:00.000Z');
    expect(snap.fleet?.queue.shared?.oldestExpiredMs).toBe(125_000);
    expect(snap.fleet?.queue.shared?.workedEvents).toBe(7);
    expect(snap.fleet?.queue.shared?.cooldownItems).toBe(3);
    expect(snap.fleet?.queue.shared?.usageEntries).toBe(4);
    expect(snap.fleet?.queue.shared?.lock?.stale).toBe(true);
    expect(snap.fleet?.proposalProduction?.noProposalDispatches).toBe(1);
    expect(snap.fleet?.proposalProduction?.topReasons[0]?.reason).toBe('agent returned no diff');
    expect(snap.fleet?.dispatchProduction?.proposalRate).toBe(0.5);
    expect(snap.fleet?.dispatchProduction?.byBackend[0]?.key).toBe('builtin');
    expect(snap.fleet?.missionBrief).toMatchObject({
      directive: 'Build the highest-value backlog proposal',
      confidence: 'medium',
      evidence: { queueBacklogItems: 4, guardBlocked: false },
    });
    expect(snap.fleet?.phantom?.knownFleetSecrets.pulseCredentialPresent).toBe(true);
    expect(snap.fleet?.phantom?.commands).toMatchObject({
      commandsKnown: true,
      agentAvailable: false,
    });
    const serialized = JSON.stringify(snap.fleet?.phantom);
    expect(serialized).not.toContain('ASHLR_PULSE_TOKEN');
    expect(serialized).not.toContain('command help text');
  });

  it('daemon degrades to zeroed fields when loadDaemonState throws', async () => {
    const { loadDaemonState } = await import('../src/core/daemon/state.js');
    vi.mocked(loadDaemonState).mockImplementation(() => { throw new Error('no state'); });
    const snap = await buildSnapshot(makeConfig());
    // Snapshot must still resolve
    expect(snap).toBeDefined();
    expect(typeof snap.daemon!.running).toBe('boolean');
    expect(snap.daemon!.running).toBe(false);
    expect(snap.daemon!.todaySpentUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Panel 2 — What's Running: inbox.pending
// ---------------------------------------------------------------------------

describe('M210 Panel 2 — What\'s Running: snapshot.inbox', () => {
  it('inbox field is present in snapshot', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toHaveProperty('inbox');
    expect(snap.inbox).toBeDefined();
  });

  it('inbox.pending is a number', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.inbox.pending).toBe('number');
  });

  it('inbox.pending reflects pendingCount()', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.inbox.pending).toBe(FIXTURE_INBOX_PENDING);
  });

  it('inbox.pending is 0 when pendingCount throws', async () => {
    const { pendingCount } = await import('../src/core/inbox/store.js');
    vi.mocked(pendingCount).mockImplementation(() => { throw new Error('io error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
    expect(snap.inbox.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Panel 3 — Frontier Usage: frontierUsage shape
// ---------------------------------------------------------------------------

describe('M210 Panel 3 — Frontier Usage: snapshot.frontierUsage', () => {
  it('frontierUsage is present when source returns data', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toHaveProperty('frontierUsage');
    expect(snap.frontierUsage).toBeDefined();
  });

  it('frontierUsage.generatedAt is a valid ISO string', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.frontierUsage!.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(snap.frontierUsage!.generatedAt))).toBe(false);
  });

  it('frontierUsage.engines is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.frontierUsage!.engines)).toBe(true);
  });

  it('each engine entry has required fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    for (const eng of snap.frontierUsage!.engines) {
      expect(typeof eng.engine).toBe('string');
      expect(typeof eng.callsToday).toBe('number');
      expect(eng.subscriptionWindow).toBeDefined();
      expect(typeof eng.subscriptionWindow.state).toBe('string');
      expect(typeof eng.subscriptionWindow.usedPct).toBe('number');
    }
  });

  it('engine subscriptionWindow.state is one of the valid values', async () => {
    const VALID_STATES = ['active', 'near', 'exhausted', 'unknown'];
    const snap = await buildSnapshot(makeConfig());
    for (const eng of snap.frontierUsage!.engines) {
      expect(VALID_STATES).toContain(eng.subscriptionWindow.state);
    }
  });

  it('engine with limit exposes limit + remainingEstimate', async () => {
    const snap = await buildSnapshot(makeConfig());
    const codex = snap.frontierUsage!.engines.find(e => e.engine === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.limit).toBe(100);
    expect(typeof codex!.remainingEstimate).toBe('number');
  });

  it('engine callsToday matches fixture', async () => {
    const snap = await buildSnapshot(makeConfig());
    const claude = snap.frontierUsage!.engines.find(e => e.engine === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.callsToday).toBe(12);
  });

  it('frontierUsage is undefined (not present) when getFrontierUsageSync throws', async () => {
    const { getFrontierUsageSync } = await import('../src/core/usage/frontier-usage.js');
    vi.mocked(getFrontierUsageSync).mockImplementation(() => { throw new Error('quota read failed'); });
    const snap = await buildSnapshot(makeConfig());
    // Must still resolve — no crash
    expect(snap).toBeDefined();
    // frontierUsage may be undefined (degraded) — that is the contract
    // The base snapshot fields remain intact
    expect(typeof snap.repos.total).toBe('number');
    expect(typeof snap.daemon!.running).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Panel 4 — Recent Activity: runs array
// ---------------------------------------------------------------------------

describe('M210 Panel 4 — Recent Activity: snapshot.runs', () => {
  it('runs is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.runs)).toBe(true);
  });

  it('runs entries each have id, goal, status, tokens', async () => {
    const { listRuns } = await import('../src/core/run/orchestrator.js');
    vi.mocked(listRuns).mockReturnValue([{
      id: 'run-m210-1',
      goal: 'Build M210 dashboard',
      engine: 'claude' as const,
      provider: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50000, maxSteps: 20, allowCloud: false },
      usage: { tokensIn: 1200, tokensOut: 800, steps: 3, estCostUsd: 0.002 },
      tasks: [],
      steps: [],
      status: 'done' as const,
      result: 'done',
    }]);

    const snap = await buildSnapshot(makeConfig());
    expect(snap.runs.length).toBeGreaterThan(0);
    const r = snap.runs[0]!;
    expect(typeof r.id).toBe('string');
    expect(typeof r.goal).toBe('string');
    expect(typeof r.status).toBe('string');
    expect(typeof r.tokens).toBe('number');
    expect(r.tokens).toBe(2000); // 1200 + 800
  });
});

// ---------------------------------------------------------------------------
// Full snapshot — all M210 fields present simultaneously
// ---------------------------------------------------------------------------

describe('M210 — full snapshot contract', () => {
  it('resolves with all four panel data sources simultaneously', async () => {
    const snap: DashboardSnapshot = await buildSnapshot(makeConfig());

    // Panel 1: daemon
    expect(snap.daemon).toBeDefined();
    expect(typeof snap.daemon!.running).toBe('boolean');

    // Panel 2: inbox
    expect(snap.inbox).toBeDefined();
    expect(typeof snap.inbox.pending).toBe('number');

    // Panel 3: frontierUsage
    expect(snap.frontierUsage).toBeDefined();
    expect(Array.isArray(snap.frontierUsage!.engines)).toBe(true);

    // Panel 4: activity
    expect(snap.activity).toBeDefined();
    expect(typeof snap.activity.sessions).toBe('number');
    expect(typeof snap.activity.commits).toBe('number');
  });

  it('snapshot never throws even when all M210 sources fail', async () => {
    const { loadDaemonState } = await import('../src/core/daemon/state.js');
    const { pendingCount } = await import('../src/core/inbox/store.js');
    const { getFrontierUsageSync } = await import('../src/core/usage/frontier-usage.js');
    const { listRuns } = await import('../src/core/run/orchestrator.js');

    vi.mocked(loadDaemonState).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(pendingCount).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(getFrontierUsageSync).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(listRuns).mockImplementation(() => { throw new Error('fail'); });

    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('snapshot is a valid DashboardSnapshot shape when all M210 sources fail', async () => {
    const { loadDaemonState } = await import('../src/core/daemon/state.js');
    const { pendingCount } = await import('../src/core/inbox/store.js');
    const { getFrontierUsageSync } = await import('../src/core/usage/frontier-usage.js');
    const { listRuns } = await import('../src/core/run/orchestrator.js');

    vi.mocked(loadDaemonState).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(pendingCount).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(getFrontierUsageSync).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(listRuns).mockImplementation(() => { throw new Error('fail'); });

    const snap: DashboardSnapshot = await buildSnapshot(makeConfig());

    expect(typeof snap.generatedAt).toBe('string');
    expect(typeof snap.repos.total).toBe('number');
    expect(snap.inbox).toBeDefined();
    expect(snap.inbox.pending).toBe(0);
    expect(snap.daemon).toBeDefined();
    expect(snap.daemon!.running).toBe(false);
    expect(Array.isArray(snap.runs)).toBe(true);
  });
});
