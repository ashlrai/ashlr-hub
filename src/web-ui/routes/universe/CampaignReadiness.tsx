import { useMemo, useState } from 'react';
import type { UniverseCampaignReadinessView } from '../../../core/web/universe-console-types.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { universeCampaignReadinessQuery } from '../../data/universe-readiness-queries.js';
import styles from './CampaignReadiness.module.css';

const LABELS: Record<UniverseCampaignReadinessView['disposition'], string> = {
  startable: 'Recorded evidence permitted a run attempt',
  owned: 'Campaign owner was recorded active',
  'owner-held': 'Owner control held the campaign',
  'resource-withheld': 'Last attempt was withheld by resources',
  'recovery-required': 'Recovery inspection was required',
  'attention-required': 'Attention was required',
  'budget-exhausted': 'Recorded budget was exhausted',
  terminal: 'Campaign had ended',
  unavailable: 'Recorded check was unavailable',
};

function RecordedCheck({ campaignId, universeId }: { campaignId: string; universeId: string }) {
  const query = useMemo(() => universeCampaignReadinessQuery(campaignId, universeId), [campaignId, universeId]);
  const { data, status } = useQuery(query);
  const refresh = useRefetch(query);
  const busy = status === 'loading' || status === 'refreshing' || status === 'idle';
  const historical = busy || status === 'error';
  return <div className={styles.result} aria-busy={busy}>
    <div className={styles.heading}><h4>Last recorded check</h4><button type="button" className={styles.button} disabled={busy} onClick={refresh}>{busy ? 'Checking recorded evidence…' : 'Refresh check'}</button></div>
    {status === 'error' ? <p className={styles.notice} role="alert">Recorded check could not be refreshed. Retry the check; no current readiness conclusion is available.</p> : null}
    {data ? <>
      {historical ? <p className={styles.notice}>Previous sample only. {busy ? 'A new check is pending.' : 'The latest check failed.'}</p> : null}
      {!historical ? <p className={styles.outcome}>{data.sourceState === 'healthy' ? LABELS[data.disposition] : 'Recorded evidence was unavailable or incomplete'}</p> : null}
      <dl className={styles.facts}>
        <div><dt>Sampled</dt><dd><time dateTime={data.sampledAt}>{new Date(data.sampledAt).toLocaleString()}</time></dd></div>
        <div><dt>Source</dt><dd>{data.sourceState}</dd></div>
        <div><dt>{historical ? 'Previous disposition' : 'Recorded disposition'}</dt><dd>{data.disposition}</dd></div>
        <div><dt>Reason code</dt><dd><code>{data.reasonCode}</code></dd></div>
        <div><dt>Observed campaign state</dt><dd>{data.observedState ?? 'Unavailable'}</dd></div>
        <div><dt>Resource runtime binding</dt><dd>{data.resourceRuntimeRequired === null ? 'Unknown' : data.resourceRuntimeRequired ? 'Explicit private runtime required for a run attempt' : 'Not required by the recorded manifest'}</dd></div>
      </dl>
    </> : busy ? <p role="status">Reading saved campaign controls and outcomes…</p> : null}
    <p className={styles.note}>This checks saved campaign controls and outcomes—not current provider connection, quota, worker capacity, evaluator execution, or execution-lease availability. A recorded startable result is advisory; the runner must still perform its admission checks.</p>
  </div>;
}

/** Mount the shared query only on request; switching campaigns resets this disclosure. */
export function CampaignReadiness({ campaignId, universeId }: { campaignId: string; universeId: string }) {
  const [open, setOpen] = useState(false);
  return <section className={styles.panel} aria-label="Recorded campaign readiness">
    <button type="button" className={styles.button} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide recorded readiness' : 'Check recorded readiness'}</button>
    {!open ? <p className={styles.note}>Inspect saved controls, remaining budgets, and recovery conditions for this campaign. This does not start work.</p> : <RecordedCheck campaignId={campaignId} universeId={universeId} />}
  </section>;
}
