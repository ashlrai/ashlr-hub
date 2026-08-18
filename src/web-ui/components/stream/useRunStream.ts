/**
 * components/stream/useRunStream.ts — the polling engine behind live run
 * streaming (M416: "watch an agent work in real time"). There is no
 * per-run SSE channel or raw-stdout endpoint on the backend (confirmed by
 * reading src/core/web/api.ts's full route table — GET /api/run/:id is the
 * only per-run read, and it returns the same structured RunState the run
 * writes to disk on every step, not a raw log tail). This hook is the
 * "best available approximation" the brief asked for when true streaming
 * isn't backed by the API: fast incremental polling of GET /api/run/:id,
 * diffing `steps`/`status` to detect real change, and being explicit about
 * both the polling cadence and the server's own floor.
 *
 * Honesty contract (non-negotiable per the build brief): this hook never
 * reports 'live' when nothing has actually changed for a while. Once a
 * running run goes STALL_AFTER_MS without an observed change to its step
 * count, status, or updatedAt, phase flips to 'stalled' — the UI must show
 * that, not keep rendering the last steps as if they were still fresh.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { runDetailQuery } from '../../data/queries.js';
import { ApiError } from '../../data/client.js';
import type { RunState } from '../../data/api-types.js';

/** Client poll cadence. The server's own disk-poll floor (SSE_POLL_MS,
 * src/core/web/api.ts:138) is ~1.5s — polling faster than that cannot
 * surface data any sooner, so this intentionally sits just above it rather
 * than implying a latency this API can't deliver. */
export const RUN_STREAM_POLL_MS = 2000;

/** No observed change for 4 poll cycles (~8s) while status is 'running' —
 * long enough to absorb an ordinary quiet beat between steps, short enough
 * that a genuinely wedged run doesn't masquerade as live for minutes. */
const STALL_AFTER_MS = RUN_STREAM_POLL_MS * 4;

export type RunStreamPhase = 'connecting' | 'live' | 'stalled' | 'done' | 'not-found' | 'error';

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

  const fingerprint = fingerprintOf(query.data);

  // Fires only when `fingerprint` actually changes identity (React's
  // dependency comparison, not a manual ref check) — i.e. only when the run
  // genuinely produced a new step, changed status, or bumped updatedAt.
  useEffect(() => {
    if (fingerprint !== null) setLastChangedAt(Date.now());
  }, [fingerprint]);

  const isTerminal = query.data ? query.data.status !== 'running' : false;
  const is404 = query.error instanceof ApiError && query.error.status === 404;

  useEffect(() => {
    if (isTerminal || is404) return;
    const interval = setInterval(() => {
      refetch();
      setLastPolledAt(Date.now());
      forceTick((n) => n + 1); // re-render so stalled-detection re-evaluates "now" even with no data change
    }, RUN_STREAM_POLL_MS);
    return () => clearInterval(interval);
  }, [refetch, isTerminal, is404]);

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
  };
}
