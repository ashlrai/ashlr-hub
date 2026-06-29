/**
 * M242 Intelligence Panel tests — hermetic, all data-source modules mocked.
 *
 * Verifies:
 *   - buildSnapshot exposes snapshot.intelligence with the full shape
 *   - routingScores: EngineScore rows mapped to trend + taskClass
 *   - antiPlaybooks: genome entries tagged 'm235:anti-playbook'
 *   - engineScorecards: per-engine ship/review/noise/harmful + shipRate from decisions ledger
 *   - recentEvents: event-bus ledger entries surfaced as kind/detail/ts
 *   - 24h window filtering: decisions older than 24h excluded from scorecards
 *   - Graceful degradation: snapshot still resolves when any intelligence source throws
 *   - Pre-M242 snapshots remain valid (intelligence field is optional)
 *   - x2 determinism: all assertions use FIXED timestamps, no Date.now()-derived flakiness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, DashboardSnapshot, IntelligenceSummary } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixed timestamps — no Date.now() flakiness
// ---------------------------------------------------------------------------

const FIXED_NOW_ISO = '2026-06-17T12:00:00.000Z';
const FIXED_NOW_MS  = Date.parse(FIXED_NOW_ISO);   // 1750161600000
const FIXED_12H_AGO = new Date(FIXED_NOW_MS - 12 * 3600 * 1000).toISOString();  // within 24h
const FIXED_25H_AGO = new Date(FIXED_NOW_MS - 25 * 3600 * 1000).toISOString();  // outside 24h
const FIXED_2D_AGO  = new Date(FIXED_NOW_MS -  2 * 24 * 3600 * 1000).toISOString();  // within 72h
const FIXED_4D_AGO  = new Date(FIXED_NOW_MS -  4 * 24 * 3600 * 1000).toISOString();  // outside 72h

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
// Base module mocks required by buildSnapshot (pre-M242 modules)
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
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: () => Promise.resolve(FIXTURE_ROLLUP) }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: () => [] }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: () => [] }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => FIXTURE_MCP_REGISTRY }));
vi.mock('../src/core/daemon/state.js', () => ({ loadDaemonState: () => FIXTURE_DAEMON_STATE }));
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: () => FIXTURE_FRONTIER_USAGE,
}));
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: () => 0,
  listProposals: () => [],
}));
vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: () => [],
}));
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: () => [],
  createGoal: () => {},
}));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: () => ({ total: 0, done: 0 }),
}));

// ---------------------------------------------------------------------------
// Intelligence-specific module mocks
// ---------------------------------------------------------------------------

/** Fixture decisions for engine-scorecard and event tests */
const FIXTURE_DECISIONS_24H = [
  // claude: 2 ship, 1 review  (within 24h)
  { ts: FIXED_12H_AGO, proposalId: 'repo:issue:aaa', action: 'judged', engine: 'claude', model: 'opus',   verdict: 'ship',   reason: '' },
  { ts: FIXED_12H_AGO, proposalId: 'repo:issue:bbb', action: 'judged', engine: 'claude', model: 'sonnet', verdict: 'ship',   reason: '' },
  { ts: FIXED_12H_AGO, proposalId: 'repo:issue:ccc', action: 'judged', engine: 'claude', model: 'sonnet', verdict: 'review', reason: '' },
  // codex: 1 ship, 1 noise  (within 24h)
  { ts: FIXED_12H_AGO, proposalId: 'repo:lint:ddd',  action: 'judged', engine: 'codex',  model: null,     verdict: 'ship',   reason: '' },
  { ts: FIXED_12H_AGO, proposalId: 'repo:lint:eee',  action: 'judged', engine: 'codex',  model: null,     verdict: 'noise',  reason: '' },
  // Older than 24h → excluded from scorecard
  { ts: FIXED_25H_AGO, proposalId: 'repo:issue:zzz', action: 'judged', engine: 'nim',    model: null,     verdict: 'ship',   reason: '' },
  // merge:shipped event within 72h (action='merged')
  { ts: FIXED_2D_AGO,  proposalId: 'repo:issue:mmm', action: 'merged',    engine: 'claude', model: 'sonnet', verdict: 'ship', reason: 'Merged fix/lint-cleanup', detail: 'auto-merge' },
  // Event older than 72h → excluded from recentEvents
  { ts: FIXED_4D_AGO,  proposalId: 'repo:issue:yyy', action: 'merged',    engine: 'claude', model: 'opus',   verdict: 'ship', reason: 'Goal finished',         detail: 'auto-merge' },
];

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn((opts?: { sinceMs?: number; limit?: number }) => {
    const since = opts?.sinceMs ?? 0;
    const filtered = FIXTURE_DECISIONS_24H.filter(d => Date.parse(d.ts) >= since);
    const limit = opts?.limit ?? Infinity;
    return filtered.slice(0, limit);
  }),
  recordDecision: vi.fn(() => {}),
}));

/** Fixture genome entries — one anti-playbook, one unrelated */
const FIXTURE_GENOME_ENTRIES = [
  {
    id: 'ap-001',
    project: null,
    source: 'hub' as const,
    title: 'Anti-playbook: avoid trivial whitespace diffs',
    text: 'A proposal titled "Fix trailing spaces" was judged \'noise\' (was too trivial / low-value).\n\nJudge reasoning: diff only changes whitespace.\n\nFuture agents: if your diff matches this pattern, reconsider before proposing.',
    tags: ['m235:anti-playbook'],
    ts: FIXED_12H_AGO,
  },
  {
    id: 'gen-002',
    project: 'my-repo',
    source: 'project' as const,
    title: 'Use TypeScript strict mode',
    text: 'Enable strict in tsconfig.json for better type safety.',
    tags: ['convention'],
    ts: FIXED_12H_AGO,
  },
];

vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => FIXTURE_GENOME_ENTRIES),
  appendHubEntry: vi.fn(() => ({ id: 'x', project: null, source: 'hub', title: '', text: '', tags: [], ts: FIXED_NOW_ISO })),
}));

/** Fixture routing scores for M240 */
const FIXTURE_SCORE_MAP = new Map([
  ['claude:opus',   { key: 'claude:opus',   engine: 'claude', model: 'opus',   score: 0.85, samples: 12 }],
  ['claude:sonnet', { key: 'claude:sonnet', engine: 'claude', model: 'sonnet', score: 0.55, samples:  8 }],
  ['codex',         { key: 'codex',         engine: 'codex',  model: null,     score: 0.30, samples:  6 }],
]);

vi.mock('../src/core/run/learned-router.js', () => ({
  buildEngineScores: vi.fn((_taskClass: string) => FIXTURE_SCORE_MAP),
  sortEnginesByScore: vi.fn((engines: string[]) => engines),
  engineScoreFor: vi.fn(() => 0.5),
  LEARNED_ROUTING_MIN_SAMPLES: 5,
  LEARNED_ROUTING_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

const { buildSnapshot } = await import('../src/core/dashboard.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snapshotWithIntelligence(): Promise<DashboardSnapshot> {
  return buildSnapshot(makeConfig());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M242 — intelligence panel in buildSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin Date.now() to FIXED_NOW_MS so time-windowed filtering in buildIntelligence
    // produces deterministic results regardless of when the test suite runs.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('snapshot.intelligence is present and has the correct shape', async () => {
    const snap = await snapshotWithIntelligence();
    expect(snap.intelligence).toBeDefined();
    const intel = snap.intelligence as IntelligenceSummary;
    expect(intel).toHaveProperty('generatedAt');
    expect(typeof intel.generatedAt).toBe('string');
    expect(Array.isArray(intel.routingScores)).toBe(true);
    expect(Array.isArray(intel.antiPlaybooks)).toBe(true);
    expect(Array.isArray(intel.engineScorecards)).toBe(true);
    expect(Array.isArray(intel.recentEvents)).toBe(true);
  });

  // ── M240: Learned routing scores ────────────────────────────────────────

  it('routingScores maps EngineScore to trend correctly', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    // claude:opus score=0.85 → promoted
    const opus = intel.routingScores.find(r => r.key === 'claude:opus');
    expect(opus).toBeDefined();
    expect(opus!.engine).toBe('claude');
    expect(opus!.model).toBe('opus');
    expect(opus!.score).toBe(0.85);
    expect(opus!.trend).toBe('promoted');

    // codex score=0.30 → demoted
    const codex = intel.routingScores.find(r => r.key === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.trend).toBe('demoted');

    // claude:sonnet score=0.55 → neutral (between 0.45 and 0.55)
    const sonnet = intel.routingScores.find(r => r.key === 'claude:sonnet');
    expect(sonnet).toBeDefined();
    expect(sonnet!.trend).toBe('neutral');
  });

  it('routingScores are sorted highest score first', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    const scores = intel.routingScores.map(r => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  // ── M235: Anti-playbook lessons ─────────────────────────────────────────

  it('antiPlaybooks only includes entries tagged m235:anti-playbook', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    expect(intel.antiPlaybooks.length).toBe(1);
    expect(intel.antiPlaybooks[0]!.id).toBe('ap-001');
    expect(intel.antiPlaybooks[0]!.title).toBe('Anti-playbook: avoid trivial whitespace diffs');
    // Snippet is capped at 200 chars
    expect(intel.antiPlaybooks[0]!.snippet.length).toBeLessThanOrEqual(200);
    expect(intel.antiPlaybooks[0]!.ts).toBe(FIXED_12H_AGO);
  });

  it('antiPlaybooks does NOT include non-anti-playbook genome entries', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    const ids = intel.antiPlaybooks.map(a => a.id);
    expect(ids).not.toContain('gen-002');
  });

  // ── Per-engine scorecards ───────────────────────────────────────────────

  it('engineScorecards aggregates judge verdicts per engine (24h)', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    const claude = intel.engineScorecards.find(s => s.engine === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.ship).toBe(2);
    expect(claude!.review).toBe(1);
    expect(claude!.noise).toBe(0);
    expect(claude!.harmful).toBe(0);
    expect(claude!.total).toBe(3);
    expect(claude!.shipRate).toBeCloseTo(2 / 3, 5);

    const codex = intel.engineScorecards.find(s => s.engine === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.ship).toBe(1);
    expect(codex!.noise).toBe(1);
    expect(codex!.total).toBe(2);
    expect(codex!.shipRate).toBe(0.5);
  });

  it('engineScorecards excludes decisions older than 24h', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    // 'nim' only had a decision at FIXED_25H_AGO (>24h ago) → not in scorecards
    const nim = intel.engineScorecards.find(s => s.engine === 'nim');
    expect(nim).toBeUndefined();
  });

  it('engineScorecards are sorted by shipRate descending', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    const rates = intel.engineScorecards.map(s => s.shipRate);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]!).toBeLessThanOrEqual(rates[i - 1]!);
    }
  });

  // ── M241: Recent fleet events ────────────────────────────────────────────

  it('recentEvents surfaces event-bus decisions within 72h', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    // FIXED_2D_AGO is within 72h
    const ev = intel.recentEvents.find(e => e.detail === 'Merged fix/lint-cleanup');
    expect(ev).toBeDefined();
    expect(ev!.kind).toContain('merge');
    expect(ev!.ts).toBe(FIXED_2D_AGO);
  });

  it('recentEvents excludes event-bus decisions older than 72h', async () => {
    const intel = (await snapshotWithIntelligence()).intelligence!;
    // FIXED_4D_AGO is older than 72h
    const old = intel.recentEvents.find(e => e.detail === 'Goal finished');
    expect(old).toBeUndefined();
  });

  // ── Graceful degradation ─────────────────────────────────────────────────

  it('snapshot resolves even when learned-router throws', async () => {
    const { buildEngineScores } = await import('../src/core/run/learned-router.js');
    vi.mocked(buildEngineScores).mockImplementationOnce(() => { throw new Error('router exploded'); });
    const snap = await buildSnapshot(makeConfig());
    // snapshot itself must resolve
    expect(snap).toBeDefined();
    expect(snap.generatedAt).toBeTruthy();
    // intelligence degrades gracefully — either undefined or has empty routingScores
    if (snap.intelligence) {
      expect(Array.isArray(snap.intelligence.routingScores)).toBe(true);
    }
  });

  it('snapshot resolves even when decisions ledger throws', async () => {
    const { readDecisions } = await import('../src/core/fleet/decisions-ledger.js');
    vi.mocked(readDecisions).mockImplementationOnce(() => { throw new Error('ledger exploded'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
    expect(snap.generatedAt).toBeTruthy();
  });

  it('snapshot resolves even when genome store throws', async () => {
    const { loadGenome } = await import('../src/core/genome/store.js');
    vi.mocked(loadGenome).mockImplementationOnce(() => { throw new Error('genome exploded'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
  });

  // ── Pre-M242 compatibility ───────────────────────────────────────────────

  it('intelligence field is optional — pre-M242 snapshot shape is still valid', () => {
    // A snapshot without intelligence must satisfy DashboardSnapshot
    const preM242Snap: DashboardSnapshot = {
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
    // Type-level: intelligence is optional so this is valid TypeScript.
    // Runtime: no intelligence field present
    expect(preM242Snap.intelligence).toBeUndefined();
  });

  // ── x2 determinism ───────────────────────────────────────────────────────

  it('produces identical results on two consecutive calls (x2 determinism)', async () => {
    const snap1 = await buildSnapshot(makeConfig());
    const snap2 = await buildSnapshot(makeConfig());
    const i1 = snap1.intelligence;
    const i2 = snap2.intelligence;
    expect(i1).toBeDefined();
    expect(i2).toBeDefined();
    expect(i1!.routingScores.length).toBe(i2!.routingScores.length);
    expect(i1!.antiPlaybooks.length).toBe(i2!.antiPlaybooks.length);
    expect(i1!.engineScorecards.length).toBe(i2!.engineScorecards.length);
    expect(i1!.recentEvents.length).toBe(i2!.recentEvents.length);
    // Key-level equality (order-stable since both runs use the same fixture maps)
    for (let i = 0; i < i1!.routingScores.length; i++) {
      expect(i1!.routingScores[i]!.key).toBe(i2!.routingScores[i]!.key);
      expect(i1!.routingScores[i]!.score).toBe(i2!.routingScores[i]!.score);
      expect(i1!.routingScores[i]!.trend).toBe(i2!.routingScores[i]!.trend);
    }
    for (let i = 0; i < i1!.antiPlaybooks.length; i++) {
      expect(i1!.antiPlaybooks[i]!.id).toBe(i2!.antiPlaybooks[i]!.id);
    }
    for (let i = 0; i < i1!.engineScorecards.length; i++) {
      expect(i1!.engineScorecards[i]!.engine).toBe(i2!.engineScorecards[i]!.engine);
      expect(i1!.engineScorecards[i]!.shipRate).toBe(i2!.engineScorecards[i]!.shipRate);
    }
  });
});
