import { useEffect, useId, useRef, useState } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { readingAge } from './budget-model.js';
import { updateResetSpending } from './reset-spending-queries.js';
import { latestResetBudgetView, readResetSpendingAccount, readResetSpendingStatus, resetStatusFresh, RESET_STATE_LABELS } from './reset-spending-model.js';
import styles from './reset-spending.module.css';
import { getAuthSnapshot, getMutationToken, subscribeAuth } from '../../../data/auth-store.js';

interface ControlProps {
  view: BudgetView | null;
  nowMs: number;
  onReviewGrant?: () => void;
  readOnly?: boolean;
}

function useResetControl(incoming: BudgetView | null) {
  const gate = useTokenGate();
  const [confirmed, setConfirmed] = useState<BudgetView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let token = getMutationToken();
    let phase = getAuthSnapshot().phase;
    const unsubscribe = subscribeAuth(() => {
      const nextToken = getMutationToken(); const nextPhase = getAuthSnapshot().phase;
      if (token !== nextToken || phase !== nextPhase) {
        generation.current += 1;
        setConfirmed(null); setNote(null); setError(null);
      }
      token = nextToken; phase = nextPhase;
    });
    return () => { mounted.current = false; generation.current += 1; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (incoming === null) { generation.current += 1; setConfirmed(null); setNote(null); }
  }, [incoming]);
  // A later shared reading supersedes our confirmed response; never keep a stale ON forever.
  const view = incoming === null ? null : latestResetBudgetView(confirmed, incoming);
  async function apply(update: Parameters<typeof updateResetSpending>[0]) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true); setNote(null); setError(null);
    let appliedGeneration: number | null = null;
    try {
      const next = await gate.run('Change allowance before resets', async () => {
        const attempt = generation.current;
        appliedGeneration = attempt;
        return updateResetSpending(update, () => mounted.current && generation.current === attempt);
      });
      if (next && mounted.current && generation.current === appliedGeneration) { setConfirmed(next); setNote('Saved and confirmed. Dispatch still checks authority, task fit and provider limits.'); }
    } catch (err) { if (mounted.current) setError(describeContextError(err)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  return { view, busy, note, error, apply, gate };
}

function Feedback({ control }: { control: ReturnType<typeof useResetControl> }) {
  return <>
    {control.note ? <p className={styles.note} role="status">{control.note}</p> : null}
    {control.error ? <p className={styles.error} role="alert">{control.error}</p> : null}
    <MutationTokenDialog {...control.gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
  </>;
}

export function ResetSpendingControl({ view: incoming, nowMs, onReviewGrant, readOnly = false }: ControlProps) {
  const control = useResetControl(incoming);
  const status = readResetSpendingStatus(control.view);
  const id = useId();
  const fresh = status && resetStatusFresh(status, control.view, nowMs);
  const legacy = status?.mode === 'legacy-priority';
  const held = status ? Object.keys(status.accounts).some(seatId => {
    const account = readResetSpendingAccount(status, seatId);
    return account && ['signed-floor', 'producer-not-granted', 'authority-paused'].includes(account.state);
  }) : false;
  return <section className={styles.control} aria-labelledby={id} aria-busy={control.busy || undefined}>
    <div className={styles.row}>
      <div className={styles.copy}>
        <h3 id={id} className={styles.title}>Use allowance before resets</h3>
        <p className={styles.secondary}>{!control.view ? 'Allowance setting has not loaded yet.'
          : !status ? 'Controls unavailable — update Ashlr to manage this setting.'
          : legacy ? 'Routing favors upcoming resets; reserve shrinking is not enabled.'
          : status.mode === 'disabled' ? 'Off · reset priority and reserve shrinking are disabled.'
          : 'Saved On · useful work may release reserve when its verified task fit permits.'}</p>
      </div>
      {legacy ? <div className={styles.actions}>
        <Button size="sm" disabled={readOnly || control.busy} onClick={() => void control.apply({ resetSpending: { enabled: true } })}>Enable allowance before resets</Button>
        <Button size="sm" variant="ghost" disabled={readOnly || control.busy} onClick={() => void control.apply({ resetSpending: { enabled: false } })}>Turn reset priority off</Button>
      </div> : <Switch checked={status?.mode === 'enabled'} disabled={!status || readOnly || control.busy}
        aria-label="Use allowance before resets" onChange={enabled => void control.apply({ resetSpending: { enabled } })} />}
    </div>
    <p className={styles.secondary}>Reserve shrinking uses subscription allowances only. An unverified billing boundary holds it; ordinary billing settings stay unchanged.</p>
    {status && !fresh ? <p className={styles.secondary}>Last reading · current eligibility unconfirmed.</p> : null}
    {status?.mode === 'enabled' && held ? <p className={styles.secondary}>Saved On; authority or signed account restrictions still hold.
      {onReviewGrant ? <Button size="sm" variant="ghost" disabled={readOnly} onClick={onReviewGrant}>Review grant</Button> : null}</p> : null}
    <Feedback control={control} />
  </section>;
}

export function ResetSpendingAccountControl({ view: incoming, nowMs, seatId, label, onReviewGrant, readOnly = false }: ControlProps & { seatId: string; label: string }) {
  const control = useResetControl(incoming);
  const status = readResetSpendingStatus(control.view);
  const account = readResetSpendingAccount(status, seatId);
  if (!status || !account) return null;
  const fresh = resetStatusFresh(status, control.view, nowMs);
  const actionable = ['signed-floor', 'producer-not-granted', 'authority-paused'].includes(account.state);
  return <div className={styles.account} aria-busy={control.busy || undefined}>
    <div className={styles.row}>
      <span className={styles.secondary}>Allowance before resets</span>
      <select aria-label={`Allowance before resets: ${label}`} value={account.mode} disabled={readOnly || control.busy}
        className={styles.select} onChange={event => void control.apply({ seatId, policy: { resetSpending: event.target.value === 'inherit' ? null : event.target.value === 'enabled' } })}>
        <option value="inherit">Use global setting</option><option value="enabled">On for this account</option><option value="disabled">Off for this account</option>
      </select>
    </div>
    <details className={styles.details}>
      <summary>{fresh ? RESET_STATE_LABELS[account.state] : 'Current eligibility unconfirmed'}</summary>
      <p>{account.reason}</p>
      {account.mode === 'enabled' && status.mode !== 'enabled' ? <p>The global setting must be On; an account override cannot enable reserve shrinking by itself.</p> : null}
      <p>Saved reserve {account.savedReservePercent}% · signed minimum {account.signedFloorPercent === null ? 'unconfirmed' : `${account.signedFloorPercent}%`}.</p>
      <p>{!fresh || account.effectiveReservePercent === null ? 'No current task reserve applied.' : `Task-derived reserve ${Math.round(account.effectiveReservePercent * 10) / 10}%${account.state === 'held' ? ' · admission held' : ''}.`}</p>
      {account.deadline ? <p>Subscription reset {describeResetAt(account.deadline, nowMs)}.</p> : null}
      {fresh && account.forecastBasis ? <p>Observed completion estimate: {Math.max(1, Math.round(account.forecastBasis.p75Ms / 60_000))} min · {account.forecastBasis.samples} samples (75th percentile){account.forecastBasis.pooled ? ' · pooled cohort' : ''}.</p> : null}
      <p>Subscription-only boundary: {account.subscriptionOnly}. Checked {readingAge(status.checkedAt, nowMs)}.</p>
      {account.constraints.map((reason, index) => <p key={index}>{reason}</p>)}
      {actionable && onReviewGrant ? <Button size="sm" variant="ghost" disabled={readOnly} onClick={onReviewGrant}>Review grant</Button> : null}
    </details>
    <Feedback control={control} />
  </div>;
}
