/**
 * m26.reflect.test.ts — hermetic unit tests for core/learn/reflect.ts.
 *
 * The deterministic reflection metrics engine. Every external read
 * (listSwarms / genomeHealth / collectUsageEvents / loadPreviousReport) is
 * MOCKED — the test NEVER touches the real ~/.ashlr, real swarm history, real
 * usage transcripts, or the real portfolio. No network, no LLM.
 *
 * Invariants under test:
 *   1. DETERMINISTIC METRICS — success rate, avg/total cost & tokens, local
 *      share are computed exactly from synthetic fixtures.
 *   2. LOCAL-vs-CLOUD SPLIT — localShare reflects only LOCAL-provider tokens.
 *   3. FAILURE CLUSTERING — failed tasks cluster by normalized error key,
 *      most-frequent first, with bounded example ids.
 *   4. GOAL CLASSIFICATION — goals bucket into coarse categories deterministically.
 *   5. WEEK-OVER-WEEK DELTA — deltas are computed vs a seeded prior snapshot
 *      (effectiveness = success-rate point change; cost = % change), with
 *      divide-by-zero + no-prior guards.
 *   6. BOUNDED — never analyzes more than maxRuns most-recent swarms.
 *   7. NO NETWORK / NO LLM — reflect.ts imports neither fetch nor getActiveClient.
 *   8. NEVER THROWS — degrades to a zeroed report on any failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AshlrConfig,
  GenomeHealth,
  ReflectionReport,
  RunUsage,
  SwarmRun,
  SwarmTaskRun,
  UsageEvent,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks for every external read in reflect.ts (hoisted by vitest)
// ---------------------------------------------------------------------------

const mockListSwarms = vi.fn<() => SwarmRun[]>(() => []);
const mockGenomeHealth = vi.fn<() => GenomeHealth>(() => ({
  totalEntries: 0,
  projects: 0,
  hubEntries: 0,
  sizeBytes: 0,
  lastLearnedAt: null,
  embeddingsAvailable: false,
}));
const mockCollectUsage = vi.fn<(sinceMs: number) => UsageEvent[]>(() => []);
const mockLoadPrevious = vi.fn<(before?: string) => ReflectionReport | null>(
  () => null,
);

vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: (...a: unknown[]) => mockListSwarms(...(a as [])),
}));

// reflect.ts uses the HUB-ONLY health reader (genomeHubHealth) — NOT
// genomeHealth — so it never triggers a portfolio disk scan (no loadGenome /
// discoverGenomeRepos). The mock is wired to that exact symbol.
vi.mock('../src/core/genome/store.js', () => ({
  genomeHubHealth: () => mockGenomeHealth(),
}));

vi.mock('../src/core/observability/usage-source.js', () => ({
  collectUsageEvents: (sinceMs: number) => mockCollectUsage(sinceMs),
}));

// Real local/cloud classifier (pure, no I/O) — exercise the actual logic.
vi.mock('../src/core/observability/rollup.js', () => ({
  isLocalProviderModel: (model: string): boolean => {
    const m = (model ?? '').toLowerCase();
    return m.includes('ollama') || m.includes('lmstudio');
  },
}));

vi.mock('../src/core/learn/store.js', () => ({
  loadPreviousReport: (before?: string) => mockLoadPrevious(before),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  buildReflection,
  classifyGoal,
  clusterFailures,
  computeDelta,
  normalizeErrorKey,
  summarizeGoalCategories,
  DEFAULT_MAX_RUNS,
  DEFAULT_USAGE_LOOKBACK_MS,
} from '../src/core/learn/reflect.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
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
  } as AshlrConfig;
}

function usage(tokensIn: number, tokensOut: number, estCostUsd: number): RunUsage {
  return { tokensIn, tokensOut, steps: 1, estCostUsd };
}

function task(
  partial: Partial<SwarmTaskRun> & Pick<SwarmTaskRun, 'id' | 'status'>,
): SwarmTaskRun {
  return { phase: 'build', ...partial } as SwarmTaskRun;
}

let swarmCounter = 0;
function swarm(partial: Partial<SwarmRun>): SwarmRun {
  swarmCounter += 1;
  const createdAt = partial.createdAt ?? `2026-06-0${(swarmCounter % 9) + 1}T00:00:00.000Z`;
  return {
    id: partial.id ?? `s${swarmCounter}`,
    goal: partial.goal ?? 'do something',
    specId: null,
    project: null,
    createdAt,
    updatedAt: partial.updatedAt ?? createdAt,
    budget: {} as SwarmRun['budget'],
    usage: partial.usage ?? usage(0, 0, 0),
    parallel: 1,
    status: partial.status ?? 'done',
    plan: { specId: null, goal: partial.goal ?? 'do something', tasks: [] },
    tasks: partial.tasks ?? [],
  } as SwarmRun;
}

function priorReport(over: Partial<ReflectionReport>): ReflectionReport {
  return {
    generatedAt: '2026-06-01T00:00:00.000Z',
    since: '2026-05-25T00:00:00.000Z',
    window: '7d',
    swarmsAnalyzed: 10,
    swarmsDone: 5,
    swarmsFailed: 5,
    successRate: 0.5,
    avgCostUsd: 1.0,
    avgTokens: 1000,
    totalCostUsd: 10,
    localShare: 0.4,
    topFailures: [],
    goalCategories: [],
    delta: {
      previousAt: null,
      effectivenessPct: null,
      costPct: null,
      localSharePct: null,
      headline: 'seed',
    },
    genome: {
      totalEntries: 0,
      projects: 0,
      hubEntries: 0,
      sizeBytes: 0,
      lastLearnedAt: null,
      embeddingsAvailable: false,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  swarmCounter = 0;
  mockListSwarms.mockReturnValue([]);
  mockGenomeHealth.mockReturnValue({
    totalEntries: 0,
    projects: 0,
    hubEntries: 0,
    sizeBytes: 0,
    lastLearnedAt: null,
    embeddingsAvailable: false,
  });
  mockCollectUsage.mockReturnValue([]);
  mockLoadPrevious.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// classifyGoal — deterministic bucketing
// ---------------------------------------------------------------------------

describe('classifyGoal', () => {
  it('buckets bugfix goals', () => {
    expect(classifyGoal('Fix the broken login bug')).toBe('bugfix');
    expect(classifyGoal('hotfix regression in parser')).toBe('bugfix');
  });
  it('buckets refactor goals', () => {
    expect(classifyGoal('Refactor the swarm runner')).toBe('refactor');
    expect(classifyGoal('rename SwarmRun to Run')).toBe('refactor');
  });
  it('buckets test goals (test keyword wins over feature add)', () => {
    expect(classifyGoal('Add tests for the reflect engine')).toBe('test');
  });
  it('buckets test goals when no fix keyword present', () => {
    expect(classifyGoal('write vitest coverage for store')).toBe('test');
  });
  it('buckets docs goals', () => {
    expect(classifyGoal('update the README documentation')).toBe('docs');
  });
  it('buckets chore goals', () => {
    expect(classifyGoal('bump deps and run lint')).toBe('chore');
  });
  it('buckets feature goals', () => {
    expect(classifyGoal('implement the new dashboard')).toBe('feature');
  });
  it('defaults to other for unmatched / empty', () => {
    expect(classifyGoal('')).toBe('other');
    expect(classifyGoal('zxqw plebbish')).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// normalizeErrorKey — stable clustering keys
// ---------------------------------------------------------------------------

describe('normalizeErrorKey', () => {
  it('strips paths/numbers so similar errors share a key', () => {
    const a = normalizeErrorKey('Timeout after 3000ms at /Users/x/foo.ts:12');
    const b = normalizeErrorKey('Timeout after 5000ms at /Users/y/bar.ts:99');
    expect(a).toBe(b);
    expect(a).toContain('timeout');
  });
  it('returns empty for empty input', () => {
    expect(normalizeErrorKey('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// clusterFailures — ranked failure modes
// ---------------------------------------------------------------------------

describe('clusterFailures', () => {
  it('clusters failed tasks by normalized error, most-frequent first', () => {
    const swarms: SwarmRun[] = [
      swarm({
        id: 'a',
        status: 'failed',
        tasks: [task({ id: 't1', status: 'failed', phase: 'verify', error: 'Timeout after 100ms' })],
      }),
      swarm({
        id: 'b',
        status: 'failed',
        tasks: [task({ id: 't2', status: 'failed', phase: 'verify', error: 'Timeout after 999ms' })],
      }),
      swarm({
        id: 'c',
        status: 'failed',
        tasks: [task({ id: 't3', status: 'failed', phase: 'build', error: 'type error TS2345' })],
      }),
    ];
    const modes = clusterFailures(swarms);
    expect(modes.length).toBe(2);
    // Timeout cluster has count 2 and ranks first.
    expect(modes[0].count).toBe(2);
    expect(modes[0].key).toContain('timeout'); // key is normalized (lowercase)
    expect(modes[0].exampleSwarmIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(modes[0].phases).toContain('verify');
  });

  it('falls back to the phase name when a failed task has no error', () => {
    const modes = clusterFailures([
      swarm({
        id: 'x',
        status: 'failed',
        tasks: [task({ id: 't', status: 'failed', phase: 'integrate', error: undefined })],
      }),
    ]);
    expect(modes.length).toBe(1);
    expect(modes[0].key).toBe('phase:integrate');
    expect(modes[0].count).toBe(1);
  });

  it('ignores non-failed tasks', () => {
    const modes = clusterFailures([
      swarm({
        id: 'ok',
        status: 'done',
        tasks: [task({ id: 't', status: 'done', phase: 'build' })],
      }),
    ]);
    expect(modes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// summarizeGoalCategories — per-category aggregation
// ---------------------------------------------------------------------------

describe('summarizeGoalCategories', () => {
  it('aggregates cost/tokens/success per category, most-expensive first', () => {
    const swarms: SwarmRun[] = [
      swarm({ goal: 'implement dashboard', status: 'done', usage: usage(100, 100, 5) }),
      swarm({ goal: 'build new widget', status: 'failed', usage: usage(50, 50, 3) }),
      swarm({ goal: 'fix login bug', status: 'done', usage: usage(10, 10, 1) }),
    ];
    const stats = summarizeGoalCategories(swarms);
    const feature = stats.find((s) => s.category === 'feature');
    const bugfix = stats.find((s) => s.category === 'bugfix');
    expect(feature?.swarms).toBe(2);
    expect(feature?.avgCostUsd).toBeCloseTo(4, 5); // (5+3)/2
    expect(feature?.successRate).toBeCloseTo(0.5, 5); // 1 done of 2
    expect(bugfix?.avgCostUsd).toBeCloseTo(1, 5);
    // Most-expensive first: feature (4) before bugfix (1).
    expect(stats[0].category).toBe('feature');
  });
});

// ---------------------------------------------------------------------------
// computeDelta — week-over-week
// ---------------------------------------------------------------------------

describe('computeDelta', () => {
  it('returns a no-prior delta when previous is null', () => {
    const d = computeDelta({ successRate: 0.9, avgCostUsd: 1, localShare: 0.5 }, null);
    expect(d.previousAt).toBeNull();
    expect(d.effectivenessPct).toBeNull();
    expect(d.costPct).toBeNull();
    expect(d.localSharePct).toBeNull();
    expect(d.headline).toMatch(/first reflection/i);
  });

  it('computes point + percent deltas vs a prior snapshot', () => {
    const prev = priorReport({ successRate: 0.5, avgCostUsd: 1.0, localShare: 0.4 });
    const d = computeDelta(
      { successRate: 0.62, avgCostUsd: 0.69, localShare: 0.5 },
      prev,
    );
    expect(d.previousAt).toBe('2026-06-01T00:00:00.000Z');
    expect(d.effectivenessPct).toBeCloseTo(12, 5); // (0.62-0.5)*100
    expect(d.costPct).toBeCloseTo(-31, 5); // (0.69-1.0)/1.0*100
    expect(d.localSharePct).toBeCloseTo(10, 5); // (0.5-0.4)*100
    expect(d.headline).toContain('12.0% more effective');
    expect(d.headline).toContain('31.0% cheaper');
  });

  it('guards divide-by-zero when prior avg cost is 0', () => {
    const prev = priorReport({ avgCostUsd: 0 });
    const grew = computeDelta({ successRate: 0.5, avgCostUsd: 2, localShare: 0.4 }, prev);
    expect(grew.costPct).toBe(100); // 0 -> >0 represented as +100% (newly non-zero)
    const stillZero = computeDelta({ successRate: 0.5, avgCostUsd: 0, localShare: 0.4 }, prev);
    expect(stillZero.costPct).toBe(0); // 0 -> 0 is no change
  });
});

// ---------------------------------------------------------------------------
// buildReflection — end-to-end deterministic metrics
// ---------------------------------------------------------------------------

describe('buildReflection — metrics', () => {
  it('computes success rate, avg/total cost & tokens from swarms', () => {
    mockListSwarms.mockReturnValue([
      swarm({ status: 'done', usage: usage(100, 100, 2) }),
      swarm({ status: 'done', usage: usage(200, 200, 4) }),
      swarm({ status: 'failed', usage: usage(50, 50, 1) }),
      swarm({ status: 'aborted', usage: usage(0, 0, 0) }),
    ]);
    const r = buildReflection(makeConfig());
    expect(r.swarmsAnalyzed).toBe(4);
    expect(r.swarmsDone).toBe(2);
    expect(r.swarmsFailed).toBe(2); // failed + aborted
    expect(r.successRate).toBeCloseTo(0.5, 5);
    expect(r.totalCostUsd).toBeCloseTo(7, 5);
    expect(r.avgCostUsd).toBeCloseTo(7 / 4, 5);
    // tokens: (200 + 400 + 100 + 0) = 700 over 4 = 175
    expect(r.avgTokens).toBeCloseTo(175, 5);
  });

  it('computes the local-vs-cloud token split from usage events', () => {
    mockListSwarms.mockReturnValue([swarm({ status: 'done', usage: usage(10, 10, 1) })]);
    mockCollectUsage.mockReturnValue([
      { ts: '2026-06-05T00:00:00Z', project: null, model: 'ollama/llama3', source: 'run', tokensIn: 300, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
      { ts: '2026-06-05T00:00:00Z', project: null, model: 'claude-3-5-sonnet', source: 'claude', tokensIn: 100, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
    const r = buildReflection(makeConfig());
    // 300 local of 400 total -> 0.75
    expect(r.localShare).toBeCloseTo(0.75, 5);
  });

  it('clusters failures and surfaces goal categories', () => {
    mockListSwarms.mockReturnValue([
      swarm({
        id: 'f1',
        goal: 'fix the crash bug',
        status: 'failed',
        usage: usage(10, 10, 1),
        tasks: [task({ id: 't', status: 'failed', phase: 'verify', error: 'Timeout after 10ms' })],
      }),
      swarm({
        id: 'f2',
        goal: 'fix another crash',
        status: 'failed',
        usage: usage(10, 10, 1),
        tasks: [task({ id: 't', status: 'failed', phase: 'verify', error: 'Timeout after 20ms' })],
      }),
    ]);
    const r = buildReflection(makeConfig());
    expect(r.topFailures.length).toBe(1);
    expect(r.topFailures[0].count).toBe(2);
    expect(r.goalCategories.some((g) => g.category === 'bugfix')).toBe(true);
  });

  it('computes week-over-week delta vs a seeded prior snapshot', () => {
    // current: 2 done of 2 -> successRate 1.0, avgCost 0.5
    mockListSwarms.mockReturnValue([
      swarm({ status: 'done', usage: usage(10, 10, 0.5) }),
      swarm({ status: 'done', usage: usage(10, 10, 0.5) }),
    ]);
    mockLoadPrevious.mockReturnValue(
      priorReport({ successRate: 0.5, avgCostUsd: 1.0, localShare: 0 }),
    );
    const r = buildReflection(makeConfig());
    expect(r.successRate).toBeCloseTo(1.0, 5);
    expect(r.avgCostUsd).toBeCloseTo(0.5, 5);
    expect(r.delta.previousAt).toBe('2026-06-01T00:00:00.000Z');
    expect(r.delta.effectivenessPct).toBeCloseTo(50, 5); // (1.0-0.5)*100
    expect(r.delta.costPct).toBeCloseTo(-50, 5); // (0.5-1.0)/1.0*100
    expect(mockLoadPrevious).toHaveBeenCalledWith(r.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// BOUNDED — never analyze more than maxRuns
// ---------------------------------------------------------------------------

describe('buildReflection — bounded', () => {
  it('analyzes at most maxRuns most-recent swarms', () => {
    const many: SwarmRun[] = [];
    for (let i = 0; i < 50; i++) many.push(swarm({ status: 'done', usage: usage(1, 1, 0.01) }));
    mockListSwarms.mockReturnValue(many);
    const r = buildReflection(makeConfig(), { maxRuns: 10 });
    expect(r.swarmsAnalyzed).toBe(10);
  });

  it('uses DEFAULT_MAX_RUNS when no maxRuns given', () => {
    const many: SwarmRun[] = [];
    for (let i = 0; i < DEFAULT_MAX_RUNS + 25; i++) {
      many.push(swarm({ status: 'done', usage: usage(1, 1, 0.01) }));
    }
    mockListSwarms.mockReturnValue(many);
    const r = buildReflection(makeConfig());
    expect(r.swarmsAnalyzed).toBe(DEFAULT_MAX_RUNS);
  });

  it('filters by the sinceMs window before capping', () => {
    const sinceMs = Date.parse('2026-06-05T00:00:00.000Z');
    mockListSwarms.mockReturnValue([
      swarm({ status: 'done', createdAt: '2026-06-06T00:00:00.000Z', usage: usage(1, 1, 1) }),
      swarm({ status: 'done', createdAt: '2026-06-01T00:00:00.000Z', usage: usage(1, 1, 1) }),
    ]);
    const r = buildReflection(makeConfig(), { sinceMs });
    expect(r.swarmsAnalyzed).toBe(1); // only the 06-06 swarm passes the window
    expect(mockCollectUsage).toHaveBeenCalledWith(sinceMs);
  });
});

// ---------------------------------------------------------------------------
// SAFETY — never throws, no LLM/network imports, default path makes no cloud call
// ---------------------------------------------------------------------------

describe('buildReflection — safety', () => {
  it('returns a zeroed report (never throws) when listSwarms throws', () => {
    mockListSwarms.mockImplementation(() => {
      throw new Error('swarm store boom');
    });
    let r: ReflectionReport | undefined;
    expect(() => {
      r = buildReflection(makeConfig());
    }).not.toThrow();
    expect(r?.swarmsAnalyzed).toBe(0);
    expect(r?.successRate).toBe(0);
    expect(r?.topFailures).toEqual([]);
  });

  it('returns a zeroed genome snapshot even when genomeHubHealth throws', () => {
    mockGenomeHealth.mockImplementation(() => {
      throw new Error('genome boom');
    });
    const r = buildReflection(makeConfig());
    expect(r.genome.totalEntries).toBe(0);
  });

  it('never populates narrative on the default deterministic path', () => {
    mockListSwarms.mockReturnValue([swarm({ status: 'done', usage: usage(1, 1, 1) })]);
    const r = buildReflection(makeConfig());
    expect(r.narrative).toBeUndefined();
    expect(r.narrativeLocal).toBeUndefined();
  });

  it('reflect.ts source imports neither fetch nor getActiveClient (no LLM/network)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'learn', 'reflect.ts'),
      'utf8',
    );
    // No call sites (doc-comment mentions of these names are allowed): assert
    // none appears as an actual invocation / import.
    expect(src).not.toMatch(/getActiveClient\s*\(/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bsaveConfig\s*\(/);
    expect(src).not.toMatch(/createProposal\s*\(|applyProposal\s*\(/);
    // And no imports of the cloud/provider client or config writer.
    expect(src).not.toMatch(/from ['"][^'"]*provider-client/);
    expect(src).not.toMatch(/import[^;]*\bsaveConfig\b/);
  });

  it('does NOT trigger a portfolio disk scan: uses genomeHubHealth, not loadGenome/genomeHealth', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'learn', 'reflect.ts'),
      'utf8',
    );
    // Hub-only health reader is used; the portfolio-walking readers are NOT.
    expect(src).toMatch(/genomeHubHealth\s*\(/);
    expect(src).not.toMatch(/\bloadGenome\s*\(/);
    expect(src).not.toMatch(/\bgenomeHealth\s*\(/);
    expect(src).not.toMatch(/discoverGenomeRepos/);
  });
});

// ---------------------------------------------------------------------------
// M26 fix: success rate uses TERMINAL swarms only (not in-flight runs)
// ---------------------------------------------------------------------------

describe('buildReflection — success rate excludes in-flight swarms', () => {
  it('computes successRate over terminal swarms only ({done,failed,aborted})', () => {
    // [done, done, running] => true completed success = 2/2 = 1.0, NOT 2/3.
    mockListSwarms.mockReturnValue([
      swarm({ status: 'done', usage: usage(10, 10, 1) }),
      swarm({ status: 'done', usage: usage(10, 10, 1) }),
      swarm({ status: 'running', usage: usage(5, 5, 0.5) }),
    ]);
    const r = buildReflection(makeConfig());
    expect(r.swarmsAnalyzed).toBe(3); // all three were READ
    expect(r.swarmsDone).toBe(2);
    expect(r.swarmsFailed).toBe(0);
    expect(r.successRate).toBeCloseTo(1.0, 5); // 2 done / 2 terminal
  });

  it('does not count planning / needs-approval as non-success in the denominator', () => {
    mockListSwarms.mockReturnValue([
      swarm({ status: 'done', usage: usage(10, 10, 1) }),
      swarm({ status: 'failed', usage: usage(10, 10, 1) }),
      swarm({ status: 'planning', usage: usage(0, 0, 0) }),
      swarm({ status: 'needs-approval', usage: usage(0, 0, 0) }),
    ]);
    const r = buildReflection(makeConfig());
    // terminal = done(1) + failed(1) = 2 => 1/2 = 0.5 (NOT 1/4 = 0.25).
    expect(r.successRate).toBeCloseTo(0.5, 5);
  });

  it('successRate is 0 when there are no terminal swarms', () => {
    mockListSwarms.mockReturnValue([
      swarm({ status: 'running', usage: usage(1, 1, 0) }),
      swarm({ status: 'planning', usage: usage(1, 1, 0) }),
    ]);
    const r = buildReflection(makeConfig());
    expect(r.successRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M26 fix: `since` sentinel + bounded default usage window
// ---------------------------------------------------------------------------

describe('buildReflection — window / since handling', () => {
  it("records since='all' (NOT the 1970 epoch) for the explicit --since all path", () => {
    mockListSwarms.mockReturnValue([swarm({ status: 'done', usage: usage(1, 1, 1) })]);
    // sinceMs===0 is the explicit '--since all' opt-in.
    const r = buildReflection(makeConfig(), { sinceMs: 0 });
    expect(r.since).toBe('all');
    expect(r.since).not.toContain('1970');
    expect(r.window).toBe('all');
    // 'all' scans everything => collectUsageEvents called with 0.
    expect(mockCollectUsage).toHaveBeenCalledWith(0);
  });

  it('default path (no --since) bounds the usage window to DEFAULT_USAGE_LOOKBACK_MS', () => {
    mockListSwarms.mockReturnValue([swarm({ status: 'done', usage: usage(1, 1, 1) })]);
    const before = Date.now() - DEFAULT_USAGE_LOOKBACK_MS;
    buildReflection(makeConfig());
    // collectUsageEvents must be called with a POSITIVE recent lower bound, not
    // 0 (which would stream the entire historical corpus).
    const arg = mockCollectUsage.mock.calls[0]?.[0] as number;
    expect(arg).toBeGreaterThan(0);
    expect(arg).toBeGreaterThanOrEqual(before - 1000);
    expect(arg).toBeLessThanOrEqual(Date.now());
  });

  it('default path records a concrete ISO since (never 1970, never the epoch)', () => {
    mockListSwarms.mockReturnValue([swarm({ status: 'done', usage: usage(1, 1, 1) })]);
    const r = buildReflection(makeConfig());
    expect(r.since).not.toBe('all');
    expect(r.since).not.toContain('1970');
    expect(Date.parse(r.since)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M26 fix: week-over-week delta annotates mismatched windows
// ---------------------------------------------------------------------------

describe('computeDelta — window mismatch annotation', () => {
  it('annotates the headline when the prior snapshot window differs', () => {
    const prev = priorReport({ window: '7d', successRate: 0.5, avgCostUsd: 1, localShare: 0.4 });
    const d = computeDelta(
      { successRate: 0.6, avgCostUsd: 1, localShare: 0.4 },
      prev,
      '30d', // current window differs from prior '7d'
    );
    expect(d.headline).toMatch(/windows differ/i);
    expect(d.headline).toContain('7d');
    expect(d.headline).toContain('30d');
  });

  it('does NOT annotate when windows match', () => {
    const prev = priorReport({ window: '7d', successRate: 0.5, avgCostUsd: 1, localShare: 0.4 });
    const d = computeDelta(
      { successRate: 0.6, avgCostUsd: 1, localShare: 0.4 },
      prev,
      '7d',
    );
    expect(d.headline).not.toMatch(/windows differ/i);
  });

  it('does NOT annotate when the current window is omitted (back-compat)', () => {
    const prev = priorReport({ window: '7d' });
    const d = computeDelta({ successRate: 0.6, avgCostUsd: 1, localShare: 0.4 }, prev);
    expect(d.headline).not.toMatch(/windows differ/i);
  });
});
