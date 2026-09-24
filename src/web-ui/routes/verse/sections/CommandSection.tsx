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
 *   6. Will it run out?                                       (burn-down per seat, 3 each)
 *   7. What ran?                                              (12 h swimlane)
 * At 375 px: Needs you, Leader, KPIs two per row, burn-downs in a snap
 * strip, then a 6 h swimlane — the DOM order below IS that order.
 *
 * Every source is optional (surface-data.ts): a Track B module that has not
 * landed is one card's designed "not in this build" state, never a blank
 * surface. Polling runs only while Command is the visible surface
 * (usePollWhileVisible), at ≥ 2 s per the performance budget.
 */
import { useEffect, useMemo, useState } from 'react';
import { Swimlane } from '../../../components/charts/Swimlane.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { AutonomyBar } from '../command/AutonomyBar.js';
import { buildKpis, claudeReserve, recordReading, seatBurns, sinceYouLooked, type SeatReading } from '../command/command-model.js';
import { KpiRow } from '../command/KpiRow.js';
import { LeaderCard } from '../command/LeaderCard.js';
import { NeedsYouCard } from '../command/NeedsYouCard.js';
import { SeatBurnDowns } from '../command/SeatBurnDowns.js';
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
import { laneRows, runTone } from '../fleet/live-model.js';
import styles from '../command/command.module.css';

const HOUR = 3_600_000;

/** Fast reads: the switch, the fleet and the inbox move while nobody clicks. */
export const COMMAND_FAST_POLL_MS = 10_000;
/** Slow reads: the Leader, budgets (the collector samples every 30 s). */
export const COMMAND_SLOW_POLL_MS = 30_000;
/** History and learning change daily. */
export const COMMAND_HISTORY_POLL_MS = 300_000;

// Seat readings observed since the page opened (module scope: they survive
// the keep-alive shell unmounting Command; see command-model recordReading).
let seatReadings: Record<string, SeatReading[]> = {};

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
  const lastLooked = useLastLooked();

  const [readings, setReadings] = useState(seatReadings);
  const view = budget.data ?? null;
  useEffect(() => {
    if (!view) return;
    seatReadings = recordReading(seatReadings, view);
    setReadings(seatReadings);
  }, [view]);

  const auth = authority.data?.value ?? null;
  const live = fleet.data?.value ?? null;
  const hist = history.data?.value ?? null;
  const darkSince = live?.state === 'dark' ? live.lastActivityAt ?? hist?.darkSince ?? null : hist?.darkSince ?? null;

  const kpis = useMemo(
    () => buildKpis({ fleet: live, history: hist, learning: learning.data?.value ?? null, policy: auth?.policy ?? null }),
    [live, hist, learning.data, auth],
  );
  const burns = useMemo(() => seatBurns(view, readings), [view, readings]);
  const since = sinceYouLooked({ lastLookedAt: lastLooked, fleet: live, leader: leader.data?.value ?? null, activity: activity.data });

  const windowH = compact ? 6 : 12;
  const from = now - windowH * HOUR;
  const lanes = useMemo(() => (live ? laneRows(live.runs, from, now) : []), [live, from, now]);
  const runsStatus: ChartStatus = !fleet.data
    ? { kind: 'loading' }
    : !live
      ? { kind: 'unknown', reason: fleet.data.reason ?? 'the live fleet view did not answer.' }
      : live.state === 'dark' && lanes.length === 0
        ? { kind: 'dark', since: darkSince ?? live.generatedAt, detail: live.stateReason ?? undefined }
        : lanes.length === 0
          ? { kind: 'empty', message: `No runs in the last ${windowH} hours.` }
          : { kind: 'ready' };

  const fleetLine = live
    ? live.state === 'dark'
      ? `Fleet dark${darkSince ? ` since ${new Date(darkSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.`
      : `Fleet ${live.state}: ${live.summary.building ?? '—'} building, ${live.summary.queued ?? '—'} queued.`
    : 'Fleet status unknown.';

  const refreshing = [authority, fleet].some((q) => q.status === 'refreshing');

  return (
    <Surface
      title="Command"
      actions={refreshing ? <RefreshIndicator /> : null}
      lead={
        <div className={styles.lead}>
          <AutonomyBar read={authority.data} loading={authority.status === 'loading'} budgetMode={view?.mode ?? null} actions={actions} compact={compact} now={now} />
          <ActionStatus actions={actions} />
          <VerdictLine
            authority={auth}
            building={live?.summary.building ?? null}
            mergedToday={live?.summary.mergedToday ?? null}
            revertsToday={live?.summary.revertsToday ?? null}
            reserve={claudeReserve(view)}
            darkSince={darkSince}
          />
          <SinceStrip lastLookedAt={lastLooked} items={since} />
        </div>
      }
    >
      <Cell span={5}>
        <NeedsYouCard state={activity} actions={actions} fleetLine={fleetLine} />
      </Cell>
      <Cell span={7}>
        <LeaderCard read={leader.data} loading={leader.status === 'loading'} actions={actions} />
      </Cell>
      <Cell span={12}>
        <KpiRow kpis={kpis} />
      </Cell>
      <Cell span={12}>
        <SeatBurnDowns burns={burns} now={now} compact={compact} />
      </Cell>
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
      {actions.dialogs}
    </Surface>
  );
}
