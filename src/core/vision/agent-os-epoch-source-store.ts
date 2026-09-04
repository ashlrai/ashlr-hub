/**
 * Durable active-epoch source lineage (M561).
 *
 * M553's immutable `first-source.json` remains sequence one and is read
 * through, never duplicated. Renewals 2..N are stored below the derived
 * `<epoch>/sources` root. M553 must allow exactly `sources/` containing
 * `records/`, `staging/`, and transient `.agent-os-epoch-source-v1.lock`.
 *
 * This module owns no anchor adapter, key loading, daemon wiring, or effects.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
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
  readImmutablePrivateRecordsForRecoveryAdmission,
  initializeImmutablePrivateRecordStoreLayout,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import type {
  AgentOsEpochAttemptHistoricalSourceBatchDecisionV1,
  AgentOsEpochAttemptHistoricalSourceBatchRequestV1,
  AgentOsEpochAttemptHistoricalSourceBatchResultV1,
  AgentOsEpochAttemptHistoricalSourceLineageV1,
  AgentOsEpochAttemptHistoricalSourceLineageProviderV1,
} from './agent-os-epoch-attempt-store.js';
import {
  AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  agentOsEpochAttemptHistoricalSourceSetDigestV1,
} from './agent-os-epoch-attempt-store.js';
import {
  ownsAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from './agent-os-epoch-coordination.js';
import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
  parseAgentOsEpochSourceBundleV2,
  verifyAgentOsEpochSourceBundleV2,
  type AgentOsEpochSourceBundleV2,
  type AgentOsEpochSourceClosureContextV1,
  type AgentOsEpochSourceSignatureVerifierV2,
  type AgentOsEpochAttemptSignerV2,
  type AgentOsEpochAttemptVerifierV2,
} from './agent-os-epoch-records.js';
import {
  canonicalAgentOsEpochSourceRenewalBytesV1,
  createAgentOsEpochSourceRenewalV1,
  parseAgentOsEpochSourceRenewalV1,
  verifyAgentOsEpochSourceRenewalV1,
  type AgentOsEpochSourceRenewalActiveContextV1,
  type AgentOsEpochSourceRenewalSignatureVerifierV1,
  type AgentOsEpochSourceRenewalSignerV1,
  type AgentOsEpochSourceRenewalV1,
} from './agent-os-epoch-source-ledger.js';
import { isAgentOsEpochStorePlatformSupportedV1 } from './agent-os-epoch-store.js';

export const AGENT_OS_EPOCH_SOURCE_STORE_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-source-store-v1' as const;
export const AGENT_OS_EPOCH_SOURCE_DIRECTORY_V1 = 'sources' as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const FIRST_SOURCE_FILE = 'first-source.json';
const SOURCE_STORE_LOCK = '.agent-os-epoch-source-v1.lock';
const RECORD_FILE_RE = /^([0-9]{12})\.json$/;
const MAX_EPOCH = 999_999_999_999;
const MAX_SOURCE_SEQUENCE = 4_096;
const MAX_FIRST_SOURCE_BYTES = 768 * 1024;
const MAX_RENEWAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 768 * 1024 * 1024;
const HARD_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AgentOsAuthenticatedActiveEpochSourceContextV1 {
  epoch: number;
  epochHeadDigest: string;
  epochManifestDigest: string;
  previousEpochHeadDigest: string;
  previousEpochSourceTipDigest: string | null;
  attemptNamespaceDigest: string;
  firstSourceBundleDigest: string;
  trustPolicyDigest: string;
  policyGeneration: number;
  expectedSourceKeyId: string;
  expectedSourcePrincipalDigest: string;
  epochCreatedAt: string;
  observedAt: string;
  writerProtocolDigest: string;
}

export type AgentOsAuthenticatedActiveEpochSourceContextReadV1 =
  | { state: 'authenticated'; context: AgentOsAuthenticatedActiveEpochSourceContextV1 }
  | { state: 'missing' | 'uncommissioned' | 'unavailable' | 'degraded' };

export interface AgentOsAuthenticatedActiveEpochSourceContextProviderV1 {
  readAuthenticatedActiveEpochSourceContext(): AgentOsAuthenticatedActiveEpochSourceContextReadV1;
}

export interface AgentOsEpochAuthenticatedSourceAttemptAuthenticatorInputV1 {
  epoch: number;
  epochSequence: number;
  epochHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  sourcePayloadDigest: string;
  sourcePayload: string;
}

export type AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1 =
  | {
      state: 'authenticated';
      keyId: string;
      generation: number;
      verifier: AgentOsEpochAttemptVerifierV2;
      signer: AgentOsEpochAttemptSignerV2 | null;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

/**
 * Trusted key-selection seam. The resolver receives only a source record that
 * M561 already authenticated as a member of one complete lineage. Implementors
 * may decode a bounded source payload or consult a separately authenticated
 * key registry; this store never loads key material itself.
 */
export interface AgentOsEpochAuthenticatedSourceAttemptAuthenticatorResolverV1 {
  resolveAuthenticatedAttemptAuthenticator(
    source: Readonly<AgentOsEpochAuthenticatedSourceAttemptAuthenticatorInputV1>,
  ): AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1;
}

export interface AgentOsEpochSourceStoreDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  activeContextProvider: AgentOsAuthenticatedActiveEpochSourceContextProviderV1;
  firstSourceSignatureVerifier: AgentOsEpochSourceSignatureVerifierV2;
  renewalSignatureVerifier: AgentOsEpochSourceRenewalSignatureVerifierV1;
  renewalSigner: AgentOsEpochSourceRenewalSignerV1 | null;
  attemptAuthenticatorResolver: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorResolverV1;
  maxSources?: number;
}

export interface AppendAgentOsEpochSourceRenewalV1Input {
  evidencePrincipalDigest: string;
  outcomePrincipalDigests: string[];
  issuedAt: string;
  expiresAt: string;
  sourcePayloadBytes: Uint8Array;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export interface AgentOsEpochSourceStoreAuthorityV1 {
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

export interface AgentOsEpochSourceTipV1 {
  epochSequence: number;
  bundleDigest: string;
  trustPolicyDigest: string;
  issuedAt: string;
  expiresAt: string;
  kind: 'first-source' | 'renewal';
}

export type AgentOsEpochSourceStoreStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'platform-unsupported'
  | 'active-context-unavailable'
  | 'active-context-changed'
  | 'active-context-mismatch'
  | 'reentrant-call'
  | 'first-source-missing'
  | 'first-source-invalid'
  | 'renewal-root-unsafe'
  | 'sequence-gap'
  | 'predecessor-mismatch'
  | 'non-monotonic-time'
  | 'source-continuity-gap'
  | 'capacity-exhausted';

export interface AgentOsEpochSourceStoreReadResultV1 extends AgentOsEpochSourceStoreAuthorityV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  firstSource: Readonly<AgentOsEpochSourceBundleV2> | null;
  renewals: ReadonlyArray<Readonly<AgentOsEpochSourceRenewalV1>>;
  current: Readonly<AgentOsEpochSourceTipV1> | null;
  currentness: 'current' | 'expired' | 'not-yet-current' | 'unknown';
  epoch: number | null;
  epochHeadDigest: string | null;
  attemptNamespaceDigest: string | null;
  stopReasons: AgentOsEpochSourceStoreStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
  capacityExhausted: boolean;
  closureAuthenticated: boolean;
}

export type AgentOsEpochSourceStoreWriteReasonV1 =
  | 'recorded'
  | 'source-replay'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'active-context-unavailable'
  | 'active-context-changed'
  | 'reentrant-call'
  | 'coordination-lease-missing'
  | 'observation-lock-missing'
  | 'signer-unavailable'
  | 'chain-unavailable'
  | 'source-not-current'
  | 'capacity-exhausted'
  | 'publication-conflict'
  | 'publication-failed';

export interface AgentOsEpochSourceStoreWriteResultV1 extends AgentOsEpochSourceStoreAuthorityV1 {
  disposition: 'recorded' | 'replayed' | 'conflicted' | 'withheld' | 'unavailable' | 'failed';
  reason: AgentOsEpochSourceStoreWriteReasonV1;
  renewal: Readonly<AgentOsEpochSourceRenewalV1> | null;
  epoch: number | null;
  epochSequence: number | null;
  closureAuthenticated: boolean;
  durable: boolean;
}

interface PinnedDependencies extends AgentOsEpochSourceStoreDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  maxSources: number;
}

const AUTHORITY: Readonly<AgentOsEpochSourceStoreAuthorityV1> = Object.freeze({
  ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  writesAuthorized: false,
  pointerMutationAuthorized: false,
  anchorMutationAuthority: false,
});

interface RootOperationState { reentered: boolean }
const ACTIVE_ROOT_OPERATIONS = new Map<string, RootOperationState>();

function enterRootOperation(rootPath: string): RootOperationState | null {
  const existing = ACTIVE_ROOT_OPERATIONS.get(rootPath);
  if (existing) {
    existing.reentered = true;
    return null;
  }
  const state = { reentered: false };
  ACTIVE_ROOT_OPERATIONS.set(rootPath, state);
  return state;
}

function leaveRootOperation(rootPath: string, state: RootOperationState): void {
  if (ACTIVE_ROOT_OPERATIONS.get(rootPath) === state) ACTIVE_ROOT_OPERATIONS.delete(rootPath);
}

function operationSafe(dependencies: PinnedDependencies): boolean {
  return ACTIVE_ROOT_OPERATIONS.get(dependencies.epochStoreRootPath)?.reentered === false;
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

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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

function validContext(value: unknown): value is AgentOsAuthenticatedActiveEpochSourceContextV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'attemptNamespaceDigest', 'epoch', 'epochCreatedAt',
    'epochHeadDigest', 'epochManifestDigest', 'expectedSourceKeyId',
    'expectedSourcePrincipalDigest', 'firstSourceBundleDigest', 'observedAt',
    'policyGeneration', 'previousEpochHeadDigest', 'previousEpochSourceTipDigest',
    'trustPolicyDigest', 'writerProtocolDigest',
  ]) && validEpoch(row['epoch']) && isAgentOsPrefixedSha256DigestV1(row['epochHeadDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['epochManifestDigest']) &&
    isAgentOsPrefixedSha256DigestV1(row['previousEpochHeadDigest']) &&
    (row['previousEpochSourceTipDigest'] === null ||
      isAgentOsRawSha256DigestV1(row['previousEpochSourceTipDigest'])) &&
    (row['epoch'] === 1) === (row['previousEpochSourceTipDigest'] === null) &&
    isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) &&
    isAgentOsRawSha256DigestV1(row['firstSourceBundleDigest']) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) &&
    Number.isSafeInteger(row['policyGeneration']) && Number(row['policyGeneration']) >= 1 &&
    Number(row['policyGeneration']) <= 1_000_000 && isAgentOsRawSha256DigestV1(row['expectedSourceKeyId']) &&
    isAgentOsPrefixedSha256DigestV1(row['expectedSourcePrincipalDigest']) &&
    validTimestamp(row['epochCreatedAt']) && validTimestamp(row['observedAt']) &&
    Date.parse(row['observedAt'] as string) >= Date.parse(row['epochCreatedAt'] as string) &&
    isAgentOsPrefixedSha256DigestV1(row['writerProtocolDigest']));
}

function cloneContext(
  value: AgentOsAuthenticatedActiveEpochSourceContextV1,
): Readonly<AgentOsAuthenticatedActiveEpochSourceContextV1> {
  return deepFreeze({ ...value });
}

function sameContext(
  left: AgentOsAuthenticatedActiveEpochSourceContextV1,
  right: AgentOsAuthenticatedActiveEpochSourceContextV1,
): boolean {
  return left.epoch === right.epoch &&
    left.epochHeadDigest === right.epochHeadDigest &&
    left.epochManifestDigest === right.epochManifestDigest &&
    left.previousEpochHeadDigest === right.previousEpochHeadDigest &&
    left.previousEpochSourceTipDigest === right.previousEpochSourceTipDigest &&
    left.attemptNamespaceDigest === right.attemptNamespaceDigest &&
    left.firstSourceBundleDigest === right.firstSourceBundleDigest &&
    left.trustPolicyDigest === right.trustPolicyDigest &&
    left.policyGeneration === right.policyGeneration &&
    left.expectedSourceKeyId === right.expectedSourceKeyId &&
    left.expectedSourcePrincipalDigest === right.expectedSourcePrincipalDigest &&
    left.epochCreatedAt === right.epochCreatedAt &&
    left.observedAt === right.observedAt &&
    left.writerProtocolDigest === right.writerProtocolDigest;
}

function pinDependencies(value: AgentOsEpochSourceStoreDependenciesV1): PinnedDependencies | null {
  try {
    if (!value || typeof value !== 'object' || !isAgentOsEpochStorePlatformSupportedV1(process.platform) ||
      !isAgentOsPrefixedSha256DigestV1(value.writerProtocolDigest) || !value.activeContextProvider ||
      typeof value.activeContextProvider.readAuthenticatedActiveEpochSourceContext !== 'function' ||
      !value.firstSourceSignatureVerifier || typeof value.firstSourceSignatureVerifier.verify !== 'function' ||
      !value.renewalSignatureVerifier || typeof value.renewalSignatureVerifier.verify !== 'function' ||
      !value.attemptAuthenticatorResolver ||
      typeof value.attemptAuthenticatorResolver.resolveAuthenticatedAttemptAuthenticator !== 'function' ||
      (value.renewalSigner !== null && typeof value.renewalSigner.sign !== 'function')) return null;
    const anchorPath = resolve(value.anchorPath);
    const epochStoreRootPath = resolve(value.epochStoreRootPath);
    const maxSources = value.maxSources ?? MAX_SOURCE_SEQUENCE;
    if (!isAbsolute(value.anchorPath) || !isAbsolute(value.epochStoreRootPath) ||
      value.anchorPath !== anchorPath || value.epochStoreRootPath !== epochStoreRootPath ||
      anchorPath === parse(anchorPath).root || dirname(epochStoreRootPath) !== anchorPath ||
      basename(epochStoreRootPath) !== 'agent-os-epochs' || !Number.isSafeInteger(maxSources) ||
      maxSources < 2 || maxSources > MAX_SOURCE_SEQUENCE) return null;
    return { ...value, anchorPath, epochStoreRootPath, maxSources };
  } catch {
    return null;
  }
}

function readContext(
  dependencies: PinnedDependencies,
): Readonly<AgentOsAuthenticatedActiveEpochSourceContextV1> | null {
  try {
    if (!operationSafe(dependencies)) return null;
    const read = dependencies.activeContextProvider.readAuthenticatedActiveEpochSourceContext();
    if (!operationSafe(dependencies) || !read || read.state !== 'authenticated' || !validContext(read.context) ||
      read.context.writerProtocolDigest !== dependencies.writerProtocolDigest) return null;
    return cloneContext(read.context);
  } catch {
    return null;
  }
}

function epochPaths(
  dependencies: PinnedDependencies,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1,
): { epochPath: string; firstSourcePath: string; sourcesPath: string } {
  const epochPath = join(
    dependencies.epochStoreRootPath,
    'epochs',
    `epoch-${String(context.epoch).padStart(12, '0')}`,
  );
  return {
    epochPath,
    firstSourcePath: join(epochPath, FIRST_SOURCE_FILE),
    sourcesPath: join(epochPath, AGENT_OS_EPOCH_SOURCE_DIRECTORY_V1),
  };
}

function epochRootReady(
  dependencies: PinnedDependencies,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1,
): boolean {
  try {
    const { epochPath } = epochPaths(dependencies, context);
    const stat = lstatSync(epochPath, { bigint: true });
    return privateDirectory(stat) && assurePrivateStoragePath(
      epochPath,
      'directory',
      'inspect-existing',
      { anchorPath: dependencies.anchorPath },
    ).ok;
  } catch {
    return false;
  }
}

function sourcesRootState(
  dependencies: PinnedDependencies,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1,
): 'missing' | 'pristine' | 'initialized' | 'unsafe' {
  const { epochPath, sourcesPath } = epochPaths(dependencies, context);
  if (!existsSync(sourcesPath)) return 'missing';
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    const epoch = lstatSync(epochPath, { bigint: true });
    const sources = lstatSync(sourcesPath, { bigint: true });
    if (!privateDirectory(epoch) || !privateDirectory(sources) || sameIdentity(epoch, sources) ||
      !assurePrivateStoragePath(sourcesPath, 'directory', 'inspect-existing', { anchorPath: epochPath }).ok) {
      return 'unsafe';
    }
    directory = opendirSync(sourcesPath);
    return directory.readSync() === null ? 'pristine' : 'initialized';
  } catch {
    return 'unsafe';
  } finally {
    if (directory) {
      try { directory.closeSync(); } catch { /* best effort */ }
    }
  }
}

function readExactPrivateFile(path: string, anchorPath: string, maximumBytes: number): Buffer | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!privateFile(before) || before.size < 2n || before.size > BigInt(maximumBytes) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!privateFile(opened) || !sameIdentity(before, opened) || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    return privateFile(after) && privateFile(named) && sameIdentity(opened, after) &&
      sameIdentity(opened, named) && opened.size === after.size ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function firstSourceContext(
  active: AgentOsAuthenticatedActiveEpochSourceContextV1,
): AgentOsEpochSourceClosureContextV1 {
  return {
    epoch: active.epoch,
    previousEpochHeadDigest: active.previousEpochHeadDigest,
    previousEpochSourceTipDigest: active.previousEpochSourceTipDigest,
    trustPolicyDigest: active.trustPolicyDigest,
    policyGeneration: active.policyGeneration,
    expectedSourceKeyId: active.expectedSourceKeyId,
    expectedSourcePrincipalDigest: active.expectedSourcePrincipalDigest,
    observedAt: active.epochCreatedAt,
  };
}

function readFirstSource(
  dependencies: PinnedDependencies,
  active: AgentOsAuthenticatedActiveEpochSourceContextV1,
): AgentOsEpochSourceBundleV2 | null {
  const { epochPath, firstSourcePath } = epochPaths(dependencies, active);
  const bytes = readExactPrivateFile(firstSourcePath, epochPath, MAX_FIRST_SOURCE_BYTES);
  const source = bytes ? parseAgentOsEpochSourceBundleV2(bytes) : null;
  if (!source || source.bundleDigest !== active.firstSourceBundleDigest) return null;
  const context = firstSourceContext(active);
  const verified = verifyAgentOsEpochSourceBundleV2(
    source,
    context,
    dependencies.firstSourceSignatureVerifier,
    {
      verify(candidate) {
        return candidate.epoch === context.epoch &&
          candidate.previousEpochHeadDigest === context.previousEpochHeadDigest &&
          candidate.previousEpochSourceTipDigest === context.previousEpochSourceTipDigest &&
          candidate.trustPolicyDigest === context.trustPolicyDigest &&
          candidate.policyGeneration === context.policyGeneration &&
          candidate.expectedSourceKeyId === context.expectedSourceKeyId &&
          candidate.expectedSourcePrincipalDigest === context.expectedSourcePrincipalDigest &&
          candidate.observedAt === context.observedAt;
      },
    },
  );
  return operationSafe(dependencies) && verified.ok ? verified.envelope : null;
}

function renewalHistoricalContext(
  active: AgentOsAuthenticatedActiveEpochSourceContextV1,
  renewal: AgentOsEpochSourceRenewalV1,
): AgentOsEpochSourceRenewalActiveContextV1 {
  return {
    epoch: renewal.epoch,
    expectedEpochSequence: renewal.epochSequence,
    epochHeadDigest: active.epochHeadDigest,
    epochManifestDigest: active.epochManifestDigest,
    attemptNamespaceDigest: active.attemptNamespaceDigest,
    currentSourceBundleDigest: renewal.previousBundleDigest,
    trustPolicyDigest: active.trustPolicyDigest,
    policyGeneration: active.policyGeneration,
    expectedSourceKeyId: active.expectedSourceKeyId,
    expectedSourcePrincipalDigest: active.expectedSourcePrincipalDigest,
    observedAt: renewal.issuedAt,
  };
}

function renewalCodec(
  active: AgentOsAuthenticatedActiveEpochSourceContextV1,
  dependencies: PinnedDependencies,
): ImmutablePrivateRecordCodec<AgentOsEpochSourceRenewalV1> {
  return {
    parse(value) {
      const canonical = canonicalAgentOsEpochSourceRenewalBytesV1(value);
      const renewal = canonical ? parseAgentOsEpochSourceRenewalV1(canonical) : null;
      if (!renewal || renewal.epoch !== active.epoch || renewal.epochHeadDigest !== active.epochHeadDigest ||
        renewal.epochManifestDigest !== active.epochManifestDigest ||
        renewal.attemptNamespaceDigest !== active.attemptNamespaceDigest ||
        renewal.trustPolicyDigest !== active.trustPolicyDigest ||
        renewal.policyGeneration !== active.policyGeneration ||
        renewal.sourceKeyId !== active.expectedSourceKeyId ||
        renewal.sourcePrincipalDigest !== active.expectedSourcePrincipalDigest) return null;
      const context = renewalHistoricalContext(active, renewal);
      const verified = verifyAgentOsEpochSourceRenewalV1(renewal, dependencies.renewalSignatureVerifier, {
        readAuthenticatedActiveEpochContext: () => ({ ...context }),
      });
      return operationSafe(dependencies) && verified.ok ? verified.renewal : null;
    },
    serialize(renewal) {
      const bytes = canonicalAgentOsEpochSourceRenewalBytesV1(renewal);
      if (!bytes) throw new TypeError('source renewal is not canonical');
      return `${bytes.toString('utf8')}\n`;
    },
    recordId: (renewal) => String(renewal.epochSequence).padStart(12, '0'),
    recordFileName: (renewal) => `${String(renewal.epochSequence).padStart(12, '0')}.json`,
    isRecordFileName: (fileName) => RECORD_FILE_RE.test(fileName),
    stageToken: (renewal) => renewal.bundleDigest.slice(0, 32),
    equivalent: (left, right) => left.epochSequence === right.epochSequence &&
      left.bundleDigest === right.bundleDigest && left.signature === right.signature,
    compare: (left, right) => left.epochSequence - right.epochSequence,
  };
}

function storeConfig(
  dependencies: PinnedDependencies,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1,
): ImmutablePrivateRecordStoreConfig<AgentOsEpochSourceRenewalV1> {
  const codec = renewalCodec(context, dependencies);
  const maxRenewals = dependencies.maxSources - 1;
  return {
    label: 'Agent OS epoch source renewal',
    anchorPath: epochPaths(dependencies, context).epochPath,
    rootPath: epochPaths(dependencies, context).sourcesPath,
    lockFileName: SOURCE_STORE_LOCK,
    maxRecordBytes: MAX_RENEWAL_BYTES,
    defaultMaxFiles: maxRenewals,
    hardMaxFiles: maxRenewals,
    defaultMaxBytes: Math.min(DEFAULT_MAX_BYTES, maxRenewals * MAX_RENEWAL_BYTES),
    hardMaxBytes: Math.min(HARD_MAX_BYTES, maxRenewals * MAX_RENEWAL_BYTES),
    codecForWrite: () => codec,
    codecForRead: () => codec,
  };
}

function tipOf(
  first: AgentOsEpochSourceBundleV2,
  renewals: readonly AgentOsEpochSourceRenewalV1[],
): AgentOsEpochSourceTipV1 {
  const current = renewals.at(-1);
  return current ? {
    epochSequence: current.epochSequence,
    bundleDigest: current.bundleDigest,
    trustPolicyDigest: current.trustPolicyDigest,
    issuedAt: current.issuedAt,
    expiresAt: current.expiresAt,
    kind: 'renewal',
  } : {
    epochSequence: 1,
    bundleDigest: first.bundleDigest,
    trustPolicyDigest: first.trustPolicyDigest,
    issuedAt: first.issuedAt,
    expiresAt: first.expiresAt,
    kind: 'first-source',
  };
}

function currentness(tip: AgentOsEpochSourceTipV1, observedAt: string): AgentOsEpochSourceStoreReadResultV1['currentness'] {
  const observed = Date.parse(observedAt);
  if (Date.parse(tip.issuedAt) > observed + MAX_FUTURE_SKEW_MS) return 'not-yet-current';
  return Date.parse(tip.expiresAt) > observed ? 'current' : 'expired';
}

function chainIssues(
  first: AgentOsEpochSourceBundleV2,
  renewals: readonly AgentOsEpochSourceRenewalV1[],
): AgentOsEpochSourceStoreStopReasonV1[] {
  const issues = new Set<AgentOsEpochSourceStoreStopReasonV1>();
  let expectedSequence = 2;
  let previousDigest = first.bundleDigest;
  let previousIssuedAt = Date.parse(first.issuedAt);
  let previousExpiresAt = Date.parse(first.expiresAt);
  for (const renewal of renewals) {
    if (renewal.epochSequence !== expectedSequence) issues.add('sequence-gap');
    if (renewal.previousBundleDigest !== previousDigest) issues.add('predecessor-mismatch');
    if (Date.parse(renewal.issuedAt) <= previousIssuedAt) issues.add('non-monotonic-time');
    if (Date.parse(renewal.issuedAt) > previousExpiresAt) issues.add('source-continuity-gap');
    expectedSequence += 1;
    previousDigest = renewal.bundleDigest;
    previousIssuedAt = Date.parse(renewal.issuedAt);
    previousExpiresAt = Date.parse(renewal.expiresAt);
  }
  return [...issues];
}

function emptyRead(
  state: AgentOsEpochSourceStoreReadResultV1['sourceState'],
  reasons: AgentOsEpochSourceStoreStopReasonV1[],
  overrides: Partial<AgentOsEpochSourceStoreReadResultV1> = {},
): AgentOsEpochSourceStoreReadResultV1 {
  return deepFreeze({
    sourceState: state,
    sourcePresent: state !== 'missing',
    complete: state === 'healthy',
    firstSource: null,
    renewals: [],
    current: null,
    currentness: 'unknown',
    epoch: null,
    epochHeadDigest: null,
    attemptNamespaceDigest: null,
    stopReasons: reasons,
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

function readForContext(
  dependencies: PinnedDependencies,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1,
  options: ImmutablePrivateRecordReadOptions = {},
  admitConservativeLinkedRecovery = false,
): AgentOsEpochSourceStoreReadResultV1 {
  if (!epochRootReady(dependencies, context)) {
    return emptyRead('missing', ['first-source-missing'], { epoch: context.epoch });
  }
  const first = readFirstSource(dependencies, context);
  if (!first) return emptyRead('degraded', ['first-source-invalid'], {
    epoch: context.epoch,
    epochHeadDigest: context.epochHeadDigest,
    attemptNamespaceDigest: context.attemptNamespaceDigest,
    closureAuthenticated: true,
  });
  const rootState = sourcesRootState(dependencies, context);
  if (rootState === 'unsafe') return emptyRead('degraded', ['renewal-root-unsafe'], {
    sourcePresent: true,
    firstSource: first,
    epoch: context.epoch,
    epochHeadDigest: context.epochHeadDigest,
    attemptNamespaceDigest: context.attemptNamespaceDigest,
    closureAuthenticated: true,
  });
  const raw = rootState === 'missing' || rootState === 'pristine'
    ? {
        records: [] as AgentOsEpochSourceRenewalV1[],
        sourceState: 'healthy' as const,
        stopReasons: [] as ImmutablePrivateRecordReadStopReason[],
        filesRead: 0,
        bytesRead: 0,
        invalidFiles: 0,
        limitExceeded: false,
      }
    : (admitConservativeLinkedRecovery
      ? readImmutablePrivateRecordsForRecoveryAdmission
      : readImmutablePrivateRecords)(storeConfig(dependencies, context), {
        ...options,
        requireComplete: false,
      });
  const issues = chainIssues(first, raw.records);
  const tip = tipOf(first, raw.records);
  const degraded = raw.sourceState === 'degraded' || issues.length > 0;
  return deepFreeze({
    ...raw,
    sourceState: degraded ? 'degraded' : 'healthy',
    sourcePresent: true,
    complete: !degraded,
    firstSource: first,
    renewals: degraded && options.requireComplete !== false ? [] : raw.records,
    current: degraded ? null : tip,
    currentness: degraded ? 'unknown' : currentness(tip, context.observedAt),
    epoch: context.epoch,
    epochHeadDigest: context.epochHeadDigest,
    attemptNamespaceDigest: context.attemptNamespaceDigest,
    stopReasons: [...new Set([...raw.stopReasons, ...issues])],
    capacityExhausted: tip.epochSequence >= dependencies.maxSources,
    closureAuthenticated: true,
    ...AUTHORITY,
  });
}

function readAgentOsEpochSourceStoreImpl(
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
  admitConservativeLinkedRecovery = false,
): AgentOsEpochSourceStoreReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return emptyRead('degraded', [
    isAgentOsEpochStorePlatformSupportedV1(process.platform)
      ? 'active-context-unavailable'
      : 'platform-unsupported',
  ]);
  const operation = enterRootOperation(dependencies.epochStoreRootPath);
  if (!operation) return emptyRead('degraded', ['reentrant-call']);
  try {
    const context = readContext(dependencies);
    if (!context) return emptyRead('degraded', [
      operation.reentered ? 'reentrant-call' : 'active-context-unavailable',
    ]);
    const result = readForContext(
      dependencies,
      context,
      options,
      admitConservativeLinkedRecovery,
    );
    const finalContext = readContext(dependencies);
    if (operation.reentered || !finalContext || !sameContext(context, finalContext)) {
      return emptyRead('degraded', [
        operation.reentered ? 'reentrant-call' : 'active-context-changed',
      ], {
        sourcePresent: result.sourcePresent,
        epoch: context.epoch,
        epochHeadDigest: context.epochHeadDigest,
        attemptNamespaceDigest: context.attemptNamespaceDigest,
      });
    }
    return result;
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

export function readAgentOsEpochSourceStoreV1(
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochSourceStoreReadResultV1 {
  return readAgentOsEpochSourceStoreImpl(suppliedDependencies, options, false);
}

/**
 * Authenticates a complete lineage while tolerating only an exact, already
 * linked stage/target crash witness. This path is read-only; M563 remains the
 * sole cleanup authority under both coordination capabilities.
 */
export function readAgentOsEpochSourceStoreForRecoveryAdmissionV1(
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
  options: ImmutablePrivateRecordReadOptions = {},
): AgentOsEpochSourceStoreReadResultV1 {
  return readAgentOsEpochSourceStoreImpl(suppliedDependencies, options, true);
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

function liveGuard(
  dependencies: PinnedDependencies,
  expected: AgentOsAuthenticatedActiveEpochSourceContextV1,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
): boolean {
  if (!operationSafe(dependencies) ||
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned') return false;
  const first = readContext(dependencies);
  if (!first || !sameContext(expected, first) || !epochRootReady(dependencies, first)) return false;
  if (ownsWriteCapabilities(dependencies, coordinationLease, observationLock) !== 'owned') return false;
  const second = readContext(dependencies);
  return second !== null && sameContext(expected, second) &&
    sourcesRootState(dependencies, second) !== 'unsafe' &&
    ownsWriteCapabilities(dependencies, coordinationLease, observationLock) === 'owned';
}

function semanticReplay(
  renewal: AgentOsEpochSourceRenewalV1,
  input: AppendAgentOsEpochSourceRenewalV1Input,
): boolean {
  const canonicalOutcomes = [...input.outcomePrincipalDigests].sort();
  return renewal.evidencePrincipalDigest === input.evidencePrincipalDigest &&
    JSON.stringify(renewal.outcomePrincipalDigests) === JSON.stringify(canonicalOutcomes) &&
    renewal.issuedAt === input.issuedAt && renewal.expiresAt === input.expiresAt &&
    exactBytes(Buffer.from(renewal.sourcePayload, 'base64url'), input.sourcePayloadBytes);
}

function writeResult(
  disposition: AgentOsEpochSourceStoreWriteResultV1['disposition'],
  reason: AgentOsEpochSourceStoreWriteReasonV1,
  renewal: AgentOsEpochSourceRenewalV1 | null = null,
  context: AgentOsAuthenticatedActiveEpochSourceContextV1 | null = null,
  closureAuthenticated = false,
  durable = false,
): AgentOsEpochSourceStoreWriteResultV1 {
  return deepFreeze({
    disposition,
    reason,
    renewal,
    epoch: context?.epoch ?? null,
    epochSequence: renewal?.epochSequence ?? null,
    closureAuthenticated,
    durable,
    ...AUTHORITY,
  });
}

function appendAgentOsEpochSourceRenewalV1Impl(
  input: AppendAgentOsEpochSourceRenewalV1Input,
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
): AgentOsEpochSourceStoreWriteResultV1 {
  const row = record(input);
  if (!row || !exactKeys(row, [
    'coordinationLease', 'evidencePrincipalDigest', 'expiresAt', 'issuedAt',
    'observationLock', 'outcomePrincipalDigests', 'sourcePayloadBytes',
  ]) || !isAgentOsPrefixedSha256DigestV1(row['evidencePrincipalDigest']) ||
    !Array.isArray(row['outcomePrincipalDigests']) || !validTimestamp(row['issuedAt']) ||
    !validTimestamp(row['expiresAt']) || !(row['sourcePayloadBytes'] instanceof Uint8Array)) {
    return writeResult('withheld', 'invalid-input');
  }
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return writeResult('withheld',
    isAgentOsEpochStorePlatformSupportedV1(process.platform) ? 'invalid-input' : 'platform-unsupported');
  const ownership = ownsWriteCapabilities(dependencies, input.coordinationLease, input.observationLock);
  if (ownership !== 'owned') return writeResult('withheld', ownership);
  if (!dependencies.renewalSigner) return writeResult('unavailable', 'signer-unavailable');
  const context = readContext(dependencies);
  if (!context) return writeResult('unavailable', 'active-context-unavailable');
  if (dependencies.renewalSigner.keyId !== context.expectedSourceKeyId ||
    dependencies.renewalSigner.principalDigest !== context.expectedSourcePrincipalDigest) {
    return writeResult('unavailable', 'signer-unavailable');
  }
  const initialization = initializeImmutablePrivateRecordStoreLayout(
    storeConfig(dependencies, context),
    {
      lockWaitMs: MAX_LOCK_WAIT_MS,
      guard: () => liveGuard(
        dependencies, context, input.coordinationLease, input.observationLock,
      ),
    },
  );
  if (initialization === 'withheld') {
    return writeResult('withheld', 'active-context-changed', null, context, false);
  }
  if (initialization === 'failed' || initialization === 'invalid') {
    return writeResult('failed', 'publication-failed', null, context, true);
  }
  const before = readForContext(dependencies, context, { requireComplete: true });
  if (!before.complete || !before.current) {
    return writeResult('unavailable', 'chain-unavailable', null, context, true);
  }
  const previousRenewal = before.renewals.at(-1);
  if (previousRenewal && semanticReplay(previousRenewal, input)) {
    return liveGuard(dependencies, context, input.coordinationLease, input.observationLock)
      ? writeResult('replayed', 'source-replay', previousRenewal, context, true, true)
      : writeResult('withheld', 'active-context-changed', null, context, false);
  }
  if (before.currentness !== 'current') {
    return writeResult('withheld', 'source-not-current', null, context, true);
  }
  const nextSequence = before.current.epochSequence + 1;
  if (before.capacityExhausted || nextSequence > dependencies.maxSources) {
    return writeResult('withheld', 'capacity-exhausted', null, context, true);
  }
  if (Date.parse(input.issuedAt) <= Date.parse(before.current.issuedAt) ||
    Date.parse(input.issuedAt) > Date.parse(before.current.expiresAt)) {
    return writeResult('withheld', 'invalid-input', null, context, true);
  }
  const renewal = createAgentOsEpochSourceRenewalV1({
    epoch: context.epoch,
    epochSequence: nextSequence,
    epochHeadDigest: context.epochHeadDigest,
    epochManifestDigest: context.epochManifestDigest,
    attemptNamespaceDigest: context.attemptNamespaceDigest,
    previousBundleDigest: before.current.bundleDigest,
    trustPolicyDigest: context.trustPolicyDigest,
    policyGeneration: context.policyGeneration,
    sourceKeyId: context.expectedSourceKeyId,
    sourcePrincipalDigest: context.expectedSourcePrincipalDigest,
    evidencePrincipalDigest: input.evidencePrincipalDigest,
    outcomePrincipalDigests: input.outcomePrincipalDigests,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    sourcePayloadBytes: input.sourcePayloadBytes,
  }, dependencies.renewalSigner);
  if (!operationSafe(dependencies) || !renewal) {
    return writeResult('withheld', operationSafe(dependencies) ? 'invalid-input' : 'reentrant-call', null, context, false);
  }
  const activeVerification = verifyAgentOsEpochSourceRenewalV1(
    renewal,
    dependencies.renewalSignatureVerifier,
    {
      readAuthenticatedActiveEpochContext: () => ({
        epoch: context.epoch,
        expectedEpochSequence: nextSequence,
        epochHeadDigest: context.epochHeadDigest,
        epochManifestDigest: context.epochManifestDigest,
        attemptNamespaceDigest: context.attemptNamespaceDigest,
        currentSourceBundleDigest: before.current!.bundleDigest,
        trustPolicyDigest: context.trustPolicyDigest,
        policyGeneration: context.policyGeneration,
        expectedSourceKeyId: context.expectedSourceKeyId,
        expectedSourcePrincipalDigest: context.expectedSourcePrincipalDigest,
        observedAt: context.observedAt,
      }),
    },
  );
  if (!operationSafe(dependencies) || !activeVerification.ok) {
    return writeResult('withheld', operationSafe(dependencies) ? 'invalid-input' : 'reentrant-call', null, context, false);
  }
  let guardFailed = false;
  const publication = writeImmutablePrivateRecord(storeConfig(dependencies, context), renewal, {
    lockWaitMs: MAX_LOCK_WAIT_MS,
    prepublish: () => {
      const allowed = liveGuard(dependencies, context, input.coordinationLease, input.observationLock);
      guardFailed ||= !allowed;
      return allowed;
    },
  });
  if (guardFailed) return writeResult('withheld', 'active-context-changed', null, context, false);
  if (publication === 'conflicted') {
    return writeResult('conflicted', 'publication-conflict', null, context, true);
  }
  if (publication !== 'recorded' && publication !== 'replayed') {
    return writeResult('failed', 'publication-failed', null, context, true);
  }
  const config = storeConfig(dependencies, context);
  const id = String(renewal.epochSequence).padStart(12, '0');
  const persisted = readImmutablePrivateRecordPoint(config, id, `${id}.json`).record;
  const exactPersisted = persisted?.bundleDigest === renewal.bundleDigest;
  if (!exactPersisted || !liveGuard(
    dependencies,
    context,
    input.coordinationLease,
    input.observationLock,
  )) return writeResult('failed', 'active-context-changed', null, context, false, exactPersisted);
  return writeResult(
    publication === 'replayed' ? 'replayed' : 'recorded',
    publication === 'replayed' ? 'source-replay' : 'recorded',
    persisted,
    context,
    true,
    true,
  );
}

export function appendAgentOsEpochSourceRenewalV1(
  input: AppendAgentOsEpochSourceRenewalV1Input,
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
): AgentOsEpochSourceStoreWriteResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return appendAgentOsEpochSourceRenewalV1Impl(input, suppliedDependencies);
  const operation = enterRootOperation(dependencies.epochStoreRootPath);
  if (!operation) return writeResult('withheld', 'reentrant-call');
  try {
    const result = appendAgentOsEpochSourceRenewalV1Impl(input, dependencies);
    if (!operation.reentered) return result;
    return writeResult(
      result.durable ? 'failed' : 'withheld',
      'reentrant-call',
      null,
      null,
      false,
      result.durable,
    );
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

export function recoverAgentOsEpochSourceStoreV1(
  input: Pick<AppendAgentOsEpochSourceRenewalV1Input, 'coordinationLease' | 'observationLock'>,
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
): 'missing' | 'clean' | 'recovered' | 'withheld' | 'failed' {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return 'withheld';
  const operation = enterRootOperation(dependencies.epochStoreRootPath);
  if (!operation) return 'withheld';
  try {
    const ownership = ownsWriteCapabilities(
      dependencies, input.coordinationLease, input.observationLock,
    );
    if (ownership !== 'owned') return 'withheld';
    const context = readContext(dependencies);
    if (!context || !epochRootReady(dependencies, context)) return 'missing';
    const config = storeConfig(dependencies, context);
    const guard = () => liveGuard(
      dependencies, context, input.coordinationLease, input.observationLock,
    );
    const initialized = initializeImmutablePrivateRecordStoreLayout(config, {
      lockWaitMs: MAX_LOCK_WAIT_MS,
      guard,
    });
    if (initialized === 'missing') return 'missing';
    if (initialized === 'withheld') return 'withheld';
    if (initialized === 'failed' || initialized === 'invalid') return 'failed';
    const recovered = recoverImmutablePrivateRecordStore(config, { lockWaitMs: MAX_LOCK_WAIT_MS });
    if (!guard() || operation.reentered) return 'withheld';
    return recovered === 'invalid' ? 'failed' : recovered;
  } catch {
    return 'failed';
  } finally {
    leaveRootOperation(dependencies.epochStoreRootPath, operation);
  }
}

function resolveHistoricalSourceBatch(
  suppliedDependencies: AgentOsEpochSourceStoreDependenciesV1,
  request: Readonly<AgentOsEpochAttemptHistoricalSourceBatchRequestV1>,
): AgentOsEpochAttemptHistoricalSourceBatchResultV1 {
  let inputSetDigest: string;
  let requested: Array<{
    digest: string;
    lineage: AgentOsEpochAttemptHistoricalSourceLineageV1;
  }>;
  try {
    const row = record(request);
    if (!row || !exactKeys(row, ['inputSetDigest', 'lineages', 'protocol']) ||
      row['protocol'] !== AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1 ||
      !isAgentOsPrefixedSha256DigestV1(row['inputSetDigest'])) return { state: 'degraded' };
    const lineageValues = exactDenseArray(row['lineages'], MAX_SOURCE_SEQUENCE);
    if (!lineageValues || lineageValues.length < 1) return { state: 'degraded' };
    requested = [];
    for (const value of lineageValues) {
      const lineage = record(value);
      const digest = lineage
        ? agentOsEpochAttemptHistoricalSourceLineageDigestV1(
          lineage as unknown as AgentOsEpochAttemptHistoricalSourceLineageV1,
        )
        : null;
      if (!lineage || !digest) return { state: 'degraded' };
      requested.push({
        digest,
        lineage: deepFreeze({
          epoch: lineage['epoch'] as number,
          epochHeadDigest: lineage['epochHeadDigest'] as string,
          epochManifestDigest: lineage['epochManifestDigest'] as string,
          attemptNamespaceDigest: lineage['attemptNamespaceDigest'] as string,
          sourceBundleDigest: lineage['sourceBundleDigest'] as string,
          trustPolicyDigest: lineage['trustPolicyDigest'] as string,
          attemptAuthenticatorKeyId: lineage['attemptAuthenticatorKeyId'] as string,
        }),
      });
    }
    const digests = requested.map(({ digest }) => digest);
    if (agentOsEpochAttemptHistoricalSourceSetDigestV1(digests) !== row['inputSetDigest']) {
      return { state: 'degraded' };
    }
    inputSetDigest = row['inputSetDigest'] as string;
  } catch {
    return { state: 'degraded' };
  }
  const pinned = pinDependencies(suppliedDependencies);
  if (!pinned) return { state: 'degraded' };
  const operation = enterRootOperation(pinned.epochStoreRootPath);
  if (!operation) return { state: 'degraded' };
  try {
    const context = readContext(pinned);
    const read = context ? readForContext(pinned, context, { requireComplete: true }) : null;
    if (!context || !read?.complete || !read.firstSource) return { state: 'degraded' };
    const sources = new Map<string, AgentOsEpochSourceBundleV2 | AgentOsEpochSourceRenewalV1>();
    for (const source of [read.firstSource, ...read.renewals]) {
      const key = `${source.bundleDigest}:${source.trustPolicyDigest}`;
      if (sources.has(key)) return { state: 'degraded' };
      sources.set(key, source);
    }
    const resolutions: Array<Readonly<AgentOsEpochAttemptHistoricalSourceBatchDecisionV1>> = [];
    for (const { digest, lineage } of requested) {
      if (read.epoch !== lineage.epoch || read.epochHeadDigest !== lineage.epochHeadDigest ||
        context.epochManifestDigest !== lineage.epochManifestDigest ||
        read.attemptNamespaceDigest !== lineage.attemptNamespaceDigest) {
        resolutions.push(deepFreeze({ lineageDigest: digest, resolution: { state: 'degraded' as const } }));
        continue;
      }
      const source = sources.get(`${lineage.sourceBundleDigest}:${lineage.trustPolicyDigest}`);
      if (!source) {
        resolutions.push(deepFreeze({ lineageDigest: digest, resolution: { state: 'missing' as const } }));
        continue;
      }
      const sourceInput = deepFreeze({
        epoch: source.epoch,
        epochSequence: source.epochSequence,
        epochHeadDigest: context.epochHeadDigest,
        epochManifestDigest: context.epochManifestDigest,
        attemptNamespaceDigest: context.attemptNamespaceDigest,
        sourceBundleDigest: source.bundleDigest,
        trustPolicyDigest: source.trustPolicyDigest,
        sourcePayloadDigest: source.sourcePayloadDigest,
        sourcePayload: source.sourcePayload,
      });
      const selected = pinned.attemptAuthenticatorResolver
        .resolveAuthenticatedAttemptAuthenticator(sourceInput);
      const selectedRow = record(selected);
      const verifier = selectedRow && record(selectedRow['verifier']);
      if (!operationSafe(pinned) || !selectedRow || selectedRow['state'] !== 'authenticated' ||
        !exactKeys(selectedRow, ['generation', 'keyId', 'signer', 'state', 'verifier']) ||
        selectedRow['keyId'] !== lineage.attemptAuthenticatorKeyId ||
        !Number.isSafeInteger(selectedRow['generation']) || Number(selectedRow['generation']) < 1 ||
        Number(selectedRow['generation']) > 1_000_000 || !verifier ||
        !exactKeys(verifier, ['keyId', 'verify']) || verifier['keyId'] !== selectedRow['keyId'] ||
        typeof verifier['verify'] !== 'function') return { state: 'degraded' };
      const verify = (verifier['verify'] as AgentOsEpochAttemptVerifierV2['verify']).bind(verifier);
      resolutions.push(deepFreeze({
        lineageDigest: digest,
        resolution: {
          state: 'authenticated' as const,
          lineage: { ...lineage, attemptAuthenticatorGeneration: Number(selectedRow['generation']) },
          verifier: {
            keyId: lineage.attemptAuthenticatorKeyId,
            verify: (input: Parameters<AgentOsEpochAttemptVerifierV2['verify']>[0]) => verify(input),
          },
        },
      }));
    }
    const finalContext = readContext(pinned);
    const originalRow = record(request);
    const originalLineages = originalRow ? exactDenseArray(originalRow['lineages'], MAX_SOURCE_SEQUENCE) : null;
    const originalDigests = originalLineages
      ? originalLineages.map((lineage) =>
        agentOsEpochAttemptHistoricalSourceLineageDigestV1(
          lineage as AgentOsEpochAttemptHistoricalSourceLineageV1,
        ) ?? '')
      : [];
    if (!operationSafe(pinned) || !finalContext || !sameContext(context, finalContext) ||
      !originalRow || !exactKeys(originalRow, ['inputSetDigest', 'lineages', 'protocol']) ||
      originalRow['protocol'] !== AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1 ||
      originalRow['inputSetDigest'] !== inputSetDigest ||
      agentOsEpochAttemptHistoricalSourceSetDigestV1(originalDigests) !== inputSetDigest) {
      return { state: 'degraded' };
    }
    return deepFreeze({ state: 'authenticated', inputSetDigest, resolutions });
  } catch {
    return { state: 'degraded' };
  } finally {
    leaveRootOperation(pinned.epochStoreRootPath, operation);
  }
}

/**
 * Adapter for M557. Historical membership remains valid when the current tip
 * renews or expires, but fails closed if any source record or chain link is no
 * longer authenticated and complete.
 */
export function createAgentOsEpochSourceHistoricalLineageProviderV1(
  dependencies: AgentOsEpochSourceStoreDependenciesV1,
): AgentOsEpochAttemptHistoricalSourceLineageProviderV1 {
  return Object.freeze({
    resolveAuthenticatedHistoricalSources(
      request: Readonly<AgentOsEpochAttemptHistoricalSourceBatchRequestV1>,
    ) {
      return resolveHistoricalSourceBatch(dependencies, request);
    },
    resolveAuthenticatedHistoricalSource(lineage: Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1>) {
      const row = record(lineage);
      if (!row || !exactKeys(row, [
        'attemptAuthenticatorKeyId', 'attemptNamespaceDigest', 'epoch', 'epochHeadDigest',
        'epochManifestDigest', 'sourceBundleDigest', 'trustPolicyDigest',
      ])) return { state: 'degraded' as const };
      const pinned = pinDependencies(dependencies);
      if (!pinned) return { state: 'degraded' as const };
      const operation = enterRootOperation(pinned.epochStoreRootPath);
      if (!operation) return { state: 'degraded' as const };
      try {
        const context = readContext(pinned);
        const read = context ? readForContext(pinned, context, { requireComplete: true }) : null;
        if (!context || !read?.complete || read.epoch !== lineage.epoch ||
          read.epochHeadDigest !== lineage.epochHeadDigest ||
          context.epochManifestDigest !== lineage.epochManifestDigest ||
          read.attemptNamespaceDigest !== lineage.attemptNamespaceDigest) {
          return { state: 'degraded' as const };
        }
        const source = [read.firstSource, ...read.renewals].find((candidate) => candidate !== null &&
          candidate.bundleDigest === lineage.sourceBundleDigest &&
          candidate.trustPolicyDigest === lineage.trustPolicyDigest);
        if (!source) return { state: 'missing' as const };
        const selected = dependencies.attemptAuthenticatorResolver
          .resolveAuthenticatedAttemptAuthenticator(deepFreeze({
          epoch: source.epoch,
          epochSequence: source.epochSequence,
          epochHeadDigest: context.epochHeadDigest,
          epochManifestDigest: context.epochManifestDigest,
          attemptNamespaceDigest: context.attemptNamespaceDigest,
          sourceBundleDigest: source.bundleDigest,
          trustPolicyDigest: source.trustPolicyDigest,
          sourcePayloadDigest: source.sourcePayloadDigest,
          sourcePayload: source.sourcePayload,
          }));
        const finalContext = readContext(pinned);
        if (!operationSafe(pinned) || !finalContext || !sameContext(context, finalContext) ||
          !selected || selected.state !== 'authenticated' ||
          selected.keyId !== lineage.attemptAuthenticatorKeyId ||
          !isAgentOsRawSha256DigestV1(selected.keyId) ||
          !Number.isSafeInteger(selected.generation) || selected.generation < 1 ||
          selected.generation > 1_000_000 || selected.verifier.keyId !== selected.keyId ||
          (selected.signer !== null && selected.signer.keyId !== selected.keyId)) {
          return { state: 'degraded' as const };
        }
        const verify = selected.verifier.verify.bind(selected.verifier);
        const selectedSigner = selected.signer;
        const authenticate = selectedSigner?.authenticate.bind(selectedSigner) ?? null;
        const verifier: AgentOsEpochAttemptVerifierV2 = Object.freeze({
          keyId: selected.keyId,
          verify: (input: Parameters<AgentOsEpochAttemptVerifierV2['verify']>[0]) => verify(input),
        });
        const signer: AgentOsEpochAttemptSignerV2 | null = authenticate === null
          ? null
          : Object.freeze({
              keyId: selected.keyId,
              authenticate: (bytes: Uint8Array) => authenticate(bytes),
            });
        return Object.freeze({
          state: 'authenticated' as const,
          lineage: Object.freeze({
            ...lineage,
            attemptAuthenticatorGeneration: selected.generation,
          }),
          verifier,
          signer,
        });
      } catch {
        return { state: 'degraded' as const };
      } finally {
        leaveRootOperation(pinned.epochStoreRootPath, operation);
      }
    },
  });
}
