import { useMemo } from 'react';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { compareControllerObservations } from '../data/controller-observation-delta.js';
import styles from './UniverseControllerChanges.module.css';

type Props = {
  previous: UniversePortfolioControllerView | null;
  current: UniversePortfolioControllerView;
  historical: boolean;
  loading: boolean;
};

/** Compares only the supplied observations; it does not collect an event history. */
export function UniverseControllerChanges({ previous, current, historical, loading }: Props) {
  const comparison = useMemo(() => compareControllerObservations(previous, current), [previous, current]);
  return <section className={styles.changes} aria-label="Changes between observations">
    <header className={styles.header}>
      <h3>Changes between observations</h3>
      <div className={styles.labels}>
        {loading ? <span>Refresh in progress</span> : null}
        {historical ? <span className={styles.historical}>Historical observations</span> : null}
      </div>
    </header>
    <p className={styles.description}>Compare the last two accepted responses in this session. This is not an event log or a live activity view.</p>
    <dl className={styles.times} aria-label="Compared observation times">
      <div><dt>Previous observation</dt><dd>{previous ? <time dateTime={previous.observedAt}>{previous.observedAt}</time> : 'Not yet observed'}</dd></div>
      <div><dt>Displayed observation</dt><dd><time dateTime={current.observedAt}>{current.observedAt}</time></dd></div>
    </dl>
    {loading ? <p className={styles.note}>The accepted observations below remain unchanged while the refresh is pending.</p> : null}
    {historical ? <p className={styles.warning}>The latest refresh failed. This comparison uses retained observations, not current evidence.</p> : null}
    {comparison.notice ? <p className={comparison.kind === 'baseline' ? styles.note : styles.warning}>{comparison.notice}</p> : null}
    {comparison.clockWarning ? <p className={styles.warning}>Observation timestamps are equal or move backward. Before and after follow response order, not a verified event timeline.</p> : null}
    {comparison.kind === 'baseline' ? <p className={styles.baseline}>Refresh this controller to compare two observations.</p>
      : comparison.kind === 'incomparable' ? <p className={styles.baseline}>These observations cannot be compared as one controller registration.</p>
      : comparison.changes.length === 0 ? <p className={styles.baseline}>No compared evidence fields changed. Observation times are excluded; this does not prove that no work occurred.</p>
      : <>
        <dl className={styles.counts} aria-label="Observation change counts">
          <div><dt>Changed fields</dt><dd>{comparison.changes.length}</dd></div>
          <div><dt>Campaigns with displayed changes</dt><dd>{comparison.changedCampaigns}</dd></div>
        </dl>
        <details className={styles.disclosure}>
          <summary>Review {comparison.changes.length} changed field{comparison.changes.length === 1 ? '' : 's'}</summary>
          <ul className={styles.rows} aria-label="Changed observation fields">
            {comparison.changes.map((change) => <li key={change.key} className={styles.row}>
              <div className={styles.field}><h4>{change.label}</h4>{change.campaignId ? <span>{change.campaignId}</span> : null}</div>
              <dl className={styles.values}>
                <div><dt>Before</dt><dd>{change.before}</dd></div>
                <div><dt>After</dt><dd>{change.after}</dd></div>
              </dl>
            </li>)}
          </ul>
        </details>
      </>}
    <p className={styles.footnote}>Differences describe returned evidence only. They do not establish worker execution, delivery verification or a production deployment.</p>
  </section>;
}
