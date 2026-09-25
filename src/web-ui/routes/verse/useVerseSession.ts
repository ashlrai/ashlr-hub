/**
 * routes/verse/useVerseSession.ts — the only React glue over verse-store /
 * session-stream (same split as data/hooks.ts over cache.ts + sse.ts).
 *
 * Three hooks, three snapshots, three render frequencies (V3.10):
 *
 *   useVerseSession(id)     the HEAD: session record, load/stream state and
 *                           the event log as of the last structural event.
 *                           Owns opening the chat. Does NOT change per
 *                           streamed token, so the Chat section, sidebar,
 *                           header and resources panel stop re-rendering at
 *                           token rate.
 *   useVerseTranscript(id)  the derived transcript — changes at most once per
 *                           animation frame while text streams. Lives in
 *                           useVerseTranscript.ts: the derivation it reads is
 *                           kept off the chat first-paint path.
 *   useVerseLive(id)        transient signals of the running turn
 *                           (reasoning, progress, retry/watchdog notices).
 *
 * Each subscribes to its own session only, so a stream feeding a lingering
 * chat in the background re-renders nothing that shows another one.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { openVerseSession } from './session-stream.js';
import {
  getVerseLive,
  getVerseSessionHead,
  subscribeVerseSession,
  type Transcript,
  type VerseLiveState,
  type VerseSessionHead,
} from './verse-store.js';

export interface VerseSessionView extends VerseSessionHead {
  /**
   * A transcript supplied WITH the view — only a hand-built view (a test, a
   * preview) carries one. The live app leaves it unset and the workspace
   * subscribes to the transcript itself (useVerseTranscript), which is what
   * keeps a streamed token from re-rendering everything that holds the view.
   */
  transcript?: Transcript;
}

const noop = () => () => {};

export function useSessionSubscription(sessionId: string | null) {
  return useCallback(
    (listener: () => void) => (sessionId ? subscribeVerseSession(sessionId, listener) : noop()),
    [sessionId],
  );
}

/**
 * @param reload bump to re-fetch the detail + reconnect for the same id
 *   (the transcript's Retry button).
 */
export function useVerseSession(sessionId: string | null, reload = 0): VerseSessionView {
  const subscribe = useSessionSubscription(sessionId);
  const head = useSyncExternalStore(
    subscribe,
    () => getVerseSessionHead(sessionId),
    () => getVerseSessionHead(sessionId),
  );

  // Only a BUMP of `reload` for the chat already open means Retry; the
  // counter itself is never reset by the host, so "reload > 0" would turn
  // every later selection into a full refetch.
  const lastOpened = useRef<{ sessionId: string | null; reload: number }>({ sessionId: null, reload });
  useEffect(() => {
    const previous = lastOpened.current;
    lastOpened.current = { sessionId, reload };
    if (!sessionId) return undefined;
    return openVerseSession(sessionId, { reload: previous.sessionId === sessionId && previous.reload !== reload });
  }, [sessionId, reload]);

  return head;
}

/** Live (never persisted) signals of the chat's running turn. */
export function useVerseLive(sessionId: string | null): VerseLiveState {
  const subscribe = useSessionSubscription(sessionId);
  return useSyncExternalStore(
    subscribe,
    () => getVerseLive(sessionId),
    () => getVerseLive(sessionId),
  );
}
