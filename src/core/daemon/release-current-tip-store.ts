/**
 * Immutable, host-local release-tip observations.
 *
 * This ledger gives cooperative processes one no-clobber sequence slot. It is
 * not a transparency log, a same-user security boundary, or release authority.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';

import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
} from '../foundry/provenance.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';

const PROTOCOL = 'release-tip-settlement-v1' as const;
const GENESIS_DIGEST = '0'.repeat(64);
const SHA256_RE = /^[a-f0-9]{64}$/;
const RECORD_FILE_RE = /^([0-9]{12})\.json$/;
const MAX_SEQUENCE = 4_096;
const MAX_RECORD_BYTES = 8 * 1_024;
const DEFAULT_MAX_BYTES = 8 * 1_024 * 1_024;
const HARD_MAX_BYTES = 32 * 1_024 * 1_024;
const PROVENANCE_KEY_GENERATION = 1;
const MAX_LOCK_WAIT_MS = 2_000;

const INPUT_KEYS = [
  'releaseScopeDigest',
  'sequence',
  'predecessorDigest',
  'releaseDigest',
  'reportedAt',
] as const;

const RECORD_KEYS = [
  'schemaVersion',
  'protocol',
  'authority',
  'casSemantics',
  'timeEvidence',
  'sameUserTamperResistant',
  'transparencyAuthority',
  'rollbackProtected',
  'currentTipAuthority',
  'continuityAuthority',
  'durableCompareAndSwapVerified',
  'bootstrapContinuityVerified',
  'releaseAuthority',
  'mergePermitted',
  'deployPermitted',
  'installPermitted',
  'startPermitted',
  'activationPermitted',
  'rollbackPermitted',
  'releaseScopeDigest',
  'provenanceKeyId',
  'provenanceKeyGeneration',
  'sequence',
  'predecessorDigest',
  'releaseDigest',
  'reportedAt',
  'settlementDigest',
  'attestation',
] as const;

export const RELEASE_TIP_GENESIS_DIGEST = GENESIS_DIGEST;

export interface ReleaseTipSettlementInput {
  releaseScopeDigest: string;
  sequence: number;
  predecessorDigest: string;
  releaseDigest: string;
  /** Caller-reported metadata only. It is not a trusted freshness source. */
  reportedAt: string;
}

export interface ReleaseTipSettlementV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  casSemantics: 'host-local-cooperative-no-clobber';
  timeEvidence: 'caller-reported-untrusted';
  sameUserTamperResistant: false;
  transparencyAuthority: false;
  rollbackProtected: false;
  currentTipAuthority: false;
  continuityAuthority: false;
  durableCompareAndSwapVerified: false;
  bootstrapContinuityVerified: false;
  releaseAuthority: false;
  mergePermitted: false;
  deployPermitted: false;
  installPermitted: false;
  startPermitted: false;
  activationPermitted: false;
  rollbackPermitted: false;
  releaseScopeDigest: string;
  provenanceKeyId: string;
  provenanceKeyGeneration: number;
  sequence: number;
  predecessorDigest: string;
  releaseDigest: string;
  reportedAt: string;
  settlementDigest: string;
  attestation: string;
}

export type ReleaseTipChainStopReason =
  | ImmutablePrivateRecordReadStopReason
  | 'platform-unsupported'
  | 'bootstrap-required'
  | 'duplicate-sequence'
  | 'out-of-order-sequence'
  | 'sequence-gap'
  | 'broken-predecessor';

interface ReleaseTipAuthorityFields {
  authority: 'observation-only';
  sameUserTamperResistant: false;
  transparencyAuthority: false;
  rollbackProtected: false;
  currentTipAuthority: false;
  continuityAuthority: false;
  durableCompareAndSwapVerified: false;
  bootstrapContinuityVerified: false;
  releaseAuthority: false;
  mergePermitted: false;
  deployPermitted: false;
  installPermitted: false;
  startPermitted: false;
  activationPermitted: false;
  rollbackPermitted: false;
}

export interface ReleaseTipSettlementReadResult extends ReleaseTipAuthorityFields {
  settlements: ReleaseTipSettlementV1[];
  currentTip: ReleaseTipSettlementV1 | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  availability: 'available' | 'unavailable';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: ReleaseTipChainStopReason[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
}

export type ReleaseTipSettlementDisposition =
  | 'recorded'
  | 'replayed'
  | 'conflicted'
  | 'rejected'
  | 'invalid'
  | 'unavailable'
  | 'failed';

export type ReleaseTipSettlementReason =
  | 'recorded'
  | 'bootstrapped'
  | 'bootstrap-required'
  | 'exact-replay'
  | 'sequence-conflict'
  | 'non-contiguous-sequence'
  | 'predecessor-mismatch'
  | 'capacity-exhausted'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'chain-unavailable'
  | 'key-unavailable'
  | 'recovery-failed'
  | 'publication-failed'
  | 'post-write-unavailable';

export interface ReleaseTipSettlementResult extends ReleaseTipAuthorityFields {
  disposition: ReleaseTipSettlementDisposition;
  reason: ReleaseTipSettlementReason;
  candidate: ReleaseTipSettlementV1 | null;
  currentTip: ReleaseTipSettlementV1 | null;
  sourceState: ReleaseTipSettlementReadResult['sourceState'];
  availability: ReleaseTipSettlementReadResult['availability'];
}

export interface ReleaseTipSettlementOperationOptions {
  lockWaitMs?: number;
  /** Test/bounded-operation seam. It may only lower the production limit. */
  maxSequence?: number;
}

const AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  sameUserTamperResistant: false as const,
  transparencyAuthority: false as const,
  rollbackProtected: false as const,
  currentTipAuthority: false as const,
  continuityAuthority: false as const,
  durableCompareAndSwapVerified: false as const,
  bootstrapContinuityVerified: false as const,
  releaseAuthority: false as const,
  mergePermitted: false as const,
  deployPermitted: false as const,
  installPermitted: false as const,
  startPermitted: false as const,
  activationPermitted: false as const,
  rollbackPermitted: false as const,
});

function plainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_SEQUENCE;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function canonicalInput(value: unknown): ReleaseTipSettlementInput | null {
  try {
    if (!plainObject(value) || !exactKeys(value, INPUT_KEYS)) return null;
    const releaseScopeDigest = value['releaseScopeDigest'];
    const sequence = value['sequence'];
    const predecessorDigest = value['predecessorDigest'];
    const releaseDigest = value['releaseDigest'];
    const reportedAt = value['reportedAt'];
    if (!validDigest(releaseScopeDigest) || !validSequence(sequence) ||
      !validDigest(predecessorDigest) || !validDigest(releaseDigest) ||
      !canonicalTimestamp(reportedAt)) return null;
    return { releaseScopeDigest, sequence, predecessorDigest, releaseDigest, reportedAt };
  } catch {
    return null;
  }
}

function shaTuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

function hmacTuple(key: Buffer, domain: string, values: readonly unknown[]): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function provenanceKeyId(key: Buffer): string {
  return hmacTuple(key, 'ashlr:release-tip-settlement:provenance-key-id:v1', [
    PROVENANCE_KEY_GENERATION,
  ]);
}

function settlementPayload(
  input: ReleaseTipSettlementInput,
  keyId: string,
): readonly unknown[] {
  return [
    1,
    PROTOCOL,
    'observation-only',
    'host-local-cooperative-no-clobber',
    'caller-reported-untrusted',
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    input.releaseScopeDigest,
    keyId,
    PROVENANCE_KEY_GENERATION,
    input.sequence,
    input.predecessorDigest,
    input.releaseDigest,
    input.reportedAt,
  ];
}

function buildSettlement(
  input: ReleaseTipSettlementInput,
  key: Buffer,
): ReleaseTipSettlementV1 | null {
  const canonical = canonicalInput(input);
  if (canonical === null || key.length !== 32) return null;
  const keyId = provenanceKeyId(key);
  const settlementDigest = shaTuple(
    'ashlr:release-tip-settlement:digest:v1',
    settlementPayload(canonical, keyId),
  );
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    casSemantics: 'host-local-cooperative-no-clobber',
    timeEvidence: 'caller-reported-untrusted',
    ...AUTHORITY,
    ...canonical,
    provenanceKeyId: keyId,
    provenanceKeyGeneration: PROVENANCE_KEY_GENERATION,
    settlementDigest,
    attestation: hmacTuple(key, 'ashlr:release-tip-settlement:attestation:v1', [
      settlementDigest,
    ]),
  };
}

function verifyWithKey(
  value: unknown,
  key: Buffer,
  expectedScopeDigest?: string,
): ReleaseTipSettlementV1 | null {
  try {
    if (!plainObject(value) || !exactKeys(value, RECORD_KEYS) || key.length !== 32) return null;
    if (
      value['schemaVersion'] !== 1 ||
      value['protocol'] !== PROTOCOL ||
      value['authority'] !== 'observation-only' ||
      value['casSemantics'] !== 'host-local-cooperative-no-clobber' ||
      value['timeEvidence'] !== 'caller-reported-untrusted' ||
      value['sameUserTamperResistant'] !== false ||
      value['transparencyAuthority'] !== false ||
      value['rollbackProtected'] !== false ||
      value['currentTipAuthority'] !== false ||
      value['continuityAuthority'] !== false ||
      value['durableCompareAndSwapVerified'] !== false ||
      value['bootstrapContinuityVerified'] !== false ||
      value['releaseAuthority'] !== false ||
      value['mergePermitted'] !== false ||
      value['deployPermitted'] !== false ||
      value['installPermitted'] !== false ||
      value['startPermitted'] !== false ||
      value['activationPermitted'] !== false ||
      value['rollbackPermitted'] !== false ||
      value['provenanceKeyGeneration'] !== PROVENANCE_KEY_GENERATION ||
      value['provenanceKeyId'] !== provenanceKeyId(key)
    ) return null;
    const input = canonicalInput({
      releaseScopeDigest: value['releaseScopeDigest'],
      sequence: value['sequence'],
      predecessorDigest: value['predecessorDigest'],
      releaseDigest: value['releaseDigest'],
      reportedAt: value['reportedAt'],
    });
    if (input === null ||
      (expectedScopeDigest !== undefined && input.releaseScopeDigest !== expectedScopeDigest) ||
      !validDigest(value['settlementDigest']) || !validDigest(value['attestation'])) return null;
    const expected = buildSettlement(input, key);
    if (!expected ||
      !sameDigest(value['settlementDigest'], expected.settlementDigest) ||
      !sameDigest(value['attestation'], expected.attestation)) return null;
    return expected;
  } catch {
    return null;
  }
}

function existingWriteKey(): Buffer | null {
  try {
    const key = loadExistingProvenanceKey();
    return key?.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function existingReadKey(): Buffer | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key?.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function createReleaseTipSettlement(
  input: ReleaseTipSettlementInput,
): ReleaseTipSettlementV1 | null {
  try {
    const key = existingWriteKey();
    return key === null ? null : buildSettlement(input, key);
  } catch {
    return null;
  }
}

export function verifyReleaseTipSettlement(value: unknown): ReleaseTipSettlementV1 | null {
  try {
    const key = existingReadKey();
    return key === null ? null : verifyWithKey(value, key);
  } catch {
    return null;
  }
}

function homePath(): string | null {
  try {
    const home = homedir();
    if (!isAbsolute(home)) return null;
    const canonical = resolve(home);
    return canonical === parse(canonical).root ? null : canonical;
  } catch {
    return null;
  }
}

export function releaseTipSettlementRootPath(releaseScopeDigest: string): string {
  if (!validDigest(releaseScopeDigest)) {
    throw new Error('release tip settlement scope is invalid');
  }
  const home = homePath();
  if (home === null) throw new Error('release tip settlement home is unavailable');
  return join(home, '.ashlr', `release-tip-settlements-v1-${releaseScopeDigest}`);
}

function sequenceToken(sequence: number): string {
  return String(sequence).padStart(12, '0');
}

function codec(
  key: Buffer,
  releaseScopeDigest: string,
): ImmutablePrivateRecordCodec<ReleaseTipSettlementV1> {
  return {
    parse: (value) => verifyWithKey(value, key, releaseScopeDigest),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => sequenceToken(record.sequence),
    recordFileName: (record) => `${sequenceToken(record.sequence)}.json`,
    isRecordFileName: (fileName) => {
      const match = RECORD_FILE_RE.exec(fileName);
      if (!match) return false;
      const sequence = Number(match[1]);
      return validSequence(sequence) && sequenceToken(sequence) === match[1];
    },
    stageToken: (record) => hmacTuple(
      key,
      'ashlr:release-tip-settlement:publication-stage:v1',
      [releaseScopeDigest, record.sequence, record.settlementDigest],
    ).slice(0, 32),
    equivalent: (left, right) =>
      left.releaseScopeDigest === right.releaseScopeDigest &&
      left.provenanceKeyGeneration === right.provenanceKeyGeneration &&
      sameDigest(left.provenanceKeyId, right.provenanceKeyId) &&
      left.sequence === right.sequence &&
      sameDigest(left.settlementDigest, right.settlementDigest) &&
      sameDigest(left.attestation, right.attestation),
    compare: (left, right) => left.sequence - right.sequence,
  };
}

function storeConfig(
  releaseScopeDigest: string,
): ImmutablePrivateRecordStoreConfig<ReleaseTipSettlementV1> | null {
  const home = homePath();
  if (home === null || !validDigest(releaseScopeDigest)) return null;
  const anchorPath = join(home, '.ashlr');
  const rootPath = join(anchorPath, `release-tip-settlements-v1-${releaseScopeDigest}`);
  return {
    label: 'release tip settlement',
    anchorPath,
    rootPath,
    lockFileName: '.release-tip-settlement.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: MAX_SEQUENCE,
    hardMaxFiles: MAX_SEQUENCE,
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    hardMaxBytes: HARD_MAX_BYTES,
    codecForWrite: () => {
      const key = existingWriteKey();
      return key === null ? null : codec(key, releaseScopeDigest);
    },
    codecForRead: () => {
      const key = existingReadKey();
      return key === null ? null : codec(key, releaseScopeDigest);
    },
  };
}

function unavailableRead(
  stopReasons: ReleaseTipChainStopReason[],
  sourceState: ReleaseTipSettlementReadResult['sourceState'] = 'degraded',
): ReleaseTipSettlementReadResult {
  return {
    settlements: [],
    currentTip: null,
    sourceState,
    availability: 'unavailable',
    sourcePresent: sourceState !== 'missing',
    complete: false,
    stopReasons,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...AUTHORITY,
  };
}

function validReadOptions(value: unknown): value is ImmutablePrivateRecordReadOptions {
  try {
    if (value === undefined) return true;
    if (!plainObject(value)) return false;
    const keys = Object.keys(value);
    if (keys.some((key) => !['maxFiles', 'maxBytes', 'requireComplete'].includes(key))) return false;
    return (value['maxFiles'] === undefined || Number.isFinite(value['maxFiles'])) &&
      (value['maxBytes'] === undefined || Number.isFinite(value['maxBytes'])) &&
      (value['requireComplete'] === undefined || typeof value['requireComplete'] === 'boolean');
  } catch {
    return false;
  }
}

export function readReleaseTipSettlements(
  releaseScopeDigest: string,
  options: ImmutablePrivateRecordReadOptions = {},
): ReleaseTipSettlementReadResult {
  try {
    // Windows directory namespace durability is not established by private
    // DACL checks. Refuse before deriving or touching any store path.
    if (process.platform === 'win32') return unavailableRead(['platform-unsupported']);
    if (!validDigest(releaseScopeDigest) || !validReadOptions(options)) {
      return unavailableRead(['invalid-options']);
    }
    const config = storeConfig(releaseScopeDigest);
    if (config === null) return unavailableRead(['invalid-options']);
    const raw = readImmutablePrivateRecords(config, { ...options, requireComplete: false });
    if (raw.sourceState === 'missing' && !raw.sourcePresent) {
      return unavailableRead(['bootstrap-required'], 'missing');
    }
    const stopReasons = new Set<ReleaseTipChainStopReason>(raw.stopReasons);
    let expectedSequence = 1;
    let expectedPredecessor = GENESIS_DIGEST;
    let previousSequence = 0;
    const seen = new Set<number>();
    for (const settlement of raw.records) {
      if (settlement.releaseScopeDigest !== releaseScopeDigest) stopReasons.add('invalid-file');
      if (settlement.provenanceKeyGeneration !== PROVENANCE_KEY_GENERATION) {
        stopReasons.add('invalid-file');
      }
      if (seen.has(settlement.sequence)) stopReasons.add('duplicate-sequence');
      if (settlement.sequence <= previousSequence) stopReasons.add('out-of-order-sequence');
      if (settlement.sequence !== expectedSequence) stopReasons.add('sequence-gap');
      if (!sameDigest(settlement.predecessorDigest, expectedPredecessor)) {
        stopReasons.add('broken-predecessor');
      }
      seen.add(settlement.sequence);
      previousSequence = settlement.sequence;
      expectedSequence = settlement.sequence + 1;
      expectedPredecessor = settlement.settlementDigest;
    }
    if (raw.records.length === 0 && stopReasons.size === 0) stopReasons.add('bootstrap-required');
    const degraded = raw.sourceState === 'degraded' || !raw.complete || stopReasons.size > 0;
    const complete = !degraded;
    const settlements = options.requireComplete === true && !complete ? [] : raw.records;
    return {
      settlements,
      currentTip: complete ? raw.records.at(-1) ?? null : null,
      sourceState: degraded ? 'degraded' : raw.sourceState,
      availability: complete ? 'available' : 'unavailable',
      sourcePresent: raw.sourcePresent,
      complete,
      stopReasons: [...stopReasons],
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
      ...AUTHORITY,
    };
  } catch {
    return unavailableRead(['io-error']);
  }
}

function result(
  disposition: ReleaseTipSettlementDisposition,
  reason: ReleaseTipSettlementReason,
  candidate: ReleaseTipSettlementV1 | null,
  chain: Pick<ReleaseTipSettlementReadResult, 'currentTip' | 'sourceState' | 'availability'>,
): ReleaseTipSettlementResult {
  return { disposition, reason, candidate, ...chain, ...AUTHORITY };
}

function invalidResult(
  disposition: 'invalid' | 'unavailable',
  reason: 'invalid-input' | 'key-unavailable',
): ReleaseTipSettlementResult {
  return result(disposition, reason, null, {
    currentTip: null,
    sourceState: 'degraded',
    availability: 'unavailable',
  });
}

function canonicalOperationOptions(
  value: unknown,
): { lockWaitMs: number; maxSequence: number } | null {
  try {
    if (!plainObject(value) || !exactKeysSubset(value, ['lockWaitMs', 'maxSequence'])) return null;
    const lockWaitMs = value['lockWaitMs'] === undefined
      ? MAX_LOCK_WAIT_MS
      : Number.isFinite(value['lockWaitMs'])
        ? Math.max(0, Math.min(MAX_LOCK_WAIT_MS, Math.floor(Number(value['lockWaitMs']))))
        : null;
    const maxSequence = value['maxSequence'] === undefined
      ? MAX_SEQUENCE
      : Number.isSafeInteger(value['maxSequence']) && Number(value['maxSequence']) >= 1 &&
          Number(value['maxSequence']) <= MAX_SEQUENCE
        ? Number(value['maxSequence'])
        : null;
    return lockWaitMs === null || maxSequence === null ? null : { lockWaitMs, maxSequence };
  } catch {
    return null;
  }
}

function exactKeysSubset(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key) => allowed.includes(key));
  } catch {
    return false;
  }
}

function transactionLockPath(anchorPath: string, releaseScopeDigest: string): string {
  return join(anchorPath, `.release-current-tip-${releaseScopeDigest}.transaction.lock`);
}

function withTransaction(
  candidate: ReleaseTipSettlementV1,
  options: { lockWaitMs: number; maxSequence: number },
  operation: (
    config: ImmutablePrivateRecordStoreConfig<ReleaseTipSettlementV1>,
  ) => ReleaseTipSettlementResult,
): ReleaseTipSettlementResult {
  const config = storeConfig(candidate.releaseScopeDigest);
  if (config === null || !existsSync(config.anchorPath)) {
    return result('unavailable', 'chain-unavailable', candidate, {
      currentTip: null,
      sourceState: 'degraded',
      availability: 'unavailable',
    });
  }
  const transactionLock = acquireLocalStoreLock(
    transactionLockPath(config.anchorPath, candidate.releaseScopeDigest),
    options.lockWaitMs,
    { anchorPath: config.anchorPath, exactPrivateStorage: true },
  );
  if (transactionLock === null) {
    return result('failed', 'publication-failed', candidate, {
      currentTip: null,
      sourceState: 'degraded',
      availability: 'unavailable',
    });
  }
  try {
    return operation(config);
  } catch {
    return result('failed', 'publication-failed', candidate, {
      currentTip: null,
      sourceState: 'degraded',
      availability: 'unavailable',
    });
  } finally {
    releaseLocalStoreLock(transactionLock);
  }
}

function recoverBeforeRead(
  config: ImmutablePrivateRecordStoreConfig<ReleaseTipSettlementV1>,
  lockWaitMs: number,
): 'clean' | 'recovered' | 'missing' | 'failed' {
  const recovery = recoverImmutablePrivateRecordStore(config, { lockWaitMs });
  return recovery === 'clean' || recovery === 'recovered' || recovery === 'missing'
    ? recovery
    : 'failed';
}

export function bootstrapReleaseTipSettlement(
  input: ReleaseTipSettlementInput,
  rawOptions: ReleaseTipSettlementOperationOptions = {},
): ReleaseTipSettlementResult {
  try {
    if (process.platform === 'win32') {
      return result('unavailable', 'platform-unsupported', null, {
        currentTip: null,
        sourceState: 'degraded',
        availability: 'unavailable',
      });
    }
    const options = canonicalOperationOptions(rawOptions);
    const candidate = createReleaseTipSettlement(input);
    if (options === null) return invalidResult('invalid', 'invalid-input');
    if (candidate === null) {
      return existingWriteKey() === null
        ? invalidResult('unavailable', 'key-unavailable')
        : invalidResult('invalid', 'invalid-input');
    }
    if (candidate.sequence !== 1 || candidate.predecessorDigest !== GENESIS_DIGEST) {
      return result('rejected', 'bootstrap-required', candidate, {
        currentTip: null,
        sourceState: 'degraded',
        availability: 'unavailable',
      });
    }
    return withTransaction(candidate, options, (config) => {
      if (recoverBeforeRead(config, options.lockWaitMs) === 'failed') {
        return result('failed', 'recovery-failed', candidate, unavailableRead(['io-error']));
      }
      const before = readReleaseTipSettlements(candidate.releaseScopeDigest, {
        requireComplete: true,
      });
      if (before.sourcePresent && before.currentTip !== null) {
        const first = before.settlements[0];
        const exact = first !== undefined &&
          sameDigest(first.settlementDigest, candidate.settlementDigest) &&
          sameDigest(first.attestation, candidate.attestation);
        return result(
          exact ? 'replayed' : 'conflicted',
          exact ? 'exact-replay' : 'sequence-conflict',
          candidate,
          before,
        );
      }
      if (before.sourcePresent && before.stopReasons.some((reason) => reason !== 'bootstrap-required')) {
        return result('unavailable', 'chain-unavailable', candidate, before);
      }
      const written = writeImmutablePrivateRecord(config, candidate, {
        lockWaitMs: options.lockWaitMs,
      });
      if (written === 'conflicted') {
        const afterConflict = readReleaseTipSettlements(candidate.releaseScopeDigest, {
          requireComplete: true,
        });
        return result('conflicted', 'sequence-conflict', candidate, afterConflict);
      }
      if (written === 'invalid') return result('invalid', 'invalid-input', candidate, before);
      if (written === 'failed') return result('failed', 'publication-failed', candidate, before);
      const after = readReleaseTipSettlements(candidate.releaseScopeDigest, {
        requireComplete: true,
      });
      if (after.availability !== 'available' || after.currentTip === null ||
        !sameDigest(after.currentTip.settlementDigest, candidate.settlementDigest)) {
        return result('unavailable', 'post-write-unavailable', candidate, after);
      }
      return result(
        written === 'replayed' ? 'replayed' : 'recorded',
        written === 'replayed' ? 'exact-replay' : 'bootstrapped',
        candidate,
        after,
      );
    });
  } catch {
    return invalidResult('invalid', 'invalid-input');
  }
}

export function recordReleaseTipSettlement(
  input: ReleaseTipSettlementInput,
  rawOptions: ReleaseTipSettlementOperationOptions = {},
): ReleaseTipSettlementResult {
  try {
    if (process.platform === 'win32') {
      return result('unavailable', 'platform-unsupported', null, {
        currentTip: null,
        sourceState: 'degraded',
        availability: 'unavailable',
      });
    }
    const options = canonicalOperationOptions(rawOptions);
    const candidate = createReleaseTipSettlement(input);
    if (options === null) return invalidResult('invalid', 'invalid-input');
    if (candidate === null) {
      return existingWriteKey() === null
        ? invalidResult('unavailable', 'key-unavailable')
        : invalidResult('invalid', 'invalid-input');
    }
    if (candidate.sequence > options.maxSequence) {
      return result('rejected', 'capacity-exhausted', candidate, {
        currentTip: null,
        sourceState: 'degraded',
        availability: 'unavailable',
      });
    }
    return withTransaction(candidate, options, (config) => {
      const recovery = recoverBeforeRead(config, options.lockWaitMs);
      if (recovery === 'failed') {
        return result('failed', 'recovery-failed', candidate, unavailableRead(['io-error']));
      }
      if (recovery === 'missing') {
        return result('rejected', 'bootstrap-required', candidate, unavailableRead(
          ['bootstrap-required'],
          'missing',
        ));
      }
      const before = readReleaseTipSettlements(candidate.releaseScopeDigest, {
        requireComplete: true,
      });
      if (before.availability !== 'available' || before.currentTip === null) {
        const reason = before.stopReasons.length === 1 &&
          before.stopReasons[0] === 'bootstrap-required'
          ? 'bootstrap-required'
          : 'chain-unavailable';
        return result(reason === 'bootstrap-required' ? 'rejected' : 'unavailable', reason, candidate, before);
      }
      const currentSequence = before.currentTip.sequence;
      if (candidate.sequence <= currentSequence) {
        const historical = before.settlements.find(
          (settlement) => settlement.sequence === candidate.sequence,
        );
        const exact = historical !== undefined &&
          sameDigest(historical.settlementDigest, candidate.settlementDigest) &&
          sameDigest(historical.attestation, candidate.attestation);
        return result(
          exact ? 'replayed' : 'conflicted',
          exact ? 'exact-replay' : 'sequence-conflict',
          candidate,
          before,
        );
      }
      if (currentSequence >= options.maxSequence || candidate.sequence > options.maxSequence) {
        return result('rejected', 'capacity-exhausted', candidate, before);
      }
      if (candidate.sequence !== currentSequence + 1) {
        return result('rejected', 'non-contiguous-sequence', candidate, before);
      }
      if (!sameDigest(candidate.predecessorDigest, before.currentTip.settlementDigest)) {
        return result('rejected', 'predecessor-mismatch', candidate, before);
      }
      const written = writeImmutablePrivateRecord(config, candidate, {
        lockWaitMs: options.lockWaitMs,
      });
      if (written === 'conflicted') {
        const afterConflict = readReleaseTipSettlements(candidate.releaseScopeDigest, {
          requireComplete: true,
        });
        return result('conflicted', 'sequence-conflict', candidate, afterConflict);
      }
      if (written === 'invalid') return result('invalid', 'invalid-input', candidate, before);
      if (written === 'failed') return result('failed', 'publication-failed', candidate, before);
      const after = readReleaseTipSettlements(candidate.releaseScopeDigest, {
        requireComplete: true,
      });
      if (after.availability !== 'available' || after.currentTip === null ||
        !sameDigest(after.currentTip.settlementDigest, candidate.settlementDigest)) {
        return result('unavailable', 'post-write-unavailable', candidate, after);
      }
      return result(
        written === 'replayed' ? 'replayed' : 'recorded',
        written === 'replayed' ? 'exact-replay' : 'recorded',
        candidate,
        after,
      );
    });
  } catch {
    return invalidResult('invalid', 'invalid-input');
  }
}
