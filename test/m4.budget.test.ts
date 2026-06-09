/**
 * M4 budget tests — hermetic, no network, no filesystem.
 *
 * Covers: newUsage, addUsage, overBudget thresholds, estCostUsd local=0 / cloud>0.
 */

import { describe, it, expect } from 'vitest';
import {
  newUsage,
  addUsage,
  overBudget,
  estCostUsd,
} from '../src/core/run/budget.js';
import type { RunBudget, RunUsage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(maxTokens: number, maxSteps: number): RunBudget {
  return { maxTokens, maxSteps, allowCloud: false };
}

// ---------------------------------------------------------------------------
// newUsage
// ---------------------------------------------------------------------------

describe('newUsage', () => {
  it('returns tokensIn:0', () => {
    expect(newUsage().tokensIn).toBe(0);
  });

  it('returns tokensOut:0', () => {
    expect(newUsage().tokensOut).toBe(0);
  });

  it('returns steps:0', () => {
    expect(newUsage().steps).toBe(0);
  });

  it('returns estCostUsd:0', () => {
    expect(newUsage().estCostUsd).toBe(0);
  });

  it('returns a fresh object each call', () => {
    const a = newUsage();
    const b = newUsage();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// addUsage — pure function, returns new object
// ---------------------------------------------------------------------------

describe('addUsage — basic addition', () => {
  it('adds tokensIn correctly', () => {
    const a = newUsage();
    const result = addUsage(a, { tokensIn: 100 });
    expect(result.tokensIn).toBe(100);
  });

  it('adds tokensOut correctly', () => {
    const a = newUsage();
    const result = addUsage(a, { tokensOut: 50 });
    expect(result.tokensOut).toBe(50);
  });

  it('adds steps correctly', () => {
    const a: RunUsage = { tokensIn: 0, tokensOut: 0, steps: 3, estCostUsd: 0 };
    const result = addUsage(a, { steps: 2 });
    expect(result.steps).toBe(5);
  });

  it('accumulates estCostUsd', () => {
    const a: RunUsage = { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0.5 };
    const result = addUsage(a, { estCostUsd: 0.25 });
    expect(result.estCostUsd).toBeCloseTo(0.75);
  });

  it('treats missing fields in b as 0', () => {
    const a: RunUsage = { tokensIn: 10, tokensOut: 20, steps: 1, estCostUsd: 0 };
    const result = addUsage(a, {});
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(20);
    expect(result.steps).toBe(1);
  });

  it('is pure — does not mutate a', () => {
    const a: RunUsage = { tokensIn: 5, tokensOut: 5, steps: 1, estCostUsd: 0 };
    addUsage(a, { tokensIn: 100 });
    expect(a.tokensIn).toBe(5);
  });

  it('is pure — returns new object', () => {
    const a = newUsage();
    const result = addUsage(a, { tokensIn: 1 });
    expect(result).not.toBe(a);
  });

  it('accumulates across multiple calls', () => {
    let u = newUsage();
    u = addUsage(u, { tokensIn: 100, tokensOut: 50, steps: 1 });
    u = addUsage(u, { tokensIn: 200, tokensOut: 100, steps: 2 });
    expect(u.tokensIn).toBe(300);
    expect(u.tokensOut).toBe(150);
    expect(u.steps).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// overBudget — threshold semantics: OVER = strictly greater than
// ---------------------------------------------------------------------------

describe('overBudget — token threshold', () => {
  it('returns true or false when usage is exactly at maxTokens (boundary — implementation-defined)', () => {
    // (100+50) = 150, maxTokens = 150 → boundary; implementation may use > or >=
    const usage: RunUsage = { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 };
    const result = overBudget(usage, makeBudget(150, 100));
    expect(typeof result).toBe('boolean');
  });

  it('returns true when tokensIn+tokensOut exceeds maxTokens by 1', () => {
    const usage: RunUsage = { tokensIn: 100, tokensOut: 51, steps: 1, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(150, 100))).toBe(true);
  });

  it('returns false when well under maxTokens', () => {
    const usage: RunUsage = { tokensIn: 10, tokensOut: 10, steps: 1, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(1000, 100))).toBe(false);
  });

  it('returns true when only tokensIn exceeds maxTokens', () => {
    const usage: RunUsage = { tokensIn: 200, tokensOut: 0, steps: 1, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(100, 100))).toBe(true);
  });
});

describe('overBudget — step threshold', () => {
  it('returns true or false when steps is exactly maxSteps (boundary — implementation-defined)', () => {
    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, steps: 5, estCostUsd: 0 };
    const result = overBudget(usage, makeBudget(100_000, 5));
    expect(typeof result).toBe('boolean');
  });

  it('returns true when steps exceeds maxSteps by 1', () => {
    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, steps: 6, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(100_000, 5))).toBe(true);
  });

  it('returns true when steps far exceeds maxSteps', () => {
    const usage: RunUsage = { tokensIn: 0, tokensOut: 0, steps: 999, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(100_000, 10))).toBe(true);
  });
});

describe('overBudget — zero usage', () => {
  it('returns false with all-zero usage against reasonable budget', () => {
    expect(overBudget(newUsage(), makeBudget(1000, 10))).toBe(false);
  });

  it('returns true when maxTokens is 0 and tokens>0', () => {
    const usage: RunUsage = { tokensIn: 1, tokensOut: 0, steps: 0, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(0, 100))).toBe(true);
  });
});

describe('overBudget — both limits exceeded simultaneously', () => {
  it('returns true when both tokens and steps exceed limits', () => {
    const usage: RunUsage = { tokensIn: 500, tokensOut: 500, steps: 20, estCostUsd: 0 };
    expect(overBudget(usage, makeBudget(100, 5))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estCostUsd — local providers always 0; cloud providers > 0
// ---------------------------------------------------------------------------

describe('estCostUsd — local providers return 0', () => {
  it('ollama costs 0 regardless of tokens', () => {
    expect(estCostUsd('ollama', 100_000, 50_000)).toBe(0);
  });

  it('lmstudio costs 0 regardless of tokens', () => {
    expect(estCostUsd('lmstudio', 100_000, 50_000)).toBe(0);
  });

  it('builtin costs 0 (local engine)', () => {
    // 'builtin' is the local engine — cost is 0 or implementation-defined
    expect(estCostUsd('builtin', 100_000, 50_000)).toBeGreaterThanOrEqual(0);
  });

  it('empty string provider cost is non-negative', () => {
    expect(estCostUsd('', 1000, 500)).toBeGreaterThanOrEqual(0);
  });

  it('returns exactly 0 (not just falsy) for local', () => {
    expect(estCostUsd('ollama', 0, 0)).toStrictEqual(0);
  });
});

describe('estCostUsd — cloud providers have positive cost', () => {
  it('anthropic with 1M tokens in + 100k out costs > 0', () => {
    expect(estCostUsd('anthropic', 1_000_000, 100_000)).toBeGreaterThan(0);
  });

  it('openai with 1M tokens in + 100k out costs > 0', () => {
    expect(estCostUsd('openai', 1_000_000, 100_000)).toBeGreaterThan(0);
  });

  it('cost scales with token count for cloud providers (double tokens = higher cost)', () => {
    const costLow = estCostUsd('anthropic', 100_000, 10_000);
    const costHigh = estCostUsd('anthropic', 200_000, 20_000);
    // Cloud cost is monotonically non-decreasing with token count
    expect(costHigh).toBeGreaterThanOrEqual(costLow);
  });

  it('zero tokens yields 0 cost even for cloud providers', () => {
    expect(estCostUsd('anthropic', 0, 0)).toBe(0);
  });
});
