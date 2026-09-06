import type { UniverseOverview, UniverseSummary } from '../../data/api-types.js';
import styles from './UniverseView.module.css';

type DeliveryReport = NonNullable<UniverseOverview['deliveryReports']>[number];

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function UniverseDeliveries({ summary, report, onInspectTrial }: {
  summary: UniverseSummary;
  report?: DeliveryReport;
  onInspectTrial: (runId: string, trialId: string) => void;
}) {
  const verified = report?.sourceState === 'healthy';
  const degraded = report?.sourceState === 'degraded';
  const deliveries = report?.deliveries ?? [];
  return (
    <section className={styles.archive} aria-label="Repository delivery">
      <div className={styles.sectionHeading}>
        <div><h2>Repository delivery</h2><p>Turn a retained artifact into an exact local Git branch. Your current checkout stays untouched.</p></div>
      </div>
      <div className={styles.campaignBody}>
        {degraded ? <div className={styles.notice} role="status"><strong>Delivery evidence could not be verified.</strong><p>{report.reasons.join('; ') || 'Refresh after restoring the recorded repository and receipt.'}</p></div> : null}
        {deliveries.length ? deliveries.map((delivery) => (
          <details key={delivery.id} className={styles.delivery}>
            <summary>
              <code>{delivery.branch}</code>
              <span>{!verified ? `Unverified record (${delivery.status})` : delivery.status === 'delivered' ? 'Local branch verified' : delivery.status === 'unchanged' ? 'No change; no branch created' : 'Pending; not confirmed delivered'}</span>
            </summary>
            <dl className={styles.deliveryFacts}>
              <div><dt>Repository</dt><dd><code>{delivery.repo}</code></dd></div>
              <div><dt>Commit</dt><dd><code>{delivery.commit}</code></dd></div>
              <div><dt>Pinned base</dt><dd><code>{delivery.baseCommit}</code></dd></div>
              <div><dt>Artifact digest</dt><dd><code>{delivery.artifactDigest}</code></dd></div>
              <div><dt>Comparator digest</dt><dd><code>{delivery.comparatorDigest}</code></dd></div>
              <div><dt>Changed files</dt><dd>{delivery.changedFiles.length ? delivery.changedFiles.map((path) => <code key={path}>{path}<br /></code>) : 'None'}</dd></div>
            </dl>
            {summary.runs.some((run) => run.id === delivery.runId && run.trials.some((trial) => trial.id === delivery.trialId)) ?
              <button type="button" className={styles.eliteButton} onClick={() => onInspectTrial(delivery.runId, delivery.trialId)}>Inspect source trial</button> :
              <p>Source trial unavailable in the current history.</p>}
            {verified && delivery.status === 'delivered' ? <pre className={styles.command}><code>{`git -C ${quote(delivery.repo)} show --stat ${quote(delivery.commit)}`}</code></pre> : null}
          </details>
        )) : <p>{degraded ? 'No delivery can be confirmed from this read.' : 'No local branches delivered yet.'}</p>}
        {summary.sourceState === 'healthy' && !degraded && summary.elites.length ? (
          <details className={styles.artifact}>
            <summary>Deliver a retained artifact from your terminal</summary>
            <p>Choose a new branch name. Each command writes only a new local branch in <code>{summary.manifest.seed.repo}</code>; it does not switch branches, merge, or push.</p>
            {summary.elites.map((elite) => <div key={elite.trialId}>
              <p>{elite.niche}: {elite.variantId}</p>
              <pre className={styles.command}><code>{`ashlr universe deliver ${quote(summary.manifest.id)} --trial ${quote(elite.trialId)} --branch ${quote(`codex/universe-${summary.manifest.id}-${elite.trialId.slice(0, 8)}`)} --json`}</code></pre>
            </div>)}
          </details>
        ) : null}
        <p>Verification binds the branch to the recorded evaluator result. It is not a fresh evaluation, a merge, or a production deployment. Refresh to inspect delivery changes made in your terminal.</p>
      </div>
    </section>
  );
}
