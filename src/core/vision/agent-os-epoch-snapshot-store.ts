/**
 * Durable epoch-scoped persistence for Agent OS Snapshot V2 records (M560).
 *
 * Callers supply only observation material and already-held transaction
 * capabilities. Epoch lineage is derived from an injected authenticated active
 * context and the complete durable chain. This module does not choose anchors,
 * load keys, mutate pointers, or grant runtime/effect authority.
 */

import { timingSafeEqual } from 'node:crypto';
import { lstatSync, opendirSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import { ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  initializeImmutablePrivateRecordStoreLayout,
  readImmutablePrivateRecordPoint,
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  ownsAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from './agent-os-epoch-coordination.js';
import {
  AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1,
  agentOsEpochSnapshotBindingDigestV1,
  agentOsEpochSnapshotBindingSetDigestV1,
  type AgentOsEpochAttemptRuntimeCommitGuardV1,
  type AgentOsEpochSnapshotBindingBatchRequestV1,
  type AgentOsEpochSnapshotBindingBatchResultV1,
  type AgentOsEpochSnapshotV2BindingVerificationInputV1,
  type AgentOsEpochSnapshotV2ExistenceVerifierV1,
} from './agent-os-epoch-attempt-store.js';
import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  agentOsEpochAttemptIdV1,
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
} from './agent-os-epoch-records.js';
import {
  canonicalAgentOsEpochSnapshotEnvelopeBytesV2,
  createAgentOsEpochSnapshotEnvelopeV2,
  parseAgentOsEpochSnapshotEnvelopeV2,
  verifyAgentOsEpochSnapshotEnvelopeV2,
  type AgentOsEpochSnapshotClosureContextV2,
  type AgentOsEpochSnapshotEnvelopeV2,
  type AgentOsEpochSnapshotSignerV2,
  type AgentOsEpochSnapshotVerifierV2,
} from './agent-os-epoch-snapshot-record.js';
import { isAgentOsEpochStorePlatformSupportedV1 } from './agent-os-epoch-store.js';
import type { AgentOsReadModelV1 } from './agent-os-read-model.js';

export const AGENT_OS_EPOCH_SNAPSHOT_STORE_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-snapshot-store-v1' as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const STORE_LOCK = '.agent-os-epoch-snapshot-v2.lock';
const RECORD_FILE_RE = /^(\d{12})\.json$/u;
const MAX_EPOCH = 999_999_999_999;
const MAX_SEQUENCE = 4_096;
const MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = MAX_SEQUENCE;
const HARD_MAX_RECORDS = MAX_SEQUENCE;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const HARD_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2_000;

export interface AgentOsAuthenticatedActiveEpochSnapshotClosureV1 {
  epoch: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  snapshotBasePreviousEnvelopeDigest: string;
  writerProtocolDigest: string;
  /** Epoch-manifest-fixed identity; source renewal must not rotate this signer. */
  expectedProducerIdentityDigest: string;
  expectedAuthenticatorKeyId: string;
  expectedAuthenticatorKeyGeneration: number;
}

export type AgentOsAuthenticatedActiveEpochSnapshotClosureReadV1 =
  | { state: 'authenticated'; closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1 }
  | { state: 'missing' | 'uncommissioned' | 'unavailable' | 'degraded' };

/** Selected only by the trusted composition root; never supplied by a write caller. */
export interface AgentOsAuthenticatedActiveEpochSnapshotClosureProviderV1 {
  readAuthenticatedClosure(): AgentOsAuthenticatedActiveEpochSnapshotClosureReadV1;
}

export interface AgentOsEpochSnapshotHistoricalContextQueryV1 {
  epoch: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  producerIdentityDigest: string;
  authenticatorKeyId: string;
  authenticatorKeyGeneration: number;
}

export interface AgentOsAuthenticatedHistoricalEpochSnapshotContextV1
  extends AgentOsEpochSnapshotHistoricalContextQueryV1 {
  snapshotBasePreviousEnvelopeDigest: string;
}

export type AgentOsAuthenticatedHistoricalEpochSnapshotContextReadV1 =
  | {
      state: 'authenticated';
      context: AgentOsAuthenticatedHistoricalEpochSnapshotContextV1;
      verifier: AgentOsEpochSnapshotVerifierV2;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

/** Authenticates the exact historical manifest/source/policy/key lineage of one record. */
export interface AgentOsEpochSnapshotHistoricalContextProviderV1 {
  readAuthenticatedHistoricalContext(
    query: Readonly<AgentOsEpochSnapshotHistoricalContextQueryV1>,
  ): AgentOsAuthenticatedHistoricalEpochSnapshotContextReadV1;
}

export interface AgentOsEpochSnapshotStartReceiptQueryV1 {
  epoch: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  producerAttemptId: string;
  durableTickDigest: string;
}

export type AgentOsAuthenticatedEpochSnapshotStartReceiptReadV1 =
  | {
      state: 'authenticated';
      startReceiptDigest: string;
      sourceBundleDigest: string;
      trustPolicyDigest: string;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

/** Authenticates reciprocal existence of one exact M557 start receipt. */
export interface AgentOsEpochSnapshotStartReceiptProviderV1 {
  readAuthenticatedStartReceipt(
    query: Readonly<AgentOsEpochSnapshotStartReceiptQueryV1>,
  ): AgentOsAuthenticatedEpochSnapshotStartReceiptReadV1;
}

export interface AgentOsEpochSnapshotStoreDependenciesV1 {
  /** Existing trusted directory that directly contains epochStoreRootPath. */
  anchorPath: string;
  /** Exact M553 root ending in `agent-os-epochs`. */
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  activeClosureProvider: AgentOsAuthenticatedActiveEpochSnapshotClosureProviderV1;
  historicalContextProvider: AgentOsEpochSnapshotHistoricalContextProviderV1;
  startReceiptProvider: AgentOsEpochSnapshotStartReceiptProviderV1;
  signer: AgentOsEpochSnapshotSignerV2 | null;
  verifier: AgentOsEpochSnapshotVerifierV2 | null;
  runtimeCommitGuard?: AgentOsEpochAttemptRuntimeCommitGuardV1;
  maxRecords?: number;
}

/** Deliberately excludes every epoch, anchor, source, predecessor, and sequence claim. */
export interface WriteAgentOsEpochSnapshotV2Input {
  durableTickDigest: string;
  renderedAt: string;
  observedAt: string;
  kernelCycleDigest: string;
  capabilityProjectionDigest: string;
  portfolioDigest: string;
  snapshot: AgentOsReadModelV1;
  snapshotDigest: string;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export type AgentOsEpochSnapshotStoreWriteReasonV1 =
  | 'recorded'
  | 'snapshot-replay'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'closure-unavailable'
  | 'closure-changed'
  | 'coordination-lease-missing'
  | 'observation-lock-missing'
  | 'signer-unavailable'
  | 'verifier-unavailable'
  | 'start-receipt-unavailable'
  | 'chain-unavailable'
  | 'capacity-exhausted'
  | 'reentrant-operation'
  | 'runtime-commit-withheld'
  | 'publication-conflict'
  | 'publication-failed';

export interface AgentOsEpochSnapshotStoreAuthorityV1 {
  authority: 'observation-only';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  anchorMutationAuthority: false;
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  proposalAuthority: false;
  learningAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
  externalMutationAuthority: false;
  rollbackProtected: false;
  sameUserTamperResistant: false;
}

export interface AgentOsEpochSnapshotStoreWriteResultV1
  extends AgentOsEpochSnapshotStoreAuthorityV1 {
  disposition: 'recorded' | 'replayed' | 'conflicted' | 'withheld' | 'unavailable' | 'failed';
  reason: AgentOsEpochSnapshotStoreWriteReasonV1;
  envelope: Readonly<AgentOsEpochSnapshotEnvelopeV2> | null;
  epoch: number | null;
  sequence: number | null;
  closureAuthenticated: boolean;
  durable: boolean;
}

export type AgentOsEpochSnapshotStoreStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'platform-unsupported'
  | 'closure-unavailable'
  | 'closure-changed'
  | 'verifier-unavailable'
  | 'historical-context-unavailable'
  | 'start-receipt-unavailable'
  | 'snapshot-root-missing'
  | 'sequence-gap'
  | 'sequence-fork'
  | 'predecessor-mismatch'
  | 'signer-identity-drift'
  | 'capacity-exhausted'
  | 'reentrant-operation';

export interface AgentOsEpochSnapshotStoreReadResultV1
  extends AgentOsEpochSnapshotStoreAuthorityV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  records: ReadonlyArray<Readonly<AgentOsEpochSnapshotEnvelopeV2>>;
  current: Readonly<AgentOsEpochSnapshotEnvelopeV2> | null;
  epoch: number | null;
  anchoredHeadDigest: string | null;
  epochManifestDigest: string | null;
  stopReasons: AgentOsEpochSnapshotStoreStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
  capacityExhausted: boolean;
  closureAuthenticated: boolean;
}

interface PinnedDependencies extends AgentOsEpochSnapshotStoreDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  maxRecords: number;
}

interface OperationToken { reentered: boolean; runtimeGuardRejected: boolean }

const activeOperations = new Map<string, OperationToken>();
const AUTHORITY: Readonly<AgentOsEpochSnapshotStoreAuthorityV1> = Object.freeze({
  ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  writesAuthorized: false,
  pointerMutationAuthorized: false,
  anchorMutationAuthority: false,
});

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      descriptors[String(key)]?.enumerable !== true ||
      !Object.hasOwn(descriptors[String(key)]!, 'value'))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalComparable(value: unknown, depth = 0): string | null {
  if (depth > 32) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && !Object.is(value, -0) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
      (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) return null;
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      const item = canonicalComparable(value[index], depth + 1);
      if (item === null) return null;
      items.push(item);
    }
    return `[${items.join(',')}]`;
  }
  const row = record(value);
  if (!row) return null;
  const entries: string[] = [];
  for (const key of Object.keys(row).sort()) {
    const item = canonicalComparable(row[key], depth + 1);
    if (item === null) return null;
    entries.push(`${JSON.stringify(key)}:${item}`);
  }
  const canonical = `{${entries.join(',')}}`;
  return Buffer.byteLength(canonical, 'utf8') <= MAX_RECORD_BYTES ? canonical : null;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameDigest(left: string, right: string): boolean {
  return exactBytes(Buffer.from(left), Buffer.from(right));
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_EPOCH;
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function privateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE));
}

function epochToken(epoch: number): string {
  return String(epoch).padStart(12, '0');
}

function sequenceToken(sequence: number): string {
  return String(sequence).padStart(12, '0');
}

function beginOperation(key: string): OperationToken | null {
  const current = activeOperations.get(key);
  if (current) {
    current.reentered = true;
    return null;
  }
  const token = { reentered: false, runtimeGuardRejected: false };
  activeOperations.set(key, token);
  return token;
}

function endOperation(key: string, token: OperationToken): void {
  if (activeOperations.get(key) === token) activeOperations.delete(key);
}

function runtimeCommitAllowed(
  dependencies: PinnedDependencies,
  token: OperationToken,
): boolean {
  if (token.reentered) return false;
  try {
    const allowed = dependencies.runtimeCommitGuard?.isCommitAuthorized() !== false;
    if (!allowed) token.runtimeGuardRejected = true;
    return allowed;
  } catch {
    token.runtimeGuardRejected = true;
    return false;
  }
}

function commitFenceReason(token: OperationToken): AgentOsEpochSnapshotStoreWriteReasonV1 {
  return token.runtimeGuardRejected
    ? 'runtime-commit-withheld'
    : token.reentered ? 'reentrant-operation' : 'closure-changed';
}

export function isAgentOsEpochSnapshotStorePlatformSupportedV1(
  platform: NodeJS.Platform,
): boolean {
  return isAgentOsEpochStorePlatformSupportedV1(platform);
}

function validClosure(value: unknown): value is AgentOsAuthenticatedActiveEpochSnapshotClosureV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'anchoredHeadDigest', 'attemptNamespaceDigest', 'epoch', 'epochManifestDigest',
    'expectedAuthenticatorKeyGeneration', 'expectedAuthenticatorKeyId',
    'expectedProducerIdentityDigest', 'snapshotBasePreviousEnvelopeDigest',
    'sourceBundleDigest', 'trustPolicyDigest', 'writerProtocolDigest',
  ]) && validEpoch(row['epoch']) &&
    isAgentOsPrefixedSha256DigestV1(row['anchoredHeadDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochManifestDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) &&
    isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) &&
    isAgentOsRawSha256DigestV1(row['snapshotBasePreviousEnvelopeDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['writerProtocolDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['expectedProducerIdentityDigest']) &&
    isAgentOsRawSha256DigestV1(row['expectedAuthenticatorKeyId']) &&
    validGeneration(row['expectedAuthenticatorKeyGeneration']));
}

function cloneClosure(
  value: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): Readonly<AgentOsAuthenticatedActiveEpochSnapshotClosureV1> {
  return deepFreeze({
    epoch: value.epoch,
    anchoredHeadDigest: value.anchoredHeadDigest,
    epochManifestDigest: value.epochManifestDigest,
    attemptNamespaceDigest: value.attemptNamespaceDigest,
    sourceBundleDigest: value.sourceBundleDigest,
    trustPolicyDigest: value.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: value.snapshotBasePreviousEnvelopeDigest,
    writerProtocolDigest: value.writerProtocolDigest,
    expectedProducerIdentityDigest: value.expectedProducerIdentityDigest,
    expectedAuthenticatorKeyId: value.expectedAuthenticatorKeyId,
    expectedAuthenticatorKeyGeneration: value.expectedAuthenticatorKeyGeneration,
  });
}

function sameClosure(
  left: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  right: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): boolean {
  return left.epoch === right.epoch &&
    left.expectedAuthenticatorKeyGeneration === right.expectedAuthenticatorKeyGeneration &&
    sameDigest(left.anchoredHeadDigest, right.anchoredHeadDigest) &&
    sameDigest(left.epochManifestDigest, right.epochManifestDigest) &&
    sameDigest(left.attemptNamespaceDigest, right.attemptNamespaceDigest) &&
    sameDigest(left.sourceBundleDigest, right.sourceBundleDigest) &&
    sameDigest(left.trustPolicyDigest, right.trustPolicyDigest) &&
    sameDigest(left.snapshotBasePreviousEnvelopeDigest, right.snapshotBasePreviousEnvelopeDigest) &&
    sameDigest(left.writerProtocolDigest, right.writerProtocolDigest) &&
    sameDigest(left.expectedProducerIdentityDigest, right.expectedProducerIdentityDigest) &&
    sameDigest(left.expectedAuthenticatorKeyId, right.expectedAuthenticatorKeyId);
}

function pinDependencies(value: AgentOsEpochSnapshotStoreDependenciesV1): PinnedDependencies | null {
  try {
    const row = record(value);
    if (!row || !exactKeys(row, [
      'activeClosureProvider', 'anchorPath', 'epochStoreRootPath', 'maxRecords',
      'historicalContextProvider', 'runtimeCommitGuard', 'signer', 'startReceiptProvider', 'verifier',
      'writerProtocolDigest',
    ].filter((key) => (key !== 'maxRecords' && key !== 'runtimeCommitGuard') || Object.hasOwn(row, key))) ||
      !isAgentOsEpochSnapshotStorePlatformSupportedV1(process.platform) ||
      typeof row['anchorPath'] !== 'string' || typeof row['epochStoreRootPath'] !== 'string' ||
      !isAgentOsPrefixedSha256DigestV1(row['writerProtocolDigest'])) return null;
    const provider = record(row['activeClosureProvider']);
    const historicalProvider = record(row['historicalContextProvider']);
    const startReceiptProvider = record(row['startReceiptProvider']);
    const signer = row['signer'] === null ? null : record(row['signer']);
    const verifier = row['verifier'] === null ? null : record(row['verifier']);
    if (!provider || !exactKeys(provider, ['readAuthenticatedClosure']) ||
      typeof provider['readAuthenticatedClosure'] !== 'function' ||
      !historicalProvider ||
      !exactKeys(historicalProvider, ['readAuthenticatedHistoricalContext']) ||
      typeof historicalProvider['readAuthenticatedHistoricalContext'] !== 'function' ||
      !startReceiptProvider ||
      !exactKeys(startReceiptProvider, ['readAuthenticatedStartReceipt']) ||
      typeof startReceiptProvider['readAuthenticatedStartReceipt'] !== 'function' ||
      (row['runtimeCommitGuard'] !== undefined &&
        (!record(row['runtimeCommitGuard']) ||
          !exactKeys(record(row['runtimeCommitGuard'])!, ['isCommitAuthorized']) ||
          typeof record(row['runtimeCommitGuard'])!['isCommitAuthorized'] !== 'function')) ||
      (signer && typeof signer['sign'] !== 'function') ||
      (verifier && typeof verifier['verify'] !== 'function')) return null;
    const anchorPath = resolve(row['anchorPath']);
    const epochStoreRootPath = resolve(row['epochStoreRootPath']);
    const maxRecords = row['maxRecords'] ?? DEFAULT_MAX_RECORDS;
    if (!isAbsolute(row['anchorPath']) || !isAbsolute(row['epochStoreRootPath']) ||
      row['anchorPath'] !== anchorPath || row['epochStoreRootPath'] !== epochStoreRootPath ||
      anchorPath === parse(anchorPath).root || dirname(epochStoreRootPath) !== anchorPath ||
      basename(epochStoreRootPath) !== 'agent-os-epochs' ||
      !Number.isSafeInteger(maxRecords) || Number(maxRecords) < 1 ||
      Number(maxRecords) > HARD_MAX_RECORDS) return null;
    return {
      ...(value as AgentOsEpochSnapshotStoreDependenciesV1),
      anchorPath,
      epochStoreRootPath,
      maxRecords: Number(maxRecords),
    };
  } catch {
    return null;
  }
}

function readClosure(
  dependencies: PinnedDependencies,
): Readonly<AgentOsAuthenticatedActiveEpochSnapshotClosureV1> | null {
  try {
    const read = dependencies.activeClosureProvider.readAuthenticatedClosure();
    if (!read || read.state !== 'authenticated' || !validClosure(read.closure) ||
      read.closure.writerProtocolDigest !== dependencies.writerProtocolDigest) return null;
    return cloneClosure(read.closure);
  } catch {
    return null;
  }
}

function epochPaths(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): { epochPath: string; snapshotsPath: string } {
  const epochPath = join(
    dependencies.epochStoreRootPath,
    'epochs',
    `epoch-${epochToken(closure.epoch)}`,
  );
  return { epochPath, snapshotsPath: join(epochPath, 'snapshots') };
}

function snapshotRootReady(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): boolean {
  try {
    const { epochPath, snapshotsPath } = epochPaths(dependencies, closure);
    const epoch = lstatSync(epochPath, { bigint: true });
    const snapshots = lstatSync(snapshotsPath, { bigint: true });
    return privateDirectory(epoch) && privateDirectory(snapshots) &&
      !(epoch.dev === snapshots.dev && epoch.ino === snapshots.ino) &&
      assurePrivateStoragePath(epochPath, 'directory', 'inspect-existing', {
        anchorPath: dependencies.anchorPath,
      }).ok && assurePrivateStoragePath(snapshotsPath, 'directory', 'inspect-existing', {
        anchorPath: epochPath,
      }).ok;
  } catch {
    return false;
  }
}

function pristineSnapshotRoot(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): boolean {
  if (!snapshotRootReady(dependencies, closure)) return false;
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(epochPaths(dependencies, closure).snapshotsPath);
    return directory.readSync() === null;
  } catch {
    return false;
  } finally {
    if (directory) {
      try { directory.closeSync(); } catch { /* best effort */ }
    }
  }
}

function closureContext(
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  expectedSequence: number,
  expectedPreviousEnvelopeDigest: string,
): AgentOsEpochSnapshotClosureContextV2 {
  return {
    epoch: closure.epoch,
    anchoredHeadDigest: closure.anchoredHeadDigest,
    epochManifestDigest: closure.epochManifestDigest,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    producerAttemptId: '',
    producerStartReceiptDigest: '',
    durableTickDigest: '',
    sourceBundleDigest: closure.sourceBundleDigest,
    trustPolicyDigest: closure.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: closure.snapshotBasePreviousEnvelopeDigest,
    expectedSequence,
    expectedPreviousEnvelopeDigest,
    expectedProducerIdentityDigest: closure.expectedProducerIdentityDigest,
    expectedAuthenticatorKeyId: closure.expectedAuthenticatorKeyId,
    expectedAuthenticatorKeyGeneration: closure.expectedAuthenticatorKeyGeneration,
  };
}

function contextForEnvelope(
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  envelope: AgentOsEpochSnapshotEnvelopeV2,
): AgentOsEpochSnapshotClosureContextV2 {
  return {
    ...closureContext(closure, envelope.epochSequence, envelope.previousEnvelopeDigest),
    producerAttemptId: envelope.producerAttemptId,
    producerStartReceiptDigest: envelope.producerStartReceiptDigest,
    durableTickDigest: envelope.durableTickDigest,
  };
}

function contextVerifierFor(
  expected: AgentOsEpochSnapshotClosureContextV2,
): { verify(context: Readonly<AgentOsEpochSnapshotClosureContextV2>): boolean } {
  return {
    verify(context) {
      const row = record(context);
      return Boolean(row && exactKeys(row, Object.keys(expected)) &&
        Object.entries(expected).every(([key, value]) => row[key] === value));
    },
  };
}

function startReceiptQuery(
  envelope: AgentOsEpochSnapshotEnvelopeV2,
): Readonly<AgentOsEpochSnapshotStartReceiptQueryV1> {
  return deepFreeze({
    epoch: envelope.epoch,
    anchoredHeadDigest: envelope.anchoredHeadDigest,
    epochManifestDigest: envelope.epochManifestDigest,
    attemptNamespaceDigest: envelope.attemptNamespaceDigest,
    producerAttemptId: envelope.producerAttemptId,
    durableTickDigest: envelope.durableTickDigest,
  });
}

function readStartReceiptLineage(
  dependencies: PinnedDependencies,
  query: AgentOsEpochSnapshotStartReceiptQueryV1,
): Readonly<{
  startReceiptDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
}> | null {
  try {
    const read = dependencies.startReceiptProvider.readAuthenticatedStartReceipt(query);
    const row = record(read);
    return row && exactKeys(row, [
      'sourceBundleDigest', 'startReceiptDigest', 'state', 'trustPolicyDigest',
    ]) &&
      row['state'] === 'authenticated' &&
      isAgentOsRawSha256DigestV1(row['startReceiptDigest']) &&
      isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) &&
      isAgentOsRawSha256DigestV1(row['trustPolicyDigest'])
      ? deepFreeze({
          startReceiptDigest: row['startReceiptDigest'],
          sourceBundleDigest: row['sourceBundleDigest'],
          trustPolicyDigest: row['trustPolicyDigest'],
        })
      : null;
  } catch {
    return null;
  }
}

function sameStartReceiptLineage(
  left: Readonly<{ startReceiptDigest: string; sourceBundleDigest: string; trustPolicyDigest: string }>,
  right: Readonly<{ startReceiptDigest: string; sourceBundleDigest: string; trustPolicyDigest: string }>,
): boolean {
  return sameDigest(left.startReceiptDigest, right.startReceiptDigest) &&
    sameDigest(left.sourceBundleDigest, right.sourceBundleDigest) &&
    sameDigest(left.trustPolicyDigest, right.trustPolicyDigest);
}

function historicalQuery(
  envelope: AgentOsEpochSnapshotEnvelopeV2,
): Readonly<AgentOsEpochSnapshotHistoricalContextQueryV1> {
  return deepFreeze({
    epoch: envelope.epoch,
    anchoredHeadDigest: envelope.anchoredHeadDigest,
    epochManifestDigest: envelope.epochManifestDigest,
    attemptNamespaceDigest: envelope.attemptNamespaceDigest,
    sourceBundleDigest: envelope.sourceBundleDigest,
    trustPolicyDigest: envelope.trustPolicyDigest,
    producerIdentityDigest: envelope.producerIdentityDigest,
    authenticatorKeyId: envelope.authenticatorKeyId,
    authenticatorKeyGeneration: envelope.authenticatorKeyGeneration,
  });
}

function readHistoricalContext(
  dependencies: PinnedDependencies,
  query: AgentOsEpochSnapshotHistoricalContextQueryV1,
): {
  context: Readonly<AgentOsAuthenticatedHistoricalEpochSnapshotContextV1>;
  verifier: AgentOsEpochSnapshotVerifierV2;
} | null {
  try {
    const read = dependencies.historicalContextProvider.readAuthenticatedHistoricalContext(query);
    const row = record(read);
    if (!row || !exactKeys(row, ['context', 'state', 'verifier']) ||
      row['state'] !== 'authenticated') return null;
    const context = record(row['context']);
    const verifier = record(row['verifier']);
    if (!context || !exactKeys(context, [
      'anchoredHeadDigest', 'attemptNamespaceDigest', 'authenticatorKeyGeneration',
      'authenticatorKeyId', 'epoch', 'epochManifestDigest', 'producerIdentityDigest',
      'snapshotBasePreviousEnvelopeDigest', 'sourceBundleDigest', 'trustPolicyDigest',
    ]) || !verifier || !exactKeys(verifier, [
      'keyGeneration', 'keyId', 'producerIdentityDigest', 'verify',
    ]) || !isAgentOsRawSha256DigestV1(context['snapshotBasePreviousEnvelopeDigest']) ||
      !Object.entries(query).every(([key, value]) => context[key] === value) ||
      verifier['producerIdentityDigest'] !== query.producerIdentityDigest ||
      verifier['keyId'] !== query.authenticatorKeyId ||
      verifier['keyGeneration'] !== query.authenticatorKeyGeneration ||
      typeof verifier['verify'] !== 'function') return null;
    return {
      context: deepFreeze({
        ...query,
        snapshotBasePreviousEnvelopeDigest: context['snapshotBasePreviousEnvelopeDigest'] as string,
      }),
      verifier: row['verifier'] as AgentOsEpochSnapshotVerifierV2,
    };
  } catch {
    return null;
  }
}

function sameHistoricalContext(
  left: AgentOsAuthenticatedHistoricalEpochSnapshotContextV1,
  right: AgentOsAuthenticatedHistoricalEpochSnapshotContextV1,
): boolean {
  return left.epoch === right.epoch &&
    left.authenticatorKeyGeneration === right.authenticatorKeyGeneration &&
    sameDigest(left.anchoredHeadDigest, right.anchoredHeadDigest) &&
    sameDigest(left.epochManifestDigest, right.epochManifestDigest) &&
    sameDigest(left.attemptNamespaceDigest, right.attemptNamespaceDigest) &&
    sameDigest(left.sourceBundleDigest, right.sourceBundleDigest) &&
    sameDigest(left.trustPolicyDigest, right.trustPolicyDigest) &&
    sameDigest(left.producerIdentityDigest, right.producerIdentityDigest) &&
    sameDigest(left.authenticatorKeyId, right.authenticatorKeyId) &&
    sameDigest(left.snapshotBasePreviousEnvelopeDigest, right.snapshotBasePreviousEnvelopeDigest);
}

function verifyHistoricalEnvelope(
  dependencies: PinnedDependencies,
  envelope: AgentOsEpochSnapshotEnvelopeV2,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  const query = historicalQuery(envelope);
  const historical = readHistoricalContext(dependencies, query);
  const startQuery = startReceiptQuery(envelope);
  const start = readStartReceiptLineage(dependencies, startQuery);
  if (!historical || !start || start.startReceiptDigest !== envelope.producerStartReceiptDigest ||
    start.sourceBundleDigest !== envelope.sourceBundleDigest ||
    start.trustPolicyDigest !== envelope.trustPolicyDigest) return null;
  const context: AgentOsEpochSnapshotClosureContextV2 = {
    epoch: historical.context.epoch,
    anchoredHeadDigest: historical.context.anchoredHeadDigest,
    epochManifestDigest: historical.context.epochManifestDigest,
    attemptNamespaceDigest: historical.context.attemptNamespaceDigest,
    producerAttemptId: envelope.producerAttemptId,
    producerStartReceiptDigest: envelope.producerStartReceiptDigest,
    durableTickDigest: envelope.durableTickDigest,
    sourceBundleDigest: historical.context.sourceBundleDigest,
    trustPolicyDigest: historical.context.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: historical.context.snapshotBasePreviousEnvelopeDigest,
    expectedSequence: envelope.epochSequence,
    expectedPreviousEnvelopeDigest: envelope.previousEnvelopeDigest,
    expectedProducerIdentityDigest: historical.context.producerIdentityDigest,
    expectedAuthenticatorKeyId: historical.context.authenticatorKeyId,
    expectedAuthenticatorKeyGeneration: historical.context.authenticatorKeyGeneration,
  };
  const verified = verifyAgentOsEpochSnapshotEnvelopeV2(
    envelope, context, historical.verifier, contextVerifierFor(context),
  );
  const finalStart = readStartReceiptLineage(dependencies, startQuery);
  if (!verified || !finalStart || !sameStartReceiptLineage(start, finalStart)) return null;
  const finalHistorical = readHistoricalContext(dependencies, query);
  return finalHistorical && sameHistoricalContext(historical.context, finalHistorical.context)
    ? verified
    : null;
}

function verifyActiveEnvelope(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  envelope: AgentOsEpochSnapshotEnvelopeV2,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  if (!dependencies.verifier) return null;
  const startQuery = startReceiptQuery(envelope);
  const start = readStartReceiptLineage(dependencies, startQuery);
  if (!start || start.startReceiptDigest !== envelope.producerStartReceiptDigest ||
    start.sourceBundleDigest !== envelope.sourceBundleDigest ||
    start.trustPolicyDigest !== envelope.trustPolicyDigest) return null;
  const context = contextForEnvelope(closure, envelope);
  const verified = verifyAgentOsEpochSnapshotEnvelopeV2(
    envelope, context, dependencies.verifier, contextVerifierFor(context),
  );
  const finalStart = readStartReceiptLineage(dependencies, startQuery);
  return verified && finalStart && sameStartReceiptLineage(start, finalStart) ? verified : null;
}

function belongsToActiveClosure(
  envelope: AgentOsEpochSnapshotEnvelopeV2,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): boolean {
  return envelope.epoch === closure.epoch &&
    envelope.anchoredHeadDigest === closure.anchoredHeadDigest &&
    envelope.epochManifestDigest === closure.epochManifestDigest &&
    envelope.attemptNamespaceDigest === closure.attemptNamespaceDigest &&
    envelope.sourceBundleDigest === closure.sourceBundleDigest &&
    envelope.trustPolicyDigest === closure.trustPolicyDigest &&
    envelope.producerIdentityDigest === closure.expectedProducerIdentityDigest &&
    envelope.authenticatorKeyId === closure.expectedAuthenticatorKeyId &&
    envelope.authenticatorKeyGeneration === closure.expectedAuthenticatorKeyGeneration;
}

function snapshotCodec(
  dependencies: PinnedDependencies,
  activeClosure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1 | null,
): ImmutablePrivateRecordCodec<AgentOsEpochSnapshotEnvelopeV2> {
  return {
    parse(value) {
      const canonical = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(value);
      const parsed = canonical ? parseAgentOsEpochSnapshotEnvelopeV2(canonical) : null;
      if (!parsed) return null;
      return activeClosure && belongsToActiveClosure(parsed, activeClosure)
        ? verifyActiveEnvelope(dependencies, activeClosure, parsed)
        : verifyHistoricalEnvelope(dependencies, parsed);
    },
    serialize(envelope) {
      const bytes = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(envelope);
      if (!bytes) throw new TypeError('snapshot envelope is not canonical');
      return `${bytes.toString('utf8')}\n`;
    },
    recordId: (envelope) => sequenceToken(envelope.epochSequence),
    recordFileName: (envelope) => `${sequenceToken(envelope.epochSequence)}.json`,
    isRecordFileName: (fileName) => RECORD_FILE_RE.test(fileName),
    stageToken: (envelope) => envelope.authenticator.slice(0, 32),
    equivalent: (left, right) => left.epochSequence === right.epochSequence &&
      sameDigest(left.envelopeDigest, right.envelopeDigest) &&
      sameDigest(left.authenticator, right.authenticator),
    compare: (left, right) => left.epochSequence - right.epochSequence,
  };
}

function storeConfig(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  allowActiveClosure = false,
): ImmutablePrivateRecordStoreConfig<AgentOsEpochSnapshotEnvelopeV2> | null {
  const { epochPath, snapshotsPath } = epochPaths(dependencies, closure);
  const codec = snapshotCodec(dependencies, allowActiveClosure ? closure : null);
  return {
    label: 'Agent OS epoch snapshot V2',
    anchorPath: epochPath,
    rootPath: snapshotsPath,
    lockFileName: STORE_LOCK,
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: dependencies.maxRecords,
    hardMaxFiles: dependencies.maxRecords,
    defaultMaxBytes: Math.min(DEFAULT_MAX_BYTES, dependencies.maxRecords * MAX_RECORD_BYTES),
    hardMaxBytes: Math.min(HARD_MAX_BYTES, dependencies.maxRecords * MAX_RECORD_BYTES),
    codecForWrite: () => codec,
    codecForRead: () => codec,
  };
}

function ownsWriteCapabilities(
  dependencies: PinnedDependencies,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
): 'owned' | 'coordination-lease-missing' | 'observation-lock-missing' {
  try {
    if (!ownsAgentOsEpochCoordinationLeaseV1(coordinationLease, {
      rootPath: dependencies.epochStoreRootPath,
      writerProtocolDigest: dependencies.writerProtocolDigest,
    })) return 'coordination-lease-missing';
    if (!ownsLocalStoreLock(observationLock) ||
      observationLock.path !== join(dependencies.anchorPath, '.agent-os-observation-transaction-v1.lock')) {
      return 'observation-lock-missing';
    }
    return 'owned';
  } catch {
    return 'observation-lock-missing';
  }
}

function liveCommitGuard(
  dependencies: PinnedDependencies,
  expectedClosure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
  token: OperationToken,
): boolean {
  if (!runtimeCommitAllowed(dependencies, token) ||
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned') return false;
  const fresh = readClosure(dependencies);
  if (!fresh || !sameClosure(expectedClosure, fresh) ||
    !snapshotRootReady(dependencies, fresh) || token.reentered) return false;
  if (ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned' ||
    !runtimeCommitAllowed(dependencies, token)) return false;
  const finalClosure = readClosure(dependencies);
  return !token.reentered && finalClosure !== null && sameClosure(expectedClosure, finalClosure) &&
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) === 'owned' &&
    runtimeCommitAllowed(dependencies, token);
}

function liveHistoricalLineageGuard(
  dependencies: PinnedDependencies,
  records: readonly AgentOsEpochSnapshotEnvelopeV2[],
  token: OperationToken,
): boolean {
  for (const envelope of records) {
    if (token.reentered || !verifyHistoricalEnvelope(dependencies, envelope)) return false;
  }
  return !token.reentered;
}

function writeResult(
  disposition: AgentOsEpochSnapshotStoreWriteResultV1['disposition'],
  reason: AgentOsEpochSnapshotStoreWriteReasonV1,
  envelope: AgentOsEpochSnapshotEnvelopeV2 | null = null,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1 | null = null,
  closureAuthenticated = false,
  durable = false,
): AgentOsEpochSnapshotStoreWriteResultV1 {
  return deepFreeze({
    disposition,
    reason,
    envelope,
    epoch: closure?.epoch ?? null,
    sequence: envelope?.epochSequence ?? null,
    closureAuthenticated,
    durable,
    ...AUTHORITY,
  });
}

function emptyRead(
  sourceState: AgentOsEpochSnapshotStoreReadResultV1['sourceState'],
  stopReasons: AgentOsEpochSnapshotStoreStopReasonV1[],
  overrides: Partial<AgentOsEpochSnapshotStoreReadResultV1> = {},
): AgentOsEpochSnapshotStoreReadResultV1 {
  return deepFreeze({
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState === 'healthy',
    records: [],
    current: null,
    epoch: null,
    anchoredHeadDigest: null,
    epochManifestDigest: null,
    stopReasons,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    capacityExhausted: false,
    closureAuthenticated: false,
    ...AUTHORITY,
    ...overrides,
  });
}

function chainIssues(
  records: readonly AgentOsEpochSnapshotEnvelopeV2[],
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
): AgentOsEpochSnapshotStoreStopReasonV1[] {
  const issues = new Set<AgentOsEpochSnapshotStoreStopReasonV1>();
  const sequences = new Set<number>();
  const attempts = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]!;
    const expectedSequence = index + 1;
    const expectedPrevious = index === 0 ? null : records[index - 1]!.envelopeDigest;
    if (sequences.has(current.epochSequence)) issues.add('sequence-fork');
    sequences.add(current.epochSequence);
    if (attempts.has(current.producerAttemptId)) issues.add('sequence-fork');
    attempts.add(current.producerAttemptId);
    if (current.epochSequence !== expectedSequence) issues.add('sequence-gap');
    if (current.producerIdentityDigest !== closure.expectedProducerIdentityDigest ||
      current.authenticatorKeyId !== closure.expectedAuthenticatorKeyId ||
      current.authenticatorKeyGeneration !== closure.expectedAuthenticatorKeyGeneration) {
      issues.add('signer-identity-drift');
    }
    if (expectedPrevious !== null && current.previousEnvelopeDigest !== expectedPrevious) {
      issues.add('predecessor-mismatch');
    }
  }
  return [...issues];
}

function readForClosure(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochSnapshotStoreReadResultV1 {
  const common = {
    epoch: closure.epoch,
    anchoredHeadDigest: closure.anchoredHeadDigest,
    epochManifestDigest: closure.epochManifestDigest,
    closureAuthenticated: true,
  };
  if (!snapshotRootReady(dependencies, closure)) {
    return emptyRead('missing', ['snapshot-root-missing'], common);
  }
  if (pristineSnapshotRoot(dependencies, closure)) {
    return emptyRead('healthy', [], { ...common, sourcePresent: true, complete: true });
  }
  const config = storeConfig(dependencies, closure);
  if (!config) return emptyRead('degraded', ['verifier-unavailable'], common);
  const raw = readImmutablePrivateRecords(config, { ...options, requireComplete: true });
  const issues = raw.complete ? chainIssues(raw.records, closure) : [];
  const capacityExhausted = raw.records.length >= dependencies.maxRecords;
  const stopReasons = [...new Set<AgentOsEpochSnapshotStoreStopReasonV1>([
    ...raw.stopReasons,
    ...issues,
    ...(capacityExhausted ? ['capacity-exhausted' as const] : []),
  ])];
  const degraded = !raw.complete || issues.length > 0;
  const records = degraded ? [] : raw.records;
  return deepFreeze({
    ...raw,
    sourceState: degraded ? 'degraded' : 'healthy',
    complete: !degraded,
    records,
    current: degraded ? null : records.at(-1) ?? null,
    ...common,
    stopReasons,
    capacityExhausted,
    ...AUTHORITY,
  });
}

export function readAgentOsEpochSnapshotsV2(
  suppliedDependencies: AgentOsEpochSnapshotStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochSnapshotStoreReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) {
    return emptyRead('degraded', [isAgentOsEpochSnapshotStorePlatformSupportedV1(process.platform)
      ? 'closure-unavailable'
      : 'platform-unsupported']);
  }
  const key = `${dependencies.epochStoreRootPath}\0snapshots`;
  const token = beginOperation(key);
  if (!token) return emptyRead('degraded', ['reentrant-operation']);
  try {
    const closure = readClosure(dependencies);
    if (!closure) return emptyRead('degraded', ['closure-unavailable']);
    const result = readForClosure(dependencies, closure, options);
    const finalClosure = readClosure(dependencies);
    if (token.reentered || !finalClosure || !sameClosure(closure, finalClosure)) {
      return emptyRead('degraded', [token.reentered ? 'reentrant-operation' : 'closure-changed'], {
        sourcePresent: result.sourcePresent,
        epoch: closure.epoch,
        anchoredHeadDigest: closure.anchoredHeadDigest,
        epochManifestDigest: closure.epochManifestDigest,
      });
    }
    return result;
  } finally {
    endOperation(key, token);
  }
}

function degradedBindingBatchResult(): AgentOsEpochSnapshotBindingBatchResultV1 {
  return deepFreeze({ state: 'degraded' as const });
}

function exactDenseArray(value: unknown[]): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
      (key === 'length' || /^(?:0|[1-9][0-9]*)$/u.test(key)) &&
      (key === 'length' || (descriptors[key]?.enumerable === true &&
        Object.hasOwn(descriptors[key]!, 'value')))) &&
      value.every((_, index) => Object.hasOwn(value, index));
  } catch {
    return false;
  }
}

function canonicalBindingBatchRequest(
  request: Readonly<AgentOsEpochSnapshotBindingBatchRequestV1>,
  maxRecords: number,
): Readonly<AgentOsEpochSnapshotBindingBatchRequestV1> | null {
  const row = record(request);
  if (!row || !exactKeys(row, ['bindings', 'inputSetDigest', 'protocol']) ||
    row['protocol'] !== AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1 ||
    !isAgentOsPrefixedSha256DigestV1(row['inputSetDigest']) ||
    !Array.isArray(row['bindings']) || !exactDenseArray(row['bindings']) ||
    row['bindings'].length < 1 ||
    row['bindings'].length > maxRecords) return null;
  const bindings: AgentOsEpochSnapshotV2BindingVerificationInputV1[] = [];
  const digests: string[] = [];
  for (const candidate of row['bindings']) {
    const binding = record(candidate);
    const digest = agentOsEpochSnapshotBindingDigestV1(
      candidate as AgentOsEpochSnapshotV2BindingVerificationInputV1,
    );
    if (!binding || digest === null) return null;
    bindings.push({
      epoch: binding['epoch'] as number,
      epochHeadDigest: binding['epochHeadDigest'] as string,
      attemptNamespaceDigest: binding['attemptNamespaceDigest'] as string,
      attemptId: binding['attemptId'] as string,
      producerStartReceiptDigest: binding['producerStartReceiptDigest'] as string,
      sourceBundleDigest: binding['sourceBundleDigest'] as string,
      trustPolicyDigest: binding['trustPolicyDigest'] as string,
      snapshotEnvelopeDigest: binding['snapshotEnvelopeDigest'] as string,
    });
    digests.push(digest);
  }
  const setDigest = agentOsEpochSnapshotBindingSetDigestV1(digests);
  if (setDigest === null || setDigest !== row['inputSetDigest']) return null;
  return deepFreeze({
    protocol: AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1,
    inputSetDigest: setDigest,
    bindings,
  });
}

/** M557 adapter backed by exactly one complete authenticated Snapshot V2 ledger scan. */
export function createAgentOsEpochSnapshotV2ExistenceVerifierV1(
  suppliedDependencies: AgentOsEpochSnapshotStoreDependenciesV1,
): AgentOsEpochSnapshotV2ExistenceVerifierV1 {
  return Object.freeze({
    verifyExactBindings(
      request: Readonly<AgentOsEpochSnapshotBindingBatchRequestV1>,
    ): AgentOsEpochSnapshotBindingBatchResultV1 {
      try {
        const dependencies = pinDependencies(suppliedDependencies);
        if (!dependencies) return degradedBindingBatchResult();
        const canonicalRequest = canonicalBindingBatchRequest(request, dependencies.maxRecords);
        if (!canonicalRequest) return degradedBindingBatchResult();
        const bindingDigests = canonicalRequest.bindings.map((binding) =>
          agentOsEpochSnapshotBindingDigestV1(binding)!);
        const read = readAgentOsEpochSnapshotsV2(dependencies, { requireComplete: true });
        if (!read.complete || read.sourceState !== 'healthy' || !read.closureAuthenticated) {
          return degradedBindingBatchResult();
        }
        const finalRequest = canonicalBindingBatchRequest(request, dependencies.maxRecords);
        if (!finalRequest || finalRequest.inputSetDigest !== canonicalRequest.inputSetDigest ||
          canonicalRequest.inputSetDigest !== request.inputSetDigest ||
          agentOsEpochSnapshotBindingSetDigestV1(bindingDigests) !== canonicalRequest.inputSetDigest) {
          return degradedBindingBatchResult();
        }
        const present = new Set<string>();
        for (const envelope of read.records) {
          const digest = agentOsEpochSnapshotBindingDigestV1({
            epoch: envelope.epoch,
            epochHeadDigest: envelope.anchoredHeadDigest,
            attemptNamespaceDigest: envelope.attemptNamespaceDigest,
            attemptId: envelope.producerAttemptId,
            producerStartReceiptDigest: envelope.producerStartReceiptDigest,
            sourceBundleDigest: envelope.sourceBundleDigest,
            trustPolicyDigest: envelope.trustPolicyDigest,
            snapshotEnvelopeDigest: envelope.envelopeDigest,
          });
          if (!digest || present.has(digest)) return degradedBindingBatchResult();
          present.add(digest);
        }
        return deepFreeze({
          state: 'authenticated' as const,
          inputSetDigest: canonicalRequest.inputSetDigest,
          decisions: bindingDigests.map((bindingDigest) => ({
            bindingDigest,
            verified: present.has(bindingDigest),
          })),
        });
      } catch {
        return degradedBindingBatchResult();
      }
    },
  });
}

function pointRead(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  sequence: number,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  const config = storeConfig(dependencies, closure, true);
  if (!config) return null;
  const slot = sequenceToken(sequence);
  const read = readImmutablePrivateRecordPoint(config, slot, `${slot}.json`);
  return read.sourceState === 'healthy' && read.exactReadComplete ? read.record : null;
}

function persistEnvelope(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  envelope: AgentOsEpochSnapshotEnvelopeV2,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
  token: OperationToken,
  priorRecords: readonly AgentOsEpochSnapshotEnvelopeV2[],
): AgentOsEpochSnapshotStoreWriteResultV1 {
  const config = storeConfig(dependencies, closure, true);
  if (!config) return writeResult('unavailable', 'verifier-unavailable', null, closure, true);
  const fencedRecords = [...priorRecords, envelope];
  let guardFailed = false;
  const publication = writeImmutablePrivateRecord(config, envelope, {
    lockWaitMs: MAX_LOCK_WAIT_MS,
    prepublish: () => {
      const allowed = liveCommitGuard(
        dependencies, closure, coordinationLease, observationLock, token,
      ) && liveHistoricalLineageGuard(dependencies, fencedRecords, token) && liveCommitGuard(
        dependencies, closure, coordinationLease, observationLock, token,
      );
      guardFailed ||= !allowed;
      return allowed;
    },
  });
  if (guardFailed) {
    return writeResult('withheld', commitFenceReason(token));
  }
  if (publication === 'conflicted') {
    return writeResult('conflicted', 'publication-conflict', null, closure, true);
  }
  if (publication !== 'recorded' && publication !== 'replayed') {
    return writeResult('failed', 'publication-failed', null, closure, true);
  }
  const persisted = pointRead(dependencies, closure, envelope.epochSequence);
  const exactPersisted = persisted !== null &&
    sameDigest(persisted.envelopeDigest, envelope.envelopeDigest) &&
    sameDigest(persisted.authenticator, envelope.authenticator);
  if (!exactPersisted || !liveCommitGuard(
    dependencies, closure, coordinationLease, observationLock, token,
  ) || !liveHistoricalLineageGuard(dependencies, fencedRecords, token) || !liveCommitGuard(
    dependencies, closure, coordinationLease, observationLock, token,
  )) {
    return writeResult(
      'failed', commitFenceReason(token),
      null, closure, false, exactPersisted,
    );
  }
  return writeResult(
    publication === 'replayed' ? 'replayed' : 'recorded',
    publication === 'replayed' ? 'snapshot-replay' : 'recorded',
    persisted,
    closure,
    true,
    true,
  );
}

function validWriteInput(value: unknown): value is WriteAgentOsEpochSnapshotV2Input {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'capabilityProjectionDigest', 'coordinationLease', 'durableTickDigest',
    'kernelCycleDigest', 'observationLock', 'observedAt', 'portfolioDigest',
    'renderedAt', 'snapshot', 'snapshotDigest',
  ]) && isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) &&
    typeof row['renderedAt'] === 'string' && typeof row['observedAt'] === 'string');
}

function matchesObservationInput(
  envelope: AgentOsEpochSnapshotEnvelopeV2,
  input: WriteAgentOsEpochSnapshotV2Input,
): boolean {
  const expectedSnapshot = canonicalComparable(envelope.payload.snapshot);
  const suppliedSnapshot = canonicalComparable(input.snapshot);
  return expectedSnapshot !== null && expectedSnapshot === suppliedSnapshot &&
    envelope.durableTickDigest === input.durableTickDigest &&
    envelope.renderedAt === input.renderedAt && envelope.observedAt === input.observedAt &&
    envelope.kernelCycleDigest === input.kernelCycleDigest &&
    envelope.capabilityProjectionDigest === input.capabilityProjectionDigest &&
    envelope.portfolioDigest === input.portfolioDigest &&
    envelope.payload.snapshotDigest === input.snapshotDigest;
}

export function writeAgentOsEpochSnapshotV2(
  input: WriteAgentOsEpochSnapshotV2Input,
  suppliedDependencies: AgentOsEpochSnapshotStoreDependenciesV1,
): AgentOsEpochSnapshotStoreWriteResultV1 {
  if (!validWriteInput(input)) return writeResult('withheld', 'invalid-input');
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) {
    return writeResult('withheld', isAgentOsEpochSnapshotStorePlatformSupportedV1(process.platform)
      ? 'invalid-input'
      : 'platform-unsupported');
  }
  const key = `${dependencies.epochStoreRootPath}\0snapshots`;
  const token = beginOperation(key);
  if (!token) return writeResult('withheld', 'reentrant-operation');
  try {
    if (!runtimeCommitAllowed(dependencies, token)) {
      return writeResult('withheld', 'runtime-commit-withheld');
    }
    const ownership = ownsWriteCapabilities(
      dependencies, input.coordinationLease, input.observationLock,
    );
    if (ownership !== 'owned') return writeResult('withheld', ownership);
    if (!dependencies.signer) return writeResult('unavailable', 'signer-unavailable');
    if (!dependencies.verifier ||
      dependencies.verifier.producerIdentityDigest !== dependencies.signer.producerIdentityDigest ||
      dependencies.verifier.keyId !== dependencies.signer.keyId ||
      dependencies.verifier.keyGeneration !== dependencies.signer.keyGeneration) {
      return writeResult('unavailable', 'verifier-unavailable');
    }
    const closure = readClosure(dependencies);
    if (!closure) return writeResult('unavailable', 'closure-unavailable');
    if (dependencies.signer.producerIdentityDigest !== closure.expectedProducerIdentityDigest ||
      dependencies.signer.keyId !== closure.expectedAuthenticatorKeyId ||
      dependencies.signer.keyGeneration !== closure.expectedAuthenticatorKeyGeneration) {
      return writeResult('unavailable', 'signer-unavailable', null, closure, true);
    }
    if (!snapshotRootReady(dependencies, closure)) {
      return writeResult('unavailable', 'chain-unavailable', null, closure, true);
    }
    const layoutConfig = storeConfig(dependencies, closure, true);
    if (!layoutConfig) return writeResult('unavailable', 'verifier-unavailable', null, closure, true);
    let layoutGuardFailed = false;
    const layout = initializeImmutablePrivateRecordStoreLayout(layoutConfig, {
      lockWaitMs: MAX_LOCK_WAIT_MS,
      guard: () => {
        const allowed = liveCommitGuard(
          dependencies, closure, input.coordinationLease, input.observationLock, token,
        );
        layoutGuardFailed ||= !allowed;
        return allowed;
      },
    });
    if (layoutGuardFailed || layout === 'withheld') {
      return writeResult('withheld', commitFenceReason(token));
    }
    if (layout !== 'initialized' && layout !== 'ready') {
      return writeResult('failed', 'publication-failed', null, closure, true);
    }
    const before = readForClosure(dependencies, closure, { requireComplete: true });
    if (!before.complete) return writeResult('unavailable', 'chain-unavailable', null, closure, true);
    if (token.reentered) return writeResult('withheld', 'reentrant-operation');
    const producerAttemptId = agentOsEpochAttemptIdV1({
      epoch: closure.epoch,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      durableTickDigest: input.durableTickDigest,
    });
    if (!producerAttemptId) return writeResult('withheld', 'invalid-input', null, closure, true);
    const existing = before.records.find((record) => record.producerAttemptId === producerAttemptId);
    if (existing) {
      if (!liveCommitGuard(
        dependencies, closure, input.coordinationLease, input.observationLock, token,
      ) || !verifyHistoricalEnvelope(dependencies, existing) || !liveCommitGuard(
        dependencies, closure, input.coordinationLease, input.observationLock, token,
      )) {
        return writeResult('withheld', commitFenceReason(token));
      }
      return matchesObservationInput(existing, input)
        ? writeResult('replayed', 'snapshot-replay', existing, closure, true, true)
        : writeResult('conflicted', 'publication-conflict', null, closure, true);
    }
    const startQuery = deepFreeze({
      epoch: closure.epoch,
      anchoredHeadDigest: closure.anchoredHeadDigest,
      epochManifestDigest: closure.epochManifestDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      producerAttemptId,
      durableTickDigest: input.durableTickDigest,
    });
    const start = readStartReceiptLineage(dependencies, startQuery);
    if (!start) {
      return writeResult('withheld', 'start-receipt-unavailable', null, closure, true);
    }
    const epochSequence = before.records.length + 1;
    const previousEnvelopeDigest = before.current?.envelopeDigest ??
      closure.snapshotBasePreviousEnvelopeDigest;
    const envelope = createAgentOsEpochSnapshotEnvelopeV2({
      epoch: closure.epoch,
      epochSequence,
      anchoredHeadDigest: closure.anchoredHeadDigest,
      epochManifestDigest: closure.epochManifestDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      producerAttemptId,
      producerStartReceiptDigest: start.startReceiptDigest,
      durableTickDigest: input.durableTickDigest,
      sourceBundleDigest: start.sourceBundleDigest,
      trustPolicyDigest: start.trustPolicyDigest,
      previousEnvelopeDigest,
      renderedAt: input.renderedAt,
      observedAt: input.observedAt,
      kernelCycleDigest: input.kernelCycleDigest,
      capabilityProjectionDigest: input.capabilityProjectionDigest,
      portfolioDigest: input.portfolioDigest,
      snapshot: input.snapshot,
      snapshotDigest: input.snapshotDigest,
    }, dependencies.signer);
    if (!envelope) return writeResult('withheld', 'invalid-input', null, closure, true);
    if (!liveCommitGuard(
      dependencies, closure, input.coordinationLease, input.observationLock, token,
    )) {
      return writeResult('withheld', commitFenceReason(token));
    }
    const finalStart = readStartReceiptLineage(dependencies, startQuery);
    if (!finalStart || !sameStartReceiptLineage(start, finalStart)) {
      return writeResult('withheld', 'start-receipt-unavailable', null, closure, false);
    }
    const authenticatedEnvelope = belongsToActiveClosure(envelope, closure)
      ? verifyActiveEnvelope(dependencies, closure, envelope)
      : verifyHistoricalEnvelope(dependencies, envelope);
    if (!authenticatedEnvelope || authenticatedEnvelope.envelopeDigest !== envelope.envelopeDigest) {
      return writeResult('withheld', 'chain-unavailable', null, closure, false);
    }
    if (before.records.length >= dependencies.maxRecords) {
      return writeResult('withheld', 'capacity-exhausted', null, closure, true);
    }
    return persistEnvelope(
      dependencies, closure, envelope, input.coordinationLease, input.observationLock, token,
      before.records,
    );
  } finally {
    endOperation(key, token);
  }
}

export function recoverAgentOsEpochSnapshotStoreV2(
  input: Pick<WriteAgentOsEpochSnapshotV2Input, 'coordinationLease' | 'observationLock'>,
  suppliedDependencies: AgentOsEpochSnapshotStoreDependenciesV1,
): 'missing' | 'clean' | 'recovered' | 'withheld' | 'failed' {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies || !input) return 'withheld';
  const key = `${dependencies.epochStoreRootPath}\0snapshots`;
  const token = beginOperation(key);
  if (!token) return 'withheld';
  try {
    if (!runtimeCommitAllowed(dependencies, token)) return 'withheld';
    const closure = readClosure(dependencies);
    if (!closure || ownsWriteCapabilities(
      dependencies, input.coordinationLease, input.observationLock,
    ) !== 'owned') return 'withheld';
    if (!snapshotRootReady(dependencies, closure)) return 'missing';
    if (pristineSnapshotRoot(dependencies, closure)) return 'clean';
    const config = storeConfig(dependencies, closure);
    if (!config || !liveCommitGuard(
      dependencies, closure, input.coordinationLease, input.observationLock, token,
    )) return 'withheld';
    const result = recoverImmutablePrivateRecordStore(config, { lockWaitMs: MAX_LOCK_WAIT_MS });
    return liveCommitGuard(
      dependencies, closure, input.coordinationLease, input.observationLock, token,
    ) ? result === 'invalid' ? 'failed' : result : 'withheld';
  } finally {
    endOperation(key, token);
  }
}
