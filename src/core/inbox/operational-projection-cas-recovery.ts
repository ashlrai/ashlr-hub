import {
  createHash,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import {
  operationalProjectionAnchorRequestDigest,
  verifyOperationalProjectionAnchorReceipt,
  type OperationalProjectionAnchorCasRequestV1,
  type OperationalProjectionAnchorTrustV1,
} from './operational-projection-monotonic-anchor.js';

const SCHEMA_VERSION = 1 as const;
const PROTOCOL = 'ashlr.operational-projection-cas-recovery.v1' as const;
const IDEMPOTENCY_DOMAIN = 'ashlr.operational-projection-cas-recovery.idempotency.v1';
const RECEIPT_DOMAIN = 'ashlr.operational-projection-cas-recovery.receipt.v1';
const SIGNATURE_DOMAIN = 'ashlr.operational-projection-cas-recovery.signature.v1';
const MAX_CANONICAL_BYTES = 16 * 1024;
const MAX_RECEIPT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UINT_RE = /^(0|[1-9][0-9]{0,19})$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const RFC3339_MILLIS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NO_AUTHORITY = {
  historicalAuthority: false as const,
  operationalAuthority: false as const,
  rollbackAuthority: false as const,
  rollbackProtected: false as const,
};

export type OperationalProjectionCasRecoveryDecision =
  | 'roll-forward'
  | 'rollback';

export interface OperationalProjectionCasRecoveryExpectationV1 {
  anchorId: string;
  namespace: string;
  transactionId: string;
  priorGeneration: string;
  priorValueDigest: string;
  priorReceiptDigest: string;
  proposedGeneration: string;
  proposedValueDigest: string;
  proposedProposalDigest: string;
  proposedProjectionDigest: string;
  casRequestDigest: string;
  casReceiptDigest: string;
  sequence: string;
  policyId: string;
  policyVersion: string;
  rootId: string;
  keyId: string;
  keyEpoch: string;
}

export interface OperationalProjectionCasRecoveryReceiptCoreV1
  extends OperationalProjectionCasRecoveryExpectationV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  idempotencyKey: string;
  decision: OperationalProjectionCasRecoveryDecision;
  issuedAt: string;
  expiresAt: string;
  historicalAuthority: false;
  operationalAuthority: false;
  rollbackAuthority: false;
  rollbackProtected: false;
}

export interface OperationalProjectionCasRecoveryReceiptV1
  extends OperationalProjectionCasRecoveryReceiptCoreV1 {
  receiptDigest: string;
  signature: string;
}

/**
 * Trust is supplied by policy, never discovered from an untrusted receipt.
 * This primitive intentionally models one pinned key rather than key discovery.
 */
export interface OperationalProjectionCasRecoveryTrustV1 {
  rootId: string;
  keyId: string;
  keyEpoch: string;
  publicKey: KeyObject;
}

/**
 * Caller-supplied durable high-water observation. This module does not persist
 * it and therefore cannot grant recovery or rollback authority.
 */
export interface OperationalProjectionCasRecoveryReplayStateV1 {
  sequence: string;
  receiptDigest: string | null;
}

export interface ObserveOperationalProjectionCasRecoveryInputV1 {
  expectation: OperationalProjectionCasRecoveryExpectationV1;
  trust: OperationalProjectionCasRecoveryTrustV1;
  replayState: OperationalProjectionCasRecoveryReplayStateV1;
  now: Date;
  casRequest: OperationalProjectionAnchorCasRequestV1;
  untrustedCasReceipt: unknown | null;
  casTrust: OperationalProjectionAnchorTrustV1;
  /**
   * null means the external service was unavailable; an empty collection means
   * it was available but returned no receipt. Multiple candidates are accepted
   * only to detect replay and equivocation, never to select a preferred answer.
   */
  untrustedReceipts: readonly unknown[] | null;
}

export type OperationalProjectionCasRecoveryRefusalReason =
  | 'invalid-expectation'
  | 'invalid-trust'
  | 'invalid-replay-state'
  | 'invalid-clock'
  | 'receipt-unavailable'
  | 'receipt-missing'
  | 'invalid-cas-receipt'
  | 'invalid-receipt'
  | 'unknown-key'
  | 'receipt-digest-mismatch'
  | 'signature-invalid'
  | 'receipt-mismatch'
  | 'receipt-expired'
  | 'receipt-not-yet-valid'
  | 'receipt-stale'
  | 'receipt-replayed'
  | 'receipt-equivocal'
  | 'sequence-gap';

export type OperationalProjectionCasRecoveryObservation =
  | {
      state: 'observed';
      reason: 'signed-external-cas-decision';
      receipt: OperationalProjectionCasRecoveryReceiptV1;
      receiptDigest: string;
      decision: OperationalProjectionCasRecoveryDecision;
      authenticated: true;
      observationOnly: true;
      localMutationPermitted: false;
      historicalAuthority: false;
      operationalAuthority: false;
      rollbackAuthority: false;
      rollbackProtected: false;
    }
  | {
      state: 'refused';
      reason: OperationalProjectionCasRecoveryRefusalReason;
      receipt: null;
      receiptDigest: null;
      decision: null;
      authenticated: false;
      observationOnly: true;
      localMutationPermitted: false;
      historicalAuthority: false;
      operationalAuthority: false;
      rollbackAuthority: false;
      rollbackProtected: false;
    };

const EXPECTATION_KEYS = [
  'anchorId',
  'namespace',
  'transactionId',
  'priorGeneration',
  'priorValueDigest',
  'priorReceiptDigest',
  'proposedGeneration',
  'proposedValueDigest',
  'proposedProposalDigest',
  'proposedProjectionDigest',
  'casRequestDigest',
  'casReceiptDigest',
  'sequence',
  'policyId',
  'policyVersion',
  'rootId',
  'keyId',
  'keyEpoch',
] as const;

const RECEIPT_CORE_KEYS = [
  'schemaVersion',
  'protocol',
  ...EXPECTATION_KEYS,
  'idempotencyKey',
  'decision',
  'issuedAt',
  'expiresAt',
  'historicalAuthority',
  'operationalAuthority',
  'rollbackAuthority',
  'rollbackProtected',
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' &&
    value.length <= maxLength &&
    ID_RE.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function parseSequence(value: unknown): bigint | null {
  if (typeof value !== 'string' || !UINT_RE.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT64 ? parsed : null;
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339_MILLIS_RE.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) &&
    DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function hashDomain(domain: string, canonical: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function canonicalExpectation(
  value: OperationalProjectionCasRecoveryExpectationV1,
): Record<string, unknown> {
  return {
    anchorId: value.anchorId,
    casReceiptDigest: value.casReceiptDigest,
    casRequestDigest: value.casRequestDigest,
    keyEpoch: value.keyEpoch,
    keyId: value.keyId,
    namespace: value.namespace,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    priorGeneration: value.priorGeneration,
    priorReceiptDigest: value.priorReceiptDigest,
    priorValueDigest: value.priorValueDigest,
    proposedGeneration: value.proposedGeneration,
    proposedProjectionDigest: value.proposedProjectionDigest,
    proposedProposalDigest: value.proposedProposalDigest,
    proposedValueDigest: value.proposedValueDigest,
    rootId: value.rootId,
    sequence: value.sequence,
    transactionId: value.transactionId,
  };
}

function validExpectation(
  value: unknown,
): value is OperationalProjectionCasRecoveryExpectationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, EXPECTATION_KEYS) ||
    !validId(record['anchorId'], 128) ||
    !validId(record['namespace'], 240) ||
    !validDigest(record['transactionId']) ||
    !validDigest(record['priorValueDigest']) ||
    !validDigest(record['priorReceiptDigest']) ||
    !validDigest(record['proposedValueDigest']) ||
    !validDigest(record['proposedProposalDigest']) ||
    !validDigest(record['proposedProjectionDigest']) ||
    !validDigest(record['casRequestDigest']) ||
    !validDigest(record['casReceiptDigest']) ||
    !validId(record['policyId'], 128) ||
    !validId(record['policyVersion'], 128) ||
    !validId(record['rootId'], 128) ||
    !validId(record['keyId'], 128)) {
    return false;
  }
  const priorGeneration = parseSequence(record['priorGeneration']);
  const proposedGeneration = parseSequence(record['proposedGeneration']);
  const sequence = parseSequence(record['sequence']);
  const keyEpoch = parseSequence(record['keyEpoch']);
  return priorGeneration !== null &&
    proposedGeneration !== null &&
    priorGeneration < MAX_UINT64 &&
    proposedGeneration === priorGeneration + 1n &&
    sequence !== null &&
    sequence > 0n &&
    keyEpoch !== null &&
    keyEpoch > 0n;
}

function canonicalIdempotencyInput(
  expectation: OperationalProjectionCasRecoveryExpectationV1,
): string {
  return JSON.stringify({
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    ...canonicalExpectation(expectation),
  });
}

export function operationalProjectionCasRecoveryIdempotencyKey(
  expectation: OperationalProjectionCasRecoveryExpectationV1,
): string {
  if (!validExpectation(expectation)) {
    throw new TypeError('invalid operational projection CAS recovery expectation');
  }
  return hashDomain(IDEMPOTENCY_DOMAIN, canonicalIdempotencyInput(expectation));
}

function validDecision(value: unknown): value is OperationalProjectionCasRecoveryDecision {
  return value === 'roll-forward' || value === 'rollback';
}

function validReceiptCore(
  value: unknown,
): value is OperationalProjectionCasRecoveryReceiptCoreV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, RECEIPT_CORE_KEYS) ||
    record['schemaVersion'] !== SCHEMA_VERSION ||
    record['protocol'] !== PROTOCOL ||
    !validExpectation(Object.fromEntries(
      EXPECTATION_KEYS.map((key) => [key, record[key]]),
    )) ||
    !validDigest(record['idempotencyKey']) ||
    !validDecision(record['decision']) ||
    parseTimestamp(record['issuedAt']) === null ||
    parseTimestamp(record['expiresAt']) === null ||
    record['historicalAuthority'] !== false ||
    record['operationalAuthority'] !== false ||
    record['rollbackAuthority'] !== false ||
    record['rollbackProtected'] !== false) {
    return false;
  }
  return equalDigest(
    record['idempotencyKey'],
    operationalProjectionCasRecoveryIdempotencyKey(
      Object.fromEntries(
        EXPECTATION_KEYS.map((key) => [key, record[key]]),
      ) as unknown as OperationalProjectionCasRecoveryExpectationV1,
    ),
  );
}

function canonicalReceiptCore(
  value: OperationalProjectionCasRecoveryReceiptCoreV1,
): string {
  return JSON.stringify({
    decision: value.decision,
    expiresAt: value.expiresAt,
    historicalAuthority: value.historicalAuthority,
    idempotencyKey: value.idempotencyKey,
    issuedAt: value.issuedAt,
    operationalAuthority: value.operationalAuthority,
    protocol: value.protocol,
    rollbackAuthority: value.rollbackAuthority,
    rollbackProtected: value.rollbackProtected,
    schemaVersion: value.schemaVersion,
    ...canonicalExpectation(value),
  });
}

export function operationalProjectionCasRecoveryReceiptDigest(
  receipt: OperationalProjectionCasRecoveryReceiptCoreV1,
): string {
  if (!validReceiptCore(receipt)) {
    throw new TypeError('invalid operational projection CAS recovery receipt core');
  }
  const canonical = canonicalReceiptCore(receipt);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) {
    throw new TypeError('operational projection CAS recovery receipt too large');
  }
  return hashDomain(RECEIPT_DOMAIN, canonical);
}

export function operationalProjectionCasRecoverySigningBytes(
  receiptDigest: string,
): Buffer {
  if (!validDigest(receiptDigest)) {
    throw new TypeError('invalid operational projection CAS recovery receipt digest');
  }
  return Buffer.from(`${SIGNATURE_DOMAIN}\n${receiptDigest}`, 'utf8');
}

function parseReceipt(
  value: unknown,
): OperationalProjectionCasRecoveryReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [...RECEIPT_CORE_KEYS, 'receiptDigest', 'signature']) ||
    !validDigest(record['receiptDigest']) ||
    typeof record['signature'] !== 'string' ||
    !SIGNATURE_RE.test(record['signature'])) {
    return null;
  }
  const core = Object.fromEntries(
    RECEIPT_CORE_KEYS.map((key) => [key, record[key]]),
  );
  if (!validReceiptCore(core)) return null;
  const signature = Buffer.from(record['signature'], 'base64url');
  if (signature.length !== 64 ||
    signature.toString('base64url') !== record['signature']) {
    return null;
  }
  return record as unknown as OperationalProjectionCasRecoveryReceiptV1;
}

function receiptCore(
  receipt: OperationalProjectionCasRecoveryReceiptV1,
): OperationalProjectionCasRecoveryReceiptCoreV1 {
  const { receiptDigest: _receiptDigest, signature: _signature, ...core } = receipt;
  return core;
}

function validTrust(value: OperationalProjectionCasRecoveryTrustV1): boolean {
  return validId(value.rootId, 128) &&
    validId(value.keyId, 128) &&
    parseSequence(value.keyEpoch) !== null &&
    value.keyEpoch !== '0' &&
    value.publicKey.type === 'public' &&
    value.publicKey.asymmetricKeyType === 'ed25519';
}

function validReplayState(
  value: OperationalProjectionCasRecoveryReplayStateV1,
): boolean {
  const sequence = parseSequence(value.sequence);
  if (sequence === null) return false;
  return sequence === 0n
    ? value.receiptDigest === null
    : validDigest(value.receiptDigest);
}

function exactExpectationMatch(
  receipt: OperationalProjectionCasRecoveryReceiptV1,
  expectation: OperationalProjectionCasRecoveryExpectationV1,
): boolean {
  return EXPECTATION_KEYS.every((key) => {
    const left = receipt[key];
    const right = expectation[key];
    return typeof left === 'string' && typeof right === 'string' &&
      (validDigest(left) && validDigest(right)
        ? equalDigest(left, right)
        : left === right);
  }) && equalDigest(
    receipt.idempotencyKey,
    operationalProjectionCasRecoveryIdempotencyKey(expectation),
  );
}

function exactCasBinding(
  expectation: OperationalProjectionCasRecoveryExpectationV1,
  request: OperationalProjectionAnchorCasRequestV1,
  casReceiptDigest: string,
): boolean {
  return request.anchorId === expectation.anchorId &&
    request.namespace === expectation.namespace &&
    request.source.transactionId === expectation.transactionId &&
    request.expected.sequence === expectation.priorGeneration &&
    request.expected.valueDigest === expectation.priorValueDigest &&
    request.expected.receiptDigest === expectation.priorReceiptDigest &&
    request.proposed.sequence === expectation.proposedGeneration &&
    equalDigest(request.proposed.valueDigest, expectation.proposedValueDigest) &&
    equalDigest(request.source.proposalDigest, expectation.proposedProposalDigest) &&
    equalDigest(request.source.projectionDigest, expectation.proposedProjectionDigest) &&
    equalDigest(
      operationalProjectionAnchorRequestDigest(request),
      expectation.casRequestDigest,
    ) &&
    equalDigest(casReceiptDigest, expectation.casReceiptDigest);
}

function sameReceiptIdentity(
  left: OperationalProjectionCasRecoveryReceiptV1,
  right: OperationalProjectionCasRecoveryReceiptV1,
): boolean {
  return left.anchorId === right.anchorId &&
    left.namespace === right.namespace &&
    left.transactionId === right.transactionId &&
    left.sequence === right.sequence &&
    equalDigest(left.idempotencyKey, right.idempotencyKey);
}

function refused(
  reason: OperationalProjectionCasRecoveryRefusalReason,
): OperationalProjectionCasRecoveryObservation {
  return {
    state: 'refused',
    reason,
    receipt: null,
    receiptDigest: null,
    decision: null,
    authenticated: false,
    observationOnly: true,
    localMutationPermitted: false,
    ...NO_AUTHORITY,
  };
}

export function observeOperationalProjectionCasRecovery(
  input: ObserveOperationalProjectionCasRecoveryInputV1,
): OperationalProjectionCasRecoveryObservation {
  try {
    if (!validExpectation(input.expectation)) return refused('invalid-expectation');
    if (!validTrust(input.trust)) return refused('invalid-trust');
    if (!validReplayState(input.replayState)) return refused('invalid-replay-state');
    const nowMs = input.now.getTime();
    if (!Number.isFinite(nowMs)) return refused('invalid-clock');
    if (input.untrustedReceipts === null) return refused('receipt-unavailable');
    if (input.untrustedReceipts.length === 0) return refused('receipt-missing');
    if (input.untrustedCasReceipt === null) return refused('receipt-unavailable');
    if (input.casTrust.keyId !== input.expectation.keyId ||
      input.casTrust.keyEpoch !== input.expectation.keyEpoch ||
      input.casTrust.anchorId !== input.expectation.anchorId) {
      return refused('unknown-key');
    }
    const casVerification = verifyOperationalProjectionAnchorReceipt(
      input.casRequest,
      input.untrustedCasReceipt,
      input.casTrust,
    );
    if (casVerification.state !== 'authenticated') {
      return casVerification.reason === 'signer-mismatch' ||
        casVerification.reason === 'anchor-mismatch'
        ? refused('unknown-key')
        : refused('invalid-cas-receipt');
    }
    if (!exactCasBinding(
      input.expectation,
      input.casRequest,
      casVerification.receipt.receiptDigest,
    )) {
      return refused('receipt-mismatch');
    }
    if (casVerification.decision === 'unavailable') {
      return refused('receipt-unavailable');
    }

    const parsed: OperationalProjectionCasRecoveryReceiptV1[] = [];
    for (const candidate of input.untrustedReceipts) {
      const receipt = parseReceipt(candidate);
      if (!receipt) return refused('invalid-receipt');
      if (receipt.rootId !== input.trust.rootId ||
        receipt.keyId !== input.trust.keyId ||
        receipt.keyEpoch !== input.trust.keyEpoch) {
        return refused('unknown-key');
      }
      const computedDigest = operationalProjectionCasRecoveryReceiptDigest(
        receiptCore(receipt),
      );
      if (!equalDigest(receipt.receiptDigest, computedDigest)) {
        return refused('receipt-digest-mismatch');
      }
      if (!verifySignature(
        null,
        operationalProjectionCasRecoverySigningBytes(receipt.receiptDigest),
        input.trust.publicKey,
        Buffer.from(receipt.signature, 'base64url'),
      )) {
        return refused('signature-invalid');
      }
      parsed.push(receipt);
    }

    const first = parsed[0]!;
    if (parsed.length > 1) {
      if (parsed.some((receipt) => !sameReceiptIdentity(first, receipt))) {
        return refused('receipt-mismatch');
      }
      if (parsed.some((receipt) => !equalDigest(first.receiptDigest, receipt.receiptDigest))) {
        return refused('receipt-equivocal');
      }
      return refused('receipt-replayed');
    }

    if (!exactExpectationMatch(first, input.expectation) ||
      first.rootId !== input.trust.rootId ||
      first.keyId !== input.trust.keyId ||
      first.keyEpoch !== input.trust.keyEpoch) {
      return refused('receipt-mismatch');
    }
    const expectedDecision = casVerification.decision === 'accepted'
      ? 'roll-forward'
      : 'rollback';
    if (first.decision !== expectedDecision) {
      return refused('receipt-equivocal');
    }

    const issuedAtMs = parseTimestamp(first.issuedAt)!;
    const expiresAtMs = parseTimestamp(first.expiresAt)!;
    if (expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_RECEIPT_LIFETIME_MS) {
      return refused('invalid-receipt');
    }
    if (nowMs < issuedAtMs - MAX_FUTURE_SKEW_MS) {
      return refused('receipt-not-yet-valid');
    }
    if (nowMs >= expiresAtMs) return refused('receipt-expired');

    const receiptSequence = parseSequence(first.sequence)!;
    const replaySequence = parseSequence(input.replayState.sequence)!;
    if (receiptSequence < replaySequence) return refused('receipt-stale');
    if (receiptSequence === replaySequence) {
      return input.replayState.receiptDigest !== null &&
        equalDigest(first.receiptDigest, input.replayState.receiptDigest)
        ? refused('receipt-replayed')
        : refused('receipt-equivocal');
    }
    if (receiptSequence !== replaySequence + 1n) return refused('sequence-gap');

    return {
      state: 'observed',
      reason: 'signed-external-cas-decision',
      receipt: first,
      receiptDigest: first.receiptDigest,
      decision: first.decision,
      authenticated: true,
      observationOnly: true,
      localMutationPermitted: false,
      ...NO_AUTHORITY,
    };
  } catch {
    return refused('invalid-receipt');
  }
}
