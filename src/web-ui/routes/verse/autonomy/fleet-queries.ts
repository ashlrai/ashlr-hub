/**
 * routes/verse/autonomy/fleet-queries.ts — the reads and writes behind the
 * local-fleet surfaces: `GET/POST /api/verse/runtime`,
 * `GET/POST /api/verse/local-only`, and `GET /api/verse/fleet`.
 *
 * Same contract as control-queries.ts — reads are QueryDefs consumed through
 * useQuery, writes go through the mutation-token gate and invalidate exactly
 * the keys they affect — with two differences that both come from these three
 * routes landing in parallel with this surface (owners R, L, F):
 *
 *  1. **The reads do not throw on absence.** A server without these routes
 *     answers 404, and a 404 means "this panel has no source yet", not
 *     "Autonomy is broken". The panels render a designed degraded state from
 *     `OptionalFleetRead.reason`. 401 still propagates: an expired read
 *     session is an unauthorized state for the whole surface.
 *  2. **The bodies are narrowed structurally, not cast.** `fleet-model.ts`
 *     projects every field, so a name drift between the route and this client
 *     degrades to "unknown" rather than throwing at render time.
 *
 * Polling: the fleet and the runtime are the two things on this screen that
 * change while nobody clicks anything, and neither has an SSE event yet, so
 * `useFleetPolling` re-reads them on an interval — pausing while the tab is
 * hidden, because a background tab polling a runtime probe is pure waste.
 */
import { useEffect } from 'react';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { useRefetch } from '../../../data/hooks.js';
import { VERSE_CONTROL_KEY, VerseControlLockedError } from './control-queries.js';
import type {
  FleetSnapshot,
  LocalOnlyPolicy,
  LocalOnlyUpdateResult,
  OptionalFleetRead,
  RuntimeAction,
  RuntimeActionResult,
  ServingRuntimeSnapshot,
} from './fleet-contract.js';
import { projectFleet, projectLocalOnly, projectServingRuntime } from './fleet-model.js';

export const VERSE_RUNTIME_KEY = 'verse-runtime';
export const VERSE_FLEET_KEY = 'verse-fleet';
export const VERSE_LOCAL_ONLY_KEY = 'verse-local-only';

function describeAbsence(path: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      // A missing route — never read as an idle machine.
      return `This server doesn't have ${path}.`;
    }
    return `${path} answered HTTP ${err.status}.`;
  }
  return `${path} could not be reached.`;
}

/**
 * One optional read, projected. `value` is null both when the route was absent
 * and when it answered something this client could not narrow — `available`
 * and `reason` are what tell the two apart.
 */
function optionalRead<T>(
  path: string,
  project: (raw: unknown) => T | null,
): (signal?: AbortSignal) => Promise<OptionalFleetRead<T>> {
  return async (signal) => {
    try {
      const raw = await apiGet<unknown>(path, signal);
      const value = project(raw);
      if (value === null) {
        return {
          value: null,
          available: true,
          // Nothing is shown rather than guessed from an unknown shape.
          reason: 'Unrecognized response — update Ashlr.',
        };
      }
      return { value, available: true, reason: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { value: null, available: false, reason: describeAbsence(path, err) };
    }
  };
}

/** GET /api/verse/runtime — is the serving runtime up, and what can it do. */
export const servingRuntimeQuery: QueryDef<OptionalFleetRead<ServingRuntimeSnapshot>> = {
  key: VERSE_RUNTIME_KEY,
  fetch: optionalRead('/api/verse/runtime', projectServingRuntime),
};

/** GET /api/verse/fleet — the agents in flight right now. */
export const fleetQuery: QueryDef<OptionalFleetRead<FleetSnapshot>> = {
  key: VERSE_FLEET_KEY,
  fetch: optionalRead('/api/verse/fleet', projectFleet),
};

/** GET /api/verse/local-only — the refusal policy and what it refuses. */
export const localOnlyQuery: QueryDef<OptionalFleetRead<LocalOnlyPolicy>> = {
  key: VERSE_LOCAL_ONLY_KEY,
  fetch: optionalRead('/api/verse/local-only', projectLocalOnly),
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/**
 * Start / stop / restart the serving runtime.
 *
 * Every one of these changes what the fleet can do, so all three fleet keys
 * and the control snapshot are invalidated together — a restarted runtime
 * with a stale slot count beside it is exactly the disagreement this surface
 * exists to prevent.
 */
export async function runRuntimeAction(action: RuntimeAction): Promise<RuntimeActionResult> {
  const result = await post<RuntimeActionResult>('/api/verse/runtime', { action });
  invalidate(VERSE_RUNTIME_KEY);
  invalidate(VERSE_FLEET_KEY);
  invalidate(VERSE_CONTROL_KEY);
  return result;
}

/** Turn the local-only refusal on or off. */
export async function setLocalOnly(enabled: boolean): Promise<LocalOnlyUpdateResult> {
  const result = await post<LocalOnlyUpdateResult>('/api/verse/local-only', { enabled });
  invalidate(VERSE_LOCAL_ONLY_KEY);
  invalidate(VERSE_CONTROL_KEY);
  return result;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Fast enough that "is it working" is answered live; slow enough to be free. */
export const FLEET_POLL_MS = 4000;

/**
 * Keep the runtime and fleet reads live while this section is mounted and the
 * tab is visible.
 *
 * Both routes probe a local process, so this is cheap — but only while someone
 * is looking. `visibilitychange` stops the timer when the tab is hidden and
 * takes one immediate reading when it comes back, so a fleet view returned to
 * after lunch is current on the first frame rather than up to an interval old.
 */
export function useFleetPolling(intervalMs: number = FLEET_POLL_MS): void {
  const refetchRuntime = useRefetch(servingRuntimeQuery);
  const refetchFleet = useRefetch(fleetQuery);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = (): void => {
      refetchRuntime();
      refetchFleet();
    };

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(tick, intervalMs);
    };

    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop();
        return;
      }
      tick();
      start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, refetchRuntime, refetchFleet]);
}
