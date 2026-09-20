import { beforeEach, describe, expect, it } from 'vitest';
import { ev, session } from './fixtures.test-support.js';
import {
  applyVerseEvent,
  buildTranscript,
  formatTokens,
  getVerseSessionState,
  groupTranscriptItems,
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
});
