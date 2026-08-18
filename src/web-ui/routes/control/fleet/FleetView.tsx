/**
 * routes/control/fleet/FleetView.tsx — queue depth, lease health, and the
 * kill switch (GET /api/fleet, GET /api/fleet-activity; POST
 * /api/fleet/pause|resume).
 *
 * The audit finding this fixes: the old UI's kill switch engaged on a
 * single click with no confirmation. This one requires an explicit confirm
 * step (Dialog) before it will even offer the token prompt, and the token
 * prompt itself only appears if no mutation hold is already active — so the
 * full path to actually pausing the fleet is: click "Pause fleet" -> confirm
 * dialog -> (token dialog, only if not already unlocked) -> mutation fires.
 *
 * Kill-switch state is read from `FleetStatus.killSwitch`
 * (`{state, sourceState, reason}` — src/core/fleet/status.ts:1690-1696),
 * which is a *different* shape from the `{sourceState, complete, reason?}`
 * SourceQuality the rest of the app keys Epistemic off of, so it's adapted
 * into that shape here (`sourceState: killSwitch.sourceState`,
 * `complete: killSwitch.sourceState === 'healthy'`) before being handed to
 * <Epistemic/> — same withhold-the-control behavior, correct source shape.
 */
import { useEffect, useRef, useState } from 'react';
import { fleetStatusQuery, fleetActivityQuery } from '../../../data/queries.js';
import { useQuery, useMutationHold } from '../../../data/hooks.js';
import { pauseFleet, resumeFleet } from '../../../data/mutations.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import styles from './FleetView.module.css';

type PendingAction = 'pause' | 'resume' | null;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function FleetView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/control/fleet', containerRef);

  const fleetQuery = useQuery(fleetStatusQuery);
  const activityQuery = useQuery(fleetActivityQuery);
  const mutationHold = useMutationHold();

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  async function executeAction(action: NonNullable<PendingAction>) {
    setMutating(true);
    setMutationError(null);
    try {
      if (action === 'pause') await pauseFleet();
      else await resumeFleet();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(false);
      setPendingAction(null);
    }
  }

  function requestAction(action: NonNullable<PendingAction>) {
    setMutationError(null);
    setPendingAction(action);
    setConfirmOpen(true);
  }

  function confirmIntent() {
    setConfirmOpen(false);
    if (mutationHold.hasHold) {
      if (pendingAction) void executeAction(pendingAction);
    } else {
      setTokenOpen(true);
    }
  }

  // After the token dialog closes: if a hold now exists, the pending action
  // was confirmed AND unlocked, so run it. If not, the dialog was cancelled
  // — drop the pending action rather than leaving a stale confirm hanging.
  useEffect(() => {
    if (tokenOpen) return;
    if (!pendingAction) return;
    if (mutationHold.hasHold) void executeAction(pendingAction);
    else setPendingAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately fires only on tokenOpen transitioning closed.
  }, [tokenOpen]);

  const fleet = fleetQuery.data;
  const killSwitch = fleet?.killSwitch;
  const killQuality = killSwitch
    ? { sourceState: killSwitch.sourceState, complete: killSwitch.sourceState === 'healthy', reason: killSwitch.reason }
    : undefined;
  const isPaused = fleet?.killed === true;

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fleet</h1>
        <div className={styles.freshness} aria-live="polite">
          {fleetQuery.status === 'refreshing' || activityQuery.status === 'refreshing' ? <RefreshIndicator /> : null}
        </div>
      </header>

      {fleetQuery.status === 'loading' ? (
        <SkeletonLine width="60%" />
      ) : fleetQuery.status === 'error' || !fleet ? (
        <p className={styles.error} role="alert">
          {fleetQuery.error?.message ?? 'Failed to load fleet status.'}
        </p>
      ) : (
        <>
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Kill switch</h2>
            <div className={styles.killSwitchRow}>
              <Epistemic
                quality={killQuality}
                label="kill switch"
                renderControl={() => (
                  <button
                    type="button"
                    className={isPaused ? styles.resumeButton : styles.pauseButton}
                    onClick={() => requestAction(isPaused ? 'resume' : 'pause')}
                    disabled={mutating}
                  >
                    {mutating ? 'Working…' : isPaused ? 'Resume fleet' : 'Pause fleet'}
                  </button>
                )}
              >
                <StatusBadge status={isPaused ? 'paused' : 'running'}>
                  {isPaused ? 'engaged — fleet paused' : 'clear — fleet active'}
                </StatusBadge>
              </Epistemic>
            </div>
            {mutationError ? (
              <p className={styles.mutationError} role="alert">
                {mutationError}
              </p>
            ) : null}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Queue depth</h2>
            <dl className={styles.metaGrid}>
              <div>
                <dt>Backlog items</dt>
                <dd className={styles.numeric}>{fleet.queue.backlogItems}</dd>
              </div>
              {fleet.queue.eligibleBacklogItems !== undefined ? (
                <div>
                  <dt>Eligible</dt>
                  <dd className={styles.numeric}>{fleet.queue.eligibleBacklogItems}</dd>
                </div>
              ) : null}
              {fleet.queue.cooldownItems !== undefined ? (
                <div>
                  <dt>Cooldown</dt>
                  <dd className={styles.numeric}>{fleet.queue.cooldownItems}</dd>
                </div>
              ) : null}
              {fleet.queue.pendingItems !== undefined ? (
                <div>
                  <dt>Pending</dt>
                  <dd className={styles.numeric}>{fleet.queue.pendingItems}</dd>
                </div>
              ) : null}
              {fleet.queue.nextEligibleAt !== undefined ? (
                <div>
                  <dt>Next eligible</dt>
                  <dd>{formatDate(fleet.queue.nextEligibleAt)}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Lease health</h2>
            {!fleet.queue.shared ? (
              <p className={styles.empty}>Shared fleet queue is not in use on this deployment.</p>
            ) : (
              <>
                <dl className={styles.metaGrid}>
                  <div>
                    <dt>Active claims</dt>
                    <dd className={styles.numeric}>{fleet.queue.shared.activeClaims}</dd>
                  </div>
                  <div>
                    <dt>Owned by this machine</dt>
                    <dd className={styles.numeric}>{fleet.queue.shared.ownedClaims}</dd>
                  </div>
                  <div>
                    <dt>Reclaimable (expired)</dt>
                    <dd className={styles.numeric}>{fleet.queue.shared.reclaimableClaims}</dd>
                  </div>
                  {fleet.queue.shared.executingClaims !== undefined ? (
                    <div>
                      <dt>Executing</dt>
                      <dd className={styles.numeric}>{fleet.queue.shared.executingClaims}</dd>
                    </div>
                  ) : null}
                  {fleet.queue.shared.ambiguousClaims !== undefined ? (
                    <div>
                      <dt>Ambiguous (needs reconciliation)</dt>
                      <dd className={styles.numeric}>{fleet.queue.shared.ambiguousClaims}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Next lease expiry</dt>
                    <dd>{formatDate(fleet.queue.shared.nextLeaseExpiryAt)}</dd>
                  </div>
                  <div>
                    <dt>Advisory lock</dt>
                    <dd>
                      {fleet.queue.shared.lock.present
                        ? fleet.queue.shared.lock.stale
                          ? 'present, stale'
                          : 'present, healthy'
                        : 'absent'}
                      {fleet.queue.shared.lock.recoveryRequired ? (
                        <span className={styles.lockWarning}> — recovery required</span>
                      ) : null}
                    </dd>
                  </div>
                </dl>
                {fleet.queue.shared.claimsByMachine.length > 0 ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Machine</th>
                          <th scope="col">Active</th>
                          <th scope="col">Expired</th>
                          <th scope="col">Executing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleet.queue.shared.claimsByMachine.map((m) => (
                          <tr key={m.machineId}>
                            <td className={styles.mono}>{m.machineId}</td>
                            <td className={styles.numeric}>{m.active}</td>
                            <td className={styles.numeric}>{m.expired}</td>
                            <td className={styles.numeric}>{m.executing ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent activity</h2>
        {activityQuery.status === 'loading' ? (
          <SkeletonLine width="70%" />
        ) : activityQuery.status === 'error' || !activityQuery.data ? (
          <p className={styles.error} role="alert">
            {activityQuery.error?.message ?? 'Failed to load fleet activity.'}
          </p>
        ) : (
          <dl className={styles.metaGrid}>
            <div>
              <dt>Cooldown items</dt>
              <dd className={styles.numeric}>{activityQuery.data.cooldownCount}</dd>
            </div>
            <div>
              <dt>Engines ready</dt>
              <dd className={styles.numeric}>
                {activityQuery.data.engineReadiness.filter((e) => e.installed && e.authed === true).length} /{' '}
                {activityQuery.data.engineReadiness.length}
              </dd>
            </div>
            <div>
              <dt>Recent auto-merges</dt>
              <dd className={styles.numeric}>{fleet?.merges.recent ?? '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      <Dialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          setPendingAction(null);
        }}
        titleId="fleet-kill-switch-confirm"
        title={pendingAction === 'resume' ? 'Resume the fleet?' : 'Pause the fleet?'}
      >
        <p className={styles.confirmBody}>
          {pendingAction === 'resume'
            ? 'This clears the global kill switch. Autonomous dispatch will resume across the fleet.'
            : 'This engages the global kill switch. Autonomous dispatch halts fleet-wide until explicitly resumed.'}
        </p>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={() => {
              setConfirmOpen(false);
              setPendingAction(null);
            }}
          >
            Cancel
          </button>
          <button type="button" className={styles.confirmButton} onClick={confirmIntent}>
            {pendingAction === 'resume' ? 'Yes, resume' : 'Yes, pause'}
          </button>
        </div>
      </Dialog>

      <MutationTokenDialog
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        reason={
          pendingAction === 'resume'
            ? 'Resuming the fleet requires the dispatch token.'
            : 'Pausing the fleet requires the dispatch token.'
        }
      />
    </div>
  );
}
