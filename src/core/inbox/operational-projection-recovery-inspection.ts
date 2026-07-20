import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  classifyOperationalProjectionRecovery,
  readOperationalProjectionTransaction,
  type OperationalProjectionRecoveryState,
  type OperationalProjectionTransactionPhase,
} from './operational-projection-transaction.js';
import { verifyOperationalProjectionReplay } from './operational-projection-replay-ledger.js';
import {
  observeOperationalProjectionArtifacts,
  validateOperationalProjectionStageText,
  validateOperationalProposalStageText,
} from './operational-projection.js';
import { readOperationalProjectionStage } from './operational-projection-staging.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

export type OperationalProjectionRecoveryNext =
  | 'would-write-proposal'
  | 'would-delete-proposal'
  | 'would-write-projection'
  | 'would-delete-projection'
  | 'would-attest-proposal-installed'
  | 'would-attest-projection-installed'
  | 'would-attest-committed';

export type OperationalProjectionRecoveryInspection =
  | { state: 'no-active-v2-transaction' }
  | {
      state: 'recoverable-observation';
      transactionId: string;
      phase: OperationalProjectionTransactionPhase;
      actual: Exclude<OperationalProjectionRecoveryState, 'unknown' | 'projection-only'>;
      next: OperationalProjectionRecoveryNext;
    }
  | { state: 'complete-observation'; transactionId: string }
  | { state: 'refused'; reason: string };

function refused(reason: string): OperationalProjectionRecoveryInspection {
  return { state: 'refused', reason };
}

function expectedStageState(
  result: ReturnType<typeof readOperationalProjectionStage>,
  present: boolean,
): boolean {
  return present ? result.state === 'present' : result.state === 'absent';
}

function applyAction(
  artifact: 'proposal' | 'projection',
  present: boolean,
): OperationalProjectionRecoveryNext {
  return present
    ? `would-write-${artifact}`
    : `would-delete-${artifact}`;
}

/**
 * Maps only a phase-compatible observed state to one precise hypothetical
 * recovery action. A future remote-CAS executor must bind this action to its
 * exact authority epoch; journal advancement alone is never effect evidence.
 */
export function nextOperationalProjectionRecoveryAction(
  phase: OperationalProjectionTransactionPhase,
  actual: OperationalProjectionRecoveryState,
  staged: { proposal: { present: boolean }; projection: { present: boolean } },
): Extract<OperationalProjectionRecoveryInspection, { state: 'recoverable-observation' }>['next'] | null {
  if (phase === 'prepared') {
    if (actual === 'no-effect') return applyAction('proposal', staged.proposal.present);
    if (actual === 'proposal-only') return 'would-attest-proposal-installed';
    return null;
  }
  if (phase === 'proposal-installed') {
    if (actual === 'proposal-only') return applyAction('projection', staged.projection.present);
    if (actual === 'complete') return 'would-attest-projection-installed';
    return null;
  }
  if (phase === 'projection-installed') {
    return actual === 'complete' ? 'would-attest-committed' : null;
  }
  return null;
}

/**
 * Read-only recovery evidence for a signed V2 transaction. This intentionally
 * neither installs artifacts nor advances transaction/replay phases.
 */
export function inspectOperationalProjectionRecoveryV2(
  storeLock: ProposalStoreMutationLock,
): OperationalProjectionRecoveryInspection {
  if (!ownsProposalStoreMutationLock(storeLock)) return refused('store-lock-not-owned');
  const current = readOperationalProjectionTransaction();
  if (current.state === 'missing') return { state: 'no-active-v2-transaction' };
  if (current.state === 'degraded') return refused(`transaction-${current.reason}`);
  if (current.transaction.schemaVersion !== 2) return refused('transaction-not-v2');

  const replay = verifyOperationalProjectionReplay();
  if (replay.verdict !== 'consistent-with-local-ledger') return refused(`replay-${replay.verdict}`);
  if (!ownsProposalStoreMutationLock(storeLock)) return refused('store-lock-not-owned');

  let provenanceKey: Buffer | null;
  try { provenanceKey = loadExistingProvenanceKeyReadOnly(); } catch { provenanceKey = null; }
  if (!provenanceKey || provenanceKey.length !== 32) return refused('provenance-key-unavailable');
  const proposalStage = readOperationalProjectionStage(
    current.transaction.transactionId,
    'proposal',
    current.transaction.staged.proposal,
    (text) => validateOperationalProposalStageText(text, current.transaction.proposalId),
  );
  if (!expectedStageState(proposalStage, current.transaction.staged.proposal.present)) {
    return refused(proposalStage.state === 'degraded' ? `proposal-stage-${proposalStage.reason}` : 'proposal-stage-mismatch');
  }
  if (!ownsProposalStoreMutationLock(storeLock)) return refused('store-lock-not-owned');
  const projectionStage = readOperationalProjectionStage(
    current.transaction.transactionId,
    'projection',
    current.transaction.staged.projection,
    (text) => validateOperationalProjectionStageText(text, provenanceKey!),
  );
  if (!expectedStageState(projectionStage, current.transaction.staged.projection.present)) {
    return refused(projectionStage.state === 'degraded' ? `projection-stage-${projectionStage.reason}` : 'projection-stage-mismatch');
  }
  if (!ownsProposalStoreMutationLock(storeLock)) return refused('store-lock-not-owned');

  const actual = observeOperationalProjectionArtifacts(current.transaction.proposalId, storeLock);
  if (actual.state !== 'healthy') return refused(`artifact-${actual.reason}`);
  if (!ownsProposalStoreMutationLock(storeLock)) return refused('store-lock-not-owned');
  const recovery = classifyOperationalProjectionRecovery(current.transaction, {
    proposal: actual.proposal.digest,
    projection: actual.projection.digest,
  });
  if (recovery === 'unknown' || recovery === 'projection-only') return refused(`artifact-state-${recovery}`);
  if (recovery === 'complete' && current.transaction.phase === 'committed') {
    return { state: 'complete-observation', transactionId: current.transaction.transactionId };
  }
  const next = nextOperationalProjectionRecoveryAction(
    current.transaction.phase,
    recovery,
    current.transaction.staged,
  );
  if (!next) return refused(`phase-artifact-mismatch:${current.transaction.phase}:${recovery}`);
  return {
    state: 'recoverable-observation',
    transactionId: current.transaction.transactionId,
    phase: current.transaction.phase,
    actual: recovery,
    next,
  };
}
