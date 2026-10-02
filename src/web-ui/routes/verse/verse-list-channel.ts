/** Shared authenticated metadata channel, independent of session frame parsing. */
import { getAuthSnapshot, getReadClientProof, subscribeAuth } from '../../data/auth-store.js';
import { isRemoteMobileMode } from '../../data/remote-mode.js';
import { invalidateVerseLists } from './verse-queries.js';

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Lightweight metadata groups; the paired gateway retains its existing session topic. */
export const VERSE_LIST_TOPICS = 'verse-sessions,verse-account-readings';
const accountReadingListeners = new Set<() => void>();
/** Reuse the existing list stream; subscribers share one connection with the sidebar. */
export function onVerseAccountReadingsChanged(listener: () => void): () => void {
  accountReadingListeners.add(listener);
  const release = openVerseListChannel();
  return () => { accountReadingListeners.delete(listener); release(); };
}

/**
 * The sidebar channel's URL. `topics` narrows the server to the metadata groups
 * this console listens to; `client` stays last, as in eventsUrl(). Without
 * `topics` the server sends every group — the historical request, which is
 * also what the refusal fallback below falls back to.
 */
export function verseListEventsUrl(withTopics = true): string {
  // The gateway accepts only the scoped topic and adds the Hub client proof
  // on its private hop. A phone must never construct or send that proof.
  if (isRemoteMobileMode()) return '/api/events?topics=verse-sessions';
  const topics = withTopics ? `topics=${VERSE_LIST_TOPICS}&` : '';
  return `/api/events?${topics}client=${encodeURIComponent(getReadClientProof())}`;
}

/**
 * Set once this page has PROVEN that the server refuses `?topics=`: a
 * connection with it failed before it ever opened, and the same channel
 * without it then opened. The read-session boundary on SSE paths used to
 * answer 401 to any parameter besides `client`, and a sidebar that never
 * updates is far worse than one that is sent (and discards) extra groups.
 * Page-lifetime only — the same rule session-stream.ts applies to `?after=`:
 * a server that gains support is used again after a reload.
 */
let topicsRefused = false;

/** Tests: forget a proven refusal. */
export function resetVerseListChannelCapabilities(): void {
  topicsRefused = false;
}

/**
 * Shared lightweight channel: session changes refresh the list; account
 * publications notify the visible seat scheduler without rebuilding bootstrap.
 */
let listReaders = 0;
let closeSharedListChannel: (() => void) | null = null;
/** Sidebar and resources share one authenticated stream, including reconnects. */
export function openVerseListChannel(): () => void {
  listReaders += 1;
  if (listReaders === 1) closeSharedListChannel = startVerseListChannel();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listReaders -= 1;
    if (listReaders === 0) { closeSharedListChannel?.(); closeSharedListChannel = null; }
  };
}

function startVerseListChannel(): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;
  /** This connection is the no-`topics` retry that tests whether `topics` was refused. */
  let probing = false;

  const connect = () => {
    if (disposed || source || typeof EventSource === 'undefined') return;
    if (getAuthSnapshot().phase !== 'authenticated') return;
    const withTopics = isRemoteMobileMode() || (!topicsRefused && !probing);
    const es = new EventSource(verseListEventsUrl(withTopics), { withCredentials: true });
    let opened = false;
    source = es;
    es.onopen = () => {
      if (disposed || source !== es || getAuthSnapshot().phase !== 'authenticated') return;
      opened = true;
      attempt = 0;
      if (probing) {
        topicsRefused = true;
        probing = false;
      }
    };
    es.addEventListener('verse-sessions', () => {
      if (!disposed && source === es && getAuthSnapshot().phase === 'authenticated') invalidateVerseLists();
    });
    es.addEventListener('verse-account-readings', (event) => {
      if (disposed || source !== es || getAuthSnapshot().phase !== 'authenticated') return;
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 ||
          !('changed' in value) || value.changed !== true) return;
        for (const listener of accountReadingListeners) listener();
      } catch { /* malformed invalidations are not account readings */ }
    });
    es.onerror = () => {
      if (disposed || source !== es) return;
      es.close();
      if (source === es) source = null;
      if (disposed || getAuthSnapshot().phase !== 'authenticated') return;
      if (!opened && withTopics && !isRemoteMobileMode()) {
        // Refused before it opened, with `topics`: find out at once whether
        // the parameter is what was refused (see topicsRefused). One probe,
        // no delay — a real outage fails the probe too and falls through to
        // the ordinary backoff below.
        probing = true;
        connect();
        return;
      }
      probing = false;
      timer = setTimeout(() => {
        timer = null;
        attempt += 1;
        connect();
      }, backoffMs(attempt));
    };
  };

  const unsubscribeAuth = subscribeAuth(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
    attempt = 0;
    if (getAuthSnapshot().phase === 'authenticated') connect();
  });
  connect();

  return () => {
    disposed = true;
    unsubscribeAuth();
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };
}
