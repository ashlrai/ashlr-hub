/**
 * context-math is the ONE place every Verse threshold is computed; these pin
 * the formulas to the figures read out of the real CLIs (docs/VERSE-CONTEXT.md).
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  cacheHitRatio,
  canonicalModelId,
  CLAUDE_STANDARD_AUTOCOMPACT_WINDOW,
  claudeAutoCompactAt,
  claudeAutocompactFlag,
  codexAutoCompactAt,
  codexEffectiveWindow,
  expansiveAdvice,
  fitVerdict,
  grokAutoCompactAt,
  handoffAdvice,
  hasExpansiveMode,
  LOCAL_MIN_USABLE_WINDOW,
  localWindowUsable,
  occupancy,
  reconcileAutoCompactAt,
  sessionOverheadTokens,
  CACHE_IDLE_TTL_MS,
} from '../src/core/verse/context-math.js';
import type { VerseModelOption, VerseUsage } from '../src/core/verse/types.js';

const CLAUDE_1M: VerseModelOption = {
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  contextWindow: 1_000_000,
  autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, CLAUDE_STANDARD_AUTOCOMPACT_WINDOW),
  expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000) },
  maxOutputTokens: 128_000,
};
const HAIKU: VerseModelOption = {
  id: 'claude-haiku-4-5-20251001',
  label: 'Claude Haiku 4.5',
  contextWindow: 200_000,
  autoCompactAt: claudeAutoCompactAt(200_000, 32_000),
  maxOutputTokens: 32_000,
};
const GPT6: VerseModelOption = {
  id: 'gpt-6-sol',
  label: 'GPT-6 Sol',
  contextWindow: codexEffectiveWindow(272_000, 95),
  autoCompactAt: codexAutoCompactAt(272_000),
  expansive: { contextWindow: codexEffectiveWindow(872_000, 95), autoCompactAt: codexAutoCompactAt(872_000), providerWindow: 872_000 },
};

function usage(partial: Partial<VerseUsage>): VerseUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    contextWindow: null,
    ...partial,
  };
}

describe('per-engine formulas match the CLIs', () => {
  it('claude: 967k at auto on a 1M model, 367k at the standard 400k window, 167k on 200k models', () => {
    expect(claudeAutoCompactAt(1_000_000, 128_000)).toBe(967_000);
    expect(claudeAutoCompactAt(1_000_000, 64_000, 400_000)).toBe(367_000);
    expect(claudeAutoCompactAt(200_000, 32_000)).toBe(167_000);
    // reserve is min(maxOut, 20k): a small max output reserves less
    expect(claudeAutoCompactAt(200_000, 8_192)).toBe(200_000 - 8_192 - 13_000);
    // local 64k tag, unknown max output → 20k reserve
    expect(claudeAutoCompactAt(65_536, null)).toBe(32_536);
    // --autocompact above the model window is clamped to the window
    expect(claudeAutoCompactAt(200_000, null, 400_000)).toBe(167_000);
    expect(claudeAutoCompactAt(20_000, null)).toBe(0);
  });

  it('codex: 258,400 effective / 244,800 compaction on 272k; 828,400 / 784,800 on 872k', () => {
    expect(codexEffectiveWindow(272_000)).toBe(258_400);
    expect(codexEffectiveWindow(272_000, 95)).toBe(258_400);
    expect(codexEffectiveWindow(272_000, 0)).toBe(258_400); // invalid percent → default
    expect(codexAutoCompactAt(272_000)).toBe(244_800);
    expect(codexEffectiveWindow(872_000)).toBe(828_400);
    expect(codexAutoCompactAt(872_000)).toBe(784_800);
  });

  it('grok: 400k at the catalog 80%', () => {
    expect(grokAutoCompactAt(500_000)).toBe(400_000);
    expect(grokAutoCompactAt(500_000, 85)).toBe(425_000);
    expect(grokAutoCompactAt(500_000, 150)).toBe(400_000);
  });
});

describe('model ids', () => {
  it('rewrites the dotted Opus 5.5 id the CLI resolves to Opus 5', () => {
    expect(canonicalModelId('claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(canonicalModelId('claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('budgets and modes', () => {
  it('reads standard and expansive budgets, never inventing one', () => {
    expect(budgetFor(CLAUDE_1M, 'standard')).toEqual({ contextWindow: 1_000_000, autoCompactAt: 367_000 });
    expect(budgetFor(CLAUDE_1M, 'expansive')?.autoCompactAt).toBe(967_000);
    expect(budgetFor(HAIKU, 'expansive')).toBeNull();
    expect(budgetFor({ id: 'x', label: 'x', contextWindow: null }, 'standard')).toBeNull();
    expect(budgetFor(null, 'standard')).toBeNull();
    expect(hasExpansiveMode(CLAUDE_1M)).toBe(true);
    expect(hasExpansiveMode(GPT6)).toBe(true);
    expect(hasExpansiveMode(HAIKU)).toBe(false);
  });

  it('passes --autocompact 400000 only to 1M models in standard mode', () => {
    expect(claudeAutocompactFlag(CLAUDE_1M, 'standard')).toBe(400_000);
    expect(claudeAutocompactFlag(CLAUDE_1M, 'expansive')).toBeNull();
    expect(claudeAutocompactFlag(HAIKU, 'standard')).toBeNull();
  });

  it('reconciles the compaction point when the CLI reports a different window', () => {
    const standard = budgetFor(CLAUDE_1M, 'standard');
    // same window → budget unchanged
    expect(reconcileAutoCompactAt({ engine: 'claude', runtimeWindow: 1_000_000, budget: standard, autocompactWindow: 400_000 })).toBe(367_000);
    // long-context credit clamp to 200k → 167k
    expect(reconcileAutoCompactAt({ engine: 'claude', runtimeWindow: 200_000, budget: standard, autocompactWindow: 400_000, maxOutputTokens: 128_000 })).toBe(167_000);
    // codex reports the EFFECTIVE window
    expect(reconcileAutoCompactAt({ engine: 'codex', runtimeWindow: 828_400, budget: budgetFor(GPT6, 'standard') })).toBe(784_800);
    // grok keeps the ratio
    expect(reconcileAutoCompactAt({ engine: 'grok', runtimeWindow: 1_000_000, budget: { contextWindow: 500_000, autoCompactAt: 400_000 } })).toBe(800_000);
  });
});

describe('occupancy', () => {
  it('tones relative to the compaction point, before the CLI compacts', () => {
    expect(occupancy(usage({ contextTokens: 100_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })).tone).toBe('ok');
    expect(occupancy(usage({ contextTokens: 300_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })).tone).toBe('warn');
    expect(occupancy(usage({ contextTokens: 360_000, contextWindow: 1_000_000, autoCompactAt: 367_000 })).tone).toBe('danger');
    expect(occupancy(usage({ contextTokens: 1_100_000, contextWindow: 1_000_000, autoCompactAt: 967_000 })).tone).toBe('over');
    expect(occupancy(usage({ contextTokens: 5 })).tone).toBe('unknown');
    const occ = occupancy(usage({ contextTokens: 300_000, contextWindow: 1_000_000, autoCompactAt: 367_000 }));
    expect(occ.untilCompaction).toBe(67_000);
    expect(occ.ofWindow).toBeCloseTo(0.3);
  });

  it('never claims "over" from an upper bound (codex turn totals)', () => {
    const bound = occupancy(usage({ contextTokens: 697_060, contextWindow: 258_400, autoCompactAt: 244_800, contextTokensExact: false }));
    expect(bound.tone).toBe('unknown');
    expect(bound.exact).toBe(false);
    // an upper bound below the compaction point still tones (the truth is at most this)
    expect(occupancy(usage({ contextTokens: 50_000, contextWindow: 258_400, autoCompactAt: 244_800, contextTokensExact: false })).tone).toBe('ok');
  });
});

describe('efficiency', () => {
  it('cache-hit ratio over disjoint buckets; null before any read', () => {
    expect(cacheHitRatio({ inputTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 10 })).toBeCloseTo(0.8);
    expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });
});

describe('fit verdicts use per-engine overhead', () => {
  it('local 64k: a small handoff fits, a repo does not', () => {
    const local: VerseModelOption = { id: 'qwen', label: 'q', contextWindow: 65_536, autoCompactAt: 32_536 };
    expect(fitVerdict(3_000, local, sessionOverheadTokens('local'))).toBe('fits');
    expect(fitVerdict(15_000, local, sessionOverheadTokens('local'))).toBe('tight');
    expect(fitVerdict(500_000, local, sessionOverheadTokens('local'))).toBe('split');
  });

  it('claude 1M: expansive only when standard cannot hold it', () => {
    expect(fitVerdict(100_000, CLAUDE_1M, sessionOverheadTokens('claude'))).toBe('fits');
    expect(fitVerdict(300_000, CLAUDE_1M, sessionOverheadTokens('claude'))).toBe('tight');
    expect(fitVerdict(600_000, CLAUDE_1M, sessionOverheadTokens('claude'))).toBe('expansive');
    expect(fitVerdict(2_000_000, CLAUDE_1M, sessionOverheadTokens('claude'))).toBe('split');
    expect(fitVerdict(10, { id: 'x', label: 'x', contextWindow: null })).toBeNull();
  });

  it('small local windows are not offered as usable', () => {
    expect(LOCAL_MIN_USABLE_WINDOW).toBe(56_000);
    expect(localWindowUsable(65_536)).toBe(true);
    expect(localWindowUsable(32_768)).toBe(false);
    expect(localWindowUsable(null)).toBe(false);
  });
});

describe('advice is evidence-based and never spends', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');

  it('suggests a handoff near compaction, after repeated compactions, and after an idle cache expiry', () => {
    expect(handoffAdvice({ usage: usage({ contextTokens: 100_000, contextWindow: 1_000_000, autoCompactAt: 367_000 }), now }).level).toBe('none');
    expect(handoffAdvice({ usage: usage({ contextTokens: 330_000, contextWindow: 1_000_000, autoCompactAt: 367_000 }), now }).level).toBe('suggest');
    expect(handoffAdvice({ usage: usage({ contextTokens: 10_000, contextWindow: 1_000_000, autoCompactAt: 367_000 }), compactionCount: 2, now }).level).toBe('suggest');
    const idle = handoffAdvice({
      usage: usage({ contextTokens: 200_000, contextWindow: 1_000_000, autoCompactAt: 967_000 }),
      lastActivityAt: new Date(now - CACHE_IDLE_TTL_MS - 1).toISOString(),
      now,
    });
    expect(idle.level).toBe('suggest');
    expect(idle.reasons.join(' ')).toMatch(/cache/);
    expect(handoffAdvice({ usage: usage({ contextTokens: 1_100_000, contextWindow: 1_000_000, autoCompactAt: 967_000 }), now }).level).toBe('urge');
  });

  it('an upper-bound reading never drives occupancy or idle advice', () => {
    const inexact = usage({ contextTokens: 697_060, contextWindow: 258_400, autoCompactAt: 244_800, contextTokensExact: false });
    expect(handoffAdvice({ usage: inexact, now, lastActivityAt: new Date(now - 2 * CACHE_IDLE_TTL_MS).toISOString() }).level).toBe('none');
    expect(handoffAdvice({ usage: inexact, compactionCount: 3, now }).level).toBe('suggest');
  });

  it('suggests expansive only on evidence, only for standard sessions with a real expansive budget', () => {
    expect(expansiveAdvice({ session: { compactionCount: 2 }, option: CLAUDE_1M }).suggest).toBe(true);
    expect(expansiveAdvice({ session: { compactionCount: 2, contextMode: 'expansive' }, option: CLAUDE_1M }).suggest).toBe(false);
    expect(expansiveAdvice({ session: { compactionCount: 5 }, option: HAIKU }).suggest).toBe(false);
    expect(expansiveAdvice({ session: {}, option: CLAUDE_1M, workingSetTokens: 600_000 }).suggest).toBe(true);
    expect(expansiveAdvice({ session: {}, option: CLAUDE_1M, workingSetTokens: 10_000 }).suggest).toBe(false);
  });
});
