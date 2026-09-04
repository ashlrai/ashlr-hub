/**
 * Durable, epoch-scoped persistence for Agent OS Attempt Receipt V2 records.
 *
 * The active closure is always obtained from an injected trusted provider; no
 * public write accepts an epoch, namespace, source, policy, or closure claim.
 * Local records remain observation-only evidence. This module owns no anchor
 * adapter, key loading, daemon wiring, execution, or external effect path.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import { ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecordPoint,
  readImmutablePrivateRecords,
  initializeImmutablePrivateRecordStoreLayout,
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
  AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  agentOsEpochAttemptIdV1,
  canonicalAgentOsEpochAttemptReceiptBytesV2,
  parseAgentOsEpochAttemptReceiptV2,
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
  verifyAgentOsEpochAttemptReceiptV2,
  verifyAgentOsEpochAttemptTransitionV2,
  createAgentOsEpochAttemptReceiptV2,
  type AgentOsEpochAttemptOutcomeV2,
  type AgentOsEpochAttemptReceiptV2,
  type AgentOsEpochAttemptSignerV2,
  type AgentOsEpochAttemptVerifierV2,
  type AgentOsEpochAttemptClosureContextV2,
} from './agent-os-epoch-records.js';
import { isAgentOsEpochStorePlatformSupportedV1 } from './agent-os-epoch-store.js';

export const AGENT_OS_EPOCH_ATTEMPT_STORE_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-attempt-store-v1' as const;
export const AGENT_OS_EPOCH_ATTEMPT_SET_DOMAIN_V1 =
  'ashlr:agent-os:epoch-attempt-set:v1\0' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-snapshot-binding-batch-v1' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_BINDING_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-snapshot-binding:v1\0' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_BINDING_SET_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-snapshot-binding-set:v1\0' as const;
export const AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-historical-source-batch-v1' as const;
export const AGENT_OS_EPOCH_HISTORICAL_SOURCE_LINEAGE_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-historical-source-lineage:v1\0' as const;
export const AGENT_OS_EPOCH_HISTORICAL_SOURCE_SET_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-historical-source-set:v1\0' as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ATTEMPT_STORE_LOCK = '.agent-os-epoch-attempt-v2.lock';
const RECORD_FILE_RE = /^([a-f0-9]{64})\.([12])\.json$/;
const MAX_EPOCH = 999_999_999_999;
const MAX_RECORD_BYTES = 16 * 1024;
const DEFAULT_MAX_RECORDS = 8_192;
const HARD_MAX_RECORDS = 100_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2_000;

interface AgentOsEpochAttemptStoreTestHooks {
  afterPublishedStartOpen?: (path: string) => void;
}

let attemptStoreTestHooks: AgentOsEpochAttemptStoreTestHooks | undefined;

/** Test-only seam for deterministic pathname replacement after descriptor open. */
export function setAgentOsEpochAttemptStoreTestHooksForTests(
  hooks?: AgentOsEpochAttemptStoreTestHooks,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('epoch attempt store hooks are test-only');
  attemptStoreTestHooks = hooks;
}

export interface AgentOsAuthenticatedActiveEpochAttemptClosureV1
  extends AgentOsEpochAttemptClosureContextV2 {
  epochHeadDigest: string;
  epochManifestDigest: string;
  attemptAuthenticatorKeyId: string;
  attemptAuthenticatorGeneration: number;
  writerProtocolDigest: string;
}

export type AgentOsAuthenticatedActiveEpochAttemptClosureReadV1 =
  | {
      state: 'authenticated';
      closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1;
    }
  | {
      state: 'missing' | 'uncommissioned' | 'unavailable' | 'degraded';
    };

/**
 * This provider owns anchor/pointer/manifest/source authentication. M557 calls
 * it afresh at every commit fence and never accepts closure data from a write
 * caller.
 */
export interface AgentOsAuthenticatedActiveEpochAttemptClosureProviderV1 {
  readAuthenticatedClosure(): AgentOsAuthenticatedActiveEpochAttemptClosureReadV1;
}

export interface AgentOsEpochAttemptHistoricalSourceLineageV1 {
  epoch: number;
  epochHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  attemptAuthenticatorKeyId: string;
}

export interface AgentOsEpochAttemptAuthenticatedHistoricalSourceLineageV1
  extends AgentOsEpochAttemptHistoricalSourceLineageV1 {
  attemptAuthenticatorGeneration: number;
}

export type AgentOsEpochAttemptHistoricalSourceVerificationResolutionV1 =
  | {
      state: 'authenticated';
      lineage: Readonly<AgentOsEpochAttemptAuthenticatedHistoricalSourceLineageV1>;
      verifier: AgentOsEpochAttemptVerifierV2;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

export type AgentOsEpochAttemptHistoricalSourceLineageResolutionV1 =
  | {
      state: 'authenticated';
      lineage: Readonly<AgentOsEpochAttemptAuthenticatedHistoricalSourceLineageV1>;
      verifier: AgentOsEpochAttemptVerifierV2;
      signer: AgentOsEpochAttemptSignerV2 | null;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

export interface AgentOsEpochAttemptHistoricalSourceBatchRequestV1 {
  protocol: typeof AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1;
  inputSetDigest: string;
  lineages: ReadonlyArray<Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1>>;
}

export interface AgentOsEpochAttemptHistoricalSourceBatchDecisionV1 {
  lineageDigest: string;
  resolution: AgentOsEpochAttemptHistoricalSourceVerificationResolutionV1;
}

export type AgentOsEpochAttemptHistoricalSourceBatchResultV1 =
  | {
      state: 'authenticated';
      inputSetDigest: string;
      resolutions: ReadonlyArray<Readonly<AgentOsEpochAttemptHistoricalSourceBatchDecisionV1>>;
    }
  | { state: 'unavailable' | 'degraded' };

type AuthenticatedHistoricalResolution = Extract<
  AgentOsEpochAttemptHistoricalSourceLineageResolutionV1,
  { state: 'authenticated' }
>;
type AuthenticatedHistoricalVerificationResolution = Extract<
  AgentOsEpochAttemptHistoricalSourceVerificationResolutionV1,
  { state: 'authenticated' }
>;

/**
 * Trusted M561-facing seam for authenticating the source generation recorded
 * by a historical receipt. Current-source admission is intentionally separate.
 * The returned verifier/signer selection binds local MAC evidence to an
 * authenticated key lineage; it does not make a same-user local MAC tamper
 * resistant, recover a deleted secret, or establish external authority.
 */
export interface AgentOsEpochAttemptHistoricalSourceLineageProviderV1 {
  resolveAuthenticatedHistoricalSource(
    lineage: Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1>,
  ): AgentOsEpochAttemptHistoricalSourceLineageResolutionV1;
  resolveAuthenticatedHistoricalSources(
    request: Readonly<AgentOsEpochAttemptHistoricalSourceBatchRequestV1>,
  ): AgentOsEpochAttemptHistoricalSourceBatchResultV1;
}

export interface AgentOsEpochSnapshotV2BindingVerificationInputV1 {
  epoch: number;
  epochHeadDigest: string;
  attemptNamespaceDigest: string;
  attemptId: string;
  producerStartReceiptDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  snapshotEnvelopeDigest: string;
}

/** A true result means one exact Snapshot V2 reciprocally binds this attempt. */
export interface AgentOsEpochSnapshotV2ExistenceVerifierV1 {
  verifyExactBindings(
    request: Readonly<AgentOsEpochSnapshotBindingBatchRequestV1>,
  ): AgentOsEpochSnapshotBindingBatchResultV1;
}

export interface AgentOsEpochSnapshotBindingBatchRequestV1 {
  protocol: typeof AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1;
  inputSetDigest: string;
  bindings: ReadonlyArray<Readonly<AgentOsEpochSnapshotV2BindingVerificationInputV1>>;
}

export type AgentOsEpochSnapshotBindingBatchResultV1 =
  | {
      state: 'authenticated';
      inputSetDigest: string;
      decisions: ReadonlyArray<Readonly<{ bindingDigest: string; verified: boolean }>>;
    }
  | { state: 'unavailable' | 'degraded' };

export interface AgentOsEpochAttemptStoreDependenciesV1 {
  /** Existing exact-private directory that directly contains epochStoreRootPath. */
  anchorPath: string;
  /** Exact M553 root, ending in `agent-os-epochs`. */
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  activeClosureProvider: AgentOsAuthenticatedActiveEpochAttemptClosureProviderV1;
  historicalSourceLineageProvider: AgentOsEpochAttemptHistoricalSourceLineageProviderV1;
  signer: AgentOsEpochAttemptSignerV2 | null;
  runtimeCommitGuard?: AgentOsEpochAttemptRuntimeCommitGuardV1;
  snapshotV2ExistenceVerifier?: AgentOsEpochSnapshotV2ExistenceVerifierV1;
  maxRecords?: number;
}

export interface AgentOsEpochAttemptRuntimeCommitGuardV1 {
  isCommitAuthorized(): boolean;
}

export interface BeginAgentOsEpochAttemptV2Input {
  durableTickDigest: string;
  startedAt: string;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export interface CompleteAgentOsEpochAttemptV2Input {
  durableTickDigest: string;
  outcome: AgentOsEpochAttemptOutcomeV2;
  snapshotEnvelopeDigest: string | null;
  completedAt: string;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export type AgentOsEpochAttemptStoreWriteReasonV1 =
  | 'recorded'
  | 'receipt-replay'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'closure-unavailable'
  | 'closure-changed'
  | 'reentrant-call'
  | 'runtime-commit-withheld'
  | 'coordination-lease-missing'
  | 'observation-lock-missing'
  | 'signer-unavailable'
  | 'verifier-unavailable'
  | 'chain-unavailable'
  | 'capacity-exhausted'
  | 'invalid-transition'
  | 'snapshot-v2-unverified'
  | 'publication-conflict'
  | 'publication-failed';

export interface AgentOsEpochAttemptStoreAuthorityV1 {
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

export interface AgentOsEpochAttemptStoreWriteResultV1
  extends AgentOsEpochAttemptStoreAuthorityV1 {
  disposition: 'recorded' | 'replayed' | 'conflicted' | 'withheld' | 'unavailable' | 'failed';
  reason: AgentOsEpochAttemptStoreWriteReasonV1;
  receipt: Readonly<AgentOsEpochAttemptReceiptV2> | null;
  epoch: number | null;
  attemptId: string | null;
  closureAuthenticated: boolean;
  durable: boolean;
}

export type AgentOsEpochAttemptStoreStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'platform-unsupported'
  | 'closure-unavailable'
  | 'closure-changed'
  | 'reentrant-call'
  | 'verifier-unavailable'
  | 'attempt-root-missing'
  | 'transition-gap'
  | 'transition-fork'
  | 'invalid-transition'
  | 'snapshot-v2-unverified'
  | 'capacity-exhausted';

export interface AgentOsEpochAttemptStoreReadResultV1
  extends AgentOsEpochAttemptStoreAuthorityV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  records: ReadonlyArray<Readonly<AgentOsEpochAttemptReceiptV2>>;
  attemptSetDigest: string | null;
  openAttempts: number;
  epoch: number | null;
  epochHeadDigest: string | null;
  attemptNamespaceDigest: string | null;
  stopReasons: AgentOsEpochAttemptStoreStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
  capacityExhausted: boolean;
  closureAuthenticated: boolean;
}

export interface AgentOsEpochAttemptSetDigestInputV1 {
  epoch: number;
  attemptNamespaceDigest: string;
  receipts: ReadonlyArray<Readonly<{
    attemptId: string;
    transitionOrdinal: 1 | 2;
    receiptDigest: string;
  }>>;
}

export interface AgentOsEpochAttemptStartReceiptQueryV1 {
  epoch: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  producerAttemptId: string;
  durableTickDigest: string;
}

export type AgentOsEpochAttemptStartReceiptReadV1 =
  | {
      state: 'authenticated';
      startReceiptDigest: string;
      sourceBundleDigest: string;
      trustPolicyDigest: string;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

export interface AgentOsEpochAttemptStartReceiptProviderV1 {
  readAuthenticatedStartReceipt(
    query: Readonly<AgentOsEpochAttemptStartReceiptQueryV1>,
  ): AgentOsEpochAttemptStartReceiptReadV1;
}

interface PinnedDependencies extends AgentOsEpochAttemptStoreDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  maxRecords: number;
}

const AUTHORITY: Readonly<AgentOsEpochAttemptStoreAuthorityV1> = Object.freeze({
  ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  writesAuthorized: false,
  pointerMutationAuthorized: false,
  anchorMutationAuthority: false,
});

interface RootOperationState {
  mode: 'read' | 'write' | 'point';
  reentered: boolean;
  nestedReadActive: boolean;
  runtimeGuardRejected: boolean;
}
interface RootOperationToken {
  state: RootOperationState;
  owner: boolean;
  nestedRead: boolean;
}
const ACTIVE_ROOT_OPERATIONS = new Map<string, RootOperationState>();

function enterRootOperation(
  rootPath: string,
  mode: 'read' | 'write' | 'point',
): RootOperationToken | null {
  const existing = ACTIVE_ROOT_OPERATIONS.get(rootPath);
  if (existing) {
    if (!existing.nestedReadActive && (mode === 'point' ||
      (mode === 'read' && existing.mode === 'write'))) {
      existing.nestedReadActive = true;
      return { state: existing, owner: false, nestedRead: true };
    }
    existing.reentered = true;
    return null;
  }
  const state = { mode, reentered: false, nestedReadActive: false, runtimeGuardRejected: false };
  ACTIVE_ROOT_OPERATIONS.set(rootPath, state);
  return { state, owner: true, nestedRead: false };
}

function leaveRootOperation(rootPath: string, token: RootOperationToken): void {
  if (token.nestedRead) token.state.nestedReadActive = false;
  if (token.owner && ACTIVE_ROOT_OPERATIONS.get(rootPath) === token.state) {
    ACTIVE_ROOT_OPERATIONS.delete(rootPath);
  }
}

function operationSafe(dependencies: PinnedDependencies): boolean {
  return ACTIVE_ROOT_OPERATIONS.get(dependencies.epochStoreRootPath)?.reentered !== true;
}

function runtimeCommitAllowed(dependencies: PinnedDependencies): boolean {
  const state = ACTIVE_ROOT_OPERATIONS.get(dependencies.epochStoreRootPath);
  try {
    const allowed = dependencies.runtimeCommitGuard?.isCommitAuthorized() !== false &&
      operationSafe(dependencies);
    if (!allowed && state) state.runtimeGuardRejected = true;
    return allowed;
  } catch {
    if (state) state.runtimeGuardRejected = true;
    return false;
  }
}

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

function exactDenseArray(value: unknown, maxLength: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length < 0 || value.length > maxLength) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1 ||
      !lengthDescriptor || lengthDescriptor.enumerable !== false) return null;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
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

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_EPOCH;
}

function privateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE));
}

function privateFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE));
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameDigest(left: string, right: string): boolean {
  return exactBytes(Buffer.from(left), Buffer.from(right));
}

function epochToken(epoch: number): string {
  return String(epoch).padStart(12, '0');
}

function attemptSlot(receipt: Pick<AgentOsEpochAttemptReceiptV2, 'attemptId' | 'transitionOrdinal'>): string {
  return `${receipt.attemptId.slice(7)}.${receipt.transitionOrdinal}`;
}

function closureContext(
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): AgentOsEpochAttemptClosureContextV2 {
  return {
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    sourceBundleDigest: closure.sourceBundleDigest,
    trustPolicyDigest: closure.trustPolicyDigest,
  };
}

function validClosure(value: unknown): value is AgentOsAuthenticatedActiveEpochAttemptClosureV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'attemptAuthenticatorGeneration', 'attemptAuthenticatorKeyId', 'attemptNamespaceDigest',
    'epoch', 'epochHeadDigest', 'epochManifestDigest', 'sourceBundleDigest',
    'trustPolicyDigest', 'writerProtocolDigest',
  ]) && validEpoch(row['epoch']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochHeadDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochManifestDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) &&
    isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) &&
    isAgentOsRawSha256DigestV1(row['attemptAuthenticatorKeyId']) &&
    Number.isSafeInteger(row['attemptAuthenticatorGeneration']) &&
    Number(row['attemptAuthenticatorGeneration']) >= 1 &&
    Number(row['attemptAuthenticatorGeneration']) <= 1_000_000 &&
    isAgentOsPrefixedSha256DigestV1(row['writerProtocolDigest']));
}

function cloneClosure(
  value: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): Readonly<AgentOsAuthenticatedActiveEpochAttemptClosureV1> {
  return deepFreeze({
    epoch: value.epoch,
    epochHeadDigest: value.epochHeadDigest,
    epochManifestDigest: value.epochManifestDigest,
    attemptNamespaceDigest: value.attemptNamespaceDigest,
    sourceBundleDigest: value.sourceBundleDigest,
    trustPolicyDigest: value.trustPolicyDigest,
    attemptAuthenticatorKeyId: value.attemptAuthenticatorKeyId,
    attemptAuthenticatorGeneration: value.attemptAuthenticatorGeneration,
    writerProtocolDigest: value.writerProtocolDigest,
  });
}

function sameClosure(
  left: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  right: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): boolean {
  return left.epoch === right.epoch &&
    sameDigest(left.epochHeadDigest, right.epochHeadDigest) &&
    sameDigest(left.epochManifestDigest, right.epochManifestDigest) &&
    sameDigest(left.attemptNamespaceDigest, right.attemptNamespaceDigest) &&
    sameDigest(left.sourceBundleDigest, right.sourceBundleDigest) &&
    sameDigest(left.trustPolicyDigest, right.trustPolicyDigest) &&
    sameDigest(left.attemptAuthenticatorKeyId, right.attemptAuthenticatorKeyId) &&
    left.attemptAuthenticatorGeneration === right.attemptAuthenticatorGeneration &&
    sameDigest(left.writerProtocolDigest, right.writerProtocolDigest);
}

function sameEpochIdentity(
  left: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  right: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): boolean {
  return left.epoch === right.epoch &&
    sameDigest(left.epochHeadDigest, right.epochHeadDigest) &&
    sameDigest(left.epochManifestDigest, right.epochManifestDigest) &&
    sameDigest(left.attemptNamespaceDigest, right.attemptNamespaceDigest) &&
    sameDigest(left.writerProtocolDigest, right.writerProtocolDigest);
}

function historicalLineage(
  context: AgentOsEpochAttemptClosureContextV2,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  attemptAuthenticatorKeyId: string,
): Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1> {
  return deepFreeze({
    epoch: context.epoch,
    epochHeadDigest: closure.epochHeadDigest,
    epochManifestDigest: closure.epochManifestDigest,
    attemptNamespaceDigest: context.attemptNamespaceDigest,
    sourceBundleDigest: context.sourceBundleDigest,
    trustPolicyDigest: context.trustPolicyDigest,
    attemptAuthenticatorKeyId,
  });
}

function validHistoricalLineage(
  value: unknown,
): value is AgentOsEpochAttemptHistoricalSourceLineageV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'attemptAuthenticatorKeyId', 'attemptNamespaceDigest', 'epoch', 'epochHeadDigest',
    'epochManifestDigest', 'sourceBundleDigest', 'trustPolicyDigest',
  ]) && validEpoch(row['epoch']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochHeadDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochManifestDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) &&
    isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) &&
    isAgentOsRawSha256DigestV1(row['attemptAuthenticatorKeyId']));
}

export function agentOsEpochAttemptHistoricalSourceLineageDigestV1(
  lineage: AgentOsEpochAttemptHistoricalSourceLineageV1,
): string | null {
  if (!validHistoricalLineage(lineage)) return null;
  const canonical = JSON.stringify({
    attemptAuthenticatorKeyId: lineage.attemptAuthenticatorKeyId,
    attemptNamespaceDigest: lineage.attemptNamespaceDigest,
    epoch: lineage.epoch,
    epochHeadDigest: lineage.epochHeadDigest,
    epochManifestDigest: lineage.epochManifestDigest,
    sourceBundleDigest: lineage.sourceBundleDigest,
    trustPolicyDigest: lineage.trustPolicyDigest,
  });
  return `sha256:${createHash('sha256')
    .update(AGENT_OS_EPOCH_HISTORICAL_SOURCE_LINEAGE_DIGEST_DOMAIN_V1, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex')}`;
}

export function agentOsEpochAttemptHistoricalSourceSetDigestV1(
  lineageDigests: ReadonlyArray<string>,
): string | null {
  if (!Array.isArray(lineageDigests) || lineageDigests.length < 1 ||
    lineageDigests.length > HARD_MAX_RECORDS ||
    lineageDigests.some((digest) => !isAgentOsPrefixedSha256DigestV1(digest))) return null;
  const sorted = [...lineageDigests].sort();
  if (new Set(sorted).size !== sorted.length ||
    sorted.some((digest, index) => digest !== lineageDigests[index])) return null;
  return `sha256:${createHash('sha256')
    .update(AGENT_OS_EPOCH_HISTORICAL_SOURCE_SET_DIGEST_DOMAIN_V1, 'utf8')
    .update(JSON.stringify(sorted), 'utf8')
    .digest('hex')}`;
}

function validateHistoricalResolution(
  value: unknown,
  expected: AgentOsEpochAttemptHistoricalSourceLineageV1,
): AuthenticatedHistoricalResolution | null {
  const resolution = record(value);
  const lineage = resolution && record(resolution['lineage']);
  const verifier = resolution && record(resolution['verifier']);
  const signerValue = resolution?.['signer'];
  const signer = signerValue === null ? null : record(signerValue);
  if (!resolution || !exactKeys(resolution, ['lineage', 'signer', 'state', 'verifier']) ||
    resolution['state'] !== 'authenticated' || !lineage || !exactKeys(lineage, [
      'attemptAuthenticatorGeneration', 'attemptAuthenticatorKeyId', 'attemptNamespaceDigest',
      'epoch', 'epochHeadDigest', 'epochManifestDigest', 'sourceBundleDigest', 'trustPolicyDigest',
    ]) || lineage['epoch'] !== expected.epoch ||
    lineage['epochHeadDigest'] !== expected.epochHeadDigest ||
    lineage['epochManifestDigest'] !== expected.epochManifestDigest ||
    lineage['attemptNamespaceDigest'] !== expected.attemptNamespaceDigest ||
    lineage['sourceBundleDigest'] !== expected.sourceBundleDigest ||
    lineage['trustPolicyDigest'] !== expected.trustPolicyDigest ||
    lineage['attemptAuthenticatorKeyId'] !== expected.attemptAuthenticatorKeyId ||
    !Number.isSafeInteger(lineage['attemptAuthenticatorGeneration']) ||
    Number(lineage['attemptAuthenticatorGeneration']) < 1 ||
    Number(lineage['attemptAuthenticatorGeneration']) > 1_000_000 ||
    !verifier || !exactKeys(verifier, ['keyId', 'verify']) ||
    verifier['keyId'] !== expected.attemptAuthenticatorKeyId ||
    typeof verifier['verify'] !== 'function' ||
    (signer !== null && (!exactKeys(signer, ['authenticate', 'keyId']) ||
      signer['keyId'] !== expected.attemptAuthenticatorKeyId ||
      typeof signer['authenticate'] !== 'function'))) return null;
  const verify = (verifier['verify'] as AgentOsEpochAttemptVerifierV2['verify']).bind(verifier);
  const authenticate = signer === null
    ? null
    : (signer['authenticate'] as AgentOsEpochAttemptSignerV2['authenticate']).bind(signer);
  return deepFreeze({
    state: 'authenticated' as const,
    lineage: { ...expected, attemptAuthenticatorGeneration: Number(lineage['attemptAuthenticatorGeneration']) },
    verifier: {
      keyId: expected.attemptAuthenticatorKeyId,
      verify: (input: Parameters<AgentOsEpochAttemptVerifierV2['verify']>[0]) => verify(input),
    },
    signer: authenticate === null ? null : {
      keyId: expected.attemptAuthenticatorKeyId,
      authenticate: (bytes: Uint8Array) => authenticate(bytes),
    },
  });
}

function validateHistoricalVerificationResolution(
  value: unknown,
  expected: AgentOsEpochAttemptHistoricalSourceLineageV1,
): AuthenticatedHistoricalVerificationResolution | null {
  const resolution = record(value);
  const lineage = resolution && record(resolution['lineage']);
  const verifier = resolution && record(resolution['verifier']);
  if (!resolution || !exactKeys(resolution, ['lineage', 'state', 'verifier']) ||
    resolution['state'] !== 'authenticated' || !lineage || !exactKeys(lineage, [
      'attemptAuthenticatorGeneration', 'attemptAuthenticatorKeyId', 'attemptNamespaceDigest',
      'epoch', 'epochHeadDigest', 'epochManifestDigest', 'sourceBundleDigest', 'trustPolicyDigest',
    ]) || lineage['epoch'] !== expected.epoch ||
    lineage['epochHeadDigest'] !== expected.epochHeadDigest ||
    lineage['epochManifestDigest'] !== expected.epochManifestDigest ||
    lineage['attemptNamespaceDigest'] !== expected.attemptNamespaceDigest ||
    lineage['sourceBundleDigest'] !== expected.sourceBundleDigest ||
    lineage['trustPolicyDigest'] !== expected.trustPolicyDigest ||
    lineage['attemptAuthenticatorKeyId'] !== expected.attemptAuthenticatorKeyId ||
    !Number.isSafeInteger(lineage['attemptAuthenticatorGeneration']) ||
    Number(lineage['attemptAuthenticatorGeneration']) < 1 ||
    Number(lineage['attemptAuthenticatorGeneration']) > 1_000_000 ||
    !verifier || !exactKeys(verifier, ['keyId', 'verify']) ||
    verifier['keyId'] !== expected.attemptAuthenticatorKeyId ||
    typeof verifier['verify'] !== 'function') return null;
  const verify = (verifier['verify'] as AgentOsEpochAttemptVerifierV2['verify']).bind(verifier);
  return deepFreeze({
    state: 'authenticated' as const,
    lineage: { ...expected, attemptAuthenticatorGeneration: Number(lineage['attemptAuthenticatorGeneration']) },
    verifier: {
      keyId: expected.attemptAuthenticatorKeyId,
      verify: (input: Parameters<AgentOsEpochAttemptVerifierV2['verify']>[0]) => verify(input),
    },
  });
}

function resolveHistoricalLineage(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  context: AgentOsEpochAttemptClosureContextV2,
  attemptAuthenticatorKeyId: string,
): AuthenticatedHistoricalResolution | null {
  try {
    if (!operationSafe(dependencies)) return null;
    const expected = historicalLineage(context, closure, attemptAuthenticatorKeyId);
    const resolution = dependencies.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSource(expected);
    if (!operationSafe(dependencies) || !resolution || resolution.state !== 'authenticated') return null;
    return validateHistoricalResolution(resolution, expected);
  } catch {
    return null;
  }
}

function resolveHistoricalLineageBatch(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  receipts: readonly AgentOsEpochAttemptReceiptV2[],
): ReadonlyMap<string, AuthenticatedHistoricalVerificationResolution> | null {
  if (receipts.length < 1) return new Map();
  const indexed = new Map<string, Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1>>();
  for (const receipt of receipts) {
    const lineage = historicalLineage({
      epoch: receipt.epoch,
      attemptNamespaceDigest: receipt.attemptNamespaceDigest,
      sourceBundleDigest: receipt.sourceBundleDigest,
      trustPolicyDigest: receipt.trustPolicyDigest,
    }, closure, receipt.authenticatorKeyId);
    const digest = agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage);
    if (!digest) return null;
    indexed.set(digest, lineage);
  }
  const ordered = [...indexed.entries()].sort(([left], [right]) => left.localeCompare(right));
  const digests = ordered.map(([digest]) => digest);
  const inputSetDigest = agentOsEpochAttemptHistoricalSourceSetDigestV1(digests);
  if (!inputSetDigest) return null;
  const request = deepFreeze({
    protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
    inputSetDigest,
    lineages: ordered.map(([, lineage]) => ({ ...lineage })),
  });
  try {
    if (!operationSafe(dependencies)) return null;
    const result = dependencies.historicalSourceLineageProvider
      .resolveAuthenticatedHistoricalSources(request);
    if (!operationSafe(dependencies) || request.inputSetDigest !== inputSetDigest ||
      agentOsEpochAttemptHistoricalSourceSetDigestV1(request.lineages.map((lineage) =>
        agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage) ?? '')) !== inputSetDigest) return null;
    const row = record(result);
    if (!row || !exactKeys(row, ['inputSetDigest', 'resolutions', 'state']) ||
      row['state'] !== 'authenticated' || row['inputSetDigest'] !== inputSetDigest ||
      !Array.isArray(row['resolutions']) || row['resolutions'].length !== ordered.length) return null;
    const decisions = exactDenseArray(row['resolutions'], dependencies.maxRecords);
    if (!decisions || decisions.length !== ordered.length) return null;
    const resolved = new Map<string, AuthenticatedHistoricalVerificationResolution>();
    for (let index = 0; index < ordered.length; index += 1) {
      const decision = record(decisions[index]);
      const [expectedDigest, expectedLineage] = ordered[index]!;
      if (!decision || !exactKeys(decision, ['lineageDigest', 'resolution']) ||
        decision['lineageDigest'] !== expectedDigest) return null;
      const resolutionRow = record(decision['resolution']);
      if (!resolutionRow || !exactKeys(resolutionRow, resolutionRow['state'] === 'authenticated'
        ? ['lineage', 'state', 'verifier']
        : ['state']) || !['authenticated', 'missing', 'unavailable', 'degraded']
        .includes(String(resolutionRow['state']))) return null;
      if (resolutionRow['state'] !== 'authenticated') continue;
      const copied = validateHistoricalVerificationResolution(resolutionRow, expectedLineage);
      if (!copied) return null;
      resolved.set(expectedDigest, copied);
    }
    return resolved;
  } catch {
    return null;
  }
}

function historicalResolutionFromIndex(
  index: ReadonlyMap<string, AuthenticatedHistoricalVerificationResolution>,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  receipt: AgentOsEpochAttemptReceiptV2,
): AuthenticatedHistoricalVerificationResolution | null {
  const lineage = historicalLineage({
    epoch: receipt.epoch,
    attemptNamespaceDigest: receipt.attemptNamespaceDigest,
    sourceBundleDigest: receipt.sourceBundleDigest,
    trustPolicyDigest: receipt.trustPolicyDigest,
  }, closure, receipt.authenticatorKeyId);
  const digest = agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage);
  return digest ? index.get(digest) ?? null : null;
}

function historicalResolutionMatches(
  resolution: AuthenticatedHistoricalResolution | null,
  generation: number,
): resolution is AuthenticatedHistoricalResolution {
  return resolution?.state === 'authenticated' &&
    resolution.lineage.attemptAuthenticatorGeneration === generation;
}

function pinDependencies(value: AgentOsEpochAttemptStoreDependenciesV1): PinnedDependencies | null {
  try {
    if (!value || typeof value !== 'object' ||
      !isAgentOsEpochStorePlatformSupportedV1(process.platform) ||
      !isAgentOsPrefixedSha256DigestV1(value.writerProtocolDigest) ||
      !value.activeClosureProvider ||
      typeof value.activeClosureProvider.readAuthenticatedClosure !== 'function' ||
      !value.historicalSourceLineageProvider ||
      typeof value.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSource !== 'function' ||
      typeof value.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSources !== 'function' ||
      (value.signer !== null && typeof value.signer.authenticate !== 'function') ||
      (value.runtimeCommitGuard !== undefined && (() => {
        const guard = record(value.runtimeCommitGuard);
        return !guard || !exactKeys(guard, ['isCommitAuthorized']) ||
          typeof guard['isCommitAuthorized'] !== 'function';
      })()) ||
      (value.snapshotV2ExistenceVerifier !== undefined &&
        typeof value.snapshotV2ExistenceVerifier.verifyExactBindings !== 'function')) return null;
    const anchorPath = resolve(value.anchorPath);
    const epochStoreRootPath = resolve(value.epochStoreRootPath);
    const maxRecords = value.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!isAbsolute(value.anchorPath) || !isAbsolute(value.epochStoreRootPath) ||
      value.anchorPath !== anchorPath || value.epochStoreRootPath !== epochStoreRootPath ||
      anchorPath === parse(anchorPath).root || dirname(epochStoreRootPath) !== anchorPath ||
      basename(epochStoreRootPath) !== 'agent-os-epochs' ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 2 || maxRecords > HARD_MAX_RECORDS) return null;
    return { ...value, anchorPath, epochStoreRootPath, maxRecords };
  } catch {
    return null;
  }
}

function readClosure(
  dependencies: PinnedDependencies,
): Readonly<AgentOsAuthenticatedActiveEpochAttemptClosureV1> | null {
  try {
    if (!operationSafe(dependencies)) return null;
    const read = dependencies.activeClosureProvider.readAuthenticatedClosure();
    if (!operationSafe(dependencies) || !read || read.state !== 'authenticated' || !validClosure(read.closure) ||
      read.closure.writerProtocolDigest !== dependencies.writerProtocolDigest) return null;
    return cloneClosure(read.closure);
  } catch {
    return null;
  }
}

function epochPaths(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): { epochPath: string; attemptsPath: string } {
  const epochPath = join(
    dependencies.epochStoreRootPath,
    'epochs',
    `epoch-${epochToken(closure.epoch)}`,
  );
  return { epochPath, attemptsPath: join(epochPath, 'attempts') };
}

function attemptRootReady(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): boolean {
  try {
    const { epochPath, attemptsPath } = epochPaths(dependencies, closure);
    const epoch = lstatSync(epochPath, { bigint: true });
    const attempts = lstatSync(attemptsPath, { bigint: true });
    return privateDirectory(epoch) && privateDirectory(attempts) &&
      !(epoch.dev === attempts.dev && epoch.ino === attempts.ino) &&
      assurePrivateStoragePath(epochPath, 'directory', 'inspect-existing', {
        anchorPath: dependencies.anchorPath,
      }).ok && assurePrivateStoragePath(attemptsPath, 'directory', 'inspect-existing', {
        anchorPath: epochPath,
      }).ok;
  } catch {
    return false;
  }
}

function pristineAttemptRoot(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
): boolean {
  if (!attemptRootReady(dependencies, closure)) return false;
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(epochPaths(dependencies, closure).attemptsPath);
    return directory.readSync() === null;
  } catch {
    return false;
  } finally {
    if (directory) {
      try { directory.closeSync(); } catch { /* best effort */ }
    }
  }
}

function contextVerifierFor(
  expected: AgentOsEpochAttemptClosureContextV2,
): { verify(context: Readonly<AgentOsEpochAttemptClosureContextV2>): boolean } {
  return {
    verify(context) {
      const row = record(context);
      return Boolean(row && exactKeys(row, [
        'attemptNamespaceDigest', 'epoch', 'sourceBundleDigest', 'trustPolicyDigest',
      ]) && context.epoch === expected.epoch &&
        context.attemptNamespaceDigest === expected.attemptNamespaceDigest &&
        context.sourceBundleDigest === expected.sourceBundleDigest &&
        context.trustPolicyDigest === expected.trustPolicyDigest);
    },
  };
}

function receiptCodec(
  dependencies: PinnedDependencies,
  activeClosure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  authentication: 'point' | 'structural' = 'point',
): ImmutablePrivateRecordCodec<AgentOsEpochAttemptReceiptV2> {
  return {
    parse: (value) => {
      const canonical = canonicalAgentOsEpochAttemptReceiptBytesV2(value);
      const receipt = canonical ? parseAgentOsEpochAttemptReceiptV2(canonical) : null;
      if (!receipt || receipt.epoch !== activeClosure.epoch ||
        receipt.attemptNamespaceDigest !== activeClosure.attemptNamespaceDigest) return null;
      if (authentication === 'structural') return receipt;
      const context: AgentOsEpochAttemptClosureContextV2 = {
        epoch: receipt.epoch,
        attemptNamespaceDigest: receipt.attemptNamespaceDigest,
        sourceBundleDigest: receipt.sourceBundleDigest,
        trustPolicyDigest: receipt.trustPolicyDigest,
      };
      const resolution = resolveHistoricalLineage(
        dependencies, activeClosure, context, receipt.authenticatorKeyId,
      );
      if (!resolution) return null;
      const verified = verifyAgentOsEpochAttemptReceiptV2(
        receipt,
        context,
        resolution.verifier,
        contextVerifierFor(context),
      );
      return operationSafe(dependencies) ? verified : null;
    },
    serialize: (receipt) => {
      const bytes = canonicalAgentOsEpochAttemptReceiptBytesV2(receipt);
      if (!bytes) throw new TypeError('attempt receipt is not canonical');
      return `${bytes.toString('utf8')}\n`;
    },
    recordId: (receipt) => attemptSlot(receipt),
    recordFileName: (receipt) => `${attemptSlot(receipt)}.json`,
    isRecordFileName: (fileName) => RECORD_FILE_RE.test(fileName),
    stageToken: (receipt) => receipt.authenticator.slice(0, 32),
    equivalent: (left, right) => left.attemptId === right.attemptId &&
      left.transitionOrdinal === right.transitionOrdinal &&
      sameDigest(left.receiptDigest, right.receiptDigest) &&
      sameDigest(left.authenticator, right.authenticator),
    compare: (left, right) => left.attemptId.localeCompare(right.attemptId) ||
      left.transitionOrdinal - right.transitionOrdinal,
  };
}

function storeConfig(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  authentication: 'point' | 'structural' = 'point',
): ImmutablePrivateRecordStoreConfig<AgentOsEpochAttemptReceiptV2> | null {
  const { epochPath, attemptsPath } = epochPaths(dependencies, closure);
  const codec = receiptCodec(dependencies, closure, authentication);
  return {
    label: 'Agent OS epoch attempt V2',
    anchorPath: epochPath,
    rootPath: attemptsPath,
    lockFileName: ATTEMPT_STORE_LOCK,
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: dependencies.maxRecords,
    hardMaxFiles: dependencies.maxRecords,
    defaultMaxBytes: Math.min(DEFAULT_MAX_BYTES, dependencies.maxRecords * MAX_RECORD_BYTES),
    hardMaxBytes: Math.min(HARD_MAX_BYTES, dependencies.maxRecords * MAX_RECORD_BYTES),
    codecForWrite: () => codec,
    codecForRead: () => codec,
  };
}

function snapshotBinding(
  activeClosure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  sourceContext: AgentOsEpochAttemptClosureContextV2,
  attemptId: string,
  producerStartReceiptDigest: string,
  snapshotEnvelopeDigest: string,
): Readonly<AgentOsEpochSnapshotV2BindingVerificationInputV1> {
  return deepFreeze({
    epoch: activeClosure.epoch,
    epochHeadDigest: activeClosure.epochHeadDigest,
    attemptNamespaceDigest: activeClosure.attemptNamespaceDigest,
    attemptId,
    producerStartReceiptDigest,
    sourceBundleDigest: sourceContext.sourceBundleDigest,
    trustPolicyDigest: sourceContext.trustPolicyDigest,
    snapshotEnvelopeDigest,
  });
}

export function agentOsEpochSnapshotBindingDigestV1(
  binding: AgentOsEpochSnapshotV2BindingVerificationInputV1,
): string | null {
  const row = record(binding);
  if (!row || !exactKeys(row, [
    'attemptId', 'attemptNamespaceDigest', 'epoch', 'epochHeadDigest',
    'producerStartReceiptDigest', 'snapshotEnvelopeDigest', 'sourceBundleDigest',
    'trustPolicyDigest',
  ]) || !validEpoch(row['epoch']) ||
    !isAgentOsPrefixedSha256DigestV1(row['epochHeadDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(row['attemptId']) ||
    !isAgentOsRawSha256DigestV1(row['producerStartReceiptDigest']) ||
    !isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) ||
    !isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) ||
    !isAgentOsRawSha256DigestV1(row['snapshotEnvelopeDigest'])) return null;
  const canonical = JSON.stringify({
    attemptId: row['attemptId'],
    attemptNamespaceDigest: row['attemptNamespaceDigest'],
    epoch: row['epoch'],
    epochHeadDigest: row['epochHeadDigest'],
    producerStartReceiptDigest: row['producerStartReceiptDigest'],
    snapshotEnvelopeDigest: row['snapshotEnvelopeDigest'],
    sourceBundleDigest: row['sourceBundleDigest'],
    trustPolicyDigest: row['trustPolicyDigest'],
  });
  return `sha256:${createHash('sha256')
    .update(AGENT_OS_EPOCH_SNAPSHOT_BINDING_DIGEST_DOMAIN_V1, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex')}`;
}

export function agentOsEpochSnapshotBindingSetDigestV1(
  bindingDigests: ReadonlyArray<string>,
): string | null {
  if (!Array.isArray(bindingDigests) || bindingDigests.length < 1 ||
    bindingDigests.length > HARD_MAX_RECORDS ||
    bindingDigests.some((digest) => !isAgentOsPrefixedSha256DigestV1(digest))) return null;
  const sorted = [...bindingDigests].sort();
  if (new Set(sorted).size !== sorted.length ||
    sorted.some((digest, index) => digest !== bindingDigests[index])) return null;
  return `sha256:${createHash('sha256')
    .update(AGENT_OS_EPOCH_SNAPSHOT_BINDING_SET_DIGEST_DOMAIN_V1, 'utf8')
    .update(JSON.stringify(sorted), 'utf8')
    .digest('hex')}`;
}

function verifySnapshotBindingBatch(
  dependencies: PinnedDependencies,
  bindings: readonly AgentOsEpochSnapshotV2BindingVerificationInputV1[],
): ReadonlySet<string> | null {
  if (!dependencies.snapshotV2ExistenceVerifier || bindings.length < 1 ||
    bindings.length > dependencies.maxRecords) return null;
  const indexed = bindings.map((binding) => ({
    binding,
    digest: agentOsEpochSnapshotBindingDigestV1(binding),
  }));
  if (indexed.some(({ digest }) => digest === null)) return null;
  indexed.sort((left, right) => left.digest!.localeCompare(right.digest!));
  const digests = indexed.map(({ digest }) => digest!);
  const inputSetDigest = agentOsEpochSnapshotBindingSetDigestV1(digests);
  if (!inputSetDigest) return null;
  const request = deepFreeze({
    protocol: AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1,
    inputSetDigest,
    bindings: indexed.map(({ binding }) => ({ ...binding })),
  });
  try {
    if (!operationSafe(dependencies)) return null;
    const result = dependencies.snapshotV2ExistenceVerifier.verifyExactBindings(request);
    if (!operationSafe(dependencies) || request.inputSetDigest !== inputSetDigest ||
      agentOsEpochSnapshotBindingSetDigestV1(
        request.bindings.map((binding) => agentOsEpochSnapshotBindingDigestV1(binding) ?? ''),
      ) !== inputSetDigest) return null;
    const row = record(result);
    if (!row) return null;
    if (row['state'] !== 'authenticated' || !exactKeys(row, [
      'decisions', 'inputSetDigest', 'state',
    ]) || row['inputSetDigest'] !== inputSetDigest || !Array.isArray(row['decisions']) ||
      row['decisions'].length !== digests.length) return null;
    const verified = new Set<string>();
    for (let index = 0; index < digests.length; index += 1) {
      const decision = record(row['decisions'][index]);
      if (!decision || !exactKeys(decision, ['bindingDigest', 'verified']) ||
        decision['bindingDigest'] !== digests[index] || typeof decision['verified'] !== 'boolean') return null;
      if (decision['verified']) verified.add(digests[index]!);
    }
    return Object.freeze(verified);
  } catch {
    return null;
  }
}

function verifiesSnapshotBinding(
  dependencies: PinnedDependencies,
  activeClosure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  sourceContext: AgentOsEpochAttemptClosureContextV2,
  attemptId: string,
  producerStartReceiptDigest: string,
  snapshotEnvelopeDigest: string | null,
): boolean {
  if (snapshotEnvelopeDigest === null) return false;
  const binding = snapshotBinding(
    activeClosure, sourceContext, attemptId, producerStartReceiptDigest, snapshotEnvelopeDigest,
  );
  const digest = agentOsEpochSnapshotBindingDigestV1(binding);
  return digest !== null && verifySnapshotBindingBatch(dependencies, [binding])?.has(digest) === true;
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
  expectedClosure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
  sourceContext: AgentOsEpochAttemptClosureContextV2,
  attemptAuthenticatorKeyId: string,
  attemptAuthenticatorGeneration: number,
  closureMode: 'exact-current-source' | 'same-epoch-historical-source',
  successfulSnapshot?: {
    attemptId: string;
    producerStartReceiptDigest: string;
    snapshotEnvelopeDigest: string;
  },
): boolean {
  if (!operationSafe(dependencies) || !runtimeCommitAllowed(dependencies) ||
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned') return false;
  const fresh = readClosure(dependencies);
  const closureMatches = fresh && (closureMode === 'exact-current-source'
    ? sameClosure(expectedClosure, fresh)
    : sameEpochIdentity(expectedClosure, fresh));
  if (!fresh || !closureMatches || !attemptRootReady(dependencies, fresh) ||
    !historicalResolutionMatches(resolveHistoricalLineage(
      dependencies, fresh, sourceContext, attemptAuthenticatorKeyId,
    ), attemptAuthenticatorGeneration)) return false;
  if (successfulSnapshot && !verifiesSnapshotBinding(
    dependencies,
    fresh,
    sourceContext,
    successfulSnapshot.attemptId,
    successfulSnapshot.producerStartReceiptDigest,
    successfulSnapshot.snapshotEnvelopeDigest,
  )) return false;
  if (ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned' ||
    !runtimeCommitAllowed(dependencies)) return false;
  const finalClosure = readClosure(dependencies);
  return finalClosure !== null &&
    (closureMode === 'exact-current-source'
      ? sameClosure(expectedClosure, finalClosure)
      : sameEpochIdentity(expectedClosure, finalClosure)) &&
    historicalResolutionMatches(resolveHistoricalLineage(
      dependencies, finalClosure, sourceContext, attemptAuthenticatorKeyId,
    ), attemptAuthenticatorGeneration) &&
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) === 'owned' &&
    runtimeCommitAllowed(dependencies);
}

function writeResult(
  disposition: AgentOsEpochAttemptStoreWriteResultV1['disposition'],
  reason: AgentOsEpochAttemptStoreWriteReasonV1,
  receipt: AgentOsEpochAttemptReceiptV2 | null = null,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1 | null = null,
  closureAuthenticated = false,
  durable = false,
): AgentOsEpochAttemptStoreWriteResultV1 {
  return deepFreeze({
    disposition,
    reason,
    receipt,
    epoch: closure?.epoch ?? null,
    attemptId: receipt?.attemptId ?? null,
    closureAuthenticated,
    durable,
    ...AUTHORITY,
  });
}

function emptyRead(
  sourceState: AgentOsEpochAttemptStoreReadResultV1['sourceState'],
  stopReasons: AgentOsEpochAttemptStoreStopReasonV1[],
  overrides: Partial<AgentOsEpochAttemptStoreReadResultV1> = {},
): AgentOsEpochAttemptStoreReadResultV1 {
  return deepFreeze({
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState === 'healthy',
    records: [],
    attemptSetDigest: null,
    openAttempts: 0,
    epoch: null,
    epochHeadDigest: null,
    attemptNamespaceDigest: null,
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

export function agentOsEpochAttemptSetDigestV1(
  input: AgentOsEpochAttemptSetDigestInputV1,
): string | null {
  try {
    const row = record(input);
    if (!row || !exactKeys(row, ['attemptNamespaceDigest', 'epoch', 'receipts']) ||
      !validEpoch(row['epoch']) ||
      !isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) ||
      !Array.isArray(row['receipts']) || row['receipts'].length > HARD_MAX_RECORDS) return null;
    const normalized = row['receipts'].map((value) => {
      const receipt = record(value);
      if (!receipt || !exactKeys(receipt, ['attemptId', 'receiptDigest', 'transitionOrdinal']) ||
        !isAgentOsPrefixedSha256DigestV1(receipt['attemptId']) ||
        ![1, 2].includes(receipt['transitionOrdinal'] as number) ||
        !isAgentOsRawSha256DigestV1(receipt['receiptDigest'])) throw new TypeError('invalid receipt');
      return {
        attemptId: receipt['attemptId'] as string,
        transitionOrdinal: receipt['transitionOrdinal'] as 1 | 2,
        receiptDigest: receipt['receiptDigest'] as string,
      };
    }).sort((left, right) => left.attemptId.localeCompare(right.attemptId) ||
      left.transitionOrdinal - right.transitionOrdinal);
    const slots = normalized.map((value) => `${value.attemptId}:${value.transitionOrdinal}`);
    if (new Set(slots).size !== slots.length) return null;
    const canonical = JSON.stringify({
      attemptNamespaceDigest: row['attemptNamespaceDigest'],
      epoch: row['epoch'],
      receipts: normalized,
    });
    return `sha256:${createHash('sha256')
      .update(AGENT_OS_EPOCH_ATTEMPT_SET_DOMAIN_V1, 'utf8')
      .update(canonical, 'utf8')
      .digest('hex')}`;
  } catch {
    return null;
  }
}

function transitionIssues(
  records: readonly AgentOsEpochAttemptReceiptV2[],
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  historicalIndex: ReadonlyMap<string, AuthenticatedHistoricalVerificationResolution>,
): AgentOsEpochAttemptStoreStopReasonV1[] {
  const reasons = new Set<AgentOsEpochAttemptStoreStopReasonV1>();
  const successBindings: AgentOsEpochSnapshotV2BindingVerificationInputV1[] = [];
  const byAttempt = new Map<string, AgentOsEpochAttemptReceiptV2[]>();
  for (const receipt of records) {
    const current = byAttempt.get(receipt.attemptId) ?? [];
    current.push(receipt);
    byAttempt.set(receipt.attemptId, current);
  }
  for (const attempt of byAttempt.values()) {
    const starts = attempt.filter((receipt) => receipt.transitionOrdinal === 1);
    const terminals = attempt.filter((receipt) => receipt.transitionOrdinal === 2);
    if (starts.length > 1 || terminals.length > 1) reasons.add('transition-fork');
    if (terminals.length > 0 && starts.length === 0) reasons.add('transition-gap');
    if (starts.length === 1 && terminals.length === 1) {
      const start = starts[0]!;
      const context: AgentOsEpochAttemptClosureContextV2 = {
        epoch: start.epoch,
        attemptNamespaceDigest: start.attemptNamespaceDigest,
        sourceBundleDigest: start.sourceBundleDigest,
        trustPolicyDigest: start.trustPolicyDigest,
      };
      const resolution = historicalResolutionFromIndex(historicalIndex, closure, start);
      const verified = resolution && terminals[0]!.authenticatorKeyId === start.authenticatorKeyId
        ? verifyAgentOsEpochAttemptTransitionV2(
            start, terminals[0], context, resolution.verifier, contextVerifierFor(context),
          )
        : null;
      if (!operationSafe(dependencies) || !verified) reasons.add('invalid-transition');
    }
    for (const terminal of terminals) {
      const terminalContext: AgentOsEpochAttemptClosureContextV2 = {
        epoch: terminal.epoch,
        attemptNamespaceDigest: terminal.attemptNamespaceDigest,
        sourceBundleDigest: terminal.sourceBundleDigest,
        trustPolicyDigest: terminal.trustPolicyDigest,
      };
      if (terminal.outcome === 'succeeded' && terminal.snapshotEnvelopeDigest !== null) {
        successBindings.push(snapshotBinding(
          closure,
          terminalContext,
          terminal.attemptId,
          starts[0]?.receiptDigest ?? AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
          terminal.snapshotEnvelopeDigest,
        ));
      }
    }
  }
  if (successBindings.length > 0) {
    const verified = verifySnapshotBindingBatch(dependencies, successBindings);
    if (!verified || successBindings.some((binding) => {
      const digest = agentOsEpochSnapshotBindingDigestV1(binding);
      return digest === null || !verified.has(digest);
    })) reasons.add('snapshot-v2-unverified');
  }
  return [...reasons];
}

function verifyReceiptFromHistoricalIndex(
  receipt: AgentOsEpochAttemptReceiptV2,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  historicalIndex: ReadonlyMap<string, AuthenticatedHistoricalVerificationResolution>,
): AgentOsEpochAttemptReceiptV2 | null {
  const resolution = historicalResolutionFromIndex(historicalIndex, closure, receipt);
  if (!resolution) return null;
  const context: AgentOsEpochAttemptClosureContextV2 = {
    epoch: receipt.epoch,
    attemptNamespaceDigest: receipt.attemptNamespaceDigest,
    sourceBundleDigest: receipt.sourceBundleDigest,
    trustPolicyDigest: receipt.trustPolicyDigest,
  };
  return verifyAgentOsEpochAttemptReceiptV2(
    receipt, context, resolution.verifier, contextVerifierFor(context),
  );
}

function readForClosure(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochAttemptStoreReadResultV1 {
  if (!attemptRootReady(dependencies, closure)) {
    return emptyRead('missing', ['attempt-root-missing'], {
      epoch: closure.epoch,
      epochHeadDigest: closure.epochHeadDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      closureAuthenticated: true,
    });
  }
  if (pristineAttemptRoot(dependencies, closure)) {
    return emptyRead('healthy', [], {
      sourcePresent: true,
      complete: true,
      attemptSetDigest: agentOsEpochAttemptSetDigestV1({
        epoch: closure.epoch,
        attemptNamespaceDigest: closure.attemptNamespaceDigest,
        receipts: [],
      }),
      epoch: closure.epoch,
      epochHeadDigest: closure.epochHeadDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      closureAuthenticated: true,
    });
  }
  const config = storeConfig(dependencies, closure, 'structural');
  if (!config) return emptyRead('degraded', ['verifier-unavailable']);
  const raw = readImmutablePrivateRecords(config, { ...options, requireComplete: false });
  const historicalIndex = resolveHistoricalLineageBatch(dependencies, closure, raw.records);
  if (historicalIndex === null) {
    return emptyRead('degraded', ['verifier-unavailable'], {
      sourcePresent: raw.sourcePresent,
      epoch: closure.epoch,
      epochHeadDigest: closure.epochHeadDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
      capacityExhausted: raw.records.length >= dependencies.maxRecords,
      closureAuthenticated: true,
    });
  }
  const authenticatedRecords = raw.records.map((receipt) =>
    verifyReceiptFromHistoricalIndex(receipt, closure, historicalIndex)).filter(
    (receipt): receipt is AgentOsEpochAttemptReceiptV2 => receipt !== null,
  );
  const authenticationFailures = raw.records.length - authenticatedRecords.length;
  const freshClosure = readClosure(dependencies);
  if (!operationSafe(dependencies) || !freshClosure || !sameEpochIdentity(closure, freshClosure)) {
    return emptyRead('degraded', ['closure-changed'], {
      sourcePresent: raw.sourcePresent,
      epoch: closure.epoch,
      epochHeadDigest: closure.epochHeadDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles + authenticationFailures,
      limitExceeded: raw.limitExceeded,
      capacityExhausted: raw.records.length >= dependencies.maxRecords,
    });
  }
  const issues = transitionIssues(authenticatedRecords, dependencies, closure, historicalIndex);
  const stopReasons = [...new Set<AgentOsEpochAttemptStoreStopReasonV1>([
    ...raw.stopReasons,
    ...(authenticationFailures > 0 ? ['invalid-file' as const] : []),
    ...issues,
    ...(raw.records.length >= dependencies.maxRecords ? ['capacity-exhausted' as const] : []),
  ])];
  const degraded = raw.sourceState === 'degraded' || authenticationFailures > 0 || issues.length > 0;
  const records = degraded && options.requireComplete !== false ? [] : authenticatedRecords;
  const starts = authenticatedRecords.filter((receipt) => receipt.transitionOrdinal === 1);
  const terminals = new Set(authenticatedRecords.filter((receipt) => receipt.transitionOrdinal === 2)
    .map((receipt) => receipt.attemptId));
  const attemptSetDigest = degraded ? null : agentOsEpochAttemptSetDigestV1({
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    receipts: authenticatedRecords.map(({ attemptId, transitionOrdinal, receiptDigest }) => ({
      attemptId, transitionOrdinal, receiptDigest,
    })),
  });
  return deepFreeze({
    ...raw,
    sourceState: degraded ? 'degraded' : 'healthy',
    complete: !degraded,
    records,
    attemptSetDigest,
    openAttempts: starts.filter((receipt) => !terminals.has(receipt.attemptId)).length,
    epoch: closure.epoch,
    epochHeadDigest: closure.epochHeadDigest,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    stopReasons,
    invalidFiles: raw.invalidFiles + authenticationFailures,
    capacityExhausted: raw.records.length >= dependencies.maxRecords,
    closureAuthenticated: true,
    ...AUTHORITY,
  });
}

function readAgentOsEpochAttemptReceiptsV2Impl(
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochAttemptStoreReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) {
    return emptyRead('degraded', [isAgentOsEpochStorePlatformSupportedV1(process.platform)
      ? 'closure-unavailable'
      : 'platform-unsupported']);
  }
  const closure = readClosure(dependencies);
  if (!closure) return emptyRead('degraded', ['closure-unavailable']);
  const result = readForClosure(dependencies, closure, options);
  const finalClosure = readClosure(dependencies);
  if (!finalClosure || !sameEpochIdentity(closure, finalClosure)) {
    return emptyRead('degraded', ['closure-changed'], {
      sourcePresent: result.sourcePresent,
      epoch: closure.epoch,
      epochHeadDigest: closure.epochHeadDigest,
      attemptNamespaceDigest: closure.attemptNamespaceDigest,
    });
  }
  return result;
}

export function readAgentOsEpochAttemptReceiptsV2(
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochAttemptStoreReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return readAgentOsEpochAttemptReceiptsV2Impl(suppliedDependencies, options);
  const operation = enterRootOperation(dependencies.epochStoreRootPath, 'read');
  if (!operation) return emptyRead('degraded', ['reentrant-call']);
  try {
    const result = readAgentOsEpochAttemptReceiptsV2Impl(dependencies, options);
    return operation.state.reentered
      ? emptyRead('degraded', ['reentrant-call'], {
          sourcePresent: result.sourcePresent,
          epoch: result.epoch,
          epochHeadDigest: result.epochHeadDigest,
          attemptNamespaceDigest: result.attemptNamespaceDigest,
        })
      : result;
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

/** Reciprocal M560 seam backed by the complete authenticated M557 ledger. */
export function createAgentOsEpochAttemptStartReceiptProviderV1(
  dependencies: AgentOsEpochAttemptStoreDependenciesV1,
): AgentOsEpochAttemptStartReceiptProviderV1 {
  return Object.freeze({
    readAuthenticatedStartReceipt(query: Readonly<AgentOsEpochAttemptStartReceiptQueryV1>) {
      const row = record(query);
      if (!row || !exactKeys(row, [
        'anchoredHeadDigest', 'attemptNamespaceDigest', 'durableTickDigest', 'epoch',
        'epochManifestDigest', 'producerAttemptId',
      ]) || !validEpoch(row['epoch']) ||
        !isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) ||
        !isAgentOsPrefixedSha256DigestV1(row['producerAttemptId']) ||
        !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) ||
        !isAgentOsPrefixedSha256DigestV1(row['anchoredHeadDigest']) ||
        !isAgentOsPrefixedSha256DigestV1(row['epochManifestDigest'])) {
        return { state: 'degraded' as const };
      }
      const closure = pinDependencies(dependencies);
      if (!closure) return { state: 'unavailable' as const };
      const operation = enterRootOperation(closure.epochStoreRootPath, 'point');
      if (!operation) return { state: 'degraded' as const };
      try {
        const active = readClosure(closure);
        if (!active || active.epoch !== row['epoch'] ||
          active.attemptNamespaceDigest !== row['attemptNamespaceDigest'] ||
          active.epochHeadDigest !== row['anchoredHeadDigest'] ||
          active.epochManifestDigest !== row['epochManifestDigest']) {
          return { state: 'degraded' as const };
        }
        const start = readPublishedStartPointDuringTransaction(
          closure, active, row['producerAttemptId'] as string,
        );
        const finalClosure = readClosure(closure);
        if (!start || operation.state.reentered || !finalClosure ||
          !sameEpochIdentity(active, finalClosure) || start.transitionOrdinal !== 1 ||
          start.epoch !== row['epoch'] ||
          start.attemptNamespaceDigest !== row['attemptNamespaceDigest'] ||
          start.attemptId !== row['producerAttemptId'] ||
          start.durableTickDigest !== row['durableTickDigest']) {
          return start ? { state: 'degraded' as const } : { state: 'missing' as const };
        }
        return Object.freeze({
          state: 'authenticated' as const,
          startReceiptDigest: start.receiptDigest,
          sourceBundleDigest: start.sourceBundleDigest,
          trustPolicyDigest: start.trustPolicyDigest,
        });
      } finally {
        leaveRootOperation(closure.epochStoreRootPath, operation);
      }
    },
  });
}

function pointRead(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  attemptId: string,
  ordinal: 1 | 2,
): AgentOsEpochAttemptReceiptV2 | null {
  const config = storeConfig(dependencies, closure);
  if (!config) return null;
  const slot = `${attemptId.slice(7)}.${ordinal}`;
  const read = readImmutablePrivateRecordPoint(config, slot, `${slot}.json`);
  return read.sourceState === 'healthy' && read.exactReadComplete ? read.record : null;
}

/**
 * Reads one already-published immutable receipt while the same process may hold
 * the store publication lock for a different slot. It deliberately ignores
 * staging and never traverses terminal receipts or invokes snapshot callbacks.
 */
function readPublishedStartPointDuringTransaction(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  attemptId: string,
): AgentOsEpochAttemptReceiptV2 | null {
  let fd: number | undefined;
  try {
    if (!isAgentOsPrefixedSha256DigestV1(attemptId) || !attemptRootReady(dependencies, closure)) return null;
    const { attemptsPath } = epochPaths(dependencies, closure);
    const recordsPath = join(attemptsPath, 'records');
    const filePath = join(recordsPath, `${attemptId.slice(7)}.1.json`);
    const records = lstatSync(recordsPath, { bigint: true });
    if (!privateDirectory(records) ||
      !assurePrivateStoragePath(recordsPath, 'directory', 'inspect-existing', {
        anchorPath: attemptsPath,
      }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const opened = fstatSync(fd, { bigint: true });
    attemptStoreTestHooks?.afterPublishedStartOpen?.(filePath);
    const namedBefore = lstatSync(filePath, { bigint: true });
    if (!privateFile(opened) || !privateFile(namedBefore) ||
      !sameIdentity(opened, namedBefore) || opened.size !== namedBefore.size ||
      opened.size < 2n || opened.size > BigInt(MAX_RECORD_BYTES) ||
      !assurePrivateStoragePath(filePath, 'file', 'inspect-existing', {
        anchorPath: attemptsPath,
      }).ok) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(filePath, { bigint: true });
    if (!privateFile(after) || !privateFile(named) || !sameIdentity(opened, after) ||
      !sameIdentity(opened, named) || opened.size !== after.size ||
      bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) return null;
    const value: unknown = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
    return receiptCodec(dependencies, closure).parse(value);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function persistReceipt(
  dependencies: PinnedDependencies,
  closure: AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  receipt: AgentOsEpochAttemptReceiptV2,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
  closureMode: 'exact-current-source' | 'same-epoch-historical-source',
  attemptAuthenticatorGeneration: number,
  successfulSnapshot?: {
    attemptId: string;
    producerStartReceiptDigest: string;
    snapshotEnvelopeDigest: string;
  },
): AgentOsEpochAttemptStoreWriteResultV1 {
  const config = storeConfig(dependencies, closure);
  if (!config) return writeResult('unavailable', 'verifier-unavailable', null, closure, true);
  let guardFailed = false;
  const sourceContext: AgentOsEpochAttemptClosureContextV2 = {
    epoch: receipt.epoch,
    attemptNamespaceDigest: receipt.attemptNamespaceDigest,
    sourceBundleDigest: receipt.sourceBundleDigest,
    trustPolicyDigest: receipt.trustPolicyDigest,
  };
  const publication = writeImmutablePrivateRecord(config, receipt, {
    lockWaitMs: MAX_LOCK_WAIT_MS,
    prepublish: () => {
      const allowed = liveCommitGuard(
        dependencies,
        closure,
        coordinationLease,
        observationLock,
        sourceContext,
        receipt.authenticatorKeyId,
        attemptAuthenticatorGeneration,
        closureMode,
        successfulSnapshot,
      );
      guardFailed ||= !allowed;
      return allowed;
    },
  });
  if (guardFailed) return writeResult('withheld', 'closure-changed', null, closure, false);
  if (publication === 'conflicted') {
    return writeResult('conflicted', 'publication-conflict', null, closure, true);
  }
  if (publication !== 'recorded' && publication !== 'replayed') {
    return writeResult('failed', 'publication-failed', null, closure, true);
  }
  const persisted = pointRead(
    dependencies, closure, receipt.attemptId, receipt.transitionOrdinal,
  );
  const exactPersisted = persisted !== null && sameDigest(persisted.receiptDigest, receipt.receiptDigest);
  if (!exactPersisted ||
    !liveCommitGuard(
      dependencies,
      closure,
      coordinationLease,
      observationLock,
      sourceContext,
      receipt.authenticatorKeyId,
      attemptAuthenticatorGeneration,
      closureMode,
      successfulSnapshot,
    )) {
    return writeResult('failed', 'closure-changed', null, closure, false, exactPersisted);
  }
  return writeResult(
    publication === 'replayed' ? 'replayed' : 'recorded',
    publication === 'replayed' ? 'receipt-replay' : 'recorded',
    persisted,
    closure,
    true,
    true,
  );
}

function writeSetup(
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
):
  | { ok: true; dependencies: PinnedDependencies; closure: Readonly<AgentOsAuthenticatedActiveEpochAttemptClosureV1> }
  | { ok: false; result: AgentOsEpochAttemptStoreWriteResultV1 } {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) {
    return { ok: false, result: writeResult('withheld',
      isAgentOsEpochStorePlatformSupportedV1(process.platform) ? 'invalid-input' : 'platform-unsupported') };
  }
  const ownership = ownsWriteCapabilities(dependencies, coordinationLease, observationLock);
  if (ownership !== 'owned') return { ok: false, result: writeResult('withheld', ownership) };
  const closure = readClosure(dependencies);
  if (!closure) return { ok: false, result: writeResult('unavailable', 'closure-unavailable') };
  if (!attemptRootReady(dependencies, closure)) {
    return { ok: false, result: writeResult('unavailable', 'chain-unavailable', null, closure, true) };
  }
  const activeResolution = resolveHistoricalLineage(
    dependencies, closure, closureContext(closure), closure.attemptAuthenticatorKeyId,
  );
  if (!historicalResolutionMatches(activeResolution, closure.attemptAuthenticatorGeneration)) {
    return { ok: false, result: writeResult('unavailable', 'verifier-unavailable', null, closure, false) };
  }
  const config = storeConfig(dependencies, closure);
  if (!config) return { ok: false, result: writeResult('unavailable', 'verifier-unavailable') };
  const initialized = initializeImmutablePrivateRecordStoreLayout(config, {
    lockWaitMs: MAX_LOCK_WAIT_MS,
    guard: () => liveCommitGuard(
      dependencies,
      closure,
      coordinationLease,
      observationLock,
      closureContext(closure),
      closure.attemptAuthenticatorKeyId,
      closure.attemptAuthenticatorGeneration,
      'same-epoch-historical-source',
    ),
  });
  if (initialized === 'withheld') {
    return { ok: false, result: writeResult('withheld', 'closure-changed', null, closure, false) };
  }
  if (initialized === 'failed' || initialized === 'invalid' || initialized === 'missing') {
    return { ok: false, result: writeResult('unavailable', 'chain-unavailable', null, closure, true) };
  }
  return { ok: true, dependencies, closure };
}

function beginAgentOsEpochAttemptV2Impl(
  input: BeginAgentOsEpochAttemptV2Input,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): AgentOsEpochAttemptStoreWriteResultV1 {
  const row = record(input);
  if (!row || !exactKeys(row, [
    'coordinationLease', 'durableTickDigest', 'observationLock', 'startedAt',
  ]) || !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) ||
    typeof row['startedAt'] !== 'string') return writeResult('withheld', 'invalid-input');
  const setup = writeSetup(suppliedDependencies, input.coordinationLease, input.observationLock);
  if (!setup.ok) return setup.result;
  const { dependencies, closure } = setup;
  if (!dependencies.signer || dependencies.signer.keyId !== closure.attemptAuthenticatorKeyId) {
    return writeResult('unavailable', 'signer-unavailable', null, closure, true);
  }
  const currentResolution = resolveHistoricalLineage(
    dependencies, closure, closureContext(closure), closure.attemptAuthenticatorKeyId,
  );
  if (!historicalResolutionMatches(currentResolution, closure.attemptAuthenticatorGeneration)) {
    return writeResult('unavailable', 'verifier-unavailable', null, closure, false);
  }
  const before = readForClosure(dependencies, closure, { requireComplete: true });
  if (!before.complete) return writeResult('unavailable', 'chain-unavailable', null, closure, true);
  const attemptId = agentOsEpochAttemptIdV1({
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    durableTickDigest: input.durableTickDigest,
  });
  if (!attemptId) return writeResult('withheld', 'invalid-input', null, closure, true);
  const existing = before.records.find((receipt) =>
    receipt.attemptId === attemptId && receipt.transitionOrdinal === 1);
  if (existing) {
    if (existing.durableTickDigest !== input.durableTickDigest || existing.startedAt !== input.startedAt) {
      return writeResult('conflicted', 'publication-conflict', null, closure, true);
    }
    const existingContext: AgentOsEpochAttemptClosureContextV2 = {
      epoch: existing.epoch,
      attemptNamespaceDigest: existing.attemptNamespaceDigest,
      sourceBundleDigest: existing.sourceBundleDigest,
      trustPolicyDigest: existing.trustPolicyDigest,
    };
    return liveCommitGuard(
      dependencies,
      closure,
      input.coordinationLease,
      input.observationLock,
      existingContext,
      existing.authenticatorKeyId,
      resolveHistoricalLineage(
        dependencies, closure, existingContext, existing.authenticatorKeyId,
      )?.lineage.attemptAuthenticatorGeneration ?? -1,
      'same-epoch-historical-source',
    )
      ? writeResult('replayed', 'receipt-replay', existing, closure, true, true)
      : writeResult('withheld', 'closure-changed', null, closure, false);
  }
  if (before.records.length >= dependencies.maxRecords) {
    return writeResult('withheld', 'capacity-exhausted', null, closure, true);
  }
  const receipt = createAgentOsEpochAttemptReceiptV2({
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    durableTickDigest: input.durableTickDigest,
    transitionOrdinal: 1,
    previousReceiptDigest: AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
    outcome: null,
    sourceBundleDigest: closure.sourceBundleDigest,
    trustPolicyDigest: closure.trustPolicyDigest,
    snapshotEnvelopeDigest: null,
    startedAt: input.startedAt,
    completedAt: null,
  }, dependencies.signer!);
  if (!receipt) return writeResult('withheld', 'invalid-input', null, closure, true);
  return persistReceipt(
    dependencies,
    closure,
    receipt,
    input.coordinationLease,
    input.observationLock,
    'exact-current-source',
    closure.attemptAuthenticatorGeneration,
  );
}

export function beginAgentOsEpochAttemptV2(
  input: BeginAgentOsEpochAttemptV2Input,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): AgentOsEpochAttemptStoreWriteResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return beginAgentOsEpochAttemptV2Impl(input, suppliedDependencies);
  const operation = enterRootOperation(dependencies.epochStoreRootPath, 'write');
  if (!operation) return writeResult('withheld', 'reentrant-call');
  try {
    const result = beginAgentOsEpochAttemptV2Impl(input, dependencies);
    if (operation.state.runtimeGuardRejected) {
      return writeResult(
        result.durable ? 'failed' : 'withheld', 'runtime-commit-withheld',
        null, null, false, result.durable,
      );
    }
    return operation.state.reentered
      ? writeResult(result.durable ? 'failed' : 'withheld', 'reentrant-call', null, null, false, result.durable)
      : result;
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

function completeAgentOsEpochAttemptV2Impl(
  input: CompleteAgentOsEpochAttemptV2Input,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): AgentOsEpochAttemptStoreWriteResultV1 {
  const row = record(input);
  if (!row || !exactKeys(row, [
    'completedAt', 'coordinationLease', 'durableTickDigest', 'observationLock',
    'outcome', 'snapshotEnvelopeDigest',
  ]) || !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) ||
    typeof row['completedAt'] !== 'string' ||
    !['succeeded', 'failed', 'cancelled', 'deadline-exceeded'].includes(String(row['outcome'])) ||
    (row['snapshotEnvelopeDigest'] !== null &&
      !isAgentOsRawSha256DigestV1(row['snapshotEnvelopeDigest']))) {
    return writeResult('withheld', 'invalid-input');
  }
  const setup = writeSetup(suppliedDependencies, input.coordinationLease, input.observationLock);
  if (!setup.ok) return setup.result;
  const { dependencies, closure } = setup;
  const before = readForClosure(dependencies, closure, { requireComplete: true });
  if (!before.complete) return writeResult('unavailable', 'chain-unavailable', null, closure, true);
  const attemptId = agentOsEpochAttemptIdV1({
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    durableTickDigest: input.durableTickDigest,
  });
  if (!attemptId) return writeResult('withheld', 'invalid-input', null, closure, true);
  const starts = before.records.filter((receipt) =>
    receipt.attemptId === attemptId && receipt.transitionOrdinal === 1);
  const terminals = before.records.filter((receipt) =>
    receipt.attemptId === attemptId && receipt.transitionOrdinal === 2);
  if (starts.length !== 1) return writeResult('withheld', 'invalid-transition', null, closure, true);
  const start = starts[0]!;
  const startContext: AgentOsEpochAttemptClosureContextV2 = {
    epoch: start.epoch,
    attemptNamespaceDigest: start.attemptNamespaceDigest,
    sourceBundleDigest: start.sourceBundleDigest,
    trustPolicyDigest: start.trustPolicyDigest,
  };
  const startResolution = resolveHistoricalLineage(
    dependencies, closure, startContext, start.authenticatorKeyId,
  );
  if (!startResolution || !startResolution.signer) {
    return writeResult('unavailable', 'chain-unavailable', null, closure, false);
  }
  const successfulSnapshot = input.outcome === 'succeeded' && input.snapshotEnvelopeDigest !== null
    ? {
        attemptId,
        producerStartReceiptDigest: start.receiptDigest,
        snapshotEnvelopeDigest: input.snapshotEnvelopeDigest,
      }
    : undefined;
  if (input.outcome === 'succeeded') {
    if (!successfulSnapshot || !verifiesSnapshotBinding(
      dependencies, closure, startContext, attemptId, start.receiptDigest, input.snapshotEnvelopeDigest,
    )) return writeResult('withheld', 'snapshot-v2-unverified', null, closure, true);
  } else if (input.snapshotEnvelopeDigest !== null) {
    return writeResult('withheld', 'invalid-input', null, closure, true);
  }
  if (terminals.length > 0) {
    const terminal = terminals[0]!;
    if (terminals.length !== 1 || terminal.outcome !== input.outcome ||
      terminal.snapshotEnvelopeDigest !== input.snapshotEnvelopeDigest ||
      terminal.completedAt !== input.completedAt) {
      return writeResult('conflicted', 'publication-conflict', null, closure, true);
    }
    return liveCommitGuard(
      dependencies,
      closure,
      input.coordinationLease,
      input.observationLock,
      startContext,
      start.authenticatorKeyId,
      startResolution.lineage.attemptAuthenticatorGeneration,
      'same-epoch-historical-source',
      successfulSnapshot,
    )
      ? writeResult('replayed', 'receipt-replay', terminal, closure, true, true)
      : writeResult('withheld', 'closure-changed', null, closure, false);
  }
  if (before.records.length >= dependencies.maxRecords) {
    return writeResult('withheld', 'capacity-exhausted', null, closure, true);
  }
  const receipt = createAgentOsEpochAttemptReceiptV2({
    epoch: closure.epoch,
    attemptNamespaceDigest: closure.attemptNamespaceDigest,
    durableTickDigest: input.durableTickDigest,
    transitionOrdinal: 2,
    previousReceiptDigest: start.receiptDigest,
    outcome: input.outcome,
    sourceBundleDigest: start.sourceBundleDigest,
    trustPolicyDigest: start.trustPolicyDigest,
    snapshotEnvelopeDigest: input.snapshotEnvelopeDigest,
    startedAt: start.startedAt,
    completedAt: input.completedAt,
  }, startResolution.signer);
  if (!receipt) return writeResult('withheld', 'invalid-input', null, closure, true);
  return persistReceipt(
    dependencies,
    closure,
    receipt,
    input.coordinationLease,
    input.observationLock,
    'same-epoch-historical-source',
    startResolution.lineage.attemptAuthenticatorGeneration,
    successfulSnapshot,
  );
}

export function completeAgentOsEpochAttemptV2(
  input: CompleteAgentOsEpochAttemptV2Input,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): AgentOsEpochAttemptStoreWriteResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return completeAgentOsEpochAttemptV2Impl(input, suppliedDependencies);
  const operation = enterRootOperation(dependencies.epochStoreRootPath, 'write');
  if (!operation) return writeResult('withheld', 'reentrant-call');
  try {
    const result = completeAgentOsEpochAttemptV2Impl(input, dependencies);
    if (operation.state.runtimeGuardRejected) {
      return writeResult(
        result.durable ? 'failed' : 'withheld', 'runtime-commit-withheld',
        null, null, false, result.durable,
      );
    }
    return operation.state.reentered
      ? writeResult(result.durable ? 'failed' : 'withheld', 'reentrant-call', null, null, false, result.durable)
      : result;
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

/**
 * Conservative stage cleanup for the authenticated active epoch. It never
 * creates an epoch, chooses an anchor, or publishes a caller-provided record.
 */
function recoverAgentOsEpochAttemptStoreV2Impl(
  input: Pick<BeginAgentOsEpochAttemptV2Input, 'coordinationLease' | 'observationLock'>,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): 'missing' | 'clean' | 'recovered' | 'withheld' | 'failed' {
  const setup = writeSetup(suppliedDependencies, input.coordinationLease, input.observationLock);
  if (!setup.ok) return 'withheld';
  const { dependencies, closure } = setup;
  if (pristineAttemptRoot(dependencies, closure)) return 'clean';
  const config = storeConfig(dependencies, closure);
  const currentSourceContext = closureContext(closure);
  if (!config || !liveCommitGuard(
    dependencies,
    closure,
    input.coordinationLease,
    input.observationLock,
    currentSourceContext,
    closure.attemptAuthenticatorKeyId,
    closure.attemptAuthenticatorGeneration,
    'same-epoch-historical-source',
  )) return 'withheld';
  const result = recoverImmutablePrivateRecordStore(config, { lockWaitMs: MAX_LOCK_WAIT_MS });
  return liveCommitGuard(
    dependencies,
    closure,
    input.coordinationLease,
    input.observationLock,
    currentSourceContext,
    closure.attemptAuthenticatorKeyId,
    closure.attemptAuthenticatorGeneration,
    'same-epoch-historical-source',
  )
    ? result === 'invalid' ? 'failed' : result
    : 'withheld';
}

export function recoverAgentOsEpochAttemptStoreV2(
  input: Pick<BeginAgentOsEpochAttemptV2Input, 'coordinationLease' | 'observationLock'>,
  suppliedDependencies: AgentOsEpochAttemptStoreDependenciesV1,
): 'missing' | 'clean' | 'recovered' | 'withheld' | 'failed' {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return recoverAgentOsEpochAttemptStoreV2Impl(input, suppliedDependencies);
  const operation = enterRootOperation(dependencies.epochStoreRootPath, 'write');
  if (!operation) return 'withheld';
  try {
    const result = recoverAgentOsEpochAttemptStoreV2Impl(input, dependencies);
    return operation.state.reentered ? 'withheld' : result;
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}
