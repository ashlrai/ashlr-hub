import {
  createHash,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

const SCHEMA_VERSION = 1 as const;
const PROTOCOL = 'ashlr.operational-projection-monotonic-anchor.v1' as const;
const VALUE_DOMAIN = 'ashlr.operational-projection-monotonic-anchor.value.v1';
const REQUEST_DOMAIN = 'ashlr.operational-projection-monotonic-anchor.request.v1';
const RECEIPT_DOMAIN = 'ashlr.operational-projection-monotonic-anchor.receipt.v1';
const SIGNATURE_DOMAIN = 'ashlr.operational-projection-monotonic-anchor.signature.v1';
const MAX_CANONICAL_BYTES = 16 * 1024;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const UINT_RE = /^(0|[1-9][0-9]{0,19})$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

const NO_AUTHORITY = {
  historicalAuthority: false as const,
  rollbackProtected: false as const,
  operationalAuthority: false as const,
};

export type OperationalProjectionAnchorDecision =
  | 'accepted'
  | 'conflict'
  | 'unavailable';

export type OperationalProjectionAnchorReason =
  | 'accepted'
  | 'compare-mismatch'
  | 'temporarily-unavailable';

export interface OperationalProjectionAnchorStateV1 {
  sequence: string;
  valueDigest: string | null;
  receiptDigest: string | null;
}

export interface OperationalProjectionAnchorProposedStateV1 {
  sequence: string;
  valueDigest: string;
}

/**
 * Binds an anchor value to one exact committed shadow transaction projection.
 * The source fields remain claims until a later coordinator independently
 * re-reads and authenticates the shadow transaction.
 */
export interface OperationalProjectionAnchorSourceV1 {
  shadowSchemaVersion: 2;
  transactionId: string;
  transactionAttestation: string;
  transactionPhase: 'committed';
  localRollForwardRequired: false;
  proposalId: string;
  proposalDigest: string;
  projectionDigest: string;
}

export interface OperationalProjectionAnchorCasRequestV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  anchorId: string;
  namespace: string;
  requestNonce: string;
  expected: OperationalProjectionAnchorStateV1;
  proposed: OperationalProjectionAnchorProposedStateV1;
  source: OperationalProjectionAnchorSourceV1;
  historicalAuthority: false;
  rollbackProtected: false;
  operationalAuthority: false;
}

export interface OperationalProjectionAnchorReceiptCoreV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  anchorId: string;
  namespace: string;
  keyId: string;
  keyEpoch: string;
  decision: OperationalProjectionAnchorDecision;
  reason: OperationalProjectionAnchorReason;
  requestDigest: string;
  observed: OperationalProjectionAnchorStateV1 | null;
  accepted: OperationalProjectionAnchorProposedStateV1 | null;
  historicalAuthority: false;
  rollbackProtected: false;
  operationalAuthority: false;
}

export interface OperationalProjectionAnchorReceiptV1
  extends OperationalProjectionAnchorReceiptCoreV1 {
  receiptDigest: string;
  signature: string;
}

/**
 * Transport boundary only. Implementations must perform one atomic external
 * compare-and-swap and return the untrusted parsed receipt response.
 */
export interface OperationalProjectionMonotonicAnchor {
  readonly anchorId: string;
  compareAndSwap(request: OperationalProjectionAnchorCasRequestV1): Promise<unknown>;
}

/**
 * Trust is caller-owned and never discovered from a receipt. Key rotation is a
 * separate policy decision expressed by selecting one exact key and epoch.
 */
export interface OperationalProjectionAnchorTrustV1 {
  anchorId: string;
  keyId: string;
  keyEpoch: string;
  publicKey: KeyObject;
}

export type OperationalProjectionAnchorInvalidReason =
  | 'invalid-request'
  | 'invalid-trust'
  | 'invalid-receipt'
  | 'anchor-mismatch'
  | 'namespace-mismatch'
  | 'request-mismatch'
  | 'signer-mismatch'
  | 'receipt-digest-mismatch'
  | 'signature-invalid'
  | 'decision-inconsistent';

export type OperationalProjectionAnchorReceiptVerification =
  | {
      state: 'authenticated';
      decision: OperationalProjectionAnchorDecision;
      receipt: OperationalProjectionAnchorReceiptV1;
      authenticated: true;
      casAccepted: boolean;
      historicalAuthority: false;
      rollbackProtected: false;
      operationalAuthority: false;
    }
  | {
      state: 'invalid';
      reason: OperationalProjectionAnchorInvalidReason;
      receipt: null;
      authenticated: false;
      casAccepted: false;
      historicalAuthority: false;
      rollbackProtected: false;
      operationalAuthority: false;
    };

export interface BuildOperationalProjectionAnchorRequestInput {
  anchorId: string;
  namespace: string;
  requestNonce: string;
  expected: OperationalProjectionAnchorStateV1;
  source: OperationalProjectionAnchorSourceV1;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && ID_RE.test(value);
}

function validProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 &&
    PROPOSAL_ID_RE.test(value) && value !== '.' && value !== '..';
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

function validState(value: unknown): value is OperationalProjectionAnchorStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['sequence', 'valueDigest', 'receiptDigest'])) return false;
  const sequence = parseSequence(record['sequence']);
  if (sequence === null) return false;
  if (sequence === 0n) {
    return record['valueDigest'] === null && record['receiptDigest'] === null;
  }
  return validDigest(record['valueDigest']) && validDigest(record['receiptDigest']);
}

function validProposedState(
  value: unknown,
): value is OperationalProjectionAnchorProposedStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['sequence', 'valueDigest']) &&
    parseSequence(record['sequence']) !== null &&
    validDigest(record['valueDigest']);
}

function validSource(value: unknown): value is OperationalProjectionAnchorSourceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, [
    'shadowSchemaVersion',
    'transactionId',
    'transactionAttestation',
    'transactionPhase',
    'localRollForwardRequired',
    'proposalId',
    'proposalDigest',
    'projectionDigest',
  ]) &&
    record['shadowSchemaVersion'] === 2 &&
    validDigest(record['transactionId']) &&
    validDigest(record['transactionAttestation']) &&
    record['transactionPhase'] === 'committed' &&
    record['localRollForwardRequired'] === false &&
    validProposalId(record['proposalId']) &&
    validDigest(record['proposalDigest']) &&
    validDigest(record['projectionDigest']);
}

function canonicalSource(value: OperationalProjectionAnchorSourceV1): string {
  return JSON.stringify({
    localRollForwardRequired: value.localRollForwardRequired,
    projectionDigest: value.projectionDigest,
    proposalDigest: value.proposalDigest,
    proposalId: value.proposalId,
    shadowSchemaVersion: value.shadowSchemaVersion,
    transactionAttestation: value.transactionAttestation,
    transactionId: value.transactionId,
    transactionPhase: value.transactionPhase,
  });
}

function canonicalState(value: OperationalProjectionAnchorStateV1): Record<string, unknown> {
  return {
    receiptDigest: value.receiptDigest,
    sequence: value.sequence,
    valueDigest: value.valueDigest,
  };
}

function canonicalProposed(
  value: OperationalProjectionAnchorProposedStateV1,
): Record<string, unknown> {
  return {
    sequence: value.sequence,
    valueDigest: value.valueDigest,
  };
}

function hashDomain(domain: string, canonical: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) && DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalWithinLimit(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MAX_CANONICAL_BYTES;
}

export function operationalProjectionAnchorValueDigest(
  source: OperationalProjectionAnchorSourceV1,
): string {
  if (!validSource(source)) throw new TypeError('invalid operational projection anchor source');
  return hashDomain(VALUE_DOMAIN, canonicalSource(source));
}

export function buildOperationalProjectionAnchorRequest(
  input: BuildOperationalProjectionAnchorRequestInput,
): OperationalProjectionAnchorCasRequestV1 {
  if (!validId(input.anchorId, 128) ||
    !validId(input.namespace, 240) ||
    !validDigest(input.requestNonce) ||
    !validState(input.expected) ||
    !validSource(input.source)) {
    throw new TypeError('invalid operational projection anchor request input');
  }
  const expectedSequence = parseSequence(input.expected.sequence);
  if (expectedSequence === null || expectedSequence >= MAX_UINT64) {
    throw new TypeError('operational projection anchor sequence exhausted');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL,
    anchorId: input.anchorId,
    namespace: input.namespace,
    requestNonce: input.requestNonce,
    expected: { ...input.expected },
    proposed: {
      sequence: (expectedSequence + 1n).toString(),
      valueDigest: operationalProjectionAnchorValueDigest(input.source),
    },
    source: { ...input.source },
    ...NO_AUTHORITY,
  };
}

function validRequest(value: unknown): value is OperationalProjectionAnchorCasRequestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'schemaVersion',
    'protocol',
    'anchorId',
    'namespace',
    'requestNonce',
    'expected',
    'proposed',
    'source',
    'historicalAuthority',
    'rollbackProtected',
    'operationalAuthority',
  ]) ||
    record['schemaVersion'] !== SCHEMA_VERSION ||
    record['protocol'] !== PROTOCOL ||
    !validId(record['anchorId'], 128) ||
    !validId(record['namespace'], 240) ||
    !validDigest(record['requestNonce']) ||
    !validState(record['expected']) ||
    !validProposedState(record['proposed']) ||
    !validSource(record['source']) ||
    record['historicalAuthority'] !== false ||
    record['rollbackProtected'] !== false ||
    record['operationalAuthority'] !== false) {
    return false;
  }
  const expected = record['expected'];
  const proposed = record['proposed'];
  const expectedSequence = parseSequence(expected.sequence);
  const proposedSequence = parseSequence(proposed.sequence);
  return expectedSequence !== null &&
    proposedSequence !== null &&
    expectedSequence < MAX_UINT64 &&
    proposedSequence === expectedSequence + 1n &&
    equalDigest(proposed.valueDigest, operationalProjectionAnchorValueDigest(record['source']));
}

function canonicalRequest(value: OperationalProjectionAnchorCasRequestV1): string {
  return JSON.stringify({
    anchorId: value.anchorId,
    expected: canonicalState(value.expected),
    historicalAuthority: value.historicalAuthority,
    namespace: value.namespace,
    operationalAuthority: value.operationalAuthority,
    proposed: canonicalProposed(value.proposed),
    protocol: value.protocol,
    requestNonce: value.requestNonce,
    rollbackProtected: value.rollbackProtected,
    schemaVersion: value.schemaVersion,
    source: JSON.parse(canonicalSource(value.source)) as Record<string, unknown>,
  });
}

export function serializeOperationalProjectionAnchorRequest(
  request: OperationalProjectionAnchorCasRequestV1,
): string {
  if (!validRequest(request)) throw new TypeError('invalid operational projection anchor request');
  const canonical = canonicalRequest(request);
  if (!canonicalWithinLimit(canonical)) {
    throw new TypeError('operational projection anchor request too large');
  }
  return canonical;
}

export function operationalProjectionAnchorRequestDigest(
  request: OperationalProjectionAnchorCasRequestV1,
): string {
  return hashDomain(REQUEST_DOMAIN, serializeOperationalProjectionAnchorRequest(request));
}

function validDecision(value: unknown): value is OperationalProjectionAnchorDecision {
  return value === 'accepted' || value === 'conflict' || value === 'unavailable';
}

function validReason(value: unknown): value is OperationalProjectionAnchorReason {
  return value === 'accepted' ||
    value === 'compare-mismatch' ||
    value === 'temporarily-unavailable';
}

function validReceiptCore(value: unknown): value is OperationalProjectionAnchorReceiptCoreV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, [
    'schemaVersion',
    'protocol',
    'anchorId',
    'namespace',
    'keyId',
    'keyEpoch',
    'decision',
    'reason',
    'requestDigest',
    'observed',
    'accepted',
    'historicalAuthority',
    'rollbackProtected',
    'operationalAuthority',
  ]) &&
    record['schemaVersion'] === SCHEMA_VERSION &&
    record['protocol'] === PROTOCOL &&
    validId(record['anchorId'], 128) &&
    validId(record['namespace'], 240) &&
    validId(record['keyId'], 128) &&
    parseSequence(record['keyEpoch']) !== null &&
    record['keyEpoch'] !== '0' &&
    validDecision(record['decision']) &&
    validReason(record['reason']) &&
    validDigest(record['requestDigest']) &&
    (record['observed'] === null || validState(record['observed'])) &&
    (record['accepted'] === null || validProposedState(record['accepted'])) &&
    record['historicalAuthority'] === false &&
    record['rollbackProtected'] === false &&
    record['operationalAuthority'] === false;
}

function canonicalReceiptCore(value: OperationalProjectionAnchorReceiptCoreV1): string {
  return JSON.stringify({
    accepted: value.accepted === null ? null : canonicalProposed(value.accepted),
    anchorId: value.anchorId,
    decision: value.decision,
    historicalAuthority: value.historicalAuthority,
    keyEpoch: value.keyEpoch,
    keyId: value.keyId,
    namespace: value.namespace,
    observed: value.observed === null ? null : canonicalState(value.observed),
    operationalAuthority: value.operationalAuthority,
    protocol: value.protocol,
    reason: value.reason,
    requestDigest: value.requestDigest,
    rollbackProtected: value.rollbackProtected,
    schemaVersion: value.schemaVersion,
  });
}

export function operationalProjectionAnchorReceiptDigest(
  receipt: OperationalProjectionAnchorReceiptCoreV1,
): string {
  if (!validReceiptCore(receipt)) {
    throw new TypeError('invalid operational projection anchor receipt core');
  }
  const canonical = canonicalReceiptCore(receipt);
  if (!canonicalWithinLimit(canonical)) {
    throw new TypeError('operational projection anchor receipt too large');
  }
  return hashDomain(RECEIPT_DOMAIN, canonical);
}

export function operationalProjectionAnchorReceiptSigningBytes(
  receiptDigest: string,
): Buffer {
  if (!validDigest(receiptDigest)) {
    throw new TypeError('invalid operational projection anchor receipt digest');
  }
  return Buffer.from(`${SIGNATURE_DOMAIN}\n${receiptDigest}`, 'utf8');
}

function parseReceipt(value: unknown): OperationalProjectionAnchorReceiptV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    'schemaVersion',
    'protocol',
    'anchorId',
    'namespace',
    'keyId',
    'keyEpoch',
    'decision',
    'reason',
    'requestDigest',
    'observed',
    'accepted',
    'historicalAuthority',
    'rollbackProtected',
    'operationalAuthority',
    'receiptDigest',
    'signature',
  ]) ||
    !validDigest(record['receiptDigest']) ||
    typeof record['signature'] !== 'string' ||
    !SIGNATURE_RE.test(record['signature']) ||
    !validReceiptCore({
      schemaVersion: record['schemaVersion'],
      protocol: record['protocol'],
      anchorId: record['anchorId'],
      namespace: record['namespace'],
      keyId: record['keyId'],
      keyEpoch: record['keyEpoch'],
      decision: record['decision'],
      reason: record['reason'],
      requestDigest: record['requestDigest'],
      observed: record['observed'],
      accepted: record['accepted'],
      historicalAuthority: record['historicalAuthority'],
      rollbackProtected: record['rollbackProtected'],
      operationalAuthority: record['operationalAuthority'],
    })) {
    return null;
  }
  const signature = Buffer.from(record['signature'], 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== record['signature']) {
    return null;
  }
  return record as unknown as OperationalProjectionAnchorReceiptV1;
}

function receiptCore(
  receipt: OperationalProjectionAnchorReceiptV1,
): OperationalProjectionAnchorReceiptCoreV1 {
  const { receiptDigest: _receiptDigest, signature: _signature, ...core } = receipt;
  return core;
}

function sameState(
  left: OperationalProjectionAnchorStateV1,
  right: OperationalProjectionAnchorStateV1,
): boolean {
  return left.sequence === right.sequence &&
    left.valueDigest === right.valueDigest &&
    left.receiptDigest === right.receiptDigest;
}

function sameProposed(
  left: OperationalProjectionAnchorProposedStateV1,
  right: OperationalProjectionAnchorProposedStateV1,
): boolean {
  return left.sequence === right.sequence && equalDigest(left.valueDigest, right.valueDigest);
}

function decisionConsistent(
  request: OperationalProjectionAnchorCasRequestV1,
  receipt: OperationalProjectionAnchorReceiptV1,
): boolean {
  if (receipt.decision === 'accepted') {
    return receipt.reason === 'accepted' &&
      receipt.observed !== null &&
      sameState(receipt.observed, request.expected) &&
      receipt.accepted !== null &&
      sameProposed(receipt.accepted, request.proposed);
  }
  if (receipt.decision === 'conflict') {
    return receipt.reason === 'compare-mismatch' &&
      receipt.observed !== null &&
      !sameState(receipt.observed, request.expected) &&
      receipt.accepted === null;
  }
  return receipt.reason === 'temporarily-unavailable' &&
    receipt.observed === null &&
    receipt.accepted === null;
}

function invalid(
  reason: OperationalProjectionAnchorInvalidReason,
): OperationalProjectionAnchorReceiptVerification {
  return {
    state: 'invalid',
    reason,
    receipt: null,
    authenticated: false,
    casAccepted: false,
    ...NO_AUTHORITY,
  };
}

export function verifyOperationalProjectionAnchorReceipt(
  request: OperationalProjectionAnchorCasRequestV1,
  untrustedReceipt: unknown,
  trust: OperationalProjectionAnchorTrustV1,
): OperationalProjectionAnchorReceiptVerification {
  try {
    if (!validRequest(request)) return invalid('invalid-request');
    if (!validId(trust.anchorId, 128) ||
      !validId(trust.keyId, 128) ||
      parseSequence(trust.keyEpoch) === null ||
      trust.keyEpoch === '0' ||
      trust.publicKey.type !== 'public' ||
      trust.publicKey.asymmetricKeyType !== 'ed25519') {
      return invalid('invalid-trust');
    }
    const receipt = parseReceipt(untrustedReceipt);
    if (!receipt) return invalid('invalid-receipt');
    if (receipt.anchorId !== request.anchorId || receipt.anchorId !== trust.anchorId) {
      return invalid('anchor-mismatch');
    }
    if (receipt.namespace !== request.namespace) return invalid('namespace-mismatch');
    if (!equalDigest(
      receipt.requestDigest,
      operationalProjectionAnchorRequestDigest(request),
    )) {
      return invalid('request-mismatch');
    }
    if (receipt.keyId !== trust.keyId || receipt.keyEpoch !== trust.keyEpoch) {
      return invalid('signer-mismatch');
    }
    const computedReceiptDigest = operationalProjectionAnchorReceiptDigest(receiptCore(receipt));
    if (!equalDigest(receipt.receiptDigest, computedReceiptDigest)) {
      return invalid('receipt-digest-mismatch');
    }
    const signature = Buffer.from(receipt.signature, 'base64url');
    if (!verifySignature(
      null,
      operationalProjectionAnchorReceiptSigningBytes(receipt.receiptDigest),
      trust.publicKey,
      signature,
    )) {
      return invalid('signature-invalid');
    }
    if (!decisionConsistent(request, receipt)) return invalid('decision-inconsistent');
    return {
      state: 'authenticated',
      decision: receipt.decision,
      receipt,
      authenticated: true,
      casAccepted: receipt.decision === 'accepted',
      ...NO_AUTHORITY,
    };
  } catch {
    return invalid('invalid-receipt');
  }
}
