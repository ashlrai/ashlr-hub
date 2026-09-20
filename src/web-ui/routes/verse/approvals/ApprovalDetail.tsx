/**
 * routes/verse/approvals/ApprovalDetail.tsx — everything a human needs before
 * deciding, and an approve path that cannot fire on one click.
 *
 * Reuses the inbox review machinery verbatim (`DiffViewer` + `diff-parser.ts`
 * + `highlight.ts`, and `ConfirmDialog`) rather than growing a second diff
 * renderer, per docs/VERSE-CONTRACT-V2.md.
 *
 * Two rules enforced here:
 *  - **Judge evidence is epistemic.** A `judge-parse-failure` /
 *    `judge-network-failure` is an infra failure, never a considered verdict,
 *    and a degraded decisions-ledger read renders "unknown" via <Epistemic/>
 *    instead of letting an empty array read as "never judged".
 *  - **Nothing signed is ever printed.** Provenance shows WHETHER a proposal
 *    carries a producer attestation, never the HMAC itself — the same rule
 *    that keeps launcher commands and tokens off every Verse payload.
 */
import { useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import type { DecisionEntry, JudgeDecisionReasonCode } from '../../../data/api-types.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { DispatchDisabledError } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { approveProposal, rejectProposal } from '../../../data/mutations.js';
import { proposalDetailQuery } from '../../../data/queries.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { DiffViewer } from '../../inbox/DiffViewer.js';
import { formatRelative } from '../autonomy/format.js';
import { describeControlError } from '../autonomy/use-guarded-action.js';
import { describeApproveConsequence, engineOf, reachesRemote } from './approvals-model.js';
import styles from './approvals.module.css';

const JUDGE_REASON_DISPLAY: Record<JudgeDecisionReasonCode, { label: string; tone: Tone }> = {
  'judge-ship-would-merge': { label: 'Ship (would merge)', tone: 'success' },
  'judge-ship-review-required': { label: 'Ship (review required)', tone: 'success' },
  'judge-review': { label: 'Review', tone: 'warning' },
  'judge-noise': { label: 'Noise', tone: 'neutral' },
  'judge-harmful': { label: 'Harmful', tone: 'danger' },
  'judge-verdict-unrecognized': { label: 'Unrecognized verdict', tone: 'unknown' },
  'judge-parse-failure': { label: 'Judge parse failure — not a review', tone: 'unknown' },
  'judge-network-failure': { label: 'Judge network failure — not a review', tone: 'unknown' },
};

function latestJudged(decisions: DecisionEntry[]): DecisionEntry | null {
  const judged = decisions.filter((d) => d.action === 'judged' && d.judgeReasonCode);
  if (judged.length === 0) return null;
  return judged.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
}

type PendingAction = 'approve' | 'reject' | null;

export interface ApprovalDetailProps {
  id: string;
  dispatchEnabled: boolean;
  onDispatchDisabled: () => void;
  onDecided: () => void;
}

export function ApprovalDetail({ id, dispatchEnabled, onDispatchDisabled, onDecided }: ApprovalDetailProps) {
  const query = useQuery(proposalDetailQuery(id));
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [tokenPrompt, setTokenPrompt] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function requestAction(action: 'approve' | 'reject') {
    setActionError(null);
    setPendingAction(action);
    if (hasMutationHold()) setConfirmOpen(true);
    else setTokenPrompt(true);
  }

  function closeTokenPrompt() {
    setTokenPrompt(false);
    // Live read — MutationTokenDialog closes synchronously after setToken().
    if (hasMutationHold()) setConfirmOpen(true);
    else setPendingAction(null);
  }

  async function confirmAction() {
    if (!pendingAction) return;
    setBusy(true);
    setActionError(null);
    try {
      if (pendingAction === 'approve') await approveProposal(id);
      else await rejectProposal(id);
      setConfirmOpen(false);
      setPendingAction(null);
      onDecided();
    } catch (err) {
      if (err instanceof DispatchDisabledError) {
        setConfirmOpen(false);
        setPendingAction(null);
        onDispatchDisabled();
      } else {
        setActionError(describeControlError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (query.status === 'loading') {
    return (
      <div className={styles.detail}>
        <SkeletonLine width="55%" />
        <SkeletonLine width="30%" />
        <SkeletonLine width="88%" />
      </div>
    );
  }

  if (query.status === 'error' || !query.data) {
    return (
      <p className={styles.error} role="alert">
        {query.error?.message ?? 'Could not load this proposal.'}
      </p>
    );
  }

  const p = query.data;
  const evidence = p.decisionEvidence;
  const judged = latestJudged(evidence?.decisions ?? []);
  const judgeDisplay = judged?.judgeReasonCode ? JUDGE_REASON_DISPLAY[judged.judgeReasonCode] : null;
  const canDecide = p.status === 'pending' && dispatchEnabled;
  const engine = engineOf(p);
  const consequence = describeApproveConsequence(p.kind, p.repo);

  return (
    <div className={styles.detail}>
      <header className={styles.detailHead}>
        <h3 className={styles.detailTitle}>{p.title}</h3>
        <div className={styles.detailMeta}>
          <StatusBadge status={p.status} />
          <span>{p.kind}</span>
          <code title={p.repo ?? undefined}>{p.repo ?? 'no repo'}</code>
          <span>{p.riskClass ? `${p.riskClass} risk` : 'risk unstated'}</span>
          {engine ? <code>{engine}</code> : null}
          <span>created {formatRelative(p.createdAt)}</span>
          {p.decidedAt ? <span>decided {formatRelative(p.decidedAt)}</span> : null}
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        </div>
        {p.summary ? <p className={styles.summary}>{p.summary}</p> : null}
      </header>

      <section className={styles.block} aria-label="Evidence">
        <h4 className={styles.blockTitle}>Evidence</h4>
        <dl className={styles.defs}>
          <dt>Judge verdict</dt>
          <dd>
            <Epistemic quality={evidence?.sourceQuality} label="judge verdict">
              {judgeDisplay && judged?.judgeReasonCode ? (
                <StatusBadge status={judged.judgeReasonCode} tone={judgeDisplay.tone}>
                  {judgeDisplay.label}
                </StatusBadge>
              ) : (
                <span className={styles.muted}>not yet judged</span>
              )}
            </Epistemic>
          </dd>

          <dt>Verification</dt>
          <dd>
            {p.verifyResult ? (
              <>
                <StatusBadge status={p.verifyResult.passed ? 'success' : 'failed'}>
                  {p.verifyResult.passed ? 'passed' : 'failed'}
                </StatusBadge>
                {p.verifyResult.ran && p.verifyResult.ran.length > 0 ? (
                  <span className={styles.muted}> · ran {p.verifyResult.ran.map((r) => r.kind).join(', ')}</span>
                ) : null}
                {!p.verifyResult.passed && p.verifyResult.failureCategory && p.verifyResult.failureCategory !== 'code' ? (
                  <span className={styles.muted}> · {p.verifyResult.failureCategory} failure — the verifier itself, not the diff</span>
                ) : null}
                {p.verifyResult.failed && p.verifyResult.failed.length > 0 ? (
                  <p className={styles.failedChecks}>failed: {p.verifyResult.failed.join(', ')}</p>
                ) : null}
              </>
            ) : (
              <span className={styles.muted}>not verified</span>
            )}
          </dd>

          {p.decisionReason ? (
            <>
              <dt>Decision reason</dt>
              <dd>{p.decisionReason}</dd>
            </>
          ) : null}

          {p.evidenceOutcome ? (
            <>
              <dt>Gates</dt>
              <dd className={styles.muted}>
                {p.evidenceOutcome.gateCount ?? 0} gate{p.evidenceOutcome.gateCount === 1 ? '' : 's'}
                {p.evidenceOutcome.policyAction ? ` · policy ${p.evidenceOutcome.policyAction}` : ''}
                {p.evidenceOutcome.trustBasis ? ` · trust ${p.evidenceOutcome.trustBasis}` : ''}
              </dd>
            </>
          ) : null}

          {p.result ? (
            <>
              <dt>Result</dt>
              <dd>{p.result}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section className={styles.block} aria-label="Provenance">
        <h4 className={styles.blockTitle}>Provenance</h4>
        <dl className={styles.defs}>
          <dt>Produced by</dt>
          <dd>{engine ? <code>{engine}</code> : <span className={styles.muted}>unknown engine</span>}</dd>
          <dt>Origin</dt>
          <dd>{p.origin}</dd>
          {p.workItemId ? (
            <>
              <dt>Work item</dt>
              <dd>
                <code>{p.workItemId}</code>
              </dd>
            </>
          ) : null}
          {p.runId ? (
            <>
              <dt>Run</dt>
              <dd>
                <code>{p.runId}</code>
              </dd>
            </>
          ) : null}
          <dt>Attestation</dt>
          <dd className={styles.muted}>
            {/* The signature itself is never rendered — only whether one exists. */}
            {p.producerProvenanceSig
              ? `signed by the sandboxed producer (v${p.producerProvenanceVersion ?? 2})`
              : p.provenanceSig
                ? 'legacy signature present'
                : 'unsigned — earns no positive routing credit'}
            {p.diffHash ? ' · diff hashed at signing time' : ''}
          </dd>
        </dl>
      </section>

      <section className={styles.block} aria-label="Diff">
        <h4 className={styles.blockTitle}>Diff</h4>
        <DiffViewer diff={p.diff} proposalKind={p.kind} />
      </section>

      {p.status === 'pending' ? (
        <footer className={styles.actions}>
          <p className={styles.actionNote}>
            {dispatchEnabled ? consequence : 'Read-only session — approve and reject are unavailable without dispatch.'}
          </p>
          {actionError && !confirmOpen ? (
            <p className={styles.error} role="alert">
              {actionError}
            </p>
          ) : null}
          <button type="button" className={styles.reject} disabled={!canDecide || busy} onClick={() => requestAction('reject')}>
            Reject
          </button>
          <button type="button" className={styles.approve} disabled={!canDecide || busy} onClick={() => requestAction('approve')}>
            Approve…
          </button>
        </footer>
      ) : (
        <footer className={styles.decided}>
          This proposal is already <strong>{p.status}</strong> — no further action is available.
        </footer>
      )}

      <MutationTokenDialog
        open={tokenPrompt}
        onClose={closeTokenPrompt}
        reason={
          pendingAction === 'approve'
            ? 'Approving a proposal writes to a real repository and requires the dispatch token.'
            : 'Rejecting a proposal requires the dispatch token.'
        }
        tokenHelp="the mutation token ashlr verse printed"
      />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
          setPendingAction(null);
          setActionError(null);
        }}
        title={
          pendingAction === 'approve'
            ? `Approve this ${p.kind} against ${p.repo ? p.repo.split('/').pop() : 'the repository'}?`
            : 'Reject this proposal?'
        }
        body={
          pendingAction === 'approve' ? (
            <>
              <strong>{p.title}</strong>
              <br />
              Kind <strong>{p.kind}</strong> · repository <code>{p.repo ?? 'unknown'}</code>
              <br />
              <br />
              {consequence}
              {reachesRemote(p.kind) ? (
                <>
                  <br />
                  <br />
                  This one leaves your machine.
                </>
              ) : null}
            </>
          ) : (
            <>
              This rejects <strong>{p.title}</strong> and discards it. It stays in history as rejected and is never
              applied.
            </>
          )
        }
        confirmLabel={pendingAction === 'approve' ? `Approve and ${reachesRemote(p.kind) ? 'open the pull request' : 'apply'}` : 'Reject'}
        // Approve is the irreversible one — a `pr` pushes a branch and opens a
        // real PR other people can see, a `patch` writes to disk now. Reject
        // only discards a proposal that stays in history. Putting the danger
        // styling on Reject trained the reflex that the red button is the safe
        // one; VERSE-CONTRACT-V2 calls Approve destructive explicitly.
        destructive={pendingAction === 'approve'}
        busy={busy}
        error={actionError}
        onConfirm={() => void confirmAction()}
      />
    </div>
  );
}
