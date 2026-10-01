import { useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { optionalQuery } from '../command/surface-data.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import { EXECUTION_FEEDBACK_CASE_PATH } from '../../../../core/verse/execution-feedback-api-types.js';
import { CASE_BASIS_LABELS, CASE_RESULT_LABELS, CASE_STAGE_LABELS, narrowExecutionCaseRead } from './execution-case-model.js';
import styles from './execution-case.module.css';

/** Mounted only for the outcome the user selects; does not fetch every case. */
export function ExecutionCaseDetails({ caseId }: { caseId: string }) {
  const query = useMemo(() => optionalQuery(`verse-execution-case:${caseId}`,
    `${EXECUTION_FEEDBACK_CASE_PATH}${encodeURIComponent(caseId)}`, 'Recorded execution details',
    raw => narrowExecutionCaseRead(raw, caseId)), [caseId]);
  const reading = useQuery(query, { freshMs: 15_000 });
  const refetch = useRefetch(query);
  const [openedAt] = useState(() => Date.now());
  const now = useNow(2_000);
  const value = reading.data?.value;
  usePollWhileVisible(refetch, value?.state === 'warming' && now - openedAt < 30_000 ? 2_000 : 15_000);
  const detail = value?.detail;
  if (!detail) return <p className={styles.note}>{reading.data?.reason ?? (value?.state === 'unavailable'
    ? 'Recorded details are unavailable. Missing evidence does not mean no work shipped.' : 'Reading recorded execution details…')}</p>;
  const partial = detail.coverage.dispatch !== 'healthy' || detail.coverage.proposals !== 'healthy' ||
    detail.coverage.ledger !== 'healthy' || detail.coverage.invalidRecords > 0 || detail.coverage.conflictingRecords > 0;
  return <section className={styles.panel} aria-label="Selected execution timeline">
    <p className={styles.note}>{partial ? 'Partial evidence. Unrecorded stages remain unknown.' : 'Stages supported by recorded evidence.'}
      {value?.state === 'stale' ? ' Showing the last reading while it refreshes.' : ''}</p>
    <ol className={styles.timeline}>
      {detail.timeline.map((row, index) => <li key={index} data-result={row.result}>
        <div className={styles.heading}><strong>{CASE_STAGE_LABELS[row.stage]}</strong><span>{CASE_RESULT_LABELS[row.result]}</span></div>
        <p className={styles.note}>{CASE_BASIS_LABELS[row.basis]} · {row.at ? <time dateTime={row.at} title={row.at}>{formatRelative(row.at)}</time> : 'Time unknown'}</p>
        {row.ci !== undefined || row.suite !== undefined ? <p className={styles.note}>
          {row.ci === undefined ? '' : `CI: ${row.ci === 'none' ? 'none recorded' : row.ci}`}
          {row.ci !== undefined && row.suite !== undefined ? ' · ' : ''}
          {row.suite === undefined ? '' : `Local verification: ${row.suite === 'not-run' ? 'not run' : row.suite}`}
        </p> : null}
        {row.href ? <a href={row.href} {...(row.href.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {row.href.startsWith('https:') ? 'Open GitHub pull request' : row.href.startsWith('/inbox/') ? 'Open proposal' : 'Open run'}</a> : null}
      </li>)}
    </ol>
    {!detail.timeline.length ? <p className={styles.note}>No timeline entries could be confirmed.</p> : null}
    <p className={styles.note}>Release and deployment are not recorded here. A merge or green check alone does not establish production status.</p>
    {value?.refreshedAt ? <p className={styles.note}>Last reading <time dateTime={value.refreshedAt} title={value.refreshedAt}>{formatRelative(value.refreshedAt)}</time></p> : null}
    <Button size="sm" variant="ghost" onClick={refetch}>Refresh details</Button>
  </section>;
}
