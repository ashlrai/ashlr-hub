import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseEvent } from '../../data/api-types.js';
import { ev, session } from './fixtures.test-support.js';
import { parseVerseEventFrame, VERSE_EVENT_TYPES } from './verse-events.js';
import { bestOf, median, openLastTurn, realisticLog, stamp } from './verse-perf.test-support.js';
import {
  applyContextReading,
  applyUsageFrame,
  applyVerseEvent,
  applyVerseEvents,
  buildTranscript,
  createTranscriptCache,
  forgetVerseSession,
  formatTokens,
  getVerseLive,
  getVerseSessionHead,
  getVerseSessionState,
  getVerseTranscript,
  groupTranscriptItems,
  lastTurnActivityAt,
  resetVerseStore,
  seedVerseSession,
  setVerseSession,
  settledStatus,
  subscribeVerseSession,
  subscribeVerseStore,
  subscribeVerseStoreLifecycle,
} from './verse-store.js';

/** A transient frame: it carries the last PERSISTED seq (wire rule, core/verse/types.ts). */
function transient(seq: number, e: Record<string, unknown>): VerseEvent {
  return { seq, at: stamp(seq), ...e } as VerseEvent;
}

describe('buildTranscript', () => {
  it('accumulates text-deltas into a streaming bubble and replaces it with the assistant-message', () => {
    const streaming = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text: 'Hel' }),
      ev(4, 'text-delta', { turnId: 't1', text: 'lo' }),
    ]);
    expect(streaming.live).toBe(true);
    expect(streaming.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    const bubble = streaming.items[1]!;
    expect(bubble.kind === 'assistant' && bubble.text).toBe('Hello');
    expect(bubble.kind === 'assistant' && bubble.streaming).toBe(true);

    const done = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text: 'Hel' }),
      ev(4, 'text-delta', { turnId: 't1', text: 'lo' }),
      ev(5, 'assistant-message', { turnId: 't1', text: 'Hello **world**' }),
      ev(6, 'usage', { turnId: 't1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 42, contextWindow: 100 } }),
      ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1200 }),
    ]);
    expect(done.live).toBe(false);
    const kinds = done.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'assistant', 'turn-done']);
    const message = done.items[1]!;
    expect(message.kind === 'assistant' && message.text).toBe('Hello **world**');
    expect(message.kind === 'assistant' && message.streaming).toBe(false);
    expect(done.usage?.contextTokens).toBe(42);
  });

  it('pairs tool-use with its tool-result by toolUseId and flags errors', () => {
    const t = buildTranscript([
      ev(1, 'tool-use', { turnId: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls -la' } }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'tu2', name: 'Read', input: { file_path: '/x' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'tu1', output: 'total 0', isError: false }),
      ev(4, 'tool-result', { turnId: 't1', toolUseId: 'tu2', output: 'ENOENT', isError: true }),
    ]);
    expect(t.items).toHaveLength(2);
    const [a, b] = t.items;
    expect(a!.kind === 'tool' && a!.result).toEqual({ output: 'total 0', isError: false });
    expect(b!.kind === 'tool' && b!.result).toEqual({ output: 'ENOENT', isError: true });
  });

  it('keeps streamed text when the turn ends without an assistant-message', () => {
    const t = buildTranscript([
      ev(1, 'text-delta', { turnId: 't1', text: 'partial' }),
      ev(2, 'cancelled', { turnId: 't1' }),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['assistant', 'cancelled']);
    expect(t.items[0]!.kind === 'assistant' && t.items[0]!.streaming).toBe(false);
  });
});

describe('verse store', () => {
  beforeEach(() => resetVerseStore());

  it('dedupes by seq, keeps events ordered, and updates the session from usage / turn-done', () => {
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'hi' })]);
    expect(applyVerseEvent('vs_1', ev(1, 'user-message', { turnId: 't1', text: 'hi' }))).toBe(false);
    expect(applyVerseEvent('vs_1', ev(3, 'assistant-message', { turnId: 't1', text: 'yo' }))).toBe(true);
    expect(applyVerseEvent('vs_1', ev(2, 'turn-started', { turnId: 't1', pid: 7 }))).toBe(true);
    let state = getVerseSessionState('vs_1');
    expect(state.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(state.session?.status).toBe('running');
    expect(state.lastSeq).toBe(3);

    applyVerseEvent('vs_1', ev(4, 'usage', { turnId: 't1', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 150_000, contextWindow: 200_000 } }));
    applyVerseEvent('vs_1', ev(5, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: 'thread-9', durationMs: 10 }));
    state = getVerseSessionState('vs_1');
    expect(state.session?.usage.contextTokens).toBe(150_000);
    expect(state.session?.status).toBe('idle');
    expect(state.session?.turnCount).toBe(2);
    expect(state.session?.nativeSessionId).toBe('thread-9');
  });

  it('accumulates usage totals across turns while context occupancy stays live', () => {
    seedVerseSession('vs_1', session(), []);
    applyVerseEvent('vs_1', ev(1, 'usage', { turnId: 't1', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 5, contextTokens: 1100, contextWindow: 200_000 } }));
    applyVerseEvent('vs_1', ev(2, 'usage', { turnId: 't2', usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 2000, cacheCreationTokens: 0, contextTokens: 2050, contextWindow: null } }));
    const { usage } = getVerseSessionState('vs_1').session!;
    // Fixture starts at input 1200 / output 300 (the server's running totals).
    expect(usage).toEqual({ inputTokens: 1350, outputTokens: 330, cacheReadTokens: 3000, cacheCreationTokens: 5, contextTokens: 2050, contextWindow: 200_000 });
  });

  it('Stop settles to idle: cancelled + turn-done ok:false is not a failure', () => {
    seedVerseSession('vs_1', session(), []);
    applyVerseEvent('vs_1', ev(1, 'user-message', { turnId: 't1', text: 'hi' }));
    applyVerseEvent('vs_1', ev(2, 'turn-started', { turnId: 't1', pid: 1 }));
    expect(getVerseSessionState('vs_1').session?.status).toBe('running');
    applyVerseEvent('vs_1', ev(3, 'cancelled', { turnId: 't1' }));
    applyVerseEvent('vs_1', ev(4, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 800 }));
    const s = getVerseSessionState('vs_1').session!;
    expect(s.status).toBe('idle');
    expect(s.lastError).toBeNull();
  });

  it('does not let a stale `running` snapshot overwrite a turn the log already settled', () => {
    seedVerseSession('vs_1', session(), []);
    applyVerseEvent('vs_1', ev(1, 'user-message', { turnId: 't1', text: 'hi' }));
    applyVerseEvent('vs_1', ev(2, 'turn-started', { turnId: 't1', pid: 1 }));
    applyVerseEvent('vs_1', ev(3, 'error', { turnId: 't1', message: 'claude process error: ENOENT (launcher not found)' }));
    applyVerseEvent('vs_1', ev(4, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 0 }));
    expect(getVerseSessionState('vs_1').session?.status).toBe('error');

    // The POST …/turns 202 arrives after the SSE frames: its `running` must lose.
    setVerseSession('vs_1', session({ status: 'running' }), 't1');
    expect(getVerseSessionState('vs_1').session?.status).toBe('error');
    expect(getVerseSessionState('vs_1').session?.lastError).toContain('ENOENT');

    // A snapshot for a NEW turn whose events have not streamed in yet is still running.
    setVerseSession('vs_1', session({ status: 'running' }), 't2');
    expect(getVerseSessionState('vs_1').session?.status).toBe('running');

    // Detail fetch that raced a cancel: no turnId hint, the log's last turn is settled → idle.
    applyVerseEvent('vs_1', ev(5, 'user-message', { turnId: 't2', text: 'again' }));
    applyVerseEvent('vs_1', ev(6, 'cancelled', { turnId: 't2' }));
    applyVerseEvent('vs_1', ev(7, 'turn-done', { turnId: 't2', ok: false, nativeSessionId: null, durationMs: 10 }));
    seedVerseSession('vs_1', session({ status: 'running' }), []);
    expect(getVerseSessionState('vs_1').session?.status).toBe('idle');

    // Pure form: a running snapshot with no events at all is left alone.
    expect(settledStatus(session({ status: 'running' }), []).status).toBe('running');
    expect(settledStatus(session({ status: 'idle' }), [ev(1, 'cancelled', { turnId: 'x' })]).status).toBe('idle');
  });

  it('returns a stable empty state for no selection', () => {
    expect(getVerseSessionState(null)).toBe(getVerseSessionState(null));
    expect(getVerseSessionState(null).events).toEqual([]);
  });
});

describe('groupTranscriptItems', () => {
  it('folds runs of tool/thinking items of one turn into a single group and leaves singles alone', () => {
    const t = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'thinking', { turnId: 't1', text: 'hmm' }),
      ev(3, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: { file_path: '/a' } }),
      ev(4, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'x', isError: false }),
      ev(5, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Read', input: { file_path: '/b' } }),
      ev(6, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'nope', isError: true }),
      ev(7, 'tool-use', { turnId: 't1', toolUseId: 'c', name: 'Edit', input: { file_path: '/b' } }),
      ev(8, 'assistant-message', { turnId: 't1', text: 'Done.' }),
      ev(9, 'tool-use', { turnId: 't1', toolUseId: 'd', name: 'Bash', input: { command: 'ls' } }),
      ev(10, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 5 }),
    ]);
    const grouped = groupTranscriptItems(t.items);
    expect(grouped.map((i) => i.kind)).toEqual(['user', 'toolGroup', 'assistant', 'tool', 'turn-done']);
    const group = grouped[1]!;
    if (group.kind !== 'toolGroup') throw new Error('expected a group');
    expect(group.items.map((i) => i.kind)).toEqual(['thinking', 'tool', 'tool', 'tool']);
    expect(group.toolCount).toBe(3);
    expect(group.summary).toBe('Read ×2, Edit');
    expect(group.errorCount).toBe(1);
    expect(group.pending).toBe(true);
    expect(group.turnId).toBe('t1');
  });

  it('does not merge tool runs from different turns', () => {
    const items = buildTranscript([
      ev(1, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: null }),
      ev(2, 'tool-use', { turnId: 't2', toolUseId: 'b', name: 'Read', input: null }),
    ]).items;
    expect(groupTranscriptItems(items).map((i) => i.kind)).toEqual(['tool', 'tool']);
  });
});

describe('formatTokens', () => {
  it('renders compact token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(123_456)).toBe('123k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(null)).toBe('—');
  });

  it('chooses the unit after rounding, so nothing prints as "1000k" or "1000"', () => {
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1M');
    expect(formatTokens(999_999)).toBe('1M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(999.4)).toBe('999');
    expect(formatTokens(999.6)).toBe('1k');
  });
});

// ---------------------------------------------------------------------------
// V3.9 — context readings and native compaction
// ---------------------------------------------------------------------------

const USAGE0 = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('verse store — V3.9 context events', () => {
  beforeEach(() => resetVerseStore());

  it('a `context` reading REPLACES occupancy and marks its window as runtime', () => {
    const codex = session({ engine: 'codex', seatId: 'codex-b', model: 'gpt-6-astra', usage: { ...session().usage, contextTokens: 900_000, contextWindow: 258_400, autoCompactAt: 244_800, contextTokensExact: false } });
    seedVerseSession('vs_1', codex, []);
    applyVerseEvent('vs_1', ev(1, 'context', { turnId: 't1', contextTokens: 136_000, contextWindow: 258_400, exact: true, autoCompactAt: 244_800 }));
    const usage = getVerseSessionState('vs_1').session!.usage;
    expect(usage.contextTokens).toBe(136_000);
    expect(usage.contextTokensExact).toBe(true);
    expect(usage.contextWindow).toBe(258_400);
    expect(usage.contextWindowSource).toBe('runtime');
    expect(usage.autoCompactAt).toBe(244_800);
    // Totals are untouched: a reading is not a usage delta.
    expect(usage.inputTokens).toBe(codex.usage.inputTokens);
  });

  it('keeps the provenance a `context` event states — a mode switch\'s catalog budget is not a CLI reading', () => {
    // The event setContextMode emits: turnId null, the new mode's CATALOG budget.
    const codex = session({ engine: 'codex', seatId: 'codex-b', model: 'gpt-6-astra', usage: { ...session().usage, contextWindow: 258_400, autoCompactAt: 244_800, contextWindowSource: 'provider-catalog' } });
    seedVerseSession('vs_1', codex, []);
    applyVerseEvent('vs_1', ev(1, 'context', { turnId: null, contextTokens: 0, contextWindow: 828_400, exact: true, autoCompactAt: 784_800, contextWindowSource: 'provider-catalog' }));
    const usage = getVerseSessionState('vs_1').session!.usage;
    expect(usage).toMatchObject({ contextWindow: 828_400, autoCompactAt: 784_800, contextWindowSource: 'provider-catalog' });
    // A value outside the known set is not stored; the pre-field default applies.
    const odd = applyContextReading(codex, ev(2, 'context', { turnId: 't1', contextTokens: 1, contextWindow: 258_400, exact: true, contextWindowSource: 'guess' as never }) as Extract<ReturnType<typeof ev>, { type: 'context' }>);
    expect(odd.contextWindowSource).toBe('runtime');
  });

  it('reconciles the compaction point when an older server sends a new window without one', () => {
    const s = session({ engine: 'codex', usage: { ...session().usage, contextWindow: 258_400, autoCompactAt: 244_800 } });
    const next = applyContextReading(s, ev(1, 'context', { turnId: 't1', contextTokens: 10, contextWindow: 828_400, exact: true }) as Extract<ReturnType<typeof ev>, { type: 'context' }>);
    expect(next.contextWindow).toBe(828_400);
    expect(next.autoCompactAt).toBe(784_800);
    // Same window, no point sent → the stored point stands.
    const same = applyContextReading(s, ev(2, 'context', { turnId: 't1', contextTokens: 10, contextWindow: 258_400, exact: true }) as Extract<ReturnType<typeof ev>, { type: 'context' }>);
    expect(same.autoCompactAt).toBe(244_800);
  });

  it('adopts a LOCAL window from a context event that names its source (the engine refreshed it before the turn)', () => {
    const local = session({ engine: 'local', seatId: 'local:qwen3-coder', model: 'qwen3-coder', usage: { ...session().usage, contextWindow: 262_144, autoCompactAt: 229_144, contextWindowSource: 'provider-catalog' } });
    seedVerseSession('vs_1', local, []);
    applyVerseEvent('vs_1', ev(1, 'context', { turnId: null, contextTokens: 30_000, contextWindow: 65_536, exact: true, autoCompactAt: 32_536, contextWindowSource: 'runtime' }));
    expect(getVerseSessionState('vs_1').session!.usage).toMatchObject({ contextWindow: 65_536, autoCompactAt: 32_536, contextWindowSource: 'runtime' });
  });

  it('never lets a reading move a LOCAL window: Verse sets that one itself', () => {
    const local = session({ engine: 'local', seatId: 'local:qwen3-coder', model: 'qwen3-coder', usage: { ...session().usage, contextWindow: 65_536, autoCompactAt: 32_536 } });
    seedVerseSession('vs_1', local, []);
    applyVerseEvent('vs_1', ev(1, 'context', { turnId: 't1', contextTokens: 30_000, contextWindow: 200_000, exact: true }));
    applyVerseEvent('vs_1', ev(2, 'usage', { turnId: 't1', usage: { ...USAGE0, contextTokens: 31_000, contextWindow: 200_000 } }));
    const usage = getVerseSessionState('vs_1').session!.usage;
    expect(usage.contextWindow).toBe(65_536);
    expect(usage.contextWindowSource).toBeUndefined();
    expect(usage.contextTokens).toBe(31_000);
  });

  it('adopts V3.9 fields from a usage frame only when the frame carries them', () => {
    const base = session();
    const old = applyUsageFrame(base, { ...USAGE0, contextTokens: 5, contextWindow: null });
    expect(Object.keys(old).sort()).toEqual(Object.keys(base.usage).sort());
    const rich = applyUsageFrame(base, { ...USAGE0, contextTokens: 400_000, contextWindow: 1_000_000, contextWindowSource: 'runtime', autoCompactAt: 367_000, contextTokensExact: true });
    expect(rich).toMatchObject({ contextTokens: 400_000, contextWindow: 1_000_000, contextWindowSource: 'runtime', autoCompactAt: 367_000 });
    // Exact is spelled by OMISSION (the server only ever writes `false`).
    expect(rich).not.toHaveProperty('contextTokensExact');
    // …so a resolved exact frame clears an earlier upper-bound "≤"…
    const bounded = { ...base, usage: { ...base.usage, contextTokensExact: false } };
    expect(applyUsageFrame(bounded, { ...USAGE0, contextTokens: 9, contextWindow: 258_400, contextWindowSource: 'runtime' })).not.toHaveProperty('contextTokensExact');
    // …while a pre-3.9 frame (no V3.9 fields at all) leaves it alone.
    expect(applyUsageFrame(bounded, { ...USAGE0, contextTokens: 9, contextWindow: null }).contextTokensExact).toBe(false);
    expect(applyUsageFrame(base, { ...USAGE0, contextTokens: 9, contextWindow: 258_400, contextWindowSource: 'runtime', contextTokensExact: false }).contextTokensExact).toBe(false);
    // A local seat accepts a window from a frame that SAYS where it came from (the engine's own record).
    const local = session({ engine: 'local', usage: { ...session().usage, contextWindow: 65_536 } });
    expect(applyUsageFrame(local, { ...USAGE0, contextTokens: 1, contextWindow: 32_768, contextWindowSource: 'provider-catalog' }).contextWindow).toBe(32_768);
  });

  it('counts `compaction` events like the server does and leaves occupancy to the next reading', () => {
    seedVerseSession('vs_1', session({ usage: { ...session().usage, contextTokens: 190_000 } }), []);
    applyVerseEvent('vs_1', ev(1, 'compaction', { turnId: 't1', trigger: 'auto', preTokens: 190_000, postTokens: 20_000, durationMs: 90_000 }));
    applyVerseEvent('vs_1', ev(2, 'compaction', { turnId: null, trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }));
    const s = getVerseSessionState('vs_1').session!;
    expect(s.compactionCount).toBe(2);
    expect(s.usage.contextTokens).toBe(190_000);
    // A replayed frame (fresh SSE connection) is dropped by seq, so it is not counted twice.
    expect(applyVerseEvent('vs_1', ev(1, 'compaction', { turnId: 't1', trigger: 'auto', preTokens: 190_000, postTokens: 20_000, durationMs: 90_000 }))).toBe(false);
    expect(getVerseSessionState('vs_1').session!.compactionCount).toBe(2);
  });

  it('puts a compaction divider in the transcript without splitting a streamed reply', () => {
    const t = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text: 'Work' }),
      ev(4, 'compaction', { turnId: 't1', trigger: 'auto', preTokens: 812_000, postTokens: 41_000, durationMs: 118_000 }),
      ev(5, 'text-delta', { turnId: 't1', text: 'ing' }),
      ev(6, 'assistant-message', { turnId: 't1', text: 'Working' }),
      ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 5 }),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'compaction', 'assistant', 'turn-done']);
    const divider = t.items[1]!;
    expect(divider.kind === 'compaction' && divider.preTokens).toBe(812_000);
    // Exactly one assistant item: the deltas were superseded, not duplicated.
    expect(t.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  });
});

describe('verse-events — V3.9 frames', () => {
  it('listens for the new event names', () => {
    expect(VERSE_EVENT_TYPES).toContain('compaction');
    expect(VERSE_EVENT_TYPES).toContain('context');
  });

  it('drops malformed context/compaction frames instead of feeding NaN to the meter', () => {
    const ok = { seq: 1, at: 'x', type: 'context', turnId: 't', contextTokens: 5, contextWindow: null, exact: true };
    expect(parseVerseEventFrame(JSON.stringify(ok))).not.toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ ...ok, contextTokens: 'lots' }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ ...ok, exact: 'yes' }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ ...ok, contextWindow: -1 }))).toBeNull();
    const compaction = { seq: 2, at: 'x', type: 'compaction', turnId: null, trigger: 'auto', preTokens: 1, postTokens: null, durationMs: null };
    expect(parseVerseEventFrame(JSON.stringify(compaction))).not.toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ ...compaction, trigger: 'sometimes' }))).toBeNull();
    // Older types keep the original seq/type-only check.
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, type: 'usage' }))).not.toBeNull();
    expect(parseVerseEventFrame('not json')).toBeNull();
  });
});

describe('lastTurnActivityAt', () => {
  it('is the newest provider round trip, ignoring a mode switch\'s turnless context event', () => {
    const at = (seq: number, iso: string, type: Parameters<typeof ev>[1], fields: Record<string, unknown>) => ({ ...ev(seq, type, fields as never), at: iso });
    expect(lastTurnActivityAt([])).toBeNull();
    const log = [
      at(1, '2026-09-23T09:00:00.000Z', 'user-message', { turnId: 't1', text: 'go' }),
      at(2, '2026-09-23T09:01:00.000Z', 'usage', { turnId: 't1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 5, contextWindow: null } }),
      at(3, '2026-09-23T09:02:00.000Z', 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 }),
      // A mode switch two hours later: no provider saw anything.
      at(4, '2026-09-23T11:00:00.000Z', 'context', { turnId: null, contextTokens: 5, contextWindow: 1_000_000, exact: true, autoCompactAt: 967_000 }),
    ];
    expect(lastTurnActivityAt(log)).toBe('2026-09-23T09:02:00.000Z');
    const withReading = [...log, at(5, '2026-09-23T11:30:00.000Z', 'context', { turnId: 't2', contextTokens: 6, contextWindow: 1_000_000, exact: true })];
    expect(lastTurnActivityAt(withReading)).toBe('2026-09-23T11:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// V3.10 data path
// ---------------------------------------------------------------------------

describe('verse store — V3.10 batched, incremental apply', () => {
  beforeEach(() => resetVerseStore());

  it('appends past the newest seq, inserts an older gap in place, drops duplicates — and notifies once per batch', () => {
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'hi' }), ev(4, 'turn-started', { turnId: 't1', pid: 1 })]);
    const listener = vi.fn();
    const off = subscribeVerseSession('vs_1', listener);
    const result = applyVerseEvents('vs_1', [
      ev(5, 'text-delta', { turnId: 't1', text: 'a' }),
      ev(2, 'thinking', { turnId: 't1', text: 'late but real' }),
      ev(4, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(6, 'text-delta', { turnId: 't1', text: 'b' }),
      ev(5, 'text-delta', { turnId: 't1', text: 'a' }),
    ]);
    expect(result).toEqual({ applied: 3, settled: false, liveChanged: false });
    expect(getVerseSessionState('vs_1').events.map((e) => e.seq)).toEqual([1, 2, 4, 5, 6]);
    expect(getVerseSessionState('vs_1').lastSeq).toBe(6);
    expect(listener).toHaveBeenCalledTimes(1);
    // A batch of nothing new is not a change.
    expect(applyVerseEvents('vs_1', [ev(6, 'text-delta', { turnId: 't1', text: 'b' })]).applied).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('reports a settled turn so the stream can refresh the lists exactly then', () => {
    seedVerseSession('vs_1', session(), []);
    expect(applyVerseEvents('vs_1', [ev(1, 'user-message', { turnId: 't1', text: 'go' })]).settled).toBe(false);
    expect(applyVerseEvents('vs_1', [ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 })]).settled).toBe(true);
  });

  it('keeps the HEAD stable across text-deltas, so nothing but the transcript re-renders per token', () => {
    seedVerseSession('vs_1', session({ status: 'running' }), [ev(1, 'user-message', { turnId: 't1', text: 'go' })]);
    const head = getVerseSessionHead('vs_1');
    applyVerseEvent('vs_1', ev(2, 'text-delta', { turnId: 't1', text: 'to' }));
    applyVerseEvent('vs_1', ev(3, 'text-delta', { turnId: 't1', text: 'ken' }));
    expect(getVerseSessionHead('vs_1')).toBe(head);
    const transcript = getVerseTranscript('vs_1');
    expect(transcript.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'token', streaming: false });
    // A structural event republishes it, with the full log.
    applyVerseEvent('vs_1', ev(4, 'tool-use', { turnId: 't1', toolUseId: 'x', name: 'Read', input: {} }));
    expect(getVerseSessionHead('vs_1')).not.toBe(head);
    expect(getVerseSessionHead('vs_1').events).toHaveLength(4);
  });

  it('notifies only the session that changed (plus the global channel)', () => {
    seedVerseSession('vs_1', session(), []);
    seedVerseSession('vs_2', session({ id: 'vs_2' }), []);
    const one = vi.fn();
    const two = vi.fn();
    const all = vi.fn();
    const offs = [subscribeVerseSession('vs_1', one), subscribeVerseSession('vs_2', two), subscribeVerseStore(all)];
    applyVerseEvent('vs_2', ev(1, 'user-message', { turnId: 't', text: 'x' }));
    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    for (const off of offs) off();
  });

  it('does nothing — no notify, same arrays — when a refetch brings nothing new', () => {
    const log = [ev(1, 'user-message', { turnId: 't1', text: 'hi' }), ev(2, 'assistant-message', { turnId: 't1', text: 'yo' })];
    seedVerseSession('vs_1', session(), log);
    const before = getVerseSessionState('vs_1');
    const listener = vi.fn();
    const off = subscribeVerseSession('vs_1', listener);
    seedVerseSession('vs_1', session(), log.map((e) => ({ ...e })));
    expect(listener).not.toHaveBeenCalled();
    expect(getVerseSessionState('vs_1')).toBe(before);
    off();
  });

  it('merges an out-of-order, duplicated detail into a sorted, unique log', () => {
    seedVerseSession('vs_1', session(), [ev(5, 'user-message', { turnId: 't2', text: 'b' })]);
    seedVerseSession('vs_1', session(), [
      ev(3, 'assistant-message', { turnId: 't1', text: 'x' }),
      ev(1, 'user-message', { turnId: 't1', text: 'a' }),
      ev(3, 'assistant-message', { turnId: 't1', text: 'dup' }),
      ev(6, 'assistant-message', { turnId: 't2', text: 'y' }),
    ]);
    const events = getVerseSessionState('vs_1').events;
    expect(events.map((e) => e.seq)).toEqual([1, 3, 5, 6]);
    expect((events[1] as Extract<VerseEvent, { type: 'assistant-message' }>).text).toBe('x');
  });

  it('forgetting a session tells lifecycle listeners (the stream registry closes its connection)', () => {
    const seen = vi.fn();
    const off = subscribeVerseStoreLifecycle(seen);
    seedVerseSession('vs_1', session(), []);
    forgetVerseSession('vs_1');
    resetVerseStore();
    expect(seen.mock.calls).toEqual([[{ kind: 'forget', sessionId: 'vs_1' }], [{ kind: 'reset' }]]);
    off();
  });
});

describe('verse store — V3.10 transient events', () => {
  beforeEach(() => resetVerseStore());

  function running() {
    seedVerseSession('vs_1', session({ status: 'running' }), [
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      { ...ev(2, 'turn-started', { turnId: 't1', pid: 1 }), at: '2026-09-20T09:00:00.000Z' },
    ]);
  }

  it('never enters the log or moves the cursor — its seq is the last PERSISTED one', () => {
    running();
    const listener = vi.fn();
    const off = subscribeVerseSession('vs_1', listener);
    expect(applyVerseEvent('vs_1', transient(2, { type: 'thinking-delta', turnId: 't1', text: 'Let me ' }))).toBe(true);
    expect(applyVerseEvent('vs_1', transient(2, { type: 'thinking-delta', turnId: 't1', text: 'check.' }))).toBe(true);
    const state = getVerseSessionState('vs_1');
    expect(state.events).toHaveLength(2);
    expect(state.lastSeq).toBe(2);
    expect(state.live.thinking).toMatchObject({ turnId: 't1', text: 'Let me check.', estimatedTokens: null });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it('seeds the live turn from a log opened mid-turn, timed from the turn\'s own stamp', () => {
    running();
    expect(getVerseLive('vs_1')).toMatchObject({ turnId: 't1', startedAt: Date.parse('2026-09-20T09:00:00.000Z') });
  });

  it('closes the streamed block when the persisted `thinking` lands, keeping what this tab measured', () => {
    running();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    applyVerseEvent('vs_1', transient(2, { type: 'thinking-delta', turnId: 't1', text: 'hmm' }));
    applyVerseEvent('vs_1', transient(2, { type: 'thinking-progress', turnId: 't1', estimatedTokens: 1800 }));
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 12_000);
    applyVerseEvent('vs_1', ev(3, 'thinking', { turnId: 't1', text: 'hmm, the pager is off by one' }));
    vi.restoreAllMocks();
    expect(getVerseLive('vs_1').thinking).toBeNull();
    const item = getVerseTranscript('vs_1').items.find((i) => i.kind === 'thinking');
    expect(item).toMatchObject({ kind: 'thinking', durationMs: 12_000, estimatedTokens: 1800, redacted: false });
  });

  it('prefers the duration the event states, and marks a redacted block', () => {
    running();
    applyVerseEvent('vs_1', { ...ev(3, 'thinking', { turnId: 't1', text: '' }), redacted: true, durationMs: 4000, kind: 'summary' } as VerseEvent);
    const item = getVerseTranscript('vs_1').items.find((i) => i.kind === 'thinking');
    expect(item).toMatchObject({ redacted: true, durationMs: 4000, estimatedTokens: null, thinkingKind: 'summary' });
  });

  it('tracks progress and a notice, clears the notice when output resumes, and ends with the turn', () => {
    running();
    applyVerseEvent('vs_1', transient(2, { type: 'progress', turnId: 't1', phase: 'tool', tool: 'Bash', elapsedMs: 14_000, tokPerSec: 38 }));
    applyVerseEvent('vs_1', transient(2, { type: 'status', turnId: 't1', kind: 'retry', message: 'API overloaded — attempt 2 of 10' }));
    let live = getVerseLive('vs_1');
    expect(live.progress).toMatchObject({ phase: 'tool', tool: 'Bash', elapsedMs: 14_000, tokPerSec: 38, outTokens: null });
    expect(live.notice).toMatchObject({ kind: 'retry', message: 'API overloaded — attempt 2 of 10' });
    // A progress tick is not output: the notice stays.
    applyVerseEvent('vs_1', transient(2, { type: 'progress', turnId: 't1', phase: 'waiting', elapsedMs: 15_000 }));
    expect(getVerseLive('vs_1').notice).not.toBeNull();
    applyVerseEvent('vs_1', ev(3, 'text-delta', { turnId: 't1', text: 'ok' }));
    expect(getVerseLive('vs_1').notice).toBeNull();
    applyVerseEvent('vs_1', ev(4, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 20_000 }));
    live = getVerseLive('vs_1');
    expect(live).toMatchObject({ turnId: null, progress: null, thinking: null, notice: null, settledTurnId: 't1' });
    // A late frame for the settled turn cannot bring the live line back.
    expect(applyVerseEvent('vs_1', transient(4, { type: 'progress', turnId: 't1', phase: 'writing', elapsedMs: 21_000 }))).toBe(false);
    expect(getVerseLive('vs_1').turnId).toBeNull();
  });

  it('a transient frame does not republish the head (the Chat section stays still)', () => {
    running();
    const head = getVerseSessionHead('vs_1');
    applyVerseEvent('vs_1', transient(2, { type: 'progress', turnId: 't1', phase: 'thinking', elapsedMs: 1000 }));
    expect(getVerseSessionHead('vs_1')).toBe(head);
  });
});

describe('buildTranscript — V3.10 segments', () => {
  it('matches the single-pass derivation item for item', () => {
    const log = realisticLog(600);
    // Leave the last turn open and streaming.
    const open = openLastTurn(log).events;
    for (const events of [log, open]) {
      const segmented = buildTranscript(events);
      const cached = buildTranscript(events, { cache: createTranscriptCache() });
      expect(cached.items).toEqual(segmented.items);
      expect(segmented.segments!.flatMap((s) => s.items)).toEqual(segmented.items);
      expect(segmented.segments!.length).toBe(events.filter((e) => e.type === 'user-message').length);
    }
    expect(buildTranscript(open).live).toBe(true);
    expect(buildTranscript(open).items.at(-1)).toMatchObject({ kind: 'assistant', streaming: true });
  });

  it('returns unchanged turns as the SAME objects on a cached rebuild', () => {
    const cache = createTranscriptCache();
    const log = realisticLog(200);
    const first = buildTranscript(log, { cache });
    const next = buildTranscript([...log, ev(10_000, 'user-message', { turnId: 'tx', text: 'more' }), ev(10_001, 'text-delta', { turnId: 'tx', text: 'a' })], { cache });
    for (let i = 0; i < first.segments!.length; i++) expect(next.segments![i]).toBe(first.segments![i]);
    expect(next.segments).toHaveLength(first.segments!.length + 1);
  });

  it('falls back to one pass when a result pairs with a call in an earlier turn (never silently different)', () => {
    const t = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'a' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'late', name: 'Bash', input: { command: 'sleep 9' } }),
      ev(3, 'user-message', { turnId: 't2', text: 'b' }),
      ev(4, 'tool-result', { turnId: 't1', toolUseId: 'late', output: 'done', isError: false }),
    ]);
    expect(t.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    expect(t.items[1]).toMatchObject({ kind: 'tool', result: { output: 'done', isError: false } });
  });

  it('carries the new persisted events and the error code into items', () => {
    const t = buildTranscript([
      ev(1, 'history-truncated', { turnId: null, droppedBefore: 900 }),
      ev(2, 'user-message', { turnId: 't1', text: 'a' }),
      ev(3, 'recovered', { turnId: 't1', how: 'handoff', message: 'Started a new Claude session from the handoff note.' }),
      { ...ev(4, 'error', { turnId: 't1', message: 'No conversation found' }), code: 'native-thread-missing' } as VerseEvent,
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['truncated', 'user', 'recovered', 'error']);
    expect(t.items[0]).toMatchObject({ droppedBefore: 900 });
    expect(t.items[2]).toMatchObject({ how: 'handoff' });
    expect(t.items[3]).toMatchObject({ code: 'native-thread-missing' });
  });
});

describe('groupTranscriptItems — V3.10 reasoning placement', () => {
  it('lifts the reasoning that ENDS a run out of the fold, and never folds reasoning alone', () => {
    const t = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: {} }),
      ev(3, 'thinking', { turnId: 't1', text: 'between calls' }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Read', input: {} }),
      ev(5, 'thinking', { turnId: 't1', text: 'what to answer' }),
      ev(6, 'assistant-message', { turnId: 't1', text: 'Done.' }),
      ev(7, 'user-message', { turnId: 't2', text: 'again' }),
      ev(8, 'thinking', { turnId: 't2', text: 'one' }),
      ev(9, 'thinking', { turnId: 't2', text: 'two' }),
    ]);
    const grouped = groupTranscriptItems(t.items);
    expect(grouped.map((i) => i.kind)).toEqual(['user', 'toolGroup', 'thinking', 'assistant', 'user', 'thinking', 'thinking']);
    const group = grouped[1]!;
    if (group.kind !== 'toolGroup') throw new Error('expected a group');
    expect(group.items.map((i) => i.kind)).toEqual(['tool', 'thinking', 'tool']);
    expect(grouped[2]).toMatchObject({ kind: 'thinking', text: 'what to answer' });
  });
});

describe('client data path — §1 targets (best of several runs)', () => {
  beforeEach(() => resetVerseStore());

  /** Replay = what opening a chat or resuming a stream costs: the log in, the transcript out. */
  function replay(events: VerseEvent[], mode: 'seed' | 'stream') {
    resetVerseStore();
    if (mode === 'seed') seedVerseSession('vs_bench', session({ id: 'vs_bench' }), events);
    else {
      seedVerseSession('vs_bench', session({ id: 'vs_bench' }), []);
      // A server that ignores `after` replays everything in one burst — one frame.
      applyVerseEvents('vs_bench', events);
    }
    getVerseTranscript('vs_bench');
  }

  it('replays 5k events in < 10 ms and 10k in < 25 ms (was 2.45 s / 17 s)', () => {
    const five = realisticLog(5000);
    const ten = realisticLog(10_000);
    const results = {
      seed5k: bestOf(7, () => replay(five, 'seed')),
      stream5k: bestOf(7, () => replay(five, 'stream')),
      seed10k: bestOf(7, () => replay(ten, 'seed')),
      stream10k: bestOf(7, () => replay(ten, 'stream')),
    };
    console.info('[verse-perf] replay ms', { events: [five.length, ten.length], turns: getVerseTranscript('vs_bench').segments?.length },
      Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(v.toFixed(2))])));
    expect(results.seed5k).toBeLessThan(10);
    expect(results.stream5k).toBeLessThan(10);
    expect(results.seed10k).toBeLessThan(25);
    expect(results.stream10k).toBeLessThan(25);
  });

  it('applies a streamed delta at 5k events — store + transcript — in well under 1 ms', () => {
    const { events: open, turnId } = openLastTurn(realisticLog(5000));
    seedVerseSession('vs_bench', session({ id: 'vs_bench', status: 'running' }), open);
    getVerseTranscript('vs_bench');
    let seq = open[open.length - 1]!.seq + 1;
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      applyVerseEvents('vs_bench', [ev(seq++, 'text-delta', { turnId, text: 'tok ' })]);
      getVerseTranscript('vs_bench');
      samples.push(performance.now() - t0);
    }
    console.info('[verse-perf] store+derive per delta at 5k, median ms', Number(median(samples).toFixed(3)));
    expect(median(samples)).toBeLessThan(1);
  });
});
