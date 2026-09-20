/**
 * routes/verse/sections/AutonomySection.tsx — the human-out-of-the-loop
 * cockpit (docs/VERSE-CONTRACT-V2.md, owner D). Lazy-mounted by VerseApp's
 * rail; takes no props by contract.
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
 */
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine, SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ActivityPanel } from '../autonomy/ActivityPanel.js';
import { CapsPanel } from '../autonomy/CapsPanel.js';
import { DaemonControls } from '../autonomy/DaemonControls.js';
import { GoalsBacklogPanel } from '../autonomy/GoalsBacklogPanel.js';
import { SafetyPanel } from '../autonomy/SafetyPanel.js';
import { ScopePanel } from '../autonomy/ScopePanel.js';
import { StatusHeader } from '../autonomy/StatusHeader.js';
import { verseCapsQuery, verseControlQuery } from '../autonomy/control-queries.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import autonomy from '../autonomy/autonomy.module.css';
import styles from './AutonomySection.module.css';

export function AutonomySection() {
  const control = useQuery(verseControlQuery);
  const caps = useQuery(verseCapsQuery);
  const bootstrap = useQuery(verseBootstrapQuery);
  const refetchControl = useRefetch(verseControlQuery);
  const guard = useGuardedAction();

  const dispatchEnabled = (bootstrap.data?.dispatchEnabled ?? true) && !guard.readOnly;
  const snapshot = control.data;

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
        <div className={styles.measure}>
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
              Without it the cockpit cannot honestly say whether the loop is running, so nothing below is shown rather
              than guessed.
              <br />
              <button type="button" className={styles.retry} onClick={refetchControl}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <StatusHeader snapshot={snapshot} />
              <DaemonControls snapshot={snapshot} guard={guard} dispatchEnabled={dispatchEnabled} />
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
        </div>
      </div>

      <MutationTokenDialog
        open={guard.tokenOpen}
        onClose={guard.closeToken}
        reason={guard.tokenReason}
        tokenHelp="the mutation token ashlr verse printed"
      />
    </section>
  );
}
