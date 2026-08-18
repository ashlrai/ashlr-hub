/**
 * routes/journal/LiveNowStrip.tsx — "watch an agent work in real time"
 * surfaced right at the top of the journal: any run currently `running`
 * gets a one-click "Watch live" that opens <RunStreamPanel/> in a drawer.
 * Reuses components/stream's live-streaming primitive rather than
 * reimplementing it — this is the journal's own integration point for that
 * feature (routes/work/** is owned by another agent and not touched here).
 */
import { useState } from 'react';
import { useQuery } from '../../data/hooks.js';
import { dashboardSnapshotQuery } from '../../data/queries.js';
import { Dialog } from '../../components/primitives/Dialog.js';
import { RunStreamPanel } from '../../components/stream/index.js';
import styles from './LiveNowStrip.module.css';

export function LiveNowStrip() {
  const snapshotQuery = useQuery(dashboardSnapshotQuery);
  const [watchingRunId, setWatchingRunId] = useState<string | null>(null);
  const runningRuns = (snapshotQuery.data?.runs ?? []).filter((r) => r.status === 'running');

  if (runningRuns.length === 0) return null;

  return (
    <div className={styles.strip}>
      <span className={styles.label}>Live now</span>
      <ul className={styles.list}>
        {runningRuns.map((run) => (
          <li key={run.id}>
            <button type="button" className={styles.watchBtn} onClick={() => setWatchingRunId(run.id)}>
              <span className={styles.pulse} aria-hidden="true" />
              {run.goal}
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={watchingRunId !== null}
        onClose={() => setWatchingRunId(null)}
        titleId="live-now-title"
        title="Watching live"
        widthClassName={styles.dialogWidth}
      >
        {watchingRunId ? <RunStreamPanel runId={watchingRunId} /> : null}
      </Dialog>
    </div>
  );
}
