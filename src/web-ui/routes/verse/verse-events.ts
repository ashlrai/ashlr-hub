/**
 * routes/verse/verse-events.ts — the Verse console's SSE vocabulary and its
 * sidebar channel, since scoped consoles never join data/sse.ts's global feed:
 *
 *   - VERSE_EVENT_TYPES + parseVerseEventFrame: every VerseEvent name a
 *     session stream can carry, and the frame validation both streams share.
 *     The per-session stream itself (resume by `?after=`, one store update
 *     per animation frame, ref-counted connections) lives in
 *     session-stream.ts (V3.10); the replay-from-zero opener that used to sit
 *     here had no callers left and was removed.
 *   - openVerseListChannel: one EventSource against /api/events for the
 *     `verse-sessions` list digest, which just invalidates the sidebar's
 *     cache keys. It subscribes with `?topics=verse-sessions` (V3.10) so the
 *     server skips the dashboard snapshot and the other groups this console
 *     would only discard.
 *
 * Every URL carries the per-tab client proof as `?client=` — the same
 * construction data/client.ts's eventsUrl() uses, because EventSource cannot
 * send the proof as a header (see read-session.ts readSessionClientProof).
 */
import type { VerseEvent, VerseEventType } from '../../data/api-types.js';
import { getAuthSnapshot, getReadClientProof } from '../../data/auth-store.js';
import { invalidateVerseLists } from './verse-queries.js';

/**
 * Every VerseEvent name the stream can carry. EventSource only dispatches
 * NAMED events to listeners registered by name, so a type missing here is
 * silently dropped — the check below turns a new union member into a compile
 * error in this file instead of a meter that never moves.
 */
const EVENT_TYPES = [
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
  // V3.9 — a server that predates them simply never sends these names.
  'compaction',
  'context',
  // V3.10 transient (SSE only, never replayed — see VERSE_TRANSIENT_EVENT_TYPES
  // in core/verse/types.ts). They carry the last PERSISTED seq, so a store that
  // dedupes by seq and does not know them yet simply drops them.
  'thinking-delta',
  'thinking-progress',
  'progress',
  'status',
  // V3.10 persisted.
  'recovered',
  'history-truncated',
] as const satisfies readonly VerseEventType[];

type UnlistedEventType = Exclude<VerseEventType, (typeof EVENT_TYPES)[number]>;
// Fails to compile when VerseEventType gains a member EVENT_TYPES does not list.
const EVENT_TYPES_EXHAUSTIVE: [UnlistedEventType] extends [never] ? true : never = true;
void EVENT_TYPES_EXHAUSTIVE;

export const VERSE_EVENT_TYPES: readonly VerseEventType[] = EVENT_TYPES;

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

const nullableCount = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * The two V3.9 frames feed arithmetic (the meter, the compaction count), so a
 * malformed one is dropped here rather than turning the meter into `NaN`.
 * Older event types keep the original seq/type-only check.
 */
function v39FieldsValid(e: Record<string, unknown>): boolean {
  if (e.type === 'context') {
    return typeof e.contextTokens === 'number' && Number.isFinite(e.contextTokens) && e.contextTokens >= 0 &&
      typeof e.exact === 'boolean' && nullableCount(e.contextWindow) &&
      (e.autoCompactAt === undefined || nullableCount(e.autoCompactAt));
  }
  if (e.type === 'compaction') {
    return (e.trigger === 'auto' || e.trigger === 'manual') &&
      nullableCount(e.preTokens) && nullableCount(e.postTokens) && nullableCount(e.durationMs);
  }
  return true;
}

const optionalCount = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * V3.10 frames that feed arithmetic or a live label (elapsed, tok/s, token
 * estimate) — same rule as v39FieldsValid: malformed → dropped, never NaN.
 */
function v310FieldsValid(e: Record<string, unknown>): boolean {
  switch (e.type) {
    case 'thinking-delta':
      return typeof e.text === 'string';
    case 'thinking-progress':
      return e.estimatedTokens !== undefined && optionalCount(e.estimatedTokens);
    case 'progress':
      return (e.phase === 'thinking' || e.phase === 'tool' || e.phase === 'writing' || e.phase === 'waiting') &&
        typeof e.elapsedMs === 'number' && Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0 &&
        (e.tool === undefined || typeof e.tool === 'string') &&
        optionalCount(e.outTokens) && optionalCount(e.tokPerSec);
    case 'status':
      return (e.kind === 'retry' || e.kind === 'preflight' || e.kind === 'watchdog') && typeof e.message === 'string';
    case 'history-truncated':
      return typeof e.droppedBefore === 'number' && Number.isFinite(e.droppedBefore);
    default:
      return true;
  }
}

/** Exported for tests: one SSE frame's data → a VerseEvent, or null when malformed. */
export function parseVerseEventFrame(raw: string): VerseEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<VerseEvent>;
    if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') return null;
    if (!v39FieldsValid(parsed as Record<string, unknown>)) return null;
    if (!v310FieldsValid(parsed as Record<string, unknown>)) return null;
    return parsed as VerseEvent;
  } catch {
    return null;
  }
}

/** The only /api/events group the Verse console listens to. */
export const VERSE_LIST_TOPICS = 'verse-sessions';

/**
 * The sidebar channel's URL. `topics` narrows the server to the one group
 * this console listens to; `client` stays last, as in eventsUrl(). Without
 * `topics` the server sends every group — the historical request, which is
 * also what the refusal fallback below falls back to.
 */
export function verseListEventsUrl(withTopics = true): string {
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
 * Sidebar digest channel: listens only for `verse-sessions` on /api/events
 * and refreshes the session list + bootstrap when it fires.
 */
export function openVerseListChannel(): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;
  /** This connection is the no-`topics` retry that tests whether `topics` was refused. */
  let probing = false;

  const connect = () => {
    if (disposed || typeof EventSource === 'undefined') return;
    if (getAuthSnapshot().phase !== 'authenticated') return;
    const withTopics = !topicsRefused && !probing;
    const es = new EventSource(verseListEventsUrl(withTopics), { withCredentials: true });
    let opened = false;
    source = es;
    es.onopen = () => {
      opened = true;
      attempt = 0;
      if (probing) {
        topicsRefused = true;
        probing = false;
      }
    };
    es.addEventListener('verse-sessions', () => invalidateVerseLists());
    es.onerror = () => {
      es.close();
      if (source === es) source = null;
      if (disposed || getAuthSnapshot().phase !== 'authenticated') return;
      if (!opened && withTopics) {
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

  connect();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };
}
