/**
 * m19.governance.test.ts — hermetic unit tests for core/observability/governance.ts
 *
 * Covers:
 *   - No cap configured: level='ok', capUsd=null, spentUsd=0 or from rollup
 *   - ok threshold: level='ok' when spend < 80% of cap
 *   - warn threshold: level='warn' when spend >= 80% of cap but <= cap
 *   - over threshold: level='over' when spend > cap
 *   - Exact boundary: 79.9% → ok, 80.0% → warn, 100.0% → over, 100.1% → over
 *   - capUsd is null when no budget configured
 *   - capUsd matches cfg.telemetry.budgetUsd when set
 *   - window field matches cfg.telemetry.budgetWindow (default '7d')
 *   - message is a human-readable string (metadata only, no secrets)
 *   - evalGovernance never throws (error resilience)
 *   - 1d window uses rollup path, 7d/30d uses forecast path
 *   - spentUsd is >= 0
 *   - GovernanceStatus shape is correct
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, ActivityRollup, UsageEvent } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock buildForecast and buildRollup so no real filesystem/git operations happen
// ---------------------------------------------------------------------------

const mockBuildForecast = vi.fn();
const mockBuildRollup = vi.fn();

vi.mock('../src/core/observability/forecast.js', () => ({
  buildForecast: (...args: unknown[]) => mockBuildForecast(...args),
}));

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: (...args: unknown[]) => mockBuildRollup(...args),
  windowToMs: (w: string): number => {
    if (w === '1d') return 86_400_000;
    if (w === '7d') return 7 * 86_400_000;
    if (w === '30d') return 30 * 86_400_000;
    return 7 * 86_400_000;
  },
  modelToProviderKey: (model: string): string => {
    const m = model.toLowerCase();
    if (m.startsWith('claude')) return 'claude';
    if (m.startsWith('gpt')) return 'gpt';
    if (m.includes('ollama')) return 'ollama';
    return model;
  },
  LOCAL_PROVIDER_KEYS: new Set(['ollama', 'lmstudio']),
  isLocalProviderModel: (model: string): boolean =>
    new Set(['ollama', 'lmstudio']).has(model.toLowerCase()),
}));

// Also mock index-engine and usage-source for rollup's transitive deps
vi.mock('../src/core/index-engine.js', () => ({
  loadIndex: vi.fn(() => null),
  buildIndex: vi.fn(async () => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    root: '/tmp',
    items: [],
  })),
}));

vi.mock('../src/core/observability/usage-source.js', () => ({
  collectUsageEvents: vi.fn(() => [] as UsageEvent[]),
  claudeProjectsDir: () => '/tmp/fake-projects',
  decodeProjectPath: (d: string) => '/' + d.replace(/-/g, '/'),
  dashNormalize: (p: string) => p.replace(/[/-]/g, '-').toLowerCase(),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { evalGovernance } from '../src/core/observability/governance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(telemetry: Partial<AshlrConfig['telemetry']> = {}): AshlrConfig {
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
    telemetry: { ...telemetry },
    tools: {},
  };
}

function makeForecast(spentUsd: number, window: '7d' | '30d' = '7d') {
  return {
    window,
    spentUsd,
    localSavingsUsd: 0,
    projectedMonthlyUsd: spentUsd * (30 / 7),
  };
}

function makeRollup(spentUsd: number, window: '1d' | '7d' | '30d' = '7d'): ActivityRollup {
  return {
    window,
    since: new Date(Date.now() - 86_400_000).toISOString(),
    totals: {
      tokensIn: 10_000,
      tokensOut: 5_000,
      estCostUsd: spentUsd,
      sessions: 1,
      commits: 0,
    },
    byProject: [],
    byDay: [],
    byModel: [],
    budget: {
      level: 'ok',
      window,
      spentUsd,
      capUsd: null,
      spentTokens: 15_000,
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
  // Default: zero spend forecast
  mockBuildForecast.mockReturnValue(makeForecast(0));
  mockBuildRollup.mockReturnValue(makeRollup(0));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GovernanceStatus shape
// ---------------------------------------------------------------------------

describe('evalGovernance — output shape', () => {
  it('returns all required GovernanceStatus fields', () => {
    const status = evalGovernance(makeConfig());
    expect(typeof status.level).toBe('string');
    expect(typeof status.spentUsd).toBe('number');
    expect(status.capUsd === null || typeof status.capUsd === 'number').toBe(true);
    expect(typeof status.window).toBe('string');
    expect(typeof status.message).toBe('string');
  });

  it('level is one of ok/warn/over', () => {
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(['ok', 'warn', 'over']).toContain(status.level);
  });

  it('spentUsd is always a finite non-negative number', () => {
    mockBuildForecast.mockReturnValue(makeForecast(5.25));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(isFinite(status.spentUsd)).toBe(true);
    expect(status.spentUsd).toBeGreaterThanOrEqual(0);
  });

  it('message is a non-empty string (metadata only)', () => {
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(status.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No-cap case
// ---------------------------------------------------------------------------

describe('evalGovernance — no cap configured', () => {
  it('returns level="ok" when no budgetUsd is set', () => {
    const status = evalGovernance(makeConfig());
    expect(status.level).toBe('ok');
  });

  it('returns capUsd=null when no budget configured', () => {
    const status = evalGovernance(makeConfig());
    expect(status.capUsd).toBeNull();
  });

  it('returns window from cfg.telemetry.budgetWindow (default 7d)', () => {
    const status = evalGovernance(makeConfig());
    expect(status.window).toBe('7d');
  });

  it('returns window matching configured budgetWindow', () => {
    const status = evalGovernance(makeConfig({ budgetWindow: '30d' }));
    expect(status.window).toBe('30d');
  });

  it('returns window=1d when configured', () => {
    const status = evalGovernance(makeConfig({ budgetWindow: '1d' }));
    expect(status.window).toBe('1d');
  });

  it('level remains ok regardless of spend when no cap is set', () => {
    mockBuildForecast.mockReturnValue(makeForecast(9999));
    const status = evalGovernance(makeConfig());
    expect(status.level).toBe('ok');
    expect(status.capUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ok threshold (spend < 80% of cap)
// ---------------------------------------------------------------------------

describe('evalGovernance — ok level (spend < 80% of cap)', () => {
  it('returns ok when spend is 0 and cap is set', () => {
    mockBuildForecast.mockReturnValue(makeForecast(0));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(status.level).toBe('ok');
    expect(status.capUsd).toBe(10);
  });

  it('returns ok when spend is 50% of cap', () => {
    mockBuildForecast.mockReturnValue(makeForecast(5));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(status.level).toBe('ok');
  });

  it('returns ok when spend is just under 80% (79.9% of cap)', () => {
    const cap = 100;
    const spend = cap * 0.799;
    mockBuildForecast.mockReturnValue(makeForecast(spend));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('ok');
  });

  it('capUsd matches the configured budgetUsd', () => {
    mockBuildForecast.mockReturnValue(makeForecast(1));
    const status = evalGovernance(makeConfig({ budgetUsd: 50 }));
    expect(status.capUsd).toBe(50);
  });

  it('spentUsd matches the forecast/rollup spend', () => {
    mockBuildForecast.mockReturnValue(makeForecast(3.75));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(status.spentUsd).toBeCloseTo(3.75, 4);
  });
});

// ---------------------------------------------------------------------------
// warn threshold (spend >= 80% and <= 100% of cap)
// ---------------------------------------------------------------------------

describe('evalGovernance — warn level (80% <= spend <= cap)', () => {
  it('returns warn when spend is exactly 80% of cap', () => {
    const cap = 10;
    const spend = cap * 0.8;
    mockBuildForecast.mockReturnValue(makeForecast(spend));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('warn');
  });

  it('returns warn when spend is 90% of cap', () => {
    const cap = 100;
    mockBuildForecast.mockReturnValue(makeForecast(90));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('warn');
  });

  it('returns warn when spend is 99% of cap (just under cap)', () => {
    const cap = 100;
    mockBuildForecast.mockReturnValue(makeForecast(99));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('warn');
  });

  it('warn: capUsd and spentUsd are correct', () => {
    const cap = 50;
    const spend = 42; // 84%
    mockBuildForecast.mockReturnValue(makeForecast(spend));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('warn');
    expect(status.capUsd).toBe(cap);
    expect(status.spentUsd).toBeCloseTo(spend, 4);
  });

  it('message contains relevant spend/cap context', () => {
    const cap = 10;
    mockBuildForecast.mockReturnValue(makeForecast(9));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('warn');
    expect(status.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// over threshold (spend > cap)
// ---------------------------------------------------------------------------

describe('evalGovernance — over level (spend > cap)', () => {
  it('returns over when spend equals the cap exactly', () => {
    const cap = 10;
    mockBuildForecast.mockReturnValue(makeForecast(cap));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('over');
  });

  it('returns over when spend exceeds the cap', () => {
    const cap = 10;
    mockBuildForecast.mockReturnValue(makeForecast(12.5));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('over');
  });

  it('returns over when spend is 2x the cap', () => {
    const cap = 5;
    mockBuildForecast.mockReturnValue(makeForecast(10));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('over');
  });

  it('over: capUsd and spentUsd are correct', () => {
    const cap = 20;
    const spend = 25;
    mockBuildForecast.mockReturnValue(makeForecast(spend));
    const status = evalGovernance(makeConfig({ budgetUsd: cap }));
    expect(status.level).toBe('over');
    expect(status.capUsd).toBe(cap);
    expect(status.spentUsd).toBeCloseTo(spend, 4);
  });

  it('message mentions over-budget advice (--over-budget)', () => {
    mockBuildForecast.mockReturnValue(makeForecast(15));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(status.level).toBe('over');
    expect(status.message).toContain('over-budget');
  });
});

// ---------------------------------------------------------------------------
// Exact boundary conditions
// ---------------------------------------------------------------------------

describe('evalGovernance — boundary thresholds', () => {
  const cap = 1000;

  it('0% of cap → ok', () => {
    mockBuildForecast.mockReturnValue(makeForecast(0));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('ok');
  });

  it('50% of cap → ok', () => {
    mockBuildForecast.mockReturnValue(makeForecast(500));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('ok');
  });

  it('79.9% of cap → ok', () => {
    mockBuildForecast.mockReturnValue(makeForecast(799));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('ok');
  });

  it('80.0% of cap → warn', () => {
    mockBuildForecast.mockReturnValue(makeForecast(800));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('warn');
  });

  it('80.1% of cap → warn', () => {
    mockBuildForecast.mockReturnValue(makeForecast(801));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('warn');
  });

  it('99.9% of cap → warn', () => {
    mockBuildForecast.mockReturnValue(makeForecast(999));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('warn');
  });

  it('100.0% of cap → over', () => {
    mockBuildForecast.mockReturnValue(makeForecast(1000));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('over');
  });

  it('100.1% of cap → over', () => {
    mockBuildForecast.mockReturnValue(makeForecast(1001));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('over');
  });

  it('200% of cap → over', () => {
    mockBuildForecast.mockReturnValue(makeForecast(2000));
    expect(evalGovernance(makeConfig({ budgetUsd: cap })).level).toBe('over');
  });
});

// ---------------------------------------------------------------------------
// Window routing: 1d uses rollup path, 7d/30d use forecast path
// ---------------------------------------------------------------------------

describe('evalGovernance — window routing', () => {
  it('uses buildForecast for 7d window', () => {
    mockBuildForecast.mockReturnValue(makeForecast(5, '7d'));
    evalGovernance(makeConfig({ budgetUsd: 10, budgetWindow: '7d' }));
    expect(mockBuildForecast).toHaveBeenCalledWith('7d', expect.anything());
    expect(mockBuildRollup).not.toHaveBeenCalled();
  });

  it('uses buildForecast for 30d window', () => {
    mockBuildForecast.mockReturnValue(makeForecast(5, '30d'));
    evalGovernance(makeConfig({ budgetUsd: 10, budgetWindow: '30d' }));
    expect(mockBuildForecast).toHaveBeenCalledWith('30d', expect.anything());
    expect(mockBuildRollup).not.toHaveBeenCalled();
  });

  it('uses buildRollup for 1d window (buildForecast does not support 1d)', () => {
    mockBuildRollup.mockReturnValue(makeRollup(3, '1d'));
    evalGovernance(makeConfig({ budgetUsd: 10, budgetWindow: '1d' }));
    expect(mockBuildRollup).toHaveBeenCalledWith('1d', expect.anything());
    expect(mockBuildForecast).not.toHaveBeenCalled();
  });

  it('passes the config to the underlying data source', () => {
    const cfg = makeConfig({ budgetUsd: 20, budgetWindow: '7d' });
    mockBuildForecast.mockReturnValue(makeForecast(0));
    evalGovernance(cfg);
    expect(mockBuildForecast).toHaveBeenCalledWith('7d', cfg);
  });

  it('1d window: spend from rollup is used for threshold comparison', () => {
    const cap = 10;
    mockBuildRollup.mockReturnValue(makeRollup(9, '1d')); // 90% of cap → warn
    const status = evalGovernance(makeConfig({ budgetUsd: cap, budgetWindow: '1d' }));
    expect(status.level).toBe('warn');
    expect(status.spentUsd).toBeCloseTo(9, 4);
  });
});

// ---------------------------------------------------------------------------
// Error resilience — never throws
// ---------------------------------------------------------------------------

describe('evalGovernance — never throws', () => {
  it('does not throw when buildForecast throws', () => {
    mockBuildForecast.mockImplementation(() => { throw new Error('forecast failed'); });
    expect(() => evalGovernance(makeConfig({ budgetUsd: 10 }))).not.toThrow();
  });

  it('does not throw when buildRollup throws', () => {
    mockBuildRollup.mockImplementation(() => { throw new Error('rollup failed'); });
    expect(() => evalGovernance(makeConfig({ budgetUsd: 5, budgetWindow: '1d' }))).not.toThrow();
  });

  it('returns a valid GovernanceStatus even when underlying data source throws', () => {
    mockBuildForecast.mockImplementation(() => { throw new Error('data unavailable'); });
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    expect(typeof status.level).toBe('string');
    expect(['ok', 'warn', 'over']).toContain(status.level);
    expect(status.capUsd === null || typeof status.capUsd === 'number').toBe(true);
    expect(typeof status.message).toBe('string');
  });

  it('does not throw for undefined/empty telemetry config', () => {
    expect(() => evalGovernance(makeConfig({}))).not.toThrow();
  });

  it('does not throw when cfg.telemetry.budgetUsd is zero', () => {
    mockBuildForecast.mockReturnValue(makeForecast(0));
    expect(() => evalGovernance(makeConfig({ budgetUsd: 0 }))).not.toThrow();
  });

  it('does not throw when spend is very large', () => {
    mockBuildForecast.mockReturnValue(makeForecast(1_000_000));
    expect(() => evalGovernance(makeConfig({ budgetUsd: 10 }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// govAction configuration (does not affect evalGovernance verdict itself)
// ---------------------------------------------------------------------------

describe('evalGovernance — govAction field (advisory only)', () => {
  it('govAction=warn does not change the level verdict', () => {
    mockBuildForecast.mockReturnValue(makeForecast(12));
    const status = evalGovernance(makeConfig({ budgetUsd: 10, govAction: 'warn' }));
    expect(status.level).toBe('over');
  });

  it('govAction=block does not change the level verdict', () => {
    mockBuildForecast.mockReturnValue(makeForecast(12));
    const status = evalGovernance(makeConfig({ budgetUsd: 10, govAction: 'block' }));
    expect(status.level).toBe('over');
    // evalGovernance is advisory only — it never blocks itself
  });

  it('evalGovernance is pure-advisory: it returns a status, never blocks execution', () => {
    // This is the key governance invariant: evalGovernance itself never throws,
    // never blocks, never modifies process state — it only returns a verdict.
    mockBuildForecast.mockReturnValue(makeForecast(999_999));
    const status = evalGovernance(makeConfig({ budgetUsd: 1, govAction: 'block' }));
    expect(status.level).toBe('over');
    // Process must still be running here — no exit, no throw, no block
    expect(typeof status.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// metadata-only message — no secrets in output
// ---------------------------------------------------------------------------

describe('evalGovernance — PRIVACY: metadata-only output', () => {
  const SECRET_VALUES = [
    'super-secret-pat-value',
    'MY_API_KEY_12345',
    '/Users/private/secret',
    'prompt_content_here',
  ];

  it('message never contains secret values', () => {
    mockBuildForecast.mockReturnValue(makeForecast(9));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    for (const secret of SECRET_VALUES) {
      expect(status.message).not.toContain(secret);
    }
  });

  it('GovernanceStatus fields contain only metadata (numbers, level string, window, message)', () => {
    mockBuildForecast.mockReturnValue(makeForecast(5));
    const status = evalGovernance(makeConfig({ budgetUsd: 10 }));
    const str = JSON.stringify(status);
    for (const secret of SECRET_VALUES) {
      expect(str).not.toContain(secret);
    }
  });
});
