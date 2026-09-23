/**
 * context-model.test.ts — the pure rules behind the handoff dialog, the memory
 * panel and message search, pinned without a DOM.
 */
import { describe, expect, it } from 'vitest';
import type { VerseSearchHit } from '../../../../core/verse/types.js';
import { SESSION_BASE_OVERHEAD_TOKENS } from '../../../../core/verse/context-math.js';
import {
  API_BODY_MAX_BYTES,
  budgetLine,
  defaultHandoffMode,
  defaultHandoffTarget,
  formatBytes,
  groupSearchHits,
  handoffFit,
  handoffTitle,
  HANDOFF_SUMMARY_REQUEST,
  highlightSegments,
  jsonBodyBytes,
  modelOption,
  offersExpansive,
  relativePhrase,
  requestMode,
  searchTerms,
  secretLike,
  targetUnavailableReason,
  TITLE_MAX_CHARS,
  turnCostSentence,
  utf8Bytes,
} from './context-model.js';
import {
  CLAUDE_SEAT,
  CODEX_SEAT,
  contextSession,
  FABLE,
  GPT6,
  HAIKU,
  LOCAL_MODEL,
  LOCAL_SEAT,
  OPUS_55,
  preferences,
  SEATS,
} from './context-fixtures.test-support.js';

describe('handoffTitle', () => {
  it('marks the continuation as part 2', () => {
    expect(handoffTitle('Migrate the billing tables')).toBe('Migrate the billing tables · part 2');
  });

  it('counts up instead of stacking suffixes', () => {
    expect(handoffTitle('Migrate the billing tables · part 2')).toBe('Migrate the billing tables · part 3');
    expect(handoffTitle('Migrate · part 9')).toBe('Migrate · part 10');
  });

  it('never exceeds the server title cap, so the server never cuts the suffix off', () => {
    const title = handoffTitle('x'.repeat(400));
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title.endsWith(' · part 2')).toBe(true);
    expect(title).toContain('…');
  });

  it('names an untitled source', () => {
    expect(handoffTitle('   ')).toBe('Untitled chat · part 2');
  });
});

describe('modelOption', () => {
  it('finds a stored alias under its canonical catalog id', () => {
    const seat = { ...CLAUDE_SEAT, models: [{ ...OPUS_55, unavailableReason: null }] };
    expect(modelOption(seat, 'claude-opus-5.5')?.id).toBe('claude-opus-5-5');
  });

  it('is null for an unknown seat or model', () => {
    expect(modelOption(null, 'x')).toBeNull();
    expect(modelOption(CLAUDE_SEAT, 'nope')).toBeNull();
  });
});

describe('defaultHandoffTarget', () => {
  it('continues on the same seat and model by default', () => {
    expect(defaultHandoffTarget(SEATS, contextSession())).toEqual({ seatId: 'claude-a', model: 'claude-fable-5-1' });
  });

  it('skips a model the seat can no longer run, staying on the seat', () => {
    expect(defaultHandoffTarget(SEATS, contextSession({ model: 'claude-opus-5-5' })))
      .toEqual({ seatId: 'claude-a', model: 'claude-fable-5-1' });
  });

  it('moves to another seat when the source seat is unavailable', () => {
    const down = { ...CLAUDE_SEAT, health: { state: 'unavailable' as const, summary: 'signed out', windows: [], observedAt: null } };
    expect(defaultHandoffTarget([down, CODEX_SEAT], contextSession())).toEqual({ seatId: 'codex-b', model: 'gpt-6-astra' });
  });

  it('is null with no runnable seat at all', () => {
    expect(defaultHandoffTarget([], contextSession())).toBeNull();
  });
});

describe('targetUnavailableReason', () => {
  it('names the pinned-CLI reason for an unrunnable model', () => {
    expect(targetUnavailableReason(CLAUDE_SEAT, OPUS_55)).toBe(
      'Opus 5.5 cannot run on Claude Max: needs Claude Code 2.1.280; this seat runs 2.1.257.',
    );
  });

  it('is null for a runnable model', () => {
    expect(targetUnavailableReason(CLAUDE_SEAT, FABLE)).toBeNull();
  });

  it('refuses an unavailable seat with its own summary', () => {
    const down = { ...CODEX_SEAT, health: { state: 'unavailable' as const, summary: 'quota exhausted', windows: [], observedAt: null } };
    expect(targetUnavailableReason(down, GPT6)).toBe('Personal Codex is unavailable: quota exhausted.');
  });
});

describe('defaultHandoffMode', () => {
  const source = contextSession({ contextMode: 'expansive' });

  it('keeps the source mode on the same seat and model', () => {
    expect(defaultHandoffMode({ option: FABLE, target: { seatId: 'claude-a', model: 'claude-fable-5-1' }, source, preferences: null }))
      .toBe('expansive');
  });

  it('uses the target seat preference on a different seat', () => {
    const prefs = preferences({ seats: { 'codex-b': { contextMode: 'expansive' } } });
    expect(defaultHandoffMode({ option: GPT6, target: { seatId: 'codex-b', model: 'gpt-6-astra' }, source: contextSession(), preferences: prefs }))
      .toBe('expansive');
  });

  it('never returns a mode the target model does not have', () => {
    const prefs = preferences({ seats: { 'claude-a': { contextMode: 'expansive' } } });
    expect(defaultHandoffMode({ option: HAIKU, target: { seatId: 'claude-a', model: HAIKU.id }, source, preferences: prefs }))
      .toBe('standard');
  });
});

describe('requestMode', () => {
  it('sends a mode only when the model has a budget for it', () => {
    expect(requestMode(FABLE, 'expansive')).toBe('expansive');
    expect(requestMode(HAIKU, 'expansive')).toBeUndefined();
    expect(requestMode({ id: 'x', label: 'x', contextWindow: null }, 'standard')).toBeUndefined();
    expect(requestMode(null, 'standard')).toBeUndefined();
  });
});

describe('budgetLine / offersExpansive', () => {
  it('states the window and the compaction point per mode', () => {
    expect(budgetLine(FABLE, 'standard')).toBe('1M window · compacts ≈367k');
    expect(budgetLine(FABLE, 'expansive')).toBe('1M window · compacts ≈967k');
    expect(budgetLine(GPT6, 'expansive')).toBe('828k window · compacts ≈785k');
    expect(budgetLine(HAIKU, 'expansive')).toBeNull();
  });

  it('offers expansive only where a real budget exists', () => {
    expect(offersExpansive(FABLE)).toBe(true);
    expect(offersExpansive(GPT6)).toBe(true);
    expect(offersExpansive(HAIKU)).toBe(false);
    expect(offersExpansive(LOCAL_MODEL)).toBe(false);
  });
});

describe('handoffFit', () => {
  it('fits a normal handoff on a 1M model and shows both halves of the sum', () => {
    const fit = handoffFit(8_000, FABLE, 'standard');
    expect(fit.verdict).toBe('fits');
    expect(fit.tone).toBe('ok');
    expect(fit.handoffTokens).toBe(2_000);
    expect(fit.needTokens).toBe(2_000 + SESSION_BASE_OVERHEAD_TOKENS);
    expect(fit.text).toContain('~2k tokens of handoff + ~30k of fixed prompt');
  });

  it('is honest about a 64k local slot: the fixed prompt alone nearly fills it', () => {
    // A 64k slot compacts at 32,536. A small note (2k) + 30k of fixed prompt
    // squeezes in as "tight"; a full-size 12,000-char note (3k) does not.
    expect(handoffFit(8_000, LOCAL_MODEL, 'standard').verdict).toBe('tight');
    const fit = handoffFit(12_000, LOCAL_MODEL, 'standard');
    expect(fit.verdict).toBe('split');
    expect(fit.tone).toBe('danger');
    expect(fit.text).toMatch(/Too big for one context/);
  });

  it('says tight with the percentage of the compaction point', () => {
    // 4k of handoff + 30k of fixed prompt = 34k against a 53k compaction point → 64%.
    const roomy = { ...LOCAL_MODEL, contextWindow: 131_072, autoCompactAt: 53_000 };
    const fit = handoffFit(4 * 4_000, roomy, 'standard');
    expect(fit.verdict).toBe('tight');
    expect(fit.text).toMatch(/Tight: .* is 64% of where this model compacts/);
  });

  it('distinguishes "needs expansive" in standard from "fits expansive" in expansive', () => {
    const small = { ...FABLE, autoCompactAt: 20_000 };
    expect(handoffFit(8_000, small, 'standard').text).toMatch(/Switch to Expansive/);
    expect(handoffFit(8_000, small, 'expansive').text).toMatch(/Fits only the expansive budget/);
  });

  it('claims nothing when the window is unknown', () => {
    const fit = handoffFit(8_000, { id: 'x', label: 'x', contextWindow: null }, 'standard');
    expect(fit.verdict).toBeNull();
    expect(fit.tone).toBe('unknown');
  });
});

describe('turnCostSentence', () => {
  it('says a local turn spends no subscription usage', () => {
    expect(turnCostSentence('local', 'Qwen')).toMatch(/spends no subscription usage/);
  });

  it('says a paid turn spends the seat’s usage, by name', () => {
    expect(turnCostSentence('claude', 'Claude Max')).toMatch(/one turn to Claude Max and spends from its usage/);
  });
});

describe('the canned summary request', () => {
  it('asks for a note, not for work', () => {
    expect(HANDOFF_SUMMARY_REQUEST).toMatch(/Do not edit files or run commands/);
    expect(HANDOFF_SUMMARY_REQUEST).toMatch(/reason/);
    expect(new TextEncoder().encode(HANDOFF_SUMMARY_REQUEST).length).toBeLessThan(2_000);
  });
});

describe('bytes', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('measures a request body as it is sent, escapes included', () => {
    expect(API_BODY_MAX_BYTES).toBe(65_536);
    expect(jsonBodyBytes({ text: 'ab' })).toBe('{"text":"ab"}'.length);
    // A line break and a quote each travel as two bytes.
    expect(jsonBodyBytes({ text: '\n"' })).toBe('{"text":"\\n\\""}'.length);
    expect(jsonBodyBytes({ content: 'x\n'.repeat(30_000) })).toBeGreaterThan(API_BODY_MAX_BYTES);
  });

  it('formats bytes for a narrow panel', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(64 * 1024)).toBe('64 KB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('relativePhrase', () => {
  const now = Date.parse('2026-09-23T10:00:00.000Z');
  it('reads as prose', () => {
    expect(relativePhrase('2026-09-23T09:59:50.000Z', now)).toBe('just now');
    expect(relativePhrase('2026-09-23T09:55:00.000Z', now)).toBe('5m ago');
    expect(relativePhrase('2026-09-01T10:00:00.000Z', now)).toMatch(/^on /);
    expect(relativePhrase(null, now)).toBeNull();
    expect(relativePhrase('garbage', now)).toBeNull();
  });
});

describe('secretLike', () => {
  it('flags credential shapes', () => {
    expect(secretLike('key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123')).toBe('an Anthropic API key');
    expect(secretLike('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('a GitHub token');
    expect(secretLike('AKIAABCDEFGHIJKLMNOP')).toBe('an AWS access key');
    expect(secretLike('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('a private key');
  });

  it('leaves ordinary engineering prose alone', () => {
    expect(secretLike('Use sk-style prefixes for keys; the task-runner is at scripts/sk-deploy.sh')).toBeNull();
    expect(secretLike('- Decided: batch size 5000 because the table is 40M rows')).toBeNull();
  });
});

describe('search helpers', () => {
  it('splits, lowercases and de-duplicates terms', () => {
    expect(searchTerms('  Retry retry  POLICY ')).toEqual(['retry', 'policy']);
    expect(searchTerms('')).toEqual([]);
  });

  it('marks every term, case-insensitively, longest first', () => {
    expect(highlightSegments('Retry the retrying policy', ['retry', 'retrying'])).toEqual([
      { text: 'Retry', match: true },
      { text: ' the ', match: false },
      { text: 'retrying', match: true },
      { text: ' policy', match: false },
    ]);
  });

  it('treats regex characters in a term literally', () => {
    expect(highlightSegments('call fn(a.b) now', ['fn(a.b)'])).toEqual([
      { text: 'call ', match: false },
      { text: 'fn(a.b)', match: true },
      { text: ' now', match: false },
    ]);
  });

  it('returns the text unmarked with no terms', () => {
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', match: false }]);
    expect(highlightSegments('', ['x'])).toEqual([]);
  });

  it('groups message hits into one row per chat, best hit first', () => {
    const hit = (over: Partial<VerseSearchHit>): VerseSearchHit => ({
      sessionId: 's1', title: 'A', projectPath: '/p', engine: 'claude', seq: 1, at: '2026-09-20T00:00:00.000Z',
      kind: 'user', snippet: 'x', score: 1, ...over,
    });
    const groups = groupSearchHits([
      hit({ sessionId: 's2', score: 9, snippet: 'best' }),
      hit({ sessionId: 's1', score: 5 }),
      hit({ sessionId: 's2', score: 3, at: '2026-09-22T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.sessionId)).toEqual(['s2', 's1']);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.top.snippet).toBe('best');
    expect(groups[0]!.latestAt).toBe('2026-09-22T00:00:00.000Z');
  });
});

describe('fixtures sanity (the numbers the docs quote)', () => {
  it('matches docs/VERSE-CONTEXT.md', () => {
    expect(FABLE.autoCompactAt).toBe(367_000);
    expect(FABLE.expansive?.autoCompactAt).toBe(967_000);
    expect(GPT6.contextWindow).toBe(258_400);
    expect(GPT6.expansive?.contextWindow).toBe(828_400);
    expect(LOCAL_SEAT.models[0]!.autoCompactAt).toBe(32_536);
  });
});
