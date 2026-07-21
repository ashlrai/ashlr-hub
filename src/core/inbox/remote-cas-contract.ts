import { createHash } from 'node:crypto';

import type { OperationalProjectionRecoveryNext } from './operational-projection-recovery-inspection.js';
import type {
  OperationalProjectionTransactionDigestsV1,
  OperationalProjectionTransactionPhase,
  OperationalProjectionTransactionStagedArtifactsV2,
} from './operational-projection-transaction.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const EPOCH_RE = /^(0|[1-9]\d*)$/;
const MAX_ID_LENGTH = 256;
const MAX_EPOCH_DIGITS = 39;
const MAX_STAGE_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

const ACTIONS_BY_PHASE: Record<OperationalProjectionTransactionPhase, readonly OperationalProjectionRecoveryNext[]> = {
  prepared: ['would-write-proposal', 'would-delete-proposal', 'would-attest-proposal-installed'],
  'proposal-installed': ['would-write-projection', 'would-delete-projection', 'would-attest-projection-installed'],
  'projection-installed': ['would-attest-committed'],
  committed: [],
};

export interface RemoteCasTransactionBindingV1 {
  schemaVersion: 1;
  transactionId: string;
  transactionAttestation: string;
  signingKeyId: string;
  proposalId: string;
  phase: OperationalProjectionTransactionPhase;
  before: OperationalProjectionTransactionDigestsV1;
  after: OperationalProjectionTransactionDigestsV1;
  staged: OperationalProjectionTransactionStagedArtifactsV2;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteCasRequestV1 {
  schemaVersion: 1;
  requestId: string;
  authorityId: string;
  audience: string;
  repositoryId: string;
  expectedEpoch: string | null;
  action: OperationalProjectionRecoveryNext;
  requestedAt: string;
  binding: RemoteCasTransactionBindingV1;
}

export type RemoteCasRequestParseResult =
  | { state: 'valid'; request: RemoteCasRequestV1 }
  | { state: 'invalid'; reason: string };

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH &&
    ID_RE.test(value);
}

function validDigest(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && DIGEST_RE.test(value));
}

function validDigests(value: unknown): value is OperationalProjectionTransactionDigestsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['projection', 'proposal']) && validDigest(record.proposal) && validDigest(record.projection);
}

function validStage(
  value: unknown,
  digest: string | null,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['bytes', 'digest', 'present']) || typeof record.present !== 'boolean' ||
    typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes)) return false;
  if (!record.present) return record.digest === null && record.bytes === 0 && digest === null;
  return typeof record.digest === 'string' && record.digest === digest && DIGEST_RE.test(record.digest) &&
    record.bytes > 0 && record.bytes <= MAX_STAGE_BYTES;
}

function validBinding(value: unknown): value is RemoteCasTransactionBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'after', 'before', 'createdAt', 'phase', 'proposalId', 'schemaVersion', 'signingKeyId', 'staged',
    'transactionAttestation', 'transactionId', 'updatedAt',
  ]) || record.schemaVersion !== 1 || !DIGEST_RE.test(record.transactionId as string) ||
    !DIGEST_RE.test(record.transactionAttestation as string) || !DIGEST_RE.test(record.signingKeyId as string) ||
    !canonicalTimestamp(record.createdAt) || !canonicalTimestamp(record.updatedAt) || typeof record.proposalId !== 'string' ||
    record.proposalId.length > 240 || !PROPOSAL_ID_RE.test(record.proposalId) ||
    !Object.hasOwn(ACTIONS_BY_PHASE, record.phase as string) || !validDigests(record.before) ||
    !validDigests(record.after) || !record.staged || typeof record.staged !== 'object' || Array.isArray(record.staged)) return false;
  const staged = record.staged as Record<string, unknown>;
  return exactKeys(staged, ['projection', 'proposal']) &&
    validStage(staged.proposal, record.after.proposal) && validStage(staged.projection, record.after.projection);
}

/**
 * Parses only the wire shape. It neither signs nor sends a request, and a
 * structurally valid value is not remote authority or execution permission.
 */
export function parseRemoteCasRequest(value: unknown): RemoteCasRequestParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid', reason: 'shape-invalid' };
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'action', 'audience', 'authorityId', 'binding', 'expectedEpoch', 'repositoryId', 'requestId', 'requestedAt', 'schemaVersion',
  ]) || record.schemaVersion !== 1) return { state: 'invalid', reason: 'shape-invalid' };
  if (!boundedId(record.requestId) || !boundedId(record.authorityId) || !boundedId(record.audience) || !boundedId(record.repositoryId)) {
    return { state: 'invalid', reason: 'identifier-invalid' };
  }
  if (record.expectedEpoch !== null && (typeof record.expectedEpoch !== 'string' ||
    record.expectedEpoch.length > MAX_EPOCH_DIGITS || !EPOCH_RE.test(record.expectedEpoch))) {
    return { state: 'invalid', reason: 'expected-epoch-invalid' };
  }
  if (!canonicalTimestamp(record.requestedAt)) return { state: 'invalid', reason: 'requested-at-invalid' };
  if (!validBinding(record.binding)) return { state: 'invalid', reason: 'binding-invalid' };
  if (typeof record.action !== 'string' || !ACTIONS_BY_PHASE[record.binding.phase].includes(record.action as OperationalProjectionRecoveryNext)) {
    return { state: 'invalid', reason: 'action-phase-invalid' };
  }
  return {
    state: 'valid',
    request: {
      schemaVersion: 1,
      requestId: record.requestId,
      authorityId: record.authorityId,
      audience: record.audience,
      repositoryId: record.repositoryId,
      expectedEpoch: record.expectedEpoch,
      action: record.action as OperationalProjectionRecoveryNext,
      requestedAt: record.requestedAt,
      binding: record.binding,
    },
  };
}

/** Stable metadata-only payload for a future authenticated authority request. */
export function canonicalRemoteCasRequest(request: RemoteCasRequestV1): string {
  return JSON.stringify({
    action: request.action,
    audience: request.audience,
    authorityId: request.authorityId,
    binding: {
      after: { projection: request.binding.after.projection, proposal: request.binding.after.proposal },
      before: { projection: request.binding.before.projection, proposal: request.binding.before.proposal },
      createdAt: request.binding.createdAt,
      phase: request.binding.phase,
      proposalId: request.binding.proposalId,
      schemaVersion: request.binding.schemaVersion,
      signingKeyId: request.binding.signingKeyId,
      staged: {
        projection: {
          bytes: request.binding.staged.projection.bytes,
          digest: request.binding.staged.projection.digest,
          present: request.binding.staged.projection.present,
        },
        proposal: {
          bytes: request.binding.staged.proposal.bytes,
          digest: request.binding.staged.proposal.digest,
          present: request.binding.staged.proposal.present,
        },
      },
      transactionAttestation: request.binding.transactionAttestation,
      transactionId: request.binding.transactionId,
      updatedAt: request.binding.updatedAt,
    },
    expectedEpoch: request.expectedEpoch,
    repositoryId: request.repositoryId,
    requestedAt: request.requestedAt,
    requestId: request.requestId,
    schemaVersion: request.schemaVersion,
  });
}

export function remoteCasRequestDigest(request: RemoteCasRequestV1): string {
  return createHash('sha256').update(canonicalRemoteCasRequest(request), 'utf8').digest('hex');
}
