/**
 * core/web/run-stream.ts — GET /api/run/:id/events: a per-run SSE tail.
 *
 * WHY THIS FILE EXISTS (the honest version):
 *
 * There is no raw stdout/token stream persisted to disk anywhere in this
 * codebase. Confirmed by tracing every candidate:
 *   - StreamSink (src/core/run/streaming.ts:20) carries live model-delta
 *     text, but it is relayed in-process only (makeCliSink writes straight
 *     to process.stderr/stdout — src/core/run/streaming.ts:46-57). Web/daemon
 *     runs pass no sink at all (defaults to nullSink()), so this text never
 *     exists outside the CLI process that happened to launch a run.
 *   - ~/.ashlr/agent-logs/*.jsonl (src/core/run/agent-diagnostics.ts) is
 *     metadata-only (byte/line COUNTS, never the text itself — see
 *     AgentDiagnosticTextShape, agent-diagnostics.ts:126-130) and is appended
 *     once per engine attempt, at completion, not during execution.
 *   - RunState.steps[].summary (src/core/types.ts:1928-1939) IS real,
 *     human-readable text, and IS the thing that grows on disk WHILE a run
 *     executes: every task/tool/model/synthesize step appends one entry via
 *     saveRun() (src/core/run/orchestrator.ts:1201, atomic write at :1271),
 *     called at every step-completion boundary (e.g. :3103, :3160, :3168)
 *     AND when a task first transitions to 'running' (:3294-3297, saved at
 *     :3297) — which is a real, disk-persisted "this task just started"
 *     signal that predates its own first step.
 *
 * So ~/.ashlr/runs/<id>.json (loadRun()/saveRun(), orchestrator.ts) is the
 * only genuinely live-growing, tailable source available without changing
 * any engine. This route does not fabricate finer granularity than that: a
 * "step-output-chunk" here is one already-written RunStep.summary, not a
 * model token. What IS genuinely new relative to polling GET /api/run/:id
 * (src/web-ui/components/stream/useRunStream.ts) is delivery: push instead
 * of poll, a tighter server-side tail interval (RUN_TAIL_POLL_MS, 500ms vs.
 * the client's previous 2000ms / the general SSE route's 1500ms), a
 * monotonic resumable sequence id, and server-computed stall detection
 * pushed the instant it's true instead of inferred client-side after several
 * missed polls.
 *
 * EVENT PROTOCOL
 *   id: <seq>                 present on every resumable event (see below)
 *   event: step-started       a RunTask left 'pending' — {taskId, index, goal}
 *   event: step-output-chunk  a RunStep appended     — {taskId, kind, index, ts, text}
 *   event: step-done          same RunStep, again     — {taskId, kind, index, ts, usage}
 *   event: run-done           RunState.status left 'running' — {status, result, terminationReason};
 *                              the stream ends cleanly right after this frame
 *   event: stall               (no id — not part of the resumable cursor) the
 *                              source hasn't grown in >= RUN_STALL_AFTER_MS — {ageMs}
 *
 * SEQUENCE / RESUME
 * Sequence ids are computed deterministically from array position, in two
 * fixed, non-overlapping ranges, so a reconnect with `Last-Event-ID` can be
 * served correctly just by re-deriving the same numbers from the current
 * on-disk state and skipping anything <= that id — no per-connection replay
 * log needs to be kept:
 *   [0, STEP_SEQ_BASE)           one id per started task, by tasks[] index
 *   [STEP_SEQ_BASE, +Infinity)   two ids per RunStep (chunk, done), by
 *                                 steps[] index — pinned to a fixed base so a
 *                                 later-appended task can never shift ids
 *                                 already sent for earlier steps
 *   run-done reuses the next free id in the step range once steps stop
 *   growing (status is terminal by construction at that point).
 *
 * SECURITY
 *  - Read-only. No path traversal: `id` is validated against RUN_ID_RE
 *    (mirrors src/core/run/orchestrator.ts:327's runFilePath() grammar)
 *    BEFORE loadRun() ever builds a path, and again defensively here even
 *    though the caller (api.ts) already matched the same shape via
 *    RUN_EVENTS_PATH_RE.
 *  - Every payload passes through sanitizePublicJson() (src/core/util/
 *    public-json.ts), same as the general SSE route's sendNamed() — this
 *    scrubs secret-shaped substrings (scrubSecrets(), src/core/util/
 *    scrub.ts) AND redacts concrete home-dir paths from every string in the
 *    event, so an engine echoing an env var into a step summary cannot leak
 *    it onto the wire.
 *  - Shares the general SSE route's connection cap (sseConnectionCapReached()
 *    / registerSse() / deregisterSse(), src/core/web/api.ts) — one pool, not
 *    a second unbounded one.
 *  - Streams from the freshly-loaded RunState on each tick (loadRun() reads
 *    the whole small JSON record — MAX_PERSISTED_RUN_BYTES-bounded in
 *    orchestrator.ts) and only ever writes the NEW slice since last tick;
 *    it never slurps or buffers unbounded history growth.
 *  - Auth: identical read-session boundary as every other GET /api/* route
 *    (src/core/web/server.ts, gated before handleApi is even reached), plus
 *    the same EventSource query-proof allowance as /api/events (server.ts's
 *    isSseQueryProofPath()) since a browser EventSource cannot set the
 *    x-ashlr-read-client header.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunState, RunTask } from '../types.js';
import { loadRun } from '../run/orchestrator.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { registerSse, deregisterSse, sseConnectionCapReached, sendJson } from './api.js';

// ---------------------------------------------------------------------------
// Route matching / run-id grammar
// ---------------------------------------------------------------------------

/** Mirrors src/core/run/orchestrator.ts:327's runFilePath() validation exactly. */
const RUN_ID_RE = /^[\w.-]{1,200}$/;

/**
 * Matches the full route (used by api.ts's dispatcher to extract the id).
 * Deliberately loose on the id segment — same shape as the existing
 * `path.startsWith('/api/run/')` handling for GET /api/run/:id — so that an
 * id shaped wrong for RUN_ID_RE (traversal attempt, stray characters,
 * percent-encoded slash smuggling, etc.) still reaches handleRunEventsSse()
 * and gets a real, testable 400 there instead of silently 404ing at the
 * router. RUN_ID_RE is the one gate that actually decides safety; this is
 * only routing.
 */
export const RUN_EVENTS_PATH_RE = /^\/api\/run\/([^/]+)\/events$/;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Tight-but-sane: this is localhost, and the whole point is beating the
 * general SSE route's 1500ms poll floor for a single run the operator is
 * actively watching. */
const RUN_TAIL_POLL_MS = 500;

/** Matches the honesty threshold the client already used when this was
 * poll-only (src/web-ui/components/stream/useRunStream.ts's STALL_AFTER_MS)
 * — moving the computation server-side doesn't mean moving the goalposts. */
const RUN_STALL_AFTER_MS = 8_000;

/** Once stalled, don't re-announce every 500ms tick — repeat at a calmer
 * cadence with a fresh age so the client never needs its own timer to keep
 * the banner's "Ns" text honest. */
const RUN_STALL_REPEAT_MS = 5_000;

/** Fixed, generous ceiling reserved for task-started ids. Step ids are
 * pinned to this base regardless of how many tasks a run ends up with, so a
 * task appearing later can never shift a step id already sent to a client. */
const STEP_SEQ_BASE = 1_000_000;

// ---------------------------------------------------------------------------
// Deterministic sequence numbering
// ---------------------------------------------------------------------------

function taskStartedSeq(taskIndex: number): number {
  return Math.min(taskIndex, STEP_SEQ_BASE - 1);
}

function stepChunkSeq(stepIndex: number): number {
  return STEP_SEQ_BASE + stepIndex * 2;
}

function stepDoneSeq(stepIndex: number): number {
  return STEP_SEQ_BASE + stepIndex * 2 + 1;
}

function runDoneSeq(stepCount: number): number {
  return STEP_SEQ_BASE + stepCount * 2;
}

type Sender = (seq: number, event: string, data: unknown) => void;

/**
 * Emit every event whose deterministic seq is > lastSeq, given the CURRENT
 * on-disk RunState. Returns the highest seq actually emitted (or lastSeq
 * unchanged if nothing new was found this tick).
 */
function emitNewEvents(run: RunState, lastSeq: number, send: Sender): number {
  let maxSeq = lastSeq;

  run.tasks.forEach((task: RunTask, i: number) => {
    if (task.status === 'pending') return;
    const seq = taskStartedSeq(i);
    if (seq <= lastSeq) return;
    send(seq, 'step-started', { taskId: task.id, index: i, goal: task.goal });
    if (seq > maxSeq) maxSeq = seq;
  });

  run.steps.forEach((step, j) => {
    const chunkSeq = stepChunkSeq(j);
    if (chunkSeq > lastSeq) {
      send(chunkSeq, 'step-output-chunk', {
        taskId: step.taskId,
        kind: step.kind,
        index: j,
        ts: step.ts,
        text: step.summary,
      });
      if (chunkSeq > maxSeq) maxSeq = chunkSeq;
    }
    const doneSeq = stepDoneSeq(j);
    if (doneSeq > lastSeq) {
      send(doneSeq, 'step-done', {
        taskId: step.taskId,
        kind: step.kind,
        index: j,
        ts: step.ts,
        usage: step.usage ?? null,
      });
      if (doneSeq > maxSeq) maxSeq = doneSeq;
    }
  });

  if (run.status !== 'running') {
    const seq = runDoneSeq(run.steps.length);
    if (seq > lastSeq) {
      send(seq, 'run-done', {
        status: run.status,
        result: run.result ?? null,
        terminationReason: run.terminationReason ?? null,
      });
      if (seq > maxSeq) maxSeq = seq;
    }
  }

  return maxSeq;
}

// ---------------------------------------------------------------------------
// Growth / stall detection
// ---------------------------------------------------------------------------

interface ProgressSnapshot {
  startedTasks: number;
  steps: number;
  status: RunState['status'];
  updatedAt: string;
}

function progressOf(run: RunState): ProgressSnapshot {
  return {
    startedTasks: run.tasks.filter((t) => t.status !== 'pending').length,
    steps: run.steps.length,
    status: run.status,
    updatedAt: run.updatedAt,
  };
}

function progressEqual(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return (
    a.startedTasks === b.startedTasks
    && a.steps === b.steps
    && a.status === b.status
    && a.updatedAt === b.updatedAt
  );
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function singleHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? (raw[0] ?? '') : '';
  return raw ?? '';
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = singleHeader(req, 'last-event-id');
  if (!raw) return -1;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= -1 ? n : -1;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/run/:id/events. Synchronous entry point (loadRun() is
 * synchronous); the SSE lifecycle itself is driven by a bounded poll timer,
 * torn down on run completion, client disconnect, or server shutdown (via
 * the shared registerSse()/drainSseConnections() registry in api.ts).
 */
export function handleRunEventsSse(req: IncomingMessage, res: ServerResponse, rawId: string): void {
  const id = rawId;
  if (!RUN_ID_RE.test(id)) {
    sendJson(res, 400, { error: 'invalid run id' });
    return;
  }

  const initial = loadRun(id);
  if (!initial) {
    sendJson(res, 404, { error: `run not found: ${id}` });
    return;
  }

  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    res.write(': connected\n\n');
  } catch {
    return; // Socket already gone.
  }

  function send(seq: number, event: string, data: unknown): void {
    try {
      const line = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(sanitizePublicJson(data))}\n\n`;
      res.write(line);
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
    }
  }

  function sendStall(ageMs: number): void {
    try {
      const line = `event: stall\ndata: ${JSON.stringify(sanitizePublicJson({ ageMs }))}\n\n`;
      res.write(line);
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
    }
  }

  let lastSeq = parseLastEventId(req);
  let lastProgress = progressOf(initial);
  let lastGrowthAt = Date.now();
  let stallLastEmitAt: number | null = null;
  let ended = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let sseId: string | undefined;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    if (intervalId !== undefined) clearInterval(intervalId);
    if (sseId !== undefined) deregisterSse(sseId);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  };

  const tick = (): void => {
    if (ended) return;
    const fresh = loadRun(id);
    if (!fresh) return; // Transient unreadable state; try again next tick.

    lastSeq = emitNewEvents(fresh, lastSeq, send);

    const progress = progressOf(fresh);
    if (!progressEqual(progress, lastProgress)) {
      lastProgress = progress;
      lastGrowthAt = Date.now();
      stallLastEmitAt = null;
    } else if (fresh.status === 'running') {
      const ageMs = Date.now() - lastGrowthAt;
      if (
        ageMs >= RUN_STALL_AFTER_MS
        && (stallLastEmitAt === null || Date.now() - stallLastEmitAt >= RUN_STALL_REPEAT_MS)
      ) {
        sendStall(ageMs);
        stallLastEmitAt = Date.now();
      }
    }

    if (fresh.status !== 'running') {
      finish();
    }
  };

  // Replay everything from lastSeq (the full history if this is a fresh
  // connection, i.e. Last-Event-ID absent) immediately.
  lastSeq = emitNewEvents(initial, lastSeq, send);

  if (initial.status !== 'running') {
    // Already finished by the time this connected — history (and run-done,
    // via emitNewEvents above) is sent; close cleanly, no polling needed.
    finish();
    return;
  }

  intervalId = setInterval(tick, RUN_TAIL_POLL_MS);
  sseId = registerSse(finish);

  req.on('close', finish);
  req.on('error', finish);
}
