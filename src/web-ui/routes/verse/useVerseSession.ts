/**
 * routes/verse/useVerseSession.ts — the only React glue over verse-store /
 * verse-events (same split as data/hooks.ts over cache.ts + sse.ts).
 *
 * Selecting a session: fetch its detail (session record + full event log),
 * seed the store, then hold a live EventSource open until the selection
 * changes or the component unmounts. The store keeps the events after the
 * stream closes, so switching back is instant while the refetch + reconnect
 * catch up in the background.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { openVerseSessionStream } from './verse-events.js';
import { fetchVerseSessionDetail } from './verse-queries.js';
import {
  buildTranscript,
  getVerseSessionState,
  seedVerseSession,
  setVerseLoadError,
  subscribeVerseStore,
  type Transcript,
  type VerseSessionState,
} from './verse-store.js';

export interface VerseSessionView extends VerseSessionState {
  transcript: Transcript;
}

/**
 * @param reload bump to re-fetch the detail + reconnect for the same id
 *   (the transcript's Retry button).
 */
export function useVerseSession(sessionId: string | null, reload = 0): VerseSessionView {
  const state = useSyncExternalStore(
    subscribeVerseStore,
    () => getVerseSessionState(sessionId),
    () => getVerseSessionState(sessionId),
  );

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void fetchVerseSessionDetail(sessionId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) seedVerseSession(sessionId, detail.session, detail.events);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setVerseLoadError(sessionId, err instanceof Error ? err.message : 'Could not load this chat.');
      });
    const close = openVerseSessionStream(sessionId);
    return () => {
      controller.abort();
      close();
    };
  }, [sessionId, reload]);

  const transcript = useMemo(() => buildTranscript(state.events), [state.events]);
  return useMemo(() => ({ ...state, transcript }), [state, transcript]);
}
