/**
 * routes/verse/sections/CommandSection.tsx — ⌘1 Command, the home surface
 * (SPEC-310B §6, SPEC-310C §5; unit C7). Lazy-mounted by the shell; takes no
 * props (named export, like every section).
 *
 * It answers, top to bottom, in the order the questions arrive:
 *   1. What is autonomy allowed to do, and how do I stop it?  (top bar)
 *   2. Is the company producing?                              (verdict line)
 *   3. What changed since I last looked?                      ("Since" strip)
 *   4. What needs me, and what is the Leader doing?           (Needs you 5 | Leader 7)
 *      — Needs you reads the shell's shared activity store (C1 useActivity).
 *   5. Is it working?                                         (5 KPI tiles)
 *   6. Will it run out?                                       (one compact seat strip)
 *      — and the cloud lane's estimated credits and tasks      (3.11 CloudCard)
 *      The per-seat burn-down charts live on Usage (audit 14); a seat here
 *      opens the Resources drawer (⌘.).
 *   7. What ran?                                              (12 h swimlane)
 * At 375 px: Needs you, Leader, KPIs two per row, one seat per line, then
 * a 6 h swimlane — the DOM order below IS that order.
 *
 * Autonomy off (no grant, grant lapsed, Stop, switch at Off, daemon down):
 * ONE banner under the top bar (autonomy/AutonomyOffState) says what is off
 * and holds the one action — Approve grant (the bar's own Touch ID sheet), or
 * the one-time `ashlr authority setup` when no grant can be drafted yet. It
 * stands in for the verdict line and the Since strip, and the KPI row and the
 * swimlane are left out while they would only draw zeros and dashes.
 *
 * Every source is optional (surface-data.ts): a Track B module that has not
 * landed is one card's designed "not in this build" state, never a blank
 * surface. Polling runs only while Command is the visible surface
 * (usePollWhileVisible), at ≥ 2 s per the performance budget.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Swimlane } from '../../../components/charts/Swimlane.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import type { VerseBootstrap } from '../../../data/api-types.js';
import { VERSE_BOOTSTRAP_KEY } from '../verse-queries.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { AutonomyBar, useGrantFlow } from '../command/AutonomyBar.js';
import { AutonomyOffState, useDraftReadiness } from '../autonomy/AutonomyOffState.js';
import { autonomyOffState } from '../autonomy/autonomy-off-model.js';
import { buildKpis, claudeReserve, kpisSayNothing, seatNames, sinceYouLooked } from '../command/command-model.js';
import { KpiRow } from '../command/KpiRow.js';
import { LeaderCard } from '../command/LeaderCard.js';
import { NeedsYouCard } from '../command/NeedsYouCard.js';
import { SeatStrip } from '../command/SeatStrip.js';
import { CloudCard } from '../cloud/CloudCard.js';
import { Cell, Surface } from '../command/Surface.js';
import { SinceStrip, VerdictLine, useLastLooked } from '../command/VerdictLine.js';
import { useActivity } from '../shell/useActivity.js';
import {
  authorityQuery,
  fleetHistoryQuery,
  fleetLiveQuery,
  leaderQuery,
  learningQuery,
} from '../command/surface-data.js';
import { fleetDarkSince, fleetDarkStatus } from '../fleet/dark-since.js';
import { laneRows, runTone } from '../fleet/live-model.js';
import styles from '../command/command.module.css';

const HOUR = 3_600_000;

/** Fast reads: the switch, the fleet and the inbox move while nobody clicks. */
export const COMMAND_FAST_POLL_MS = 10_000;
/** Slow reads: the Leader, budgets (the collector samples every 30 s). */
export const COMMAND_SLOW_POLL_MS = 30_000;
/** History and learning change daily. */
export const COMMAND_HISTORY_POLL_MS = 300_000;

export function CommandSection() {
  const { compact } = useViewport();
  const authority = useQuery(authorityQuery);
  const fleet = useQuery(fleetLiveQuery);
  // The shell's ONE activity poll (C1) — never a second loop from here.
  const activity = useActivity();
  const leader = useQuery(leaderQuery);
  const learning = useQuery(learningQuery, { freshMs: 60_000 });
  const history = useQuery(fleetHistoryQuery, { freshMs: 60_000 });
  const budget = useQuery(budgetQuery, { freshMs: 15_000 });

  const refetch = {
    authority: useRefetch(authorityQuery),
    fleet: useRefetch(fleetLiveQuery),
    leader: useRefetch(leaderQuery),
    learning: useRefetch(learningQuery),
    history: useRefetch(fleetHistoryQuery),
    budget: useRefetch(budgetQuery),
  };
  usePollWhileVisible(() => {
    refetch.authority();
    refetch.fleet();
  }, COMMAND_FAST_POLL_MS);
  usePollWhileVisible(() => {
    refetch.leader();
    refetch.budget();
  }, COMMAND_SLOW_POLL_MS);
  usePollWhileVisible(() => {
    refetch.history();
    refetch.learning();
  }, COMMAND_HISTORY_POLL_MS);

  // A 30 s clock is enough for the chip and the swimlane's "now"; the
  // countdown rings keep their own 1 s ticker.
  const now = useNow(30_000);
  const actions = useSurfaceActions();
  // One Touch ID sheet for the bar AND the "Autonomy is off" banner.
  const grantFlow = useGrantFlow(actions);
  const lastLooked = useLastLooked();

  // The seat roster, for the seat strip (the rail's capacity projection) and
  // Needs-you's seat names. Read from the cache WITHOUT fetching: the console
  // loads bootstrap at startup and the chat surfaces keep it live, and a
  // bootstrap read here would cost ~384 ms of server event loop per poll
  // (useSeatsRefresh.ts). No roster → the strip falls back to the budget
  // route's own seat list and says readiness is unknown.
  const roster = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(VERSE_BOOTSTRAP_KEY, listener), []),
    () => getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY),
    () => getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY),
  );
  const seats = roster.data?.seats ?? null;

  const view = budget.data ?? null;

  const auth = authority.data?.value ?? null;
  const live = fleet.data?.value ?? null;
  const hist = history.data?.value ?? null;
  // THE dark-since instant (fleet/dark-since.ts): null unless the fleet is
  // dark. Never fleet history's date — that is "quiet since", not "dark".
  const darkSince = fleetDarkSince(live);

  const kpis = useMemo(
    // `budget` puts each paid seat's window usage (percent, never dollars) in
    // the metered-spend caption (review 3.10 c10).
    () => buildKpis({ fleet: live, history: hist, learning: learning.data?.value ?? null, policy: auth?.policy ?? null, budget: view }),
    [live, hist, learning.data, auth, view],
  );
  // Needs-you names seats as the seat strip below it does, never by raw id.
  const names = useMemo(() => seatNames(seats, view), [seats, view]);
  // The banner decides once both reads (and, with no grant, the draft) have
  // answered — never a flash of "off" while Command is still loading.
  const draft = useDraftReadiness(auth?.grant.state === 'none');
  const banner = authority.data && fleet.data && draft !== undefined ? autonomyOffState({ authority: auth, live, draft }) : null;
  const kpisEmpty = useMemo(() => kpisSayNothing({ fleet: live, history: hist, learning: learning.data?.value ?? null }), [live, hist, learning.data]);
  const since = sinceYouLooked({ lastLookedAt: lastLooked, fleet: live, leader: leader.data?.value ?? null, activity: activity.data });

  const windowH = compact ? 6 : 12;
  const from = now - windowH * HOUR;
  const lanes = useMemo(() => (live ? laneRows(live.runs, from, now) : []), [live, from, now]);
  const runsStatus: ChartStatus = !fleet.data
    ? { kind: 'loading' }
    : !live
      ? { kind: 'unknown', reason: fleet.data.reason ?? 'the live fleet view did not answer.' }
      : live.state === 'dark' && lanes.length === 0
        ? fleetDarkStatus(live)
        : lanes.length === 0
          ? { kind: 'empty', message: `No runs in the last ${windowH} hours.` }
          : { kind: 'ready' };

  // The banner (or the verdict) already says the fleet is dark; "All clear"
  // needs no third copy of it.
  const fleetLine = live
    ? live.state === 'dark'
      ? null
      : `Fleet ${live.state}: ${live.summary.building ?? '—'} building, ${live.summary.queued ?? '—'} queued.`
    : 'Fleet status unknown.';
  const refreshing = [authority, fleet].some((q) => q.status === 'refreshing');

  return (
    <Surface
      title="Command"
      actions={refreshing ? <RefreshIndicator /> : null}
      lead={
        <div className={styles.lead}>
          <AutonomyBar read={authority.data} loading={authority.status === 'loading'} budgetMode={view?.mode ?? null} actions={actions} compact={compact} now={now} grantFlow={grantFlow} />
          <ActionStatus actions={actions} />
          {banner ? (
            <AutonomyOffState state={banner} here="command" onGrant={(intent) => grantFlow.open(intent, banner.why)} />
          ) : (
            <>
              <VerdictLine
                authority={auth}
                building={live?.summary.building ?? null}
                mergedToday={live?.summary.mergedToday ?? null}
                revertsToday={live?.summary.revertsToday ?? null}
                reserve={claudeReserve(view)}
                darkSince={darkSince}
              />
              <SinceStrip lastLookedAt={lastLooked} items={since} now={now} />
            </>
          )}
        </div>
      }
    >
      <Cell span={5}>
        <NeedsYouCard state={activity} actions={actions} fleetLine={fleetLine} seatNames={names} />
      </Cell>
      <Cell span={7}>
        <LeaderCard read={leader.data} loading={leader.status === 'loading'} actions={actions} />
      </Cell>
      {banner && kpisEmpty ? null : (
        <Cell span={12}>
          <KpiRow kpis={kpis} />
        </Cell>
      )}
      <Cell span={12}>
        <SeatStrip budget={view} seats={seats} now={now} />
      </Cell>
      <Cell span={12}>
        <CloudCard actions={actions} now={now} />
      </Cell>
      {banner && lanes.length === 0 ? null : (
        <Cell span={12}>
          <Swimlane
            title={`Last ${windowH} hours`}
            description="Fleet lanes; bars coloured by status, outlines are queued or parked"
            status={runsStatus}
            lanes={lanes}
            from={from}
            to={now}
            now={now}
            toneOf={runTone}
          />
        </Cell>
      )}
      {grantFlow.sheet}
      {actions.dialogs}
    </Surface>
  );
}
