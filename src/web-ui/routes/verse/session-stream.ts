/**
 * routes/verse/session-stream.ts — the client data path for ONE open chat
 * (V3.10): load it once, resume its live stream from where the store left
 * off, batch what streams in to one store update per animation frame, and
 * keep the connection across section switches.
 *
 * WHY THIS EXISTS (measured before 3.10, scratchpad perf/):
 *   - opening a chat raced a full detail fetch against an EventSource that
 *     replayed the whole log from seq 0, and every replayed frame was applied
 *     and rendered on its own — 2.45 s for a 5k-event chat, 17 s for 10k;
 *   - every reconnect (at least one per 15-minute read session) replayed the
 *     whole log again, because a hand-made EventSource sends no Last-Event-ID;
 *   - every replayed `turn-done` refetched the session list and bootstrap;
 *   - leaving the Chat section closed the stream, so coming back replayed.
 *
 * THE PATH NOW
 *   1. `openVerseSession(id)` fetches the detail ONCE when the store has not
 *      loaded the chat, seeds the store, and only then attaches the stream —
 *      so the two never race.
 *   2. The stream URL carries `?after=<lastSeq>` (the highest PERSISTED seq
 *      the store holds). The server replays only what is newer; a server that
 *      predates `after` replays everything and the store's seq dedupe drops
 *      it. A server whose auth boundary REFUSES the extra parameter is
 *      detected once and served without it (afterRefused). A dropped
 *      connection is left to the browser's own reconnect, which resumes by
 *      Last-Event-ID.
 *   3. Frames are queued and applied with ONE `applyVerseEvents` call per
 *      animation frame (a timer backs rAF up, since a hidden tab gets none).
 *      Transient frames (reasoning deltas, progress) ride the same queue in
 *      arrival order.
 *   4. The session list is invalidated only when a batch really settled a
 *      turn — never for a replayed duplicate.
 *   5. Streams are ref-counted. When the last user lets go (section switch,
 *      another chat selected) the connection lingers for IDLE_CLOSE_MS so
 *      switching back is instant and costs no replay; at most MAX_IDLE
 *      lingering connections are kept, because they share the server's SSE
 *      connection cap with /api/events.
 *
 * Auth: every URL carries the per-tab client proof as `?client=` (EventSource
 * cannot send it as a header — see server.ts readSessionClientProof), and a
 * stream never reconnects once the read session is gone.
 */
import type { VerseEvent } from '../../data/api-types.js';
import { getAuthSnapshot, getReadClientProof } from '../../data/auth-store.js';
import { parseVerseEventFrame, VERSE_EVENT_TYPES } from './verse-events.js';
import { fetchVerseSessionDetail, invalidateVerseLists, verseSessionPath } from './verse-queries.js';
import {
  applyVerseEvents,
  getVerseSessionState,
  seedVerseSession,
  setVerseLoadError,
  setVerseStreamState,
  subscribeVerseStoreLifecycle,
} from './verse-store.js';

/** How long a released stream stays connected before it is closed. */
export const IDLE_CLOSE_MS = 90_000;
/** Released-but-lingering streams kept at once (they count against the server's SSE cap). */
export const MAX_IDLE_STREAMS = 1;
/** Fallback flush when requestAnimationFrame does not fire (hidden tab, occluded window). */
const FRAME_FALLBACK_MS = 250;

/**
 * Per-session stream URL: `?after=<cursor>&client=<proof>`. `after` is
 * omitted for cursor 0 — seqs start at 1, so "after 0" and "from the start"
 * are the same request, and the bare form is what a server without `after`
 * support has always seen.
 */
export function verseSessionStreamUrl(sessionId: string, after: number): string {
  const cursor = Number.isSafeInteger(after) && after > 0 ? `after=${after}&` : '';
  return `${verseSessionPath(sessionId, '/events')}?${cursor}client=${encodeURIComponent(getReadClientProof())}`;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

// ---------------------------------------------------------------------------
// Frame scheduling
// ---------------------------------------------------------------------------

type FrameScheduler = (flush: () => void) => () => void;

/**
 * True inside a React `act()` test environment. There, `act()` is the test
 * declaring "everything this block causes must be visible after it", and a
 * frame-deferred flush would land after the assertions — so frames are
 * applied as they arrive, exactly as React applies its own scheduled work
 * inside act. Production never sets the flag.
 */
function inActEnvironment(): boolean {
  return (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT === true;
}

const animationFrameScheduler: FrameScheduler = (flush) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    clearTimeout(timer);
    flush();
  };
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const raf = !hidden && typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : null;
  const timer = setTimeout(run, raf === null ? 0 : FRAME_FALLBACK_MS);
  return () => {
    done = true;
    if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
};

let customScheduler: FrameScheduler | null = null;

/**
 * Tests: replace the frame scheduler (null restores the default). A scheduler
 * that never calls `flush` lets a test assert what is queued; calling it
 * later simulates the frame.
 */
export function setVerseFrameScheduler(scheduler: FrameScheduler | null): void {
  customScheduler = scheduler;
}

function scheduleFrame(flush: () => void): (() => void) | null {
  if (customScheduler) return customScheduler(flush);
  if (inActEnvironment()) {
    flush();
    return null;
  }
  return animationFrameScheduler(flush);
}

/**
 * Collects frames for one session and applies them once per frame. Returns
 * whether the flushed batch settled a turn, for the list invalidation.
 */
class FrameQueue {
  private queue: VerseEvent[] = [];
  private cancel: (() => void) | null = null;
  private scheduled = false;

  constructor(private readonly sessionId: string) {}

  push(event: VerseEvent): void {
    this.queue.push(event);
    if (this.scheduled) return;
    this.scheduled = true;
    const cancel = scheduleFrame(() => this.flush());
    // A synchronous scheduler (act environment) has already flushed.
    if (this.scheduled) this.cancel = cancel;
  }

  /** Apply everything queued now. Safe to call with nothing queued. */
  flush(): void {
    this.scheduled = false;
    this.cancel?.();
    this.cancel = null;
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const result = applyVerseEvents(this.sessionId, batch);
    if (result.settled) invalidateVerseLists();
  }

  drop(): void {
    this.scheduled = false;
    this.cancel?.();
    this.cancel = null;
    this.queue = [];
  }
}

// ---------------------------------------------------------------------------
// One resumable stream
// ---------------------------------------------------------------------------

interface LiveStream {
  close(): void;
  /** Tear down and reconnect from the current cursor (Retry). */
  restart(): void;
}

/**
 * Set once this page has PROVEN that the server refuses `?after=`: a
 * connection with the cursor closed before it opened, and the same stream
 * without it then opened. A read-session boundary that accepts only the
 * `?client=` proof on SSE paths answers 401 to any extra parameter, and a
 * chat that cannot connect at all is far worse than one that replays (the
 * store drops what it already holds). Page-lifetime only: a server that gains
 * support is used again after a reload.
 */
let afterRefused = false;

/** Tests: forget a proven refusal. */
export function resetVerseStreamCapabilities(): void {
  afterRefused = false;
}

/** `EventSource.CONNECTING` — the browser is reconnecting by itself. */
const ES_CONNECTING = 0;

function openResumableStream(sessionId: string): LiveStream {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;
  /** This connection is the no-`after` retry that tests whether the cursor was refused. */
  let probing = false;
  const queue = new FrameQueue(sessionId);

  const connect = () => {
    if (disposed || typeof EventSource === 'undefined') return;
    if (getAuthSnapshot().phase !== 'authenticated') return;
    setVerseStreamState(sessionId, attempt === 0 ? 'connecting' : 'reconnecting');
    // The cursor is read at CONNECT time, after everything already received
    // was applied, so a reconnect asks only for what it has not seen.
    const cursor = afterRefused || probing ? 0 : getVerseSessionState(sessionId).lastSeq;
    const es = new EventSource(verseSessionStreamUrl(sessionId, cursor), { withCredentials: true });
    let opened = false;
    source = es;
    es.onopen = () => {
      opened = true;
      attempt = 0;
      if (probing) {
        afterRefused = true;
        probing = false;
      }
      setVerseStreamState(sessionId, 'open');
    };
    for (const type of VERSE_EVENT_TYPES) {
      es.addEventListener(type, (evt) => {
        if (source !== es) return;
        const event = parseVerseEventFrame((evt as MessageEvent<string>).data);
        if (event) queue.push(event);
      });
    }
    es.onerror = (evt) => {
      // A server-sent event NAMED `error` (a VerseEvent.type) also dispatches
      // through onerror because onerror is the handler for event type "error".
      // It arrives as a MessageEvent with data; a real transport failure does
      // not. Without this guard every vendor error replayed on reconnect would
      // tear the stream down again, forever.
      if (typeof MessageEvent !== 'undefined' && evt instanceof MessageEvent) return;
      // Everything received before the drop moves the cursor first.
      queue.flush();
      if (disposed) return;
      // A dropped connection (network blip, server restart, the server
      // closing a congested stream) is retried by the BROWSER, which sends
      // Last-Event-ID — the last persisted seq, since transient frames carry
      // no id — so it resumes without a replay. Only a refused one (an HTTP
      // error) ends up CLOSED and is ours to retry.
      if (typeof es.readyState === 'number' && es.readyState === ES_CONNECTING) {
        setVerseStreamState(sessionId, 'reconnecting');
        return;
      }
      es.close();
      if (source === es) source = null;
      setVerseStreamState(sessionId, 'reconnecting');
      if (getAuthSnapshot().phase !== 'authenticated') return;
      if (!opened && cursor > 0 && !probing) {
        // Refused before it opened, with a cursor: find out at once whether
        // the cursor is what was refused (see afterRefused).
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

  const teardown = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };

  connect();

  return {
    close() {
      if (disposed) return;
      disposed = true;
      teardown();
      // Frames already received still belong in the store (a lingering stream
      // closing mid-turn must not lose its last tokens).
      queue.flush();
      queue.drop();
      setVerseStreamState(sessionId, 'closed');
    },
    restart() {
      if (disposed) return;
      teardown();
      queue.flush();
      attempt = 0;
      connect();
    },
  };
}

// ---------------------------------------------------------------------------
// Ref-counted registry
// ---------------------------------------------------------------------------

interface RegistryEntry {
  stream: LiveStream;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** When the last reference was released (for evicting the oldest lingering stream). */
  releasedAt: number;
}

const registry = new Map<string, RegistryEntry>();

function closeEntry(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  registry.delete(sessionId);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.stream.close();
}

function evictIdle(): void {
  const idle = [...registry.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].releasedAt - b[1].releasedAt);
  while (idle.length > MAX_IDLE_STREAMS) closeEntry(idle.shift()![0]);
}

/**
 * Hold the live stream for `sessionId` open. Returns the release. The first
 * acquire connects (resuming after the store's cursor); later ones share it.
 */
export function acquireVerseSessionStream(sessionId: string): () => void {
  let entry = registry.get(sessionId);
  if (entry) {
    entry.refs += 1;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  } else {
    entry = { stream: openResumableStream(sessionId), refs: 1, idleTimer: null, releasedAt: 0 };
    registry.set(sessionId, entry);
  }
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (registry.get(sessionId) !== held) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    held.releasedAt = Date.now();
    held.idleTimer = setTimeout(() => {
      if (registry.get(sessionId) === held && held.refs === 0) closeEntry(sessionId);
    }, IDLE_CLOSE_MS);
    evictIdle();
  };
}

/** Close every live stream (logout; tests). */
export function closeAllVerseSessionStreams(): void {
  for (const id of [...registry.keys()]) closeEntry(id);
}

/** Diagnostics/tests: the sessions with a stream held open, and their reference counts. */
export function verseStreamRegistrySnapshot(): Array<{ sessionId: string; refs: number }> {
  return [...registry.entries()].map(([sessionId, e]) => ({ sessionId, refs: e.refs }));
}

// A deleted chat has no stream to keep; a cleared store (logout, test reset)
// has no chats at all.
subscribeVerseStoreLifecycle((event) => {
  if (event.kind === 'reset') closeAllVerseSessionStreams();
  else closeEntry(event.sessionId);
});

// ---------------------------------------------------------------------------
// Opening a chat
// ---------------------------------------------------------------------------

export interface OpenVerseSessionOptions {
  /** Re-fetch the detail and reconnect even when the store already holds the chat (the transcript's Retry). */
  reload?: boolean;
}

/**
 * Show one chat: load it (once) and keep its live stream attached until the
 * returned disposer runs.
 *
 *  - Not loaded yet → fetch the detail, seed the store, THEN attach the
 *    stream from the seeded cursor. No race, no full replay.
 *  - Already loaded (switching back) → attach at once from the cursor; a
 *    stream still lingering from the last visit has nothing to catch up.
 *  - `reload` → refetch the detail and restart the connection.
 */
export function openVerseSession(sessionId: string, options: OpenVerseSessionOptions = {}): () => void {
  const controller = new AbortController();
  let release: (() => void) | null = null;
  let disposed = false;

  const attach = () => {
    if (disposed || release) return;
    release = acquireVerseSessionStream(sessionId);
  };

  const state = getVerseSessionState(sessionId);
  const needsLoad = options.reload === true || !state.loaded || state.loadError !== null;

  if (!needsLoad) {
    attach();
  } else {
    if (options.reload) registry.get(sessionId)?.stream.restart();
    void fetchVerseSessionDetail(sessionId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        seedVerseSession(sessionId, detail.session, detail.events);
        attach();
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setVerseLoadError(sessionId, err instanceof Error ? err.message : 'Could not load this chat.');
      });
  }

  return () => {
    disposed = true;
    controller.abort();
    release?.();
    release = null;
  };
}
