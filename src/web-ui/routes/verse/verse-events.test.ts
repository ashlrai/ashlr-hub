/**
 * verse-events.test.ts — the sidebar channel (`openVerseListChannel`) and the
 * shared frame parser.
 *
 * The channel subscribes with `?topics=verse-sessions` (V3.10) so the server
 * skips the dashboard groups this console discards. A server whose read-
 * session boundary refuses the extra SSE parameter (it used to 401 anything
 * besides `client`) must still get a working sidebar: that is detected once
 * per page and served without `topics`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { MockEventSource } from './fixtures.test-support.js';
import {
  openVerseListChannel,
  parseVerseEventFrame,
  resetVerseListChannelCapabilities,
  verseListEventsUrl,
} from './verse-events.js';
import * as queries from './verse-queries.js';

function listSources(): MockEventSource[] {
  return MockEventSource.instances.filter((i) => i.url.startsWith('/api/events?'));
}
function lastList(): MockEventSource {
  const all = listSources();
  const found = all[all.length - 1];
  if (!found) throw new Error('no /api/events source');
  return found;
}

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  resetVerseListChannelCapabilities();
  markCheckComplete(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verseListEventsUrl', () => {
  it('asks for the verse-sessions group only, with the client proof last', () => {
    expect(verseListEventsUrl()).toMatch(/^\/api\/events\?topics=verse-sessions&client=[a-f0-9]{64}$/);
  });
  it('without topics is the historical request', () => {
    expect(verseListEventsUrl(false)).toMatch(/^\/api\/events\?client=[a-f0-9]{64}$/);
  });
});

describe('openVerseListChannel', () => {
  it('subscribes with topics and invalidates the lists on verse-sessions', () => {
    const invalidate = vi.spyOn(queries, 'invalidateVerseLists').mockImplementation(() => undefined);
    const dispose = openVerseListChannel();
    const es = lastList();
    expect(es.url).toContain('topics=verse-sessions&');
    expect(es.withCredentials).toBe(true);
    es.emitOpen();
    es.emitNamed('verse-sessions', { sessions: [] });
    expect(invalidate).toHaveBeenCalledTimes(1);
    dispose();
    expect(es.closed).toBe(true);
  });

  it('a refusal before open probes once without topics; an open probe sticks for the page', () => {
    vi.useFakeTimers();
    const dispose = openVerseListChannel();
    const refused = lastList();
    refused.onerror?.();
    expect(refused.closed).toBe(true);
    // Probe is immediate — no backoff wait for a sidebar that could work now.
    const probe = lastList();
    expect(probe).not.toBe(refused);
    expect(probe.url).not.toContain('topics=');
    probe.emitOpen();
    dispose();

    // A later channel on the same page goes straight to the working form.
    const dispose2 = openVerseListChannel();
    expect(lastList().url).not.toContain('topics=');
    dispose2();
  });

  it('a failing probe is an outage, not a refusal: backoff, then topics again', () => {
    vi.useFakeTimers();
    const dispose = openVerseListChannel();
    lastList().onerror?.();
    const probe = lastList();
    expect(probe.url).not.toContain('topics=');
    probe.onerror?.();
    expect(listSources()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(listSources()).toHaveLength(3);
    expect(lastList().url).toContain('topics=verse-sessions&');
    dispose();
  });

  it('a drop after a successful open is retried with backoff, keeping topics', () => {
    vi.useFakeTimers();
    const dispose = openVerseListChannel();
    const es = lastList();
    es.emitOpen();
    es.onerror?.();
    expect(listSources()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(listSources()).toHaveLength(2);
    expect(lastList().url).toContain('topics=verse-sessions&');
    dispose();
  });

  it('does not reconnect once the read session is gone', () => {
    vi.useFakeTimers();
    const dispose = openVerseListChannel();
    markCheckComplete(false);
    lastList().onerror?.();
    vi.advanceTimersByTime(60_000);
    expect(listSources()).toHaveLength(1);
    dispose();
  });
});

describe('parseVerseEventFrame — V3.10 frames', () => {
  const at = '2026-09-23T20:00:00.000Z';
  it('keeps well-formed transient and persisted frames', () => {
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'thinking-delta', turnId: 't1', text: 'hm' }))).not.toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'progress', turnId: 't1', phase: 'tool', tool: 'npm test', elapsedMs: 1200 }))).not.toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 4, at, type: 'recovered', turnId: null, how: 'handoff', message: 'x' }))).not.toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 1, at, type: 'history-truncated', turnId: null, droppedBefore: 900 }))).not.toBeNull();
  });
  it('drops frames whose numbers would turn a live label into NaN', () => {
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'progress', turnId: 't1', phase: 'tool', elapsedMs: 'soon' }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'progress', turnId: 't1', phase: 'dreaming', elapsedMs: 1 }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'thinking-progress', turnId: 't1' }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 3, at, type: 'status', turnId: null, kind: 'panic', message: 'x' }))).toBeNull();
    expect(parseVerseEventFrame(JSON.stringify({ seq: 1, at, type: 'history-truncated', turnId: null, droppedBefore: null }))).toBeNull();
    expect(parseVerseEventFrame('not json')).toBeNull();
  });
});
