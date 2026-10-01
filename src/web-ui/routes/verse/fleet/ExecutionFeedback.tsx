import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { optionalQuery } from '../command/surface-data.js';
import { formatRelative } from '../autonomy/format.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import { EXECUTION_FEEDBACK_PATH } from '../../../../core/verse/execution-feedback-api-types.js';
import { narrowExecutionFeedbackRead, OUTCOME_LABELS } from './execution-feedback-model.js';
import type { ExecutionFeedbackOutcome } from '../../../../core/fleet/execution-feedback-types.js';
import styles from './execution-feedback.module.css';
import { ExecutionCaseDetails } from './ExecutionCaseDetails.js';

const feedbackQuery = optionalQuery('verse-execution-feedback', EXECUTION_FEEDBACK_PATH, 'Recorded execution outcomes', narrowExecutionFeedbackRead);

function FeedbackReading() {
  const reading = useQuery(feedbackQuery, { freshMs: 15_000 });
  const refetch = useRefetch(feedbackQuery);
  const [openedAt] = useState(() => Date.now());
  const [inspectOpen, setInspectOpen] = useState(false);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const now = useNow(2_000);
  const value = reading.data?.value;
  // Catch a completed cold worker promptly, then return to the normal cadence.
  // The shared visibility hook pauses both hidden surfaces and hidden windows.
  usePollWhileVisible(refetch, value?.state === 'warming' && now - openedAt < 30_000 ? 2_000 : 15_000);
  const feedback = value?.feedback;
  if (!value) return <p className={styles.note}>{reading.data?.reason ?? 'Reading recorded outcomes…'}</p>;
  if (!feedback) return <p className={styles.note}>{value.state === 'warming' ? 'Reading recorded outcomes…' : 'Recorded execution evidence is unavailable.'}</p>;
  const known = feedback.counts !== null;
  const measured = feedback.counts ?? feedback.observedCounts;
  const largest = Math.max(1, ...Object.values(measured));
  return (
    <div className={styles.body}>
      <p className={styles.note}>
        {feedback.sourceState === 'missing' ? 'No readable execution history. Totals are unknown.' : known ? 'Recorded outcomes in the last seven days.' : 'Partial history. These are observed counts; full totals are unknown.'}
        {value.state === 'stale' ? ' Showing the last reading while it refreshes.' : ''}
      </p>
      {feedback.sourceState !== 'missing' ? <dl className={styles.counts} aria-label={known ? 'Recorded execution totals' : 'Observed execution counts, incomplete history'}>
        {(Object.keys(OUTCOME_LABELS) as ExecutionFeedbackOutcome[]).map((outcome) => (
          <div key={outcome}>
            <dt>{OUTCOME_LABELS[outcome]}</dt>
            <dd>{known ? '' : '≥ '}{measured[outcome]}
              <span className={styles.bar} aria-hidden="true" data-outcome={outcome}
                style={{ width: `${measured[outcome] / largest * 100}%` }} />
            </dd>
          </div>
        ))}
      </dl> : null}
      {feedback.sourceState !== 'missing' ? <p className={styles.note}>Bars compare recorded counts; they are not success rates.</p> : null}
      {value.refreshedAt ? <p className={styles.note} title={value.refreshedAt}>Last reading {formatRelative(value.refreshedAt)}</p> : null}
      <p className={styles.note}>Produced proposals are counted separately from verification and shipping. Opening this view starts no agent or model call.</p>
      {feedback.coverage.proposalSource === 'degraded' || feedback.coverage.proposalSource === 'unavailable'
        ? <p className={styles.note}>Proposal history is incomplete; an unrecorded proposal is not evidence that none exists.</p> : null}
      {feedback.cases.length ? <details className={styles.cases} open={inspectOpen} onToggle={(event) => setInspectOpen(event.currentTarget.open)}>
        <summary>Inspect {feedback.cases.length} recorded outcomes</summary>
        {inspectOpen ? <><ul>{feedback.cases.map((row) => <li key={row.caseId}>
          <span>{OUTCOME_LABELS[row.outcome]}{row.failureKind ? ` · ${row.failureKind}` : ''}</span>
          <span>{formatRelative(row.endedAt)}{row.proposalRecorded ? ' · proposal recorded' : ''}</span>
          <Button size="sm" variant="ghost" aria-expanded={selectedCase === row.caseId}
            onClick={() => setSelectedCase(selectedCase === row.caseId ? null : row.caseId)}>
            {selectedCase === row.caseId ? 'Hide timeline' : 'View timeline'}
          </Button>
          {selectedCase === row.caseId ? <ExecutionCaseDetails key={row.caseId} caseId={row.caseId} /> : null}
        </li>)}</ul></> : null}
      </details> : null}
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        <Button size="sm" variant="ghost" onClick={() => executeCatalogCommand('surface.growth', { via: 'button' })}>Open lessons</Button>
      </div>
    </div>
  );
}

/** Mount the query only when opened; leave chats, drafts and routing untouched. */
export function ExecutionFeedback() {
  const [open, setOpen] = useState(false);
  return <details className={styles.panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Execution feedback <span>outcomes and learning evidence</span></summary>
    {open ? <FeedbackReading /> : null}
  </details>;
}
