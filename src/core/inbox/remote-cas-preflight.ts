import type { RemoteCasAuthorityConfig } from './remote-cas-authority.js';
import {
  nextOperationalProjectionRecoveryAction,
  type OperationalProjectionRecoveryInspection,
} from './operational-projection-recovery-inspection.js';
import {
  parseRemoteCasRequest,
  remoteCasRequestDigest,
  type RemoteCasRequestV1,
} from './remote-cas-contract.js';
import type { OperationalProjectionTransactionV2 } from './operational-projection-transaction.js';

const EPOCH_RE = /^(0|[1-9]\d*)$/;
const MAX_EPOCH_DIGITS = 39;

type ProbeAuthorityConfig = Extract<RemoteCasAuthorityConfig, { mode: 'probe' }>;
type RecoverableInspection = Extract<OperationalProjectionRecoveryInspection, { state: 'recoverable-observation' }>;

export interface BuildRemoteCasRequestFromInspectionInput {
  inspection: RecoverableInspection;
  transaction: OperationalProjectionTransactionV2;
  authority: ProbeAuthorityConfig;
  repositoryId: string;
  expectedEpoch: string;
  requestId: string;
  requestedAt: string;
}

export type RemoteCasPreflightResult =
  | { state: 'ready'; request: RemoteCasRequestV1; digest: string }
  | { state: 'refused'; reason: string };

function refused(reason: string): RemoteCasPreflightResult {
  return { state: 'refused', reason };
}

/**
 * Builds a future remote-authority request from already-inspected local state.
 * This is deliberately pure: a ready result is neither a grant nor permission
 * to alter a journal, proposal, projection, or reader authority.
 */
export function buildRemoteCasRequestFromInspection(
  input: BuildRemoteCasRequestFromInspectionInput,
): RemoteCasPreflightResult {
  if (input.authority.mode !== 'probe') return refused('authority-not-probe');
  if (!EPOCH_RE.test(input.expectedEpoch) || input.expectedEpoch.length > MAX_EPOCH_DIGITS) {
    return refused('expected-epoch-invalid');
  }
  if (input.inspection.transactionId !== input.transaction.transactionId) {
    return refused('inspection-transaction-mismatch');
  }
  if (input.inspection.phase !== input.transaction.phase) return refused('inspection-phase-mismatch');

  const expectedAction = nextOperationalProjectionRecoveryAction(
    input.transaction.phase,
    input.inspection.actual,
    input.transaction.staged,
  );
  if (!expectedAction || expectedAction !== input.inspection.next) {
    return refused('inspection-action-mismatch');
  }

  const request: RemoteCasRequestV1 = {
    schemaVersion: 1,
    requestId: input.requestId,
    authorityId: input.authority.authorityId,
    audience: input.authority.audience,
    repositoryId: input.repositoryId,
    expectedEpoch: input.expectedEpoch,
    action: input.inspection.next,
    requestedAt: input.requestedAt,
    binding: {
      schemaVersion: 1,
      transactionId: input.transaction.transactionId,
      transactionAttestation: input.transaction.attestation,
      signingKeyId: input.transaction.signingKeyId,
      proposalId: input.transaction.proposalId,
      phase: input.transaction.phase,
      before: { ...input.transaction.before },
      after: { ...input.transaction.after },
      staged: {
        proposal: { ...input.transaction.staged.proposal },
        projection: { ...input.transaction.staged.projection },
      },
      createdAt: input.transaction.createdAt,
      updatedAt: input.transaction.updatedAt,
    },
  };
  const parsed = parseRemoteCasRequest(request);
  if (parsed.state !== 'valid') return refused(`request-${parsed.reason}`);
  return { state: 'ready', request: parsed.request, digest: remoteCasRequestDigest(parsed.request) };
}
