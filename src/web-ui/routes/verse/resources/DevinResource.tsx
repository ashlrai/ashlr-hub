/**
 * routes/verse/resources/DevinResource.tsx — Devin in the Resources drawer
 * (⌘.) (3.15): connection status, ACUs used against the budget, sessions
 * running today, a reply box for sessions waiting on Mason, and the same
 * Chat / Fleet readiness lines every resource shows (the verdicts come from
 * the server, core/devin/service.ts devinStatus).
 *
 * ACUs are Devin's own readings; dollars are an estimate and say so. A
 * server without the lane (404) renders nothing — the drawer simply has no
 * Devin card, never a false "not connected". Setting up happens in a
 * terminal (`ashlr devin connect`, hidden input): the page never takes a key.
 *
 * A waiting session's row also opens its Evidence (the same timeline sheet
 * cloud tasks use, cloud/EvidenceTimeline.tsx): session status, ACUs against
 * its cap, messages Verse sent, and its PR onward once there is one.
 */
import { lazy, Suspense, useState } from 'react';
import type { DevinTaskV1 } from '../../../../core/devin/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Input } from '../../../components/primitives/Input.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { acuLevel, devinHeadline, devinModelsLines, devinReadinessRow, devinUsageEvidence, DEVIN_USAGE_LINK, formatAcu, safeDevinHref, waitingTasks } from '../devin/devin-model.js';
import { DEVIN_POLL_MS, devinQuery, messageDevinTask } from '../devin/devin-queries.js';
import { ReadinessLines } from './ReadinessLines.js';
import { ResourceFacts } from './ResourceFacts.js';
import type { ResourceFactsView } from './resources-model.js';
import type { CostBasis } from '../../../../core/routing/tiers.js';
import styles from './ResourcesDrawer.module.css';

/** The evidence sheet is its own chunk, fetched the first time a row's Evidence opens. */
const EvidenceTimeline = lazy(() => import('../cloud/EvidenceTimeline.js'));

function Reply({ task }: { task: DevinTaskV1 }) {
  const gate = useTokenGate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const session = safeDevinHref(task.sessionUrl, 'app.devin.ai');
  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    setNote(null);
    try {
      const done = await gate.run('Send this reply to the Devin session.', () => messageDevinTask(task.id, message));
      if (done === null) return;
      setText('');
      setNote({ tone: 'success', text: 'Sent. Devin picks it up in the session.' });
    } catch (err) {
      setNote({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={styles.devinWaiting} data-devin-task={task.id}>
      <p className={styles.subtle}>
        <strong>{task.title}</strong> — {task.stateReason ?? 'Devin is waiting for you.'}
        {session ? (
          <>
            {' '}
            <a className={styles.external} href={session} target="_blank" rel="noopener noreferrer">
              Open in Devin
              <IconExternalLink />
              <span className={styles.visuallyHidden}> (opens in a new tab)</span>
            </a>
          </>
        ) : null}
        {' '}
        <Button size="sm" variant="ghost" aria-haspopup="dialog" aria-label={`Evidence: ${task.title}`} onClick={() => setEvidenceOpen(true)}>
          Evidence
        </Button>
      </p>
      <form className={styles.devinReply} onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Input aria-label={`Reply to Devin: ${task.title}`} value={text} maxLength={4000} placeholder="Reply to Devin…" onChange={(event) => setText(event.target.value)} />
        <Button size="sm" type="submit" busy={busy} disabled={text.trim() === ''}>Send</Button>
      </form>
      {note ? <p className={styles.status} data-tone={note.tone} role="status"><span className={styles.statusDot} aria-hidden="true" /><span>{note.text}</span></p> : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
      {evidenceOpen ? (
        <Suspense fallback={null}>
          <EvidenceTimeline taskId={task.id} title={task.title} open onClose={() => setEvidenceOpen(false)} />
        </Suspense>
      ) : null}
    </li>
  );
}

export interface DevinResourceProps {
  /** 3.15: tier · cost basis · models — the facts row every card carries (the drawer builds it from the Devin seats). */
  facts?: ResourceFactsView | null;
  /** Every cost basis the Devin seats span (cloud ACU credits, the CLI's plan). */
  bases?: readonly CostBasis[];
}

export function DevinResource({ facts = null, bases }: DevinResourceProps = {}) {
  const read = useQuery(devinQuery);
  const refetch = useRefetch(devinQuery);
  usePollWhileVisible(refetch, DEVIN_POLL_MS);
  if (read.data === undefined && read.status !== 'error') {
    return (
      <li className={styles.card} data-resource="devin" data-devin="loading">
        <p className={styles.subtle} aria-busy="true">Reading Devin…</p>
      </li>
    );
  }
  if (!read.data?.available) return null;
  const overview = read.data.value;
  if (!overview) {
    return (
      <li className={styles.card} data-resource="devin" data-devin="unrecognised">
        <p className={styles.subtle}>{read.data.reason ?? 'Unrecognized response — update Ashlr.'}</p>
      </li>
    );
  }
  const { status, budget } = overview;
  const head = devinHeadline(status);
  const live = status.enabled && status.connected;
  const usage = devinUsageEvidence(budget);
  const available = usage?.free ?? Math.max(0, budget.acuRemaining - Math.max(0, budget.acuInFlight));
  const level = acuLevel({ ...budget, acuRemaining: available });
  const leftPercent = budget.acuBudgetTotal > 0 ? Math.max(0, Math.min(100, (available / budget.acuBudgetTotal) * 100)) : 0;
  const waiting = waitingTasks(overview.tasks);
  const modelLines = overview.cli && overview.cli.state !== 'missing' ? devinModelsLines(overview.models) : null;
  return (
    <li className={styles.card} data-resource="devin" data-devin={status.state}>
      <div className={styles.cardHead}>
        <MonogramTile monogram="Dv" engine="devin" size="sm" />
        <h4 className={styles.cardName}>
          <span>Devin</span>
          <span className={styles.plan}>{status.principalName ?? 'Cognition'}</span>
        </h4>
      </div>
      {facts !== null ? (
        <ResourceFacts
          facts={{ ...facts, reserve: live && budget.budget.reserveAcu > 0 ? `${formatAcu(budget.budget.reserveAcu)} kept for you` : facts.reserve }}
          {...(bases ? { bases } : {})}
        />
      ) : null}
      <p className={styles.status} data-tone={head.tone} title={status.reason}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusLabel}>{head.word}</span>
      </p>
      <p className={styles.subtle}>{status.reason}</p>
      {live ? (
        <>
          <p className={styles.creditsHead}>
            <span className={styles.creditsAmount}>{formatAcu(available)} of {formatAcu(budget.acuBudgetTotal)} {usage ? 'available' : 'left'}</span>
            <span className={styles.pill} data-tone="neutral" title="Your configured allowance minus recorded usage and unresolved exposure; not a provider-reported credit balance or subscription quota.">tracked budget</span>
            {budget.paused ? <span className={styles.pill} data-tone="warning">paused</span> : null}
          </p>
          <div className={styles.meter} data-level={level} data-single>
            <span
              className={styles.meterTrack}
              role="img"
              aria-label={usage ? `Devin tracked budget: ${formatAcu(usage.reported)} reported usage plus adjustment, ${formatAcu(usage.held)} held exposure, ${formatAcu(available)} available of ${formatAcu(budget.acuBudgetTotal)}` : `Devin ACUs: ${formatAcu(budget.acuUsed)} accounted for of ${formatAcu(budget.acuBudgetTotal)}, ${formatAcu(available)} left; usage and reservations are not separated by this server`}
            >
              <span className={styles.meterFill} data-kind="left" style={{ width: `${Math.round(leftPercent)}%` }} />
            </span>
            <span className={styles.meterValue} aria-hidden="true">{Math.round(leftPercent)}% left</span>
          </div>
          <p className={styles.subtle}>
            {budget.running} running · {budget.sessionsToday} today · {formatAcu(budget.acuToday)} today, used or held
          </p>
          {usage ? <p className={styles.subtle}>
            {formatAcu(usage.reported)} reported usage + adjustment · {formatAcu(usage.held)} held exposure · about ${budget.estimatedUsdUsed} for recorded usage
            <span className={styles.pill} data-tone="neutral" title={budget.estimateNote}>estimate</span>
          </p> : <p className={styles.fine}>This server combines reservations and usage. Recorded cost coverage is unavailable.</p>}
          {!budget.canLaunch.ok ? (
            <p className={styles.status} data-tone="warning"><span className={styles.statusDot} aria-hidden="true" /><span>{budget.canLaunch.reason}</span></p>
          ) : null}
          {waiting.length > 0 ? (
            <ul className={styles.devinWaitingList} aria-label="Devin sessions waiting for you">
              {waiting.map((task) => <Reply key={task.id} task={task} />)}
            </ul>
          ) : null}
          <p className={styles.fine}>{budget.estimateNote}</p>
          <a className={styles.external} href={DEVIN_USAGE_LINK} target="_blank" rel="noopener noreferrer">
            Real usage on app.devin.ai
            <IconExternalLink />
            <span className={styles.visuallyHidden}> (opens in a new tab)</span>
          </a>
        </>
      ) : null}
      {modelLines ? (
        // 3.15: the CLI's own catalog (`devin models list`), summarised; the
        // default is what a new Devin (CLI) chat starts on (devin.defaultModel).
        <p className={styles.subtle} data-devin-models={overview.models?.source ?? 'unknown'}
          title={modelLines.stale ? 'Not listed yet — the full list appears after the CLI is asked (in the background).' : undefined}>
          {modelLines.catalog} · {modelLines.defaultLine}
        </p>
      ) : null}
      {overview.cli && overview.cli.state !== 'missing' ? (
        // The CLI reports no ACU / usage numbers, so its chats are not in the
        // budget above — say that instead of implying they are counted.
        <p className={styles.fine} data-devin-cli={overview.cli.state}>
          Devin (CLI){overview.cli.state === 'logged-out' ? <> — logged out; run <code>devin auth login</code></> : null}: usage not reported by the CLI,
          so CLI chats are not counted here.
        </p>
      ) : null}
      <ReadinessLines row={devinReadinessRow(status)} />
    </li>
  );
}
