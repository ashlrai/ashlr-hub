/**
 * routes/verse/sections/FleetSection.tsx — ⌘2 Fleet (SPEC-310B §6,
 * SPEC-310C §5; unit C7). THE place to operate the fleet (3.15): what it is
 * doing and the one thing in its way, Start / Pause / Resume / Stop, the grant
 * (and editing it), steering runs and the queue — then what is running where,
 * why that seat, what is waiting, and per-repo control.
 *
 *   Fleet control: one sentence, one blocker, the controls, the facts (lead)
 *   Rollout ladder (while a grant is active)                       (12)
 *   Steer: working runs (log / interject / stop), queue, goals, Leader (12)
 *   Live swimlane by lane × phase                                  (12)
 *   Shadow decisions: G0–G7 per proposal, ladder regressions       (12)
 *   Gate funnel + refusal reasons (7) | Why this seat (5)
 *   Parked Gantt (7)                  | Overnight (5)
 *   Repo table: stage, last merge, green% sparkline, holds, pause/resume (12)
 *   ▸ Advanced — the eleven legacy Autonomy panels, fetched only when opened
 *
 * At 375 px: one column in that order; the repo table becomes cards.
 * The live view polls every 5 s while Fleet is the visible surface.
 *
 * Autonomy off: the shared AutonomyOffState sits under the lanes, and when
 * the fleet has nothing to draw (no runs, no gate traffic) the three chart
 * cards are left out instead of each repeating "Fleet dark since …".
 */
import { Suspense, lazy, useId, useState } from 'react';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronRight } from '../../../components/primitives/icons.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { runQuery } from '../../../data/cache.js';
import { AutonomyOffState, useAutonomyOff } from '../autonomy/AutonomyOffState.js';
import { overnightQuery } from '../autonomy/overnight-queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { budgetPreviewQuery, budgetQuery } from '../budget/budget-queries.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { paletteBlock, useGrantFlow } from '../command/AutonomyBar.js';
import { anchorId } from '../command/nav.js';
import { FleetControl } from '../fleet/FleetControl.js';
import { SteerPanel } from '../fleet/SteerPanel.js';
import { Cell, Surface } from '../command/Surface.js';
import { authorityQuery, fleetLiveQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { GateFunnelCards, LanesStrip, LiveSwimlane, OvernightCard, ParkedCard, WhySeatCard } from '../fleet/FleetCards.js';
import { RepoTable } from '../fleet/RepoTable.js';
import { FleetScheduling } from '../resources/SchedulingEvidence.js';
import { ExecutionFeedback } from '../fleet/ExecutionFeedback.js';
const ResetSpendingControl = lazy(() => import('../budget/ResetSpendingControl.js').then(module => ({ default: module.ResetSpendingControl })));
import { nothingToDraw } from '../fleet/live-model.js';
import { fleetDarkSince } from '../fleet/dark-since.js';
import styles from '../fleet/fleet.module.css';

export const FLEET_POLL_MS = 5_000;
export const FLEET_SLOW_POLL_MS = 30_000;

// The legacy cockpit is ~74 KB of panels: its own chunk, loaded on open.
// Shadow decisions (3.14): the gates' verdicts per proposal and ladder
// regressions — its own chunk, loaded once a grant has ever been signed.
const ShadowDecisions = lazy(() => import('../fleet/ShadowDecisions.js'));

const FleetAdvanced = lazy(() => import('../fleet/Advanced.js').then((m) => ({ default: () => <m.FleetAdvanced embedded /> })));
// The rollout ladder (3.14) lives here since 3.15 — Command links to it.
const AutonomyStatus = lazy(() => import('../command/AutonomyStatus.js'));
const OutcomesPanel = lazy(() => import('../fleet/OutcomesPanel.js').then(m => ({ default: m.OutcomesPanel })));
const FleetWorld = lazy(() => import('../fleet/FleetWorld.js'));

export function FleetSection() {
  const { compact } = useViewport();
  const fleet = useQuery(fleetLiveQuery);
  const overnight = useQuery(overnightQuery);
  const budget = useQuery(budgetQuery, { freshMs: 15_000 });
  const preview = useQuery(budgetPreviewQuery, { freshMs: 15_000 });
  const refetchOvernight = useRefetch(overnightQuery);
  const refetchPreview = useRefetch(budgetPreviewQuery);
  const refetchBudget = useRefetch(budgetQuery);
  // Automatic polling lets slow or queued reads settle; superseding them on
  // every tick can leave the last producing snapshot on screen indefinitely.
  usePollWhileVisible(() => {
    void runQuery(fleetLiveQuery.key, () => fleetLiveQuery.fetch());
  }, FLEET_POLL_MS);
  usePollWhileVisible(() => {
    refetchOvernight();
    refetchPreview();
    refetchBudget();
  }, FLEET_SLOW_POLL_MS);

  const now = useNow(15_000);
  const actions = useSurfaceActions();
  // One Touch ID sheet for Start's grant step, the blocker and "Edit scope".
  const grantFlow = useGrantFlow(actions);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const worldId = useId();
  const advancedId = useId();
  const live = fleet.data?.value ?? null;
  const off = useAutonomyOff();
  // Same cache entry as the off-state's read (no extra request).
  const authority = useQuery(authorityQuery, { freshMs: 30_000 });
  const auth = authority.data?.value ?? null;
  const grantState = auth?.grant.state ?? null;
  // A grant (active, or lapsed with history) means the ledger has decisions to show.
  const showDecisions = grantState !== null && grantState !== 'none';
  // Collapse only what would be empty: a fleet stopped an hour ago still
  // draws its last runs.
  const collapse = off != null && live !== null && nothingToDraw(live);

  function openAdvanced(): void {
    setAdvancedOpen(true);
    requestAnimationFrame(() => document.getElementById(advancedId)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  }

  return (
    <Surface
      title="Fleet"
      actions={fleet.status === 'refreshing' ? <RefreshIndicator /> : null}
      lead={
        <>
          <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading outcomes…</p>}>
            <OutcomesPanel actions={actions} />
          </Suspense>
          <div className={styles.taskActions} role="group" aria-label="Delegate and guide work">
            <Button size="sm" variant="primary" onClick={() => executeCatalogCommand('agents.new', { via: 'button' })}>Delegate a task</Button>
            <Button size="sm" variant="ghost" onClick={() => executeCatalogCommand('surface.agents', { via: 'button' })}>Review agents</Button>
            <Button size="sm" variant="ghost" onClick={() => executeCatalogCommand('surface.mind', { via: 'button' })}>Standing instructions</Button>
          </div>
          <p className={styles.muted}>Delegate a task in its own workspace, or give the Leader standing instructions for fleet planning.</p>
          <ActionStatus actions={actions} />
          <div id={anchorId('fleet-control')}>
            <span id={anchorId('authority-grant')} />
            <FleetControl actions={actions} grantFlow={grantFlow} darkSince={fleetDarkSince(live)} setupShownBelow={off?.kind === 'setup'} />
          </div>
          {/* The one-time setup checklist (the only step list left); every other
              off state is FleetControl's single blocker + button. */}
          {off && off.kind === 'setup' ? <AutonomyOffState state={off} here="fleet" /> : null}
          <LanesStrip live={live} />
        </>
      }
    >
      {auth && auth.grant.state === 'active' ? (
        // Needs-you's rollout and Stop items, and ⌘K "Autonomy status", point here.
        <Cell span={12}>
          <div id={anchorId('autonomy')}>
            <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading the rollout ladder…</p>}>
              <AutonomyStatus
                status={auth}
                now={now}
                onReapprove={(why) => grantFlow.open('re-approve', why)}
                blocked={paletteBlock({ status: auth, reason: null, readOnly: actions.readOnly, busy: actions.busy })}
              />
            </Suspense>
          </div>
        </Cell>
      ) : null}
      <Cell span={12}>
        <Button size="sm" variant="ghost" aria-expanded={worldOpen} aria-controls={worldId} onClick={() => setWorldOpen(open => !open)}>
          {worldOpen ? 'Close agent world' : 'Explore agent world'}
        </Button>
        <div id={worldId}>
          {worldOpen ? <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading the agent world…</p>}>
            <FleetWorld read={fleet.data} refreshing={fleet.status === 'refreshing'} readFailed={fleet.status === 'error'} />
          </Suspense> : null}
        </div>
        <div id="fleet-working-runs"><SteerPanel live={live} actions={actions} now={now} /></div>
        <Suspense fallback={<p className={styles.muted}>Loading allowance controls…</p>}>
          <ResetSpendingControl view={budget.data ?? null} nowMs={now} readOnly={actions.readOnly}
            onReviewGrant={() => grantFlow.open('re-approve', 'Review subscription reserve floors and producer roles before allowance reserve shrinking.')} />
        </Suspense>
        <FleetScheduling budget={budget.data ?? null} now={now} />
        <ExecutionFeedback />
      </Cell>
      {collapse ? null : (
        <Cell span={12}>
          <LiveSwimlane read={fleet.data} now={now} hours={compact ? 6 : 12} />
        </Cell>
      )}
      {showDecisions ? (
        <Cell span={12}>
          <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading shadow decisions…</p>}>
            <ShadowDecisions now={now} />
          </Suspense>
        </Cell>
      ) : null}
      {collapse ? null : (
        <Cell span={7}>
          <GateFunnelCards read={fleet.data} />
        </Cell>
      )}
      <Cell span={collapse ? 6 : 5}>
        <WhySeatCard read={fleet.data} preview={preview.data ?? null} view={budget.data ?? null} now={now} />
      </Cell>
      {collapse ? null : (
        <Cell span={7}>
          <ParkedCard read={fleet.data} now={now} />
        </Cell>
      )}
      <Cell span={collapse ? 6 : 5}>
        <OvernightCard read={overnight.data} onOpenAdvanced={openAdvanced} dark={live?.state === 'dark'} />
      </Cell>
      <Cell span={12}>
        <RepoTable read={fleet.data} actions={actions} now={now} compact={compact} />
      </Cell>
      <Cell span={12}>
        <div className={styles.advanced}>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            <IconChevronRight className={styles.chevron} width={14} height={14} aria-hidden="true" />
            Advanced
            <span className={styles.disclosureNote}>daemon, overnight, local runtime, caps, scope, activity, safety, goals</span>
          </button>
          <div id={advancedId} hidden={!advancedOpen}>
            {advancedOpen ? (
              <Suspense fallback={<p className={styles.muted} aria-busy="true">Loading the advanced panels…</p>}>
                <FleetAdvanced />
              </Suspense>
            ) : null}
          </div>
        </div>
      </Cell>
      {grantFlow.sheet}
      {actions.dialogs}
    </Surface>
  );
}
