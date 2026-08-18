/**
 * components/stream/useRunStreamEvents.ts — the SSE transport half of live
 * run streaming. Opens one EventSource per mounted run against
 * `GET /api/run/:id/events` (src/core/web/run-stream.ts) and exposes the
 * frames it receives.
 *
 * This hook does NOT reconstruct a full RunState from events — the server
 * event protocol intentionally carries only the new slice per tick (see
 * run-stream.ts's header comment for exactly why: RunStep.summary is the
 * finest real granularity available without engine changes, there is no
 * token stream). The full structured run (steps/tasks/usage/status) still
 * comes from the existing GET /api/run/:id query cache; useRunStream.ts
 * composes this hook with that query, using SSE frames as a push-triggered
 * refetch signal instead of useRunStream's old fixed 2s poll, and using the
 * server's own `stall` events instead of client-inferred staleness.
 *
 * Fallback contract: if the endpoint doesn't exist (older server — 404/400/
 * 503 before the connection ever reaches 'open'), or EventSource itself
 * isn't available, `status` settles to 'unavailable' and the caller is
 * expected to fall back to polling. It never retries forever against a
 * route that plainly isn't there.
 */
import { useEffect, useState } from 'react';
import { getReadClientProof } from '../../data/auth-store.js';

export interface RunStreamChunk {
  seq: number;
  taskId: string;
  kind: string;
  index: number;
  ts: string;
  text: string;
}

export interface RunStreamTaskStarted {
  seq: number;
  taskId: string;
  index: number;
  goal: string;
}

export interface RunStreamDoneEvent {
  status: string;
  result: string | null;
  terminationReason: string | null;
}

export type SseTransportStatus = 'connecting' | 'open' | 'unavailable';

export interface RunStreamEventsState {
  status: SseTransportStatus;
  chunks: RunStreamChunk[];
  starts: RunStreamTaskStarted[];
  stall: { ageMs: number; at: number } | null;
  runDone: RunStreamDoneEvent | null;
  /** Increments on every received frame — a cheap effect dependency for
   * "something changed, go refetch the structured run now". */
  version: number;
}

const INITIAL_STATE: RunStreamEventsState = {
  status: 'connecting',
  chunks: [],
  starts: [],
  stall: null,
  runDone: null,
  version: 0,
};

function parseEventData<T>(evt: Event): T | null {
  const messageEvent = evt as MessageEvent<string>;
  try {
    return JSON.parse(messageEvent.data) as T;
  } catch {
    return null;
  }
}

/** @param enabled skip opening a connection entirely (e.g. run already terminal, or caller has already fallen back to polling). */
export function useRunStreamEvents(runId: string, enabled: boolean): RunStreamEventsState {
  const [state, setState] = useState<RunStreamEventsState>(INITIAL_STATE);

  useEffect(() => {
    if (!enabled) {
      setState(INITIAL_STATE);
      return;
    }
    setState(INITIAL_STATE);

    if (typeof EventSource === 'undefined') {
      setState((s) => ({ ...s, status: 'unavailable' }));
      return;
    }

    const url = `/api/run/${encodeURIComponent(runId)}/events?client=${encodeURIComponent(getReadClientProof())}`;
    const source = new EventSource(url, { withCredentials: true });

    source.onopen = () => {
      setState((s) => (s.status === 'unavailable' ? s : { ...s, status: 'open' }));
    };

    // A route the server doesn't recognize (older build) or a rejected
    // connection (bad/expired session, invalid run id, connection cap)
    // answers with a plain JSON error, not an event-stream — the browser
    // surfaces that as an error with no preceding 'open'. Treat "errored
    // before ever opening" as permanently unavailable for this mount rather
    // than retrying indefinitely; a transient error AFTER a successful open
    // is left to EventSource's own built-in reconnect.
    source.onerror = () => {
      setState((s) => (s.status === 'open' ? s : { ...s, status: 'unavailable' }));
    };

    source.addEventListener('step-started', (evt) => {
      const data = parseEventData<RunStreamTaskStarted>(evt);
      if (!data) return;
      setState((s) => ({ ...s, starts: [...s.starts, data], version: s.version + 1 }));
    });

    source.addEventListener('step-output-chunk', (evt) => {
      const data = parseEventData<RunStreamChunk>(evt);
      if (!data) return;
      setState((s) => ({ ...s, chunks: [...s.chunks, data], version: s.version + 1 }));
    });

    source.addEventListener('step-done', () => {
      setState((s) => ({ ...s, stall: null, version: s.version + 1 }));
    });

    source.addEventListener('stall', (evt) => {
      const data = parseEventData<{ ageMs: number }>(evt);
      if (!data) return;
      setState((s) => ({ ...s, stall: { ageMs: data.ageMs, at: Date.now() }, version: s.version + 1 }));
    });

    source.addEventListener('run-done', (evt) => {
      const data = parseEventData<RunStreamDoneEvent>(evt);
      setState((s) => ({
        ...s,
        runDone: data ?? { status: 'done', result: null, terminationReason: null },
        stall: null,
        version: s.version + 1,
      }));
    });

    return () => {
      source.close();
    };
  }, [runId, enabled]);

  return state;
}
