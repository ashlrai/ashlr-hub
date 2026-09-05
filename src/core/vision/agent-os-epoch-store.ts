/**
 * Local, non-authoritative durability for prepared Agent OS epochs (M553).
 *
 * External anchor CAS is the sole epoch commit point. This module owns no
 * anchor, key, daemon, configuration, or effect integration. It only preserves
 * exact canonical M550 bytes in a private, bounded, fail-closed filesystem
 * layout and atomically maintains a local cache pointer.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { ownsLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import {
  ownsAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from './agent-os-epoch-coordination.js';
import {
  AGENT_OS_ROLLOVER_AUTHORITY_V1,
  AGENT_OS_ROLLOVER_MAX_EPOCH_V1,
  canonicalAgentOsObservationEpochHeadBytesV1,
  canonicalAgentOsObservationEpochManifestBytesV1,
  parseAgentOsObservationEpochHeadV1,
  parseAgentOsObservationEpochManifestV1,
  type AgentOsManifestAuthenticatorVerifierV1,
  type AgentOsPreparedEpochEvidenceV1,
  type AgentOsPreparedEpochEvidenceVerifierV1,
} from './agent-os-rollover-protocol.js';

export const AGENT_OS_EPOCH_STORE_PROTOCOL_V1 = 'ashlr-agent-os-local-epoch-store-v1' as const;
export const AGENT_OS_EPOCH_RECOVERY_PROTOCOL_V1 = 'ashlr-agent-os-epoch-recovery-marker-v1' as const;
export const AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1 = 'ashlr-agent-os-active-epoch-pointer-v1' as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PROTOCOL_BYTES = 64 * 1024;
const MAX_FIRST_SOURCE_BYTES = 768 * 1024;
const MAX_POINTER_BYTES = 128 * 1024;
const MAX_EPOCH_ENTRIES = 4_096;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST_RE = /^[a-f0-9]{64}$/;
const EPOCH_DIRECTORY_RE = /^epoch-([0-9]{12})$/;
const PREPARE_DIRECTORY_RE = /^\.epoch-([0-9]{12})-([a-f0-9]{64})\.prepare$/;

const MANIFEST_FILE = 'manifest.json';
const HEAD_FILE = 'head.json';
const FIRST_SOURCE_FILE = 'first-source.json';
const EVIDENCE_FILE = 'prepared-evidence.json';
const RECOVERY_FILE = 'recovery-marker.json';
const SNAPSHOTS_DIRECTORY = 'snapshots';
const ATTEMPTS_DIRECTORY = 'attempts';
const SOURCES_DIRECTORY = 'sources';
const ACTIVE_POINTER_FILE = 'active-pointer.json';
const ATTEMPT_RECORDS_DIRECTORY = 'records';
const ATTEMPT_STAGING_DIRECTORY = 'staging';
const ATTEMPT_LEDGER_LOCK_FILE = '.agent-os-epoch-attempt-v2.lock';
const SNAPSHOT_LEDGER_LOCK_FILE = '.agent-os-epoch-snapshot-v2.lock';
const SOURCE_LEDGER_LOCK_FILE = '.agent-os-epoch-source-v1.lock';

const PREPARED_ENTRIES = Object.freeze([
  ATTEMPTS_DIRECTORY,
  EVIDENCE_FILE,
  FIRST_SOURCE_FILE,
  HEAD_FILE,
  MANIFEST_FILE,
  RECOVERY_FILE,
  SNAPSHOTS_DIRECTORY,
  SOURCES_DIRECTORY,
].sort());

/**
 * Windows directory fsync may be reported as unsupported by the shared
 * durability primitive. M553 must not claim power-loss durability there until
 * a Windows-specific implementation has been commissioned and accepted.
 */
export function isAgentOsEpochStorePlatformSupportedV1(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

export type AgentOsEpochStoreCrashPointV1 =
  | 'root-durable'
  | 'epochs-directory-durable'
  | 'staging-directory-durable'
  | 'manifest-durable'
  | 'head-durable'
  | 'first-source-durable'
  | 'sources-directory-durable'
  | 'snapshots-directory-durable'
  | 'attempts-directory-durable'
  | 'prepared-evidence-durable'
  | 'recovery-marker-durable'
  | 'prepared-epoch-published'
  | 'prepared-epoch-replay-durable'
  | 'pointer-temporary-durable'
  | 'pointer-renamed'
  | 'pointer-directory-durable'
  | 'pointer-replay-durable';

export interface AgentOsEpochStoreDependenciesV1 {
  /** Existing exact-private directory that directly contains rootPath. */
  anchorPath: string;
  /** Exact absolute path to the one M553 store root. */
  rootPath: string;
  manifestAuthenticatorVerifier: AgentOsManifestAuthenticatorVerifierV1;
  preparedEpochEvidenceVerifier: AgentOsPreparedEpochEvidenceVerifierV1;
  firstSourceBundleVerifier: (canonicalBytes: Uint8Array, expectedBundleDigest: string) => boolean;
  writerProtocolDigest: string;
  /** Injected read-only anchor boundary; M553 owns no adapter or credentials. */
  readAnchorHead: () =>
    | { state: 'present'; canonicalHeadBytes: Uint8Array }
    | { state: 'missing' | 'unavailable' | 'degraded' };
  /** Test-only fault seam. Production callers omit it. */
  afterDurableStep?: (step: AgentOsEpochStoreCrashPointV1) => void;
}

export interface PrepareAgentOsEpochInputV1 {
  canonicalManifestBytes: Uint8Array;
  canonicalHeadBytes: Uint8Array;
  canonicalFirstSourceBundleBytes: Uint8Array;
  preparedEvidence: AgentOsPreparedEpochEvidenceV1;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export interface InstallAgentOsActivePointerInputV1 {
  canonicalHeadBytes: Uint8Array;
  operationId: string;
  expectedPreviousHeadDigest: string | null;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
}

export type AgentOsEpochStoreReasonV1 =
  | 'prepared'
  | 'replayed'
  | 'pointer-installed'
  | 'pointer-replayed'
  | 'missing'
  | 'invalid-input'
  | 'unsafe-storage'
  | 'incomplete-preparation'
  | 'artifact-conflict'
  | 'prepared-evidence-unverified'
  | 'manifest-authentication-failed'
  | 'first-source-verification-failed'
  | 'pointer-conflict'
  | 'io-failure';

export interface AgentOsEpochStoreMutationResultV1 {
  state: 'accepted' | 'withheld' | 'missing' | 'degraded';
  reason: AgentOsEpochStoreReasonV1;
  epoch: number | null;
  operationId: string | null;
  preparedDurable: boolean;
  pointerInstalled: boolean;
  anchorVerified: false;
  anchorHeadMatched: boolean;
  sourceCompatibility: 'unverified';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  rollbackProtected: false;
  authority: 'observation-only';
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
}

export interface AgentOsPreparedEpochReadResultV1 extends AgentOsEpochStoreMutationResultV1 {
  canonicalManifestBytes: Buffer | null;
  canonicalHeadBytes: Buffer | null;
  canonicalFirstSourceBundleBytes: Buffer | null;
  preparedEvidence: Readonly<AgentOsPreparedEpochEvidenceV1> | null;
  phase: 'none' | 'cas-pending';
}

export interface AgentOsActivePointerReadResultV1 extends AgentOsEpochStoreMutationResultV1 {
  canonicalHeadBytes: Buffer | null;
  manifestDigest: string | null;
  phase: 'none' | 'pointer-installed';
}

export interface AgentOsActiveEpochArtifactsReadResultV1 extends AgentOsEpochStoreMutationResultV1 {
  canonicalManifestBytes: Buffer | null;
  canonicalHeadBytes: Buffer | null;
  canonicalFirstSourceBundleBytes: Buffer | null;
  preparedEvidence: Readonly<AgentOsPreparedEpochEvidenceV1> | null;
  manifestDigest: string | null;
  headDigest: string | null;
  attemptNamespaceDigest: string | null;
  snapshotBasePreviousEnvelopeDigest: string | null;
  phase: 'none' | 'active';
}

interface RecoveryMarkerV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_EPOCH_RECOVERY_PROTOCOL_V1;
  epoch: number;
  operationId: string;
  manifestDigest: string;
  headDigest: string;
  firstSourceBundleDigest: string;
  manifestBytesDigest: string;
  headBytesDigest: string;
  firstSourceBytesDigest: string;
  preparedEvidenceBytesDigest: string;
  phase: 'cas-pending';
  authority: 'observation-only';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  rollbackProtected: false;
}

interface ActivePointerV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1;
  epoch: number;
  headDigest: string;
  manifestDigest: string;
  operationId: string;
  canonicalHeadBase64: string;
  authority: 'observation-only';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  rollbackProtected: false;
}

interface PinnedDependencies extends AgentOsEpochStoreDependenciesV1 {
  anchorPath: string;
  rootPath: string;
}

interface PreparedCandidate {
  epoch: number;
  operationId: string;
  manifestBytes: Buffer;
  headBytes: Buffer;
  sourceBytes: Buffer;
  evidence: AgentOsPreparedEpochEvidenceV1;
  evidenceBytes: Buffer;
  marker: RecoveryMarkerV1;
  markerBytes: Buffer;
}

const LOCAL_AUTHORITY = Object.freeze({
  anchorVerified: false as const,
  writesAuthorized: false as const,
  pointerMutationAuthorized: false as const,
  rollbackProtected: false as const,
  ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
});

function mutationResult(
  state: AgentOsEpochStoreMutationResultV1['state'],
  reason: AgentOsEpochStoreReasonV1,
  epoch: number | null = null,
  operationId: string | null = null,
  preparedDurable = false,
  pointerInstalled = false,
  anchorHeadMatched = false,
): AgentOsEpochStoreMutationResultV1 {
  return Object.freeze({
    state,
    reason,
    epoch,
    operationId,
    preparedDurable,
    pointerInstalled,
    anchorHeadMatched,
    sourceCompatibility: 'unverified' as const,
    ...LOCAL_AUTHORITY,
  });
}

function preparedReadResult(
  base: AgentOsEpochStoreMutationResultV1,
  candidate?: PreparedCandidate,
): AgentOsPreparedEpochReadResultV1 {
  return Object.freeze({
    ...base,
    canonicalManifestBytes: candidate ? Buffer.from(candidate.manifestBytes) : null,
    canonicalHeadBytes: candidate ? Buffer.from(candidate.headBytes) : null,
    canonicalFirstSourceBundleBytes: candidate ? Buffer.from(candidate.sourceBytes) : null,
    preparedEvidence: candidate ? deepFreeze(structuredClone(candidate.evidence)) : null,
    phase: candidate ? 'cas-pending' : 'none',
  });
}

function activeArtifactsReadResult(
  base: AgentOsEpochStoreMutationResultV1,
  candidate?: PreparedCandidate,
): AgentOsActiveEpochArtifactsReadResultV1 {
  const manifest = candidate ? parseAgentOsObservationEpochManifestV1(candidate.manifestBytes) : null;
  const head = candidate ? parseAgentOsObservationEpochHeadV1(candidate.headBytes) : null;
  return Object.freeze({
    ...base,
    canonicalManifestBytes: candidate ? Buffer.from(candidate.manifestBytes) : null,
    canonicalHeadBytes: candidate ? Buffer.from(candidate.headBytes) : null,
    canonicalFirstSourceBundleBytes: candidate ? Buffer.from(candidate.sourceBytes) : null,
    preparedEvidence: candidate ? deepFreeze(structuredClone(candidate.evidence)) : null,
    manifestDigest: manifest?.manifestDigest ?? null,
    headDigest: head?.headDigest ?? null,
    attemptNamespaceDigest: manifest?.attemptNamespaceDigest ?? null,
    snapshotBasePreviousEnvelopeDigest: manifest?.snapshotBase.previousEnvelopeDigest ?? null,
    phase: candidate ? 'active' : 'none',
  });
}

function pointerReadResult(
  base: AgentOsEpochStoreMutationResultV1,
  pointer?: ActivePointerV1,
  headBytes?: Buffer,
): AgentOsActivePointerReadResultV1 {
  return Object.freeze({
    ...base,
    canonicalHeadBytes: headBytes ? Buffer.from(headBytes) : null,
    manifestDigest: pointer?.manifestDigest ?? null,
    phase: pointer ? 'pointer-installed' : 'none',
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
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

function canonicalObjectBytes(value: Record<string, unknown>): Buffer | null {
  try {
    const ordered = Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
    return bytes.length > 0 && bytes.length <= MAX_PROTOCOL_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function validRawDigest(value: unknown): value is string {
  return typeof value === 'string' && RAW_DIGEST_RE.test(value);
}

function epochToken(epoch: number): string {
  return String(epoch).padStart(12, '0');
}

function validEpoch(epoch: unknown): epoch is number {
  return Number.isSafeInteger(epoch) && Number(epoch) > 0 && Number(epoch) <= AGENT_OS_ROLLOVER_MAX_EPOCH_V1;
}

function owned(stat: Pick<BigIntStats, 'uid'>): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function privateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE));
}

function privateFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE));
}

function sameIdentity(left: Pick<BigIntStats, 'dev' | 'ino'>, right: Pick<BigIntStats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pinDependencies(value: AgentOsEpochStoreDependenciesV1): PinnedDependencies | null {
  try {
    if (!isAgentOsEpochStorePlatformSupportedV1(process.platform) ||
      !value || typeof value !== 'object' || typeof value.manifestAuthenticatorVerifier !== 'function' ||
      typeof value.preparedEpochEvidenceVerifier !== 'function' ||
      typeof value.firstSourceBundleVerifier !== 'function' ||
      typeof value.readAnchorHead !== 'function' || !validDigest(value.writerProtocolDigest) ||
      (value.afterDurableStep !== undefined && typeof value.afterDurableStep !== 'function')) return null;
    const anchorPath = resolve(value.anchorPath);
    const rootPath = resolve(value.rootPath);
    if (!isAbsolute(value.anchorPath) || !isAbsolute(value.rootPath) || value.anchorPath !== anchorPath ||
      value.rootPath !== rootPath || anchorPath === parse(anchorPath).root || rootPath === anchorPath ||
      dirname(rootPath) !== anchorPath || basename(rootPath) !== 'agent-os-epochs') return null;
    const anchor = lstatSync(anchorPath, { bigint: true });
    if (!privateDirectory(anchor) || !assurePrivateStoragePath(
      anchorPath, 'directory', 'inspect-existing', { anchorPath },
    ).ok) return null;
    return { ...value, anchorPath, rootPath };
  } catch {
    return null;
  }
}

function inspectDirectory(path: string, anchorPath: string): BigIntStats | null {
  try {
    const before = lstatSync(path, { bigint: true });
    if (!privateDirectory(before) || !assurePrivateStoragePath(
      path, 'directory', 'inspect-existing', { anchorPath },
    ).ok) return null;
    const after = lstatSync(path, { bigint: true });
    return privateDirectory(after) && sameIdentity(before, after) ? after : null;
  } catch {
    return null;
  }
}

function ensureDirectory(path: string, parentPath: string, anchorPath: string): BigIntStats {
  const parentBefore = inspectDirectory(parentPath, anchorPath);
  if (!parentBefore || dirname(path) !== parentPath) throw new Error('unsafe parent directory');
  if (!existsSync(path)) {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    if (!assurePrivateStoragePath(path, 'directory', 'secure-created', { anchorPath }).ok) {
      throw new Error('private directory assurance failed');
    }
    fsyncDirectory(parentPath, { expectedIdentity: parentBefore });
  }
  const directory = inspectDirectory(path, anchorPath);
  const parentAfter = inspectDirectory(parentPath, anchorPath);
  if (!directory || !parentAfter || !sameIdentity(parentBefore, parentAfter) || sameIdentity(directory, parentAfter)) {
    throw new Error('directory identity changed');
  }
  return directory;
}

function afterStep(dependencies: PinnedDependencies, step: AgentOsEpochStoreCrashPointV1): void {
  dependencies.afterDurableStep?.(step);
}

function ensureRoot(dependencies: PinnedDependencies): { root: BigIntStats; epochs: BigIntStats } {
  const root = ensureDirectory(dependencies.rootPath, dependencies.anchorPath, dependencies.anchorPath);
  afterStep(dependencies, 'root-durable');
  const epochsPath = join(dependencies.rootPath, 'epochs');
  const epochs = ensureDirectory(epochsPath, dependencies.rootPath, dependencies.anchorPath);
  afterStep(dependencies, 'epochs-directory-durable');
  if (sameIdentity(root, epochs)) throw new Error('aliased store directories');
  return { root, epochs };
}

function writeNewFile(path: string, bytes: Uint8Array, parent: string, anchorPath: string): void {
  let fd: number | undefined;
  try {
    if (dirname(path) !== parent) throw new Error('file is not a direct child of its pinned parent');
    const parentBefore = inspectDirectory(parent, anchorPath);
    if (!parentBefore) throw new Error('unsafe file parent');
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_FILE_MODE);
    const opened = fstatSync(fd, { bigint: true });
    if (!privateFile(opened) || opened.size !== 0n) throw new Error('unsafe new file');
    let offset = 0;
    const ownedBytes = Buffer.from(bytes);
    while (offset < ownedBytes.length) {
      const written = writeSync(fd, ownedBytes, offset, ownedBytes.length - offset, offset);
      if (written <= 0) throw new Error('write made no progress');
      offset += written;
    }
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    const named = lstatSync(path, { bigint: true });
    const finalOpened = fstatSync(fd, { bigint: true });
    if (!privateFile(named) || !privateFile(finalOpened) || !sameIdentity(opened, named) ||
      !sameIdentity(opened, finalOpened) || named.size !== BigInt(ownedBytes.length)) throw new Error('file changed');
    if (!assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath }).ok) {
      throw new Error('private file assurance failed');
    }
    const parentAfter = inspectDirectory(parent, anchorPath);
    if (!parentAfter || !sameIdentity(parentBefore, parentAfter)) throw new Error('file parent changed');
    fsyncDirectory(parent, { expectedIdentity: parentBefore });
    const parentDurable = inspectDirectory(parent, anchorPath);
    if (!parentDurable || !sameIdentity(parentBefore, parentDurable)) throw new Error('file parent changed');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readExactFile(path: string, maximumBytes: number, anchorPath: string): Buffer | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!privateFile(before) || before.size <= 0n || before.size > BigInt(maximumBytes) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!privateFile(opened) || !sameIdentity(before, opened) || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    return privateFile(after) && privateFile(namedAfter) && sameIdentity(opened, after) &&
      sameIdentity(opened, namedAfter) && after.size === opened.size ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readDirectoryBounded(path: string, maximumEntries: number, anchorPath: string): string[] | null {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    const before = inspectDirectory(path, anchorPath);
    if (!before) return null;
    directory = opendirSync(path);
    const entries: string[] = [];
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry.name);
      if (entries.length > maximumEntries) return null;
    }
    directory.closeSync();
    directory = undefined;
    const after = inspectDirectory(path, anchorPath);
    return after && sameIdentity(before, after) ? entries : null;
  } catch {
    return null;
  } finally {
    if (directory) {
      try { directory.closeSync(); } catch { /* best effort */ }
    }
  }
}

type AgentOsEpochLedgerLayoutModeV1 = 'must-be-empty' | 'runtime-owned';

function validRuntimeLedgerLayout(path: string, anchorPath: string, lockFileName: string): boolean {
  const entries = readDirectoryBounded(path, 3, anchorPath);
  if (!entries) return false;
  if (entries.length === 0) return true;
  const allowed = new Set([
    ATTEMPT_RECORDS_DIRECTORY,
    ATTEMPT_STAGING_DIRECTORY,
    lockFileName,
  ]);
  if (entries.some((entry) => !allowed.has(entry))) return false;
  const records = entries.includes(ATTEMPT_RECORDS_DIRECTORY)
    ? inspectDirectory(join(path, ATTEMPT_RECORDS_DIRECTORY), anchorPath)
    : null;
  const staging = entries.includes(ATTEMPT_STAGING_DIRECTORY)
    ? inspectDirectory(join(path, ATTEMPT_STAGING_DIRECTORY), anchorPath)
    : null;
  if (entries.includes(ATTEMPT_RECORDS_DIRECTORY) && !records ||
    entries.includes(ATTEMPT_STAGING_DIRECTORY) && !staging ||
    records && staging && sameIdentity(records, staging)) return false;
  if (entries.includes(lockFileName)) {
    try {
      const lock = lstatSync(join(path, lockFileName), { bigint: true });
      if (!privateFile(lock)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parseExactObject(bytes: Uint8Array, keys: readonly string[]): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const row = plainRecord(value);
    if (!row || !exactKeys(row, keys)) return null;
    const canonical = canonicalObjectBytes(row);
    return canonical && exactBytes(bytes, canonical) ? row : null;
  } catch {
    return null;
  }
}

const EVIDENCE_KEYS = [
  'attemptNamespaceDigest', 'epoch', 'firstSourceBundleDigest', 'manifestDigest',
  'previousHeadDigest', 'recoveryOperationId', 'snapshotBasePreviousEnvelopeDigest',
] as const;

function canonicalEvidence(value: unknown): { evidence: AgentOsPreparedEpochEvidenceV1; bytes: Buffer } | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, EVIDENCE_KEYS) || !validEpoch(row['epoch']) ||
    !validDigest(row['attemptNamespaceDigest']) || !validRawDigest(row['firstSourceBundleDigest']) ||
    !validDigest(row['manifestDigest']) || !validDigest(row['previousHeadDigest']) ||
    !validDigest(row['recoveryOperationId']) || !validRawDigest(row['snapshotBasePreviousEnvelopeDigest'])) {
    return null;
  }
  const bytes = canonicalObjectBytes(row);
  return bytes ? { evidence: structuredClone(row) as unknown as AgentOsPreparedEpochEvidenceV1, bytes } : null;
}

const MARKER_KEYS = [
  'authority', 'epoch', 'firstSourceBundleDigest', 'firstSourceBytesDigest', 'headBytesDigest',
  'headDigest', 'manifestBytesDigest', 'manifestDigest', 'operationId', 'phase', 'pointerMutationAuthorized',
  'preparedEvidenceBytesDigest', 'protocol', 'rollbackProtected', 'schemaVersion', 'writesAuthorized',
] as const;

function canonicalMarker(value: unknown): { marker: RecoveryMarkerV1; bytes: Buffer } | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, MARKER_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_EPOCH_RECOVERY_PROTOCOL_V1 || !validEpoch(row['epoch']) ||
    !['operationId', 'manifestDigest', 'headDigest', 'manifestBytesDigest', 'headBytesDigest',
      'firstSourceBytesDigest', 'preparedEvidenceBytesDigest'].every((key) => validDigest(row[key])) ||
    !validRawDigest(row['firstSourceBundleDigest']) ||
    row['phase'] !== 'cas-pending' || row['authority'] !== 'observation-only' ||
    row['writesAuthorized'] !== false || row['pointerMutationAuthorized'] !== false ||
    row['rollbackProtected'] !== false) return null;
  const bytes = canonicalObjectBytes(row);
  return bytes ? { marker: structuredClone(row) as unknown as RecoveryMarkerV1, bytes } : null;
}

function pinPreparedCandidate(
  input: Pick<PrepareAgentOsEpochInputV1,
    'canonicalManifestBytes' | 'canonicalHeadBytes' | 'canonicalFirstSourceBundleBytes' | 'preparedEvidence'>,
  dependencies: PinnedDependencies,
): PreparedCandidate | null {
  try {
    const manifestBytes = Buffer.from(input.canonicalManifestBytes);
    const headBytes = Buffer.from(input.canonicalHeadBytes);
    const sourceBytes = Buffer.from(input.canonicalFirstSourceBundleBytes);
    if (manifestBytes.length === 0 || manifestBytes.length > MAX_PROTOCOL_BYTES ||
      headBytes.length === 0 || headBytes.length > MAX_PROTOCOL_BYTES ||
      sourceBytes.length === 0 || sourceBytes.length > MAX_FIRST_SOURCE_BYTES) return null;
    const manifest = parseAgentOsObservationEpochManifestV1(manifestBytes);
    const head = parseAgentOsObservationEpochHeadV1(headBytes);
    const evidenceValue = canonicalEvidence(input.preparedEvidence);
    if (!manifest || !head || !evidenceValue ||
      !exactBytes(manifestBytes, canonicalAgentOsObservationEpochManifestBytesV1(manifest) ?? Buffer.alloc(0)) ||
      !exactBytes(headBytes, canonicalAgentOsObservationEpochHeadBytesV1(head) ?? Buffer.alloc(0)) ||
      manifest.epoch !== head.epoch || head.epochManifestDigest !== manifest.manifestDigest ||
      head.firstSourceBundleDigest !== manifest.firstSourceBundle.bundleDigest ||
      head.writerProtocolDigest !== dependencies.writerProtocolDigest ||
      evidenceValue.evidence.epoch !== head.epoch ||
      evidenceValue.evidence.previousHeadDigest !== head.previousHeadDigest ||
      evidenceValue.evidence.manifestDigest !== manifest.manifestDigest ||
      evidenceValue.evidence.firstSourceBundleDigest !== manifest.firstSourceBundle.bundleDigest ||
      evidenceValue.evidence.snapshotBasePreviousEnvelopeDigest !== manifest.snapshotBase.previousEnvelopeDigest ||
      evidenceValue.evidence.attemptNamespaceDigest !== manifest.attemptNamespaceDigest) return null;
    let manifestAuthenticated = false;
    let evidenceAuthenticated = false;
    let sourceVerified = false;
    try {
      manifestAuthenticated = dependencies.manifestAuthenticatorVerifier(Buffer.from(manifestBytes), deepFreeze(structuredClone(manifest))) === true;
      evidenceAuthenticated = dependencies.preparedEpochEvidenceVerifier(deepFreeze(structuredClone(evidenceValue.evidence))) === true;
      sourceVerified = dependencies.firstSourceBundleVerifier(Buffer.from(sourceBytes), manifest.firstSourceBundle.bundleDigest) === true;
    } catch { return null; }
    if (!manifestAuthenticated || !evidenceAuthenticated || !sourceVerified) return null;
    const marker: RecoveryMarkerV1 = {
      schemaVersion: 1,
      protocol: AGENT_OS_EPOCH_RECOVERY_PROTOCOL_V1,
      epoch: head.epoch,
      operationId: evidenceValue.evidence.recoveryOperationId,
      manifestDigest: manifest.manifestDigest,
      headDigest: head.headDigest,
      firstSourceBundleDigest: manifest.firstSourceBundle.bundleDigest,
      manifestBytesDigest: sha256(manifestBytes),
      headBytesDigest: sha256(headBytes),
      firstSourceBytesDigest: sha256(sourceBytes),
      preparedEvidenceBytesDigest: sha256(evidenceValue.bytes),
      phase: 'cas-pending',
      authority: 'observation-only',
      writesAuthorized: false,
      pointerMutationAuthorized: false,
      rollbackProtected: false,
    };
    const markerValue = canonicalMarker(marker);
    return markerValue ? {
      epoch: head.epoch,
      operationId: evidenceValue.evidence.recoveryOperationId,
      manifestBytes,
      headBytes,
      sourceBytes,
      evidence: evidenceValue.evidence,
      evidenceBytes: evidenceValue.bytes,
      marker,
      markerBytes: markerValue.bytes,
    } : null;
  } catch {
    return null;
  }
}

function ownsRequiredLocks(
  dependencies: PinnedDependencies,
  coordinationLease: AgentOsEpochCoordinationLeaseV1,
  observationLock: LocalStoreLock,
): boolean {
  try {
    return ownsAgentOsEpochCoordinationLeaseV1(coordinationLease, {
      rootPath: dependencies.rootPath,
      writerProtocolDigest: dependencies.writerProtocolDigest,
    }) && ownsLocalStoreLock(observationLock) &&
      observationLock.path === join(dependencies.anchorPath, '.agent-os-observation-transaction-v1.lock');
  } catch {
    return false;
  }
}

function readPreparedCandidate(
  dependencies: PinnedDependencies,
  epoch: number,
  ledgerLayout: AgentOsEpochLedgerLayoutModeV1 = 'must-be-empty',
): { candidate: PreparedCandidate | null; reason: AgentOsEpochStoreReasonV1 } {
  try {
    if (!validEpoch(epoch)) return { candidate: null, reason: 'invalid-input' };
    const root = inspectDirectory(dependencies.rootPath, dependencies.anchorPath);
    if (!root && !existsSync(dependencies.rootPath)) return { candidate: null, reason: 'missing' };
    const epochsPath = join(dependencies.rootPath, 'epochs');
    const epochs = inspectDirectory(epochsPath, dependencies.anchorPath);
    if (!root || !epochs || sameIdentity(root, epochs)) return { candidate: null, reason: 'unsafe-storage' };
    const entries = readDirectoryBounded(epochsPath, MAX_EPOCH_ENTRIES, dependencies.anchorPath);
    if (!entries || entries.some((entry) =>
      !EPOCH_DIRECTORY_RE.test(entry) && !PREPARE_DIRECTORY_RE.test(entry))) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    const token = epochToken(epoch);
    if (entries.some((entry) => entry.startsWith(`.epoch-${token}-`) && PREPARE_DIRECTORY_RE.test(entry))) {
      return { candidate: null, reason: 'incomplete-preparation' };
    }
    const epochPath = join(epochsPath, `epoch-${token}`);
    if (!existsSync(epochPath)) return { candidate: null, reason: 'missing' };
    const epochStat = inspectDirectory(epochPath, dependencies.anchorPath);
    if (!epochStat || sameIdentity(epochStat, epochs) || sameIdentity(epochStat, root)) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    const epochEntries = readDirectoryBounded(
      epochPath,
      PREPARED_ENTRIES.length,
      dependencies.anchorPath,
    )?.sort();
    if (!epochEntries) return { candidate: null, reason: 'unsafe-storage' };
    if (epochEntries.length !== PREPARED_ENTRIES.length ||
      !epochEntries.every((entry, index) => entry === PREPARED_ENTRIES[index])) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    const snapshots = inspectDirectory(join(epochPath, SNAPSHOTS_DIRECTORY), dependencies.anchorPath);
    const attempts = inspectDirectory(join(epochPath, ATTEMPTS_DIRECTORY), dependencies.anchorPath);
    const snapshotPath = join(epochPath, SNAPSHOTS_DIRECTORY);
    const attemptPath = join(epochPath, ATTEMPTS_DIRECTORY);
    const snapshotLayoutValid = ledgerLayout === 'must-be-empty'
      ? readDirectoryBounded(snapshotPath, 0, dependencies.anchorPath) !== null
      : validRuntimeLedgerLayout(snapshotPath, dependencies.anchorPath, SNAPSHOT_LEDGER_LOCK_FILE);
    const attemptLayoutValid = ledgerLayout === 'must-be-empty'
      ? readDirectoryBounded(attemptPath, 0, dependencies.anchorPath) !== null
      : validRuntimeLedgerLayout(attemptPath, dependencies.anchorPath, ATTEMPT_LEDGER_LOCK_FILE);
    const snapshotsAfter = inspectDirectory(snapshotPath, dependencies.anchorPath);
    const attemptsAfter = inspectDirectory(attemptPath, dependencies.anchorPath);
    const sourcePath = join(epochPath, SOURCES_DIRECTORY);
    const sources = inspectDirectory(sourcePath, dependencies.anchorPath);
    const sourceLayoutValid = ledgerLayout === 'must-be-empty'
      ? readDirectoryBounded(sourcePath, 0, dependencies.anchorPath) !== null
      : validRuntimeLedgerLayout(sourcePath, dependencies.anchorPath, SOURCE_LEDGER_LOCK_FILE);
    const sourcesAfter = inspectDirectory(sourcePath, dependencies.anchorPath);
    if (!snapshots || !attempts || sameIdentity(snapshots, attempts) || !snapshotLayoutValid ||
      !sources || !attemptLayoutValid || !sourceLayoutValid || !snapshotsAfter || !attemptsAfter ||
      !sameIdentity(snapshots, snapshotsAfter) || !sameIdentity(attempts, attemptsAfter)) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    if (!sourcesAfter || sameIdentity(sources, snapshots) || sameIdentity(sources, attempts) ||
      sameIdentity(sources, epochStat) || !sameIdentity(sources, sourcesAfter)) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    const manifestBytes = readExactFile(join(epochPath, MANIFEST_FILE), MAX_PROTOCOL_BYTES, dependencies.anchorPath);
    const headBytes = readExactFile(join(epochPath, HEAD_FILE), MAX_PROTOCOL_BYTES, dependencies.anchorPath);
    const sourceBytes = readExactFile(join(epochPath, FIRST_SOURCE_FILE), MAX_FIRST_SOURCE_BYTES, dependencies.anchorPath);
    const evidenceBytes = readExactFile(join(epochPath, EVIDENCE_FILE), MAX_PROTOCOL_BYTES, dependencies.anchorPath);
    const markerBytes = readExactFile(join(epochPath, RECOVERY_FILE), MAX_PROTOCOL_BYTES, dependencies.anchorPath);
    if (!manifestBytes || !headBytes || !sourceBytes || !evidenceBytes || !markerBytes) {
      return { candidate: null, reason: 'unsafe-storage' };
    }
    const evidenceValue = canonicalEvidence(parseExactObject(evidenceBytes, EVIDENCE_KEYS));
    const markerValue = canonicalMarker(parseExactObject(markerBytes, MARKER_KEYS));
    if (!evidenceValue || !markerValue || !exactBytes(evidenceBytes, evidenceValue.bytes) ||
      !exactBytes(markerBytes, markerValue.bytes)) return { candidate: null, reason: 'artifact-conflict' };
    const candidate = pinPreparedCandidate({
      canonicalManifestBytes: manifestBytes,
      canonicalHeadBytes: headBytes,
      canonicalFirstSourceBundleBytes: sourceBytes,
      preparedEvidence: evidenceValue.evidence,
    }, dependencies);
    if (!candidate || markerValue.marker.epoch !== epoch || markerValue.marker.operationId !== candidate.operationId ||
      markerValue.marker.manifestDigest !== candidate.marker.manifestDigest ||
      markerValue.marker.headDigest !== candidate.marker.headDigest ||
      markerValue.marker.firstSourceBundleDigest !== candidate.marker.firstSourceBundleDigest ||
      markerValue.marker.manifestBytesDigest !== sha256(manifestBytes) ||
      markerValue.marker.headBytesDigest !== sha256(headBytes) ||
      markerValue.marker.firstSourceBytesDigest !== sha256(sourceBytes) ||
      markerValue.marker.preparedEvidenceBytesDigest !== sha256(evidenceBytes)) {
      return { candidate: null, reason: 'artifact-conflict' };
    }
    return { candidate, reason: 'prepared' };
  } catch {
    return { candidate: null, reason: 'io-failure' };
  }
}

export function prepareAgentOsEpochV1(
  input: PrepareAgentOsEpochInputV1,
  suppliedDependencies: AgentOsEpochStoreDependenciesV1,
): AgentOsEpochStoreMutationResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  const row = plainRecord(input);
  if (!dependencies || !row || !exactKeys(row, [
    'canonicalFirstSourceBundleBytes', 'canonicalHeadBytes', 'canonicalManifestBytes',
    'coordinationLease', 'observationLock', 'preparedEvidence',
  ]) || !ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock)) {
    return mutationResult('withheld', 'invalid-input');
  }
  const candidate = pinPreparedCandidate(input, dependencies);
  if (!candidate) return mutationResult('withheld', 'invalid-input');
  try {
    const { epochs } = ensureRoot(dependencies);
    const epochsPath = join(dependencies.rootPath, 'epochs');
    const existing = readPreparedCandidate(dependencies, candidate.epoch);
    if (existing.candidate) {
      const same = existing.candidate.operationId === candidate.operationId &&
        exactBytes(existing.candidate.manifestBytes, candidate.manifestBytes) &&
        exactBytes(existing.candidate.headBytes, candidate.headBytes) &&
        exactBytes(existing.candidate.sourceBytes, candidate.sourceBytes) &&
        exactBytes(existing.candidate.evidenceBytes, candidate.evidenceBytes);
      if (!same) return mutationResult('degraded', 'artifact-conflict', candidate.epoch, candidate.operationId);
      fsyncDirectory(epochsPath, { expectedIdentity: epochs });
      afterStep(dependencies, 'prepared-epoch-replay-durable');
      const durableReplay = readPreparedCandidate(dependencies, candidate.epoch);
      return durableReplay.candidate && durableReplay.candidate.operationId === candidate.operationId &&
        exactBytes(durableReplay.candidate.manifestBytes, candidate.manifestBytes) &&
        exactBytes(durableReplay.candidate.headBytes, candidate.headBytes) &&
        exactBytes(durableReplay.candidate.sourceBytes, candidate.sourceBytes) &&
        exactBytes(durableReplay.candidate.evidenceBytes, candidate.evidenceBytes)
        ? mutationResult('accepted', 'replayed', candidate.epoch, candidate.operationId, true)
        : mutationResult('degraded', durableReplay.reason, candidate.epoch, candidate.operationId);
    }
    if (existing.reason !== 'missing') {
      return mutationResult('degraded', existing.reason, candidate.epoch, candidate.operationId);
    }
    const finalPath = join(epochsPath, `epoch-${epochToken(candidate.epoch)}`);
    const stagingPath = join(epochsPath, `.epoch-${epochToken(candidate.epoch)}-${candidate.operationId.slice(7)}.prepare`);
    if (existsSync(finalPath) || existsSync(stagingPath)) {
      return mutationResult('degraded', 'incomplete-preparation', candidate.epoch, candidate.operationId);
    }
    const staging = ensureDirectory(stagingPath, epochsPath, dependencies.anchorPath);
    afterStep(dependencies, 'staging-directory-durable');
    writeNewFile(join(stagingPath, MANIFEST_FILE), candidate.manifestBytes, stagingPath, dependencies.anchorPath);
    afterStep(dependencies, 'manifest-durable');
    writeNewFile(join(stagingPath, HEAD_FILE), candidate.headBytes, stagingPath, dependencies.anchorPath);
    afterStep(dependencies, 'head-durable');
    writeNewFile(join(stagingPath, FIRST_SOURCE_FILE), candidate.sourceBytes, stagingPath, dependencies.anchorPath);
    afterStep(dependencies, 'first-source-durable');
    ensureDirectory(join(stagingPath, SOURCES_DIRECTORY), stagingPath, dependencies.anchorPath);
    fsyncDirectory(join(stagingPath, SOURCES_DIRECTORY));
    afterStep(dependencies, 'sources-directory-durable');
    ensureDirectory(join(stagingPath, SNAPSHOTS_DIRECTORY), stagingPath, dependencies.anchorPath);
    fsyncDirectory(join(stagingPath, SNAPSHOTS_DIRECTORY));
    afterStep(dependencies, 'snapshots-directory-durable');
    ensureDirectory(join(stagingPath, ATTEMPTS_DIRECTORY), stagingPath, dependencies.anchorPath);
    fsyncDirectory(join(stagingPath, ATTEMPTS_DIRECTORY));
    afterStep(dependencies, 'attempts-directory-durable');
    writeNewFile(join(stagingPath, EVIDENCE_FILE), candidate.evidenceBytes, stagingPath, dependencies.anchorPath);
    afterStep(dependencies, 'prepared-evidence-durable');
    writeNewFile(join(stagingPath, RECOVERY_FILE), candidate.markerBytes, stagingPath, dependencies.anchorPath);
    afterStep(dependencies, 'recovery-marker-durable');
    if (!ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock)) {
      return mutationResult('degraded', 'incomplete-preparation', candidate.epoch, candidate.operationId);
    }
    const stagingBeforeRename = inspectDirectory(stagingPath, dependencies.anchorPath);
    const epochsBeforeRename = inspectDirectory(epochsPath, dependencies.anchorPath);
    if (!stagingBeforeRename || !epochsBeforeRename || !sameIdentity(staging, stagingBeforeRename) ||
      !sameIdentity(epochs, epochsBeforeRename)) throw new Error('preparation directory changed');
    fsyncDirectory(stagingPath, { expectedIdentity: stagingBeforeRename });
    renameSync(stagingPath, finalPath);
    const published = inspectDirectory(finalPath, dependencies.anchorPath);
    const epochsAfterRename = inspectDirectory(epochsPath, dependencies.anchorPath);
    if (!published || !epochsAfterRename || !sameIdentity(stagingBeforeRename, published) ||
      !sameIdentity(epochsBeforeRename, epochsAfterRename)) throw new Error('published directory changed');
    fsyncDirectory(epochsPath, { expectedIdentity: epochsBeforeRename });
    afterStep(dependencies, 'prepared-epoch-published');
    const verified = readPreparedCandidate(dependencies, candidate.epoch);
    return verified.candidate
      ? mutationResult('accepted', 'prepared', candidate.epoch, candidate.operationId, true)
      : mutationResult('degraded', verified.reason, candidate.epoch, candidate.operationId);
  } catch {
    return mutationResult('degraded', 'io-failure', candidate.epoch, candidate.operationId);
  }
}

export function readPreparedAgentOsEpochV1(
  suppliedDependencies: AgentOsEpochStoreDependenciesV1,
  epoch: number,
): AgentOsPreparedEpochReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return preparedReadResult(mutationResult('withheld', 'invalid-input'));
  const read = readPreparedCandidate(dependencies, epoch);
  if (!read.candidate) {
    const state = read.reason === 'missing' ? 'missing' : read.reason === 'invalid-input' ? 'withheld' : 'degraded';
    return preparedReadResult(mutationResult(state, read.reason, validEpoch(epoch) ? epoch : null));
  }
  return preparedReadResult(
    mutationResult('accepted', 'prepared', read.candidate.epoch, read.candidate.operationId, true),
    read.candidate,
  );
}

const POINTER_KEYS = [
  'authority', 'canonicalHeadBase64', 'epoch', 'headDigest', 'manifestDigest', 'operationId',
  'pointerMutationAuthorized', 'protocol', 'rollbackProtected', 'schemaVersion', 'writesAuthorized',
] as const;

function canonicalPointer(value: unknown): { pointer: ActivePointerV1; bytes: Buffer; headBytes: Buffer } | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, POINTER_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1 || !validEpoch(row['epoch']) ||
    !validDigest(row['headDigest']) || !validDigest(row['manifestDigest']) || !validDigest(row['operationId']) ||
    typeof row['canonicalHeadBase64'] !== 'string' || row['canonicalHeadBase64'].length > MAX_POINTER_BYTES ||
    row['authority'] !== 'observation-only' || row['writesAuthorized'] !== false ||
    row['pointerMutationAuthorized'] !== false || row['rollbackProtected'] !== false) return null;
  const headBytes = Buffer.from(row['canonicalHeadBase64'], 'base64');
  if (headBytes.length === 0 || headBytes.toString('base64') !== row['canonicalHeadBase64']) return null;
  const head = parseAgentOsObservationEpochHeadV1(headBytes);
  if (!head || head.epoch !== row['epoch'] || head.headDigest !== row['headDigest'] ||
    head.epochManifestDigest !== row['manifestDigest']) return null;
  const bytes = canonicalObjectBytes(row);
  return bytes && bytes.length <= MAX_POINTER_BYTES
    ? { pointer: structuredClone(row) as unknown as ActivePointerV1, bytes, headBytes }
    : null;
}

function readPointerInternal(
  dependencies: PinnedDependencies,
): {
  value: ReturnType<typeof canonicalPointer>;
  candidate: PreparedCandidate | null;
  reason: AgentOsEpochStoreReasonV1;
} {
  try {
    const root = inspectDirectory(dependencies.rootPath, dependencies.anchorPath);
    if (!root) return {
      value: null,
      candidate: null,
      reason: existsSync(dependencies.rootPath) ? 'unsafe-storage' : 'missing',
    };
    const pointerPath = join(dependencies.rootPath, ACTIVE_POINTER_FILE);
    if (!existsSync(pointerPath)) return { value: null, candidate: null, reason: 'missing' };
    const bytes = readExactFile(pointerPath, MAX_POINTER_BYTES, dependencies.anchorPath);
    const row = bytes ? parseExactObject(bytes, POINTER_KEYS) : null;
    const value = row ? canonicalPointer(row) : null;
    if (!value || !exactBytes(bytes!, value.bytes)) {
      return { value: null, candidate: null, reason: 'artifact-conflict' };
    }
    const prepared = readPreparedCandidate(dependencies, value.pointer.epoch, 'runtime-owned');
    if (!prepared.candidate || prepared.candidate.operationId !== value.pointer.operationId ||
      !exactBytes(prepared.candidate.headBytes, value.headBytes)) {
      return { value: null, candidate: null, reason: 'artifact-conflict' };
    }
    return { value, candidate: prepared.candidate, reason: 'pointer-installed' };
  } catch {
    return { value: null, candidate: null, reason: 'io-failure' };
  }
}

export function readAgentOsActiveEpochPointerV1(
  suppliedDependencies: AgentOsEpochStoreDependenciesV1,
): AgentOsActivePointerReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return pointerReadResult(mutationResult('withheld', 'invalid-input'));
  const read = readPointerInternal(dependencies);
  if (!read.value) {
    return pointerReadResult(mutationResult(read.reason === 'missing' ? 'missing' : 'degraded', read.reason));
  }
  return pointerReadResult(
    mutationResult('accepted', 'pointer-installed', read.value.pointer.epoch,
      read.value.pointer.operationId, true, true),
    read.value.pointer,
    read.value.headBytes,
  );
}

/**
 * Reads the exact immutable artifacts selected by the local active pointer.
 * This does not authenticate the external anchor or any runtime ledger and is
 * therefore evidence only. Runtime composition must perform a fresh anchor
 * read and verifier selection inside its own held transaction.
 */
export function readAgentOsActiveEpochArtifactsV1(
  suppliedDependencies: AgentOsEpochStoreDependenciesV1,
): AgentOsActiveEpochArtifactsReadResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies) return activeArtifactsReadResult(mutationResult('withheld', 'invalid-input'));
  const read = readPointerInternal(dependencies);
  if (!read.value || !read.candidate) {
    return activeArtifactsReadResult(mutationResult(
      read.reason === 'missing' ? 'missing' : 'degraded',
      read.reason,
    ));
  }
  return activeArtifactsReadResult(
    mutationResult(
      'accepted',
      'pointer-installed',
      read.value.pointer.epoch,
      read.value.pointer.operationId,
      true,
      true,
    ),
    read.candidate,
  );
}

export function installAgentOsActiveEpochPointerV1(
  input: InstallAgentOsActivePointerInputV1,
  suppliedDependencies: AgentOsEpochStoreDependenciesV1,
): AgentOsEpochStoreMutationResultV1 {
  const dependencies = pinDependencies(suppliedDependencies);
  if (!dependencies || !plainRecord(input) || !exactKeys(input as unknown as Record<string, unknown>, [
    'canonicalHeadBytes', 'coordinationLease', 'expectedPreviousHeadDigest', 'observationLock', 'operationId',
  ]) || !validDigest(input.operationId) ||
    (input.expectedPreviousHeadDigest !== null && !validDigest(input.expectedPreviousHeadDigest))) {
    return mutationResult('withheld', 'invalid-input');
  }
  try {
    const headBytes = Buffer.from(input.canonicalHeadBytes);
    const head = parseAgentOsObservationEpochHeadV1(headBytes);
    if (!head || !exactBytes(headBytes, canonicalAgentOsObservationEpochHeadBytesV1(head) ?? Buffer.alloc(0)) ||
      head.previousHeadDigest !== input.expectedPreviousHeadDigest && input.expectedPreviousHeadDigest !== null) {
      return mutationResult('withheld', 'invalid-input');
    }
    if (!ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock)) {
      return mutationResult('withheld', 'invalid-input', head.epoch, input.operationId);
    }
    const { root } = ensureRoot(dependencies);
    const current = readPointerInternal(dependencies);
    if (current.value) {
      if (exactBytes(current.value.headBytes, headBytes) && current.value.pointer.operationId === input.operationId) {
        let anchorRead: ReturnType<PinnedDependencies['readAnchorHead']>;
        let locksStillHeld = false;
        try {
          locksStillHeld = ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock);
          anchorRead = dependencies.readAnchorHead();
          locksStillHeld = locksStillHeld && ownsRequiredLocks(
            dependencies,
            input.coordinationLease,
            input.observationLock,
          );
        } catch {
          locksStillHeld = false;
          anchorRead = { state: 'unavailable' };
        }
        if (!locksStillHeld || anchorRead.state !== 'present' ||
          !exactBytes(Buffer.from(anchorRead.canonicalHeadBytes), headBytes)) {
          return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId, true, true);
        }
        fsyncDirectory(dependencies.rootPath, { expectedIdentity: root });
        afterStep(dependencies, 'pointer-replay-durable');
        const durableReplay = readPointerInternal(dependencies);
        return durableReplay.value && durableReplay.value.pointer.operationId === input.operationId &&
          exactBytes(durableReplay.value.headBytes, headBytes) &&
          ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock)
          ? mutationResult('accepted', 'pointer-replayed', head.epoch, input.operationId, true, true, true)
          : mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId, true, true);
      }
      if (input.expectedPreviousHeadDigest === null ||
        current.value.pointer.headDigest !== input.expectedPreviousHeadDigest ||
        current.value.pointer.epoch + 1 !== head.epoch) {
        return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId);
      }
    } else if (current.reason !== 'missing') {
      return mutationResult('degraded', current.reason, head.epoch, input.operationId);
    } else if (input.expectedPreviousHeadDigest !== null) {
      return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId);
    }
    // A first install must still consume a pristine prepared candidate. Exact
    // replay is handled above from the runtime-owned active candidate so
    // normal ledger initialization cannot make a durable pointer unreplayable.
    const prepared = readPreparedCandidate(dependencies, head.epoch);
    if (!prepared.candidate || prepared.candidate.operationId !== input.operationId ||
      !exactBytes(prepared.candidate.headBytes, headBytes)) {
      return mutationResult('degraded', 'prepared-evidence-unverified', head.epoch, input.operationId);
    }
    const pointer: ActivePointerV1 = {
      schemaVersion: 1,
      protocol: AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1,
      epoch: head.epoch,
      headDigest: head.headDigest,
      manifestDigest: head.epochManifestDigest,
      operationId: input.operationId,
      canonicalHeadBase64: headBytes.toString('base64'),
      authority: 'observation-only',
      writesAuthorized: false,
      pointerMutationAuthorized: false,
      rollbackProtected: false,
    };
    const encoded = canonicalPointer(pointer);
    if (!encoded) return mutationResult('withheld', 'invalid-input');
    const pointerPath = join(dependencies.rootPath, ACTIVE_POINTER_FILE);
    const temporaryPath = join(dependencies.rootPath, `.active-pointer-${head.headDigest.slice(7)}.tmp`);
    if (existsSync(temporaryPath)) return mutationResult('degraded', 'incomplete-preparation', head.epoch, input.operationId);
    writeNewFile(temporaryPath, encoded.bytes, dependencies.rootPath, dependencies.anchorPath);
    afterStep(dependencies, 'pointer-temporary-durable');
    // The caller must hold the M546 transaction lock. A final exact reread
    // narrows cooperative races; this local cache never substitutes for CAS.
    const finalCurrent = readPointerInternal(dependencies);
    if (current.value) {
      if (!finalCurrent.value || finalCurrent.value.pointer.headDigest !== current.value.pointer.headDigest) {
        unlinkSync(temporaryPath);
        fsyncDirectory(dependencies.rootPath);
        return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId);
      }
    } else if (finalCurrent.reason !== 'missing') {
      unlinkSync(temporaryPath);
      fsyncDirectory(dependencies.rootPath);
      return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId);
    }
    let anchorRead: ReturnType<PinnedDependencies['readAnchorHead']>;
    let locksStillHeld = false;
    try {
      locksStillHeld = ownsRequiredLocks(dependencies, input.coordinationLease, input.observationLock);
      anchorRead = dependencies.readAnchorHead();
      locksStillHeld = locksStillHeld && ownsRequiredLocks(
        dependencies,
        input.coordinationLease,
        input.observationLock,
      );
    } catch {
      locksStillHeld = false;
      anchorRead = { state: 'unavailable' };
    }
    if (!locksStillHeld || anchorRead.state !== 'present' ||
      !exactBytes(Buffer.from(anchorRead.canonicalHeadBytes), headBytes)) {
      unlinkSync(temporaryPath);
      fsyncDirectory(dependencies.rootPath);
      return mutationResult('degraded', 'pointer-conflict', head.epoch, input.operationId);
    }
    const rootBeforeRename = inspectDirectory(dependencies.rootPath, dependencies.anchorPath);
    if (!rootBeforeRename || !sameIdentity(root, rootBeforeRename)) {
      return mutationResult('degraded', 'unsafe-storage', head.epoch, input.operationId);
    }
    renameSync(temporaryPath, pointerPath);
    afterStep(dependencies, 'pointer-renamed');
    const rootAfterRename = inspectDirectory(dependencies.rootPath, dependencies.anchorPath);
    const installedPointerBytes = readExactFile(pointerPath, MAX_POINTER_BYTES, dependencies.anchorPath);
    if (!rootAfterRename || !sameIdentity(rootBeforeRename, rootAfterRename) ||
      !installedPointerBytes || !exactBytes(installedPointerBytes, encoded.bytes)) {
      return mutationResult('degraded', 'unsafe-storage', head.epoch, input.operationId, true);
    }
    fsyncDirectory(dependencies.rootPath, { expectedIdentity: rootBeforeRename });
    afterStep(dependencies, 'pointer-directory-durable');
    const installed = readPointerInternal(dependencies);
    return installed.value && exactBytes(installed.value.headBytes, headBytes)
      ? mutationResult('accepted', 'pointer-installed', head.epoch, input.operationId, true, true, true)
      : mutationResult('degraded', installed.reason, head.epoch, input.operationId, true);
  } catch {
    return mutationResult('degraded', 'io-failure');
  }
}
