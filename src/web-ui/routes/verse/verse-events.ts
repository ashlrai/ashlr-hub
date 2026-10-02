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
 *     session-list and account-reading digests, which invalidate the corresponding
 *     cached projections. It subscribes only to these metadata topics so the
 *     server skips the dashboard snapshot and the other groups this console
 *     would only discard.
 *
 * Every URL carries the per-tab client proof as `?client=` — the same
 * construction data/client.ts's eventsUrl() uses, because EventSource cannot
 * send the proof as a header (see read-session.ts readSessionClientProof).
 */
import type { VerseEvent, VerseEventType } from '../../data/api-types.js';
import { getAuthSnapshot, getReadClientProof, subscribeAuth } from '../../data/auth-store.js';
import { isRemoteMobileMode } from '../../data/remote-mode.js';
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
  // V3.15 persisted (additive): injected / seat-reported sources.
  'source',
  // 3.15 persisted (Devin seats).
  'remote-status',
  'remote-pr',
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
    case 'source': {
      // Kept inline (not core/verse/trace isVerseSource): this file is on the
      // chat's first-paint path and must not pull the trace module in.
      const s = e.source as Record<string, unknown> | null | undefined;
      return !!s && typeof s === 'object' && typeof s.kind === 'string' && typeof s.ref === 'string' && s.ref.length > 0 &&
        typeof s.title === 'string' && typeof s.origin === 'string';
    }
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
