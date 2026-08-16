/**
 * routes/inbox/ProposalDetail.tsx — evidence + diff review + approve/reject
 * for one proposal (operator-console brief items 2-4). Every judge-verdict
 * field is wrapped in <Epistemic/> keyed off decisionEvidence.sourceQuality
 * (src/core/web/api.ts's decisions-ledger join) — when the ledger read is
 * degraded or no decision row matches this proposal, this renders "unknown"
 * and withholds nothing it would have to guess, rather than presenting an
 * absent judgeReasonCode as "never judged". A judge-parse-failure/
 * judge-network-failure reason code is an infra failure, NOT a considered
 * judgment, and is rendered with its own distinct label/tone — never folded
 * into a genuine judge-review (see JUDGE_REASON_DISPLAY below).
 */
import { useState } from 'react';
import type { DecisionEntry, JudgeDecisionReasonCode } from '../../data/api-types.js';
import { proposalDetailQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { approveProposal, rejectProposal } from '../../data/mutations.js';
import { DispatchDisabledError } from '../../data/client.js';
import { Epistemic } from '../../components/primitives/Epistemic.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DiffViewer } from './DiffViewer.js';
import styles from './ProposalDetail.module.css';

const JUDGE_REASON_DISPLAY: Record<JudgeDecisionReasonCode, { label: string; tone: Tone }> = {
  'judge-ship-would-merge': { label: 'Ship (would merge)', tone: 'success' },
  'judge-ship-review-required': { label: 'Ship (review required)', tone: 'success' },
  'judge-review': { label: 'Review', tone: 'warning' },
  'judge-noise': { label: 'Noise', tone: 'neutral' },
  'judge-harmful': { label: 'Harmful', tone: 'danger' },
  'judge-verdict-unrecognized': { label: 'Unrecognized verdict', tone: 'unknown' },
  // Infra failures, not a considered judgment — the exact conflation bug
  // the backend just fixed. `tone: 'unknown'` (violet) deliberately, not
  // 'danger' or 'warning' — those would read as a real verdict.
  'judge-parse-failure': { label: 'Judge parse failure — not a review', tone: 'unknown' },
  'judge-network-failure': { label: 'Judge network failure — not a review', tone: 'unknown' },
};

function latestJudged(decisions: DecisionEntry[]): DecisionEntry | null {
  const judged = decisions.filter((d) => d.action === 'judged' && d.judgeReasonCode);
  if (judged.length === 0) return null;
  return judged.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

type PendingAction = 'approve' | 'reject' | null;

export function ProposalDetail({ id, onDispatchDisabled }: { id: string; onDispatchDisabled: () => void }) {
  const query = useQuery(proposalDetailQuery(id));
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function requestAction(action: 'approve' | 'reject') {
    setActionError(null);
    setPendingAction(action);
    if (hasMutationHold()) {
      setConfirmOpen(true);
    } else {
      setTokenDialogOpen(true);
    }
  }

  function onTokenDialogClose() {
    setTokenDialogOpen(false);
    // Live read, not the hook snapshot — MutationTokenDialog's onClose can
    // fire synchronously before this component re-renders, so a snapshot
    // captured at last render would still read stale here.
    if (hasMutationHold()) {
      setConfirmOpen(true);
    } else {
      setPendingAction(null); // dialog was cancelled/dismissed, not unlocked
    }
  }

  async function confirmPendingAction() {
    if (!pendingAction) return;
    setBusy(true);
    setActionError(null);
    try {
      if (pendingAction === 'approve') await approveProposal(id);
      else await rejectProposal(id);
      setConfirmOpen(false);
      setPendingAction(null);
    } catch (err) {
      if (err instanceof DispatchDisabledError) {
        setConfirmOpen(false);
        setPendingAction(null);
        onDispatchDisabled();
      } else {
        setActionError(err instanceof Error ? err.message : 'Action failed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (query.status === 'loading') {
    return (
      <div className={styles.panel}>
        <SkeletonLine width="60%" />
        <SkeletonLine width="30%" />
        <SkeletonLine width="90%" />
      </div>
    );
  }

  if (query.status === 'error' || !query.data) {
    return (
      <div className={styles.error} role="alert">
        {query.error?.message ?? 'Failed to load this proposal.'}
      </div>
    );
  }

  const p = query.data;
  const evidence = p.decisionEvidence;
  const judged = latestJudged(evidence.decisions);
  const judgeDisplay = judged?.judgeReasonCode ? JUDGE_REASON_DISPLAY[judged.judgeReasonCode] : null;
  const canDecide = p.status === 'pending';

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{p.title}</h2>
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        </div>
        <div className={styles.metaRow}>
          <StatusBadge status={p.status} />
          <span className={styles.metaItem}>{p.kind}</span>
          <span className={styles.metaItem} title={p.repo ?? undefined}>
            {p.repo ?? 'no repo'}
          </span>
          <span className={styles.metaItem}>created {formatRelative(p.createdAt)}</span>
          {p.decidedAt ? <span className={styles.metaItem}>decided {formatRelative(p.decidedAt)}</span> : null}
          {p.riskClass ? <span className={`${styles.riskBadge} ${styles[`risk_${p.riskClass}`]}`}>{p.riskClass} risk</span> : null}
        </div>
        {p.summary ? <p className={styles.summary}>{p.summary}</p> : null}
      </header>

      <section className={styles.evidence} aria-label="Evidence">
        <div className={styles.evidenceRow}>
          <span className={styles.evidenceLabel}>Judge verdict</span>
          <Epistemic quality={evidence.sourceQuality} label="judge verdict">
            {judgeDisplay ? (
              <StatusBadge status={judged!.judgeReasonCode!} tone={judgeDisplay.tone}>
                {judgeDisplay.label}
              </StatusBadge>
            ) : (
              <span className={styles.muted}>not yet judged</span>
            )}
          </Epistemic>
        </div>
        {judged?.judgeRationaleState ? (
          <p className={styles.rationaleNote}>
            Model rationale:{' '}
            {judged.judgeRationaleState === 'not-persisted' ? 'not persisted' : 'legacy (redacted)'}
          </p>
        ) : null}

        {p.decisionReason ? (
          <div className={styles.evidenceRow}>
            <span className={styles.evidenceLabel}>Decision reason</span>
            <span>{p.decisionReason}</span>
          </div>
        ) : null}

        {p.verifyResult ? (
          <div className={styles.evidenceRow}>
            <span className={styles.evidenceLabel}>Verification</span>
            <div>
              <StatusBadge status={p.verifyResult.passed ? 'success' : 'failed'}>
                {p.verifyResult.passed ? 'passed' : 'failed'}
              </StatusBadge>
              {p.verifyResult.ran && p.verifyResult.ran.length > 0 ? (
                <span className={styles.muted}> · ran {p.verifyResult.ran.map((r) => r.kind).join(', ')}</span>
              ) : null}
              {p.verifyResult.failed && p.verifyResult.failed.length > 0 ? (
                <p className={styles.failedChecks}>Failed: {p.verifyResult.failed.join(', ')}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {p.evidenceOutcome ? (
          <div className={styles.evidenceRow}>
            <span className={styles.evidenceLabel}>Gates</span>
            <span className={styles.muted}>
              {p.evidenceOutcome.gateCount ?? 0} gate{p.evidenceOutcome.gateCount === 1 ? '' : 's'}
              {p.evidenceOutcome.policyAction ? ` · policy: ${p.evidenceOutcome.policyAction}` : ''}
              {p.evidenceOutcome.trustBasis ? ` · trust: ${p.evidenceOutcome.trustBasis}` : ''}
            </span>
          </div>
        ) : null}

        {p.result ? (
          <div className={styles.evidenceRow}>
            <span className={styles.evidenceLabel}>Result</span>
            <span>{p.result}</span>
          </div>
        ) : null}
      </section>

      <section className={styles.diffSection} aria-label="Diff">
        <DiffViewer diff={p.diff} proposalKind={p.kind} />
      </section>

      {canDecide ? (
        <footer className={styles.actions}>
          {actionError && !confirmOpen ? (
            <p className={styles.actionError} role="alert">
              {actionError}
            </p>
          ) : null}
          <button type="button" className={styles.rejectButton} onClick={() => requestAction('reject')}>
            Reject
          </button>
          <button type="button" className={styles.approveButton} onClick={() => requestAction('approve')}>
            Approve
          </button>
        </footer>
      ) : (
        <footer className={styles.decided}>
          This proposal is already <strong>{p.status}</strong> — no further action available.
        </footer>
      )}

      <MutationTokenDialog
        open={tokenDialogOpen}
        onClose={onTokenDialogClose}
        reason={
          pendingAction === 'approve'
            ? 'Approving a proposal mutates the fleet and requires the dispatch token.'
            : 'Rejecting a proposal requires the dispatch token.'
        }
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          setPendingAction(null);
          setActionError(null);
        }}
        title={pendingAction === 'approve' ? 'Approve this proposal?' : 'Reject this proposal?'}
        body={
          pendingAction === 'approve' ? (
            <>
              This applies <strong>{p.title}</strong> to <code>{p.repo}</code> now — it writes the diff to disk and
              cannot be undone from this dialog. Review the diff above before confirming.
            </>
          ) : (
            <>
              This rejects <strong>{p.title}</strong> and discards it. It stays visible in history (status:
              rejected) but will never be applied.
            </>
          )
        }
        confirmLabel={pendingAction === 'approve' ? 'Approve and apply' : 'Reject'}
        destructive={pendingAction === 'reject'}
        busy={busy}
        error={actionError}
        onConfirm={() => void confirmPendingAction()}
      />
    </div>
  );
}
