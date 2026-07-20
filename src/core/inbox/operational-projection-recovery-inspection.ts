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

export type OperationalProjectionRecoveryInspection =
  | { state: 'no-active-v2-transaction' }
  | {
      state: 'recoverable-observation';
      transactionId: string;
      phase: OperationalProjectionTransactionPhase;
      actual: Exclude<OperationalProjectionRecoveryState, 'complete' | 'unknown' | 'projection-only'>;
      next: 'would-install-proposal' | 'would-install-projection';
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
  if (recovery === 'complete') {
    return { state: 'complete-observation', transactionId: current.transaction.transactionId };
  }
  return {
    state: 'recoverable-observation',
    transactionId: current.transaction.transactionId,
    phase: current.transaction.phase,
    actual: recovery,
    next: recovery === 'no-effect' ? 'would-install-proposal' : 'would-install-projection',
  };
}
