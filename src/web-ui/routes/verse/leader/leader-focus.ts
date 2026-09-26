/**
 * routes/verse/leader/leader-focus.ts — "take me to the Leader, ready to
 * type": the one hand-off from anywhere (⌘K, Command's Leader card, a
 * Needs-you question) to Mind's conversation panel.
 *
 *   requestLeaderFocus({ kind: 'composer' })   Mind, composer focused
 *   requestLeaderFocus({ kind: 'directive' })  Mind, "+ Add directive" open
 *   requestLeaderFocus({ kind: 'question', … }) Mind, that question's answer box open
 *
 * WHY A STORE, NOT A PARKED COMMAND: Mind and its panel are two lazy chunks;
 * a parked bus command expires in 4 s, a request here waits (up to
 * REQUEST_TTL_MS) until the panel mounts and takes it. Taking it clears it,
 * so a later visit to Mind never re-focuses on a stale ask.
 *
 * Framework-free, tiny: the palette handler, the drawer and Command import it.
 */
import { setVerseSection } from '../verse-ui-store.js';

export type LeaderFocusTarget =
  | { kind: 'composer' }
  | { kind: 'directive' }
  | {
      kind: 'question';
      /** The Needs-you item id or the server's question id. */
      questionId: string | null;
      memoId: string | null;
      index: number | null;
      /** The question's words (a fallback when the thread has no question message for it). */
      text: string | null;
    };

export type LeaderFocusRequest = LeaderFocusTarget & { seq: number; at: number };

export const REQUEST_TTL_MS = 20_000;

let current: LeaderFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Go to Mind and ask its Leader panel to focus `target`. */
export function requestLeaderFocus(target: LeaderFocusTarget): void {
  seq += 1;
  current = { ...target, seq, at: Date.now() };
  setVerseSection('mind');
  emit();
}

/**
 * The request as stored (useSyncExternalStore's snapshot: it changes only
 * when the store emits). Whether it is still live is `isLeaderFocusLive`.
 */
export function getLeaderFocus(): LeaderFocusRequest | null {
  return current;
}

export function isLeaderFocusLive(request: LeaderFocusRequest, now: number = Date.now()): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}

/** Clear the request `seq` (and only that one — a newer ask survives). */
export function takeLeaderFocus(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function subscribeLeaderFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hygiene. */
export function resetLeaderFocus(): void {
  current = null;
  emit();
}
