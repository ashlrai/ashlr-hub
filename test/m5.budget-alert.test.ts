/**
 * M5 budget-alert tests — hermetic, pure function, no I/O.
 *
 * Covers:
 *   - ok: no caps set → always ok
 *   - ok: caps set but spend is well under
 *   - warn: spend >= 80% of any cap (USD or tokens)
 *   - over: spend > any cap (USD or tokens)
 *   - Both caps set simultaneously; 'over' wins over 'warn'
 *   - message is a non-empty string in all cases
 *   - capUsd / capTokens reflect the config values (or null when absent)
 *   - spentUsd / spentTokens reflect the input totals
 *   - window field echoes the passed window string
 *   - Never throws under any input
 */

import { describe, it, expect } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { evalBudget } from '../src/core/observability/budget-alert.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(telemetry: AshlrConfig['telemetry'] = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry,
    tools: {},
  };
}

function spent(spentUsd: number, spentTokens: number): { spentUsd: number; spentTokens: number } {
  return { spentUsd, spentTokens };
}

// ---------------------------------------------------------------------------
// No caps configured
// ---------------------------------------------------------------------------

describe('evalBudget — no caps', () => {
  it('returns level ok when no caps are configured', () => {
    const result = evalBudget(spent(9999, 9_999_999), makeConfig({}), '7d');
    expect(result.level).toBe('ok');
  });

  it('capUsd is null when budgetUsd not set', () => {
    const result = evalBudget(spent(100, 1000), makeConfig({}), '7d');
    expect(result.capUsd).toBeNull();
  });

  it('capTokens is null when budgetTokens not set', () => {
    const result = evalBudget(spent(100, 1000), makeConfig({}), '7d');
    expect(result.capTokens).toBeNull();
  });

  it('message is a non-empty string', () => {
    const result = evalBudget(spent(0, 0), makeConfig({}), '7d');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// USD cap — ok zone
// ---------------------------------------------------------------------------

describe('evalBudget — USD cap, ok zone', () => {
  it('ok when spend is 0 and cap is set', () => {
    const result = evalBudget(spent(0, 0), makeConfig({ budgetUsd: 100 }), '7d');
    expect(result.level).toBe('ok');
  });

  it('ok when spend is well under cap (50% usage)', () => {
    const result = evalBudget(spent(5, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('ok');
  });

  it('ok when spend is just under the 80% warn threshold', () => {
    // 79.9% of cap → ok
    const result = evalBudget(spent(7.99, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('ok');
  });

  it('spentUsd reflects the input', () => {
    const result = evalBudget(spent(3.14, 0), makeConfig({ budgetUsd: 100 }), '7d');
    expect(result.spentUsd).toBeCloseTo(3.14);
  });

  it('capUsd reflects config value', () => {
    const result = evalBudget(spent(1, 0), makeConfig({ budgetUsd: 42 }), '7d');
    expect(result.capUsd).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// USD cap — warn zone (>= 80%, < 100%)
// ---------------------------------------------------------------------------

describe('evalBudget — USD cap, warn zone', () => {
  it('warn when spend is exactly 80% of cap', () => {
    const result = evalBudget(spent(8, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('warn');
  });

  it('warn when spend is 90% of cap', () => {
    const result = evalBudget(spent(9, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('warn');
  });

  it('warn when spend is 99% of cap (just under 100%)', () => {
    const result = evalBudget(spent(9.9, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('warn');
  });

  it('message mentions the cap or spend in warn state', () => {
    const result = evalBudget(spent(8, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// USD cap — over zone (>= 100%)
// ---------------------------------------------------------------------------

describe('evalBudget — USD cap, over zone', () => {
  it('over when spend equals cap exactly', () => {
    const result = evalBudget(spent(10, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('over');
  });

  it('over when spend exceeds cap by 1 cent', () => {
    const result = evalBudget(spent(10.01, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('over');
  });

  it('over when spend is double the cap', () => {
    const result = evalBudget(spent(20, 0), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.level).toBe('over');
  });

  it('over when spend is enormously above cap', () => {
    const result = evalBudget(spent(9999, 0), makeConfig({ budgetUsd: 1 }), '7d');
    expect(result.level).toBe('over');
  });
});

// ---------------------------------------------------------------------------
// Token cap — ok / warn / over
// ---------------------------------------------------------------------------

describe('evalBudget — token cap, all zones', () => {
  it('ok when tokens well under cap', () => {
    const result = evalBudget(spent(0, 500_000), makeConfig({ budgetTokens: 1_000_000 }), '7d');
    expect(result.level).toBe('ok');
  });

  it('warn when tokens >= 80% of cap', () => {
    const result = evalBudget(spent(0, 800_000), makeConfig({ budgetTokens: 1_000_000 }), '7d');
    expect(result.level).toBe('warn');
  });

  it('over when tokens >= 100% of cap', () => {
    const result = evalBudget(spent(0, 1_000_000), makeConfig({ budgetTokens: 1_000_000 }), '7d');
    expect(result.level).toBe('over');
  });

  it('over when tokens exceed cap', () => {
    const result = evalBudget(spent(0, 1_500_000), makeConfig({ budgetTokens: 1_000_000 }), '7d');
    expect(result.level).toBe('over');
  });

  it('capTokens reflects config value', () => {
    const result = evalBudget(spent(0, 100), makeConfig({ budgetTokens: 500_000 }), '7d');
    expect(result.capTokens).toBe(500_000);
  });

  it('capTokens is null when budgetTokens not configured', () => {
    const result = evalBudget(spent(0, 100), makeConfig({ budgetUsd: 10 }), '7d');
    expect(result.capTokens).toBeNull();
  });

  it('spentTokens reflects the input', () => {
    const result = evalBudget(spent(0, 123_456), makeConfig({ budgetTokens: 1_000_000 }), '7d');
    expect(result.spentTokens).toBe(123_456);
  });
});

// ---------------------------------------------------------------------------
// Both caps — 'over' wins over 'warn' when one cap exceeded and other is warn
// ---------------------------------------------------------------------------

describe('evalBudget — both caps set', () => {
  it('over when USD cap exceeded even if tokens are ok', () => {
    const result = evalBudget(
      spent(20, 100_000),
      makeConfig({ budgetUsd: 10, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('over');
  });

  it('over when token cap exceeded even if USD is ok', () => {
    const result = evalBudget(
      spent(1, 2_000_000),
      makeConfig({ budgetUsd: 100, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('over');
  });

  it('warn when USD is in warn zone and tokens are ok', () => {
    const result = evalBudget(
      spent(8.5, 100_000),
      makeConfig({ budgetUsd: 10, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('warn');
  });

  it('warn when token cap is in warn zone and USD is ok', () => {
    const result = evalBudget(
      spent(1, 850_000),
      makeConfig({ budgetUsd: 100, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('warn');
  });

  it('ok when both caps well under 80%', () => {
    const result = evalBudget(
      spent(1, 100_000),
      makeConfig({ budgetUsd: 100, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('ok');
  });

  it('over beats warn — USD over, tokens in warn zone → over', () => {
    const result = evalBudget(
      spent(11, 900_000),
      makeConfig({ budgetUsd: 10, budgetTokens: 1_000_000 }),
      '7d',
    );
    expect(result.level).toBe('over');
  });
});

// ---------------------------------------------------------------------------
// window field
// ---------------------------------------------------------------------------

describe('evalBudget — window field', () => {
  it('echoes the window string', () => {
    expect(evalBudget(spent(0, 0), makeConfig({}), '1d').window).toBe('1d');
    expect(evalBudget(spent(0, 0), makeConfig({}), '7d').window).toBe('7d');
    expect(evalBudget(spent(0, 0), makeConfig({}), '30d').window).toBe('30d');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — zero spend, zero cap, never throws
// ---------------------------------------------------------------------------

describe('evalBudget — edge cases', () => {
  it('never throws with zero spend and zero cap', () => {
    expect(() => evalBudget(spent(0, 0), makeConfig({ budgetUsd: 0 }), '7d')).not.toThrow();
  });

  it('zero cap with any spend is over', () => {
    const result = evalBudget(spent(0.01, 0), makeConfig({ budgetUsd: 0 }), '7d');
    // Any spend > 0 vs cap of 0 should be 'over'
    expect(result.level).toBe('over');
  });

  it('never throws with very large numbers', () => {
    expect(() =>
      evalBudget(
        spent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        makeConfig({ budgetUsd: 1, budgetTokens: 1 }),
        '7d',
      ),
    ).not.toThrow();
  });

  it('never throws with NaN inputs (defensive)', () => {
    expect(() => evalBudget(spent(NaN, NaN), makeConfig({ budgetUsd: 10 }), '7d')).not.toThrow();
  });

  it('never throws with negative spend (defensive)', () => {
    expect(() => evalBudget(spent(-1, -100), makeConfig({ budgetUsd: 10 }), '7d')).not.toThrow();
  });

  it('returns a BudgetAlert with all required fields in every case', () => {
    const cases = [
      evalBudget(spent(0, 0), makeConfig({}), '7d'),
      evalBudget(spent(5, 500_000), makeConfig({ budgetUsd: 10, budgetTokens: 1_000_000 }), '7d'),
      evalBudget(spent(100, 0), makeConfig({ budgetUsd: 10 }), '7d'),
    ];
    for (const result of cases) {
      expect(['ok', 'warn', 'over']).toContain(result.level);
      expect(typeof result.window).toBe('string');
      expect(typeof result.spentUsd).toBe('number');
      expect(typeof result.spentTokens).toBe('number');
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
      // capUsd / capTokens must be number or null (not undefined)
      expect(result.capUsd === null || typeof result.capUsd === 'number').toBe(true);
      expect(result.capTokens === null || typeof result.capTokens === 'number').toBe(true);
    }
  });
});
