import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  recoverImmutablePrivateRecordStore,
  readImmutablePrivateRecords,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
  type ImmutablePrivateRecordWriteDisposition,
} from '../util/immutable-private-record-store.js';
import {
  operationalProjectionAnchorReceiptDigest,
  operationalProjectionAnchorRequestDigest,
  verifyOperationalProjectionAnchorReceipt,
  type OperationalProjectionAnchorCasRequestV1,
  type OperationalProjectionAnchorReceiptCoreV1,
  type OperationalProjectionAnchorReceiptV1,
  type OperationalProjectionAnchorTrustV1,
} from './operational-projection-monotonic-anchor.js';
import {
  inspectOperationalProjectionShadowWrite,
  operationalProjectionShadowWriterRoot,
  rollbackCommittedOperationalProjectionShadowWrite,
  type OperationalProjectionShadowInspection,
} from './operational-projection-shadow-writer.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

const SCHEMA_VERSION = 1 as const;
const RECORD_TYPE = 'operational-projection-cas-consumption' as const;
const KEY_DOMAIN = 'ashlr.operational-projection-cas-consumption.key.v1';
const RECORD_DOMAIN = 'ashlr.operational-projection-cas-consumption.record.v1';
const ATTESTATION_DOMAIN = 'ashlr.operational-projection-cas-consumption.attestation.v1';
const DECISION_DOMAIN = 'ashlr.operational-projection-cas-consumption.decision.v1';
const CONSUMPTION_DOMAIN = 'ashlr.operational-projection-cas-consumption.identity.v2';
const LEGACY_CONSUMPTION_DOMAIN =
  'ashlr.operational-projection-cas-consumption.identity.v1';
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const MAX_RECORDS = 50_000;

const NO_AUTHORITY = {
  historicalAuthority: false as const,
  operationalAuthority: false as const,
  rollbackAuthority: false as const,
  rollbackProtected: false as const,
};

export type OperationalProjectionCasConsumptionDecision =
  | 'roll-forward'
  | 'rollback';

export type OperationalProjectionCasConsumptionPhase =
  | 'prepared'
  | 'applied';

export interface OperationalProjectionCasConsumptionRecordV1 {
  schemaVersion: 1;
  recordType: typeof RECORD_TYPE;
  decisionId: string;
  phase: OperationalProjectionCasConsumptionPhase;
  decision: OperationalProjectionCasConsumptionDecision;
  consumptionDigest: string;
  requestDigest: string;
  receiptDigest: string;
  casRequest: OperationalProjectionAnchorCasRequestV1;
  casReceipt: OperationalProjectionAnchorReceiptV1;
  resultingShadowPhase: 'committed' | 'rolled-back' | null;
  recordedAt: string;
  historicalAuthority: false;
  operationalAuthority: false;
  rollbackAuthority: false;
  rollbackProtected: false;
  recordDigest: string;
  attestation: string;
}

export interface ApplyOperationalProjectionCasRecoveryInputV1 {
  casRequest: OperationalProjectionAnchorCasRequestV1;
  /**
   * May be null only after an authenticated prepared record was durably
   * published. The coordinator then reverifies the persisted receipt.
   */
  untrustedCasReceipt: unknown | null;
  casTrust: OperationalProjectionAnchorTrustV1;
  storeLock: ProposalStoreMutationLock;
  now: Date;
}

export type ApplyOperationalProjectionCasRecoveryResult =
  | {
      state: 'applied';
      reason: 'signed-cas-decision-applied' | 'signed-cas-decision-already-applied';
      decision: OperationalProjectionCasConsumptionDecision;
      decisionId: string;
      receiptDigest: string;
      prepared: OperationalProjectionCasConsumptionRecordV1;
      completion: OperationalProjectionCasConsumptionRecordV1;
      shadow: OperationalProjectionShadowInspection;
      authenticated: true;
      localMutationApplied: boolean;
      historicalAuthority: false;
      operationalAuthority: false;
      rollbackAuthority: false;
      rollbackProtected: false;
    }
  | {
      state: 'refused' | 'degraded';
      reason: string;
      decision: null;
      decisionId: null;
      receiptDigest: null;
      prepared: OperationalProjectionCasConsumptionRecordV1 | null;
      completion: OperationalProjectionCasConsumptionRecordV1 | null;
      shadow: OperationalProjectionShadowInspection | null;
      authenticated: false;
      localMutationApplied: false;
      historicalAuthority: false;
      operationalAuthority: false;
      rollbackAuthority: false;
      rollbackProtected: false;
    };

type UnsignedRecord = Omit<
  OperationalProjectionCasConsumptionRecordV1,
  'recordDigest' | 'attestation'
>;

const RECORD_KEYS = [
  'schemaVersion',
  'recordType',
  'decisionId',
  'phase',
  'decision',
  'consumptionDigest',
  'requestDigest',
  'receiptDigest',
  'casRequest',
  'casReceipt',
  'resultingShadowPhase',
  'recordedAt',
  'historicalAuthority',
  'operationalAuthority',
  'rollbackAuthority',
  'rollbackProtected',
  'recordDigest',
  'attestation',
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) &&
    DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha(domain: string, value: string): string {
  return createHash('sha256')
    .update(`${domain}\n`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function localKey(): Buffer | null {
  try {
    const provenance = loadExistingProvenanceKeyReadOnly();
    return provenance?.length === 32
      ? createHmac('sha256', provenance).update(`${KEY_DOMAIN}\n`, 'utf8').digest()
      : null;
  } catch {
    return null;
  }
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update(`${domain}\n`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function receiptCore(
  receipt: OperationalProjectionAnchorReceiptV1,
): OperationalProjectionAnchorReceiptCoreV1 {
  const { receiptDigest: _receiptDigest, signature: _signature, ...core } = receipt;
  return core;
}

function decisionFor(
  request: OperationalProjectionAnchorCasRequestV1,
  receipt: OperationalProjectionAnchorReceiptV1,
): OperationalProjectionCasConsumptionDecision | null {
  if (receipt.decision === 'accepted') return 'roll-forward';
  if (receipt.decision === 'conflict') {
    // A retry after a lost acceptance response can legitimately observe the
    // exact proposed value as a compare mismatch. The signed receipt is still
    // a conflict for this retry, but it proves the transaction already won.
    const observed = receipt.observed;
    if (receipt.reason === 'compare-mismatch' &&
      receipt.accepted === null &&
      observed !== null &&
      observed.sequence === request.proposed.sequence &&
      observed.valueDigest !== null &&
      equalDigest(observed.valueDigest, request.proposed.valueDigest)) {
      return 'roll-forward';
    }
    return 'rollback';
  }
  return null;
}

function persistedDecisionCompatible(
  request: OperationalProjectionAnchorCasRequestV1,
  receipt: OperationalProjectionAnchorReceiptV1,
  persisted: OperationalProjectionCasConsumptionDecision,
): boolean {
  const current = decisionFor(request, receipt);
  if (current === persisted) return true;
  // Before exact-observed conflicts were recognized as acceptance-equivalent,
  // this schema durably recorded them as rollback. Preserve that authenticated
  // local intent on upgrade; only newly prepared records use roll-forward.
  return current === 'roll-forward' &&
    receipt.decision === 'conflict' &&
    persisted === 'rollback';
}

function decisionId(requestDigest: string, receiptDigest: string): string {
  return sha(DECISION_DOMAIN, JSON.stringify([requestDigest, receiptDigest]));
}

// Routing coordinates and retry state cannot partition one shadow transaction's decision history.
function consumptionDigest(request: OperationalProjectionAnchorCasRequestV1): string {
  return sha(CONSUMPTION_DOMAIN, JSON.stringify({
    source: {
      projectionDigest: request.source.projectionDigest,
      proposalDigest: request.source.proposalDigest,
      proposalId: request.source.proposalId,
      transactionId: request.source.transactionId,
    },
  }));
}

function legacyCoordinateBoundConsumptionDigest(
  request: OperationalProjectionAnchorCasRequestV1,
): string {
  return sha(LEGACY_CONSUMPTION_DOMAIN, JSON.stringify({
    anchorId: request.anchorId,
    namespace: request.namespace,
    source: {
      projectionDigest: request.source.projectionDigest,
      proposalDigest: request.source.proposalDigest,
      proposalId: request.source.proposalId,
      transactionId: request.source.transactionId,
    },
  }));
}

function unsigned(
  record: OperationalProjectionCasConsumptionRecordV1,
): UnsignedRecord {
  const {
    recordDigest: _recordDigest,
    attestation: _attestation,
    ...value
  } = record;
  return value;
}

function payload(record: UnsignedRecord): string {
  return JSON.stringify({
    casReceipt: record.casReceipt,
    casRequest: record.casRequest,
    consumptionDigest: record.consumptionDigest,
    decision: record.decision,
    decisionId: record.decisionId,
    historicalAuthority: record.historicalAuthority,
    operationalAuthority: record.operationalAuthority,
    phase: record.phase,
    receiptDigest: record.receiptDigest,
    recordType: record.recordType,
    recordedAt: record.recordedAt,
    requestDigest: record.requestDigest,
    resultingShadowPhase: record.resultingShadowPhase,
    rollbackAuthority: record.rollbackAuthority,
    rollbackProtected: record.rollbackProtected,
    schemaVersion: record.schemaVersion,
  });
}

function buildRecord(
  key: Buffer,
  request: OperationalProjectionAnchorCasRequestV1,
  receipt: OperationalProjectionAnchorReceiptV1,
  phase: OperationalProjectionCasConsumptionPhase,
  recordedAt: string,
  persistedDecision?: OperationalProjectionCasConsumptionDecision,
): OperationalProjectionCasConsumptionRecordV1 | null {
  try {
    const requestDigest = operationalProjectionAnchorRequestDigest(request);
    const stableConsumptionDigest = consumptionDigest(request);
    const computedReceiptDigest = operationalProjectionAnchorReceiptDigest(receiptCore(receipt));
    const inferredDecision = decisionFor(request, receipt);
    if (!inferredDecision) return null;
    const decision = persistedDecision ?? inferredDecision;
    if (!persistedDecisionCompatible(request, receipt, decision) ||
      !equalDigest(receipt.receiptDigest, computedReceiptDigest) ||
      !canonicalTimestamp(recordedAt)) return null;
    const id = decisionId(requestDigest, receipt.receiptDigest);
    const record: UnsignedRecord = {
      schemaVersion: SCHEMA_VERSION,
      recordType: RECORD_TYPE,
      decisionId: id,
      phase,
      decision,
      consumptionDigest: stableConsumptionDigest,
      requestDigest,
      receiptDigest: receipt.receiptDigest,
      casRequest: structuredClone(request),
      casReceipt: structuredClone(receipt),
      resultingShadowPhase: phase === 'prepared'
        ? null
        : decision === 'roll-forward' ? 'committed' : 'rolled-back',
      recordedAt,
      ...NO_AUTHORITY,
    };
    const recordDigest = sha(RECORD_DOMAIN, payload(record));
    return {
      ...record,
      recordDigest,
      attestation: hmac(key, ATTESTATION_DOMAIN, recordDigest),
    };
  } catch {
    return null;
  }
}

function parseRecord(
  value: unknown,
  key: Buffer,
): OperationalProjectionCasConsumptionRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, RECORD_KEYS) ||
    row['schemaVersion'] !== SCHEMA_VERSION ||
    row['recordType'] !== RECORD_TYPE ||
    typeof row['decisionId'] !== 'string' || !DIGEST_RE.test(row['decisionId']) ||
    (row['phase'] !== 'prepared' && row['phase'] !== 'applied') ||
    (row['decision'] !== 'roll-forward' && row['decision'] !== 'rollback') ||
    typeof row['consumptionDigest'] !== 'string' || !DIGEST_RE.test(row['consumptionDigest']) ||
    typeof row['requestDigest'] !== 'string' || !DIGEST_RE.test(row['requestDigest']) ||
    typeof row['receiptDigest'] !== 'string' || !DIGEST_RE.test(row['receiptDigest']) ||
    !row['casRequest'] || typeof row['casRequest'] !== 'object' ||
    !row['casReceipt'] || typeof row['casReceipt'] !== 'object' ||
    (row['resultingShadowPhase'] !== null &&
      row['resultingShadowPhase'] !== 'committed' &&
      row['resultingShadowPhase'] !== 'rolled-back') ||
    (row['phase'] === 'prepared' && row['resultingShadowPhase'] !== null) ||
    (row['phase'] === 'applied' && row['resultingShadowPhase'] === null) ||
    !canonicalTimestamp(row['recordedAt']) ||
    row['historicalAuthority'] !== false ||
    row['operationalAuthority'] !== false ||
    row['rollbackAuthority'] !== false ||
    row['rollbackProtected'] !== false ||
    typeof row['recordDigest'] !== 'string' || !DIGEST_RE.test(row['recordDigest']) ||
    typeof row['attestation'] !== 'string' || !DIGEST_RE.test(row['attestation'])) {
    return null;
  }
  const record = row as unknown as OperationalProjectionCasConsumptionRecordV1;
  try {
    const requestDigest = operationalProjectionAnchorRequestDigest(record.casRequest);
    const stableConsumptionDigest = consumptionDigest(record.casRequest);
    // Parent-format records remain readable only after their local HMAC is verified below.
    const legacyConsumptionDigest = legacyCoordinateBoundConsumptionDigest(record.casRequest);
    const receiptDigest = operationalProjectionAnchorReceiptDigest(
      receiptCore(record.casReceipt),
    );
    const decision = decisionFor(record.casRequest, record.casReceipt);
    const expectedResultingPhase = record.decision === 'roll-forward'
      ? 'committed'
      : 'rolled-back';
    if (!decision ||
      !persistedDecisionCompatible(record.casRequest, record.casReceipt, record.decision) ||
      (record.phase === 'applied' && record.resultingShadowPhase !== expectedResultingPhase) ||
      (!equalDigest(stableConsumptionDigest, record.consumptionDigest) &&
        !equalDigest(legacyConsumptionDigest, record.consumptionDigest)) ||
      !equalDigest(requestDigest, record.requestDigest) ||
      !equalDigest(receiptDigest, record.receiptDigest) ||
      !equalDigest(record.casReceipt.receiptDigest, record.receiptDigest) ||
      !SIGNATURE_RE.test(record.casReceipt.signature) ||
      !equalDigest(
        record.decisionId,
        decisionId(record.requestDigest, record.receiptDigest),
      )) return null;
    const expectedDigest = sha(RECORD_DOMAIN, payload(unsigned(record)));
    return equalDigest(record.recordDigest, expectedDigest) &&
      equalDigest(record.attestation, hmac(key, ATTESTATION_DOMAIN, expectedDigest))
      ? record
      : null;
  } catch {
    return null;
  }
}

function codec(key: Buffer): ImmutablePrivateRecordCodec<
OperationalProjectionCasConsumptionRecordV1
> {
  return {
    parse: (value) => parseRecord(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => `${record.decisionId}.${record.phase}`,
    recordFileName: (record) => `${record.decisionId}.${record.phase}.json`,
    isRecordFileName: (fileName) =>
      /^(?:[a-f0-9]{64})\.(?:prepared|applied)\.json$/.test(fileName),
    stageToken: (record) => record.recordDigest,
    equivalent: (left, right) => equalDigest(left.recordDigest, right.recordDigest),
    compare: (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) ||
      left.decisionId.localeCompare(right.decisionId) ||
      left.phase.localeCompare(right.phase),
  };
}

export function operationalProjectionCasConsumptionStorePath(): string {
  return join(operationalProjectionShadowWriterRoot(), 'cas-consumption-v1');
}

function storeConfig(): ImmutablePrivateRecordStoreConfig<
OperationalProjectionCasConsumptionRecordV1
> {
  return {
    label: 'operational projection CAS consumption',
    anchorPath: operationalProjectionShadowWriterRoot(),
    rootPath: operationalProjectionCasConsumptionStorePath(),
    lockFileName: '.cas-consumption.lock',
    maxRecordBytes: 64 * 1024,
    defaultMaxFiles: 4_096,
    hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: 32 * 1024 * 1024,
    hardMaxBytes: 512 * 1024 * 1024,
    codecForWrite: () => {
      const key = localKey();
      return key ? codec(key) : null;
    },
    codecForRead: () => {
      const key = localKey();
      return key ? codec(key) : null;
    },
  };
}

export function readOperationalProjectionCasConsumptionRecords(): {
  records: OperationalProjectionCasConsumptionRecordV1[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  stopReasons: string[];
} {
  const read = readImmutablePrivateRecords(storeConfig(), {
    maxFiles: MAX_RECORDS,
    maxBytes: 512 * 1024 * 1024,
    requireComplete: true,
  });
  return {
    records: read.records,
    sourceState: read.sourceState,
    complete: read.complete,
    stopReasons: read.stopReasons,
  };
}

function writeRecord(
  record: OperationalProjectionCasConsumptionRecordV1,
): ImmutablePrivateRecordWriteDisposition {
  return writeImmutablePrivateRecord(storeConfig(), record);
}

function failed(
  state: 'refused' | 'degraded',
  reason: string,
  prepared: OperationalProjectionCasConsumptionRecordV1 | null = null,
  completion: OperationalProjectionCasConsumptionRecordV1 | null = null,
  shadow: OperationalProjectionShadowInspection | null = null,
): ApplyOperationalProjectionCasRecoveryResult {
  return {
    state,
    reason,
    decision: null,
    decisionId: null,
    receiptDigest: null,
    prepared,
    completion,
    shadow,
    authenticated: false,
    localMutationApplied: false,
    ...NO_AUTHORITY,
  };
}

function exactShadowValueBinding(
  request: OperationalProjectionAnchorCasRequestV1,
  shadow: OperationalProjectionShadowInspection,
): boolean {
  const transaction = shadow.transaction;
  const source = request.source;
  return shadow.state === 'healthy' &&
    transaction !== null &&
    transaction.transactionId === source.transactionId &&
    transaction.proposalId === source.proposalId &&
    transaction.after.proposal.present &&
    transaction.after.proposal.digest !== null &&
    equalDigest(transaction.after.proposal.digest, source.proposalDigest) &&
    transaction.after.projection.present &&
    transaction.after.projection.digest !== null &&
    equalDigest(transaction.after.projection.digest, source.projectionDigest);
}

function exactCommittedShadowBinding(
  request: OperationalProjectionAnchorCasRequestV1,
  shadow: OperationalProjectionShadowInspection,
): boolean {
  return exactShadowValueBinding(request, shadow) &&
    shadow.transaction?.phase === 'committed' &&
    !shadow.transaction.localRollForwardRequired &&
    equalDigest(shadow.transaction.attestation, request.source.transactionAttestation) &&
    shadow.actual === 'complete';
}

function exactPersistedShadowBinding(
  prepared: OperationalProjectionCasConsumptionRecordV1,
  shadow: OperationalProjectionShadowInspection,
): boolean {
  if (!exactShadowValueBinding(prepared.casRequest, shadow)) return false;
  if (shadow.transaction?.phase === 'committed') {
    return !shadow.transaction.localRollForwardRequired &&
      equalDigest(
        shadow.transaction.attestation,
        prepared.casRequest.source.transactionAttestation,
      );
  }
  return prepared.decision === 'rollback' && shadow.transaction?.phase === 'rolled-back';
}

function applied(
  reason: 'signed-cas-decision-applied' | 'signed-cas-decision-already-applied',
  prepared: OperationalProjectionCasConsumptionRecordV1,
  completion: OperationalProjectionCasConsumptionRecordV1,
  shadow: OperationalProjectionShadowInspection,
  localMutationApplied: boolean,
): ApplyOperationalProjectionCasRecoveryResult {
  return {
    state: 'applied',
    reason,
    decision: prepared.decision,
    decisionId: prepared.decisionId,
    receiptDigest: prepared.receiptDigest,
    prepared,
    completion,
    shadow,
    authenticated: true,
    localMutationApplied,
    ...NO_AUTHORITY,
  };
}

function findDecisionRecords(
  records: readonly OperationalProjectionCasConsumptionRecordV1[],
  requestDigest: string,
  stableConsumptionDigest: string,
): {
  prepared: OperationalProjectionCasConsumptionRecordV1 | null;
  completion: OperationalProjectionCasConsumptionRecordV1 | null;
  equivocal: boolean;
  requestMismatch: boolean;
} {
  const matching = records.filter((record) =>
    equalDigest(consumptionDigest(record.casRequest), stableConsumptionDigest));
  const decisionIds = new Set(matching.map((record) => record.decisionId));
  if (decisionIds.size > 1) {
    return {
      prepared: null,
      completion: null,
      equivocal: true,
      requestMismatch: false,
    };
  }
  return {
    prepared: matching.find((record) => record.phase === 'prepared') ?? null,
    completion: matching.find((record) => record.phase === 'applied') ?? null,
    equivocal: false,
    requestMismatch: matching.some((record) =>
      !equalDigest(record.requestDigest, requestDigest)),
  };
}

export function applyOperationalProjectionCasRecovery(
  input: ApplyOperationalProjectionCasRecoveryInputV1,
): ApplyOperationalProjectionCasRecoveryResult {
  if (!ownsProposalStoreMutationLock(input.storeLock)) {
    return failed('refused', 'store-lock-not-owned');
  }
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return failed('refused', 'invalid-clock');
  const recordedAt = input.now.toISOString();
  let requestDigest: string;
  let stableConsumptionDigest: string;
  try {
    requestDigest = operationalProjectionAnchorRequestDigest(input.casRequest);
    stableConsumptionDigest = consumptionDigest(input.casRequest);
  } catch {
    return failed('refused', 'invalid-cas-request');
  }

  const recovery = recoverImmutablePrivateRecordStore(storeConfig());
  if (recovery === 'invalid' || recovery === 'failed') {
    return failed('degraded', `consumption-ledger-recovery-${recovery}`);
  }
  const ledger = readOperationalProjectionCasConsumptionRecords();
  if (ledger.sourceState === 'degraded' ||
    (ledger.sourceState === 'healthy' && !ledger.complete)) {
    return failed('degraded', `consumption-ledger-${ledger.stopReasons.join(',') || 'incomplete'}`);
  }
  const existing = findDecisionRecords(
    ledger.records,
    requestDigest,
    stableConsumptionDigest,
  );
  if (existing.equivocal) return failed('refused', 'cas-decision-equivocal');
  if (existing.completion && !existing.prepared) {
    return failed(
      'degraded',
      'completion-without-prepared-decision',
      null,
      existing.completion,
    );
  }
  if (existing.requestMismatch) {
    return failed(
      'refused',
      'cas-consumption-identity-already-decided',
      existing.prepared,
      existing.completion,
    );
  }
  const candidateReceipt = input.untrustedCasReceipt ?? existing.prepared?.casReceipt ?? null;
  if (candidateReceipt === null) return failed('refused', 'cas-receipt-unavailable');
  const verified = verifyOperationalProjectionAnchorReceipt(
    input.casRequest,
    candidateReceipt,
    input.casTrust,
  );
  if (verified.state !== 'authenticated') {
    return failed('refused', `invalid-cas-receipt-${verified.reason}`);
  }
  const decision = decisionFor(input.casRequest, verified.receipt);
  if (!decision) return failed('refused', 'cas-decision-unavailable');
  const id = decisionId(requestDigest, verified.receipt.receiptDigest);
  if (existing.prepared && !equalDigest(existing.prepared.decisionId, id)) {
    return failed('refused', 'cas-decision-equivocal', existing.prepared, existing.completion);
  }

  let shadow = inspectOperationalProjectionShadowWrite();
  const shadowBound = existing.prepared
    ? exactPersistedShadowBinding(existing.prepared, shadow)
    : exactCommittedShadowBinding(input.casRequest, shadow);
  if (!shadowBound) {
    return failed(
      'refused',
      'shadow-decision-binding-mismatch',
      existing.prepared,
      existing.completion,
      shadow,
    );
  }
  if (existing.completion) {
    const expectedPhase = existing.completion.resultingShadowPhase;
    if (shadow.transaction?.phase !== expectedPhase ||
      (expectedPhase === 'committed' && shadow.actual !== 'complete') ||
      (expectedPhase === 'rolled-back' && shadow.actual !== 'no-effect')) {
      return failed(
        'degraded',
        'applied-shadow-state-inconsistent',
        existing.prepared,
        existing.completion,
        shadow,
      );
    }
    return applied(
      'signed-cas-decision-already-applied',
      existing.prepared!,
      existing.completion,
      shadow,
      false,
    );
  }

  const key = localKey();
  if (!key) return failed('degraded', 'consumption-key-unavailable', existing.prepared);
  let prepared = existing.prepared;
  if (!prepared) {
    prepared = buildRecord(
      key,
      input.casRequest,
      verified.receipt,
      'prepared',
      recordedAt,
    );
    if (!prepared) return failed('degraded', 'prepared-record-invalid');
    const write = writeRecord(prepared);
    if (write !== 'recorded' && write !== 'replayed') {
      return failed(
        write === 'conflicted' ? 'refused' : 'degraded',
        `prepared-record-${write}`,
        prepared,
        null,
        shadow,
      );
    }
  }

  const committedAttestation = prepared.casRequest.source.transactionAttestation;
  const appliedDecision = prepared.decision;
  let localMutationApplied = false;
  if (appliedDecision === 'rollback' && shadow.transaction?.phase !== 'rolled-back') {
    shadow = rollbackCommittedOperationalProjectionShadowWrite(
      prepared.casRequest.source.transactionId,
      committedAttestation,
      input.storeLock,
      input.now,
    );
    localMutationApplied = true;
  }
  const expectedPhase = appliedDecision === 'roll-forward' ? 'committed' : 'rolled-back';
  if (shadow.state !== 'healthy' ||
    shadow.transaction?.phase !== expectedPhase ||
    (expectedPhase === 'committed' && shadow.actual !== 'complete') ||
    (expectedPhase === 'rolled-back' && shadow.actual !== 'no-effect')) {
    return failed('degraded', 'shadow-action-incomplete', prepared, null, shadow);
  }

  const completion = buildRecord(
    key,
    prepared.casRequest,
    prepared.casReceipt,
    'applied',
    recordedAt,
    prepared.decision,
  );
  if (!completion) return failed('degraded', 'completion-record-invalid', prepared, null, shadow);
  const write = writeRecord(completion);
  if (write !== 'recorded' && write !== 'replayed') {
    return failed(
      write === 'conflicted' ? 'refused' : 'degraded',
      `completion-record-${write}`,
      prepared,
      completion,
      shadow,
    );
  }
  return applied(
    'signed-cas-decision-applied',
    prepared,
    completion,
    shadow,
    localMutationApplied,
  );
}
