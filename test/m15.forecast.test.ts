/**
 * M15 forecast tests — hermetic, mocked rollup, no real filesystem reads.
 *
 * Covers buildForecast:
 *   - spentUsd reflects actual cloud spend in the window
 *   - spentUsd=0 when all usage was local (ollama/lmstudio tokens = $0)
 *   - localSavingsUsd > 0 when local tokens were used (would-have-been cloud cost)
 *   - localSavingsUsd = 0 when no tokens were processed
 *   - projectedMonthlyUsd extrapolates from the window rate to ~30 days
 *   - projectedMonthlyUsd = 0 when spentUsd = 0 and no cloud spend
 *   - window field matches the requested window label
 *   - CostForecast shape is correct
 *   - 7d and 30d windows produce correct extrapolation factors
 *
 * Invariants:
 *   - Estimates are finite numbers (no Infinity/NaN)
 *   - Estimates are >= 0 (no negative costs)
 *   - localSavingsUsd is an ESTIMATE of what local tokens would have cost
 *     on cloud — it can be > spentUsd (which is $0 for pure-local runs)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, ActivityRollup, UsageEvent } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock buildRollup so no real filesystem/git operations happen
// ---------------------------------------------------------------------------

const mockBuildRollup = vi.fn();

// modelToProviderKey / isLocalProviderModel mirror the real rollup.ts logic so
// forecast's local/cloud split is exercised against the same derivation the
// production code uses (not a divergent stub).
function modelToProviderKey(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude'))  return 'claude';
  if (m.startsWith('gpt'))     return 'gpt';
  if (m.startsWith('gemini'))  return 'gemini';
  if (m.startsWith('mistral')) return 'mistral';
  if (m.startsWith('cohere'))  return 'cohere';
  if (m.includes('ollama'))    return 'ollama';
  if (m.includes('lmstudio'))  return 'lmstudio';
  return model;
}

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: (...args: unknown[]) => mockBuildRollup(...args),
  windowToMs: (w: string): number => {
    if (w === '1d')  return 86_400_000;
    if (w === '7d')  return 7 * 86_400_000;
    if (w === '30d') return 30 * 86_400_000;
    return 7 * 86_400_000;
  },
  modelToProviderKey,
  LOCAL_PROVIDER_KEYS: new Set(['ollama', 'lmstudio']),
  isLocalProviderModel: (model: string): boolean =>
    new Set(['ollama', 'lmstudio']).has(modelToProviderKey(model)),
}));

// Also mock the index-engine (may be transitively required)
vi.mock('../src/core/index-engine.js', () => ({
  loadIndex: vi.fn(() => null),
  buildIndex: vi.fn(async () => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    root: '/tmp',
    items: [],
  })),
}));

// Mock usage-source to prevent real filesystem reads
vi.mock('../src/core/observability/usage-source.js', () => ({
  collectUsageEvents: vi.fn(() => [] as UsageEvent[]),
  claudeProjectsDir: () => '/tmp/fake-projects',
  decodeProjectPath: (d: string) => '/' + d.replace(/-/g, '/'),
  dashNormalize: (p: string) => p.replace(/[/-]/g, '-').toLowerCase(),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { buildForecast } from '../src/core/observability/forecast.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
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
      providerChain: ['ollama', 'lmstudio'],
    },
    telemetry: {},
    tools: {},
    ...overrides,
  };
}

function makeRollup(
  window: '7d' | '30d',
  overrides: Partial<ActivityRollup['totals']> = {},
  byModel: ActivityRollup['byModel'] = [],
): ActivityRollup {
  const defaultTotals = {
    tokensIn: 0,
    tokensOut: 0,
    estCostUsd: 0,
    sessions: 0,
    commits: 0,
  };
  return {
    window,
    since: new Date(Date.now() - (window === '7d' ? 7 : 30) * 86_400_000).toISOString(),
    totals: { ...defaultTotals, ...overrides },
    byProject: [],
    byDay: [],
    byModel,
    budget: {
      level: 'ok',
      window,
      spentUsd: overrides.estCostUsd ?? 0,
      capUsd: null,
      spentTokens: (overrides.tokensIn ?? 0) + (overrides.tokensOut ?? 0),
      capTokens: null,
      message: 'ok',
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRollup.mockReturnValue(makeRollup('7d'));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// CostForecast shape
// ---------------------------------------------------------------------------

describe('buildForecast — output shape', () => {
  it('returns all required CostForecast fields', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d'));
    const forecast = buildForecast('7d', makeConfig());
    expect(typeof forecast.window).toBe('string');
    expect(typeof forecast.spentUsd).toBe('number');
    expect(typeof forecast.localSavingsUsd).toBe('number');
    expect(typeof forecast.projectedMonthlyUsd).toBe('number');
  });

  it('window field matches the requested window', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d'));
    const f7 = buildForecast('7d', makeConfig());
    expect(f7.window).toBe('7d');

    mockBuildRollup.mockReturnValue(makeRollup('30d'));
    const f30 = buildForecast('30d', makeConfig());
    expect(f30.window).toBe('30d');
  });

  it('all numeric fields are finite (no Infinity or NaN)', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 100_000, tokensOut: 50_000, estCostUsd: 5.0 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(isFinite(forecast.spentUsd)).toBe(true);
    expect(isFinite(forecast.localSavingsUsd)).toBe(true);
    expect(isFinite(forecast.projectedMonthlyUsd)).toBe(true);
    expect(isNaN(forecast.spentUsd)).toBe(false);
    expect(isNaN(forecast.localSavingsUsd)).toBe(false);
    expect(isNaN(forecast.projectedMonthlyUsd)).toBe(false);
  });

  it('all numeric fields are non-negative', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 50_000, tokensOut: 20_000, estCostUsd: 2.5 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.spentUsd).toBeGreaterThanOrEqual(0);
    expect(forecast.localSavingsUsd).toBeGreaterThanOrEqual(0);
    expect(forecast.projectedMonthlyUsd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// spentUsd — cloud spend attribution
// ---------------------------------------------------------------------------

describe('buildForecast — spentUsd', () => {
  it('reflects actual cloud spend from the rollup', () => {
    const cloudSpend = 12.50;
    mockBuildRollup.mockReturnValue(makeRollup('7d', { estCostUsd: cloudSpend }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.spentUsd).toBeCloseTo(cloudSpend, 4);
  });

  it('is 0 when rollup estCostUsd is 0', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { estCostUsd: 0 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.spentUsd).toBe(0);
  });

  it('is 0 for a pure-local run (ollama/lmstudio tokens only, $0 cost)', () => {
    // Local tokens have estCostUsd=0 in the rollup
    mockBuildRollup.mockReturnValue(
      makeRollup(
        '7d',
        { tokensIn: 500_000, tokensOut: 200_000, estCostUsd: 0 },
        [
          { model: 'ollama', tokensIn: 500_000, tokensOut: 200_000, estCostUsd: 0, calls: 10 },
        ],
      ),
    );
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.spentUsd).toBe(0);
  });

  it('correctly reflects cloud spend when mixed local+cloud usage', () => {
    const cloudCost = 3.75;
    mockBuildRollup.mockReturnValue(
      makeRollup(
        '7d',
        { tokensIn: 1_000_000, tokensOut: 400_000, estCostUsd: cloudCost },
        [
          { model: 'claude-sonnet', tokensIn: 500_000, tokensOut: 200_000, estCostUsd: cloudCost, calls: 5 },
          { model: 'ollama', tokensIn: 500_000, tokensOut: 200_000, estCostUsd: 0, calls: 10 },
        ],
      ),
    );
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.spentUsd).toBeCloseTo(cloudCost, 4);
  });
});

// ---------------------------------------------------------------------------
// localSavingsUsd — would-have-been-cloud estimate
// ---------------------------------------------------------------------------

describe('buildForecast — localSavingsUsd', () => {
  it('is > 0 when local tokens were processed', () => {
    // Pure local run: $0 spent, but savings > 0 because those tokens would have cost cloud money
    mockBuildRollup.mockReturnValue(
      makeRollup(
        '7d',
        { tokensIn: 500_000, tokensOut: 200_000, estCostUsd: 0 },
        [
          { model: 'ollama', tokensIn: 500_000, tokensOut: 200_000, estCostUsd: 0, calls: 10 },
        ],
      ),
    );
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.localSavingsUsd).toBeGreaterThan(0);
  });

  it('is 0 when no tokens were processed at all', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 0, tokensOut: 0, estCostUsd: 0 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.localSavingsUsd).toBe(0);
  });

  it('scales with number of local tokens', () => {
    const smallRollup = makeRollup('7d', { tokensIn: 10_000, tokensOut: 5_000, estCostUsd: 0 }, [
      { model: 'ollama', tokensIn: 10_000, tokensOut: 5_000, estCostUsd: 0, calls: 2 },
    ]);
    const largeRollup = makeRollup('7d', { tokensIn: 1_000_000, tokensOut: 500_000, estCostUsd: 0 }, [
      { model: 'ollama', tokensIn: 1_000_000, tokensOut: 500_000, estCostUsd: 0, calls: 20 },
    ]);

    mockBuildRollup.mockReturnValueOnce(smallRollup);
    const forecastSmall = buildForecast('7d', makeConfig());

    mockBuildRollup.mockReturnValueOnce(largeRollup);
    const forecastLarge = buildForecast('7d', makeConfig());

    expect(forecastLarge.localSavingsUsd).toBeGreaterThan(forecastSmall.localSavingsUsd);
  });

  it('can exceed spentUsd (savings > actual spend when heavy local usage)', () => {
    // Pure local: spent $0, but savings could be $50+ for heavy usage
    mockBuildRollup.mockReturnValue(
      makeRollup(
        '7d',
        { tokensIn: 5_000_000, tokensOut: 2_000_000, estCostUsd: 0 },
        [
          { model: 'ollama', tokensIn: 5_000_000, tokensOut: 2_000_000, estCostUsd: 0, calls: 50 },
        ],
      ),
    );
    const forecast = buildForecast('7d', makeConfig());
    // savings should be positive and greater than $0 (the actual spend)
    expect(forecast.localSavingsUsd).toBeGreaterThan(0);
    expect(forecast.localSavingsUsd).toBeGreaterThan(forecast.spentUsd);
  });
});

// ---------------------------------------------------------------------------
// projectedMonthlyUsd — rate extrapolation
// ---------------------------------------------------------------------------

describe('buildForecast — projectedMonthlyUsd', () => {
  it('is 0 when spentUsd is 0 (no cloud spend)', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { estCostUsd: 0 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.projectedMonthlyUsd).toBe(0);
  });

  it('extrapolates 7d rate to 30 days: projectedMonthly ≈ spentUsd * (30/7)', () => {
    const spend7d = 7.0; // $7 over 7 days = $1/day
    mockBuildRollup.mockReturnValue(makeRollup('7d', { estCostUsd: spend7d }));
    const forecast = buildForecast('7d', makeConfig());
    const expected = spend7d * (30 / 7);
    // Allow ±5% tolerance for rounding
    expect(forecast.projectedMonthlyUsd).toBeGreaterThan(expected * 0.95);
    expect(forecast.projectedMonthlyUsd).toBeLessThan(expected * 1.05);
  });

  it('extrapolates 30d rate to 30 days: projectedMonthly ≈ spentUsd * 1', () => {
    const spend30d = 30.0; // $30 over 30 days = $1/day → $30/month
    mockBuildRollup.mockReturnValue(makeRollup('30d', { estCostUsd: spend30d }));
    const forecast = buildForecast('30d', makeConfig());
    // For a 30d window, extrapolating to 30d should be approximately the same
    expect(forecast.projectedMonthlyUsd).toBeGreaterThan(spend30d * 0.95);
    expect(forecast.projectedMonthlyUsd).toBeLessThan(spend30d * 1.05);
  });

  it('is proportional to spending rate', () => {
    const lowSpend = makeRollup('7d', { estCostUsd: 1.0 });
    const highSpend = makeRollup('7d', { estCostUsd: 10.0 });

    mockBuildRollup.mockReturnValueOnce(lowSpend);
    const forecastLow = buildForecast('7d', makeConfig());

    mockBuildRollup.mockReturnValueOnce(highSpend);
    const forecastHigh = buildForecast('7d', makeConfig());

    expect(forecastHigh.projectedMonthlyUsd).toBeGreaterThan(forecastLow.projectedMonthlyUsd);
  });

  it('is finite and non-negative even for large token volumes', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 100_000_000, tokensOut: 50_000_000, estCostUsd: 1500.0 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(isFinite(forecast.projectedMonthlyUsd)).toBe(true);
    expect(forecast.projectedMonthlyUsd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Window-specific behavior
// ---------------------------------------------------------------------------

describe('buildForecast — 7d vs 30d windows', () => {
  it('calls buildRollup with the correct window arg', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d'));
    buildForecast('7d', makeConfig());
    expect(mockBuildRollup).toHaveBeenCalledWith('7d', expect.anything());

    mockBuildRollup.mockReturnValue(makeRollup('30d'));
    buildForecast('30d', makeConfig());
    expect(mockBuildRollup).toHaveBeenCalledWith('30d', expect.anything());
  });

  it('30d window: same daily rate as 7d gives the same monthly projection', () => {
    // $7 / 7d = $1/day; $30 / 30d = $1/day → same monthly projection
    mockBuildRollup.mockReturnValueOnce(makeRollup('7d', { estCostUsd: 7.0 }));
    const f7 = buildForecast('7d', makeConfig());

    mockBuildRollup.mockReturnValueOnce(makeRollup('30d', { estCostUsd: 30.0 }));
    const f30 = buildForecast('30d', makeConfig());

    // Both should project ~$30/month (±10% tolerance for rounding)
    expect(Math.abs(f7.projectedMonthlyUsd - f30.projectedMonthlyUsd)).toBeLessThan(
      Math.max(f7.projectedMonthlyUsd, f30.projectedMonthlyUsd) * 0.10,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('buildForecast — edge cases', () => {
  it('handles zero tokens and zero cost without throwing', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 0, tokensOut: 0, estCostUsd: 0 }));
    expect(() => buildForecast('7d', makeConfig())).not.toThrow();
  });

  it('handles very small spend (sub-cent) without underflowing to negative', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 100, tokensOut: 50, estCostUsd: 0.00001 }));
    const forecast = buildForecast('7d', makeConfig());
    expect(forecast.projectedMonthlyUsd).toBeGreaterThanOrEqual(0);
    expect(forecast.spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('passes the config to buildRollup', () => {
    const cfg = makeConfig({ telemetry: { budgetUsd: 50 } });
    mockBuildRollup.mockReturnValue(makeRollup('7d'));
    buildForecast('7d', cfg);
    expect(mockBuildRollup).toHaveBeenCalledWith('7d', cfg);
  });

  it('does not throw when byModel is empty', () => {
    mockBuildRollup.mockReturnValue(makeRollup('7d', { tokensIn: 1000, tokensOut: 500, estCostUsd: 0.01 }, []));
    expect(() => buildForecast('7d', makeConfig())).not.toThrow();
  });
});
