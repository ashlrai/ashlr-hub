/**
 * routes/verse/verse-store.ts — per-session transcript state for the Verse
 * console. Framework-free (useSyncExternalStore glue lives in
 * useVerseSession.ts), same split as data/cache.ts + data/hooks.ts.
 *
 * One entry per session id holds the ordered, seq-deduplicated event log,
 * the latest session record we know of, and the stream connection state.
 * Snapshots are replaced wholesale on every change (Object.is semantics —
 * see DESIGN.md §3 for the bug that rule prevents).
 *
 * `buildTranscript()` derives what the transcript renders from the raw
 * events: streamed `text-delta`s accumulate into a provisional assistant
 * bubble until the matching `assistant-message` arrives and replaces it;
 * `tool-use` and `tool-result` pair up by toolUseId into one card.
 */
import type { VerseEvent, VerseSession, VerseUsage } from '../../data/api-types.js';

export type VerseStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface VerseSessionState {
  sessionId: string;
  session: VerseSession | null;
  events: VerseEvent[];
  lastSeq: number;
  loaded: boolean;
  loadError: string | null;
  stream: VerseStreamState;
}

const EMPTY: Omit<VerseSessionState, 'sessionId'> = {
  session: null,
  events: [],
  lastSeq: 0,
  loaded: false,
  loadError: null,
  stream: 'idle',
};

const sessions = new Map<string, VerseSessionState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeVerseStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function entryFor(sessionId: string): VerseSessionState {
  let e = sessions.get(sessionId);
  if (!e) {
    e = { sessionId, ...EMPTY };
    sessions.set(sessionId, e);
  }
  return e;
}

function patch(sessionId: string, delta: Partial<VerseSessionState>): void {
  const current = entryFor(sessionId);
  sessions.set(sessionId, { ...current, ...delta });
  emit();
}

const NONE: VerseSessionState = { sessionId: '', ...EMPTY };

/** Stable reference until the entry changes, so useSyncExternalStore is happy. */
export function getVerseSessionState(sessionId: string | null): VerseSessionState {
  if (!sessionId) return NONE;
  return entryFor(sessionId);
}

/** Merge a fetched detail (session + full event log) into the entry. Events
 * already known (same seq) are kept once; the union stays sorted by seq. The
 * detail fetch starts before the EventSource opens, so a `turn-done` that
 * streamed in meanwhile wins over the older `running` snapshot. */
export function seedVerseSession(sessionId: string, session: VerseSession, events: VerseEvent[]): void {
  const current = entryFor(sessionId);
  const merged = mergeEvents(current.events, events);
  patch(sessionId, {
    session: settledStatus(session, merged),
    events: merged,
    lastSeq: merged.length ? merged[merged.length - 1]!.seq : 0,
    loaded: true,
    loadError: null,
  });
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

/**
 * Apply one live event. Duplicates (a fresh SSE connection replays from the
 * start) are dropped by seq; out-of-order arrivals are inserted in place.
 * Session-level side effects: `usage` updates the live context meter,
 * `turn-started` flips status to running, `turn-done`/`cancelled`/`error`
 * settle it, and a codex `turn-done.nativeSessionId` is captured.
 */
export function applyVerseEvent(sessionId: string, event: VerseEvent): boolean {
  const current = entryFor(sessionId);
  if (!Number.isFinite(event.seq)) return false;
  if (current.events.some((e) => e.seq === event.seq)) return false;
  const events = mergeEvents(current.events, [event]);
  let session = current.session;
  if (session) {
    switch (event.type) {
      case 'turn-started':
        session = { ...session, status: 'running', lastError: null, updatedAt: event.at };
        break;
      case 'usage':
        // The frame carries THIS turn's counts; the record keeps the session
        // totals (server: session-engine applyUsage). Context occupancy and
        // the window are live values, not sums.
        session = {
          ...session,
          usage: {
            inputTokens: session.usage.inputTokens + event.usage.inputTokens,
            outputTokens: session.usage.outputTokens + event.usage.outputTokens,
            cacheReadTokens: session.usage.cacheReadTokens + event.usage.cacheReadTokens,
            cacheCreationTokens: session.usage.cacheCreationTokens + event.usage.cacheCreationTokens,
            contextTokens: event.usage.contextTokens,
            contextWindow: event.usage.contextWindow ?? session.usage.contextWindow,
          },
          updatedAt: event.at,
        };
        break;
      case 'turn-done':
        session = {
          ...session,
          status: event.ok ? 'idle' : session.lastError ? 'error' : 'idle',
          turnCount: session.turnCount + 1,
          nativeSessionId: event.nativeSessionId ?? session.nativeSessionId,
          updatedAt: event.at,
        };
        break;
      case 'error':
        session = { ...session, status: 'error', lastError: event.message, updatedAt: event.at };
        break;
      case 'cancelled':
        session = { ...session, status: 'idle', updatedAt: event.at };
        break;
      default:
        break;
    }
  }
  patch(sessionId, { events, lastSeq: Math.max(current.lastSeq, event.seq), session });
  return true;
}

export function forgetVerseSession(sessionId: string): void {
  if (sessions.delete(sessionId)) emit();
}

/** Test/logout hygiene. */
export function resetVerseStore(): void {
  sessions.clear();
  emit();
}

function mergeEvents(existing: VerseEvent[], incoming: VerseEvent[]): VerseEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, VerseEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Transcript derivation
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: 'user'; key: string; turnId: string; at: string; text: string }
  | { kind: 'assistant'; key: string; turnId: string; at: string; text: string; streaming: boolean }
  | { kind: 'thinking'; key: string; turnId: string; at: string; text: string }
  | {
      kind: 'tool';
      key: string;
      turnId: string;
      at: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result: { output: string; isError: boolean } | null;
      /** tool-use → tool-result wall time; null while pending or unstamped. */
      durationMs: number | null;
    }
  | { kind: 'error'; key: string; turnId: string | null; at: string; message: string }
  | { kind: 'cancelled'; key: string; turnId: string; at: string }
  | { kind: 'turn-done'; key: string; turnId: string; at: string; ok: boolean; durationMs: number };

export interface Transcript {
  items: TranscriptItem[];
  /** True while a turn is open (started and not yet done/cancelled). */
  live: boolean;
  /** Most recent usage frame seen in the log, if any. */
  usage: VerseUsage | null;
}

/** Wall time between two ISO stamps; null when either is unparseable. */
function spanMs(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

export function buildTranscript(events: VerseEvent[]): Transcript {
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  let pending: { turnId: string; at: string; text: string; key: string } | null = null;
  let live = false;
  let usage: VerseUsage | null = null;

  const flushPending = (streaming: boolean) => {
    if (!pending) return;
    items.push({ kind: 'assistant', key: pending.key, turnId: pending.turnId, at: pending.at, text: pending.text, streaming });
    pending = null;
  };

  for (const e of events) {
    switch (e.type) {
      case 'user-message':
        flushPending(false);
        items.push({ kind: 'user', key: `u-${e.seq}`, turnId: e.turnId, at: e.at, text: e.text });
        break;
      case 'turn-started':
        live = true;
        break;
      case 'text-delta':
        if (pending && pending.turnId !== e.turnId) flushPending(false);
        if (!pending) pending = { turnId: e.turnId, at: e.at, text: '', key: `d-${e.seq}` };
        pending.text += e.text;
        break;
      case 'assistant-message':
        // The complete message supersedes whatever deltas streamed before it.
        pending = null;
        items.push({ kind: 'assistant', key: `a-${e.seq}`, turnId: e.turnId, at: e.at, text: e.text, streaming: false });
        break;
      case 'thinking':
        flushPending(false);
        items.push({ kind: 'thinking', key: `t-${e.seq}`, turnId: e.turnId, at: e.at, text: e.text });
        break;
      case 'tool-use':
        flushPending(false);
        toolIndex.set(e.toolUseId, items.length);
        items.push({
          kind: 'tool',
          key: `tu-${e.seq}`,
          turnId: e.turnId,
          at: e.at,
          toolUseId: e.toolUseId,
          name: e.name,
          input: e.input,
          result: null,
          durationMs: null,
        });
        break;
      case 'tool-result': {
        const idx = toolIndex.get(e.toolUseId);
        const existing = idx === undefined ? undefined : items[idx];
        if (existing && existing.kind === 'tool') {
          items[idx!] = { ...existing, result: { output: e.output, isError: e.isError }, durationMs: spanMs(existing.at, e.at) };
        } else {
          items.push({
            kind: 'tool',
            key: `tr-${e.seq}`,
            turnId: e.turnId,
            at: e.at,
            toolUseId: e.toolUseId,
            name: 'tool',
            input: null,
            result: { output: e.output, isError: e.isError },
            durationMs: null,
          });
        }
        break;
      }
      case 'usage':
        usage = e.usage;
        break;
      case 'error':
        flushPending(false);
        items.push({ kind: 'error', key: `e-${e.seq}`, turnId: e.turnId, at: e.at, message: e.message });
        break;
      case 'cancelled':
        flushPending(false);
        live = false;
        items.push({ kind: 'cancelled', key: `c-${e.seq}`, turnId: e.turnId, at: e.at });
        break;
      case 'turn-done':
        flushPending(false);
        live = false;
        items.push({ kind: 'turn-done', key: `td-${e.seq}`, turnId: e.turnId, at: e.at, ok: e.ok, durationMs: e.durationMs });
        break;
      default:
        break;
    }
  }
  // Deltas still arriving for an open turn render as a streaming bubble.
  flushPending(live);
  return { items, live, usage };
}

// ---------------------------------------------------------------------------
// Render-time grouping
// ---------------------------------------------------------------------------

export type ToolGroupMember = Extract<TranscriptItem, { kind: 'tool' | 'thinking' }>;

export interface ToolGroupItem {
  kind: 'toolGroup';
  key: string;
  turnId: string;
  at: string;
  items: ToolGroupMember[];
  /** Tool calls only (thinking blocks are not counted). */
  toolCount: number;
  /** "Read ×6, Edit ×4" — names in first-seen order. */
  summary: string;
  errorCount: number;
  /** A member is still waiting for its result. */
  pending: boolean;
  /** Wall time between the first and last member, when both have parseable timestamps. */
  spanMs: number | null;
}

export type TranscriptRenderItem = TranscriptItem | ToolGroupItem;

/**
 * Fold runs of two or more consecutive `tool`/`thinking` items from the same
 * turn into one `toolGroup`, so an agentic turn reads as "N tool calls"
 * with a single disclosure instead of a wall of cards. Single tool calls
 * stay as they are. Pure over buildTranscript()'s output (the index-based
 * tool-result pairing there is untouched).
 */
export function groupTranscriptItems(items: readonly TranscriptItem[]): TranscriptRenderItem[] {
  const out: TranscriptRenderItem[] = [];
  let run: ToolGroupMember[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) out.push(run[0]!);
    else out.push(makeToolGroup(run));
    run = [];
  };

  for (const item of items) {
    if ((item.kind === 'tool' || item.kind === 'thinking') && (run.length === 0 || run[0]!.turnId === item.turnId)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === 'tool' || item.kind === 'thinking') run.push(item);
    else out.push(item);
  }
  flush();
  return out;
}

function makeToolGroup(members: ToolGroupMember[]): ToolGroupItem {
  const counts = new Map<string, number>();
  let errorCount = 0;
  let pending = false;
  for (const m of members) {
    if (m.kind !== 'tool') continue;
    counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    if (m.result === null) pending = true;
    else if (m.result.isError) errorCount += 1;
  }
  const toolCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const summary = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const span = spanMs(members[0]!.at, members[members.length - 1]!.at);
  return {
    kind: 'toolGroup',
    key: `g-${members[0]!.key}`,
    turnId: members[0]!.turnId,
    at: members[0]!.at,
    items: members,
    toolCount,
    summary,
    errorCount,
    pending,
    spanMs: span,
  };
}

/** "123k" / "1.2M" — compact token counts for the meter and usage rows. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
