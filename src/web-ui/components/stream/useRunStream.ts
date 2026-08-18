/**
 * components/stream/useRunStream.ts — the engine behind live run streaming
 * (M416: "watch an agent work in real time"). Prefers a genuine push
 * channel — GET /api/run/:id/events (src/core/web/run-stream.ts), a per-run
 * SSE tail — and falls back to the original incremental-polling approach
 * against GET /api/run/:id when that route isn't there (older server) or
 * EventSource isn't available. See useRunStreamEvents.ts for the transport
 * and run-stream.ts's header comment for exactly what granularity the
 * source data actually supports (RunStep.summary, not raw model tokens —
 * this was never fabricated, only the DELIVERY changed from poll to push).
 *
 * Honesty contract (non-negotiable per the build brief, unchanged by adding
 * a push transport): this hook never reports 'live' when nothing has
 * actually changed for a while. On the polling fallback, phase flips to
 * 'stalled' after STALL_AFTER_MS with no observed change; on the SSE path,
 * the exact same signal is computed server-side (run-stream.ts's
 * RUN_STALL_AFTER_MS, same threshold) and pushed as an explicit `stall`
 * event instead of inferred client-side.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { runDetailQuery } from '../../data/queries.js';
import { ApiError } from '../../data/client.js';
import type { RunState } from '../../data/api-types.js';
import { useRunStreamEvents, type RunStreamChunk, type RunStreamOutputChunk } from './useRunStreamEvents.js';

/** Client poll cadence. The server's own disk-poll floor (SSE_POLL_MS,
 * src/core/web/api.ts:138) is ~1.5s — polling faster than that cannot
 * surface data any sooner, so this intentionally sits just above it rather
 * than implying a latency this API can't deliver. Only used on the polling
 * fallback path — the SSE path's tail interval is run-stream.ts's
 * RUN_TAIL_POLL_MS (500ms), server-side. */
export const RUN_STREAM_POLL_MS = 2000;

/** No observed change for 4 poll cycles (~8s) while status is 'running' —
 * long enough to absorb an ordinary quiet beat between steps, short enough
 * that a genuinely wedged run doesn't masquerade as live for minutes.
 * Mirrored server-side by run-stream.ts's RUN_STALL_AFTER_MS. */
const STALL_AFTER_MS = RUN_STREAM_POLL_MS * 4;

export type RunStreamPhase = 'connecting' | 'live' | 'stalled' | 'done' | 'not-found' | 'error';
export type RunStreamTransport = 'sse' | 'polling';

export interface RunStreamState {
  phase: RunStreamPhase;
  run: RunState | undefined;
  error: Error | undefined;
  /** When the run's own data last actually changed (step count / status / updatedAt). */
  lastChangedAt: number | null;
  /** When this hook last attempted a poll, regardless of whether anything changed. */
  lastPolledAt: number | null;
  /** Manually force an immediate poll (e.g. a "check now" affordance). */
  pollNow: () => void;
  /** Which transport is actually driving updates right now. */
  transport: RunStreamTransport;
  /** Live output chunks pushed over SSE (empty on the polling fallback — the
   * structured `run.steps` is still complete either way, this is purely the
   * append-only feed for a live output pane). */
  chunks: RunStreamChunk[];
  /** v333: live engine/model text tailed from the durable stream file — see
   * RunStreamOutputChunk. Empty on the polling fallback, same reasoning as
   * `chunks`: the polling path has no SSE frames to carry it. This is the
   * finer-than-step-boundary text the "live output pane" actually renders. */
  outputChunks: RunStreamOutputChunk[];
  /** Age (ms) of the server's most recent stall notice, when SSE-driven. */
  stallAgeMs: number | null;
}

function fingerprintOf(run: RunState | undefined): string | null {
  if (!run) return null;
  return `${run.status}:${run.steps.length}:${run.updatedAt}`;
}

export function useRunStream(runId: string): RunStreamState {
  const def = useMemo(() => runDetailQuery(runId), [runId]);
  const query = useQuery(def);
  const refetch = useRefetch(def);

  const [lastChangedAt, setLastChangedAt] = useState<number | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  const isTerminal = query.data ? query.data.status !== 'running' : false;
  const is404 = query.error instanceof ApiError && query.error.status === 404;

  // Attempt SSE for every non-terminal, non-404 run. Once the SSE hook
  // settles on 'unavailable' (older server, or EventSource unsupported) this
  // permanently falls back to polling for the life of this mount — it never
  // fights a route that plainly isn't there.
  const sseEnabled = !isTerminal && !is404;
  const events = useRunStreamEvents(runId, sseEnabled);
  const transport: RunStreamTransport = events.status === 'open' ? 'sse' : 'polling';

  const fingerprint = fingerprintOf(query.data);

  // Fires only when `fingerprint` actually changes identity (React's
  // dependency comparison, not a manual ref check) — i.e. only when the run
  // genuinely produced a new step, changed status, or bumped updatedAt.
  useEffect(() => {
    if (fingerprint !== null) setLastChangedAt(Date.now());
  }, [fingerprint]);

  // Polling fallback — only runs while SSE has not successfully opened.
  // Once transport flips to 'sse' this interval stops; if SSE later drops to
  // 'unavailable' the effect re-runs (transport dependency) and polling
  // resumes automatically.
  useEffect(() => {
    if (isTerminal || is404 || transport === 'sse') return;
    const interval = setInterval(() => {
      refetch();
      setLastPolledAt(Date.now());
      forceTick((n) => n + 1); // re-render so stalled-detection re-evaluates "now" even with no data change
    }, RUN_STREAM_POLL_MS);
    return () => clearInterval(interval);
  }, [refetch, isTerminal, is404, transport]);

  // SSE push -> refetch the structured run. `events.version` bumps on every
  // frame (step-started/step-output-chunk/step-done/stall/run-done); this is
  // the "push" half that makes the SSE path faster than the poll floor.
  useEffect(() => {
    if (transport !== 'sse' || events.version === 0) return;
    refetch();
    setLastPolledAt(Date.now());
  }, [events.version, transport, refetch]);

  // Server-pushed stall notice is only "fresh" for a bounded window — after
  // that, prefer re-evaluating from lastChangedAt like the polling path so a
  // client that missed a later non-stall frame (tab backgrounded, etc.)
  // doesn't get stuck showing a stale stall banner forever.
  const stallFreshMs = RUN_STREAM_POLL_MS * 6;
  const sseStallFresh =
    transport === 'sse' && events.stall !== null && Date.now() - events.stall.at < stallFreshMs;

  let phase: RunStreamPhase;
  if (is404) {
    phase = 'not-found';
  } else if (query.status === 'error' && query.data === undefined) {
    phase = 'error';
  } else if (query.status === 'loading') {
    phase = 'connecting';
  } else if (!query.data) {
    phase = 'connecting';
  } else if (query.data.status !== 'running') {
    phase = 'done';
  } else if (transport === 'sse') {
    phase = sseStallFresh ? 'stalled' : 'live';
  } else if (lastChangedAt !== null && Date.now() - lastChangedAt > STALL_AFTER_MS) {
    phase = 'stalled';
  } else {
    phase = 'live';
  }

  return {
    phase,
    run: query.data,
    error: query.error,
    lastChangedAt,
    lastPolledAt,
    pollNow: () => {
      refetch();
      setLastPolledAt(Date.now());
    },
    transport,
    chunks: events.chunks,
    outputChunks: events.outputChunks,
    stallAgeMs: sseStallFresh ? events.stall!.ageMs : null,
  };
}
