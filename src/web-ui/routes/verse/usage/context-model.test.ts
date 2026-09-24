/**
 * context-model.test.ts — the wording and aggregation every seat surface
 * shares. Pinned at the places where the convenient projection would lie: a
 * default window presented as a fact, codex's turn total presented as a
 * measurement, "no cache reported" presented as 0%, and a per-chat average
 * of ratios presented as a seat's ratio.
 */
import { describe, expect, it } from 'vitest';
import type { VerseEvent, VerseSession } from '../../../data/api-types.js';
import { CACHE_IDLE_TTL_MS } from '../../../../core/verse/context-math.js';
import {
  CLAUDE_CONTEXT_SEAT,
  CLAUDE_SKEW_NOTE,
  CODEX_CONTEXT_SEAT,
  GROK_CONTEXT_SEAT,
  LOCAL_CONTEXT_SEAT,
  OPUS_55_REASON,
  UNKNOWN_WINDOW_SEAT,
} from '../seat-fixtures.test-support.js';
import {
  contextModeDescription,
  effectiveBudget,
  fitExplanation,
  fitMethodNote,
  expansiveMeteringNote,
  fitIsFloor,
  formatRatio,
  idleCacheWarning,
  isEstimatedWindow,
  modelContextPhrase,
  modelContextSentence,
  modelFit,
  seatModelOption,
  modelUnavailableReason,
  noModeReason,
  reportedCacheHitRatio,
  resolveContextMode,
  seatCliLine,
  seatContextNotes,
  seatEfficiency,
  sessionContext,
  turnContextStats,
} from './context-model.js';
import { CODEX_EXPANSIVE_METERING_NOTE, WINDOW_SOURCE_TEXT } from '../verse-model.js';

const FABLE = CLAUDE_CONTEXT_SEAT.models[0]!;
const OPUS_55 = CLAUDE_CONTEXT_SEAT.models[1]!;
const HAIKU = CLAUDE_CONTEXT_SEAT.models[2]!;
const GPT6 = CODEX_CONTEXT_SEAT.models[0]!;
const GPT55 = CODEX_CONTEXT_SEAT.models[1]!;
const GROK = GROK_CONTEXT_SEAT.models[0]!;
const LOCAL = LOCAL_CONTEXT_SEAT.models[0]!;
const MYSTERY = UNKNOWN_WINDOW_SEAT.models[0]!;

function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'vs_1',
    title: 'Refactor the queue',
    projectPath: '/Users/mason/dev/hub',
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-fable-5-1',
    nativeSessionId: 'uuid-1',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:05:00.000Z',
    status: 'idle',
    turnCount: 3,
    usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 8_000, cacheCreationTokens: 1_000, contextTokens: 142_000, contextWindow: 1_000_000 },
    lastError: null,
    ...over,
  };
}

let seq = 0;
function usageEvent(turnId: string, usage: Partial<VerseSession['usage']>): VerseEvent {
  seq += 1;
  return {
    seq,
    at: '2026-09-23T10:00:00.000Z',
    type: 'usage',
    turnId,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null, ...usage },
  };
}
function contextEvent(turnId: string | null, contextTokens: number, exact = true): VerseEvent {
  seq += 1;
  return { seq, at: '2026-09-23T10:00:00.000Z', type: 'context', turnId, contextTokens, contextWindow: 258_400, exact };
}
function compactionEvent(turnId: string): VerseEvent {
  seq += 1;
  return { seq, at: '2026-09-23T10:00:00.000Z', type: 'compaction', turnId, trigger: 'auto', preTokens: 967_391, postTokens: 19_001, durationMs: 118_000 };
}

describe('models and modes', () => {
  it('finds a model through the alias table, so an old dotted id still resolves', () => {
    expect(seatModelOption(CLAUDE_CONTEXT_SEAT, 'claude-opus-5-5')).toBe(OPUS_55);
    // What Verse once shipped — the CLI ran it as Opus 5, but it IS the 5.5 row.
    expect(seatModelOption(CLAUDE_CONTEXT_SEAT, 'claude-opus-5.5')).toBe(OPUS_55);
    expect(seatModelOption(CLAUDE_CONTEXT_SEAT, 'claude-nope')).toBeNull();
    expect(seatModelOption(null, 'claude-fable-5-1')).toBeNull();
  });

  it('never resolves to a mode the model cannot be told', () => {
    expect(resolveContextMode(FABLE, 'expansive')).toBe('expansive');
    expect(resolveContextMode(HAIKU, 'expansive')).toBe('standard');
    expect(resolveContextMode(GPT55, 'expansive')).toBe('standard');
    expect(resolveContextMode(GROK, 'expansive')).toBe('standard');
    expect(effectiveBudget(FABLE, 'expansive')).toEqual({ contextWindow: 1_000_000, autoCompactAt: 967_000 });
    expect(effectiveBudget(HAIKU, 'expansive')).toEqual({ contextWindow: 200_000, autoCompactAt: 167_000 });
    expect(effectiveBudget(MYSTERY, 'standard')).toBeNull();
  });

  it('lets a seat outage outrank a model reason, and ignores a blank reason', () => {
    expect(modelUnavailableReason(CLAUDE_CONTEXT_SEAT, OPUS_55)).toBe(OPUS_55_REASON);
    expect(modelUnavailableReason(CLAUDE_CONTEXT_SEAT, FABLE)).toBeNull();
    expect(modelUnavailableReason(CLAUDE_CONTEXT_SEAT, { ...FABLE, unavailableReason: '   ' })).toBeNull();
    const down = { ...CLAUDE_CONTEXT_SEAT, health: { ...CLAUDE_CONTEXT_SEAT.health, state: 'unavailable' as const, summary: 'signed out' } };
    expect(modelUnavailableReason(down, OPUS_55)).toBe('signed out');
  });

  it('names the pinned CLI and passes the seat notes through', () => {
    expect(seatCliLine(CLAUDE_CONTEXT_SEAT)).toBe('Claude Code 2.1.257');
    expect(seatCliLine(CODEX_CONTEXT_SEAT)).toBe('Codex CLI 0.155.0');
    expect(seatCliLine(LOCAL_CONTEXT_SEAT)).toBeNull();
    expect(seatContextNotes(CLAUDE_CONTEXT_SEAT)).toEqual([CLAUDE_SKEW_NOTE]);
    expect(seatContextNotes(GROK_CONTEXT_SEAT)).toEqual([]);
  });
});

describe('picker and dialog wording', () => {
  it('gives each model its own window and compaction point', () => {
    expect(modelContextPhrase(FABLE)).toBe('1M ctx · compacts ≈367k');
    expect(modelContextPhrase(FABLE, 'expansive')).toBe('1M ctx · compacts ≈967k (expansive)');
    expect(modelContextPhrase(HAIKU)).toBe('200k ctx · compacts ≈167k');
    expect(modelContextPhrase(GPT6)).toBe('258k ctx · compacts ≈245k');
    expect(modelContextPhrase(GPT6, 'expansive')).toBe('828k ctx · compacts ≈785k (expansive)');
    expect(modelContextPhrase(GROK)).toBe('500k ctx · compacts ≈400k');
    expect(modelContextPhrase(LOCAL)).toBe('66k ctx · compacts ≈33k');
  });

  it('says "unknown" rather than printing a default, and marks an estimate as one', () => {
    expect(modelContextPhrase(MYSTERY)).toBe('window unknown');
    expect(modelContextPhrase({ id: 'x', label: 'X', contextWindow: 200_000, windowSource: 'fallback' })).toBe('200k ctx (est.)');
    expect(isEstimatedWindow('fallback')).toBe(true);
    expect(isEstimatedWindow('runtime')).toBe(false);
    expect(isEstimatedWindow(undefined)).toBe(false);
  });

  it('writes the long form with both budgets and the provenance', () => {
    expect(modelContextSentence(FABLE)).toBe(
      `1M-token window; compacts at about 367k in Standard. Expansive runs to about 967k before compacting. Window ${WINDOW_SOURCE_TEXT['cli-catalog']}.`,
    );
    expect(modelContextSentence(GROK)).toBe(`500k-token window; compacts at about 400k. Window ${WINDOW_SOURCE_TEXT['provider-catalog']}.`);
    expect(modelContextSentence(MYSTERY)).toBe('Context window unknown for this model.');
  });

  it('explains what each mode costs with arithmetic, not adjectives', () => {
    const standard = contextModeDescription('claude', FABLE, 'standard');
    expect(standard).toContain('Compacts at about 367k');
    expect(standard).toContain('re-sends the whole context');
    const expansive = contextModeDescription('claude', FABLE, 'expansive');
    expect(expansive).toContain('Runs to about 967k');
    // 967k / 367k — exactly how much more a full expansive turn re-sends.
    expect(expansive).toContain('re-sends 2.6× the tokens of one at 367k');
    expect(expansive).not.toContain('OpenAI');
    // Codex carries the ONE shared metering caveat, worded as reported (single source).
    const codex = contextModeDescription('codex', GPT6, 'expansive');
    expect(codex).toContain(CODEX_EXPANSIVE_METERING_NOTE);
    // "twice that" must follow the ratio it multiplies.
    expect(codex.indexOf('re-sends 3.2× the tokens')).toBeLessThan(codex.indexOf(CODEX_EXPANSIVE_METERING_NOTE));
    expect(CODEX_EXPANSIVE_METERING_NOTE).toMatch(/reportedly/);
    expect(CODEX_EXPANSIVE_METERING_NOTE).toMatch(/272k/);
    expect(CODEX_EXPANSIVE_METERING_NOTE).toMatch(/about 2×/);
    expect(expansiveMeteringNote('codex')).toBe(CODEX_EXPANSIVE_METERING_NOTE);
    expect(expansiveMeteringNote('claude')).toBeNull();
    expect(expansiveMeteringNote(null)).toBeNull();
    expect(contextModeDescription('codex', GPT55, 'standard')).toBe("Compacts at about 245k — the CLI's own default budget for this model.");
  });

  it('says why a model offers no mode choice', () => {
    expect(noModeReason('grok', GROK)).toMatch(/compacts at its own fixed point/);
    expect(noModeReason('local', LOCAL)).toMatch(/compacts at its own fixed point/);
    expect(noModeReason('claude', HAIKU)).toMatch(/no larger window/);
    expect(noModeReason('claude', MYSTERY)).toMatch(/window is unknown/);
  });
});

describe('context fit', () => {
  it('a 300k working set needs expansive on GPT-6 and must be split on a 64k local model', () => {
    expect(modelFit(300_000, GPT6, 'standard', 'codex')).toBe('expansive');
    expect(modelFit(300_000, LOCAL, 'standard', 'local')).toBe('split');
    expect(modelFit(300_000, FABLE, 'standard', 'claude')).toBe('tight');
    expect(modelFit(100_000, FABLE, 'standard', 'claude')).toBe('fits');
    expect(modelFit(300_000, GPT55, 'standard', 'codex')).toBe('split');
    // Unknown budget, unknown working set: no verdict, never a guess.
    expect(modelFit(300_000, MYSTERY, 'standard', 'claude')).toBeNull();
    expect(modelFit(null, FABLE, 'standard', 'claude')).toBeNull();
    expect(modelFit(Number.NaN, FABLE, 'standard', 'claude')).toBeNull();
  });

  it('explains every verdict, and says HOW to split', () => {
    expect(fitExplanation({ verdict: 'fits', tokens: 100_000, option: FABLE, mode: 'standard' }))
      .toBe('All ~100k tokens of tracked code fits well inside this model\'s budget (compacts ≈367k), with room left for the conversation.');
    expect(fitExplanation({ verdict: 'tight', tokens: 300_000, option: FABLE, mode: 'standard' })).toMatch(/under the ≈367k compaction point/);
    const needs = fitExplanation({ verdict: 'expansive', tokens: 300_000, option: GPT6, mode: 'standard' });
    expect(needs).toContain('only Expansive (≈785k) takes it all');
    expect(needs).toContain('Switch to Expansive');
    expect(fitExplanation({ verdict: 'tight', tokens: 300_000, option: FABLE, mode: 'standard' }))
      .toContain('Expansive (≈967k) would hold it with room to spare.');
    expect(fitExplanation({ verdict: 'tight', tokens: 300_000, option: HAIKU, mode: 'standard' })).not.toContain('Expansive');
    const split = fitExplanation({ verdict: 'split', tokens: 2_000_000, option: FABLE, mode: 'standard', floor: true });
    expect(split).toMatch(/^At least ~2M tokens/);
    expect(split).toContain('even Expansive (≈967k)');
    expect(split).toContain('fan it out across several chats');
    expect(split).toContain('narrow this chat');
  });

  it('judges a chat set to Expansive against the budget it will actually run with', () => {
    expect(modelFit(300_000, FABLE, 'expansive', 'claude')).toBe('fits');
    expect(modelFit(700_000, FABLE, 'expansive', 'claude')).toBe('tight');
    expect(modelFit(2_000_000, FABLE, 'expansive', 'claude')).toBe('split');
    expect(modelFit(300_000, GPT6, 'expansive', 'codex')).toBe('fits');
    // No expansive budget: the mode resolves to Standard, and so does the verdict.
    expect(modelFit(300_000, HAIKU, 'expansive', 'claude')).toBe('split');
    expect(fitExplanation({ verdict: 'fits', tokens: 300_000, option: FABLE, mode: 'expansive' }))
      .toBe("All ~300k tokens of tracked code fits well inside this model's Expansive budget (compacts ≈967k), with room left for the conversation.");
    expect(fitExplanation({ verdict: 'tight', tokens: 700_000, option: FABLE, mode: 'expansive' }))
      .toMatch(/fits under the ≈967k compaction point of the Expansive budget/);
  });

  it('adds the seat engine’s estimated fixed prompt, not one flat figure', () => {
    // A 64k local seat compacts at 32,536. With a flat 30k fixed prompt any
    // code over ~2.5k tokens was "too big — split"; local's ~15k estimate
    // leaves real room, so 8k of code fits tightly.
    expect(modelFit(3_000, LOCAL, 'standard', 'local')).toBe('fits');
    expect(modelFit(8_000, LOCAL, 'standard', 'local')).toBe('tight');
    expect(modelFit(20_000, LOCAL, 'standard', 'local')).toBe('split');
    // No engine: the largest estimate (25k), so less room.
    expect(modelFit(7_000, LOCAL, 'standard', null)).toBe('tight');
    expect(modelFit(8_000, LOCAL, 'standard', null)).toBe('split');
  });

  it('names the fixed-prompt estimate the verdict used', () => {
    expect(fitMethodNote('local')).toContain('an estimated ~15k of fixed prompt for Claude Code');
    expect(fitMethodNote('codex')).toContain('an estimated ~15k of fixed prompt for Codex CLI');
    expect(fitMethodNote('claude')).toContain('an estimated ~25k');
    expect(fitMethodNote(null)).toContain('an estimated ~25k of fixed prompt that every chat');
  });

  it('treats a truncated root as a floor', () => {
    const root = { path: '/a', files: 20_000, bytes: 1, estTokens: 1, truncated: false };
    expect(fitIsFloor({ roots: [root], totalEstTokens: 1, estimator: 'bytes/4', sampledAt: 'x' })).toBe(false);
    expect(fitIsFloor({ roots: [root, { ...root, truncated: true }], totalEstTokens: 1, estimator: 'bytes/4', sampledAt: 'x' })).toBe(true);
  });
});

describe('sessionContext — the meter precedence', () => {
  const seats = [CLAUDE_CONTEXT_SEAT, GROK_CONTEXT_SEAT];

  it('prefers a window the CLI reported at runtime', () => {
    const view = sessionContext(session({
      usage: { ...session().usage, contextWindow: 200_000, contextWindowSource: 'runtime', autoCompactAt: 167_000 },
    }), seats);
    expect(view).toMatchObject({ window: 200_000, autoCompactAt: 167_000, source: 'runtime', exact: true });
  });

  it('otherwise uses the CURRENT catalog budget for the model and mode, repairing a stale stored window', () => {
    // A grok session saved at the old 256k default.
    const grok = sessionContext(session({
      seatId: 'grok-a', engine: 'grok', model: 'grok-4.7-build-fast',
      usage: { ...session().usage, contextWindow: 256_000 },
    }), seats);
    expect(grok).toMatchObject({ window: 500_000, autoCompactAt: 400_000, source: 'provider-catalog', mode: 'standard', hasModes: false });

    const expansive = sessionContext(session({ contextMode: 'expansive' }), seats);
    expect(expansive).toMatchObject({ window: 1_000_000, autoCompactAt: 967_000, mode: 'expansive', hasModes: true });
    // The dotted id Verse once shipped still finds its catalog row.
    expect(sessionContext(session({ model: 'claude-opus-5.5' }), seats)).toMatchObject({ window: 1_000_000, autoCompactAt: 367_000 });
  });

  it('falls back to what the record stored, claiming no provenance it never recorded', () => {
    const gone = sessionContext(session({ seatId: 'retired-seat' }), seats);
    expect(gone).toMatchObject({ window: 1_000_000, autoCompactAt: null, source: null });
    const sourced = sessionContext(session({ seatId: 'retired-seat', usage: { ...session().usage, contextWindowSource: 'documented' } }), seats);
    expect(sourced).toMatchObject({ window: 1_000_000, source: 'documented' });
    const none = sessionContext(session({ seatId: 'retired-seat', usage: { ...session().usage, contextWindow: null } }), seats);
    expect(none).toMatchObject({ window: null, source: null });
  });

  it('carries the upper-bound flag and never clamps the reading', () => {
    const codex = sessionContext(session({
      seatId: 'codex-b', engine: 'codex', model: 'gpt-6-astra',
      usage: { ...session().usage, contextTokens: 2_800_000, contextTokensExact: false },
    }), [CODEX_CONTEXT_SEAT]);
    expect(codex).toMatchObject({ tokens: 2_800_000, exact: false, window: 258_400 });
  });
});

describe('cache ratios', () => {
  it('reports none-reported rather than 0% when the provider said nothing about its cache', () => {
    expect(reportedCacheHitRatio({ inputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
    expect(reportedCacheHitRatio({ inputTokens: 1_000, cacheReadTokens: 8_000, cacheCreationTokens: 1_000 })).toBeCloseTo(0.8);
    // A cache WRITE with no reads yet is a real 0%: the provider did report caching.
    expect(reportedCacheHitRatio({ inputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 9_000 })).toBe(0);
    expect(formatRatio(0.8)).toBe('80%');
    expect(formatRatio(null)).toBe('—');
  });
});

describe('turnContextStats', () => {
  it('averages and peaks the per-turn context from the log', () => {
    const stats = turnContextStats([
      usageEvent('t1', { contextTokens: 40_000, inputTokens: 1_000, cacheCreationTokens: 39_000 }),
      usageEvent('t2', { contextTokens: 90_000, cacheReadTokens: 80_000, inputTokens: 10_000 }),
      compactionEvent('t2'),
      usageEvent('t3', { contextTokens: 20_000, cacheReadTokens: 18_000, inputTokens: 2_000 }),
    ]);
    expect(stats).toMatchObject({ turns: 3, average: 50_000, peak: 90_000, exact: true, compactions: 1 });
    expect(stats.lastTurnCacheHit).toBeCloseTo(0.9);
  });

  it('lets an exact rollout reading replace codex’s turn total, never mixing the two', () => {
    const stats = turnContextStats([
      // The turn total sums every call — 2.8M on a 258k window.
      usageEvent('t1', { contextTokens: 2_800_000, contextTokensExact: false, inputTokens: 2_800_000 }),
      contextEvent('t1', 120_000),
      contextEvent('t1', 136_000),
    ]);
    expect(stats).toMatchObject({ turns: 1, average: 136_000, peak: 136_000, exact: true });
  });

  it('flags the statistic when a turn had only an upper bound', () => {
    const stats = turnContextStats([
      usageEvent('t1', { contextTokens: 100_000 }),
      usageEvent('t2', { contextTokens: 500_000, contextTokensExact: false }),
    ]);
    expect(stats).toMatchObject({ turns: 2, average: 300_000, peak: 500_000, exact: false });
  });

  it('says nothing for an empty log and ignores readings outside any turn', () => {
    expect(turnContextStats([])).toEqual({ turns: 0, average: null, peak: null, exact: true, compactions: 0, lastTurnCacheHit: null });
    expect(turnContextStats([contextEvent(null, 50_000)]).turns).toBe(0);
  });
});

describe('idleCacheWarning', () => {
  const at = Date.parse('2026-09-23T10:05:00.000Z');
  const lastTurn = new Date(at).toISOString();

  it('warns once the chat has been idle past the cache lifetime (61 minutes), timed from the last TURN', () => {
    expect(idleCacheWarning(session(), 142_000, at + 61 * 60_000, lastTurn)).toEqual({ idleMs: 61 * 60_000, tokens: 142_000, local: false });
    expect(idleCacheWarning(session(), 142_000, at + CACHE_IDLE_TTL_MS - 60_000, lastTurn)).toBeNull();
  });

  it('ignores session.updatedAt: a rename or mode switch does not warm the provider cache', () => {
    const renamedJustNow = session({ updatedAt: new Date(at + 2 * CACHE_IDLE_TTL_MS - 1_000).toISOString() });
    expect(idleCacheWarning(renamedJustNow, 142_000, at + 2 * CACHE_IDLE_TTL_MS, lastTurn)).not.toBeNull();
  });

  it('stays quiet while running, for a context no bigger than a fresh chat’s, with no turn yet, and on a bad timestamp', () => {
    expect(idleCacheWarning(session({ status: 'running' }), 142_000, at + 2 * CACHE_IDLE_TTL_MS, lastTurn)).toBeNull();
    expect(idleCacheWarning(session(), 20_000, at + 2 * CACHE_IDLE_TTL_MS, lastTurn)).toBeNull();
    expect(idleCacheWarning(session(), 142_000, at + 2 * CACHE_IDLE_TTL_MS, null)).toBeNull();
    expect(idleCacheWarning(session(), 142_000, at + 2 * CACHE_IDLE_TTL_MS, 'not a date')).toBeNull();
  });

  it('marks a local chat, whose cost is time rather than spend', () => {
    expect(idleCacheWarning(session({ engine: 'local' }), 40_000, at + 2 * CACHE_IDLE_TTL_MS, lastTurn)?.local).toBe(true);
  });
});

describe('seatEfficiency', () => {
  const seats = [CLAUDE_CONTEXT_SEAT, LOCAL_CONTEXT_SEAT];

  it('computes a seat’s ratio from summed tokens, not a mean of per-chat ratios', () => {
    const rows = seatEfficiency([
      // 2 turns, 0% hit on a tiny chat …
      session({ id: 'a', turnCount: 2, usage: { ...session().usage, inputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 100, contextTokens: 1_000 } }),
      // … and a long chat at 90%. The mean of ratios would say 45%.
      session({ id: 'b', turnCount: 200, compactionCount: 3, contextMode: 'expansive', usage: { ...session().usage, inputTokens: 90_000, cacheReadTokens: 900_000, cacheCreationTokens: 10_000, contextTokens: 600_000 } }),
    ], seats);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ seatId: 'claude-a', label: 'Claude Max', sessions: 2, turns: 202, compactions: 3, expansiveSessions: 1, retired: false });
    expect(row.promptTokens).toBe(1_001_000);
    expect(row.cacheHitRatio).toBeCloseTo(900_000 / 1_001_000);
    // The expansive chat is the fullest: 600k of its 1M window.
    expect(row.fullest).toMatchObject({ sessionId: 'b', tokens: 600_000, window: 1_000_000 });
  });

  it('counts an expansive chat even before it has a context reading', () => {
    const rows = seatEfficiency([
      session({ id: 'std' }),
      // The mode is a fact about the chat, not its reading.
      session({ id: 'empty', contextMode: 'expansive', usage: { ...session().usage, contextTokens: 0 } }),
    ], seats);
    expect(rows[0]).toMatchObject({ sessions: 2, expansiveSessions: 1 });
  });

  it('keeps a retired seat’s history, says none-reported for a local seat, and sorts by prompt tokens', () => {
    const rows = seatEfficiency([
      session({ id: 'l', seatId: LOCAL_CONTEXT_SEAT.id, engine: 'local', model: 'qwen3.8:27b-ctx64k', usage: { inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 30_000, contextWindow: 65_536 } }),
      session({ id: 'r', seatId: 'grok-old', engine: 'grok', model: 'grok-4', usage: { inputTokens: 500_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 256_000 } }),
    ], seats);
    expect(rows.map((r) => r.seatId)).toEqual(['grok-old', LOCAL_CONTEXT_SEAT.id]);
    expect(rows[0]).toMatchObject({ label: 'grok-old', engine: 'grok', retired: true, fullest: null, cacheHitRatio: null });
    expect(rows[1]).toMatchObject({ cacheHitRatio: null, fullest: { tokens: 30_000, window: 65_536 } });
  });

  it('omits seats with no chats instead of listing them at zero', () => {
    expect(seatEfficiency([], seats)).toEqual([]);
  });
});
