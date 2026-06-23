/**
 * m82.subscription-panel.test.ts — M82: Subscription usage panel.
 *
 * Tests buildSubscriptionUsage() from src/core/web/control.ts:
 *
 *   1. Shape — returns SubscriptionEngineUsage[] with codex + claude entries.
 *   2. Codex real data — primary (5h) + secondary (weekly) windows populated
 *      correctly from seeded readCodexRateLimits mock.
 *   3. Claude best-effort — always hasData:false, windows:[].
 *   4. Never-throws — null/undefined/corrupt mock data all degrade safely.
 *   5. Bar-color thresholds — pure helper: green <=70 / amber <=90 / red >90.
 *   6. minutesToWindowLabel — 300min→'5h', 10080min→'1w', 1440min→'1d'.
 *
 * readCodexRateLimits is vi.mocked so no disk access occurs.
 * buildControlSnapshot is NOT called (avoids daemon/provider side-effects).
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

// Import after mocks are registered
import { buildSubscriptionUsage } from '../src/core/web/control.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCodexLimits(
  primaryPct: number,
  secondaryPct?: number,
  plan = 'pro',
): CodexRateLimits {
  const now = Math.floor(Date.now() / 1000);
  return {
    primary: {
      usedPercent: primaryPct,
      windowMinutes: 300,        // 5h
      resetsAt: now + 3600,
    },
    ...(secondaryPct !== undefined
      ? {
          secondary: {
            usedPercent: secondaryPct,
            windowMinutes: 10080, // 1w
            resetsAt: now + 7 * 24 * 3600,
          },
        }
      : {}),
    planType: plan,
  };
}

// ---------------------------------------------------------------------------
// Pure bar-color helper — mirrors the logic in app.js so thresholds are
// tested independently of the DOM.
// ---------------------------------------------------------------------------
function barColor(pct: number): 'red' | 'amber' | 'green' {
  if (pct > 90) return 'red';
  if (pct > 70) return 'amber';
  return 'green';
}

beforeEach(() => {
  mockRateLimitsReturn = null;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Snapshot shape
// ===========================================================================

describe('buildSubscriptionUsage — shape', () => {
  it('always returns an array', () => {
    const result = buildSubscriptionUsage();
    expect(Array.isArray(result)).toBe(true);
  });

  it('always includes a claude entry', () => {
    const result = buildSubscriptionUsage();
    const claude = result.find((e) => e.engine === 'claude');
    expect(claude).toBeDefined();
  });

  it('claude entry is always hasData:false with empty windows', () => {
    // Even with codex data present, claude has no local signal
    mockRateLimitsReturn = makeCodexLimits(50);
    const result = buildSubscriptionUsage();
    const claude = result.find((e) => e.engine === 'claude');
    expect(claude?.hasData).toBe(false);
    expect(claude?.windows).toEqual([]);
  });
});

// ===========================================================================
// 2. Codex real data
// ===========================================================================

describe('buildSubscriptionUsage — codex with data', () => {
  it('includes codex entry with hasData:true when rate limits available', () => {
    mockRateLimitsReturn = makeCodexLimits(60, 30);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex).toBeDefined();
    expect(codex?.hasData).toBe(true);
  });

  it('primary window label is 5h for 300-minute window', () => {
    mockRateLimitsReturn = makeCodexLimits(60);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[0]?.label).toBe('5h');
  });

  it('secondary window label is 1w for 10080-minute window', () => {
    mockRateLimitsReturn = makeCodexLimits(60, 30);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[1]?.label).toBe('1w');
  });

  it('usedPercent is propagated correctly for both windows', () => {
    mockRateLimitsReturn = makeCodexLimits(75, 42);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[0]?.usedPercent).toBe(75);
    expect(codex?.windows[1]?.usedPercent).toBe(42);
  });

  it('resetsAt is populated from rate limits', () => {
    mockRateLimitsReturn = makeCodexLimits(50);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(typeof codex?.windows[0]?.resetsAt).toBe('number');
    expect(codex!.windows[0]!.resetsAt).toBeGreaterThan(0);
  });

  it('plan is propagated from planType', () => {
    mockRateLimitsReturn = makeCodexLimits(50, undefined, 'max');
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.plan).toBe('max');
  });

  it('codex with only primary (no secondary) returns one window', () => {
    mockRateLimitsReturn = makeCodexLimits(80);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows).toHaveLength(1);
  });
});

// ===========================================================================
// 3. No codex data
// ===========================================================================

describe('buildSubscriptionUsage — no codex data', () => {
  it('no codex entry when readCodexRateLimits returns null', () => {
    mockRateLimitsReturn = null;
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    // codex entry is absent when there is no data
    expect(codex).toBeUndefined();
  });

  it('result is still an array (just claude) when no codex data', () => {
    mockRateLimitsReturn = null;
    const result = buildSubscriptionUsage();
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((e) => typeof e.engine === 'string')).toBe(true);
  });
});

// ===========================================================================
// 4. Never-throws — degrade on corrupt/missing data
// ===========================================================================

describe('buildSubscriptionUsage — never-throws', () => {
  it('returns array even when rate limits has no primary or secondary', () => {
    mockRateLimitsReturn = { planType: 'pro' }; // no primary/secondary
    expect(() => buildSubscriptionUsage()).not.toThrow();
    const result = buildSubscriptionUsage();
    expect(Array.isArray(result)).toBe(true);
  });

  it('codex with no windows is hasData:false', () => {
    mockRateLimitsReturn = { planType: 'pro' }; // no primary/secondary
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    // Either codex is absent or hasData is false when no windows
    if (codex) {
      expect(codex.hasData).toBe(false);
    }
  });

  it('does not throw when mock returns an empty object', () => {
    mockRateLimitsReturn = {} as CodexRateLimits;
    expect(() => buildSubscriptionUsage()).not.toThrow();
  });
});

// ===========================================================================
// 5. Bar-color thresholds (pure helper, no DOM)
// ===========================================================================

describe('barColor thresholds', () => {
  it('green at 0%', () => expect(barColor(0)).toBe('green'));
  it('green at 70%', () => expect(barColor(70)).toBe('green'));
  it('amber at 71%', () => expect(barColor(71)).toBe('amber'));
  it('amber at 90%', () => expect(barColor(90)).toBe('amber'));
  it('red at 91%', () => expect(barColor(91)).toBe('red'));
  it('red at 100%', () => expect(barColor(100)).toBe('red'));
});

// ===========================================================================
// 6. minutesToWindowLabel — verified via the windows shape
// ===========================================================================

describe('window label derivation', () => {
  it('300 minutes → 5h', () => {
    mockRateLimitsReturn = makeCodexLimits(50);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[0]?.label).toBe('5h');
  });

  it('10080 minutes (7d) → 1w', () => {
    mockRateLimitsReturn = makeCodexLimits(50, 20);
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[1]?.label).toBe('1w');
  });

  it('1440 minutes → 1d', () => {
    // Manually set up a 24h primary window
    const now = Math.floor(Date.now() / 1000);
    mockRateLimitsReturn = {
      primary: { usedPercent: 40, windowMinutes: 1440, resetsAt: now + 3600 },
      planType: 'pro',
    };
    const result = buildSubscriptionUsage();
    const codex = result.find((e) => e.engine === 'codex');
    expect(codex?.windows[0]?.label).toBe('1d');
  });
});
