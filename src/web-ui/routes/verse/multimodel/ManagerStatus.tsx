import { useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { writeOutcome } from '../fleet/outcomes-queries.js';
import { pendingManagerMessage, managerSessionQuery } from './manager-queries.js';
import styles from './multimodel.module.css';

/** Polling is sidecar reconciliation, not provider contact; hidden sections pause it. */
export function ManagerStatus({ sessionId, retryMessage }: { sessionId: string; retryMessage?: (text: string) => Promise<void> }) {
  const query = useMemo(() => managerSessionQuery(sessionId), [sessionId]);
  const read = useQuery(query, { freshMs: 0 }); const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 3_000);
  const [retrying, setRetrying] = useState(false);
  const savedMessage = pendingManagerMessage(sessionId);
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const value = read.data;
  const association = value?.sourceState === 'healthy' ? value.association : null;
  const manager = association?.manager;
  const paused = association?.paused === true;
  const label = !value && !read.error ? 'Loading manager…' : read.error || value?.sourceState === 'degraded' ? 'Manager unavailable' : !manager ? 'Manager ready for your request'
    : paused ? 'Manager paused' : manager.running ? `${manager.running.intent === 'review' ? 'Reviewing' : manager.running.intent === 'replan' ? 'Replanning' : 'Planning'} · ${manager.running.route.model}`
      : manager.next ? 'Waiting for the fleet' : manager.latest?.state === 'failed' ? 'Manager stage failed' : 'Manager idle';
  async function togglePause() {
    if (!association) return;
    setPending(true); setError(null);
    try { await writeOutcome(paused ? 'resume' : 'pause', association.outcomeId, crypto.randomUUID(), association.revision); refresh(); }
    catch { setError('Could not update the manager. Refresh and retry.'); }
    finally { setPending(false); }
  }
  return <span className={styles.group}>
    <span className={styles.why} role="status">{label}</span>
    {association ? <button type="button" className={styles.chip} disabled={pending} onClick={() => { void togglePause(); }}
      title={paused ? 'Resume this outcome with its current scope' : 'Pause this outcome; the resident observes cancellation before its next effect'}>{pending ? 'Saving…' : paused ? 'Resume manager' : 'Pause manager'}</button> : null}
    {savedMessage && retryMessage ? <button type="button" className={styles.chip} disabled={retrying} onClick={() => { setRetrying(true); void retryMessage(savedMessage.text).catch(() => setError('The saved message could not be confirmed. Retry it again.')).finally(() => setRetrying(false)); }}
      title="Retry the same saved message; your current draft stays until this message is confirmed">{retrying ? 'Retrying…' : 'Retry saved message'}</button> : null}
    {error ? <span className={styles.noticeError} role="alert">{error}</span> : null}
  </span>;
}
