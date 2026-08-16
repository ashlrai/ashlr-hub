/**
 * routes/journal/JournalEntryDetail.tsx — the "why did it do that, in one
 * click" drill-in (build brief, journal section). Only mounts when its
 * parent <details> is opened, so the extra fetch it performs (proposal
 * diff/taste/verdict, or a live run stream) never happens for rows nobody
 * expands.
 */
import { useQuery } from '../../data/hooks.js';
import { proposalDetailQuery } from '../../data/queries.js';
import { RunStreamPanel } from '../../components/stream/index.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import type { JournalDrillIn } from './journal-model.js';
import styles from './JournalEntryDetail.module.css';

function ProposalDetail({ proposalId }: { proposalId: string }) {
  const query = useQuery(proposalDetailQuery(proposalId));

  if (query.status === 'loading') return <SkeletonLine width="80%" />;
  if (query.status === 'error') {
    return (
      <p className={styles.error}>
        Could not load proposal {proposalId}: {query.error?.message ?? 'not found on disk (it may have been pruned).'}
      </p>
    );
  }
  const p = query.data;
  if (!p) return null;

  return (
    <div className={styles.detailBody}>
      <dl className={styles.grid}>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={p.status} />
          </dd>
        </div>
        {p.riskClass ? (
          <div>
            <dt>Risk</dt>
            <dd>{p.riskClass}</dd>
          </div>
        ) : null}
        {p.taste ? (
          <div>
            <dt>Judge verdict</dt>
            <dd>
              {p.taste.verdict} · alignment {p.taste.alignment}/10 · ambition {p.taste.ambition}/10 · design{' '}
              {p.taste.design}/10
            </dd>
          </div>
        ) : null}
        {p.decisionReason ? (
          <div>
            <dt>Decision</dt>
            <dd>{p.decisionReason}</dd>
          </div>
        ) : null}
        {p.learningSource ? (
          <div>
            <dt>Learning source</dt>
            <dd>{p.learningSource}</dd>
          </div>
        ) : null}
      </dl>
      {p.taste?.rationale ? <p className={styles.rationale}>{p.taste.rationale}</p> : null}
      {p.diff ? (
        <details className={styles.diffDetails}>
          <summary>Diff ({p.diff.split('\n').length} lines)</summary>
          <pre className={styles.diff}>{p.diff}</pre>
        </details>
      ) : (
        <p className={styles.error}>No diff recorded for this proposal.</p>
      )}
    </div>
  );
}

export function JournalEntryDetail({ drillIn }: { drillIn: JournalDrillIn }) {
  if (drillIn.runId) {
    return <RunStreamPanel runId={drillIn.runId} />;
  }
  if (drillIn.proposalId) {
    return <ProposalDetail proposalId={drillIn.proposalId} />;
  }
  return null;
}
