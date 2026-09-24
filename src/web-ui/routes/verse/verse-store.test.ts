import { beforeEach, describe, expect, it } from 'vitest';
import { ev, session } from './fixtures.test-support.js';
import { parseVerseEventFrame, VERSE_EVENT_TYPES } from './verse-events.js';
import {
  applyContextReading,
  applyUsageFrame,
  applyVerseEvent,
  buildTranscript,
  formatTokens,
  getVerseSessionState,
  groupTranscriptItems,
  lastTurnActivityAt,
  resetVerseStore,
  seedVerseSession,
  setVerseSession,
  settledStatus,
} from './verse-store.js';

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
