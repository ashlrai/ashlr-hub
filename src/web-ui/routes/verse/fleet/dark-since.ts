/**
 * routes/verse/fleet/dark-since.ts — the ONE "Fleet dark since …" (3.10.1).
 *
 * 3.10.0 said it three ways: Command and Fleet took the live snapshot's
 * `lastActivityAt` ("Sep 1"), Growth took fleet history's `darkSince` ("Aug
 * 18"), and Command fell back to history whenever the live read was not dark.
 * Those are two different facts:
 *
 *   dark since   — autonomy is shut (no standing grant, or no daemon) and
 *                  the fleet last showed any sign of life then. Served once,
 *                  as `FleetLiveSnapshotV1.darkSince` (core/verse/
 *                  fleet-live-api.ts `fleetDarkSince`). Only this value may be
 *                  worded "Fleet dark since …".
 *   quiet since  — fleet history's `darkSince`: the last run started or
 *                  proposal filed. Worded "No fleet runs or proposals since …"
 *                  (`quietSinceStatus`), never "dark".
 *
 * Dates are the viewer's LOCAL calendar day everywhere ("Sep 1"), so the
 * verdict line and the chart beside it can never name different days.
 *
 * Framework-free; tested directly.
 */
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';

/**
 * The fleet's dark-since instant, or null when the fleet is not dark. A
 * pre-3.10.1 server sends no `darkSince`; the same rule is applied to what it
 * does send.
 */
export function fleetDarkSince(live: FleetLiveSnapshotV1 | null | undefined): string | null {
  if (!live) return null;
  if (live.darkSince !== undefined) return live.darkSince;
  return live.state === 'dark' ? live.lastActivityAt : null;
}

/** The viewer's local calendar day for an instant, as `YYYY-MM-DD`. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Sep 1" — the viewer's local day for `iso`. */
export function darkSinceLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'an unknown day';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * `iso` as the viewer's local `YYYY-MM-DD`, for ChartFrame's dark state:
 * ChartFrame labels the day it is GIVEN (a bare ISO instant would be cut to
 * its UTC day, which an evening west of UTC turns into tomorrow).
 */
export function darkSinceDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? localDay(ms) : iso;
}

/**
 * The chart state for a DARK live fleet, from THE dark-since instant: "Fleet
 * dark since Sep 1" (the viewer's local day). When the server knows the fleet
 * is dark but not since when (`darkSince: null` — a fresh install, a cleared
 * ledger and journal), it says just "Fleet dark.", as Command's line does —
 * never "since <today>" from the snapshot's own `generatedAt`.
 */
export function fleetDarkStatus(live: FleetLiveSnapshotV1): ChartStatus {
  const since = fleetDarkSince(live);
  const detail = live.stateReason?.trim() || undefined;
  if (since !== null && Number.isFinite(Date.parse(since))) return { kind: 'dark', since: darkSinceDay(since), detail };
  if (!detail) return { kind: 'empty', message: 'Fleet dark.' };
  return { kind: 'empty', message: `Fleet dark. ${/[.!?…]$/.test(detail) ? detail : `${detail}.`}` };
}

/**
 * A chart status built over fleet HISTORY, re-worded: history's `darkSince`
 * is "quiet since" (the last run or proposal), so its dark state becomes a
 * plain "No fleet runs or proposals since Aug 18." Every other status passes
 * through untouched.
 */
export function quietSinceStatus(status: ChartStatus): ChartStatus {
  if (status.kind !== 'dark') return status;
  return { kind: 'empty', message: `No fleet runs or proposals since ${darkSinceLabel(status.since)}.` };
}
