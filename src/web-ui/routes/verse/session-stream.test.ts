import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { ev, MockEventSource, session, verseFetch } from './fixtures.test-support.js';
import {
  acquireVerseSessionStream,
  closeAllVerseSessionStreams,
  IDLE_CLOSE_MS,
  openVerseSession,
  resetVerseStreamCapabilities,
  setVerseFrameScheduler,
  verseSessionStreamUrl,
  verseStreamRegistrySnapshot,
} from './session-stream.js';
import * as queries from './verse-queries.js';
import {
  getVerseLive,
  getVerseSessionState,
  resetVerseStore,
  seedVerseSession,
  subscribeVerseSession,
} from './verse-store.js';

/** A frame scheduler the test drives by hand: `frame()` runs what is queued. */
function manualFrames() {
  const pending: Array<() => void> = [];
  setVerseFrameScheduler((flush) => {
    pending.push(flush);
    return () => {
      const at = pending.indexOf(flush);
      if (at !== -1) pending.splice(at, 1);
    };
  });
  return {
    frame() {
      for (const flush of pending.splice(0)) flush();
    },
    get queued() {
      return pending.length;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  closeAllVerseSessionStreams();
  resetVerseStreamCapabilities();
  setVerseFrameScheduler(null);
  markCheckComplete(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verseSessionStreamUrl', () => {
  it('resumes after the cursor and keeps the client proof last', () => {
    expect(verseSessionStreamUrl('vs_1', 42)).toMatch(/^\/api\/verse\/sessions\/vs_1\/events\?after=42&client=[a-f0-9]{64}$/);
  });

  it('omits the cursor when there is nothing to resume past (seqs start at 1)', () => {
    expect(verseSessionStreamUrl('vs_1', 0)).toMatch(/^\/api\/verse\/sessions\/vs_1\/events\?client=[a-f0-9]{64}$/);
    expect(verseSessionStreamUrl('vs_1', Number.NaN)).not.toContain('after=');
  });
});

describe('openVerseSession — one load, then a resumed stream', () => {
  it('fetches the detail once, seeds the store, and only then streams from the seeded cursor', async () => {
    const { fetch, state } = verseFetch();
    state.details.vs_1 = {
      session: session(),
      events: [ev(1, 'user-message', { turnId: 't1', text: 'hi' }), ev(2, 'assistant-message', { turnId: 't1', text: 'yo' })],
    };
    vi.stubGlobal('fetch', fetch);

    const close = openVerseSession('vs_1');
    // No stream until the detail landed: the two can no longer race.
    expect(MockEventSource.instances).toHaveLength(0);
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(getVerseSessionState('vs_1').events.map((e) => e.seq)).toEqual([1, 2]);
    expect(MockEventSource.instances[0]!.url).toContain('/events?after=2&client=');
    expect(state.calls.filter((c) => c.path === '/api/verse/sessions/vs_1')).toHaveLength(1);
    close();
  });

  it('re-attaches from the cursor without refetching when the chat is already loaded', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'hi' })]);
    const close = openVerseSession('vs_1');
    expect(fetch).not.toHaveBeenCalled();
    expect(MockEventSource.forSession('vs_1').url).toContain('after=1&');
    close();
  });

  it('reports a failed load and opens no stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })));
    const close = openVerseSession('vs_1');
    await vi.waitFor(() => expect(getVerseSessionState('vs_1').loadError).not.toBeNull());
    expect(MockEventSource.instances).toHaveLength(0);
    close();
  });

  it('reload refetches the detail and reconnects even when loaded', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'hi' })]);
    const first = openVerseSession('vs_1');
    first();
    const second = openVerseSession('vs_1', { reload: true });
    await vi.waitFor(() => expect(state.calls.some((c) => c.path === '/api/verse/sessions/vs_1')).toBe(true));
    second();
  });
});

describe('frame batching', () => {
  it('applies every frame that arrives within one animation frame with ONE store update', () => {
    const frames = manualFrames();
    seedVerseSession('vs_1', session({ status: 'running' }), [ev(1, 'user-message', { turnId: 't1', text: 'go' })]);
    const release = acquireVerseSessionStream('vs_1');
    const stream = MockEventSource.forSession('vs_1');
    const notified = vi.fn();
    const unsubscribe = subscribeVerseSession('vs_1', notified);

    stream.emit(ev(2, 'turn-started', { turnId: 't1', pid: 1 }));
    for (let i = 0; i < 50; i++) stream.emit(ev(3 + i, 'text-delta', { turnId: 't1', text: 'x' }));
    stream.emit({ seq: 52, at: '2026-09-19T10:00:00.000Z', type: 'thinking-delta', turnId: 't1', text: 'hmm' });
    // Nothing applied yet: the frame has not run.
    expect(getVerseSessionState('vs_1').events).toHaveLength(1);
    expect(notified).not.toHaveBeenCalled();
    expect(frames.queued).toBe(1);

    frames.frame();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(getVerseSessionState('vs_1').events).toHaveLength(52);
    // The transient frame reached the live state and did not enter the log.
    expect(getVerseLive('vs_1').thinking?.text).toBe('hmm');
    expect(getVerseSessionState('vs_1').lastSeq).toBe(52);
    unsubscribe();
    release();
  });

  it('invalidates the chat lists only when a batch really settled a turn — never for a replayed duplicate', () => {
    const frames = manualFrames();
    const invalidate = vi.spyOn(queries, 'invalidateVerseLists').mockImplementation(() => {});
    seedVerseSession('vs_1', session(), [
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 5 }),
    ]);
    const release = acquireVerseSessionStream('vs_1');
    const stream = MockEventSource.forSession('vs_1');
    // A server without `after` support replays the settled turn: a duplicate.
    stream.emit(ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 5 }));
    frames.frame();
    expect(invalidate).not.toHaveBeenCalled();

    stream.emit(ev(3, 'user-message', { turnId: 't2', text: 'again' }));
    stream.emit(ev(4, 'turn-done', { turnId: 't2', ok: true, nativeSessionId: null, durationMs: 5 }));
    frames.frame();
    expect(invalidate).toHaveBeenCalledTimes(1);
    release();
  });

  it('reconnects after a drop from the cursor it has reached, flushing what already arrived', () => {
    vi.useFakeTimers();
    manualFrames();
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'go' })]);
    const release = acquireVerseSessionStream('vs_1');
    const stream = MockEventSource.forSession('vs_1');
    stream.emitOpen();
    stream.emit(ev(2, 'turn-started', { turnId: 't1', pid: 1 }));
    stream.emit(ev(3, 'text-delta', { turnId: 't1', text: 'partial' }));
    stream.onerror?.();
    expect(getVerseSessionState('vs_1').lastSeq).toBe(3);
    expect(getVerseSessionState('vs_1').stream).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    const next = MockEventSource.forSession('vs_1');
    expect(next).not.toBe(stream);
    expect(next.url).toContain('after=3&');
    release();
  });
});

describe('ref-counted streams', () => {
  it('shares one connection, lingers after the last release, and closes after the idle window', () => {
    vi.useFakeTimers();
    seedVerseSession('vs_1', session(), []);
    const a = acquireVerseSessionStream('vs_1');
    const b = acquireVerseSessionStream('vs_1');
    expect(MockEventSource.instances).toHaveLength(1);
    a();
    b();
    // Switching sections and back must not replay: the stream is still open.
    const stream = MockEventSource.instances[0]!;
    expect(stream.closed).toBe(false);
    const again = acquireVerseSessionStream('vs_1');
    expect(MockEventSource.instances).toHaveLength(1);
    again();
    vi.advanceTimersByTime(IDLE_CLOSE_MS + 1);
    expect(stream.closed).toBe(true);
    expect(getVerseSessionState('vs_1').stream).toBe('closed');
    expect(verseStreamRegistrySnapshot()).toEqual([]);
  });

  it('keeps at most one lingering stream: the older idle one closes when another is released', () => {
    vi.useFakeTimers();
    seedVerseSession('vs_1', session(), []);
    seedVerseSession('vs_2', session({ id: 'vs_2' }), []);
    const one = acquireVerseSessionStream('vs_1');
    const two = acquireVerseSessionStream('vs_2');
    one();
    vi.advanceTimersByTime(10);
    two();
    expect(MockEventSource.forSession('vs_2').closed).toBe(false);
    expect(MockEventSource.instances.find((i) => i.url.includes('/vs_1/'))!.closed).toBe(true);
  });

  it('closes every stream when the store is reset (logout, test hygiene)', () => {
    seedVerseSession('vs_1', session(), []);
    acquireVerseSessionStream('vs_1');
    resetVerseStore();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    expect(verseStreamRegistrySnapshot()).toEqual([]);
  });
});

describe('resume against the server that is actually there', () => {
  it('leaves a dropped connection to the browser, which resumes by Last-Event-ID', () => {
    seedVerseSession('vs_1', session(), [ev(1, 'user-message', { turnId: 't1', text: 'go' })]);
    const release = acquireVerseSessionStream('vs_1');
    const stream = MockEventSource.forSession('vs_1') as MockEventSource & { readyState?: number };
    stream.emitOpen();
    stream.readyState = 0; // EventSource.CONNECTING: the browser is already retrying
    stream.onerror?.();
    expect(stream.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(getVerseSessionState('vs_1').stream).toBe('reconnecting');
    release();
  });

  it('detects a server that refuses `?after=` (401 before open) and serves the chat without it', () => {
    vi.useFakeTimers();
    seedVerseSession('vs_1', session(), [ev(7, 'user-message', { turnId: 't1', text: 'go' })]);
    const release = acquireVerseSessionStream('vs_1');
    const refused = MockEventSource.forSession('vs_1');
    expect(refused.url).toContain('after=7&');
    refused.onerror?.();
    // Retried at once without the cursor — no backoff wait for a chat that cannot connect.
    const probe = MockEventSource.forSession('vs_1');
    expect(probe).not.toBe(refused);
    expect(probe.url).not.toContain('after=');
    probe.emitOpen();
    expect(getVerseSessionState('vs_1').stream).toBe('open');
    // Proven: later connections on this page skip the cursor.
    probe.onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.forSession('vs_1').url).not.toContain('after=');
    release();
  });

  it('keeps using the cursor when the retry without it fails too (the server was just down)', () => {
    vi.useFakeTimers();
    seedVerseSession('vs_1', session(), [ev(7, 'user-message', { turnId: 't1', text: 'go' })]);
    const release = acquireVerseSessionStream('vs_1');
    MockEventSource.forSession('vs_1').onerror?.();
    MockEventSource.forSession('vs_1').onerror?.();
    const before = MockEventSource.instances.length;
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances.length).toBe(before + 1);
    expect(MockEventSource.forSession('vs_1').url).toContain('after=7&');
    release();
  });
});
