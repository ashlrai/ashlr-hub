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
import type { DevinDailyConsumption } from '../../../../core/devin/client.js';
import type { DevinTaskV1 } from '../../../../core/devin/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Input } from '../../../components/primitives/Input.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { acuLevel, devinConsumptionEvidence, devinHeadline, devinModelsLines, devinReadinessRow, devinSelfIdentityEvidence, devinUsageEvidence, DEVIN_USAGE_LINK, formatAcu, formatConsumptionAcu, safeDevinHref, waitingTasks } from '../devin/devin-model.js';
import { DEVIN_POLL_MS, devinQuery, messageDevinTask, refreshDevinConsumption } from '../devin/devin-queries.js';
import { requestGuarded } from '../shell/guarded-action.js';
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

/** Explicit pagination keeps the full available history reachable without a large initial render. */
function ConsumptionHistory({ days }: { days: DevinDailyConsumption['days'] }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(days.length / 20));
  const current = Math.min(page, pages - 1);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Daily consumption ({days.length} reporting buckets)</summary>
    {open ? <>
      <ul aria-label="Devin daily consumption">
        {days.slice(current * 20, (current + 1) * 20).map(day => <li key={day.date}>
          <p className={styles.fine}>Provider date {day.date} · {formatConsumptionAcu(day.acus)}</p>
          <p className={styles.fine}>{Object.entries(day.products).map(([product, acus]) => `${product}: ${acus === null ? 'not reported' : formatConsumptionAcu(acus)}`).join(' · ')}</p>
        </li>)}
      </ul>
      {pages > 1 ? <div aria-label="Consumption history pages">
        <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button>
        <span className={styles.fine}>Page {current + 1} of {pages}</span>
        <Button size="sm" variant="ghost" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</Button>
      </div> : null}
    </> : null}
  </details>;
}

export function DevinResource({ facts = null, bases }: DevinResourceProps = {}) {
  const [consumptionError, setConsumptionError] = useState<string | null>(null);
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
  const capturedIdentity = devinSelfIdentityEvidence(status.selfIdentity);
  const identity = capturedIdentity?.principal === status.principal ? capturedIdentity : null;
  const consumption = devinConsumptionEvidence(overview.consumption);
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
      {status.connected ? <section aria-label="Devin cached account observation">
        <p className={styles.fine}>
          Cloud account: {identity ? <>{identity.principal === 'service_user' ? 'Service account' : 'Personal access token'} · captured <time dateTime={identity.observedAt}>{new Date(identity.observedAt).toLocaleString()}</time></> : 'not reported'}
        </p>
        <p className={styles.fine}>
          {identity ? 'Cached Devin API /self observation. ' : ''}Max weekly allowance is not reported; subscription-only spending is unverified.
        </p>
      </section> : null}
      {status.connected ? <section aria-label="Devin organization consumption">
        <p className={styles.creditsHead}><span className={styles.creditsAmount}>{consumption?.value ?? 'Consumption not reported by this server'}</span>
          <span className={styles.pill} data-tone="neutral">organization API</span></p>
        {consumption?.lines.map((line, index) => <p className={styles.fine} key={index}>{line}</p>)}
        {consumption?.report ? <ConsumptionHistory key={overview.consumption?.fetchedAt} days={consumption.report.days} /> : null}
        {consumptionError ? <p role="alert" className={styles.fine}>{consumptionError}</p> : null}
        <Button size="sm" variant="ghost" onClick={() => requestGuarded({
          title: 'Read Devin organization consumption?', body: '', confirmLabel: 'Read consumption', destructive: false,
          skipConfirm: true, token: true, tokenReason: 'Read organization ACU consumption only — no session is started.',
          run: refreshDevinConsumption, onDone: () => setConsumptionError(null), onError: setConsumptionError,
        })}>Read consumption</Button>
      </section> : null}
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
