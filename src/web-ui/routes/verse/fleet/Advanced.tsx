/**
 * routes/verse/fleet/Advanced.tsx — the eleven legacy Autonomy panels, now
 * "Fleet ▸ Advanced" (SPEC-310C §0.1 / §5; unit C7). Moved here verbatim from
 * sections/AutonomySection.tsx: the daemon controls, overnight, local
 * runtime, local-only, the local fleet, caps, scope, activity, safety and
 * goals still work exactly as they did — 3.10 only moves them below the fold
 * of the Fleet surface, behind a disclosure, so they are not fetched until
 * opened. `embedded` drops the section chrome (strip + scroll) because the
 * Fleet surface already provides both; the legacy AutonomySection wrapper
 * renders it standalone until the shell (C1) retires the old rail entry.
 *
 * (Original header, unchanged:)
 *
 * It answers, top to bottom: is it running, how do I stop it, what is it
 * allowed to spend, what is it allowed to touch, what did it do, is it safe,
 * and what is it aiming at. The order is the priority order — the stop button
 * is never below the fold.
 *
 * One `GET /api/verse/control` aggregate backs the header, the controls, and
 * the live-usage figures; the panels underneath fetch their own slower or
 * filterable data (`/caps`, `/scope`, `/audit`, `/safety`, `/goals`,
 * `/backlog`) so a slow audit read never blocks the stop button from
 * rendering.
 *
 * Read-only sessions: `ashlr serve` without dispatch 404s every POST. That is
 * detected two ways — the bootstrap's `dispatchEnabled` up front, and a
 * `DispatchDisabledError` from any attempted write — and is rendered as an
 * explained session mode, never as an error.
 *
 * LOCAL FLEET (owner U). Three panels sit directly under the controls, above
 * budget and scope, because on a local-only machine they are the answer to
 * "is it working": the serving runtime that makes local agents possible at
 * all, the local-only refusal, and the agents in flight. They read
 * `/api/verse/{runtime,local-only,fleet}` through `fleet-queries.ts`, which
 * treats an absent route as a degraded panel rather than a dead section — the
 * three routes are landing in parallel with this surface.
 *
 * They also poll. The runtime and the fleet are the only things on this screen
 * that change while nobody clicks anything, and neither has an SSE event yet,
 * so `useFleetPolling` re-reads them while the tab is visible. Everything else
 * here still refreshes on the existing cache rules.
 *
 * OVERNIGHT (owner U). It sits directly under the controls, above the local
 * fleet, because it is a CONTROL — the one the operator arms when they walk
 * away — and the order of this section is the priority order. It reads
 * `/api/verse/overnight` through `overnight-queries.ts`, which treats an
 * absent route as a designed "not available in this build" state rather than
 * an error, and polls only while a run is armed.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine, SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { ActivityPanel } from '../autonomy/ActivityPanel.js';
import { CapsPanel } from '../autonomy/CapsPanel.js';
import { DaemonControls } from '../autonomy/DaemonControls.js';
import { FleetPanel } from '../autonomy/FleetPanel.js';
import { GoalsBacklogPanel } from '../autonomy/GoalsBacklogPanel.js';
import { LocalOnlyPanel } from '../autonomy/LocalOnlyPanel.js';
import { LocalRuntimePanel } from '../autonomy/LocalRuntimePanel.js';
import { OvernightPanel } from '../autonomy/OvernightPanel.js';
import { SafetyPanel } from '../autonomy/SafetyPanel.js';
import { ScopePanel } from '../autonomy/ScopePanel.js';
import { StatusHeader } from '../autonomy/StatusHeader.js';
import { verseCapsQuery, verseControlQuery } from '../autonomy/control-queries.js';
import {
  fleetQuery,
  localOnlyQuery,
  servingRuntimeQuery,
  useFleetPolling,
} from '../autonomy/fleet-queries.js';
import type { SeatLike } from '../autonomy/fleet-model.js';
import { overnightQuery, useOvernightPolling } from '../autonomy/overnight-queries.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import autonomy from '../autonomy/autonomy.module.css';
import styles from '../sections/AutonomySection.module.css';

export function FleetAdvanced({ embedded = false }: { embedded?: boolean }) {
  const control = useQuery(verseControlQuery);
  const caps = useQuery(verseCapsQuery);
  const bootstrap = useQuery(verseBootstrapQuery);
  const runtime = useQuery(servingRuntimeQuery);
  const fleet = useQuery(fleetQuery);
  const localOnly = useQuery(localOnlyQuery);
  const overnight = useQuery(overnightQuery);
  const refetchControl = useRefresh(verseControlQuery);
  const guard = useGuardedAction();
  useFleetPolling();
  // Only an ARMED run has counters that move on their own; a disarmed panel
  // has one boolean to report and is left to the ordinary cache rules.
  useOvernightPolling(overnight.data?.value?.armed ?? false);

  const dispatchEnabled = (bootstrap.data?.dispatchEnabled ?? true) && !guard.readOnly;
  const snapshot = control.data;

  // The live seat roster, narrowed to what the local-only blast radius needs.
  // Bootstrap is the roster every other Verse surface reads, so this panel's
  // "3 of your 5 seats" cannot disagree with the seat picker.
  const seats: SeatLike[] = useMemo(
    () => (bootstrap.data?.seats ?? []).map((s) => ({ id: s.id, engine: s.engine, label: s.label })),
    [bootstrap.data],
  );

  const content: ReactNode = (
    <>
          {!dispatchEnabled ? (
            <div className={styles.banner} role="status">
              <span className={styles.bannerTitle}>Read-only session</span>
              This server was started without dispatch, so starting, stopping, editing caps, and changing scope are
              unavailable. Everything below is live and accurate — run <code>ashlr verse</code> to get the controls.
            </div>
          ) : null}

          {control.status === 'loading' ? (
            <div className={styles.loading}>
              <SkeletonLine width="42%" />
              <SkeletonLine width="68%" />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : control.status === 'error' || !snapshot ? (
            <div className={styles.failure} role="alert">
              {control.error?.message ?? 'Could not read the autonomy control snapshot.'}
              <br />
              Loop status unknown, so nothing below is shown.
              <br />
              <button type="button" className={styles.retry} onClick={refetchControl}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <StatusHeader snapshot={snapshot} />
              <DaemonControls snapshot={snapshot} guard={guard} dispatchEnabled={dispatchEnabled} />
              {/* The unattended lane, directly under the controls: arming it
                  is the biggest single thing an operator does on this screen,
                  and its halt must never be below the fold. */}
              <OvernightPanel
                read={overnight.data ?? null}
                snapshot={snapshot}
                guard={guard}
                dispatchEnabled={dispatchEnabled}
                loading={overnight.status === 'loading'}
              />
              {/* The local fleet, in the order the questions arrive: can it
                  run, what is it allowed to reach, and what is it doing. */}
              {/* `fleet` explicitly: this screen already holds the fleet read
                  (FleetPanel below), so the lane-cap line reads the same
                  object rather than peeking the shared cache entry — one
                  source for both panels, no reliance on cache timing. */}
              <LocalRuntimePanel
                read={runtime.data ?? null}
                guard={guard}
                dispatchEnabled={dispatchEnabled}
                loading={runtime.status === 'loading'}
                fleet={fleet.data ?? null}
              />
              <LocalOnlyPanel
                read={localOnly.data ?? null}
                seats={seats}
                guard={guard}
                dispatchEnabled={dispatchEnabled}
                loading={localOnly.status === 'loading'}
              />
              <FleetPanel
                read={fleet.data ?? null}
                runtime={runtime.data?.value ?? null}
                loading={fleet.status === 'loading'}
              />
              {caps.status === 'loading' ? (
                <div className={autonomy.panel}>
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
              ) : caps.data ? (
                <CapsPanel caps={caps.data} snapshot={snapshot} guard={guard} dispatchEnabled={dispatchEnabled} />
              ) : (
                <section className={autonomy.panel} aria-label="Budget and limits">
                  <div className={autonomy.panelHead}>
                    <h3 className={autonomy.panelTitle}>Budget and limits</h3>
                  </div>
                  <p className={autonomy.error} role="alert">
                    {caps.error?.message ?? 'Could not read the configured caps, so none are shown or editable.'}
                  </p>
                </section>
              )}
              <ScopePanel guard={guard} dispatchEnabled={dispatchEnabled} />
              <ActivityPanel snapshot={snapshot} />
              <SafetyPanel />
              <GoalsBacklogPanel />
            </>
          )}
    </>
  );

  const token = (
    <MutationTokenDialog
      open={guard.tokenOpen}
      onClose={guard.closeToken}
      reason={guard.tokenReason}
      tokenHelp="the mutation token ashlr verse printed"
    />
  );

  if (embedded) {
    return (
      <div className={styles.loading} data-embedded="true">
        <div className={styles.headerActions}>
          {control.status === 'refreshing' ? <RefreshIndicator /> : null}
          <button type="button" className={styles.ghost} onClick={refetchControl}>
            Refresh
          </button>
        </div>
        {content}
        {token}
      </div>
    );
  }

  return (
    <section className={styles.section} aria-label="Autonomy">
      <header className={styles.header} data-app-region="drag">
        <h2 className={styles.title}>Autonomy</h2>
        <div className={styles.headerActions}>
          {control.status === 'refreshing' ? <RefreshIndicator /> : null}
          <button type="button" className={styles.ghost} onClick={refetchControl}>
            Refresh
          </button>
        </div>
      </header>

      <div className={styles.scroll}>
        <div className={styles.measure}>{content}</div>
      </div>

      {token}
    </section>
  );
}
