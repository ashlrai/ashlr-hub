import { useMemo } from 'react';
import type { TaskContextEvidence, TaskContextEventV1 } from '../../../../core/context/task-temporal-context.js';
import type { OutcomeTaskContextView } from '../../../../core/verse/outcome-task-context.js';
import { Button } from '../../../components/primitives/Button.js';
import { apiGet, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './TaskContext.module.css';

function time(value: string | null): string {
  if (!value) return 'Unknown';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms) : 'Unknown';
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function eventValid(value: unknown, taskRef: string): value is TaskContextEventV1 {
  if (!value || typeof value !== 'object') return false;
  const event = value as TaskContextEventV1;
  return event.schemaVersion === 1 && typeof event.eventId === 'string' && event.taskRef === taskRef && !!event.source
    && ['phantom', 'mail', 'calendar', 'document', 'github', 'project-memory'].includes(event.source.kind)
    && [event.source.provider, event.source.accountRef, event.source.objectRef, event.source.revisionRef].every(item => typeof item === 'string')
    && texts(event.sourceRefs) && texts(event.supersedes) && typeof event.content === 'string'
    && ['upsert', 'cancel'].includes(event.kind) && ['recorded', 'derived', 'hypothesis'].includes(event.epistemic)
    && typeof event.observedAt === 'string' && Number.isFinite(Date.parse(event.observedAt))
    && [event.occurredAt, event.validFrom, event.validUntil].every(item => item === null || typeof item === 'string' && Number.isFinite(Date.parse(item)));
}
function evidenceValid(value: unknown, taskRef: string): value is TaskContextEvidence {
  if (!eventValid(value, taskRef)) return false;
  const evidence = value as TaskContextEvidence;
  return ['current', 'superseded', 'canceled', 'expired', 'conflicted'].includes(evidence.status)
    && ['known', 'unknown'].includes(evidence.temporalResolution) && texts(evidence.replacedBy);
}
function Evidence({ evidence }: { evidence: TaskContextEvidence }) {
  return <li className={styles.evidence}>
    <div className={styles.line}><strong>{evidence.source.kind === 'phantom' ? 'Phantom task record' : evidence.source.kind.replaceAll('-', ' ')}</strong>
      <span>{evidence.status === 'current' ? 'Current record' : evidence.status.replaceAll('-', ' ')} · {evidence.epistemic}</span></div>
    <p className={styles.times}>Occurred {time(evidence.occurredAt)} · observed {time(evidence.observedAt)}</p>
    {evidence.temporalResolution === 'unknown' ? <p className={styles.note}>Effective time is unknown.</p> : null}
    <details><summary>Content and source references</summary><pre>{evidence.content}</pre>
      <dl><div><dt>Account</dt><dd>{evidence.source.accountRef}</dd></div><div><dt>Provider</dt><dd>{evidence.source.provider}</dd></div>
        <div><dt>Object</dt><dd>{evidence.source.objectRef}</dd></div><div><dt>Revision</dt><dd>{evidence.source.revisionRef}</dd></div>
        <div><dt>Valid from</dt><dd>{time(evidence.validFrom)}</dd></div><div><dt>Valid until</dt><dd>{time(evidence.validUntil)}</dd></div></dl>
      <ul aria-label="Source references">{evidence.sourceRefs.map(reference => <li key={reference}>{reference}</li>)}</ul>
    </details>
  </li>;
}
export function TaskContext({ outcomeId, taskId, title }: { outcomeId: string; taskId: string; title: string }) {
  const query = useMemo<QueryDef<OutcomeTaskContextView>>(() => ({
    key: `verse-task-context:${outcomeId}:${taskId}`,
    async fetch(signal) {
      const result = await apiGet<OutcomeTaskContextView>(`/api/verse/outcomes/${encodeURIComponent(outcomeId)}/tasks/${encodeURIComponent(taskId)}/context`, signal);
      if (!result || result.schemaVersion !== 1 || result.outcomeId !== outcomeId || result.taskId !== taskId || typeof result.active !== 'boolean'
        || !result.coverage || !['healthy', 'missing', 'degraded'].includes(result.coverage.sourceState) || typeof result.coverage.complete !== 'boolean'
        || !texts(result.coverage.stopReasons) || typeof result.taskRef !== 'string' || !Number.isSafeInteger(result.outcomeRevision)
        || !Array.isArray(result.current) || !result.current.every(item => evidenceValid(item, result.taskRef))
        || !Array.isArray(result.history) || !result.history.every(item => evidenceValid(item, result.taskRef))
        || !Array.isArray(result.conflicts) || !result.conflicts.every(item => item && typeof item.kind === 'string' && texts(item.eventIds)
          && (item.alternatives === undefined || Array.isArray(item.alternatives) && item.alternatives.every(event => eventValid(event, result.taskRef))))
        || !Array.isArray(result.sources) || !result.sources.every(item => item && ['outcome', 'private-task-context', 'agent-action-ledger'].includes(item.source)
          && ['healthy', 'missing', 'degraded'].includes(item.sourceState) && typeof item.complete === 'boolean' && texts(item.stopReasons))) throw new Error('Task context is unavailable.');
      return result;
    },
  }), [outcomeId, taskId]);
  const read = useQuery(query);
  const refetch = useRefetch(query);
  const value = read.status === 'error' ? null : read.data;
  return <section className={styles.panel} aria-label={`Context for ${title}`}>
    <div className={styles.header}><h4>Task context</h4><Button size="sm" variant="ghost" onClick={refetch}>Refresh task context</Button></div>
    <p className={styles.note}>Recorded Phantom evidence for this task. External inboxes and personal agent accounts are not imported here.</p>
    {read.status === 'error' ? <p role="alert">Task context is unavailable. {readFailureReason(read.error)}</p>
      : !value ? <p role="status" aria-busy="true">Reading task context…</p> : <>
        {!value.active ? <p role="status">This task belongs to an earlier outcome revision.</p> : null}
        {value.coverage.sourceState !== 'healthy' || !value.coverage.complete ? <p role="status">Context is incomplete. Missing records and current facts remain unknown.</p> : null}
        <p className={styles.times}>As of {time(value.asOf)} · observed through {time(value.observedThrough)}</p>
        {value.conflicts.length ? <p role="status">Conflicting or unresolved evidence: {value.conflicts.map(conflict => conflict.kind.replaceAll('-', ' ')).join(', ')}.</p> : null}
        <h5>Current records</h5>{value.current.length ? <ul className={styles.list}>{value.current.map(evidence => <Evidence key={evidence.eventId} evidence={evidence} />)}</ul>
          : <p className={styles.note}>{value.coverage.complete && value.coverage.sourceState === 'healthy' ? 'No current records in this projection.' : 'No current records available; coverage is incomplete.'}</p>}
        {value.conflicts.some(conflict => conflict.alternatives?.length) ? <details><summary>Conflicting versions</summary>
          {value.conflicts.map((conflict, index) => conflict.alternatives?.length ? <div key={index}><h5>{conflict.kind.replaceAll('-', ' ')}</h5>
            {conflict.alternatives.map((alternative, position) => <div key={`${alternative.eventId}:${position}`}><p>{alternative.epistemic} · observed {time(alternative.observedAt)} · {alternative.source.revisionRef}</p>
              <pre>{alternative.content}</pre><ul aria-label="Conflicting source references">{alternative.sourceRefs.map(reference => <li key={reference}>{reference}</li>)}</ul></div>)}</div> : null)}
        </details> : null}
        <details><summary>History and coverage</summary>
          {value.history.length ? <ul className={styles.list}>{value.history.map(evidence => <Evidence key={evidence.eventId} evidence={evidence} />)}</ul> : <p>No historical records in this projection.</p>}
          <ul aria-label="Context source coverage">{value.sources.map(source => <li key={source.source}>{source.source.replaceAll('-', ' ')}: {source.sourceState}, {source.complete ? 'complete' : 'incomplete'}{source.stopReasons.length ? ` — ${source.stopReasons.join(', ')}` : ''}</li>)}</ul>
        </details>
      </>}
  </section>;
}
