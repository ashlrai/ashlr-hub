/**
 * routes/verse/useVerseTranscript.ts — the React glue over the derived
 * transcript (verse-transcript.ts).
 *
 * Not in useVerseSession.ts because that module is on the chat first-paint
 * path (the Chat section opens the chat through it) while the transcript is
 * rendered only by lazy chunks (the workspace, the dock). Importing the
 * derivation from there would put it back in the first-paint critical JS.
 */
import { useSyncExternalStore } from 'react';
import { useSessionSubscription } from './useVerseSession.js';
import { getVerseTranscript, type Transcript } from './verse-transcript.js';

/** The transcript of one chat, rebuilt only for the turn that changed. */
export function useVerseTranscript(sessionId: string | null): Transcript {
  const subscribe = useSessionSubscription(sessionId);
  return useSyncExternalStore(
    subscribe,
    () => getVerseTranscript(sessionId),
    () => getVerseTranscript(sessionId),
  );
}
