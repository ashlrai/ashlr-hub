/**
 * routes/verse/verse-events.ts — the two live channels the Verse console
 * owns, since scoped consoles never join data/sse.ts's global feed:
 *
 *   1. One EventSource per OPEN session against
 *      GET /api/verse/sessions/:id/events. Event name = VerseEvent.type,
 *      id = seq (so the browser's own Last-Event-ID reconnect resumes where
 *      it left off); each frame is applied to verse-store, which drops
 *      anything already seen by seq — a fresh connection replays from the
 *      start, exactly like src/core/web/run-stream.ts.
 *   2. One EventSource against /api/events for the `verse-sessions` list
 *      digest, which just invalidates the sidebar's cache keys.
 *
 * Both carry the per-tab client proof as `?client=` — the same construction
 * data/client.ts's eventsUrl() uses, because EventSource cannot send the
 * proof as a header (see server.ts readSessionClientProof).
 */
import type { VerseEvent, VerseEventType } from '../../data/api-types.js';
import { getAuthSnapshot, getReadClientProof } from '../../data/auth-store.js';
import { eventsUrl } from '../../data/client.js';
import { applyVerseEvent, setVerseStreamState } from './verse-store.js';
import { invalidateVerseLists, verseSessionPath } from './verse-queries.js';

export const VERSE_EVENT_TYPES: readonly VerseEventType[] = [
  'user-message',
  'turn-started',
  'text-delta',
  'assistant-message',
  'thinking',
  'tool-use',
  'tool-result',
  'usage',
  'turn-done',
  'error',
  'cancelled',
];

/** Per-session stream URL, carrying the client proof the way eventsUrl() does. */
export function verseSessionEventsUrl(sessionId: string): string {
  return `${verseSessionPath(sessionId, '/events')}?client=${encodeURIComponent(getReadClientProof())}`;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

function parseEvent(raw: string): VerseEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<VerseEvent>;
    if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') return null;
    return parsed as VerseEvent;
  } catch {
    return null;
  }
}

/**
 * Open the live stream for one session. Returns a disposer; reconnects with
 * backoff on error while the session is still open and the read session is
 * still authenticated.
 */
export function openVerseSessionStream(sessionId: string): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  const connect = () => {
    if (disposed || typeof EventSource === 'undefined') return;
    if (getAuthSnapshot().phase !== 'authenticated') return;
    setVerseStreamState(sessionId, attempt === 0 ? 'connecting' : 'reconnecting');
    const es = new EventSource(verseSessionEventsUrl(sessionId), { withCredentials: true });
    source = es;
    es.onopen = () => {
      attempt = 0;
      setVerseStreamState(sessionId, 'open');
    };
    for (const type of VERSE_EVENT_TYPES) {
      es.addEventListener(type, (evt) => {
        const event = parseEvent((evt as MessageEvent<string>).data);
        if (!event) return;
        applyVerseEvent(sessionId, event);
        if (event.type === 'turn-done' || event.type === 'cancelled' || event.type === 'error') invalidateVerseLists();
      });
    }
    es.onerror = (evt) => {
      // A server-sent event NAMED `error` (a VerseEvent.type) also dispatches
      // through onerror because onerror is the handler for event type "error".
      // It arrives as a MessageEvent with data; a real transport failure does
      // not. Without this guard every vendor error replayed on reconnect would
      // tear the stream down again, forever.
      if (typeof MessageEvent !== 'undefined' && evt instanceof MessageEvent) return;
      es.close();
      if (source === es) source = null;
      if (disposed) return;
      setVerseStreamState(sessionId, 'reconnecting');
      if (getAuthSnapshot().phase !== 'authenticated') return;
      timer = setTimeout(() => {
        timer = null;
        attempt += 1;
        connect();
      }, backoffMs(attempt));
    };
  };

  connect();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
    setVerseStreamState(sessionId, 'closed');
  };
}

/**
 * Sidebar digest channel: listens only for `verse-sessions` on /api/events
 * and refreshes the session list + bootstrap when it fires.
 */
export function openVerseListChannel(): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  const connect = () => {
    if (disposed || typeof EventSource === 'undefined') return;
    if (getAuthSnapshot().phase !== 'authenticated') return;
    const es = new EventSource(eventsUrl(), { withCredentials: true });
    source = es;
    es.onopen = () => {
      attempt = 0;
    };
    es.addEventListener('verse-sessions', () => invalidateVerseLists());
    es.onerror = () => {
      es.close();
      if (source === es) source = null;
      if (disposed || getAuthSnapshot().phase !== 'authenticated') return;
      timer = setTimeout(() => {
        timer = null;
        attempt += 1;
        connect();
      }, backoffMs(attempt));
    };
  };

  connect();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };
}
