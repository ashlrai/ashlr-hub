/**
 * routes/verse/autonomy/SafetyPanel.tsx — the `verify-safety` report as
 * pass/fail lines with a re-run button.
 *
 * These are READ-ONLY structural checks on this build's own source, so the
 * "Re-run" button is a plain re-fetch of `GET /api/verse/safety`: it needs no
 * mutation token and cannot change anything. The count is stated rather than
 * hardcoded to five — if the backend grows a sixth check the panel should show
 * six, not silently hide it.
 */
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { verseSafetyQuery } from './control-queries.js';
import styles from './autonomy.module.css';

export function SafetyPanel() {
  const query = useQuery(verseSafetyQuery);
  const refetch = useRefresh(verseSafetyQuery);
  const report = query.data;
  const passed = report?.checks?.filter((c) => c.pass).length ?? 0;
  const total = report?.checks?.length ?? 0;

  return (
    <section className={styles.panel} aria-label="Safety checks">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Safety</h3>
        <div className={styles.panelActions}>
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          {report ? (
            <span className={styles.panelNote}>
              {passed}/{total} passing
            </span>
          ) : null}
          <button type="button" className={styles.button} onClick={refetch} disabled={query.status === 'loading'}>
            Re-run checks
          </button>
        </div>
      </div>

      {query.status === 'loading' ? (
        <div className={styles.skeletons}>
          <SkeletonLine width="70%" />
          <SkeletonLine width="55%" />
          <SkeletonLine width="62%" />
        </div>
      ) : query.status === 'error' ? (
        <p className={styles.error} role="alert">
          {query.error?.message ?? 'Could not run the safety checks.'}
        </p>
      ) : !report || total === 0 ? (
        <p className={styles.empty}>
          The safety report came back with no checks. That is itself a problem worth investigating — treat it as a
          failure, not as a pass.
        </p>
      ) : (
        <div className={styles.checkList}>
          {report.checks.map((check) => (
            <div className={styles.check} key={check.id} data-pass={check.pass}>
              <span className={styles.checkMark} aria-hidden="true">
                {check.pass ? '✓' : '✕'}
              </span>
              <span className={styles.checkLabel}>
                {check.label}
                <span className={styles.srOnly}>{check.pass ? ' — passed' : ' — failed'}</span>
              </span>
              <span className={styles.checkDetail}>{check.detail || check.id}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
