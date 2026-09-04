/**
 * Execution Capacity Lease V1.
 *
 * A private, default-off reservation ledger for already-authenticated execution
 * identity capacity observations. A lease is bookkeeping only: this module has
 * no model/runtime execution, provider, credential, routing, or
 * runtime-resolution capability. Its shared private-storage and lock helpers
 * may perform bounded local OS security inspection using fixed system tools.
 * Allocation tombstones are retained until the bounded store fills so an old
 * allocation identity can never acquire a new lifetime (ABA) accidentally.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  acquireLocalStoreLockWithOutcome,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export const EXECUTION_CAPACITY_LEASE_V1_PROTOCOL = 'ashlr-execution-capacity-lease-v1' as const;
export const EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL = 'ashlr-execution-capacity-evidence-v1' as const;

const STORE_FILE = 'leases-v1.json';
const STORE_LOCK = '.leases-v1.lock';
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LEASES = 2_048;
const MAX_IDENTITIES = 64;
const MAX_BATCH_ITEMS = 32;
const MAX_TRUSTED_SLOTS = 1_024;
const MAX_ALLOCATION_ID_BYTES = 4_096;
const MAX_AUTHENTICATOR_BYTES = 4_096;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const MIN_LEASE_TTL_MS = 1_000;
const MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_LOCK_WAIT_MS = 2_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const CAPABILITY_RE = /^ecap_[A-Za-z0-9_-]{43}$/u;

export const EXECUTION_CAPACITY_LEASE_NO_AUTHORITY_V1 = Object.freeze({
  authority: 'lease-only' as const,
  sameUserTamperResistant: false as const,
  executionAuthority: false as const,
  providerContactAuthority: false as const,
  routingMutation: false as const,
});

export interface ExecutionCapacityEvidenceUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL;
  authority: 'observation-only';
  executionAuthority: false;
  providerContactAuthority: false;
  routingMutation: false;
  verifierIdentityDigest: string;
  executionIdentityDigest: string;
  observationEpoch: number;
  trustedSlots: number;
  observedAt: string;
  expiresAt: string;
}

export interface ExecutionCapacityEvidenceEnvelopeV1 extends ExecutionCapacityEvidenceUnsignedV1 {
  evidenceDigest: string;
  authenticator: string;
}

export interface ExecutionCapacityEvidenceVerifierV1 {
  readonly verifierIdentityDigest: string;
  verify(input: Readonly<{
    verifierIdentityDigest: string;
    executionIdentityDigest: string;
    observationEpoch: number;
    evidenceDigest: string;
    canonicalDomainSeparatedEnvelope: Uint8Array;
    authenticator: string;
  }>): boolean;
}

export interface ExecutionCapacityLeaseBatchItemV1 {
  executionIdentityDigest: string;
  slots: number;
  expectedEvidenceDigest: string;
  evidenceEnvelope: ExecutionCapacityEvidenceEnvelopeV1;
}

export interface ExecutionCapacityLeaseAcquireInputV1 {
  allocationId: string;
  leaseTtlMs: number;
  items: readonly ExecutionCapacityLeaseBatchItemV1[];
}

export interface ExecutionCapacityLeaseRenewInputV1 extends ExecutionCapacityLeaseAcquireInputV1 {
  ownerCapability: string;
  expectedLeaseEpoch: number;
}

export interface ExecutionCapacityLeaseReleaseInputV1 {
  allocationId: string;
  ownerCapability: string;
  expectedLeaseEpoch: number;
}

export type ExecutionCapacityLeaseReasonV1 =
  | 'recorded'
  | 'replayed'
  | 'renewed'
  | 'released'
  | 'reclaimed'
  | 'disabled'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'verifier-unavailable'
  | 'evidence-unauthenticated'
  | 'evidence-stale'
  | 'evidence-future'
  | 'evidence-expired'
  | 'evidence-mismatch'
  | 'evidence-drift'
  | 'identity-conflict'
  | 'allocation-conflict'
  | 'allocation-finalized'
  | 'lease-not-found'
  | 'lease-expired'
  | 'owner-capability-invalid'
  | 'lease-epoch-conflict'
  | 'lease-epoch-exhausted'
  | 'trusted-slots-exhausted'
  | 'capacity-exhausted'
  | 'store-unavailable'
  | 'publication-failed'
  | 'lock-release-failed';

export interface ExecutionCapacityLeaseMutationResultV1
  extends Readonly<typeof EXECUTION_CAPACITY_LEASE_NO_AUTHORITY_V1> {
  disposition: 'recorded' | 'replayed' | 'withheld' | 'unavailable' | 'failed';
  reason: ExecutionCapacityLeaseReasonV1;
  allocationDigest: string | null;
  leaseEpoch: number | null;
  expiresAt: string | null;
  /** Present exactly once: only the successful first acquisition returns it. */
  ownerCapability: string | null;
  durable: boolean;
  committedWithoutReceipt: boolean;
}

export interface ExecutionCapacityLeaseIdentityInspectionV1 {
  executionIdentityDigest: string;
  evidenceDigest: string;
  observationEpoch: number;
  trustedSlots: number;
  reservedSlots: number;
  availableSlots: number;
  evidenceFresh: boolean;
}

export interface ExecutionCapacityLeasePublicRecordV1 {
  allocationDigest: string;
  leaseEpoch: number;
  state: 'reserved' | 'released' | 'expired';
  slots: number;
  expiresAt: string;
}

export interface ExecutionCapacityLeaseInspectionV1
  extends Readonly<typeof EXECUTION_CAPACITY_LEASE_NO_AUTHORITY_V1> {
  enabled: boolean;
  sourceState: 'disabled' | 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  identities: ExecutionCapacityLeaseIdentityInspectionV1[];
  leases: ExecutionCapacityLeasePublicRecordV1[];
  activeLeaseCount: number;
  expiredPendingReclaim: number;
  stopReasons: ExecutionCapacityLeaseReasonV1[];
}

export interface ExecutionCapacityLeaseStoreDependenciesV1 {
  /** Existing trusted ancestor containing rootPath. */
  anchorPath: string;
  rootPath: string;
  /** Explicit opt-in. Omission is disabled. */
  enabled?: boolean;
  /** Trusted composition dependency, captured once and bound by digest. */
  verifier?: ExecutionCapacityEvidenceVerifierV1 | null;
  clock?: () => Date;
  lockWaitMs?: number;
}

interface PersistedIdentityV1 {
  executionIdentityDigest: string;
  evidenceDigest: string;
  observationEpoch: number;
  trustedSlots: number;
  observedAt: string;
  expiresAt: string;
}

interface PersistedLeaseItemV1 {
  executionIdentityDigest: string;
  slots: number;
  evidenceDigest: string;
}

interface PersistedLeaseV1 {
  allocationIdHash: string;
  allocationDigest: string;
  requestDigest: string;
  ownerCapabilityCommitment: string;
  epoch: number;
  state: 'reserved' | 'released' | 'expired';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  items: PersistedLeaseItemV1[];
}

interface PersistedLedgerUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof EXECUTION_CAPACITY_LEASE_V1_PROTOCOL;
  identities: PersistedIdentityV1[];
  leases: PersistedLeaseV1[];
}

interface PersistedLedgerV1 extends PersistedLedgerUnsignedV1 { stateDigest: string }

interface BoundFile {
  found: boolean;
  dev?: bigint;
  ino?: bigint;
  size?: bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  bytes?: Buffer;
}

interface RootIdentity { path: string; dev: bigint; ino: bigint }

interface VerifiedBatchItem {
  executionIdentityDigest: string;
  slots: number;
  expectedEvidenceDigest: string;
  evidence: ExecutionCapacityEvidenceEnvelopeV1;
}

interface LeaseTestHooks {
  releaseLock?: (lock: LocalStoreLock) => boolean;
  beforeRename?: () => void;
  fsyncDirectory?: typeof fsyncDirectory;
  randomBytes?: (size: number) => Buffer;
}

let leaseTestHooks: LeaseTestHooks | undefined;

/** Test-only deterministic fault injection. */
export function setExecutionCapacityLeaseTestHooksForTests(hooks?: LeaseTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('execution capacity lease hooks are test-only');
  leaseTestHooks = hooks;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function sha256(domain: string, value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update('\0').update(value).digest('hex')}`;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (utilTypes.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return null;
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return null;
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) =>
      [key, (descriptor as PropertyDescriptor & { value: unknown }).value]));
  } catch {
    return null;
  }
}

function snapshotPlainArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return null;
    const length = descriptors['length'];
    if (!length || !('value' in length) || !safeInteger(length.value, 1, maximum)) return null;
    const expectedKeys = ['length', ...Array.from({ length: length.value as number }, (_, index) => String(index))];
    if (!exactKeys(descriptors as unknown as Record<string, unknown>, expectedKeys)) return null;
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function evidenceUnsigned(envelope: ExecutionCapacityEvidenceEnvelopeV1): ExecutionCapacityEvidenceUnsignedV1 {
  return {
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    providerContactAuthority: false,
    routingMutation: false,
    verifierIdentityDigest: envelope.verifierIdentityDigest,
    executionIdentityDigest: envelope.executionIdentityDigest,
    observationEpoch: envelope.observationEpoch,
    trustedSlots: envelope.trustedSlots,
    observedAt: envelope.observedAt,
    expiresAt: envelope.expiresAt,
  };
}

/** Canonical bytes the external authenticator signs. */
export function canonicalExecutionCapacityEvidenceBytesV1(
  unsigned: ExecutionCapacityEvidenceUnsignedV1,
): Buffer {
  return Buffer.from(
    `${EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL}\0${canonicalJson(unsigned)}`,
    'utf8',
  );
}

export function digestExecutionCapacityEvidenceV1(
  unsigned: ExecutionCapacityEvidenceUnsignedV1,
): string {
  return sha256('ashlr.execution-capacity-evidence.digest.v1',
    canonicalExecutionCapacityEvidenceBytesV1(unsigned));
}

function parseEvidence(value: unknown): ExecutionCapacityEvidenceEnvelopeV1 | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, [
    'schemaVersion', 'protocol', 'authority', 'executionAuthority',
    'providerContactAuthority', 'routingMutation', 'verifierIdentityDigest', 'executionIdentityDigest',
    'observationEpoch', 'trustedSlots', 'observedAt', 'expiresAt',
    'evidenceDigest', 'authenticator',
  ])) return null;
  if (row['schemaVersion'] !== 1 || row['protocol'] !== EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL ||
    row['authority'] !== 'observation-only' || row['executionAuthority'] !== false ||
    row['providerContactAuthority'] !== false || row['routingMutation'] !== false ||
    typeof row['verifierIdentityDigest'] !== 'string' || !DIGEST_RE.test(row['verifierIdentityDigest']) ||
    typeof row['executionIdentityDigest'] !== 'string' || !DIGEST_RE.test(row['executionIdentityDigest']) ||
    !safeInteger(row['observationEpoch'], 1, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(row['trustedSlots'], 0, MAX_TRUSTED_SLOTS) ||
    !canonicalTimestamp(row['observedAt']) || !canonicalTimestamp(row['expiresAt']) ||
    Date.parse(row['expiresAt']) <= Date.parse(row['observedAt']) ||
    typeof row['evidenceDigest'] !== 'string' || !DIGEST_RE.test(row['evidenceDigest']) ||
    typeof row['authenticator'] !== 'string' || row['authenticator'].length < 1 ||
    Buffer.byteLength(row['authenticator'], 'utf8') > MAX_AUTHENTICATOR_BYTES) return null;
  const envelope = row as unknown as ExecutionCapacityEvidenceEnvelopeV1;
  return digestExecutionCapacityEvidenceV1(evidenceUnsigned(envelope)) === envelope.evidenceDigest
    ? JSON.parse(JSON.stringify(envelope)) as ExecutionCapacityEvidenceEnvelopeV1
    : null;
}

function verifyEvidence(
  value: unknown,
  verify: ExecutionCapacityEvidenceVerifierV1['verify'],
): ExecutionCapacityEvidenceEnvelopeV1 | null {
  const envelope = parseEvidence(value);
  if (!envelope) return null;
  const signed = canonicalExecutionCapacityEvidenceBytesV1(evidenceUnsigned(envelope));
  const callbackBytes = Buffer.from(signed);
  const before = Buffer.from(callbackBytes);
  const input = Object.freeze({
    executionIdentityDigest: envelope.executionIdentityDigest,
    verifierIdentityDigest: envelope.verifierIdentityDigest,
    observationEpoch: envelope.observationEpoch,
    evidenceDigest: envelope.evidenceDigest,
    canonicalDomainSeparatedEnvelope: callbackBytes,
    authenticator: envelope.authenticator,
  });
  let verified = false;
  try { verified = verify(input) === true; } catch { /* fail closed */ }
  if (!verified || !timingSafeEqual(callbackBytes, before)) return null;
  return parseEvidence(envelope);
}

function captureVerifier(value: unknown): {
  verifierIdentityDigest: string;
  verify: ExecutionCapacityEvidenceVerifierV1['verify'];
} | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['verifierIdentityDigest', 'verify']) ||
    typeof row['verifierIdentityDigest'] !== 'string' || !DIGEST_RE.test(row['verifierIdentityDigest']) ||
    typeof row['verify'] !== 'function' || utilTypes.isProxy(row['verify'])) return null;
  return {
    verifierIdentityDigest: row['verifierIdentityDigest'],
    verify: row['verify'] as ExecutionCapacityEvidenceVerifierV1['verify'],
  };
}

function nestedWithin(anchor: string, target: string): boolean {
  const nested = relative(anchor, target);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function owned(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function privateMode(stat: BigIntStats, mode: number): boolean {
  return process.platform === 'win32' || (stat.mode & 0o777n) === BigInt(mode);
}

function sameFile(left: Pick<BigIntStats, 'dev' | 'ino'>, right: Pick<BigIntStats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeRoot(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    privateMode(stat, PRIVATE_DIRECTORY_MODE);
}

function safeFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned(stat) &&
    privateMode(stat, PRIVATE_FILE_MODE);
}

function pinRoot(anchorPath: string, rootPath: string): RootIdentity | null {
  try {
    const anchor = resolve(anchorPath);
    const root = resolve(rootPath);
    if (!isAbsolute(anchorPath) || !isAbsolute(rootPath) || root === parse(root).root ||
      !nestedWithin(anchor, root)) return null;
    const anchorStat = lstatSync(anchor, { bigint: true });
    const stat = lstatSync(root, { bigint: true });
    if (anchorStat.isSymbolicLink() || !anchorStat.isDirectory() || !safeRoot(stat)) return null;
    const assurance = assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: anchor });
    return assurance.ok ? { path: root, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function stableRoot(root: RootIdentity): boolean {
  try {
    const stat = lstatSync(root.path, { bigint: true });
    return safeRoot(stat) && sameFile(stat, root);
  } catch {
    return false;
  }
}

function readBoundFile(root: RootIdentity): BoundFile | null {
  const path = join(root.path, STORE_FILE);
  let fd: number | undefined;
  try {
    let before: BigIntStats;
    try { before = lstatSync(path, { bigint: true }); }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && stableRoot(root)
        ? { found: false }
        : null;
    }
    if (!safeFile(before) || before.size <= 0n || before.size > BigInt(STORE_MAX_BYTES) ||
      !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: root.path }).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!safeFile(opened) || !sameFile(before, opened) || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) return null;
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!safeFile(after) || !safeFile(named) || !sameFile(before, after) || !sameFile(after, named) ||
      after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
      !stableRoot(root)) return null;
    return {
      found: true, dev: after.dev, ino: after.ino, size: after.size,
      mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs, bytes,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function sameBound(left: BoundFile, right: BoundFile | null): boolean {
  if (!right || left.found !== right.found) return false;
  return !left.found || (left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    !!left.bytes && !!right.bytes && timingSafeEqual(left.bytes, right.bytes));
}

function ledgerDigest(unsigned: PersistedLedgerUnsignedV1): string {
  return sha256('ashlr.execution-capacity-lease.ledger.v1', canonicalJson(unsigned));
}

function freshLedger(): PersistedLedgerV1 {
  const unsigned: PersistedLedgerUnsignedV1 = {
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_LEASE_V1_PROTOCOL,
    identities: [],
    leases: [],
  };
  return { ...unsigned, stateDigest: ledgerDigest(unsigned) };
}

const IDENTITY_KEYS = ['executionIdentityDigest', 'evidenceDigest', 'observationEpoch', 'trustedSlots', 'observedAt', 'expiresAt'];
const ITEM_KEYS = ['executionIdentityDigest', 'slots', 'evidenceDigest'];
const LEASE_KEYS = ['allocationIdHash', 'allocationDigest', 'requestDigest', 'ownerCapabilityCommitment', 'epoch', 'state', 'createdAt', 'updatedAt', 'expiresAt', 'items'];

function parseLedger(bytes: Buffer): PersistedLedgerV1 | null {
  try {
    const row = plainRecord(JSON.parse(bytes.toString('utf8')));
    if (!row || !exactKeys(row, ['schemaVersion', 'protocol', 'identities', 'leases', 'stateDigest']) ||
      row['schemaVersion'] !== 1 || row['protocol'] !== EXECUTION_CAPACITY_LEASE_V1_PROTOCOL ||
      !Array.isArray(row['identities']) || row['identities'].length > MAX_IDENTITIES ||
      !Array.isArray(row['leases']) || row['leases'].length > MAX_LEASES ||
      typeof row['stateDigest'] !== 'string' || !DIGEST_RE.test(row['stateDigest'])) return null;
    const identities: PersistedIdentityV1[] = [];
    const identityDigests = new Set<string>();
    for (const value of row['identities']) {
      const item = plainRecord(value);
      if (!item || !exactKeys(item, IDENTITY_KEYS) ||
        typeof item['executionIdentityDigest'] !== 'string' || !DIGEST_RE.test(item['executionIdentityDigest']) ||
        identityDigests.has(item['executionIdentityDigest']) ||
        typeof item['evidenceDigest'] !== 'string' || !DIGEST_RE.test(item['evidenceDigest']) ||
        !safeInteger(item['observationEpoch'], 1, Number.MAX_SAFE_INTEGER) ||
        !safeInteger(item['trustedSlots'], 0, MAX_TRUSTED_SLOTS) ||
        !canonicalTimestamp(item['observedAt']) || !canonicalTimestamp(item['expiresAt']) ||
        Date.parse(item['expiresAt']) <= Date.parse(item['observedAt'])) return null;
      identityDigests.add(item['executionIdentityDigest']);
      identities.push(item as unknown as PersistedIdentityV1);
    }
    const leases: PersistedLeaseV1[] = [];
    const allocationIds = new Set<string>();
    for (const value of row['leases']) {
      const lease = plainRecord(value);
      if (!lease || !exactKeys(lease, LEASE_KEYS) ||
        typeof lease['allocationIdHash'] !== 'string' || !DIGEST_RE.test(lease['allocationIdHash']) ||
        allocationIds.has(lease['allocationIdHash']) ||
        typeof lease['allocationDigest'] !== 'string' || !DIGEST_RE.test(lease['allocationDigest']) ||
        typeof lease['requestDigest'] !== 'string' || !DIGEST_RE.test(lease['requestDigest']) ||
        typeof lease['ownerCapabilityCommitment'] !== 'string' || !DIGEST_RE.test(lease['ownerCapabilityCommitment']) ||
        !safeInteger(lease['epoch'], 1, Number.MAX_SAFE_INTEGER) ||
        !['reserved', 'released', 'expired'].includes(String(lease['state'])) ||
        !canonicalTimestamp(lease['createdAt']) || !canonicalTimestamp(lease['updatedAt']) ||
        !canonicalTimestamp(lease['expiresAt']) ||
        Date.parse(lease['createdAt']) > Date.parse(lease['updatedAt']) ||
        Date.parse(lease['createdAt']) >= Date.parse(lease['expiresAt']) ||
        ((lease['state'] === 'reserved' || lease['state'] === 'released') &&
          Date.parse(lease['updatedAt']) >= Date.parse(lease['expiresAt'])) ||
        lease['allocationDigest'] !== sha256('ashlr.execution-capacity-lease.allocation.v1', lease['requestDigest']) ||
        !Array.isArray(lease['items']) ||
        lease['items'].length < 1 || lease['items'].length > MAX_BATCH_ITEMS) return null;
      allocationIds.add(lease['allocationIdHash']);
      const itemIdentities = new Set<string>();
      for (const valueItem of lease['items']) {
        const item = plainRecord(valueItem);
        if (!item || !exactKeys(item, ITEM_KEYS) ||
          typeof item['executionIdentityDigest'] !== 'string' || !DIGEST_RE.test(item['executionIdentityDigest']) ||
          itemIdentities.has(item['executionIdentityDigest']) || !identityDigests.has(item['executionIdentityDigest']) ||
          !safeInteger(item['slots'], 1, MAX_TRUSTED_SLOTS) ||
          typeof item['evidenceDigest'] !== 'string' || !DIGEST_RE.test(item['evidenceDigest'])) return null;
        itemIdentities.add(item['executionIdentityDigest']);
      }
      leases.push(lease as unknown as PersistedLeaseV1);
    }
    for (const identity of identities) {
      const total = leases.reduce((sum, lease) => lease.state !== 'reserved' ? sum : sum +
        (lease.items.find((item) => item.executionIdentityDigest === identity.executionIdentityDigest)?.slots ?? 0), 0);
      if (total > identity.trustedSlots) return null;
    }
    identities.sort((left, right) => left.executionIdentityDigest.localeCompare(right.executionIdentityDigest));
    leases.sort((left, right) => left.allocationIdHash.localeCompare(right.allocationIdHash));
    const unsigned: PersistedLedgerUnsignedV1 = {
      schemaVersion: 1,
      protocol: EXECUTION_CAPACITY_LEASE_V1_PROTOCOL,
      identities,
      leases,
    };
    if (ledgerDigest(unsigned) !== row['stateDigest']) return null;
    return { ...unsigned, stateDigest: row['stateDigest'] };
  } catch {
    return null;
  }
}

function saveLedger(
  root: RootIdentity,
  expected: BoundFile,
  ledger: PersistedLedgerV1,
): { ok: boolean; committed: boolean } {
  const path = join(root.path, STORE_FILE);
  const temporary = join(root.path, `.${STORE_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(ledger)}\n`, 'utf8');
  if (bytes.length > STORE_MAX_BYTES) return { ok: false, committed: false };
  let fd: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  try {
    if (!stableRoot(root)) return { ok: false, committed: false };
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_FILE_MODE);
    temporaryIdentity = fstatSync(fd, { bigint: true });
    if (!safeFile(temporaryIdentity) || temporaryIdentity.size !== 0n ||
      !assurePrivateStoragePath(temporary, 'file', 'secure-created', { anchorPath: root.path }).ok) {
      return { ok: false, committed: false };
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return { ok: false, committed: false };
      offset += count;
    }
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(temporary, { bigint: true });
    if (!safeFile(opened) || !safeFile(named) || !sameFile(opened, named) ||
      !sameFile(opened, temporaryIdentity) || opened.size !== BigInt(bytes.length) ||
      !stableRoot(root) || !sameBound(expected, readBoundFile(root))) {
      return { ok: false, committed: false };
    }
    leaseTestHooks?.beforeRename?.();
    if (!stableRoot(root) || !sameBound(expected, readBoundFile(root))) {
      return { ok: false, committed: false };
    }
    renameSync(temporary, path);
    published = true;
    (leaseTestHooks?.fsyncDirectory ?? fsyncDirectory)(root.path, { expectedIdentity: root });
    const installed = readBoundFile(root);
    const ok = !!installed?.found && installed.dev === temporaryIdentity.dev && installed.ino === temporaryIdentity.ino &&
      !!installed.bytes && timingSafeEqual(installed.bytes, bytes) && stableRoot(root);
    return { ok, committed: true };
  } catch {
    return { ok: false, committed: published };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (!published && temporaryIdentity && stableRoot(root)) {
      try {
        const named = lstatSync(temporary, { bigint: true });
        if (safeFile(named) && sameFile(named, temporaryIdentity)) unlinkSync(temporary);
      } catch { /* exact temporary already absent/replaced */ }
    }
  }
}

function allocationIdHash(allocationId: string): string {
  return sha256('ashlr.execution-capacity-lease.allocation-id.v1', allocationId);
}

function ownerCommitment(capability: string): string {
  return sha256('ashlr.execution-capacity-lease.owner-capability.v1', capability);
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requestDigest(allocationHash: string, ttlMs: number, items: readonly VerifiedBatchItem[]): string {
  return sha256('ashlr.execution-capacity-lease.request.v1', canonicalJson({
    allocationIdHash: allocationHash,
    leaseTtlMs: ttlMs,
    items: items.map((item) => ({
      executionIdentityDigest: item.executionIdentityDigest,
      slots: item.slots,
      evidenceDigest: item.expectedEvidenceDigest,
    })),
  }));
}

function mutation(
  disposition: ExecutionCapacityLeaseMutationResultV1['disposition'],
  reason: ExecutionCapacityLeaseReasonV1,
  values: Partial<Pick<ExecutionCapacityLeaseMutationResultV1,
    'allocationDigest' | 'leaseEpoch' | 'expiresAt' | 'ownerCapability' | 'durable' | 'committedWithoutReceipt'>> = {},
): ExecutionCapacityLeaseMutationResultV1 {
  return {
    ...EXECUTION_CAPACITY_LEASE_NO_AUTHORITY_V1,
    disposition,
    reason,
    allocationDigest: values.allocationDigest ?? null,
    leaseEpoch: values.leaseEpoch ?? null,
    expiresAt: values.expiresAt ?? null,
    ownerCapability: values.ownerCapability ?? null,
    durable: values.durable ?? false,
    committedWithoutReceipt: values.committedWithoutReceipt ?? false,
  };
}

function validateBatch(
  input: ExecutionCapacityLeaseAcquireInputV1,
  expectedInputKeys: readonly string[],
  verifierIdentityDigest: string | null,
  verify: ExecutionCapacityEvidenceVerifierV1['verify'] | null,
): { ok: true; allocationHash: string; leaseTtlMs: number; items: VerifiedBatchItem[] } |
  { ok: false; reason: ExecutionCapacityLeaseReasonV1 } {
  try {
    const inputRow = plainRecord(input);
    if (!inputRow || !exactKeys(inputRow, expectedInputKeys)) return { ok: false, reason: 'invalid-input' };
    const allocationId = inputRow['allocationId'];
    const leaseTtlMs = inputRow['leaseTtlMs'];
    const rawItems = snapshotPlainArray(inputRow['items'], MAX_BATCH_ITEMS);
    if (typeof allocationId !== 'string' || allocationId.length < 1 ||
      Buffer.byteLength(allocationId, 'utf8') > MAX_ALLOCATION_ID_BYTES ||
      !safeInteger(leaseTtlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS) ||
      !rawItems) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (!verifierIdentityDigest || !verify) return { ok: false, reason: 'verifier-unavailable' };
    const identities = new Set<string>();
    const candidates: VerifiedBatchItem[] = [];
    // Snapshot the complete batch before invoking caller code. A verifier for
    // item N cannot swap the view used for item N+1.
    for (const raw of rawItems) {
      const item = plainRecord(raw);
      if (!item || !exactKeys(item, ['executionIdentityDigest', 'slots', 'expectedEvidenceDigest', 'evidenceEnvelope']) ||
        typeof item['executionIdentityDigest'] !== 'string' || !DIGEST_RE.test(item['executionIdentityDigest']) ||
        identities.has(item['executionIdentityDigest']) || !safeInteger(item['slots'], 1, MAX_TRUSTED_SLOTS) ||
        typeof item['expectedEvidenceDigest'] !== 'string' || !DIGEST_RE.test(item['expectedEvidenceDigest'])) {
        return { ok: false, reason: 'invalid-input' };
      }
      const evidenceSnapshot = parseEvidence(item['evidenceEnvelope']);
      if (!evidenceSnapshot) return { ok: false, reason: 'evidence-unauthenticated' };
      if (evidenceSnapshot.executionIdentityDigest !== item['executionIdentityDigest'] ||
        evidenceSnapshot.evidenceDigest !== item['expectedEvidenceDigest'] ||
        evidenceSnapshot.verifierIdentityDigest !== verifierIdentityDigest) {
        return { ok: false, reason: 'evidence-mismatch' };
      }
      identities.add(item['executionIdentityDigest']);
      candidates.push({
        executionIdentityDigest: item['executionIdentityDigest'],
        slots: item['slots'],
        expectedEvidenceDigest: item['expectedEvidenceDigest'],
        evidence: evidenceSnapshot,
      });
    }
    const items: VerifiedBatchItem[] = [];
    for (const candidate of candidates) {
      const evidence = verifyEvidence(candidate.evidence, verify);
      if (!evidence) return { ok: false, reason: 'evidence-unauthenticated' };
      items.push({ ...candidate, evidence });
    }
    items.sort((left, right) => left.executionIdentityDigest.localeCompare(right.executionIdentityDigest));
    return {
      ok: true,
      allocationHash: allocationIdHash(allocationId),
      leaseTtlMs,
      items,
    };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}

function evidenceTimeReason(evidence: ExecutionCapacityEvidenceEnvelopeV1, nowMs: number): ExecutionCapacityLeaseReasonV1 | null {
  const observed = Date.parse(evidence.observedAt);
  const expires = Date.parse(evidence.expiresAt);
  if (observed > nowMs + MAX_FUTURE_SKEW_MS) return 'evidence-future';
  if (nowMs - observed > MAX_EVIDENCE_AGE_MS) return 'evidence-stale';
  if (expires <= nowMs) return 'evidence-expired';
  return null;
}

function expireReserved(ledger: PersistedLedgerV1, nowMs: number): string[] {
  const reclaimed: string[] = [];
  for (const lease of ledger.leases) {
    if (lease.state === 'reserved' && Date.parse(lease.expiresAt) <= nowMs) {
      lease.state = 'expired';
      lease.updatedAt = new Date(nowMs).toISOString();
      reclaimed.push(lease.allocationDigest);
    }
  }
  return reclaimed.sort();
}

function reservedSlots(ledger: PersistedLedgerV1, identityDigest: string): number {
  return ledger.leases.reduce((total, lease) => lease.state !== 'reserved' ? total : total +
    (lease.items.find((item) => item.executionIdentityDigest === identityDigest)?.slots ?? 0), 0);
}

function applyEvidence(
  ledger: PersistedLedgerV1,
  items: readonly VerifiedBatchItem[],
  nowMs: number,
): ExecutionCapacityLeaseReasonV1 | null {
  for (const item of items) {
    const timeReason = evidenceTimeReason(item.evidence, nowMs);
    if (timeReason) return timeReason;
    const prior = ledger.identities.find((identity) =>
      identity.executionIdentityDigest === item.executionIdentityDigest);
    if (!prior) continue;
    if (item.evidence.observationEpoch < prior.observationEpoch) return 'evidence-stale';
    if (item.evidence.observationEpoch === prior.observationEpoch &&
      item.evidence.evidenceDigest !== prior.evidenceDigest) return 'evidence-drift';
    if (item.evidence.observationEpoch > prior.observationEpoch &&
      item.evidence.trustedSlots < reservedSlots(ledger, item.executionIdentityDigest)) {
      return 'evidence-drift';
    }
  }
  for (const item of items) {
    const next: PersistedIdentityV1 = {
      executionIdentityDigest: item.executionIdentityDigest,
      evidenceDigest: item.evidence.evidenceDigest,
      observationEpoch: item.evidence.observationEpoch,
      trustedSlots: item.evidence.trustedSlots,
      observedAt: item.evidence.observedAt,
      expiresAt: item.evidence.expiresAt,
    };
    const index = ledger.identities.findIndex((identity) =>
      identity.executionIdentityDigest === item.executionIdentityDigest);
    if (index === -1) ledger.identities.push(next);
    else if (item.evidence.observationEpoch > ledger.identities[index]!.observationEpoch) ledger.identities[index] = next;
  }
  ledger.identities.sort((left, right) => left.executionIdentityDigest.localeCompare(right.executionIdentityDigest));
  return null;
}

function finalizeLedger(ledger: PersistedLedgerV1): PersistedLedgerV1 {
  ledger.leases.sort((left, right) => left.allocationIdHash.localeCompare(right.allocationIdHash));
  const unsigned: PersistedLedgerUnsignedV1 = {
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_LEASE_V1_PROTOCOL,
    identities: ledger.identities,
    leases: ledger.leases,
  };
  return { ...unsigned, stateDigest: ledgerDigest(unsigned) };
}

type LockedOperation = (ledger: PersistedLedgerV1, expected: BoundFile, root: RootIdentity) => {
  result: ExecutionCapacityLeaseMutationResultV1;
  changed: boolean;
};

export class ExecutionCapacityLeaseStoreV1 {
  readonly #dependencies: Required<Pick<ExecutionCapacityLeaseStoreDependenciesV1, 'enabled' | 'clock' | 'lockWaitMs'>> &
    Pick<ExecutionCapacityLeaseStoreDependenciesV1, 'anchorPath' | 'rootPath'>;
  readonly #verifierIdentityDigest: string | null;
  readonly #verifyEvidence: ExecutionCapacityEvidenceVerifierV1['verify'] | null;

  constructor(dependencies?: ExecutionCapacityLeaseStoreDependenciesV1) {
    let verifier: ReturnType<typeof captureVerifier> = null;
    try { verifier = captureVerifier(dependencies?.verifier); } catch { /* unavailable */ }
    this.#verifierIdentityDigest = verifier?.verifierIdentityDigest ?? null;
    this.#verifyEvidence = verifier?.verify ?? null;
    this.#dependencies = {
      anchorPath: dependencies?.anchorPath ?? homedir(),
      rootPath: dependencies?.rootPath ?? join(homedir(), '.ashlr', 'private', 'execution-capacity-leases-v1'),
      enabled: dependencies?.enabled === true,
      clock: dependencies?.clock ?? (() => new Date()),
      lockWaitMs: Math.max(0, Math.min(MAX_LOCK_WAIT_MS,
        Number.isFinite(dependencies?.lockWaitMs) ? Math.floor(dependencies!.lockWaitMs!) : 250)),
    };
  }

  #preflight(): ExecutionCapacityLeaseMutationResultV1 | null {
    try {
      if (!this.#dependencies.enabled) return mutation('withheld', 'disabled');
      if (process.platform === 'win32') return mutation('unavailable', 'platform-unsupported');
      const anchor = resolve(this.#dependencies.anchorPath);
      const root = resolve(this.#dependencies.rootPath);
      if (!isAbsolute(this.#dependencies.anchorPath) || !isAbsolute(this.#dependencies.rootPath) ||
        root === parse(root).root || !nestedWithin(anchor, root)) return mutation('withheld', 'invalid-input');
      return null;
    } catch {
      return mutation('withheld', 'invalid-input');
    }
  }

  #locked(operation: LockedOperation): ExecutionCapacityLeaseMutationResultV1 {
    const preflight = this.#preflight();
    if (preflight) return preflight;
    const acquired = acquireLocalStoreLockWithOutcome(
      join(resolve(this.#dependencies.rootPath), STORE_LOCK),
      this.#dependencies.lockWaitMs,
      { anchorPath: resolve(this.#dependencies.anchorPath), exactPrivateStorage: true },
    );
    if (acquired.state !== 'acquired') return mutation('unavailable', 'store-unavailable');
    let result = mutation('unavailable', 'store-unavailable');
    let committed = false;
    try {
      const root = pinRoot(this.#dependencies.anchorPath, this.#dependencies.rootPath);
      const expected = root ? readBoundFile(root) : null;
      if (!root || !expected) result = mutation('unavailable', 'store-unavailable');
      else {
        const ledger = expected.found ? parseLedger(expected.bytes!) : freshLedger();
        if (!ledger) result = mutation('unavailable', 'store-unavailable');
        else {
          const outcome = operation(ledger, expected, root);
          result = outcome.result;
          if (outcome.changed) {
            const finalized = finalizeLedger(ledger);
            const saved = saveLedger(root, expected, finalized);
            if (!saved.ok) {
              committed = saved.committed;
              result = mutation('failed', 'publication-failed', {
                allocationDigest: result.allocationDigest,
                leaseEpoch: result.leaseEpoch,
                expiresAt: result.expiresAt,
                durable: false,
                committedWithoutReceipt: saved.committed,
              });
            } else {
              committed = true;
              result = { ...result, durable: true };
            }
          }
        }
      }
    } catch {
      result = mutation('unavailable', 'store-unavailable');
    }
    const released = (leaseTestHooks?.releaseLock ?? releaseLocalStoreLock)(acquired.lock);
    if (!released) {
      return mutation('unavailable', 'lock-release-failed', {
        allocationDigest: result.allocationDigest,
        leaseEpoch: result.leaseEpoch,
        expiresAt: result.expiresAt,
        durable: result.durable,
        committedWithoutReceipt: committed,
      });
    }
    return result;
  }

  acquire(input: ExecutionCapacityLeaseAcquireInputV1): ExecutionCapacityLeaseMutationResultV1 {
    const preflight = this.#preflight();
    if (preflight) return preflight;
    const validated = validateBatch(
      input,
      ['allocationId', 'leaseTtlMs', 'items'],
      this.#verifierIdentityDigest,
      this.#verifyEvidence,
    );
    if (!validated.ok) return mutation('withheld', validated.reason);
    const request = requestDigest(validated.allocationHash, validated.leaseTtlMs, validated.items);
    return this.#locked((ledger) => {
      const now = this.#dependencies.clock();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return { result: mutation('withheld', 'invalid-input'), changed: false };
      const reclaimed = expireReserved(ledger, nowMs);
      const prior = ledger.leases.find((lease) => lease.allocationIdHash === validated.allocationHash);
      if (prior) {
        const priorIdentities = prior.items.map((item) => item.executionIdentityDigest).sort();
        const requestedIdentities = validated.items.map((item) => item.executionIdentityDigest).sort();
        const sameIdentities = canonicalJson(priorIdentities) === canonicalJson(requestedIdentities);
        const reason: ExecutionCapacityLeaseReasonV1 = !sameIdentities
          ? 'identity-conflict'
          : prior.state !== 'reserved'
            ? 'allocation-finalized'
            : prior.requestDigest === request ? 'replayed' : 'allocation-conflict';
        return {
          result: mutation(reason === 'replayed' ? 'replayed' : 'withheld', reason, {
            allocationDigest: prior.allocationDigest,
            leaseEpoch: prior.epoch,
            expiresAt: prior.expiresAt,
          }),
          changed: reclaimed.length > 0,
        };
      }
      if (ledger.leases.length >= MAX_LEASES ||
        new Set([...ledger.identities.map((identity) => identity.executionIdentityDigest),
          ...validated.items.map((item) => item.executionIdentityDigest)]).size > MAX_IDENTITIES) {
        return { result: mutation('withheld', 'capacity-exhausted'), changed: reclaimed.length > 0 };
      }
      const stagedLedger = {
        ...ledger,
        identities: ledger.identities.map((identity) => ({ ...identity })),
      };
      const evidenceReason = applyEvidence(stagedLedger, validated.items, nowMs);
      if (evidenceReason) return { result: mutation('withheld', evidenceReason), changed: reclaimed.length > 0 };
      for (const item of validated.items) {
        const identity = stagedLedger.identities.find((candidate) =>
          candidate.executionIdentityDigest === item.executionIdentityDigest)!;
        if (reservedSlots(stagedLedger, item.executionIdentityDigest) + item.slots > identity.trustedSlots) {
          return { result: mutation('withheld', 'trusted-slots-exhausted'), changed: reclaimed.length > 0 };
        }
      }
      const capability = `ecap_${(leaseTestHooks?.randomBytes ?? randomBytes)(32).toString('base64url')}`;
      if (!CAPABILITY_RE.test(capability)) {
        return { result: mutation('unavailable', 'store-unavailable'), changed: reclaimed.length > 0 };
      }
      const createdAt = now.toISOString();
      const evidenceExpiry = Math.min(...validated.items.map((item) => Date.parse(item.evidence.expiresAt)));
      const expiresAt = new Date(Math.min(nowMs + validated.leaseTtlMs, evidenceExpiry)).toISOString();
      const allocationDigest = sha256('ashlr.execution-capacity-lease.allocation.v1', request);
      ledger.identities = stagedLedger.identities;
      ledger.leases.push({
        allocationIdHash: validated.allocationHash,
        allocationDigest,
        requestDigest: request,
        ownerCapabilityCommitment: ownerCommitment(capability),
        epoch: 1,
        state: 'reserved',
        createdAt,
        updatedAt: createdAt,
        expiresAt,
        items: validated.items.map((item) => ({
          executionIdentityDigest: item.executionIdentityDigest,
          slots: item.slots,
          evidenceDigest: item.expectedEvidenceDigest,
        })),
      });
      return {
        result: mutation('recorded', 'recorded', {
          allocationDigest, leaseEpoch: 1, expiresAt, ownerCapability: capability,
        }),
        changed: true,
      };
    });
  }

  renew(input: ExecutionCapacityLeaseRenewInputV1): ExecutionCapacityLeaseMutationResultV1 {
    const preflight = this.#preflight();
    if (preflight) return preflight;
    const inputRow = plainRecord(input);
    const ownerCapability = inputRow?.['ownerCapability'];
    const expectedLeaseEpoch = inputRow?.['expectedLeaseEpoch'];
    if (typeof ownerCapability !== 'string' || !CAPABILITY_RE.test(ownerCapability) ||
      !safeInteger(expectedLeaseEpoch, 1, Number.MAX_SAFE_INTEGER)) {
      return mutation('withheld', 'invalid-input');
    }
    const validated = validateBatch(
      input,
      ['allocationId', 'leaseTtlMs', 'items', 'ownerCapability', 'expectedLeaseEpoch'],
      this.#verifierIdentityDigest,
      this.#verifyEvidence,
    );
    if (!validated.ok) return mutation('withheld', validated.reason);
    return this.#locked((ledger) => {
      const now = this.#dependencies.clock();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return { result: mutation('withheld', 'invalid-input'), changed: false };
      const reclaimed = expireReserved(ledger, nowMs);
      const lease = ledger.leases.find((candidate) => candidate.allocationIdHash === validated.allocationHash);
      if (!lease) return { result: mutation('withheld', 'lease-not-found'), changed: reclaimed.length > 0 };
      if (lease.state === 'expired') return { result: mutation('withheld', 'lease-expired'), changed: reclaimed.length > 0 };
      if (lease.state !== 'reserved') return { result: mutation('withheld', 'allocation-finalized'), changed: reclaimed.length > 0 };
      if (!sameDigest(ownerCommitment(ownerCapability), lease.ownerCapabilityCommitment)) {
        return { result: mutation('withheld', 'owner-capability-invalid'), changed: reclaimed.length > 0 };
      }
      if (expectedLeaseEpoch !== lease.epoch) {
        return { result: mutation('withheld', 'lease-epoch-conflict'), changed: reclaimed.length > 0 };
      }
      if (lease.epoch >= Number.MAX_SAFE_INTEGER) {
        return { result: mutation('withheld', 'lease-epoch-exhausted'), changed: reclaimed.length > 0 };
      }
      const normalizedItems = validated.items.map((item) => ({
        executionIdentityDigest: item.executionIdentityDigest,
        slots: item.slots,
      }));
      const leasedItems = lease.items.map((item) => ({
        executionIdentityDigest: item.executionIdentityDigest,
        slots: item.slots,
      }));
      if (canonicalJson(normalizedItems) !== canonicalJson(leasedItems)) {
        return { result: mutation('withheld', 'allocation-conflict'), changed: reclaimed.length > 0 };
      }
      const stagedLedger = {
        ...ledger,
        identities: ledger.identities.map((identity) => ({ ...identity })),
      };
      const evidenceReason = applyEvidence(stagedLedger, validated.items, nowMs);
      if (evidenceReason) return { result: mutation('withheld', evidenceReason), changed: reclaimed.length > 0 };
      const evidenceExpiry = Math.min(...validated.items.map((item) => Date.parse(item.evidence.expiresAt)));
      const expiresAt = new Date(Math.min(nowMs + validated.leaseTtlMs, evidenceExpiry)).toISOString();
      lease.epoch += 1;
      lease.updatedAt = now.toISOString();
      lease.expiresAt = expiresAt;
      ledger.identities = stagedLedger.identities;
      return {
        result: mutation('recorded', 'renewed', {
          allocationDigest: lease.allocationDigest, leaseEpoch: lease.epoch, expiresAt,
        }),
        changed: true,
      };
    });
  }

  release(input: ExecutionCapacityLeaseReleaseInputV1): ExecutionCapacityLeaseMutationResultV1 {
    const preflight = this.#preflight();
    if (preflight) return preflight;
    const inputRow = plainRecord(input);
    const allocationId = inputRow?.['allocationId'];
    const ownerCapability = inputRow?.['ownerCapability'];
    const expectedLeaseEpoch = inputRow?.['expectedLeaseEpoch'];
    if (!inputRow || !exactKeys(inputRow, ['allocationId', 'ownerCapability', 'expectedLeaseEpoch']) ||
      typeof allocationId !== 'string' || allocationId.length < 1 ||
      Buffer.byteLength(allocationId, 'utf8') > MAX_ALLOCATION_ID_BYTES ||
      typeof ownerCapability !== 'string' || !CAPABILITY_RE.test(ownerCapability) ||
      !safeInteger(expectedLeaseEpoch, 1, Number.MAX_SAFE_INTEGER)) {
      return mutation('withheld', 'invalid-input');
    }
    const hash = allocationIdHash(allocationId);
    return this.#locked((ledger) => {
      const now = this.#dependencies.clock();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return { result: mutation('withheld', 'invalid-input'), changed: false };
      const reclaimed = expireReserved(ledger, nowMs);
      const lease = ledger.leases.find((candidate) => candidate.allocationIdHash === hash);
      if (!lease) return { result: mutation('withheld', 'lease-not-found'), changed: reclaimed.length > 0 };
      if (lease.state === 'expired') return { result: mutation('withheld', 'lease-expired'), changed: reclaimed.length > 0 };
      if (lease.state !== 'reserved') return { result: mutation('withheld', 'allocation-finalized'), changed: reclaimed.length > 0 };
      if (!sameDigest(ownerCommitment(ownerCapability), lease.ownerCapabilityCommitment)) {
        return { result: mutation('withheld', 'owner-capability-invalid'), changed: reclaimed.length > 0 };
      }
      if (expectedLeaseEpoch !== lease.epoch) {
        return { result: mutation('withheld', 'lease-epoch-conflict'), changed: reclaimed.length > 0 };
      }
      if (lease.epoch >= Number.MAX_SAFE_INTEGER) {
        return { result: mutation('withheld', 'lease-epoch-exhausted'), changed: reclaimed.length > 0 };
      }
      lease.epoch += 1;
      lease.state = 'released';
      lease.updatedAt = now.toISOString();
      return {
        result: mutation('recorded', 'released', {
          allocationDigest: lease.allocationDigest, leaseEpoch: lease.epoch, expiresAt: lease.expiresAt,
        }),
        changed: true,
      };
    });
  }

  reclaimExpired(): ExecutionCapacityLeaseMutationResultV1 {
    const preflight = this.#preflight();
    if (preflight) return preflight;
    return this.#locked((ledger) => {
      const now = this.#dependencies.clock();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return { result: mutation('withheld', 'invalid-input'), changed: false };
      const reclaimed = expireReserved(ledger, nowMs);
      return {
        result: mutation(reclaimed.length > 0 ? 'recorded' : 'replayed',
          reclaimed.length > 0 ? 'reclaimed' : 'replayed'),
        changed: reclaimed.length > 0,
      };
    });
  }

  inspect(): ExecutionCapacityLeaseInspectionV1 {
    const authority = EXECUTION_CAPACITY_LEASE_NO_AUTHORITY_V1;
    if (!this.#dependencies.enabled) return {
      ...authority, enabled: false, sourceState: 'disabled', complete: true,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['disabled'],
    };
    if (process.platform === 'win32') return {
      ...authority, enabled: true, sourceState: 'degraded', complete: false,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['platform-unsupported'],
    };
    const root = pinRoot(this.#dependencies.anchorPath, this.#dependencies.rootPath);
    if (!root) return {
      ...authority, enabled: true, sourceState: 'missing', complete: false,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['store-unavailable'],
    };
    const bound = readBoundFile(root);
    if (!bound) return {
      ...authority, enabled: true, sourceState: 'degraded', complete: false,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['store-unavailable'],
    };
    if (!bound.found) return {
      ...authority, enabled: true, sourceState: 'missing', complete: true,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: [],
    };
    const ledger = parseLedger(bound.bytes!);
    if (!ledger) return {
      ...authority, enabled: true, sourceState: 'degraded', complete: false,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['store-unavailable'],
    };
    let nowMs = Number.NaN;
    try { nowMs = this.#dependencies.clock().getTime(); } catch { /* fail closed below */ }
    if (!Number.isFinite(nowMs)) return {
      ...authority, enabled: true, sourceState: 'degraded', complete: false,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['store-unavailable'],
    };
    const active = ledger.leases.filter((lease) =>
      lease.state === 'reserved' && Date.parse(lease.expiresAt) > nowMs);
    const identities = ledger.identities.map((identity) => {
      const reserved = active.reduce((total, lease) => total +
        (lease.items.find((item) => item.executionIdentityDigest === identity.executionIdentityDigest)?.slots ?? 0), 0);
      return {
        executionIdentityDigest: identity.executionIdentityDigest,
        evidenceDigest: identity.evidenceDigest,
        observationEpoch: identity.observationEpoch,
        trustedSlots: identity.trustedSlots,
        reservedSlots: reserved,
        availableSlots: Math.max(0, identity.trustedSlots - reserved),
        evidenceFresh: Number.isFinite(nowMs) && Date.parse(identity.observedAt) >= nowMs - MAX_EVIDENCE_AGE_MS &&
          Date.parse(identity.observedAt) <= nowMs + MAX_FUTURE_SKEW_MS && Date.parse(identity.expiresAt) > nowMs,
      };
    });
    return {
      ...authority,
      enabled: true,
      sourceState: 'healthy',
      complete: true,
      identities,
      leases: ledger.leases.map((lease) => ({
        allocationDigest: lease.allocationDigest,
        leaseEpoch: lease.epoch,
        state: lease.state === 'reserved' && Date.parse(lease.expiresAt) <= nowMs ? 'expired' : lease.state,
        slots: lease.items.reduce((sum, item) => sum + item.slots, 0),
        expiresAt: lease.expiresAt,
      })),
      activeLeaseCount: active.length,
      expiredPendingReclaim: ledger.leases.filter((lease) =>
        lease.state === 'reserved' && Date.parse(lease.expiresAt) <= nowMs).length,
      stopReasons: [],
    };
  }
}
