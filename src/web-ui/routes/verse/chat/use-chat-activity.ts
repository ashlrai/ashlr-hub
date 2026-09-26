/**
 * routes/verse/chat/use-chat-activity.ts — the Chat surface's view of C1's
 * activity + session-meta routes (unit C2).
 *
 * WHY NOT C1's useActivity: that hook runs the shell's CURSOR loop (it owns
 * completions, the rail badges and the native "Finished:" notifications).
 * The chat list needs only the present tense — who is running, what they are
 * doing, what needs the operator — so it reads the same route without a
 * cursor, through the shared query cache under VERSE_ACTIVITY_KEY. Any other
 * reader of that key (the rail, a future pane) shares the one request.
 *
 * Polls every 5 s ONLY while the Chat surface and the window are visible
 * (C0's usePollWhileVisible), and catches up the moment it is shown again.
 * Activity answers in < 5 ms from memory (SPEC-310C budget), so this is
 * cheap; it is still never faster than the 2 s floor.
 *
 * Also owns this tab's "seen" map: opening a chat clears its unread dot NOW,
 * whether or not the server-side POST can run (it needs a held token).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { markVerseSessionSeen, verseActivityQuery, verseSessionMetaQuery } from '../verse-queries.js';

export const CHAT_ACTIVITY_POLL_MS = 5_000;

// ---- local seen map --------------------------------------------------------

let seen = new Map<string, number>();
const seenListeners = new Set<() => void>();

function subscribeSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => seenListeners.delete(listener);
}

function getSeen(): ReadonlyMap<string, number> {
  return seen;
}

/** Record that the operator saw `sessionId` up to `turnCount`, locally and (best-effort) on the server. */
export function noteSessionSeen(sessionId: string, turnCount: number): void {
  if ((seen.get(sessionId) ?? -1) >= turnCount) return;
  seen = new Map(seen).set(sessionId, turnCount);
  for (const listener of [...seenListeners]) listener();
  void markVerseSessionSeen(sessionId, turnCount);
}

/** Test seam. */
export function resetLocalSeen(): void {
  seen = new Map();
  for (const listener of [...seenListeners]) listener();
}

export function useLocalSeen(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribeSeen, getSeen, getSeen);
}

// ---- queries ---------------------------------------------------------------

export function useChatActivity() {
  const activity = useQuery(verseActivityQuery, { freshMs: CHAT_ACTIVITY_POLL_MS - 500 });
  const meta = useQuery(verseSessionMetaQuery);
  const refetchActivity = useRefetch(verseActivityQuery);
  const tick = useCallback(() => refetchActivity(), [refetchActivity]);
  usePollWhileVisible(tick, CHAT_ACTIVITY_POLL_MS);
  const localSeen = useLocalSeen();
  return {
    /** null = the route is not mounted on this server (or has not answered yet). */
    activity: activity.data ?? null,
    meta: meta.data ?? null,
    /**
     * Why session-meta could not be read (the route's own sentence, e.g. the
     * chat engine is not answering), or null. A 404 is not an error here — it
     * reads as `meta: null` ("not on this server").
     */
    metaError: meta.status === 'error' ? readFailureReason(meta.error) : null,
    localSeen,
  };
}
