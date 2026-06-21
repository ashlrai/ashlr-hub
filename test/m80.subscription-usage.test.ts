/**
 * m80.subscription-usage.test.ts — M80: subscription-usage-aware throttling.
 *
 * Tests the pure helpers in src/core/fleet/subscription-usage.ts:
 *
 *   subscriptionUsage(engine)    — codex: reads readCodexRateLimits (mocked);
 *                                   claude: always null (no local signal)
 *   subscriptionAllows(engine)   — false only when KNOWN usage >= maxPercent;
 *                                   true for unknown/under-cap/non-subscription
 *   isSubscriptionEngine(engine) — true for claude/codex (frontier tier), false
 *                                   for builtin/ollama/etc
 *
 * readCodexRateLimits is vi.mocked so no disk access happens.
 * engineTierOf relies on the built-in registry (no disk access either).
 *
 * All helpers are pure and never-throws: the last block exercises the
 * never-throws guarantee with null / undefined / corrupt inputs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodexRateLimits } from '../src/core/observability/codex-source.js';

// ---------------------------------------------------------------------------
// Mock readCodexRateLimits before importing the module under test
// ---------------------------------------------------------------------------

let mockRateLimitsReturn: CodexRateLimits | null = null;

vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => mockRateLimitsReturn,
  CODEX_PROVIDER_KEY: 'codex',
  collectCodexEvents: () => [],
}));

// Import after mock is registered
import {
  subscriptionUsage,
  subscriptionAllows,
  isSubscriptionEngine,
} from '../src/core/fleet/subscription-usage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRateLimits(
  primaryPct: number,
  secondaryPct?: number,
): CodexRateLimits {
  const baseResetsAt = Math.floor(Date.now() / 1000) + 3600; // 1h from now
  return {
    primary: {
      usedPercent: primaryPct,
      windowMinutes: 300, // 5h window
      resetsAt: baseResetsAt,
    },
    ...(secondaryPct !== undefined
      ? {
          secondary: {
            usedPercent: secondaryPct,
            windowMinutes: 10080, // 7d window
            resetsAt: baseResetsAt + 7 * 24 * 3600,
          },
        }
      : {}),
    planType: 'pro',
  };
}

beforeEach(() => {
  mockRateLimitsReturn = null;
  vi.clearAllMocks();
});

// ===========================================================================
// isSubscriptionEngine
// ===========================================================================

describe('isSubscriptionEngine', () => {
  it('returns true for claude (frontier tier)', () => {
    expect(isSubscriptionEngine('claude')).toBe(true);
  });

  it('returns true for codex (frontier tier)', () => {
    expect(isSubscriptionEngine('codex')).toBe(true);
  });

  it('returns false for builtin', () => {
    expect(isSubscriptionEngine('builtin')).toBe(false);
  });

  it('returns false for an unknown/local engine', () => {
    expect(isSubscriptionEngine('ollama' as 'builtin')).toBe(false);
    expect(isSubscriptionEngine('ashlrcode' as 'builtin')).toBe(false);
  });
});

// ===========================================================================
// subscriptionUsage
// ===========================================================================

describe('subscriptionUsage — codex', () => {
  it('returns null when readCodexRateLimits returns null', () => {
    mockRateLimitsReturn = null;
    expect(subscriptionUsage('codex')).toBeNull();
  });

  it('returns usage from primary window when only primary is present', () => {
    mockRateLimitsReturn = makeRateLimits(40);
    const usage = subscriptionUsage('codex');
    expect(usage).not.toBeNull();
    expect(usage?.usedPercent).toBe(40);
    expect(usage?.windowLabel).toBe('5h'); // 300 min → '5h'
    expect(typeof usage?.resetsAt).toBe('number');
  });

  it('returns the HIGHER of primary/secondary when secondary is larger', () => {
    // primary=40%, secondary=70% → should return secondary (70%)
    mockRateLimitsReturn = makeRateLimits(40, 70);
    const usage = subscriptionUsage('codex');
    expect(usage?.usedPercent).toBe(70);
    expect(usage?.windowLabel).toBe('1w'); // 10080 min = 7d = 1 week → '1w'
  });

  it('returns primary when primary is the higher', () => {
    // primary=80%, secondary=30% → should return primary (80%)
    mockRateLimitsReturn = makeRateLimits(80, 30);
    const usage = subscriptionUsage('codex');
    expect(usage?.usedPercent).toBe(80);
    expect(usage?.windowLabel).toBe('5h');
  });

  it('returns null when limits has no primary or secondary', () => {
    mockRateLimitsReturn = { planType: 'pro' }; // no primary/secondary
    expect(subscriptionUsage('codex')).toBeNull();
  });
});

describe('subscriptionUsage — claude', () => {
  it('returns null for claude (no local signal — never block proactively)', () => {
    // Even with codex limits set, claude has no local signal
    mockRateLimitsReturn = makeRateLimits(99);
    expect(subscriptionUsage('claude')).toBeNull();
  });
});

describe('subscriptionUsage — non-subscription engines', () => {
  it('returns null for builtin', () => {
    expect(subscriptionUsage('builtin')).toBeNull();
  });
});

// ===========================================================================
// subscriptionAllows
// ===========================================================================

describe('subscriptionAllows — codex at 95% (over default 90%)', () => {
  it('returns allowed:false when codex primary window is >= 90%', () => {
    mockRateLimitsReturn = makeRateLimits(95);
    const result = subscriptionAllows('codex');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('95%');
    expect(result.reason).toContain('codex');
  });

  it('returns allowed:false even if opts.maxPercent is provided and exceeded', () => {
    mockRateLimitsReturn = makeRateLimits(85);
    // Custom lower cap: 80%
    const result = subscriptionAllows('codex', { maxPercent: 80 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('85%');
  });

  it('includes the window label and cap in the reason string', () => {
    mockRateLimitsReturn = makeRateLimits(95);
    const result = subscriptionAllows('codex');
    expect(result.reason).toContain('5h');
    expect(result.reason).toContain('90%');
  });
});

describe('subscriptionAllows — codex at 40% (under 90%)', () => {
  it('returns allowed:true when usage is under the cap', () => {
    mockRateLimitsReturn = makeRateLimits(40);
    const result = subscriptionAllows('codex');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('40%');
  });

  it('returns allowed:true with a custom cap when under it', () => {
    mockRateLimitsReturn = makeRateLimits(40);
    const result = subscriptionAllows('codex', { maxPercent: 50 });
    expect(result.allowed).toBe(true);
  });
});

describe('subscriptionAllows — boundary: exactly at maxPercent', () => {
  it('returns allowed:false when usage equals maxPercent (inclusive threshold)', () => {
    mockRateLimitsReturn = makeRateLimits(90);
    const result = subscriptionAllows('codex', { maxPercent: 90 });
    expect(result.allowed).toBe(false);
  });

  it('returns allowed:true when usage is one below maxPercent', () => {
    mockRateLimitsReturn = makeRateLimits(89);
    const result = subscriptionAllows('codex', { maxPercent: 90 });
    expect(result.allowed).toBe(true);
  });
});

describe('subscriptionAllows — codex with null rate limits (unknown)', () => {
  it('returns allowed:true when readCodexRateLimits returns null', () => {
    mockRateLimitsReturn = null;
    const result = subscriptionAllows('codex');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('unknown');
  });
});

describe('subscriptionAllows — claude (no local signal)', () => {
  it('returns allowed:true for claude regardless of codex limits', () => {
    // Claude has no local utilization signal — never block it proactively
    mockRateLimitsReturn = makeRateLimits(99);
    const result = subscriptionAllows('claude');
    expect(result.allowed).toBe(true);
  });

  it('reason mentions unknown / no local signal', () => {
    const result = subscriptionAllows('claude');
    expect(result.reason).toContain('unknown');
  });
});

describe('subscriptionAllows — non-subscription engines', () => {
  it('returns allowed:true for builtin (not a subscription engine)', () => {
    const result = subscriptionAllows('builtin');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('not a subscription engine');
  });
});

// ===========================================================================
// Never-throws — exercise with corrupt/missing data
// ===========================================================================

describe('never-throws guarantee', () => {
  it('subscriptionUsage does not throw when readCodexRateLimits returns garbage', () => {
    // Force readCodexRateLimits to return something malformed via the mock
    mockRateLimitsReturn = {
      primary: undefined,
      secondary: undefined,
    } as unknown as CodexRateLimits;
    expect(() => subscriptionUsage('codex')).not.toThrow();
  });

  it('subscriptionAllows does not throw on any input combination', () => {
    mockRateLimitsReturn = null;
    expect(() => subscriptionAllows('claude')).not.toThrow();
    expect(() => subscriptionAllows('codex')).not.toThrow();
    expect(() => subscriptionAllows('builtin')).not.toThrow();
    // Nonsense engine id
    expect(() => subscriptionAllows('nonexistent' as 'builtin')).not.toThrow();
  });

  it('isSubscriptionEngine does not throw on nonsense input', () => {
    expect(() => isSubscriptionEngine(undefined as unknown as 'builtin')).not.toThrow();
    expect(() => isSubscriptionEngine('' as 'builtin')).not.toThrow();
  });
});
