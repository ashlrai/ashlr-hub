/**
 * core/verse/transient-events.ts — V3.10 event types that are NEVER
 * persisted, emitted to live SSE listeners only. Wire rules (A5 server, A6
 * client):
 *  - a transient event carries `seq` = the session's LAST PERSISTED seq (the
 *    counter does not advance), so the stored log stays gap-free and a server
 *    restart can never reissue a seq a client already saw;
 *  - its SSE frame has NO `id:` line, so the browser's Last-Event-ID resume
 *    cursor only ever points at persisted events;
 *  - clients must not dedupe, store or resume by a transient event's seq.
 *
 * Browser-safe (plain Set) and dependency-free at runtime: the web chat's
 * first-paint store imports the guard from HERE, not from ./types.ts (which
 * re-exports both), so the rest of types.ts's runtime values stay out of the
 * chat first-paint JS.
 */
import type { VerseEvent, VerseEventType, VerseTransientEvent } from './types.js';

export const TRANSIENT_EVENT_TYPE_LIST = [
  'thinking-delta',
  'thinking-progress',
  'progress',
  'status',
] as const satisfies readonly VerseEventType[];

export const VERSE_TRANSIENT_EVENT_TYPES: ReadonlySet<VerseEventType> = new Set<VerseEventType>(TRANSIENT_EVENT_TYPE_LIST);

/** V3.10. Type guard over VERSE_TRANSIENT_EVENT_TYPES. */
export function isTransientVerseEvent(event: VerseEvent): event is VerseTransientEvent {
  return VERSE_TRANSIENT_EVENT_TYPES.has(event.type);
}
