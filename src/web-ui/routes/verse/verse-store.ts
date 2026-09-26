/**
 * routes/verse/verse-store.ts — per-session transcript state for the Verse
 * console. Framework-free (useSyncExternalStore glue lives in
 * useVerseSession.ts, the live stream in session-stream.ts), same split as
 * data/cache.ts + data/hooks.ts.
 *
 * One entry per session id holds the ordered, seq-deduplicated event log,
 * the latest session record we know of, the stream connection state, and —
 * V3.10 — the LIVE state of a running turn (reasoning streaming in, what the
 * turn is doing, retry/watchdog notices), which is fed by transient events
 * that are never persisted and never enter the event log.
 * Snapshots are replaced wholesale on every change (Object.is semantics —
 * see DESIGN.md §3 for the bug that rule prevents).
 *
 * V3.10 DATA PATH. The previous store merged every event with a Map + spread
 * + sort and told every subscriber about it: replaying 5k events took 2.45 s
 * and 10k took 17 s, and every streamed token re-rendered the whole Chat
 * section. Now:
 *
 *   - `applyVerseEvents` applies a BATCH: an event past the newest seq is a
 *     plain append (one array copy per batch, not per event), an older one
 *     is binary-searched (duplicate → dropped, gap → inserted in place);
 *   - subscribers are per session (`subscribeVerseSession`) and read one of
 *     three snapshots that change independently:
 *       · the HEAD (`getVerseSessionHead`) — session record, stream state
 *         and the event log as of the last STRUCTURAL event. A text-delta
 *         alone does not republish it, so the sidebar, header and resources
 *         panel do not re-render per token;
 *       · the TRANSCRIPT (`getVerseTranscript`, verse-transcript.ts) —
 *         derived lazily, per turn segment, with unchanged turns returned as
 *         the same objects so the renderer can skip them;
 *       · the LIVE state (`getVerseLive`) — transient signals only.
 *   - the stream (session-stream.ts) calls `applyVerseEvents` once per
 *     animation frame, so a burst of frames costs one render.
 *
 * The transcript derivation (`buildTranscript`, `getVerseTranscript`,
 * `groupTranscriptItems`) lives in verse-transcript.ts: this store is on the
 * chat first-paint path and the derivation is not (only lazy chunks render a
 * transcript). Its types are re-exported below so type imports keep working;
 * never re-export a VALUE from there, or the derivation rides along again.
 */
import type { VerseEvent, VerseSession, VerseUsage } from '../../data/api-types.js';
import type {
  VerseProgressPhase,
  VerseStatusKind,
  VerseTransientEvent,
  VerseWindowSource,
} from '../../../core/verse/types.js';
// transient-events, not types: a value imported from types.ts brings every
// runtime value exported there (the handoff prompt, the effort tables) into
// this store's first-paint chunk.
import { isTransientVerseEvent } from '../../../core/verse/transient-events.js';
// compaction-point, not context-math: this store is on the chat first-paint
// path and needs only this formula (context-math re-exports it).
import { reconcileAutoCompactAt } from '../../../core/verse/compaction-point.js';

export type {
  BuildTranscriptOptions,
  ToolGroupItem,
  ToolGroupMember,
  Transcript,
  TranscriptCache,
  TranscriptItem,
  TranscriptRenderItem,
  TranscriptSegment,
} from './verse-transcript.js';

export type VerseStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

// ---------------------------------------------------------------------------
// Live (transient) state
// ---------------------------------------------------------------------------

/** The reasoning block currently streaming in (`thinking-delta` / `thinking-progress`). */
export interface VerseLiveThinking {
  turnId: string;
  /** Streamed text so far; empty when the CLI reports only a token estimate. */
  text: string;
  /** Client clock (ms) when this block's first signal arrived. */
  startedAt: number;
  /** Latest `thinking-progress` estimate; null when the CLI sent none (unknown, never 0). */
  estimatedTokens: number | null;
}

export interface VerseLiveProgress {
  phase: VerseProgressPhase;
  tool: string | null;
  /** Server-measured turn wall time when the frame was sent. */
  elapsedMs: number;
  outTokens: number | null;
  tokPerSec: number | null;
  /** Client clock (ms) the frame arrived, so elapsed can keep counting between frames. */
  receivedAt: number;
}

export interface VerseLiveNotice {
  kind: VerseStatusKind;
  message: string;
  at: string;
  receivedAt: number;
}

export interface VerseLiveState {
  /** The running turn these signals belong to; null when none is running. */
  turnId: string | null;
  /** Client clock (ms) the running turn started, from its `turn-started` stamp when parseable. */
  startedAt: number | null;
  progress: VerseLiveProgress | null;
  thinking: VerseLiveThinking | null;
  /** The latest plumbing notice (API retry, preflight, no-output watchdog); cleared when output resumes. */
  notice: VerseLiveNotice | null;
  /** Last turn that settled, so a late transient frame for it cannot resurrect the live line. */
  settledTurnId: string | null;
}

/** What this tab measured about a reasoning block while it streamed — keyed by the persisted `thinking` event's seq. */
export interface VerseThinkingStat {
  durationMs: number | null;
  estimatedTokens: number | null;
}

const EMPTY_LIVE: VerseLiveState = {
  turnId: null,
  startedAt: null,
  progress: null,
  thinking: null,
  notice: null,
  settledTurnId: null,
};

// ---------------------------------------------------------------------------
// Entries, heads and subscriptions
// ---------------------------------------------------------------------------

export interface VerseSessionState {
  sessionId: string;
  session: VerseSession | null;
  events: VerseEvent[];
  /** Highest PERSISTED seq held — the resume cursor. Transient frames never move it. */
  lastSeq: number;
  loaded: boolean;
  loadError: string | null;
  stream: VerseStreamState;
  /** V3.10 transient signals of the running turn. */
  live: VerseLiveState;
}

/**
 * Everything about a session EXCEPT its live signals, republished only on
 * structural change. `events` is the log as of the last non-`text-delta`
 * event: streamed tokens reach the transcript through its own subscription,
 * so a consumer of the head (session record, meters, activity stats) never
 * re-renders per token. Code that needs every delta reads
 * `getVerseSessionState` or `getVerseTranscript` instead.
 */
export type VerseSessionHead = Omit<VerseSessionState, 'live'>;

const EMPTY: Omit<VerseSessionState, 'sessionId'> = {
  session: null,
  events: [],
  lastSeq: 0,
  loaded: false,
  loadError: null,
  stream: 'idle',
  live: EMPTY_LIVE,
};

const sessions = new Map<string, VerseSessionState>();
const heads = new Map<string, VerseSessionHead>();
const thinkingStats = new Map<string, Map<number, VerseThinkingStat>>();
const listeners = new Set<() => void>();
const sessionListeners = new Map<string, Set<() => void>>();

export type VerseStoreLifecycle = { kind: 'reset' } | { kind: 'forget'; sessionId: string };
const lifecycleListeners = new Set<(event: VerseStoreLifecycle) => void>();

function notify(sessionId: string | null): void {
  if (sessionId !== null) {
    const scoped = sessionListeners.get(sessionId);
    if (scoped) for (const l of [...scoped]) l();
  } else {
    for (const set of [...sessionListeners.values()]) for (const l of [...set]) l();
  }
  for (const l of [...listeners]) l();
}

/** Every change to every session. Prefer `subscribeVerseSession` in components. */
export function subscribeVerseStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes to ONE session only — what a component showing that session subscribes to. */
export function subscribeVerseSession(sessionId: string, listener: () => void): () => void {
  let set = sessionListeners.get(sessionId);
  if (!set) {
    set = new Set();
    sessionListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = sessionListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) sessionListeners.delete(sessionId);
  };
}

/**
 * Reset / forget notifications, so the live-stream registry can close the
 * connection of a chat that was deleted or of a store that was cleared on
 * logout (and so tests never inherit a previous test's stream).
 */
export function subscribeVerseStoreLifecycle(listener: (event: VerseStoreLifecycle) => void): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function headOf(state: VerseSessionState): VerseSessionHead {
  return {
    sessionId: state.sessionId,
    session: state.session,
    events: state.events,
    lastSeq: state.lastSeq,
    loaded: state.loaded,
    loadError: state.loadError,
    stream: state.stream,
  };
}

function entryFor(sessionId: string): VerseSessionState {
  let e = sessions.get(sessionId);
  if (!e) {
    e = { sessionId, ...EMPTY };
    sessions.set(sessionId, e);
    heads.set(sessionId, headOf(e));
  }
  return e;
}

/**
 * Store `next` and republish the head when anything it carries changed.
 * `structural` = the event log gained something other than a text-delta.
 */
function commit(sessionId: string, next: VerseSessionState, structural: boolean): void {
  sessions.set(sessionId, next);
  const head = heads.get(sessionId);
  if (
    !head || structural || head.session !== next.session || head.loaded !== next.loaded ||
    head.loadError !== next.loadError || head.stream !== next.stream
  ) {
    heads.set(sessionId, headOf(next));
  }
}

function patch(sessionId: string, delta: Partial<VerseSessionState>, structural = false): void {
  const current = entryFor(sessionId);
  commit(sessionId, { ...current, ...delta }, structural);
  notify(sessionId);
}

const NONE: VerseSessionState = { sessionId: '', ...EMPTY };
const NONE_HEAD: VerseSessionHead = headOf(NONE);

/** Stable reference until the entry changes, so useSyncExternalStore is happy. */
export function getVerseSessionState(sessionId: string | null): VerseSessionState {
  if (!sessionId) return NONE;
  return entryFor(sessionId);
}

/** The head snapshot (see VerseSessionHead) — stable across text-deltas. */
export function getVerseSessionHead(sessionId: string | null): VerseSessionHead {
  if (!sessionId) return NONE_HEAD;
  entryFor(sessionId);
  return heads.get(sessionId)!;
}

/** Live signals of the running turn; the same object until one of them changes. */
export function getVerseLive(sessionId: string | null): VerseLiveState {
  if (!sessionId) return EMPTY_LIVE;
  return entryFor(sessionId).live;
}

/**
 * What this tab measured about the session's reasoning blocks while they
 * streamed (read by verse-transcript.ts when it derives the transcript).
 */
export function getVerseThinkingStats(sessionId: string): ReadonlyMap<number, VerseThinkingStat> | undefined {
  return thinkingStats.get(sessionId);
}

/** Merge a fetched detail (session + full event log) into the entry. Events
 * already known (same seq) are kept once; the union stays sorted by seq. The
 * detail fetch can race a live stream, so a `turn-done` that streamed in
 * meanwhile wins over the older `running` snapshot. A refetch that brings
 * nothing new changes nothing — no re-render. */
export function seedVerseSession(sessionId: string, session: VerseSession, events: readonly VerseEvent[]): void {
  const current = entryFor(sessionId);
  const merged = mergeEvents(current.events, events);
  const settled = settledStatus(session, merged);
  const nextSession = current.session && sameSession(current.session, settled) ? current.session : settled;
  const eventsChanged = merged !== current.events;
  const live = eventsChanged || nextSession !== current.session ? liveFromLog(current.live, merged, nextSession) : current.live;
  if (!eventsChanged && nextSession === current.session && current.loaded && current.loadError === null && live === current.live) return;
  commit(sessionId, {
    ...current,
    session: nextSession,
    events: merged,
    lastSeq: merged.length ? Math.max(current.lastSeq, merged[merged.length - 1]!.seq) : current.lastSeq,
    loaded: true,
    loadError: null,
    live,
  }, eventsChanged);
  notify(sessionId);
}

export function setVerseLoadError(sessionId: string, message: string): void {
  patch(sessionId, { loadError: message, loaded: true });
}

export function setVerseStreamState(sessionId: string, stream: VerseStreamState): void {
  if (entryFor(sessionId).stream === stream) return;
  patch(sessionId, { stream });
}

/**
 * Replace the session record (after a turn POST / rename / list refresh).
 * `turnId` is the turn the snapshot claims is running (POST …/turns returns
 * it): when the log already holds that turn's `turn-done`/`cancelled` — a
 * spawn failure settles in the same tick as the 202 — the snapshot is stale
 * and must not drag the composer back to running.
 */
export function setVerseSession(sessionId: string, session: VerseSession, turnId?: string): void {
  const current = entryFor(sessionId);
  patch(sessionId, { session: settledStatus(session, current.events, turnId) });
}

/**
 * Reconcile a `running` snapshot against the event log. Without a `turnId`
 * the running turn is the last `user-message`/`turn-started` in the log; a
 * later `turn-done`/`cancelled` means the server already settled it. With a
 * `turnId`, only that turn's terminal event counts (its `user-message` may
 * not have streamed in yet, so a previous turn's `turn-done` proves nothing).
 * Status follows the same rules applyVerseEvent uses: cancelled → idle,
 * `turn-done ok:false` → error only when an `error` event was logged for it.
 */
export function settledStatus(session: VerseSession, events: readonly VerseEvent[], turnId?: string): VerseSession {
  if (session.status !== 'running') return session;
  let anchorSeq = -1;
  let anchorTurn: string | null = turnId ?? null;
  if (!turnId) {
    for (const e of events) {
      if (e.type === 'user-message' || e.type === 'turn-started') {
        anchorSeq = e.seq;
        anchorTurn = e.turnId;
      }
    }
    if (anchorTurn === null) return session;
  }
  let terminal: Extract<VerseEvent, { type: 'turn-done' | 'cancelled' }> | null = null;
  let lastError: string | null = null;
  for (const e of events) {
    if (e.seq <= anchorSeq) continue;
    if (e.type === 'error' && e.turnId === anchorTurn) lastError = e.message;
    if ((e.type === 'turn-done' || e.type === 'cancelled') && e.turnId === anchorTurn) terminal = e;
  }
  if (!terminal) return session;
  const failed = terminal.type === 'turn-done' && !terminal.ok && lastError !== null;
  return {
    ...session,
    status: failed ? 'error' : 'idle',
    lastError: failed ? lastError : null,
    updatedAt: terminal.at > session.updatedAt ? terminal.at : session.updatedAt,
  };
}

/** Optimistic status flip (e.g. right after POST …/turns returns 202). */
export function setVerseSessionStatus(sessionId: string, status: VerseSession['status']): void {
  const current = entryFor(sessionId);
  if (!current.session || current.session.status === status) return;
  patch(sessionId, { session: { ...current.session, status } });
}

export interface VerseApplyResult {
  /** Persisted events newly added to the log (duplicates excluded). */
  applied: number;
  /** A newly added event settled a turn (`turn-done` / `cancelled` / `error`) — the lists may be stale. */
  settled: boolean;
  /** A transient frame changed the live state. */
  liveChanged: boolean;
}

/**
 * Apply a BATCH of live events in arrival order, then notify once.
 *
 * Persisted events: duplicates (a stream that replays from the start, or a
 * resume that overlaps the detail fetch) are dropped by seq; an event past
 * the newest seq is appended; an older unseen one is inserted in place.
 * Session-level side effects: `usage` and `context` update the live context
 * meter, `compaction` counts a native compaction, `turn-started` flips
 * status to running, `turn-done`/`cancelled`/`error` settle it, and a codex
 * `turn-done.nativeSessionId` is captured.
 *
 * Transient events (VERSE_TRANSIENT_EVENT_TYPES) never enter the log and
 * never move `lastSeq`: they carry the last PERSISTED seq, so deduping them
 * by seq would drop every one of them. They only update `live`.
 */
export function applyVerseEvents(sessionId: string, incoming: readonly VerseEvent[]): VerseApplyResult {
  const current = entryFor(sessionId);
  let events: VerseEvent[] = current.events;
  let copied = false;
  let lastSeq = current.lastSeq;
  let session = current.session;
  let live = current.live;
  let applied = 0;
  let settled = false;
  let structural = false;
  let liveChanged = false;
  const now = Date.now();

  for (const event of incoming) {
    if (isTransientVerseEvent(event)) {
      const next = applyTransient(live, event, now);
      if (next !== live) {
        live = next;
        liveChanged = true;
      }
      continue;
    }
    if (!Number.isFinite(event.seq)) continue;
    const tail = events.length > 0 ? events[events.length - 1]!.seq : -Infinity;
    if (event.seq > tail) {
      if (!copied) {
        events = events.slice();
        copied = true;
      }
      events.push(event);
    } else {
      const at = seqIndex(events, event.seq);
      if (at.found) continue;
      if (!copied) {
        events = events.slice();
        copied = true;
      }
      events.splice(at.index, 0, event);
    }
    applied += 1;
    lastSeq = Math.max(lastSeq, event.seq);
    if (event.type !== 'text-delta') structural = true;
    if (event.type === 'turn-done' || event.type === 'cancelled' || event.type === 'error') settled = true;
    if (session) session = sessionAfter(session, event);
    const nextLive = livePersisted(live, event, now, sessionId);
    if (nextLive !== live) live = nextLive;
  }

  if (applied === 0 && !liveChanged) return { applied: 0, settled: false, liveChanged: false };
  commit(sessionId, { ...current, events, lastSeq, session, live }, structural);
  notify(sessionId);
  return { applied, settled, liveChanged };
}

/**
 * Apply one live event (the single-event form of applyVerseEvents). Returns
 * true when the log gained the event, or — for a transient frame — when the
 * live state changed.
 */
export function applyVerseEvent(sessionId: string, event: VerseEvent): boolean {
  const result = applyVerseEvents(sessionId, [event]);
  return result.applied > 0 || result.liveChanged;
}

/** A persisted event's effect on the session record (the old applyVerseEvent switch). */
function sessionAfter(session: VerseSession, event: VerseEvent): VerseSession {
  switch (event.type) {
    case 'turn-started':
      return { ...session, status: 'running', lastError: null, updatedAt: event.at };
    case 'usage':
      return { ...session, usage: applyUsageFrame(session, event.usage), updatedAt: event.at };
    case 'context':
      return { ...session, usage: applyContextReading(session, event), updatedAt: event.at };
    case 'compaction':
      // Counted exactly as the server counts it (session-engine), so a reload
      // shows the same number the live stream did. Occupancy is NOT touched
      // here: the next `usage`/`context` reading is the measurement.
      return { ...session, compactionCount: (session.compactionCount ?? 0) + 1, updatedAt: event.at };
    case 'turn-done':
      return {
        ...session,
        status: event.ok ? 'idle' : session.lastError ? 'error' : 'idle',
        turnCount: session.turnCount + 1,
        nativeSessionId: event.nativeSessionId ?? session.nativeSessionId,
        updatedAt: event.at,
      };
    case 'error':
      return { ...session, status: 'error', lastError: event.message, updatedAt: event.at };
    case 'cancelled':
      return { ...session, status: 'idle', updatedAt: event.at };
    default:
      return session;
  }
}

function stampMs(at: string, fallback: number): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Enter (or stay in) the live context of `turnId`. */
function liveForTurn(live: VerseLiveState, turnId: string, startedAt: number): VerseLiveState {
  if (live.turnId === turnId) return live;
  return { ...EMPTY_LIVE, turnId, startedAt, settledTurnId: live.settledTurnId };
}

function applyTransient(live: VerseLiveState, event: VerseTransientEvent, now: number): VerseLiveState {
  // A frame for a turn that already settled (late delivery after turn-done)
  // must not bring the live line back.
  if (event.turnId !== null && event.turnId === live.settledTurnId) return live;
  const base = event.turnId !== null ? liveForTurn(live, event.turnId, now) : live;
  switch (event.type) {
    case 'thinking-delta': {
      if (event.text.length === 0) return base;
      const block = base.thinking && base.thinking.turnId === event.turnId
        ? { ...base.thinking, text: base.thinking.text + event.text }
        : { turnId: event.turnId, text: event.text, startedAt: now, estimatedTokens: null };
      return { ...base, thinking: block, notice: null };
    }
    case 'thinking-progress': {
      const block = base.thinking && base.thinking.turnId === event.turnId
        ? { ...base.thinking, estimatedTokens: event.estimatedTokens }
        : { turnId: event.turnId, text: '', startedAt: now, estimatedTokens: event.estimatedTokens };
      return { ...base, thinking: block };
    }
    case 'progress':
      return {
        ...base,
        progress: {
          phase: event.phase,
          tool: typeof event.tool === 'string' && event.tool.length > 0 ? event.tool : null,
          elapsedMs: event.elapsedMs,
          outTokens: event.outTokens ?? null,
          tokPerSec: event.tokPerSec ?? null,
          receivedAt: now,
        },
      };
    case 'status':
      return { ...base, notice: { kind: event.kind, message: event.message, at: event.at, receivedAt: now } };
    default:
      return base;
  }
}

/** A persisted event's effect on the live state. */
function livePersisted(live: VerseLiveState, event: VerseEvent, now: number, sessionId: string): VerseLiveState {
  switch (event.type) {
    case 'turn-started':
      if (event.turnId === live.settledTurnId) return live;
      return live.turnId === event.turnId
        ? { ...live, startedAt: stampMs(event.at, live.startedAt ?? now) }
        : { ...EMPTY_LIVE, turnId: event.turnId, startedAt: stampMs(event.at, now), settledTurnId: live.settledTurnId };
    case 'thinking': {
      // The persisted block supersedes the streamed one. What this tab
      // measured while it streamed (duration, the CLI's token estimate) is
      // kept beside the log, by seq, so the finished block can still say
      // "Thought 12s · ~1.8k tok" — the event itself is immutable.
      const streamed = live.thinking && live.thinking.turnId === event.turnId ? live.thinking : null;
      if (streamed) {
        let stats = thinkingStats.get(sessionId);
        if (!stats) {
          stats = new Map();
          thinkingStats.set(sessionId, stats);
        }
        stats.set(event.seq, {
          durationMs: typeof event.durationMs === 'number' ? event.durationMs : Math.max(0, now - streamed.startedAt),
          estimatedTokens: streamed.estimatedTokens,
        });
      }
      return streamed || live.notice ? { ...live, thinking: streamed ? null : live.thinking, notice: null } : live;
    }
    case 'text-delta':
    case 'assistant-message':
    case 'tool-use':
    case 'tool-result':
      // Output resumed: a retry went through, the watchdog's silence ended.
      return live.notice && (event.turnId === live.turnId || live.turnId === null) ? { ...live, notice: null } : live;
    case 'turn-done':
    case 'cancelled':
      return { ...EMPTY_LIVE, settledTurnId: event.turnId };
    default:
      return live;
  }
}

/**
 * Live state implied by a freshly merged log: a chat opened (or reloaded)
 * mid-turn still shows its live line, timed from the turn's own stamp; a
 * log whose last turn is settled shows none.
 */
function liveFromLog(live: VerseLiveState, events: readonly VerseEvent[], session: VerseSession | null): VerseLiveState {
  let openTurn: Extract<VerseEvent, { type: 'turn-started' }> | null = null;
  let settledTurnId: string | null = live.settledTurnId;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === 'turn-done' || e.type === 'cancelled') {
      settledTurnId = e.turnId;
      break;
    }
    if (e.type === 'turn-started') {
      openTurn = e;
      break;
    }
  }
  if (!openTurn) {
    if (live.turnId !== null && live.turnId === settledTurnId) return { ...EMPTY_LIVE, settledTurnId };
    // No turn-started in the log yet (the POST just went out): keep whatever
    // the stream already told us; nothing in the log contradicts it.
    return live.settledTurnId === settledTurnId ? live : { ...live, settledTurnId };
  }
  if (session && session.status !== 'running') return live.turnId === null ? live : { ...EMPTY_LIVE, settledTurnId: live.settledTurnId };
  if (live.turnId === openTurn.turnId) return live;
  return { ...EMPTY_LIVE, turnId: openTurn.turnId, startedAt: stampMs(openTurn.at, Date.now()), settledTurnId: live.settledTurnId };
}

/**
 * Fold one `usage` frame into the session record. The frame carries THIS
 * turn's counts; the record keeps the session totals (server: session-engine
 * applyUsage). Occupancy and the window are live values, not sums.
 *
 * V3.9 fields are adopted only when the frame carries them (spread-when-
 * present), so a pre-3.9 server's frames leave the record's shape unchanged.
 * The one exception is a local seat: Verse SETS that window
 * (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), so a window a frame reports without
 * provenance is not allowed to replace it — the server ignores runtime
 * windows on local for the same reason.
 */
export function applyUsageFrame(session: VerseSession, frame: VerseUsage): VerseUsage {
  const prev = session.usage;
  const next: VerseUsage = {
    ...prev,
    inputTokens: prev.inputTokens + frame.inputTokens,
    outputTokens: prev.outputTokens + frame.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + frame.cacheReadTokens,
    cacheCreationTokens: prev.cacheCreationTokens + frame.cacheCreationTokens,
    contextTokens: frame.contextTokens,
  };
  const frameWindow = typeof frame.contextWindow === 'number' && frame.contextWindow > 0 ? frame.contextWindow : null;
  const trusted = frame.contextWindowSource !== undefined || session.engine !== 'local';
  if (frameWindow !== null && trusted) next.contextWindow = frameWindow;
  if (frame.contextWindowSource !== undefined) next.contextWindowSource = frame.contextWindowSource;
  if (frame.autoCompactAt !== undefined) next.autoCompactAt = frame.autoCompactAt;
  // The server marks an EXACT reading by OMITTING the key (it only writes
  // `false`), so a resolved frame without it must clear an earlier "≤" — a
  // frame from a pre-3.9 server (no V3.9 fields at all) leaves it alone.
  if (frame.contextTokensExact === false) next.contextTokensExact = false;
  else if (frame.contextWindowSource !== undefined) delete next.contextTokensExact;
  return next;
}

/** The provenance values a frame may carry; anything else is ignored, never stored. */
const WINDOW_SOURCES: ReadonlySet<string> = new Set<VerseWindowSource>(['runtime', 'provider-catalog', 'cli-catalog', 'documented', 'fallback']);

function frameWindowSource(value: unknown): VerseWindowSource | null {
  return typeof value === 'string' && WINDOW_SOURCES.has(value) ? (value as VerseWindowSource) : null;
}

/**
 * Apply a `context` reading: it REPLACES occupancy (never summed). When it
 * names a window, the window's provenance is the one the EVENT states
 * (`contextWindowSource`, V3.9): the engine also emits a `context` event
 * after a MODE SWITCH, carrying the new mode's CATALOG budget, and stamping
 * that 'runtime' made the tooltip say "reported by the CLI on the last turn"
 * for a number no CLI reported — and pinned it ahead of later catalog
 * corrections (sessionContextBudget precedence 1). Only an event from a
 * server that predates the field (no source at all) is taken as a runtime
 * reading, which is what every such event was.
 *
 * The engine fills `autoCompactAt` for the window in force; a frame without
 * it (an older server) is reconciled from the previous budget rather than
 * left pointing at a compaction point that belonged to a different window.
 */
export function applyContextReading(
  session: VerseSession,
  event: Extract<VerseEvent, { type: 'context' }>,
): VerseUsage {
  const prev = session.usage;
  const next: VerseUsage = {
    ...prev,
    contextTokens: Math.max(0, Math.floor(event.contextTokens)),
    contextTokensExact: event.exact,
  };
  const window = typeof event.contextWindow === 'number' && event.contextWindow > 0 ? event.contextWindow : null;
  const stated = frameWindowSource(event.contextWindowSource);
  // Local windows are SET by Verse (CLAUDE_CODE_MAX_CONTEXT_TOKENS), not
  // measured: a window without provenance is not allowed to move one (see
  // applyUsageFrame). A V3.9 event that states its source is the engine's
  // own record of the window it just launched with, so it is adopted.
  if (window === null || (session.engine === 'local' && stated === null)) {
    if (event.autoCompactAt !== undefined && event.autoCompactAt !== null) next.autoCompactAt = event.autoCompactAt;
    return next;
  }
  next.contextWindow = window;
  next.contextWindowSource = stated ?? 'runtime';
  if (event.autoCompactAt !== undefined) {
    next.autoCompactAt = event.autoCompactAt;
  } else if (window !== prev.contextWindow) {
    next.autoCompactAt = reconcileAutoCompactAt({
      engine: session.engine,
      runtimeWindow: window,
      budget: prev.contextWindow ? { contextWindow: prev.contextWindow, autoCompactAt: prev.autoCompactAt ?? null } : null,
    });
  }
  return next;
}

export function forgetVerseSession(sessionId: string): void {
  const existed = sessions.delete(sessionId);
  heads.delete(sessionId);
  thinkingStats.delete(sessionId);
  for (const l of [...lifecycleListeners]) l({ kind: 'forget', sessionId });
  if (existed) notify(sessionId);
}

/** Test/logout hygiene. */
export function resetVerseStore(): void {
  sessions.clear();
  heads.clear();
  thinkingStats.clear();
  for (const l of [...lifecycleListeners]) l({ kind: 'reset' });
  notify(null);
}

/** Position of `seq` in a seq-sorted log (binary search). */
function seqIndex(events: readonly VerseEvent[], seq: number): { found: boolean; index: number } {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const s = events[mid]!.seq;
    if (s === seq) return { found: true, index: mid };
    if (s < seq) lo = mid + 1;
    else hi = mid;
  }
  return { found: false, index: lo };
}

/** Sorted by seq, one event per seq (first occurrence wins), non-finite seqs dropped. */
function normalizeEvents(events: readonly VerseEvent[]): VerseEvent[] {
  let ascending = true;
  for (let i = 0; i < events.length; i += 1) {
    const seq = events[i]!.seq;
    if (!Number.isFinite(seq) || (i > 0 && seq <= events[i - 1]!.seq)) {
      ascending = false;
      break;
    }
  }
  if (ascending) return events.slice();
  const bySeq = new Map<number, VerseEvent>();
  for (const e of events) if (Number.isFinite(e.seq) && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Union of two logs by seq, existing events winning. Returns `existing`
 * itself when `incoming` adds nothing, so a refetch that brought no news is
 * not a change. Linear in the two lengths (both are seq-sorted).
 */
function mergeEvents(existing: VerseEvent[], incomingRaw: readonly VerseEvent[]): VerseEvent[] {
  if (incomingRaw.length === 0) return existing;
  const incoming = normalizeEvents(incomingRaw);
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (incoming[0]!.seq > existing[existing.length - 1]!.seq) return existing.concat(incoming);
  const out: VerseEvent[] = [];
  let added = 0;
  let i = 0;
  let j = 0;
  while (i < existing.length || j < incoming.length) {
    const a = existing[i];
    const b = incoming[j];
    if (b === undefined || (a !== undefined && a.seq < b.seq)) {
      out.push(a!);
      i += 1;
    } else if (a === undefined || b.seq < a.seq) {
      out.push(b);
      added += 1;
      j += 1;
    } else {
      out.push(a);
      i += 1;
      j += 1;
    }
  }
  return added === 0 ? existing : out;
}

function shallowEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Same record, one level deep — a refetched but unchanged session must not re-render its chat. */
function sameSession(a: VerseSession, b: VerseSession): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof VerseSession>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => shallowEqualValue(a[k], b[k]));
}
