/**
 * routes/verse/autonomy/overnight-queries.ts — the one read and the one write
 * behind the Overnight panel: `GET /api/verse/overnight` and
 * `POST /api/verse/overnight`.
 *
 * Same contract as `control-queries.ts` and `fleet-queries.ts` — the read is a
 * QueryDef consumed through `useQuery` (cache-backed, so a poll never blanks a
 * populated panel); the write pulls the held mutation token from auth-store,
 * touches the hold on success, and invalidates exactly the keys it affects.
 * There is no new data layer here on purpose.
 *
 * TWO THINGS THAT ARE DELIBERATE:
 *
 *  1. **The read does not throw on absence.** The route does not exist yet —
 *     four owners are building the engine, the permit, the budgets and the
 *     local-only policy in parallel. A server without it answers 404, and 404
 *     means "this panel has no source yet", not "Autonomy is broken". It comes
 *     back as `OptionalFleetRead` (reused rather than re-declared, because two
 *     shapes for "a read that is allowed to be absent" would be one too many)
 *     and the panel renders a designed not-available state from `reason`.
 *     401 still propagates: an expired read session is an unauthorized state
 *     for the whole surface, not a missing panel.
 *
 *  2. **There is no pause route here, and there must not be one.** The halt
 *     this panel offers is the DAEMON-SCOPED pause — `~/.ashlr/daemon.paused`,
 *     via `runDaemonAction('pause')` in control-queries.ts. Disarming stops
 *     arming the next run; pausing stops the loop that is running now, and
 *     they are different questions. Neither is `stopDaemon()`, which is
 *     `setKill(true)` and therefore the emergency stop wearing a quieter name
 *     (see the header of DaemonControls.tsx).
 */
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { useRefetch } from '../../../data/hooks.js';
import { useEffect } from 'react';
import { VERSE_CONTROL_KEY, VerseControlLockedError } from './control-queries.js';
import type { OptionalFleetRead } from './fleet-contract.js';
import type {
  OvernightAction,
  OvernightActionResult,
  OvernightStatus,
  OvernightStopRule,
} from './overnight-contract.js';
import { projectOvernight } from './overnight-model.js';

export const VERSE_OVERNIGHT_KEY = 'verse-overnight';
export const OVERNIGHT_PATH = '/api/verse/overnight';

function describeAbsence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      // A missing route — not a run that refused to start.
      return 'Overnight runs are not available on this server.';
    }
    return `${OVERNIGHT_PATH} answered HTTP ${err.status}.`;
  }
  return `${OVERNIGHT_PATH} could not be reached.`;
}

/**
 * `GET /api/verse/overnight` — is a run armed, and what has it done.
 *
 * `value` is null both when the route was absent and when it answered
 * something this client could not narrow; `available` and `reason` are what
 * tell those two apart, and the panel words them differently.
 */
export const overnightQuery: QueryDef<OptionalFleetRead<OvernightStatus>> = {
  key: VERSE_OVERNIGHT_KEY,
  fetch: async (signal) => {
    try {
      const raw = await apiGet<unknown>(OVERNIGHT_PATH, signal);
      const value = projectOvernight(raw);
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
      return { value: null, available: false, reason: describeAbsence(err) };
    }
  },
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

function invalidateOvernight(): void {
  invalidate(VERSE_OVERNIGHT_KEY);
  // Arming changes what the daemon will do next, and the control snapshot is
  // what the rest of the cockpit reads that from.
  invalidate(VERSE_CONTROL_KEY);
}

/** Arm an overnight run with exactly one stop rule. */
export async function armOvernight(stopRule: OvernightStopRule): Promise<OvernightActionResult> {
  const body: OvernightAction = { action: 'arm', stopRule };
  const result = await post<OvernightActionResult>(OVERNIGHT_PATH, body);
  invalidateOvernight();
  return result;
}

/**
 * Disarm: no further overnight run starts.
 *
 * This is NOT the halt. It stops the arrangement, not the loop — a run already
 * in flight keeps going until it is paused. The panel says so at the click.
 */
export async function disarmOvernight(): Promise<OvernightActionResult> {
  const body: OvernightAction = { action: 'disarm' };
  const result = await post<OvernightActionResult>(OVERNIGHT_PATH, body);
  invalidateOvernight();
  return result;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Slower than the fleet's 4s: an overnight run's counters move on the scale of
 * whole iterations, and the thing an operator watches second by second (the
 * elapsed clock and the countdown) is derived locally from `useNow`.
 */
export const OVERNIGHT_POLL_MS = 15_000;

/**
 * Keep the overnight status live while a run is armed and the tab is visible.
 *
 * Only while armed: a disarmed panel has one boolean to report and polling it
 * every fifteen seconds forever would be pure waste. Hidden tabs stop the
 * timer and take one immediate reading when they come back, so a panel
 * returned to in the morning is current on the first frame.
 */
export function useOvernightPolling(armed: boolean, intervalMs: number = OVERNIGHT_POLL_MS): void {
  const refetch = useRefetch(overnightQuery);

  useEffect(() => {
    if (!armed) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(refetch, intervalMs);
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
      refetch();
      start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [armed, intervalMs, refetch]);
}
