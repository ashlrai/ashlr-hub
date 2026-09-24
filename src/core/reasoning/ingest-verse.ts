/**
 * Verse → reasoning store (V3.10, unit A7).
 *
 * Two ways in, one reducer:
 *
 *  1. LIVE TAP — `recordVerseReasoning(event, session)`, called by the session
 *     engine (unit A5, deferred via setImmediate) for persisted `thinking`,
 *     `tool-use` and `turn-done` events (any other event is accepted too).
 *     Synchronous, O(1) per event, never throws. Each `thinking` event
 *     becomes a ReasoningStepV1, written as soon as the NEXT event tells us
 *     which tool, if any, the reasoning led to — so live reasoning is
 *     searchable within the turn. Transient events (`thinking-delta` & co.)
 *     are ignored: the persisted `thinking` event is the durable record.
 *
 *  2. BACKFILL — `ingestVerseSessionLogs()` reads `~/.ashlr/verse/sessions/
 *     *.events.jsonl` and produces the TURN FEATURES for every closed turn
 *     (it sees tool results, errors and final messages, which the tap's event
 *     subset does not), plus the steps of any turn the tap never saw (history
 *     from before 3.10, or turns that ran while this process was down).
 *     Per-session cursors (last CLOSED turn's seq + file size/mtime) make it
 *     incremental; a still-open turn is re-read next pass, never half-written.
 *
 * Ids are deterministic (`verse:<sessionId>:<seq>` for steps,
 * `verse:<sessionId>:<turnId>` for features), so the rare overlap between tap
 * and backfill (a restart between the tap's write and the next backfill) is
 * de-duplicated by the store's readers.
 *
 * Tool evidence refs use the contract's event form `session:<id>#<seq>`.
 */

import { readdir, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyAgentDiagnosticError } from '../run/agent-diagnostics.js';
import { isTransientVerseEvent, type VerseEvent, type VerseSession } from '../verse/types.js';
import { TurnAccumulator, type ToolHandle, type TurnFeaturesV1 } from './extractors.js';
import {
  appendFeatures,
  appendSteps,
  appendStepsChunked,
  cleanLabel,
  readJsonl,
  readStoreState,
  reasoningRoot,
  writeStoreState,
} from './store.js';
import type { ReasoningOutcome, ReasoningStepKind, ReasoningStepV1 } from './types.js';

// ---------------------------------------------------------------------------
// Shared reducer
// ---------------------------------------------------------------------------

export interface VerseSessionMeta {
  id: string;
  engine: string;
  model: string | null;
  repo: string | null;
}

/** Only the session fields the tap reads, so a caller can pass a full VerseSession or a stub. */
export type VerseSessionLike = Pick<VerseSession, 'id' | 'engine' | 'model' | 'projectPath'>;

export function verseSessionMeta(session: VerseSessionLike): VerseSessionMeta {
  return {
    id: session.id,
    engine: session.engine,
    model: typeof session.model === 'string' && session.model !== '' ? session.model : null,
    repo: cleanLabel(session.projectPath, 512),
  };
}

interface OpenTurn {
  acc: TurnAccumulator;
  tools: Map<string, ToolHandle>;
  errorClass: string | null;
  errored: boolean;
  /** Last thinking step (and its seq), held until the next event tells us `toolAfter`. */
  pending: { step: ReasoningStepV1; seq: number } | null;
  /** Backfill mode: steps held until the turn closes. */
  buffered: ReasoningStepV1[];
  lastSeq: number;
  touchedMs: number;
}

export interface ReducerSink {
  steps(steps: ReasoningStepV1[]): void;
  feature(feature: TurnFeaturesV1): void;
}

const MAX_OPEN_TURNS_PER_SESSION = 8;
const MAX_TOOL_HANDLES = 2_000;

function stepKind(event: Extract<VerseEvent, { type: 'thinking' }>): ReasoningStepKind {
  if (event.kind === 'summary') return 'summary';
  if (event.kind === 'progress') return 'progress';
  return 'thinking';
}

function errorClassOf(event: Extract<VerseEvent, { type: 'error' }>): string | null {
  if (typeof event.code === 'string' && event.code !== '') return event.code;
  const cls = classifyAgentDiagnosticError(event.message);
  return cls === 'none' ? null : cls;
}

/**
 * Folds one session's events into steps + turn features. `bufferSteps`
 * (backfill) holds a turn's steps until the turn closes; live mode writes
 * each step as soon as its `toolAfter` is known.
 */
export class VerseSessionReducer {
  readonly meta: VerseSessionMeta;
  private readonly sink: ReducerSink;
  private readonly bufferSteps: boolean;
  private readonly emitFeatures: boolean;
  private readonly stepsBelowSeq: number;
  private readonly turns = new Map<string, OpenTurn>();
  /** Seq of the newest event that CLOSED a turn (cursor for the backfill). */
  lastClosedSeq = 0;

  constructor(
    meta: VerseSessionMeta,
    sink: ReducerSink,
    options: { bufferSteps?: boolean; emitFeatures?: boolean; stepsBelowSeq?: number } = {},
  ) {
    this.meta = meta;
    this.sink = sink;
    this.bufferSteps = options.bufferSteps === true;
    this.emitFeatures = options.emitFeatures !== false;
    this.stepsBelowSeq = options.stepsBelowSeq ?? Number.POSITIVE_INFINITY;
  }

  get openTurns(): number {
    return this.turns.size;
  }

  private emitStep(turn: OpenTurn, step: ReasoningStepV1, seq: number): void {
    // Steps at/after `stepsBelowSeq` were already written by the live tap.
    if (seq >= this.stepsBelowSeq) return;
    if (this.bufferSteps) turn.buffered.push(step);
    else this.sink.steps([step]);
  }

  private flushPending(turn: OpenTurn, toolAfter: string | null): void {
    if (!turn.pending) return;
    const step = { ...turn.pending.step, toolAfter };
    const seq = turn.pending.seq;
    turn.pending = null;
    this.emitStep(turn, step, seq);
  }

  private open(turnId: string, at: string): OpenTurn {
    let turn = this.turns.get(turnId);
    if (turn) return turn;
    // A session only ever runs one turn at a time; more than a handful open
    // means turns that never saw turn-done (crash) — close the oldest.
    if (this.turns.size >= MAX_OPEN_TURNS_PER_SESSION) {
      const oldest = [...this.turns.entries()].sort((a, b) => a[1].touchedMs - b[1].touchedMs)[0];
      if (oldest) this.close(oldest[0], null, oldest[1].acc.lastAt, oldest[1].lastSeq);
    }
    turn = {
      acc: new TurnAccumulator({
        id: `verse:${this.meta.id}:${turnId}`,
        source: 'verse',
        sessionId: this.meta.id,
        runId: null,
        repo: this.meta.repo,
        engine: this.meta.engine,
        model: this.meta.model,
        turnId,
        startedAt: at,
      }),
      tools: new Map(),
      errorClass: null,
      errored: false,
      pending: null,
      buffered: [],
      lastSeq: 0,
      touchedMs: Date.now(),
    };
    this.turns.set(turnId, turn);
    return turn;
  }

  /** Close a turn: flush its steps and emit its feature row. */
  close(turnId: string, outcome: ReasoningOutcome | null, endedAt: string | null, seq: number): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    this.flushPending(turn, null);
    if (turn.buffered.length > 0) this.sink.steps(turn.buffered);
    const resolved = outcome ?? (turn.errored ? 'error' : null);
    if (this.emitFeatures) this.sink.feature(turn.acc.finish(resolved, endedAt, turn.errorClass));
    if (seq > this.lastClosedSeq) this.lastClosedSeq = seq;
  }

  /** Close every open turn with an unknown outcome (shutdown / idle sweep). */
  closeAll(): void {
    for (const [turnId, turn] of [...this.turns.entries()]) {
      this.close(turnId, null, turn.acc.lastAt, turn.lastSeq);
    }
  }

  /** Close turns idle longer than `idleMs` (a crashed CLI never sends turn-done). */
  closeIdle(nowMs: number, idleMs: number): void {
    for (const [turnId, turn] of [...this.turns.entries()]) {
      if (nowMs - turn.touchedMs > idleMs) this.close(turnId, null, turn.acc.lastAt, turn.lastSeq);
    }
  }

  /** Drop open turns without emitting anything (backfill: re-read next pass). */
  discardOpen(): void {
    this.turns.clear();
  }

  handle(event: VerseEvent, nowMs = Date.now()): void {
    if (isTransientVerseEvent(event)) return;
    const turnId = typeof event.turnId === 'string' ? event.turnId : null;
    if (turnId === null) return; // session-level events (compaction w/o turn, history-truncated…)

    switch (event.type) {
      case 'user-message':
      case 'turn-started': {
        const turn = this.open(turnId, event.at);
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        return;
      }
      case 'thinking': {
        const turn = this.open(turnId, event.at);
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        this.flushPending(turn, null);
        const redacted = event.redacted === true;
        turn.acc.addThinking(`verse:${this.meta.id}:${event.seq}`, event.at, event.text ?? '', redacted);
        turn.pending = { seq: event.seq, step: {
          v: 1,
          id: `verse:${this.meta.id}:${event.seq}`,
          source: 'verse',
          sessionId: this.meta.id,
          runId: null,
          repo: this.meta.repo,
          engine: this.meta.engine,
          model: this.meta.model,
          at: event.at,
          turnId,
          kind: stepKind(event),
          text: event.text ?? '',
          tokens: null,
          toolAfter: null,
          outcome: null,
        } };
        return;
      }
      case 'tool-use': {
        const turn = this.open(turnId, event.at);
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        this.flushPending(turn, event.name);
        const handle = turn.acc.addTool(`session:${this.meta.id}#${event.seq}`, event.at, event.name, event.input);
        if (turn.tools.size < MAX_TOOL_HANDLES) turn.tools.set(event.toolUseId, handle);
        return;
      }
      case 'tool-result': {
        const turn = this.turns.get(turnId);
        if (!turn) return;
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        this.flushPending(turn, null);
        const handle = turn.tools.get(event.toolUseId);
        if (handle !== undefined) {
          turn.acc.resolveTool(handle, event.isError !== true, event.at);
          turn.tools.delete(event.toolUseId);
        }
        return;
      }
      case 'assistant-message': {
        const turn = this.open(turnId, event.at);
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        this.flushPending(turn, null);
        turn.acc.addMessage(`session:${this.meta.id}#${event.seq}`, event.at, event.text ?? '');
        return;
      }
      case 'error': {
        const turn = this.turns.get(turnId);
        if (!turn) return;
        turn.touchedMs = nowMs;
        turn.lastSeq = event.seq;
        turn.errored = true;
        turn.errorClass ??= errorClassOf(event);
        return;
      }
      case 'turn-done':
        this.close(turnId, event.ok ? 'ok' : 'error', event.at, event.seq);
        return;
      case 'cancelled':
        this.close(turnId, 'cancelled', event.at, event.seq);
        return;
      default: {
        const turn = this.turns.get(turnId);
        if (turn) {
          turn.touchedMs = nowMs;
          turn.lastSeq = event.seq;
          this.flushPending(turn, null);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Live tap
// ---------------------------------------------------------------------------

interface TapEntry {
  reducer: VerseSessionReducer;
  firstSeq: number;
  touchedMs: number;
}

const MAX_TAPPED_SESSIONS = 64;
/** A turn with no event for this long is closed with an unknown outcome. */
const TURN_IDLE_MS = 6 * 60 * 60 * 1_000;
const SWEEP_EVERY_MS = 60_000;

const tapped = new Map<string, TapEntry>();
let lastSweepMs = 0;
let tapRoot: string | null = null;

/**
 * Live steps are queued and written in batches: one append costs ~1.3 ms of
 * syscalls (open/fstat/write/close) against ~0.08 ms per step in a batch, and
 * single appends spiked past 20 ms under load (measured, scratchpad a7/).
 * A crash can lose at most the last FLUSH_DELAY_MS of steps — and the
 * backfill re-derives those from the Verse event log after a restart.
 */
const FLUSH_DELAY_MS = 250;
const FLUSH_AT = 64;
let queue: ReasoningStepV1[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let exitHookInstalled = false;

function flushQueue(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  appendSteps(batch, tapRoot ?? reasoningRoot());
}

function enqueueSteps(steps: ReasoningStepV1[]): void {
  queue.push(...steps);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { try { flushQueue(); } catch { /* exiting */ } });
  }
  if (queue.length >= FLUSH_AT) {
    flushQueue();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { flushQueue(); } catch { /* never throw from a timer */ }
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

const liveSink: ReducerSink = {
  steps: enqueueSteps,
  feature: (feature) => { appendFeatures([feature], tapRoot ?? reasoningRoot()); },
};

function sweep(nowMs: number): void {
  if (nowMs - lastSweepMs < SWEEP_EVERY_MS) return;
  lastSweepMs = nowMs;
  for (const entry of tapped.values()) entry.reducer.closeIdle(nowMs, TURN_IDLE_MS);
}

/**
 * Engine tap (unit A5 calls this for every event it PERSISTS; transient
 * events are accepted and ignored). Never throws, never awaits.
 */
export function recordVerseReasoning(event: VerseEvent, session: VerseSessionLike): void {
  try {
    if (!event || !session || typeof session.id !== 'string' || isTransientVerseEvent(event)) return;
    const nowMs = Date.now();
    let entry = tapped.get(session.id);
    if (!entry) {
      if (tapped.size >= MAX_TAPPED_SESSIONS) {
        const oldest = [...tapped.entries()].sort((a, b) => a[1].touchedMs - b[1].touchedMs)[0];
        if (oldest) {
          oldest[1].reducer.closeAll();
          tapped.delete(oldest[0]);
        }
      }
      entry = {
        // Features come from the backfill, which sees the whole log (tool
        // results, errors, final messages) rather than the tap's subset.
        reducer: new VerseSessionReducer(verseSessionMeta(session), liveSink, { emitFeatures: false }),
        firstSeq: typeof event.seq === 'number' ? event.seq : 0,
        touchedMs: nowMs,
      };
      tapped.set(session.id, entry);
    }
    entry.touchedMs = nowMs;
    entry.reducer.handle(event, nowMs);
    sweep(nowMs);
  } catch {
    /* the reasoning store must never break a chat turn */
  }
}

/**
 * Write everything the tap holds: close every open tapped turn (outcome
 * unknown) and flush the step queue synchronously. For shutdown / crash
 * handlers (unit A5) and tests.
 */
export function flushVerseReasoning(): void {
  try {
    for (const entry of tapped.values()) entry.reducer.closeAll();
    flushQueue();
  } catch {
    /* best effort */
  }
}

/** Flush queued live steps without closing turns (tests, maintenance). */
export function flushVerseReasoningQueue(): void {
  try {
    flushQueue();
  } catch {
    /* best effort */
  }
}

/** First seq the live tap saw per session (the backfill leaves steps from there on to the tap). */
export function verseTapProgress(): Map<string, { firstSeq: number }> {
  const out = new Map<string, { firstSeq: number }>();
  for (const [id, entry] of tapped) out.set(id, { firstSeq: entry.firstSeq });
  return out;
}

/** Test hook: reset tap state and optionally pin the store root. */
export function resetVerseReasoningTap(root: string | null = null): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  queue = [];
  tapped.clear();
  lastSweepMs = 0;
  tapRoot = root;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

const CURSOR_NAME = 'verse-cursor';
const EVENTS_SUFFIX = '.events.jsonl';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SESSION_RECORD_BYTES = 1024 * 1024;
const MAX_SESSIONS_PER_RUN = 500;

interface VerseCursorEntry {
  size: number;
  mtimeMs: number;
  lastSeq: number;
}

interface VerseCursorState {
  v: 1;
  sessions: Record<string, VerseCursorEntry>;
}

export interface VerseBackfillOptions {
  /** Verse data root (default `~/.ashlr/verse`, same as the engine). */
  verseRoot?: string;
  /** Reasoning store root. */
  root?: string;
}

export interface VerseBackfillResult {
  sessionsScanned: number;
  sessionsChanged: number;
  steps: number;
  features: number;
}

export function defaultVerseRoot(): string {
  return join(homedir(), '.ashlr', 'verse');
}

async function readSessionRecord(path: string): Promise<VerseSessionLike | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_SESSION_RECORD_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<VerseSession>;
    if (typeof parsed.id !== 'string' || typeof parsed.engine !== 'string') return null;
    return {
      id: parsed.id,
      engine: parsed.engine,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : '',
    };
  } catch {
    return null;
  }
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Incrementally ingest Verse session logs the live tap did not cover. Never throws. */
export async function ingestVerseSessionLogs(options: VerseBackfillOptions = {}): Promise<VerseBackfillResult> {
  const root = options.root ?? reasoningRoot();
  const sessionsDir = join(options.verseRoot ?? defaultVerseRoot(), 'sessions');
  const result: VerseBackfillResult = { sessionsScanned: 0, sessionsChanged: 0, steps: 0, features: 0 };
  const prior = readStoreState<VerseCursorState>(CURSOR_NAME, root);
  const cursor: VerseCursorState = prior?.v === 1 && prior.sessions && typeof prior.sessions === 'object'
    ? prior
    : { v: 1, sessions: {} };
  const tap = verseTapProgress();

  let names: string[];
  try {
    names = (await readdir(sessionsDir)).filter((name) => name.endsWith(EVENTS_SUFFIX));
  } catch {
    return result;
  }
  const present = new Set<string>();
  for (const name of names.slice(0, MAX_SESSIONS_PER_RUN)) {
    const id = name.slice(0, -EVENTS_SUFFIX.length);
    if (!SESSION_ID_RE.test(id)) continue;
    present.add(id);
    result.sessionsScanned += 1;
    const eventsPath = join(sessionsDir, name);
    let stat;
    try {
      stat = await lstat(eventsPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const previous = cursor.sessions[id];
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
    const session = await readSessionRecord(join(sessionsDir, `${id}.json`));
    if (!session) continue;
    result.sessionsChanged += 1;
    const floor = previous?.lastSeq ?? 0;
    // In this process the tap already wrote the steps from its first seq on.
    const tapped = tap.get(id);

    const batchSteps: ReasoningStepV1[] = [];
    const batchFeatures: TurnFeaturesV1[] = [];
    const reducer = new VerseSessionReducer(verseSessionMeta(session), {
      steps: (steps) => { batchSteps.push(...steps); },
      feature: (feature) => { batchFeatures.push(feature); },
    }, { bufferSteps: true, ...(tapped ? { stepsBelowSeq: tapped.firstSeq } : {}) });
    reducer.lastClosedSeq = floor;
    await readJsonl(eventsPath, (row) => {
      const event = row as VerseEvent;
      if (!event || typeof event.seq !== 'number' || typeof event.type !== 'string') return;
      if (event.seq <= floor) return;
      reducer.handle(event, 0);
    });
    // Open (unfinished) turns are re-read next pass from `lastClosedSeq`.
    reducer.discardOpen();
    const lastSeq = reducer.lastClosedSeq;
    result.steps += await appendStepsChunked(batchSteps, root);
    result.features += appendFeatures(batchFeatures, root);
    cursor.sessions[id] = { size: stat.size, mtimeMs: stat.mtimeMs, lastSeq };
    await yieldToLoop();
  }
  // Forget cursors for deleted sessions so the state file cannot grow forever.
  for (const id of Object.keys(cursor.sessions)) {
    if (!present.has(id)) delete cursor.sessions[id];
  }
  writeStoreState(CURSOR_NAME, cursor, root);
  return result;
}
