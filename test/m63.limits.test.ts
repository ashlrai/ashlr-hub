/**
 * M63: resolveUsageWindows — unit tests.
 *
 * What's under test:
 *   - Never throws under minimal cfg / empty transcript history
 *   - windows is computed from seeded UsageEvents (collectUsageEvents stubbed)
 *   - With no API keys set, providers are kind:'subscription' with an honest
 *     detail string and NO fabricated `limit` field
 *   - Shape is stable: connected, note, windows[], providers[] always present
 *
 * Network is never hit: fetchAnthropicUsage / fetchOpenAIUsage are not
 * exercised when there are no API keys; the subscription path is pure sync.
 * The test that seeds events stubs collectUsageEvents via vi.mock before import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub collectUsageEvents BEFORE importing limits.ts so the module picks it up.
// We mock at the module boundary used by limits.ts.
// ---------------------------------------------------------------------------

const mockCollectUsageEvents = vi.fn<[number], import('../src/core/types.js').UsageEvent[]>();

vi.mock('../src/core/observability/usage-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/observability/usage-source.js')>();
  return {
    ...actual,
    collectUsageEvents: (sinceMs: number) => mockCollectUsageEvents(sinceMs),
  };
});

// Lazy import after mock registration
import { resolveUsageWindows } from '../src/core/observability/limits.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config — resolveUsageWindows only uses cfg shape (currently unused internally). */
function minimalCfg(): AshlrConfig {
  return {} as unknown as AshlrConfig;
}

/** Build a UsageEvent with just the fields limits.ts cares about. */
function makeEvent(opts: {
  model: string;
  tokensIn: number;
  tokensOut: number;
  tsOffset?: number; // ms before now; default 1h
}): import('../src/core/types.js').UsageEvent {
  const offset = opts.tsOffset ?? 60 * 60 * 1_000; // 1 h ago
  return {
    ts: new Date(Date.now() - offset).toISOString(),
    project: null,
    model: opts.model,
    source: 'claude',
    tokensIn: opts.tokensIn,
    tokensOut: opts.tokensOut,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  expect.hasAssertions();
  // Default: empty transcript history
  mockCollectUsageEvents.mockReturnValue([]);
  // Ensure no API keys bleed across tests
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M63 resolveUsageWindows — shape stability', () => {
  it('never throws under minimal cfg and empty history', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    expect(result).toBeDefined();
  });

  it('always returns connected, note, windows, providers', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    expect(typeof result.connected).toBe('boolean');
    expect(typeof result.note).toBe('string');
    expect(result.note.length).toBeGreaterThan(0);
    expect(Array.isArray(result.windows)).toBe(true);
    expect(Array.isArray(result.providers)).toBe(true);
  });

  it('returns empty windows when history is empty', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    expect(result.windows).toHaveLength(0);
  });
});

describe('M63 resolveUsageWindows — rolling-window computation (REAL)', () => {
  it('produces 5h and 24h windows from seeded events', async () => {
    // One event at 1h ago — falls inside BOTH 5h and 24h windows
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 1000, tokensOut: 500, tsOffset: 1 * 60 * 60 * 1_000 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());

    const claudeWindows = result.windows.filter((w) => w.provider === 'claude');
    expect(claudeWindows.length).toBeGreaterThanOrEqual(2); // at least 5h and 24h

    const w5  = claudeWindows.find((w) => w.window === '5h');
    const w24 = claudeWindows.find((w) => w.window === '24h');
    expect(w5).toBeDefined();
    expect(w24).toBeDefined();

    // Event is within 5h so both windows should have the same non-zero tokens
    expect(w5!.tokens).toBe(1500);
    expect(w24!.tokens).toBe(1500);
    expect(w5!.costUsd).toBeGreaterThanOrEqual(0);
    expect(w24!.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('event at 6h ago appears only in 24h window, not 5h', async () => {
    // 6h ago — outside 5h window, inside 24h window
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 2000, tokensOut: 1000, tsOffset: 6 * 60 * 60 * 1_000 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());
    const claudeWindows = result.windows.filter((w) => w.provider === 'claude');

    const w5  = claudeWindows.find((w) => w.window === '5h');
    const w24 = claudeWindows.find((w) => w.window === '24h');

    // 5h window: the 6h-old event is excluded by the timestamp filter in limits.ts.
    // However, collectUsageEvents is called with now-24h, so the mock RETURNS the
    // 6h event; limits.ts then sub-filters for 5h itself.
    expect(w5?.tokens ?? 0).toBe(0);
    expect(w24!.tokens).toBe(3000);
  });

  it('accumulates multiple events for the same provider', async () => {
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 500,  tokensOut: 200, tsOffset: 1 * 60 * 60 * 1_000 }),
      makeEvent({ model: 'claude-3-haiku-20240307',    tokensIn: 300,  tokensOut: 100, tsOffset: 2 * 60 * 60 * 1_000 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());
    const w24claude = result.windows.find((w) => w.provider === 'claude' && w.window === '24h');

    // Both models -> 'claude' provider; tokens should be summed
    expect(w24claude).toBeDefined();
    expect(w24claude!.tokens).toBe(500 + 200 + 300 + 100);
  });

  it('handles multiple providers in parallel', async () => {
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 1000, tokensOut: 500 }),
      makeEvent({ model: 'gpt-4o',                    tokensIn: 800,  tokensOut: 400 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());
    const providers = [...new Set(result.windows.map((w) => w.provider))];
    expect(providers).toContain('claude');
    expect(providers).toContain('gpt');
  });

  it('costUsd is a non-negative finite number', async () => {
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 1000, tokensOut: 500 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());
    for (const w of result.windows) {
      expect(typeof w.costUsd).toBe('number');
      expect(isFinite(w.costUsd)).toBe(true);
      expect(w.costUsd).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('M63 resolveUsageWindows — subscription providers (no API keys)', () => {
  it('providers array contains anthropic when no key is set', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    const anthro = result.providers.find((p) => p.provider === 'anthropic');
    expect(anthro).toBeDefined();
    expect(anthro!.kind).toBe('subscription');
  });

  it('anthropic subscription entry has NO fabricated limit field', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    const anthro = result.providers.find((p) => p.provider === 'anthropic');
    expect(anthro).toBeDefined();
    // limit must be absent — never fabricated
    expect(anthro!.limit).toBeUndefined();
  });

  it('subscription detail is a non-empty honest string', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    const anthro = result.providers.find((p) => p.provider === 'anthropic');
    expect(typeof anthro!.detail).toBe('string');
    expect(anthro!.detail.length).toBeGreaterThan(10);
    // Must not claim a specific number
    expect(anthro!.detail).not.toMatch(/\blimit\s*=\s*\d/i);
  });

  it('connected is false when no API keys are set', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    expect(result.connected).toBe(false);
  });

  it('note string mentions subscription or API key honestly', async () => {
    const result = await resolveUsageWindows(minimalCfg());
    // Should mention subscription plans or similar honest context
    const lower = result.note.toLowerCase();
    expect(lower.includes('subscription') || lower.includes('api') || lower.includes('limit')).toBe(true);
  });
});

describe('M63 resolveUsageWindows — UsageWindow shape', () => {
  it('each window entry has provider, window, tokens, costUsd', async () => {
    mockCollectUsageEvents.mockReturnValue([
      makeEvent({ model: 'claude-3-5-sonnet-20241022', tokensIn: 100, tokensOut: 50 }),
    ]);

    const result = await resolveUsageWindows(minimalCfg());
    for (const w of result.windows) {
      expect(typeof w.provider).toBe('string');
      expect(w.window === '5h' || w.window === '24h').toBe(true);
      expect(typeof w.tokens).toBe('number');
      expect(typeof w.costUsd).toBe('number');
    }
  });
});
