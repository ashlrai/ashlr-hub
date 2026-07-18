import {
  advanceOperationalProjectionTransactionJournalOnly,
  prepareOperationalProjectionTransactionJournalOnly,
  readOperationalProjectionTransaction,
  type OperationalProjectionTransactionPhase,
  type OperationalProjectionTransactionReadResult,
  type PrepareOperationalProjectionTransactionInput,
} from './operational-projection-transaction.js';
import {
  recordOperationalProjectionReplay,
  verifyOperationalProjectionReplay,
} from './operational-projection-replay-ledger.js';
import type { ProposalStoreMutationLock } from './proposal-mutation-lock.js';

function degraded(reason: string): OperationalProjectionTransactionReadResult {
  return { state: 'degraded', reason, transaction: null };
}

function recordFailureReason(
  result: ReturnType<typeof recordOperationalProjectionReplay>,
): string {
  return result.state === 'degraded' ? result.reason : 'replay-ledger-missing-after-write';
}

function samePrepareIntent(
  current: OperationalProjectionTransactionReadResult,
  input: PrepareOperationalProjectionTransactionInput,
): boolean {
  return current.state === 'healthy' && current.transaction.phase === 'prepared' &&
    current.transaction.proposalId === input.proposalId &&
    current.transaction.before.proposal === input.before.proposal &&
    current.transaction.before.projection === input.before.projection &&
    current.transaction.after.proposal === input.after.proposal &&
    current.transaction.after.projection === input.after.projection;
}

/** Repair a one-phase journal/ledger crash gap before another mutation is allowed. */
export function reconcileOperationalProjectionReplay(
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionTransactionReadResult {
  const current = readOperationalProjectionTransaction();
  if (current.state !== 'healthy') return current;
  const verification = verifyOperationalProjectionReplay();
  if (verification.verdict === 'consistent-with-local-ledger') return current;
  if (verification.verdict !== 'missing-local-ledger' &&
    verification.verdict !== 'transaction-ahead-of-ledger' &&
    verification.verdict !== 'transaction-identity-mismatch') {
    return degraded(`transaction-replay-${verification.verdict}`);
  }
  const recorded = recordOperationalProjectionReplay(current.transaction, storeLock, now);
  return recorded.state === 'healthy'
    ? current
    : degraded(`transaction-${recordFailureReason(recorded)}`);
}

export function prepareOperationalProjectionTransaction(
  input: PrepareOperationalProjectionTransactionInput,
): OperationalProjectionTransactionReadResult {
  const existing = readOperationalProjectionTransaction();
  if (existing.state === 'degraded') return existing;
  const reconciled = existing.state === 'healthy'
    ? reconcileOperationalProjectionReplay(input.storeLock, input.now)
    : existing;
  if (reconciled.state === 'degraded') return reconciled;
  const prepared = samePrepareIntent(reconciled, input)
    ? reconciled
    : prepareOperationalProjectionTransactionJournalOnly(input);
  if (prepared.state !== 'healthy') return prepared;
  const recorded = recordOperationalProjectionReplay(
    prepared.transaction,
    input.storeLock,
    input.now,
  );
  return recorded.state === 'healthy'
    ? prepared
    : degraded(`transaction-${recordFailureReason(recorded)}`);
}

export function advanceOperationalProjectionTransaction(
  transactionId: string,
  phase: OperationalProjectionTransactionPhase,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionTransactionReadResult {
  const reconciled = reconcileOperationalProjectionReplay(storeLock, now);
  if (reconciled.state !== 'healthy') return reconciled;
  if (reconciled.transaction.transactionId !== transactionId) {
    return degraded('transaction-identity-mismatch');
  }
  if (reconciled.transaction.phase === phase) return reconciled;
  const advanced = advanceOperationalProjectionTransactionJournalOnly(
    transactionId,
    phase,
    storeLock,
    now,
  );
  if (advanced.state !== 'healthy') return advanced;
  const recorded = recordOperationalProjectionReplay(advanced.transaction, storeLock, now);
  return recorded.state === 'healthy'
    ? advanced
    : degraded(`transaction-${recordFailureReason(recorded)}`);
}
