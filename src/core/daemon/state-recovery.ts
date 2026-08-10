import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServiceStatusResult } from './service.js';
import { serviceActivity } from './service-activity.js';
import {
  acquireDaemonServiceLifecycleFence,
  ownsDaemonServiceLifecycleFence,
  releaseDaemonServiceLifecycleFence,
} from './service-lifecycle-fence.js';
import {
  acquireDaemonLock,
  daemonStateIssueCodes,
  daemonStatePath,
  daemonStateRecoveryMarkerPath,
  heartbeatDaemonLock,
  releaseDaemonLock,
  type DaemonStateDiagnosticCode,
  type DaemonLock,
} from './state.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { fsyncDirectory } from '../util/durability.js';
import { canonicalizeDaemonActivationValue } from './activation-permit.js';
import {
  loadExistingProvenanceKeyReadOnly,
  loadOrCreateKey,
} from '../foundry/provenance.js';
import type { DaemonState } from '../types.js';

const SHA256_RE = /^[a-f0-9]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PLAN_TTL_MS = 10 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;
const PLAN_DOMAIN = 'ashlr:daemon-state-quarantine-plan:v1\n';
const MARKER_DOMAIN = 'ashlr:daemon-state-quarantine-marker:v1\n';
const RECEIPT_DOMAIN = 'ashlr:daemon-state-quarantine-receipt:v1\n';
const SIGNING_KEY_DOMAIN = 'ashlr:daemon-state-quarantine-signing-key:v1\n';
const SIGNING_KEY_ID_DOMAIN = 'ashlr:daemon-state-quarantine-signing-key-id:v1\n';
const RESOLUTION_PLAN_DOMAIN = 'ashlr:daemon-state-resolution-plan:v1\n';
const RESOLUTION_INTENT_DOMAIN = 'ashlr:daemon-state-resolution-intent:v1\n';
const RESOLUTION_RECEIPT_DOMAIN = 'ashlr:daemon-state-resolution-receipt:v1\n';
const RESOLUTION_SIGNING_KEY_DOMAIN = 'ashlr:daemon-state-resolution-signing-key:v1\n';
const RESOLUTION_SIGNING_KEY_ID_DOMAIN = 'ashlr:daemon-state-resolution-signing-key-id:v1\n';
const SIGNATURE_ALGORITHM = 'hmac-sha256' as const;

const RECOVERABLE_ISSUE_CODES = new Set<DaemonStateDiagnosticCode>([
  'pid-invalid',
  'started-at-invalid',
  'last-tick-at-invalid',
  'budget-day-invalid',
  'spend-invalid',
  'items-processed-invalid',
  'ticks-invalid',
  'spend-accounting-shape-invalid',
  'spend-accounting-keys-invalid',
  'spend-accounting-day-invalid',
  'spend-accounting-id-invalid',
  'spend-accounting-exhaustion-invalid',
  'automatic-drain-flag-invalid',
]);

export interface DaemonStateQuarantinePlan {
  schemaVersion: 1;
  kind: 'daemon-state-quarantine-plan';
  planId: string;
  createdAt: string;
  expiresAt: string;
  operation: 'quarantine';
  expectedSourceSha256: string;
  sourceSizeBytes: number;
  sourcePathSha256: string;
  sourceGeneration: SourceGeneration;
  issueCodes: DaemonStateDiagnosticCode[];
  quarantineFileName: string;
  authority: {
    dryRunFirst: true;
    operatorAuthorizationRequired: true;
    operatorIdentityAuthenticated: false;
    sourceMutationAllowed: false;
    serviceMutationAllowed: false;
    serviceStartAllowed: false;
    serviceRestartAllowed: false;
    serviceInstallAllowed: false;
  };
  planDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

export interface DaemonStateQuarantineReceipt {
  schemaVersion: 1;
  kind: 'daemon-state-quarantine-receipt';
  planId: string;
  planDigest: string;
  previousDigest: string;
  completedAt: string;
  operation: 'quarantine';
  sourceSha256: string;
  sourceSizeBytes: number;
  quarantineFileName: string;
  quarantineSha256: string;
  sourceBytesPreserved: true;
  daemonStateBlockedPendingResolution: true;
  operatorAuthorizationPresented: true;
  operatorIdentityAuthenticated: false;
  serviceMutationPerformed: false;
  serviceStartPerformed: false;
  serviceRestartPerformed: false;
  serviceInstallPerformed: false;
  receiptDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

export interface DaemonStateResolutionPlan {
  schemaVersion: 1;
  kind: 'daemon-state-resolution-plan';
  planId: string;
  createdAt: string;
  expiresAt: string;
  operation: 'publish-fresh-state';
  quarantinePlanId: string;
  quarantinePlanDigest: string;
  quarantineReceiptDigest: string;
  quarantineMarkerDigest: string;
  quarantineSigningKeyId: string;
  sourcePathSha256: string;
  sourceGeneration: SourceGeneration;
  sourceSha256: string;
  sourceSizeBytes: number;
  quarantinePathSha256: string;
  quarantineGeneration: SourceGeneration;
  quarantineSha256: string;
  quarantineSizeBytes: number;
  destinationPathSha256: string;
  derivedAccountingCanonicalBase64: string;
  derivedAccountingSha256: string;
  derivedAccountingSizeBytes: number;
  freshStateCanonicalBase64: string;
  freshStateSha256: string;
  freshStateSizeBytes: number;
  supervisorObservationCanonicalBase64: string;
  supervisorObservationSha256: string;
  supervisorObservationSizeBytes: number;
  requiredServiceActivity: 'inactive';
  requiredSupervisorRegistration: 'absent';
  authority: {
    dryRunFirst: true;
    operatorAuthorizationRequired: true;
    repeatedAuthorizationRequired: true;
    exactDestinationReplacementAllowed: true;
    quarantineMutationAllowed: false;
    exactMarkerRetirementAllowed: true;
    serviceMutationAllowed: false;
    serviceStartAllowed: false;
    serviceRestartAllowed: false;
    serviceInstallAllowed: false;
  };
  planDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

interface DaemonStateResolutionIntent {
  schemaVersion: 1;
  kind: 'daemon-state-resolution-intent';
  planId: string;
  planDigest: string;
  previousDigest: string;
  authorizedAt: string;
  operation: 'publish-fresh-state';
  sourceGeneration: SourceGeneration;
  sourceSha256: string;
  quarantineReceiptDigest: string;
  quarantineMarkerDigest: string;
  destinationPathSha256: string;
  derivedAccountingSha256: string;
  freshStateSha256: string;
  supervisorObservationSha256: string;
  operatorAuthorizationCount: 2;
  statePublicationAllowed: true;
  exactMarkerRetirementAllowed: true;
  serviceMutationAllowed: false;
  intentDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

export interface DaemonStateResolutionReceipt {
  schemaVersion: 1;
  kind: 'daemon-state-resolution-receipt';
  planId: string;
  planDigest: string;
  previousDigest: string;
  completedAt: string;
  operation: 'publish-fresh-state';
  quarantinePlanId: string;
  quarantinePlanDigest: string;
  quarantineReceiptDigest: string;
  quarantineMarkerDigest: string;
  destinationPathSha256: string;
  derivedAccountingCanonicalBase64: string;
  derivedAccountingSha256: string;
  derivedAccountingSizeBytes: number;
  freshStateSha256: string;
  freshStateSizeBytes: number;
  supervisorObservationCanonicalBase64: string;
  supervisorObservationSha256: string;
  supervisorObservationSizeBytes: number;
  freshStateGeneration: SourceGeneration;
  quarantineFileName: string;
  quarantineSha256: string;
  quarantineSizeBytes: number;
  quarantineGeneration: SourceGeneration;
  sourcePathReplaced: true;
  quarantineEvidencePreserved: true;
  markerRetirementAuthorized: true;
  operatorAuthorizationCount: 2;
  operatorIdentityAuthenticated: false;
  serviceMutationPerformed: false;
  serviceStartPerformed: false;
  serviceRestartPerformed: false;
  serviceInstallPerformed: false;
  receiptDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

export type DaemonStateRecoveryRefusal =
  | 'invalid-expected-sha256'
  | 'source-missing'
  | 'source-unsafe'
  | 'source-unreadable'
  | 'source-drift'
  | 'source-not-malformed'
  | 'source-running-not-proven-stopped'
  | 'unknown-or-nonrecoverable-issue-code'
  | 'service-active'
  | 'service-state-unknown'
  | 'supervisor-registered'
  | 'accounting-state-unknown'
  | 'unsafe-recovery-storage'
  | 'plan-write-failed'
  | 'invalid-plan-id'
  | 'invalid-plan-digest'
  | 'plan-missing'
  | 'plan-unsafe'
  | 'plan-tampered'
  | 'plan-not-yet-valid'
  | 'plan-expired'
  | 'authorization-required'
  | 'authorization-mismatch'
  | 'plan-already-consumed'
  | 'recovery-marker-conflict'
  | 'recovery-lock-unavailable'
  | 'daemon-lock-unavailable'
  | 'quarantine-destination-conflict'
  | 'atomic-evidence-unavailable'
  | 'quarantine-failed'
  | 'receipt-write-failed'
  | 'invalid-quarantine-plan-id'
  | 'invalid-quarantine-receipt-digest'
  | 'quarantine-plan-missing'
  | 'quarantine-plan-tampered'
  | 'quarantine-receipt-missing'
  | 'quarantine-receipt-tampered'
  | 'quarantine-evidence-drift'
  | 'resolution-intent-conflict'
  | 'resolution-state-conflict'
  | 'atomic-replacement-unavailable'
  | 'state-publication-failed'
  | 'marker-retirement-failed';

export interface DaemonStateRecoveryFailure {
  ok: false;
  reason: DaemonStateRecoveryRefusal;
  detail: string;
}

export type PreviewDaemonStateQuarantineResult =
  | { ok: true; plan: DaemonStateQuarantinePlan; planPath: string }
  | DaemonStateRecoveryFailure;

export type ExecuteDaemonStateQuarantineResult =
  | {
      ok: true;
      receipt: DaemonStateQuarantineReceipt;
      receiptPath: string;
      quarantinePath: string;
      resumed: boolean;
    }
  | DaemonStateRecoveryFailure;

export type PreviewDaemonStateResolutionResult =
  | { ok: true; plan: DaemonStateResolutionPlan; planPath: string }
  | DaemonStateRecoveryFailure;

export type ExecuteDaemonStateResolutionResult =
  | {
      ok: true;
      receipt: DaemonStateResolutionReceipt;
      receiptPath: string;
      quarantinePath: string;
      retiredMarkerPath: string;
      resumed: boolean;
    }
  | DaemonStateRecoveryFailure;

export interface DaemonStateRecoveryRuntime {
  now?: () => Date;
  randomId?: () => string;
  serviceStatus: () => ServiceStatusResult;
  beforeQuarantine?: () => void;
  beforeMarkerPublish?: () => void;
  afterIntent?: () => void;
  afterQuarantine?: () => void;
  beforeTerminalWrite?: () => void;
  beforeReceiptPublish?: () => void;
  /** Prepare an exact, no-clobber evidence publication for the blocked source. */
  prepareAtomicQuarantineEvidence?: (input: {
    sourcePath: string;
    quarantinePath: string;
    expectedSourceSha256: string;
    expectedSourceGeneration: SourceGeneration;
  }) => { publish: () => void } | null;
}

export interface DaemonStateResolutionRuntime {
  now?: () => Date;
  randomId?: () => string;
  platform?: NodeJS.Platform;
  serviceStatus: () => ServiceStatusResult;
  dailyBudgetUsd: () => number;
  beforeIntentPublish?: () => void;
  afterIntentStage?: () => void;
  beforeStatePublish?: () => void;
  afterStatePublish?: () => void;
  beforeReceiptPublish?: () => void;
  afterReceiptStage?: () => void;
  afterReceiptPublish?: () => void;
  beforeMarkerRetirement?: () => void;
  afterLifecycleFenceAcquire?: () => void;
}

export interface DaemonStateAtomicEvidenceFilesystem {
  platform: NodeJS.Platform;
  lstat: (path: string) => BigIntStats;
  link: (sourcePath: string, destinationPath: string) => void;
  syncDirectory: (path: string) => void;
}

const daemonStateAtomicEvidenceFilesystem: DaemonStateAtomicEvidenceFilesystem = {
  platform: process.platform,
  lstat: (path) => lstatSync(path, { bigint: true }),
  link: linkSync,
  syncDirectory: fsyncDirectory,
};

interface StableSource {
  bytes: Buffer;
  sha256: string;
  size: number;
  stat: BigIntStats;
  running: boolean | null;
  issueCodes: DaemonStateDiagnosticCode[];
}

export interface SourceGeneration {
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
  bornNs: string;
}

interface RecoveryMarker {
  schemaVersion: 1;
  kind: 'daemon-state-quarantine-intent';
  planId: string;
  planDigest: string;
  expectedSourceSha256: string;
  quarantineFileName: string;
  createdAt: string;
  serviceMutationAllowed: false;
  markerDigest: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string;
}

interface RecoverySigner {
  key: Buffer;
  keyId: string;
}

function recoveryRoot(): string {
  return join(homedir(), '.ashlr', 'control', 'daemon-state-recovery');
}

export function daemonStateRecoveryPlanPath(planId: string): string {
  return join(recoveryRoot(), 'plans', `${planId}.json`);
}

export function daemonStateRecoveryReceiptPath(planId: string): string {
  return join(recoveryRoot(), 'receipts', `${planId}.json`);
}

export function daemonStateResolutionPlanPath(planId: string): string {
  return join(recoveryRoot(), 'resolution-plans', `${planId}.json`);
}

export function daemonStateResolutionIntentPath(planId: string): string {
  return join(recoveryRoot(), 'resolution-intents', `${planId}.json`);
}

export function daemonStateResolutionReceiptPath(planId: string): string {
  return join(recoveryRoot(), 'resolution-receipts', `${planId}.json`);
}

export function daemonStateResolutionRetiredMarkerPath(planId: string): string {
  return join(recoveryRoot(), 'retired-markers', planId, 'active.json');
}

export function daemonStateQuarantinePath(fileName: string): string {
  return join(homedir(), '.ashlr', 'quarantine', 'daemon-state', fileName);
}

function recoveryLockPath(): string {
  return join(recoveryRoot(), 'locks', 'quarantine.lock');
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainDigest(domain: string, value: unknown): string {
  return sha256Bytes(`${domain}${canonicalizeDaemonActivationValue(value)}`);
}

function signingKey(provenanceKey: Buffer): RecoverySigner {
  const key = createHmac('sha256', provenanceKey).update(SIGNING_KEY_DOMAIN, 'utf8').digest();
  return {
    key,
    keyId: sha256Bytes(Buffer.concat([Buffer.from(SIGNING_KEY_ID_DOMAIN, 'utf8'), key])),
  };
}

function signerForWrite(): RecoverySigner {
  loadOrCreateKey();
  const durable = loadExistingProvenanceKeyReadOnly();
  if (!durable) throw new Error('durable provenance signing key unavailable');
  return signingKey(durable);
}

function signerForRead(): RecoverySigner | null {
  try {
    const durable = loadExistingProvenanceKeyReadOnly();
    return durable ? signingKey(durable) : null;
  } catch {
    return null;
  }
}

function resolutionSigningKey(provenanceKey: Buffer): RecoverySigner {
  const key = createHmac('sha256', provenanceKey).update(RESOLUTION_SIGNING_KEY_DOMAIN, 'utf8').digest();
  return {
    key,
    keyId: sha256Bytes(Buffer.concat([Buffer.from(RESOLUTION_SIGNING_KEY_ID_DOMAIN, 'utf8'), key])),
  };
}

function resolutionSignerForWrite(): RecoverySigner {
  loadOrCreateKey();
  const durable = loadExistingProvenanceKeyReadOnly();
  if (!durable) throw new Error('durable provenance signing key unavailable');
  return resolutionSigningKey(durable);
}

function resolutionSignerForRead(): RecoverySigner | null {
  try {
    const durable = loadExistingProvenanceKeyReadOnly();
    return durable ? resolutionSigningKey(durable) : null;
  } catch {
    return null;
  }
}

function keyedSignature(domain: string, value: unknown, signer: RecoverySigner): string {
  return createHmac('sha256', signer.key)
    .update(domain, 'utf8')
    .update(canonicalizeDaemonActivationValue(value), 'utf8')
    .digest('hex');
}

function authenticSignature(
  domain: string,
  value: unknown,
  keyId: unknown,
  algorithm: unknown,
  signature: unknown,
): boolean {
  if (algorithm !== SIGNATURE_ALGORITHM || typeof keyId !== 'string' ||
    !SHA256_RE.test(keyId) || typeof signature !== 'string' || !SHA256_RE.test(signature)) return false;
  const signer = signerForRead();
  if (!signer || !equalDigest(signer.keyId, keyId)) return false;
  return equalDigest(signature, keyedSignature(domain, value, signer));
}

function authenticResolutionSignature(
  domain: string,
  value: unknown,
  keyId: unknown,
  algorithm: unknown,
  signature: unknown,
): boolean {
  if (algorithm !== SIGNATURE_ALGORITHM || typeof keyId !== 'string' ||
    !SHA256_RE.test(keyId) || typeof signature !== 'string' || !SHA256_RE.test(signature)) return false;
  const signer = resolutionSignerForRead();
  if (!signer || !equalDigest(signer.keyId, keyId)) return false;
  return equalDigest(signature, keyedSignature(domain, value, signer));
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function owned(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function safePrivateFile(stat: BigIntStats, allowedLinks: readonly bigint[] = [1n]): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && allowedLinks.includes(stat.nlink) && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077n) === 0n);
}

function safePrivateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077n) === 0n);
}

function safeHomeAnchor(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePrivateDirectoryIdentity(path: string, expected: BigIntStats): boolean {
  const observed = lstatSync(path, { bigint: true });
  const aclAssured = process.platform !== 'darwin' || assurePrivateStoragePath(
    path,
    'directory',
    'inspect-owned',
    { anchorPath: resolve(homedir()) },
  ).ok;
  const assured = lstatSync(path, { bigint: true });
  return aclAssured && sameSnapshot(observed, assured) && safePrivateDirectory(assured) &&
    observed.dev === expected.dev && observed.ino === expected.ino &&
    observed.mode === expected.mode && observed.uid === expected.uid && observed.gid === expected.gid;
}

function sourceGeneration(stat: BigIntStats): SourceGeneration {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
    bornNs: stat.birthtimeNs.toString(),
  };
}

function validGeneration(value: unknown): value is SourceGeneration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = ['bornNs', 'changedNs', 'device', 'inode', 'modifiedNs'];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
    expected.every((key) => typeof row[key] === 'string' && /^[0-9]+$/u.test(row[key] as string));
}

function sameGeneration(stat: BigIntStats, expected: SourceGeneration): boolean {
  const observed = sourceGeneration(stat);
  return canonicalizeDaemonActivationValue(observed) === canonicalizeDaemonActivationValue(expected);
}

function sameRelocatedGeneration(stat: BigIntStats, expected: SourceGeneration): boolean {
  return stat.dev.toString() === expected.device && stat.ino.toString() === expected.inode &&
    stat.mtimeNs.toString() === expected.modifiedNs && stat.birthtimeNs.toString() === expected.bornNs;
}

function validBoundedPlanWindow(createdAt: unknown, expiresAt: unknown): boolean {
  if (typeof createdAt !== 'string' || typeof expiresAt !== 'string') return false;
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires) &&
    expires > created && expires - created <= PLAN_TTL_MS;
}

function nestedWithin(anchor: string, target: string): boolean {
  const nested = relative(anchor, target);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function ensurePrivateDirectory(path: string): void {
  const home = resolve(homedir());
  const target = resolve(path);
  if (!nestedWithin(home, target)) throw new Error('path-outside-home');
  const homeStat = lstatSync(home, { bigint: true });
  // A normal macOS home may be 0755. It is a containment anchor, not a state
  // directory: traversal/read bits are acceptable, but another user must
  // never be able to replace descendants beneath it. `.ashlr` and every
  // recovery directory below it still require exact private-directory modes.
  if (!safeHomeAnchor(homeStat)) throw new Error('unsafe-home');
  if (process.platform === 'darwin') {
    const homeAssurance = assurePrivateStoragePath(home, 'directory', 'inspect-owned', {
      anchorPath: home,
    });
    if (!homeAssurance.ok) throw new Error(`unsafe-home:${homeAssurance.reason}`);
    if (!sameSnapshot(homeStat, lstatSync(home, { bigint: true }))) {
      throw new Error('home-changed-during-assurance');
    }
  }
  const parts = relative(home, target).split(sep).filter(Boolean);
  let cursor = home;
  for (const part of parts) {
    cursor = join(cursor, part);
    let created = false;
    if (!existsSync(cursor)) {
      mkdirSync(cursor, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    }
    let stat = lstatSync(cursor, { bigint: true });
    if (!safePrivateDirectory(stat)) throw new Error(`unsafe-directory:${cursor}`);
    if (created) {
      if (process.platform !== 'win32') chmodSync(cursor, PRIVATE_DIRECTORY_MODE);
      stat = lstatSync(cursor, { bigint: true });
      const assurance = assurePrivateStoragePath(cursor, 'directory', 'secure-created', {
        anchorPath: home,
      });
      if (!assurance.ok) throw new Error(`unsafe-directory:${assurance.reason}`);
      fsyncDirectory(dirname(cursor));
    } else {
      const assurance = assurePrivateStoragePath(cursor, 'directory', 'inspect-existing', {
        anchorPath: home,
      });
      if (!assurance.ok) throw new Error(`unsafe-directory:${assurance.reason}`);
    }
    if (!sameSnapshot(stat, lstatSync(cursor, { bigint: true }))) {
      throw new Error(`directory-changed-during-assurance:${cursor}`);
    }
  }
}

function assureSourceStorage(path: string): void {
  const home = resolve(homedir());
  const target = resolve(path);
  if (!nestedWithin(home, target)) throw new Error('source-outside-home');
  if (process.platform !== 'win32') {
    const homeStat = lstatSync(home, { bigint: true });
    if (!safeHomeAnchor(homeStat)) throw new Error('unsafe-source-home');
    const parts = relative(home, dirname(target)).split(sep).filter(Boolean);
    let cursor = home;
    for (const part of parts) {
      cursor = join(cursor, part);
      if (!safePrivateDirectory(lstatSync(cursor, { bigint: true }))) {
        throw new Error(`unsafe-source-directory:${cursor}`);
      }
    }
  }
  const assurance = assurePrivateStoragePath(target, 'file', 'inspect-owned', { anchorPath: home });
  if (!assurance.ok) throw new Error(`unsafe-source:${assurance.reason}`);
}

function readExact(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error('short-read');
    offset += count;
  }
  return bytes;
}

function stableRead(
  path: string,
  diagnoseState: boolean,
  allowedLinks: readonly bigint[] = [1n],
): StableSource {
  const namedBefore = lstatSync(path, { bigint: true });
  if (!safePrivateFile(namedBefore, allowedLinks) || namedBefore.size <= 0n ||
    namedBefore.size > BigInt(MAX_STATE_BYTES)) throw new Error('unsafe-source-file');
  assureSourceStorage(path);
  const namedAssured = lstatSync(path, { bigint: true });
  if (!sameSnapshot(namedBefore, namedAssured)) throw new Error('source-changed-during-assurance');
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!safePrivateFile(openedBefore, allowedLinks) || !sameSnapshot(namedBefore, openedBefore)) {
      throw new Error('source-changed-during-open');
    }
    const bytes = readExact(fd, Number(openedBefore.size));
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, namedAfter)) {
      throw new Error('source-changed-during-read');
    }
    if (process.platform === 'darwin') {
      assureSourceStorage(path);
      const assuredOpened = fstatSync(fd, { bigint: true });
      const assuredNamed = lstatSync(path, { bigint: true });
      if (!sameSnapshot(openedAfter, assuredOpened) || !sameSnapshot(assuredOpened, assuredNamed)) {
        throw new Error('source-changed-during-assurance');
      }
    }
    let running: boolean | null = null;
    let issueCodes: DaemonStateDiagnosticCode[] = [];
    if (diagnoseState) {
      try {
        const decoded = JSON.parse(bytes.toString('utf8')) as unknown;
        if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
          const row = decoded as Record<string, unknown>;
          running = typeof row['running'] === 'boolean' ? row['running'] : null;
        }
        issueCodes = daemonStateIssueCodes(decoded);
      } catch {
        issueCodes = ['invalid-json'];
      }
    }
    return {
      bytes,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      stat: openedAfter,
      running,
      issueCodes,
    };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error('write-made-no-progress');
    offset += count;
  }
}

function writeExclusiveBytes(path: string, bytes: Buffer): void {
  ensurePrivateDirectory(dirname(path));
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    );
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const initial = fstatSync(fd, { bigint: true });
    if (!safePrivateFile(initial) || initial.size !== 0n) throw new Error('unsafe-new-record');
    if (process.platform === 'darwin') {
      const emptyAssurance = assurePrivateStoragePath(path, 'file', 'secure-created', {
        anchorPath: resolve(homedir()),
      });
      if (!emptyAssurance.ok) throw new Error(`unsafe-record:${emptyAssurance.reason}`);
      const assuredOpened = fstatSync(fd, { bigint: true });
      const assuredNamed = lstatSync(path, { bigint: true });
      if (!safePrivateFile(assuredOpened) || assuredOpened.size !== 0n ||
        !sameSnapshot(initial, assuredOpened) || !sameSnapshot(assuredOpened, assuredNamed)) {
        throw new Error('record-changed-during-assurance');
      }
    }
    writeAll(fd, bytes);
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!safePrivateFile(after) || after.dev !== initial.dev || after.ino !== initial.ino ||
      after.size !== BigInt(bytes.length)) throw new Error('record-changed-during-write');
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', {
      anchorPath: homedir(),
    });
    if (!assurance.ok) throw new Error(`unsafe-record:${assurance.reason}`);
    if (process.platform === 'darwin') {
      const assuredOpened = fstatSync(fd, { bigint: true });
      const assuredNamed = lstatSync(path, { bigint: true });
      if (!sameSnapshot(after, assuredOpened) || !sameSnapshot(assuredOpened, assuredNamed)) {
        throw new Error('record-changed-during-final-assurance');
      }
    }
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve fail-closed evidence */ }
    }
  }
}

function writeExclusiveRecord(path: string, value: unknown): void {
  writeExclusiveBytes(path, Buffer.from(`${canonicalizeDaemonActivationValue(value)}\n`, 'utf8'));
}

function writePrivateRecordTemp(path: string, planId: string, value: unknown): string {
  const tempPath = join(dirname(path), `.${basename(path)}.${planId}.${randomUUID()}.tmp`);
  writeExclusiveRecord(tempPath, value);
  return tempPath;
}

function publishRecordNoClobber(tempPath: string, finalPath: string): void {
  // Node does not expose renameat2(RENAME_NOREPLACE). A same-filesystem hard
  // link provides the required atomic, no-clobber publication without exposing
  // partially-written record bytes. The private temp intentionally remains:
  // pathname-based cleanup cannot be made identity-conditional in Node.
  linkSync(tempPath, finalPath);
  fsyncDirectory(dirname(finalPath));
}

function readRecord(path: string): unknown {
  return JSON.parse(stableRead(path, false).bytes.toString('utf8')) as unknown;
}

function readPublishedRecord(path: string): unknown {
  return JSON.parse(stableRead(path, false, [1n, 2n]).bytes.toString('utf8')) as unknown;
}

function retirePrivateRecord(path: string, category: string, planId: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (!safePrivateFile(stat) || stat.size > BigInt(MAX_STATE_BYTES)) {
    throw new Error('unsafe-abandoned-record');
  }
  const destinationDirectory = join(
    recoveryRoot(),
    'abandoned',
    category,
    planId,
    randomUUID(),
  );
  ensurePrivateDirectory(destinationDirectory);
  renameSync(path, join(destinationDirectory, basename(path)));
  fsyncDirectory(dirname(path));
  fsyncDirectory(destinationDirectory);
}

function markerTempPrefix(markerPath: string, planId: string): string {
  return `.${basename(markerPath)}.${planId}.`;
}

function prepareMarkerTemp(
  markerPath: string,
  plan: DaemonStateQuarantinePlan,
  marker: RecoveryMarker,
): string {
  ensurePrivateDirectory(dirname(markerPath));
  const prefix = markerTempPrefix(markerPath, plan.planId);
  let reusable: string | null = null;
  for (const name of readdirSync(dirname(markerPath)).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = join(dirname(markerPath), name);
    let parsed: RecoveryMarker | null = null;
    try {
      parsed = parseMarker(readRecord(candidate));
    } catch {
      // Invalid private temps are retained in the abandoned evidence tree.
    }
    if (parsed && equalDigest(parsed.markerDigest, marker.markerDigest)) {
      if (!reusable) {
        reusable = candidate;
        continue;
      }
    }
    retirePrivateRecord(candidate, 'marker-temp', plan.planId);
  }
  return reusable ?? writePrivateRecordTemp(markerPath, plan.planId, marker);
}

function prepareReceiptTemp(
  receiptPath: string,
  plan: DaemonStateQuarantinePlan,
  receipt: DaemonStateQuarantineReceipt,
): string {
  ensurePrivateDirectory(dirname(receiptPath));
  const prefix = markerTempPrefix(receiptPath, plan.planId);
  let reusable: string | null = null;
  for (const name of readdirSync(dirname(receiptPath)).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = join(dirname(receiptPath), name);
    let parsed: DaemonStateQuarantineReceipt | null = null;
    try {
      parsed = parseReceipt(readRecord(candidate));
    } catch {
      // Invalid private temps are retained in the abandoned evidence tree.
    }
    if (parsed && equalDigest(parsed.receiptDigest, receipt.receiptDigest)) {
      if (!reusable) {
        reusable = candidate;
        continue;
      }
    }
    retirePrivateRecord(candidate, 'receipt-temp', plan.planId);
  }
  return reusable ?? writePrivateRecordTemp(receiptPath, plan.planId, receipt);
}

function prepareResolutionReceiptTemp(
  receiptPath: string,
  plan: DaemonStateResolutionPlan,
  receipt: DaemonStateResolutionReceipt,
): string {
  ensurePrivateDirectory(dirname(receiptPath));
  const prefix = markerTempPrefix(receiptPath, plan.planId);
  let reusable: string | null = null;
  for (const name of readdirSync(dirname(receiptPath)).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = join(dirname(receiptPath), name);
    let parsed: DaemonStateResolutionReceipt | null = null;
    try {
      parsed = parseResolutionReceipt(readRecord(candidate));
    } catch {
      // Invalid private temps are retained in the abandoned evidence tree.
    }
    if (parsed && equalDigest(parsed.receiptDigest, receipt.receiptDigest)) {
      if (!reusable) {
        reusable = candidate;
        continue;
      }
    }
    retirePrivateRecord(candidate, 'resolution-receipt-temp', plan.planId);
  }
  return reusable ?? writePrivateRecordTemp(receiptPath, plan.planId, receipt);
}

function planTimeRefusal(
  plan: DaemonStateQuarantinePlan,
  runtime: DaemonStateRecoveryRuntime,
  observedNow: Date = runtime.now?.() ?? new Date(),
): DaemonStateRecoveryFailure | null {
  const createdAtMs = Date.parse(plan.createdAt);
  if (observedNow.getTime() < createdAtMs - MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: 'plan-not-yet-valid',
      detail: `local clock precedes plan creation beyond ${MAX_CLOCK_SKEW_MS}ms allowed skew`,
    };
  }
  return observedNow.getTime() >= Date.parse(plan.expiresAt)
    ? { ok: false, reason: 'plan-expired', detail: `plan expired at ${plan.expiresAt}` }
    : null;
}

function buildMarker(
  plan: DaemonStateQuarantinePlan,
  signer: RecoverySigner,
): RecoveryMarker {
  const unsignedMarker: Omit<RecoveryMarker, 'markerDigest' | 'signature'> = {
    schemaVersion: 1,
    kind: 'daemon-state-quarantine-intent',
    planId: plan.planId,
    planDigest: plan.planDigest,
    expectedSourceSha256: plan.expectedSourceSha256,
    quarantineFileName: plan.quarantineFileName,
    createdAt: plan.createdAt,
    serviceMutationAllowed: false,
    signingKeyId: signer.keyId,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
  };
  const unsignedSignedMarker: Omit<RecoveryMarker, 'signature'> = {
    ...unsignedMarker,
    markerDigest: domainDigest(MARKER_DOMAIN, unsignedMarker),
  };
  return {
    ...unsignedSignedMarker,
    signature: keyedSignature(MARKER_DOMAIN, unsignedSignedMarker, signer),
  };
}

function serviceRefusal(runtime: DaemonStateRecoveryRuntime): DaemonStateRecoveryFailure | null {
  let status: ServiceStatusResult;
  try {
    status = runtime.serviceStatus();
  } catch (error) {
    return { ok: false, reason: 'service-state-unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  if (status.registrationState === 'unknown' || status.platformSpec === 'unknown' ||
    status.runtimeState === undefined || status.runtimeState === 'unknown') {
    return { ok: false, reason: 'service-state-unknown', detail: 'service registration or runtime state is unknown' };
  }
  const activity = serviceActivity(status);
  return activity === 'inactive'
    ? null
    : {
        ok: false,
        reason: 'service-active',
        detail: `service activity is ${activity}`,
      };
}

function validateSource(source: StableSource, expectedSha256: string): DaemonStateRecoveryFailure | null {
  if (!equalDigest(source.sha256, expectedSha256)) {
    return { ok: false, reason: 'source-drift', detail: `observed source SHA-256 ${source.sha256}` };
  }
  if (source.issueCodes.length === 0) {
    return { ok: false, reason: 'source-not-malformed', detail: 'daemon state passes strict validation' };
  }
  const unsupported = source.issueCodes.filter((code) => !RECOVERABLE_ISSUE_CODES.has(code));
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: 'unknown-or-nonrecoverable-issue-code',
      detail: unsupported.join(', '),
    };
  }
  if (source.running !== false) {
    return {
      ok: false,
      reason: 'source-running-not-proven-stopped',
      detail: 'daemon state must explicitly contain running:false',
    };
  }
  return null;
}

function planDigestPayload(
  plan: DaemonStateQuarantinePlan,
): Omit<DaemonStateQuarantinePlan, 'planDigest' | 'signature'> {
  const { planDigest: _planDigest, signature: _signature, ...unsigned } = plan;
  return unsigned;
}

function planSignaturePayload(plan: DaemonStateQuarantinePlan): Omit<DaemonStateQuarantinePlan, 'signature'> {
  const { signature: _signature, ...unsigned } = plan;
  return unsigned;
}

function markerDigestPayload(marker: RecoveryMarker): Omit<RecoveryMarker, 'markerDigest' | 'signature'> {
  const { markerDigest: _markerDigest, signature: _signature, ...unsigned } = marker;
  return unsigned;
}

function markerSignaturePayload(marker: RecoveryMarker): Omit<RecoveryMarker, 'signature'> {
  const { signature: _signature, ...unsigned } = marker;
  return unsigned;
}

function receiptDigestPayload(
  receipt: DaemonStateQuarantineReceipt,
): Omit<DaemonStateQuarantineReceipt, 'receiptDigest' | 'signature'> {
  const { receiptDigest: _receiptDigest, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function receiptSignaturePayload(
  receipt: DaemonStateQuarantineReceipt,
): Omit<DaemonStateQuarantineReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function parsePlan(value: unknown): DaemonStateQuarantinePlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    'authority', 'createdAt', 'expiresAt', 'expectedSourceSha256', 'issueCodes', 'kind', 'operation',
    'planDigest', 'planId', 'quarantineFileName', 'schemaVersion', 'sourcePathSha256',
    'sourceSizeBytes', 'sourceGeneration', 'signature', 'signatureAlgorithm', 'signingKeyId',
  ].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-quarantine-plan' ||
    row['operation'] !== 'quarantine' || typeof row['planId'] !== 'string' ||
    !UUID_RE.test(row['planId']) || !validBoundedPlanWindow(row['createdAt'], row['expiresAt']) ||
    !SHA256_RE.test(String(row['expectedSourceSha256'])) ||
    !Number.isSafeInteger(row['sourceSizeBytes']) || Number(row['sourceSizeBytes']) < 1 ||
    !SHA256_RE.test(String(row['sourcePathSha256'])) ||
    !validGeneration(row['sourceGeneration']) ||
    !Array.isArray(row['issueCodes']) || row['issueCodes'].length < 1 ||
    row['issueCodes'].some((code) => typeof code !== 'string' || !RECOVERABLE_ISSUE_CODES.has(code as DaemonStateDiagnosticCode)) ||
    typeof row['quarantineFileName'] !== 'string' || basename(row['quarantineFileName']) !== row['quarantineFileName'] ||
    !SHA256_RE.test(String(row['planDigest'])) || !SHA256_RE.test(String(row['signingKeyId'])) ||
    row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM || !SHA256_RE.test(String(row['signature']))) return null;
  const authority = row['authority'];
  if (typeof authority !== 'object' || authority === null || Array.isArray(authority)) return null;
  const authorityRow = authority as Record<string, unknown>;
  if (canonicalizeDaemonActivationValue(authorityRow) !== canonicalizeDaemonActivationValue({
    dryRunFirst: true,
    operatorAuthorizationRequired: true,
    operatorIdentityAuthenticated: false,
    sourceMutationAllowed: false,
    serviceMutationAllowed: false,
    serviceStartAllowed: false,
    serviceRestartAllowed: false,
    serviceInstallAllowed: false,
  })) return null;
  const plan = value as DaemonStateQuarantinePlan;
  return equalDigest(plan.planDigest, domainDigest(PLAN_DOMAIN, planDigestPayload(plan))) &&
    authenticSignature(PLAN_DOMAIN, planSignaturePayload(plan), plan.signingKeyId,
      plan.signatureAlgorithm, plan.signature)
    ? plan
    : null;
}

function parseMarker(value: unknown): RecoveryMarker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    'createdAt', 'expectedSourceSha256', 'kind', 'markerDigest', 'planDigest', 'planId',
    'quarantineFileName', 'schemaVersion', 'serviceMutationAllowed', 'signature',
    'signatureAlgorithm', 'signingKeyId',
  ].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-quarantine-intent' ||
    typeof row['planId'] !== 'string' || !UUID_RE.test(row['planId']) ||
    !SHA256_RE.test(String(row['planDigest'])) ||
    !SHA256_RE.test(String(row['expectedSourceSha256'])) ||
    typeof row['quarantineFileName'] !== 'string' ||
    basename(row['quarantineFileName']) !== row['quarantineFileName'] ||
    typeof row['createdAt'] !== 'string' || row['serviceMutationAllowed'] !== false ||
    !SHA256_RE.test(String(row['markerDigest'])) || !SHA256_RE.test(String(row['signingKeyId'])) ||
    row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM || !SHA256_RE.test(String(row['signature']))) return null;
  const marker = value as RecoveryMarker;
  return equalDigest(marker.markerDigest, domainDigest(MARKER_DOMAIN, markerDigestPayload(marker))) &&
    authenticSignature(MARKER_DOMAIN, markerSignaturePayload(marker), marker.signingKeyId,
      marker.signatureAlgorithm, marker.signature)
    ? marker
    : null;
}

function parseReceipt(value: unknown): DaemonStateQuarantineReceipt | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    'completedAt', 'daemonStateBlockedPendingResolution', 'kind', 'operation',
    'operatorAuthorizationPresented', 'operatorIdentityAuthenticated', 'planDigest', 'planId',
    'previousDigest', 'quarantineFileName', 'quarantineSha256', 'receiptDigest', 'schemaVersion',
    'serviceInstallPerformed', 'serviceMutationPerformed', 'serviceRestartPerformed',
    'serviceStartPerformed', 'signature', 'signatureAlgorithm', 'signingKeyId', 'sourceBytesPreserved',
    'sourceSha256', 'sourceSizeBytes',
  ].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-quarantine-receipt' ||
    typeof row['planId'] !== 'string' || !UUID_RE.test(row['planId']) ||
    !SHA256_RE.test(String(row['planDigest'])) || !SHA256_RE.test(String(row['previousDigest'])) ||
    typeof row['completedAt'] !== 'string' || row['operation'] !== 'quarantine' ||
    !SHA256_RE.test(String(row['sourceSha256'])) ||
    !Number.isSafeInteger(row['sourceSizeBytes']) || Number(row['sourceSizeBytes']) < 1 ||
    typeof row['quarantineFileName'] !== 'string' ||
    basename(row['quarantineFileName']) !== row['quarantineFileName'] ||
    !SHA256_RE.test(String(row['quarantineSha256'])) || row['sourceBytesPreserved'] !== true ||
    row['daemonStateBlockedPendingResolution'] !== true ||
    row['operatorAuthorizationPresented'] !== true || row['operatorIdentityAuthenticated'] !== false ||
    row['serviceMutationPerformed'] !== false || row['serviceStartPerformed'] !== false ||
    row['serviceRestartPerformed'] !== false || row['serviceInstallPerformed'] !== false ||
    !SHA256_RE.test(String(row['receiptDigest'])) || !SHA256_RE.test(String(row['signingKeyId'])) ||
    row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM || !SHA256_RE.test(String(row['signature']))) return null;
  const receipt = value as DaemonStateQuarantineReceipt;
  return equalDigest(receipt.receiptDigest, domainDigest(RECEIPT_DOMAIN, receiptDigestPayload(receipt))) &&
    authenticSignature(RECEIPT_DOMAIN, receiptSignaturePayload(receipt), receipt.signingKeyId,
      receipt.signatureAlgorithm, receipt.signature)
    ? receipt
    : null;
}

function acquireRecoveryLock(): LocalStoreLock | null {
  return acquireLocalStoreLock(recoveryLockPath(), 2_000, {
    anchorPath: homedir(),
    exactPrivateStorage: true,
  });
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path, { bigint: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function evidencePathEntryExists(
  path: string,
  filesystem: DaemonStateAtomicEvidenceFilesystem,
): boolean {
  try {
    filesystem.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sameEvidenceParent(
  path: string,
  expected: BigIntStats,
  filesystem: DaemonStateAtomicEvidenceFilesystem,
): boolean {
  const observed = filesystem.lstat(path);
  return safePrivateDirectory(observed) && observed.dev === expected.dev &&
    observed.ino === expected.ino && observed.mode === expected.mode &&
    observed.uid === expected.uid && observed.gid === expected.gid;
}

/**
 * Publish exact quarantine evidence without ever deleting a pathname. The
 * authenticated recovery marker, not source removal, blocks daemon startup.
 * Windows execute remains unsupported until directory durability has a native
 * implementation; dry-run and all read-only diagnostics remain available.
 */
export function prepareDaemonStateAtomicQuarantineEvidence(
  input: Parameters<NonNullable<DaemonStateRecoveryRuntime['prepareAtomicQuarantineEvidence']>>[0],
  filesystem: DaemonStateAtomicEvidenceFilesystem = daemonStateAtomicEvidenceFilesystem,
): { publish: () => void } | null {
  if (filesystem.platform === 'win32') return null;
  const sourcePath = resolve(input.sourcePath);
  const quarantinePath = resolve(input.quarantinePath);
  const home = resolve(homedir());
  if (sourcePath === quarantinePath || !nestedWithin(home, sourcePath) ||
    !nestedWithin(home, quarantinePath)) return null;

  const sourceParentPath = dirname(sourcePath);
  const quarantineParentPath = dirname(quarantinePath);
  assureSourceStorage(sourcePath);
  ensurePrivateDirectory(quarantineParentPath);

  const source = stableRead(sourcePath, false);
  if (!sameGeneration(source.stat, input.expectedSourceGeneration) ||
    !equalDigest(source.sha256, input.expectedSourceSha256)) return null;
  const sourceParent = filesystem.lstat(sourceParentPath);
  const quarantineParent = filesystem.lstat(quarantineParentPath);
  if (!safePrivateDirectory(sourceParent) || !safePrivateDirectory(quarantineParent) ||
    source.stat.dev !== sourceParent.dev || source.stat.dev !== quarantineParent.dev ||
    evidencePathEntryExists(quarantinePath, filesystem)) return null;

  let consumed = false;
  return {
    publish: () => {
      if (consumed) throw new Error('atomic-evidence-capability-already-consumed');
      consumed = true;
      if (!sameEvidenceParent(sourceParentPath, sourceParent, filesystem) ||
        !sameEvidenceParent(quarantineParentPath, quarantineParent, filesystem)) {
        throw new Error('atomic-evidence-parent-changed');
      }
      const immediateSource = stableRead(sourcePath, false);
      if (!sameGeneration(immediateSource.stat, input.expectedSourceGeneration) ||
        !equalDigest(immediateSource.sha256, input.expectedSourceSha256) ||
        evidencePathEntryExists(quarantinePath, filesystem)) {
        throw new Error('atomic-evidence-source-or-destination-changed');
      }

      // link(2) is an atomic no-clobber publication and fails with EXDEV when
      // the destination is not on the source filesystem.
      filesystem.link(sourcePath, quarantinePath);
      filesystem.syncDirectory(quarantineParentPath);

      const linkedEvidence = stableRead(quarantinePath, false, [2n]);
      const linkedSource = stableRead(sourcePath, false, [2n]);
      if (!sameRelocatedGeneration(linkedEvidence.stat, input.expectedSourceGeneration) ||
        !sameRelocatedGeneration(linkedSource.stat, input.expectedSourceGeneration) ||
        linkedEvidence.stat.dev !== linkedSource.stat.dev || linkedEvidence.stat.ino !== linkedSource.stat.ino ||
        !equalDigest(linkedEvidence.sha256, input.expectedSourceSha256) ||
        !equalDigest(linkedSource.sha256, input.expectedSourceSha256) ||
        !sameEvidenceParent(sourceParentPath, sourceParent, filesystem) ||
        !sameEvidenceParent(quarantineParentPath, quarantineParent, filesystem)) {
        throw new Error('atomic-evidence-linked-generation-mismatch');
      }
    },
  };
}

function readAuthenticatedLinkedQuarantine(
  sourcePath: string,
  quarantinePath: string,
  plan: DaemonStateQuarantinePlan,
): { source: StableSource; evidence: StableSource } | null {
  const source = stableRead(sourcePath, true, [2n]);
  const evidence = stableRead(quarantinePath, false, [2n]);
  if (source.stat.dev !== evidence.stat.dev || source.stat.ino !== evidence.stat.ino ||
    !sameRelocatedGeneration(source.stat, plan.sourceGeneration) ||
    !sameRelocatedGeneration(evidence.stat, plan.sourceGeneration) ||
    source.size !== plan.sourceSizeBytes || evidence.size !== plan.sourceSizeBytes ||
    !equalDigest(source.sha256, plan.expectedSourceSha256) ||
    !equalDigest(evidence.sha256, plan.expectedSourceSha256) ||
    canonicalizeDaemonActivationValue([...source.issueCodes].sort()) !==
      canonicalizeDaemonActivationValue(plan.issueCodes)) return null;
  const invalid = validateSource(source, plan.expectedSourceSha256);
  return invalid ? null : { source, evidence };
}

export function previewDaemonStateQuarantine(
  expectedSourceSha256: string,
  runtime: DaemonStateRecoveryRuntime,
): PreviewDaemonStateQuarantineResult {
  const expected = expectedSourceSha256.toLowerCase();
  if (!SHA256_RE.test(expected)) {
    return { ok: false, reason: 'invalid-expected-sha256', detail: 'expected SHA-256 must be 64 lowercase hex characters' };
  }
  const service = serviceRefusal(runtime);
  if (service) return service;
  let source: StableSource;
  try {
    source = stableRead(daemonStatePath(), true);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'source-missing' : String(error).includes('unsafe') ? 'source-unsafe' : 'source-unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const invalid = validateSource(source, expected);
  if (invalid) return invalid;
  const planId = (runtime.randomId ?? randomUUID)();
  if (!UUID_RE.test(planId)) {
    return { ok: false, reason: 'plan-write-failed', detail: 'runtime produced an invalid plan id' };
  }
  const now = runtime.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS).toISOString();
  let signer: RecoverySigner;
  try {
    signer = signerForWrite();
  } catch (error) {
    return { ok: false, reason: 'plan-write-failed', detail: error instanceof Error ? error.message : String(error) };
  }
  const unsigned: Omit<DaemonStateQuarantinePlan, 'planDigest' | 'signature'> = {
    schemaVersion: 1,
    kind: 'daemon-state-quarantine-plan',
    planId,
    createdAt,
    expiresAt,
    operation: 'quarantine',
    expectedSourceSha256: expected,
    sourceSizeBytes: source.size,
    sourcePathSha256: sha256Bytes(resolve(daemonStatePath())),
    sourceGeneration: sourceGeneration(source.stat),
    issueCodes: [...source.issueCodes].sort(),
    quarantineFileName: `${expected}.${planId}.daemon.json`,
    authority: {
      dryRunFirst: true,
      operatorAuthorizationRequired: true,
      operatorIdentityAuthenticated: false,
      sourceMutationAllowed: false,
      serviceMutationAllowed: false,
      serviceStartAllowed: false,
      serviceRestartAllowed: false,
      serviceInstallAllowed: false,
    },
    signingKeyId: signer.keyId,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
  };
  const unsignedSigned: Omit<DaemonStateQuarantinePlan, 'signature'> = {
    ...unsigned,
    planDigest: domainDigest(PLAN_DOMAIN, unsigned),
  };
  const plan: DaemonStateQuarantinePlan = {
    ...unsignedSigned,
    signature: keyedSignature(PLAN_DOMAIN, unsignedSigned, signer),
  };
  const planPath = daemonStateRecoveryPlanPath(planId);
  try {
    writeExclusiveRecord(planPath, plan);
  } catch (error) {
    return { ok: false, reason: 'plan-write-failed', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, plan, planPath };
}

export function executeDaemonStateQuarantine(
  input: { planId: string; planDigest: string; operatorAuthorization: string },
  runtime: DaemonStateRecoveryRuntime,
): ExecuteDaemonStateQuarantineResult {
  if (!UUID_RE.test(input.planId)) return { ok: false, reason: 'invalid-plan-id', detail: 'invalid plan id' };
  if (!SHA256_RE.test(input.planDigest)) return { ok: false, reason: 'invalid-plan-digest', detail: 'invalid plan digest' };
  if (!input.operatorAuthorization) return { ok: false, reason: 'authorization-required', detail: 'explicit operator authorization is required' };
  if (!equalDigest(input.operatorAuthorization, input.planDigest)) {
    return { ok: false, reason: 'authorization-mismatch', detail: 'authorization must equal the exact plan digest' };
  }

  const lock = acquireRecoveryLock();
  if (!lock) return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock unavailable' };
  let daemonLock: DaemonLock | undefined;
  try {
    if (!ownsLocalStoreLock(lock)) {
      return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock ownership was lost' };
    }
    const receiptPath = daemonStateRecoveryReceiptPath(input.planId);
    let receiptEntryPresent: boolean;
    try {
      receiptEntryPresent = pathEntryExists(receiptPath);
    } catch (error) {
      return {
        ok: false,
        reason: 'receipt-write-failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (receiptEntryPresent) {
      try {
        const receipt = parseReceipt(readPublishedRecord(receiptPath));
        if (!receipt || receipt.planId !== input.planId ||
          !equalDigest(receipt.planDigest, input.planDigest)) {
          return {
            ok: false,
            reason: 'receipt-write-failed',
            detail: 'completion receipt path exists but is invalid; the plan is not considered consumed',
          };
        }
        return {
          ok: false,
          reason: 'plan-already-consumed',
          detail: 'plan already has a valid authenticated completion receipt',
        };
      } catch {
        return {
          ok: false,
          reason: 'receipt-write-failed',
          detail: 'completion receipt path cannot be verified; the plan is not considered consumed',
        };
      }
    }

    let plan: DaemonStateQuarantinePlan | null;
    try {
      plan = parsePlan(readRecord(daemonStateRecoveryPlanPath(input.planId)));
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'plan-missing' : 'plan-unsafe',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!plan || !equalDigest(plan.planDigest, input.planDigest)) {
      return { ok: false, reason: 'plan-tampered', detail: 'persisted plan signature, digest, or shape is invalid' };
    }
    if (!equalDigest(plan.sourcePathSha256, sha256Bytes(resolve(daemonStatePath()))) ||
      plan.quarantineFileName !== `${plan.expectedSourceSha256}.${plan.planId}.daemon.json`) {
      return { ok: false, reason: 'plan-tampered', detail: 'persisted plan is not bound to this daemon state path' };
    }
    const signer = signerForRead();
    if (!signer || !equalDigest(signer.keyId, plan.signingKeyId)) {
      return { ok: false, reason: 'plan-tampered', detail: 'recovery signing authority is unavailable or changed' };
    }

    const markerPath = daemonStateRecoveryMarkerPath();
    let marker: RecoveryMarker | null = null;
    let invalidMarkerPresent = false;
    try {
      marker = parseMarker(readPublishedRecord(markerPath));
      if (marker && (marker.planId !== plan.planId || !equalDigest(marker.planDigest, plan.planDigest))) {
        return { ok: false, reason: 'recovery-marker-conflict', detail: 'another or invalid recovery intent is active' };
      }
      invalidMarkerPresent = marker === null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        invalidMarkerPresent = true;
      }
    }

    const initialTimeRefusal = planTimeRefusal(plan, runtime);
    if (initialTimeRefusal) return initialTimeRefusal;
    const quarantinePath = daemonStateQuarantinePath(plan.quarantineFileName);
    let source: StableSource | null = null;
    let resumed = false;
    try {
      source = stableRead(daemonStatePath(), true, [1n, 2n]);
    } catch (error) {
      let quarantineEntryPresent = false;
      try { quarantineEntryPresent = pathEntryExists(quarantinePath); } catch { /* reported as unsafe source state below */ }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !marker || !quarantineEntryPresent) {
        return {
          ok: false,
          reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'source-missing' : 'source-unsafe',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      resumed = true;
    }

    let quarantineExists: boolean;
    try {
      quarantineExists = pathEntryExists(quarantinePath);
    } catch (error) {
      return { ok: false, reason: 'unsafe-recovery-storage', detail: error instanceof Error ? error.message : String(error) };
    }
    if (invalidMarkerPresent) {
      if (!source || quarantineExists) {
        return { ok: false, reason: 'recovery-marker-conflict', detail: 'recovery intent cannot be authenticated safely' };
      }
      try {
        retirePrivateRecord(markerPath, 'partial-marker', plan.planId);
      } catch {
        return { ok: false, reason: 'recovery-marker-conflict', detail: 'recovery intent cannot be authenticated safely' };
      }
      invalidMarkerPresent = false;
    }

    let linkedQuarantine: { source: StableSource; evidence: StableSource } | null = null;
    if (marker && source && quarantineExists) {
      try {
        linkedQuarantine = readAuthenticatedLinkedQuarantine(daemonStatePath(), quarantinePath, plan);
      } catch {
        linkedQuarantine = null;
      }
      if (!linkedQuarantine) {
        return {
          ok: false,
          reason: 'quarantine-destination-conflict',
          detail: 'live source and quarantine evidence are not the same authenticated planned inode',
        };
      }
      source = linkedQuarantine.source;
      resumed = true;
    }

    if (source) {
      const invalid = validateSource(source, plan.expectedSourceSha256);
      if (invalid) {
        return invalid;
      }
      const generationMatches = linkedQuarantine
        ? sameRelocatedGeneration(source.stat, plan.sourceGeneration)
        : sameGeneration(source.stat, plan.sourceGeneration);
      if (source.size !== plan.sourceSizeBytes || !generationMatches ||
        canonicalizeDaemonActivationValue([...source.issueCodes].sort()) !==
          canonicalizeDaemonActivationValue(plan.issueCodes)) {
        return { ok: false, reason: 'source-drift', detail: 'source generation or metadata no longer matches the dry-run plan' };
      }
    }

    if (!marker && quarantineExists) {
      return {
        ok: false,
        reason: 'quarantine-destination-conflict',
        detail: 'quarantine destination exists without this plan intent',
      };
    }
    const serviceBefore = serviceRefusal(runtime);
    if (serviceBefore) {
      return serviceBefore;
    }
    const daemonLockResult = acquireDaemonLock();
    if (!daemonLockResult.acquired) {
      return { ok: false, reason: 'daemon-lock-unavailable', detail: daemonLockResult.reason };
    }
    daemonLock = daemonLockResult.lock;
    if (resumed) {
      const resumedRecoveryLockOwned = ownsLocalStoreLock(lock);
      const resumedDaemonLockOwned = resumedRecoveryLockOwned && heartbeatDaemonLock(daemonLock);
      if (!resumedRecoveryLockOwned || !resumedDaemonLockOwned) {
        return {
          ok: false,
          reason: !resumedRecoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
          detail: 'lock ownership was lost while resuming sealed quarantine evidence',
        };
      }
    }

    if (source && !linkedQuarantine) {
      try {
        runtime.beforeQuarantine?.();
      } catch (error) {
        return { ok: false, reason: 'source-drift', detail: error instanceof Error ? error.message : String(error) };
      }
      let finalSource: StableSource;
      try { finalSource = stableRead(daemonStatePath(), true); } catch (error) {
        return { ok: false, reason: 'source-drift', detail: error instanceof Error ? error.message : String(error) };
      }
      const finalInvalid = validateSource(finalSource, plan.expectedSourceSha256);
      if (finalInvalid) {
        return finalInvalid;
      }
      if (finalSource.size !== plan.sourceSizeBytes || !sameGeneration(finalSource.stat, plan.sourceGeneration)) {
        return { ok: false, reason: 'source-drift', detail: 'source filesystem generation changed after authorization' };
      }
      const finalService = serviceRefusal(runtime);
      if (finalService) {
        return finalService;
      }
      if (!ownsLocalStoreLock(lock)) {
        return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock ownership was lost before mutation' };
      }
      if (!heartbeatDaemonLock(daemonLock)) {
        return { ok: false, reason: 'daemon-lock-unavailable', detail: 'daemon lock ownership was lost before mutation' };
      }
      try {
        ensurePrivateDirectory(dirname(quarantinePath));
      } catch (error) {
        return { ok: false, reason: 'unsafe-recovery-storage', detail: error instanceof Error ? error.message : String(error) };
      }
      if (pathEntryExists(quarantinePath)) {
        return { ok: false, reason: 'quarantine-destination-conflict', detail: 'quarantine destination appeared before mutation' };
      }
      let quarantineParent: BigIntStats;
      let sourceParent: BigIntStats;
      let preparedEvidence: { publish: () => void } | null = null;
      try {
        quarantineParent = lstatSync(dirname(quarantinePath), { bigint: true });
        sourceParent = lstatSync(dirname(daemonStatePath()), { bigint: true });
        if (!safePrivateDirectory(quarantineParent) || !safePrivateDirectory(sourceParent)) {
          throw new Error('unsafe-evidence-parent');
        }
        preparedEvidence = runtime.prepareAtomicQuarantineEvidence?.({
          sourcePath: daemonStatePath(),
          quarantinePath,
          expectedSourceSha256: plan.expectedSourceSha256,
          expectedSourceGeneration: plan.sourceGeneration,
        }) ?? null;
      } catch (error) {
        return { ok: false, reason: 'unsafe-recovery-storage', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!preparedEvidence) {
        try {
          const unavailableSource = stableRead(daemonStatePath(), true);
          if (!sameGeneration(unavailableSource.stat, plan.sourceGeneration) ||
            !equalDigest(unavailableSource.sha256, plan.expectedSourceSha256)) {
            return { ok: false, reason: 'source-drift', detail: 'source changed while preparing quarantine evidence' };
          }
        } catch (error) {
          return { ok: false, reason: 'source-drift', detail: error instanceof Error ? error.message : String(error) };
        }
        return {
          ok: false,
          reason: 'atomic-evidence-unavailable',
          detail: 'runtime has no durable atomic quarantine-evidence capability; source was preserved and no recovery marker was published',
        };
      }

      const markerTimeRefusal = planTimeRefusal(plan, runtime);
      if (markerTimeRefusal) return markerTimeRefusal;

      if (!marker) {
        marker = buildMarker(plan, signer);
        try {
          const markerTempPath = prepareMarkerTemp(markerPath, plan, marker);
          runtime.beforeMarkerPublish?.();
          const markerPublishRecoveryLockOwned = ownsLocalStoreLock(lock);
          const markerPublishDaemonLockOwned = markerPublishRecoveryLockOwned && heartbeatDaemonLock(daemonLock);
          if (!markerPublishRecoveryLockOwned || !markerPublishDaemonLockOwned) {
            return {
              ok: false,
              reason: !markerPublishRecoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
              detail: 'lock ownership was lost before recovery marker publication; private temp was left uncommitted',
            };
          }
          const markerPublishTimeRefusal = planTimeRefusal(plan, runtime);
          if (markerPublishTimeRefusal) return markerPublishTimeRefusal;
          publishRecordNoClobber(markerTempPath, markerPath);
          const publishedMarker = parseMarker(readPublishedRecord(markerPath));
          if (!publishedMarker || !equalDigest(publishedMarker.markerDigest, marker.markerDigest)) {
            return { ok: false, reason: 'recovery-marker-conflict', detail: 'published recovery marker could not be authenticated exactly' };
          }
        } catch (error) {
          return { ok: false, reason: 'recovery-marker-conflict', detail: error instanceof Error ? error.message : String(error) };
        }
      }

      const recoveryLockOwned = ownsLocalStoreLock(lock);
      const daemonLockOwned = recoveryLockOwned && heartbeatDaemonLock(daemonLock);
      if (!recoveryLockOwned || !daemonLockOwned) {
        return {
          ok: false,
          reason: !recoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
          detail: 'lock ownership was lost immediately before evidence publication',
        };
      }
      try {
        runtime.afterIntent?.();
      } catch (error) {
        return { ok: false, reason: 'quarantine-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const evidenceRecoveryLockOwned = ownsLocalStoreLock(lock);
      const evidenceDaemonLockOwned = evidenceRecoveryLockOwned && heartbeatDaemonLock(daemonLock);
      if (!evidenceRecoveryLockOwned || !evidenceDaemonLockOwned) {
        return {
          ok: false,
          reason: !evidenceRecoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
          detail: 'lock ownership was lost at evidence publication',
        };
      }
      const evidenceTimeRefusal = planTimeRefusal(plan, runtime);
      if (evidenceTimeRefusal) return evidenceTimeRefusal;
      let immediateSource: StableSource;
      try {
        immediateSource = stableRead(daemonStatePath(), true);
        const immediateInvalid = validateSource(immediateSource, plan.expectedSourceSha256);
        if (immediateInvalid) return immediateInvalid;
        if (immediateSource.size !== plan.sourceSizeBytes ||
          !sameGeneration(immediateSource.stat, plan.sourceGeneration)) {
          return { ok: false, reason: 'source-drift', detail: 'source filesystem generation changed at evidence publication' };
        }
        const currentMarker = parseMarker(readPublishedRecord(markerPath));
        if (!currentMarker || !equalDigest(currentMarker.markerDigest, marker.markerDigest)) {
          return { ok: false, reason: 'recovery-marker-conflict', detail: 'recovery marker changed before evidence publication' };
        }
        const immediateRelocationTimeRefusal = planTimeRefusal(plan, runtime);
        if (immediateRelocationTimeRefusal) return immediateRelocationTimeRefusal;
        if (pathEntryExists(quarantinePath)) {
          return {
            ok: false,
            reason: 'quarantine-destination-conflict',
            detail: 'quarantine destination appeared before evidence publication',
          };
        }
        if (!samePrivateDirectoryIdentity(dirname(daemonStatePath()), sourceParent) ||
          !samePrivateDirectoryIdentity(dirname(quarantinePath), quarantineParent)) {
          return {
            ok: false,
            reason: 'unsafe-recovery-storage',
            detail: 'source or quarantine parent identity changed before evidence publication',
          };
        }
        preparedEvidence.publish();
        fsyncDirectory(dirname(quarantinePath));
        linkedQuarantine = readAuthenticatedLinkedQuarantine(daemonStatePath(), quarantinePath, plan);
        if (!linkedQuarantine) throw new Error('published quarantine evidence is not the planned source inode');
        source = linkedQuarantine.source;
      } catch (error) {
        return { ok: false, reason: 'quarantine-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      try {
        if (!samePrivateDirectoryIdentity(dirname(daemonStatePath()), sourceParent) ||
          !samePrivateDirectoryIdentity(dirname(quarantinePath), quarantineParent)) {
          return {
            ok: false,
            reason: 'unsafe-recovery-storage',
            detail: 'source or quarantine parent identity changed during evidence publication',
          };
        }
        linkedQuarantine = readAuthenticatedLinkedQuarantine(daemonStatePath(), quarantinePath, plan);
        if (!linkedQuarantine) {
          return {
            ok: false,
            reason: 'quarantine-failed',
            detail: 'prepared evidence publication did not seal the exact live source inode',
          };
        }
        quarantineExists = true;
      } catch (error) {
        return { ok: false, reason: 'quarantine-failed', detail: error instanceof Error ? error.message : String(error) };
      }
    }

    if (!marker) {
      return { ok: false, reason: 'quarantine-failed', detail: 'authenticated recovery intent is missing after evidence publication' };
    }
    let preserved: StableSource;
    try { preserved = stableRead(quarantinePath, false, [1n, 2n]); } catch (error) {
      return { ok: false, reason: 'quarantine-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!sameRelocatedGeneration(preserved.stat, plan.sourceGeneration) ||
      !equalDigest(preserved.sha256, plan.expectedSourceSha256) || preserved.size !== plan.sourceSizeBytes) {
      return { ok: false, reason: 'quarantine-failed', detail: 'quarantined evidence does not match the authenticated source generation' };
    }
    try {
      linkedQuarantine = readAuthenticatedLinkedQuarantine(daemonStatePath(), quarantinePath, plan);
    } catch {
      linkedQuarantine = null;
    }
    if (!linkedQuarantine) {
      return { ok: false, reason: 'quarantine-failed', detail: 'source and quarantine evidence are not the authenticated linked inode' };
    }
    try {
      const currentMarker = parseMarker(readPublishedRecord(markerPath));
      if (!currentMarker || !equalDigest(currentMarker.markerDigest, marker.markerDigest)) {
        return { ok: false, reason: 'recovery-marker-conflict', detail: 'recovery marker changed after evidence publication' };
      }
      runtime.afterQuarantine?.();
    } catch (error) {
      return { ok: false, reason: 'quarantine-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    const serviceBeforeReceipt = serviceRefusal(runtime);
    if (serviceBeforeReceipt) return serviceBeforeReceipt;
    try {
      runtime.beforeTerminalWrite?.();
    } catch (error) {
      return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    const terminalRecoveryLockOwned = ownsLocalStoreLock(lock);
    const terminalDaemonLockOwned = terminalRecoveryLockOwned && heartbeatDaemonLock(daemonLock);
    if (!terminalRecoveryLockOwned || !terminalDaemonLockOwned) {
      return {
        ok: false,
        reason: !terminalRecoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
        detail: 'lock ownership was lost before terminal receipt staging',
      };
    }
    const terminalTimeRefusal = planTimeRefusal(plan, runtime);
    if (terminalTimeRefusal) return terminalTimeRefusal;

    const receiptNow = runtime.now?.() ?? new Date();
    const receiptTimestampRefusal = planTimeRefusal(plan, runtime, receiptNow);
    if (receiptTimestampRefusal) return receiptTimestampRefusal;
    const unsignedReceipt: Omit<DaemonStateQuarantineReceipt, 'receiptDigest' | 'signature'> = {
      schemaVersion: 1,
      kind: 'daemon-state-quarantine-receipt',
      planId: plan.planId,
      planDigest: plan.planDigest,
      previousDigest: marker.markerDigest,
      completedAt: receiptNow.toISOString(),
      operation: 'quarantine',
      sourceSha256: plan.expectedSourceSha256,
      sourceSizeBytes: plan.sourceSizeBytes,
      quarantineFileName: plan.quarantineFileName,
      quarantineSha256: preserved.sha256,
      sourceBytesPreserved: true,
      daemonStateBlockedPendingResolution: true,
      operatorAuthorizationPresented: true,
      operatorIdentityAuthenticated: false,
      serviceMutationPerformed: false,
      serviceStartPerformed: false,
      serviceRestartPerformed: false,
      serviceInstallPerformed: false,
      signingKeyId: signer.keyId,
      signatureAlgorithm: SIGNATURE_ALGORITHM,
    };
    const unsignedSignedReceipt: Omit<DaemonStateQuarantineReceipt, 'signature'> = {
      ...unsignedReceipt,
      receiptDigest: domainDigest(RECEIPT_DOMAIN, unsignedReceipt),
    };
    const receipt: DaemonStateQuarantineReceipt = {
      ...unsignedSignedReceipt,
      signature: keyedSignature(RECEIPT_DOMAIN, unsignedSignedReceipt, signer),
    };
    let receiptTempPath: string;
    try {
      receiptTempPath = prepareReceiptTemp(receiptPath, plan, receipt);
    } catch (error) {
      return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    try {
      runtime.beforeReceiptPublish?.();
    } catch (error) {
      return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    const publishRecoveryLockOwned = ownsLocalStoreLock(lock);
    const publishDaemonLockOwned = publishRecoveryLockOwned && heartbeatDaemonLock(daemonLock);
    if (!publishRecoveryLockOwned || !publishDaemonLockOwned) {
      return {
        ok: false,
        reason: !publishRecoveryLockOwned ? 'recovery-lock-unavailable' : 'daemon-lock-unavailable',
        detail: 'lock ownership was lost before terminal receipt publication; private temp was left uncommitted',
      };
    }
    const serviceAtPublish = serviceRefusal(runtime);
    if (serviceAtPublish) return serviceAtPublish;
    const publishTimeRefusal = planTimeRefusal(plan, runtime);
    if (publishTimeRefusal) return publishTimeRefusal;
    try {
      const finalLinkedQuarantine = readAuthenticatedLinkedQuarantine(daemonStatePath(), quarantinePath, plan);
      if (!finalLinkedQuarantine) {
        return { ok: false, reason: 'quarantine-failed', detail: 'linked quarantine seal changed before receipt publication' };
      }
      const finalPreserved = stableRead(quarantinePath, false, [1n, 2n]);
      if (!sameRelocatedGeneration(finalPreserved.stat, plan.sourceGeneration) ||
        !equalDigest(finalPreserved.sha256, plan.expectedSourceSha256) ||
        finalPreserved.size !== plan.sourceSizeBytes) {
        return { ok: false, reason: 'quarantine-failed', detail: 'quarantined evidence changed before receipt publication' };
      }
      const immediatePublishTimeRefusal = planTimeRefusal(plan, runtime);
      if (immediatePublishTimeRefusal) return immediatePublishTimeRefusal;
      publishRecordNoClobber(receiptTempPath, receiptPath);
      const published = parseReceipt(readPublishedRecord(receiptPath));
      if (!published || !equalDigest(published.receiptDigest, receipt.receiptDigest)) {
        return { ok: false, reason: 'receipt-write-failed', detail: 'published receipt could not be authenticated exactly' };
      }
    } catch (error) {
      return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, receipt, receiptPath, quarantinePath, resumed };
  } finally {
    if (daemonLock) releaseDaemonLock(daemonLock);
    releaseLocalStoreLock(lock);
  }
}

interface DerivedDaemonAccounting {
  schemaVersion: 1;
  kind: 'daemon-state-resolution-accounting';
  budgetDay: string;
  configuredDailyBudgetUsd: number;
  sourceBudgetDay: string | null;
  sourceSpentUsd: number | null;
  sourceAccounting: 'absent' | 'valid' | 'malformed';
  disposition: 'same-day-exhausted' | 'prior-day-reset' | 'ambiguous-exhausted';
  resolvedSpentUsd: number;
  budgetExhausted: boolean;
}

interface SupervisorObservation {
  schemaVersion: 1;
  kind: 'daemon-state-resolution-supervisor-observation';
  platformSpec: 'launchd' | 'systemd' | 'schtasks';
  registrationState: 'absent';
  runtimeState: 'stopped';
  installed: false;
  running: false;
  activationState: 'absent';
  keepAliveOrRestartPolicy: 'absent';
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalizeDaemonActivationValue(value)}\n`, 'utf8');
}

function canonicalBudgetDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sourceAccountingDisposition(
  row: Record<string, unknown>,
  sourceBudgetDay: string | null,
): DerivedDaemonAccounting['sourceAccounting'] {
  const value = row['spendGuardAccounting'];
  if (value === undefined) return 'absent';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'malformed';
  const accounting = value as Record<string, unknown>;
  const keys = Object.keys(accounting).sort();
  const allowed = accounting['budgetExhausted'] === undefined
    ? ['accountingId', 'budgetDay']
    : ['accountingId', 'budgetDay', 'budgetExhausted'];
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]) &&
    sourceBudgetDay !== null && accounting['budgetDay'] === sourceBudgetDay &&
    UUID_RE.test(String(accounting['accountingId'])) &&
    (accounting['budgetExhausted'] === undefined || typeof accounting['budgetExhausted'] === 'boolean')
    ? 'valid'
    : 'malformed';
}

function deriveDaemonAccounting(
  sourceBytes: Buffer,
  planId: string,
  observedNow: Date,
  configuredDailyBudgetUsd: number,
): { accounting: DerivedDaemonAccounting; accountingBytes: Buffer; stateBytes: Buffer } {
  if (!Number.isFinite(configuredDailyBudgetUsd) || configuredDailyBudgetUsd <= 0) {
    throw new Error('configured daemon daily budget is unavailable or invalid');
  }
  const budgetDay = observedNow.toISOString().slice(0, 10);
  let sourceBudgetDay: string | null = null;
  let sourceSpentUsd: number | null = null;
  let sourceAccounting: DerivedDaemonAccounting['sourceAccounting'] = 'malformed';
  try {
    const decoded = JSON.parse(sourceBytes.toString('utf8')) as unknown;
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      const row = decoded as Record<string, unknown>;
      sourceBudgetDay = canonicalBudgetDay(row['todayDate']) ? row['todayDate'] : null;
      sourceSpentUsd = typeof row['todaySpentUsd'] === 'number' &&
        Number.isFinite(row['todaySpentUsd']) && row['todaySpentUsd'] >= 0
        ? row['todaySpentUsd']
        : null;
      sourceAccounting = sourceAccountingDisposition(row, sourceBudgetDay);
    }
  } catch {
    // Ambiguous source authority is represented by an exhausted current day.
  }

  const provenPriorDay = sourceBudgetDay !== null && sourceBudgetDay < budgetDay &&
    sourceSpentUsd !== null && sourceAccounting !== 'malformed';
  const provenSameDay = sourceBudgetDay === budgetDay && sourceSpentUsd !== null;
  const disposition: DerivedDaemonAccounting['disposition'] = provenSameDay
    ? 'same-day-exhausted'
    : provenPriorDay
      ? 'prior-day-reset'
      : 'ambiguous-exhausted';
  const budgetExhausted = disposition !== 'prior-day-reset';
  const resolvedSpentUsd = budgetExhausted
    ? Math.max(sourceSpentUsd ?? 0, configuredDailyBudgetUsd)
    : 0;
  const accounting: DerivedDaemonAccounting = {
    schemaVersion: 1,
    kind: 'daemon-state-resolution-accounting',
    budgetDay,
    configuredDailyBudgetUsd,
    sourceBudgetDay,
    sourceSpentUsd,
    sourceAccounting,
    disposition,
    resolvedSpentUsd,
    budgetExhausted,
  };
  const state: DaemonState = {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: budgetDay,
    todaySpentUsd: resolvedSpentUsd,
    itemsProcessed: 0,
    ...(budgetExhausted ? {
      spendGuardAccounting: {
        budgetDay,
        accountingId: planId,
        budgetExhausted: true,
      },
    } : {}),
    ticks: [],
  };
  return { accounting, accountingBytes: canonicalBytes(accounting), stateBytes: canonicalBytes(state) };
}

function observeAbsentSupervisor(runtime: DaemonStateResolutionRuntime): SupervisorObservation | DaemonStateRecoveryFailure {
  let status: ServiceStatusResult;
  try {
    status = runtime.serviceStatus();
  } catch (error) {
    return { ok: false, reason: 'service-state-unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  if (status.registrationState === 'unknown' || status.platformSpec === 'unknown' ||
    status.runtimeState === undefined || status.runtimeState === 'unknown') {
    return { ok: false, reason: 'service-state-unknown', detail: 'supervisor registration or runtime state is unknown' };
  }
  if (serviceActivity(status) !== 'inactive') {
    return { ok: false, reason: 'service-active', detail: `service activity is ${serviceActivity(status)}` };
  }
  if (status.registrationState !== 'absent' || status.installed || status.runtimeState !== 'stopped') {
    return {
      ok: false,
      reason: 'supervisor-registered',
      detail: 'resident supervisor registration, activation, or restart authority is still present',
    };
  }
  return {
    schemaVersion: 1,
    kind: 'daemon-state-resolution-supervisor-observation',
    platformSpec: status.platformSpec,
    registrationState: 'absent',
    runtimeState: 'stopped',
    installed: false,
    running: false,
    activationState: 'absent',
    keepAliveOrRestartPolicy: 'absent',
  };
}

function validSupervisorObservation(value: unknown): value is SupervisorObservation {
  return canonicalizeDaemonActivationValue(value) === canonicalizeDaemonActivationValue({
    schemaVersion: 1,
    kind: 'daemon-state-resolution-supervisor-observation',
    platformSpec: (value as Partial<SupervisorObservation> | null)?.platformSpec,
    registrationState: 'absent',
    runtimeState: 'stopped',
    installed: false,
    running: false,
    activationState: 'absent',
    keepAliveOrRestartPolicy: 'absent',
  }) && ['launchd', 'systemd', 'schtasks'].includes(
    String((value as Partial<SupervisorObservation> | null)?.platformSpec),
  );
}

function resolutionPlanDigestPayload(
  plan: DaemonStateResolutionPlan,
): Omit<DaemonStateResolutionPlan, 'planDigest' | 'signature'> {
  const { planDigest: _planDigest, signature: _signature, ...unsigned } = plan;
  return unsigned;
}

function resolutionPlanSignaturePayload(
  plan: DaemonStateResolutionPlan,
): Omit<DaemonStateResolutionPlan, 'signature'> {
  const { signature: _signature, ...unsigned } = plan;
  return unsigned;
}

function resolutionIntentDigestPayload(
  intent: DaemonStateResolutionIntent,
): Omit<DaemonStateResolutionIntent, 'intentDigest' | 'signature'> {
  const { intentDigest: _intentDigest, signature: _signature, ...unsigned } = intent;
  return unsigned;
}

function resolutionIntentSignaturePayload(
  intent: DaemonStateResolutionIntent,
): Omit<DaemonStateResolutionIntent, 'signature'> {
  const { signature: _signature, ...unsigned } = intent;
  return unsigned;
}

function resolutionReceiptDigestPayload(
  receipt: DaemonStateResolutionReceipt,
): Omit<DaemonStateResolutionReceipt, 'receiptDigest' | 'signature'> {
  const { receiptDigest: _receiptDigest, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function resolutionReceiptSignaturePayload(
  receipt: DaemonStateResolutionReceipt,
): Omit<DaemonStateResolutionReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function canonicalFreshStateBinding(
  planId: unknown,
  accountingBase64: unknown,
  accountingDigest: unknown,
  accountingSize: unknown,
  base64: unknown,
  digest: unknown,
  size: unknown,
): boolean {
  if (typeof planId !== 'string' || !UUID_RE.test(planId) ||
    typeof accountingBase64 !== 'string' || typeof accountingDigest !== 'string' ||
    !SHA256_RE.test(accountingDigest) || !Number.isSafeInteger(accountingSize) || Number(accountingSize) < 1 ||
    typeof base64 !== 'string' || typeof digest !== 'string' || !SHA256_RE.test(digest) ||
    !Number.isSafeInteger(size) || Number(size) < 1) return false;
  const accountingBytes = Buffer.from(accountingBase64, 'base64');
  if (accountingBytes.toString('base64') !== accountingBase64 || Number(accountingSize) !== accountingBytes.length ||
    !equalDigest(accountingDigest, sha256Bytes(accountingBytes))) return false;
  let accounting: DerivedDaemonAccounting;
  try {
    accounting = JSON.parse(accountingBytes.toString('utf8')) as DerivedDaemonAccounting;
  } catch {
    return false;
  }
  const accountingKeys = [
    'budgetDay', 'budgetExhausted', 'configuredDailyBudgetUsd', 'disposition', 'kind', 'resolvedSpentUsd',
    'schemaVersion', 'sourceAccounting', 'sourceBudgetDay', 'sourceSpentUsd',
  ].sort();
  if (typeof accounting !== 'object' || accounting === null || Array.isArray(accounting) ||
    Object.keys(accounting).sort().join('\0') !== accountingKeys.join('\0') || accounting.schemaVersion !== 1 ||
    accounting.kind !== 'daemon-state-resolution-accounting' || !canonicalBudgetDay(accounting.budgetDay) ||
    !Number.isFinite(accounting.configuredDailyBudgetUsd) || accounting.configuredDailyBudgetUsd <= 0 ||
    !(accounting.sourceBudgetDay === null || canonicalBudgetDay(accounting.sourceBudgetDay)) ||
    !(accounting.sourceSpentUsd === null ||
      (Number.isFinite(accounting.sourceSpentUsd) && accounting.sourceSpentUsd >= 0)) ||
    !['absent', 'valid', 'malformed'].includes(accounting.sourceAccounting) ||
    !['same-day-exhausted', 'prior-day-reset', 'ambiguous-exhausted'].includes(accounting.disposition) ||
    !Number.isFinite(accounting.resolvedSpentUsd) || accounting.resolvedSpentUsd < 0 ||
    accounting.budgetExhausted !== (accounting.disposition !== 'prior-day-reset') ||
    (accounting.budgetExhausted && accounting.resolvedSpentUsd < accounting.configuredDailyBudgetUsd) ||
    (!accounting.budgetExhausted && accounting.resolvedSpentUsd !== 0) ||
    !canonicalBytes(accounting).equals(accountingBytes)) return false;
  const expectedState: DaemonState = {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: accounting.budgetDay,
    todaySpentUsd: accounting.resolvedSpentUsd,
    itemsProcessed: 0,
    ...(accounting.budgetExhausted ? {
      spendGuardAccounting: {
        budgetDay: accounting.budgetDay,
        accountingId: planId,
        budgetExhausted: true,
      },
    } : {}),
    ticks: [],
  };
  const expected = canonicalBytes(expectedState);
  const decoded = Buffer.from(base64, 'base64');
  return decoded.toString('base64') === base64 && decoded.equals(expected) &&
    Number(size) === expected.length && equalDigest(digest, sha256Bytes(expected));
}

function canonicalSupervisorBinding(base64: unknown, digest: unknown, size: unknown): boolean {
  if (typeof base64 !== 'string' || typeof digest !== 'string' || !SHA256_RE.test(digest) ||
    !Number.isSafeInteger(size) || Number(size) < 1) return false;
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.toString('base64') !== base64 || Number(size) !== decoded.length ||
    !equalDigest(digest, sha256Bytes(decoded))) return false;
  try {
    const observation = JSON.parse(decoded.toString('utf8')) as unknown;
    return validSupervisorObservation(observation) && canonicalBytes(observation).equals(decoded);
  } catch {
    return false;
  }
}

function canonicalJsonBinding(base64: unknown, digest: unknown, size: unknown): boolean {
  if (typeof base64 !== 'string' || typeof digest !== 'string' || !SHA256_RE.test(digest) ||
    !Number.isSafeInteger(size) || Number(size) < 1) return false;
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.toString('base64') !== base64 || Number(size) !== decoded.length ||
    !equalDigest(digest, sha256Bytes(decoded))) return false;
  try {
    return canonicalBytes(JSON.parse(decoded.toString('utf8')) as unknown).equals(decoded);
  } catch {
    return false;
  }
}

function resolutionAuthorityValid(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return canonicalizeDaemonActivationValue(value) === canonicalizeDaemonActivationValue({
    dryRunFirst: true,
    operatorAuthorizationRequired: true,
    repeatedAuthorizationRequired: true,
    exactDestinationReplacementAllowed: true,
    quarantineMutationAllowed: false,
    exactMarkerRetirementAllowed: true,
    serviceMutationAllowed: false,
    serviceStartAllowed: false,
    serviceRestartAllowed: false,
    serviceInstallAllowed: false,
  });
}

function parseResolutionPlan(value: unknown): DaemonStateResolutionPlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = [
    'authority', 'createdAt', 'derivedAccountingCanonicalBase64', 'derivedAccountingSha256',
    'derivedAccountingSizeBytes', 'destinationPathSha256', 'expiresAt', 'freshStateCanonicalBase64',
    'freshStateSha256', 'freshStateSizeBytes', 'kind', 'operation', 'planDigest', 'planId',
    'quarantineGeneration', 'quarantineMarkerDigest', 'quarantinePathSha256', 'quarantinePlanDigest',
    'quarantinePlanId', 'quarantineReceiptDigest', 'quarantineSha256', 'quarantineSigningKeyId',
    'quarantineSizeBytes', 'requiredServiceActivity', 'requiredSupervisorRegistration', 'schemaVersion',
    'signature', 'signatureAlgorithm', 'signingKeyId', 'sourceGeneration', 'sourcePathSha256',
    'sourceSha256', 'sourceSizeBytes', 'supervisorObservationCanonicalBase64',
    'supervisorObservationSha256', 'supervisorObservationSizeBytes',
  ].sort();
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-resolution-plan' ||
    row['operation'] !== 'publish-fresh-state' || typeof row['planId'] !== 'string' ||
    !UUID_RE.test(row['planId']) || !validBoundedPlanWindow(row['createdAt'], row['expiresAt']) ||
    typeof row['quarantinePlanId'] !== 'string' || !UUID_RE.test(row['quarantinePlanId']) ||
    !SHA256_RE.test(String(row['quarantinePlanDigest'])) ||
    !SHA256_RE.test(String(row['quarantineReceiptDigest'])) ||
    !SHA256_RE.test(String(row['quarantineMarkerDigest'])) ||
    !SHA256_RE.test(String(row['quarantineSigningKeyId'])) ||
    !SHA256_RE.test(String(row['sourcePathSha256'])) || !validGeneration(row['sourceGeneration']) ||
    !SHA256_RE.test(String(row['sourceSha256'])) ||
    !Number.isSafeInteger(row['sourceSizeBytes']) || Number(row['sourceSizeBytes']) < 1 ||
    !SHA256_RE.test(String(row['quarantinePathSha256'])) || !validGeneration(row['quarantineGeneration']) ||
    !SHA256_RE.test(String(row['quarantineSha256'])) ||
    !Number.isSafeInteger(row['quarantineSizeBytes']) || Number(row['quarantineSizeBytes']) < 1 ||
    !SHA256_RE.test(String(row['destinationPathSha256'])) || row['requiredServiceActivity'] !== 'inactive' ||
    row['requiredSupervisorRegistration'] !== 'absent' ||
    !canonicalFreshStateBinding(
      row['planId'], row['derivedAccountingCanonicalBase64'], row['derivedAccountingSha256'],
      row['derivedAccountingSizeBytes'], row['freshStateCanonicalBase64'], row['freshStateSha256'],
      row['freshStateSizeBytes'],
    ) || !canonicalSupervisorBinding(
      row['supervisorObservationCanonicalBase64'], row['supervisorObservationSha256'],
      row['supervisorObservationSizeBytes'],
    ) || !resolutionAuthorityValid(row['authority']) ||
    !SHA256_RE.test(String(row['planDigest'])) || !SHA256_RE.test(String(row['signingKeyId'])) ||
    row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM || !SHA256_RE.test(String(row['signature']))) return null;
  const plan = value as DaemonStateResolutionPlan;
  return equalDigest(plan.planDigest, domainDigest(RESOLUTION_PLAN_DOMAIN, resolutionPlanDigestPayload(plan))) &&
    authenticResolutionSignature(
      RESOLUTION_PLAN_DOMAIN,
      resolutionPlanSignaturePayload(plan),
      plan.signingKeyId,
      plan.signatureAlgorithm,
      plan.signature,
    ) ? plan : null;
}

function parseResolutionIntent(value: unknown): DaemonStateResolutionIntent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = [
    'authorizedAt', 'derivedAccountingSha256', 'destinationPathSha256', 'exactMarkerRetirementAllowed', 'freshStateSha256',
    'intentDigest', 'kind', 'operation', 'operatorAuthorizationCount', 'planDigest', 'planId',
    'previousDigest', 'quarantineMarkerDigest', 'quarantineReceiptDigest', 'schemaVersion',
    'serviceMutationAllowed', 'signature', 'signatureAlgorithm', 'signingKeyId', 'sourceGeneration',
    'sourceSha256', 'statePublicationAllowed', 'supervisorObservationSha256',
  ].sort();
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-resolution-intent' ||
    row['operation'] !== 'publish-fresh-state' || typeof row['planId'] !== 'string' ||
    !UUID_RE.test(row['planId']) || !SHA256_RE.test(String(row['planDigest'])) ||
    !SHA256_RE.test(String(row['previousDigest'])) || typeof row['authorizedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(String(row['authorizedAt']))) || !validGeneration(row['sourceGeneration']) ||
    !SHA256_RE.test(String(row['sourceSha256'])) ||
    !SHA256_RE.test(String(row['quarantineReceiptDigest'])) ||
    !SHA256_RE.test(String(row['quarantineMarkerDigest'])) ||
    !SHA256_RE.test(String(row['destinationPathSha256'])) ||
    !SHA256_RE.test(String(row['derivedAccountingSha256'])) ||
    !SHA256_RE.test(String(row['freshStateSha256'])) ||
    !SHA256_RE.test(String(row['supervisorObservationSha256'])) || row['operatorAuthorizationCount'] !== 2 ||
    row['statePublicationAllowed'] !== true || row['exactMarkerRetirementAllowed'] !== true ||
    row['serviceMutationAllowed'] !== false || !SHA256_RE.test(String(row['intentDigest'])) ||
    !SHA256_RE.test(String(row['signingKeyId'])) || row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM ||
    !SHA256_RE.test(String(row['signature']))) return null;
  const intent = value as DaemonStateResolutionIntent;
  return equalDigest(intent.intentDigest, domainDigest(RESOLUTION_INTENT_DOMAIN, resolutionIntentDigestPayload(intent))) &&
    authenticResolutionSignature(
      RESOLUTION_INTENT_DOMAIN,
      resolutionIntentSignaturePayload(intent),
      intent.signingKeyId,
      intent.signatureAlgorithm,
      intent.signature,
    ) ? intent : null;
}

function parseResolutionReceipt(value: unknown): DaemonStateResolutionReceipt | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = [
    'completedAt', 'derivedAccountingCanonicalBase64', 'derivedAccountingSha256',
    'derivedAccountingSizeBytes', 'destinationPathSha256', 'freshStateGeneration', 'freshStateSha256',
    'freshStateSizeBytes', 'kind', 'markerRetirementAuthorized', 'operation',
    'operatorAuthorizationCount', 'operatorIdentityAuthenticated', 'planDigest', 'planId',
    'previousDigest', 'quarantineEvidencePreserved', 'quarantineFileName', 'quarantineGeneration',
    'quarantineMarkerDigest', 'quarantinePlanDigest', 'quarantinePlanId', 'quarantineReceiptDigest',
    'quarantineSha256', 'quarantineSizeBytes', 'receiptDigest', 'schemaVersion',
    'serviceInstallPerformed', 'serviceMutationPerformed', 'serviceRestartPerformed',
    'serviceStartPerformed', 'signature', 'signatureAlgorithm', 'signingKeyId', 'sourcePathReplaced',
    'supervisorObservationCanonicalBase64', 'supervisorObservationSha256', 'supervisorObservationSizeBytes',
  ].sort();
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
  if (row['schemaVersion'] !== 1 || row['kind'] !== 'daemon-state-resolution-receipt' ||
    row['operation'] !== 'publish-fresh-state' || typeof row['planId'] !== 'string' ||
    !UUID_RE.test(row['planId']) || !SHA256_RE.test(String(row['planDigest'])) ||
    !SHA256_RE.test(String(row['previousDigest'])) || typeof row['completedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(String(row['completedAt']))) || typeof row['quarantinePlanId'] !== 'string' ||
    !UUID_RE.test(row['quarantinePlanId']) || !SHA256_RE.test(String(row['quarantinePlanDigest'])) ||
    !SHA256_RE.test(String(row['quarantineReceiptDigest'])) ||
    !SHA256_RE.test(String(row['quarantineMarkerDigest'])) ||
    !SHA256_RE.test(String(row['destinationPathSha256'])) ||
    !canonicalJsonBinding(
      row['derivedAccountingCanonicalBase64'], row['derivedAccountingSha256'],
      row['derivedAccountingSizeBytes'],
    ) || !SHA256_RE.test(String(row['freshStateSha256'])) ||
    !Number.isSafeInteger(row['freshStateSizeBytes']) || Number(row['freshStateSizeBytes']) < 1 ||
    !validGeneration(row['freshStateGeneration']) || typeof row['quarantineFileName'] !== 'string' ||
    basename(row['quarantineFileName']) !== row['quarantineFileName'] ||
    !SHA256_RE.test(String(row['quarantineSha256'])) ||
    !Number.isSafeInteger(row['quarantineSizeBytes']) || Number(row['quarantineSizeBytes']) < 1 ||
    !validGeneration(row['quarantineGeneration']) ||
    !canonicalSupervisorBinding(
      row['supervisorObservationCanonicalBase64'], row['supervisorObservationSha256'],
      row['supervisorObservationSizeBytes'],
    ) || row['sourcePathReplaced'] !== true ||
    row['quarantineEvidencePreserved'] !== true || row['markerRetirementAuthorized'] !== true ||
    row['operatorAuthorizationCount'] !== 2 || row['operatorIdentityAuthenticated'] !== false ||
    row['serviceMutationPerformed'] !== false || row['serviceStartPerformed'] !== false ||
    row['serviceRestartPerformed'] !== false || row['serviceInstallPerformed'] !== false ||
    !SHA256_RE.test(String(row['receiptDigest'])) || !SHA256_RE.test(String(row['signingKeyId'])) ||
    row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM || !SHA256_RE.test(String(row['signature']))) return null;
  const receipt = value as DaemonStateResolutionReceipt;
  return equalDigest(
    receipt.receiptDigest,
    domainDigest(RESOLUTION_RECEIPT_DOMAIN, resolutionReceiptDigestPayload(receipt)),
  ) && authenticResolutionSignature(
    RESOLUTION_RECEIPT_DOMAIN,
    resolutionReceiptSignaturePayload(receipt),
    receipt.signingKeyId,
    receipt.signatureAlgorithm,
    receipt.signature,
  ) ? receipt : null;
}

interface AuthenticatedQuarantineChain {
  plan: DaemonStateQuarantinePlan;
  marker: RecoveryMarker;
  receipt: DaemonStateQuarantineReceipt;
  quarantinePath: string;
  evidence: StableSource;
}

function quarantineChainMatches(
  plan: DaemonStateQuarantinePlan,
  marker: RecoveryMarker,
  receipt: DaemonStateQuarantineReceipt,
): boolean {
  return marker.planId === plan.planId && equalDigest(marker.planDigest, plan.planDigest) &&
    equalDigest(marker.expectedSourceSha256, plan.expectedSourceSha256) &&
    marker.quarantineFileName === plan.quarantineFileName &&
    receipt.planId === plan.planId && equalDigest(receipt.planDigest, plan.planDigest) &&
    equalDigest(receipt.previousDigest, marker.markerDigest) &&
    equalDigest(receipt.sourceSha256, plan.expectedSourceSha256) &&
    receipt.sourceSizeBytes === plan.sourceSizeBytes && receipt.quarantineFileName === plan.quarantineFileName &&
    equalDigest(receipt.quarantineSha256, plan.expectedSourceSha256) &&
    plan.signingKeyId === marker.signingKeyId && marker.signingKeyId === receipt.signingKeyId;
}

function readQuarantineChain(
  quarantinePlanId: string,
  quarantineReceiptDigest: string,
  markerPath: string,
  markerLinks: readonly bigint[] = [1n, 2n],
): AuthenticatedQuarantineChain | DaemonStateRecoveryFailure {
  let quarantinePlan: DaemonStateQuarantinePlan | null;
  try {
    quarantinePlan = parsePlan(readRecord(daemonStateRecoveryPlanPath(quarantinePlanId)));
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'quarantine-plan-missing'
        : 'quarantine-plan-tampered',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!quarantinePlan) {
    return { ok: false, reason: 'quarantine-plan-tampered', detail: 'quarantine plan cannot be authenticated' };
  }

  let marker: RecoveryMarker | null;
  try {
    marker = parseMarker(JSON.parse(stableRead(markerPath, false, markerLinks).bytes.toString('utf8')) as unknown);
  } catch (error) {
    return {
      ok: false,
      reason: 'recovery-marker-conflict',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!marker) {
    return { ok: false, reason: 'recovery-marker-conflict', detail: 'quarantine marker cannot be authenticated' };
  }

  let receipt: DaemonStateQuarantineReceipt | null;
  try {
    receipt = parseReceipt(readPublishedRecord(daemonStateRecoveryReceiptPath(quarantinePlanId)));
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'quarantine-receipt-missing'
        : 'quarantine-receipt-tampered',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!receipt || !equalDigest(receipt.receiptDigest, quarantineReceiptDigest) ||
    !quarantineChainMatches(quarantinePlan, marker, receipt)) {
    return {
      ok: false,
      reason: 'quarantine-receipt-tampered',
      detail: 'quarantine plan, marker, and receipt do not form the exact authenticated chain',
    };
  }

  const quarantinePath = daemonStateQuarantinePath(quarantinePlan.quarantineFileName);
  let evidence: StableSource;
  try {
    evidence = stableRead(quarantinePath, false, [1n, 2n]);
  } catch (error) {
    return {
      ok: false,
      reason: 'quarantine-evidence-drift',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!sameRelocatedGeneration(evidence.stat, quarantinePlan.sourceGeneration) ||
    evidence.size !== quarantinePlan.sourceSizeBytes ||
    !equalDigest(evidence.sha256, quarantinePlan.expectedSourceSha256)) {
    return {
      ok: false,
      reason: 'quarantine-evidence-drift',
      detail: 'quarantine evidence is not the authenticated preserved source generation',
    };
  }
  return { plan: quarantinePlan, marker, receipt, quarantinePath, evidence };
}

function resolutionPlanTimeRefusal(
  plan: DaemonStateResolutionPlan,
  runtime: DaemonStateResolutionRuntime,
): DaemonStateRecoveryFailure | null {
  const observed = runtime.now?.() ?? new Date();
  const created = Date.parse(plan.createdAt);
  if (observed.getTime() + MAX_CLOCK_SKEW_MS < created) {
    return { ok: false, reason: 'plan-not-yet-valid', detail: `plan was created at ${plan.createdAt}` };
  }
  return observed.getTime() >= Date.parse(plan.expiresAt)
    ? { ok: false, reason: 'plan-expired', detail: `plan expired at ${plan.expiresAt}` }
    : null;
}

function resolutionLocksRefusal(
  recoveryLock: LocalStoreLock,
  daemonLock: DaemonLock,
  detail: string,
): DaemonStateRecoveryFailure | null {
  const recoveryOwned = ownsLocalStoreLock(recoveryLock);
  const daemonOwned = recoveryOwned && heartbeatDaemonLock(daemonLock);
  if (recoveryOwned && daemonOwned) return null;
  return {
    ok: false,
    reason: recoveryOwned ? 'daemon-lock-unavailable' : 'recovery-lock-unavailable',
    detail,
  };
}

function exactResolutionIntent(
  intent: DaemonStateResolutionIntent,
  plan: DaemonStateResolutionPlan,
): boolean {
  return intent.planId === plan.planId && equalDigest(intent.planDigest, plan.planDigest) &&
    equalDigest(intent.previousDigest, plan.quarantineReceiptDigest) &&
    equalDigest(intent.sourceSha256, plan.sourceSha256) &&
    canonicalizeDaemonActivationValue(intent.sourceGeneration) ===
      canonicalizeDaemonActivationValue(plan.sourceGeneration) &&
    equalDigest(intent.quarantineReceiptDigest, plan.quarantineReceiptDigest) &&
    equalDigest(intent.quarantineMarkerDigest, plan.quarantineMarkerDigest) &&
    equalDigest(intent.destinationPathSha256, plan.destinationPathSha256) &&
    equalDigest(intent.derivedAccountingSha256, plan.derivedAccountingSha256) &&
    equalDigest(intent.freshStateSha256, plan.freshStateSha256) &&
    equalDigest(intent.supervisorObservationSha256, plan.supervisorObservationSha256) &&
    intent.signingKeyId === plan.signingKeyId;
}

function exactResolutionReceipt(
  receipt: DaemonStateResolutionReceipt,
  intent: DaemonStateResolutionIntent,
  plan: DaemonStateResolutionPlan,
): boolean {
  return receipt.planId === plan.planId && equalDigest(receipt.planDigest, plan.planDigest) &&
    equalDigest(receipt.previousDigest, intent.intentDigest) && receipt.quarantinePlanId === plan.quarantinePlanId &&
    equalDigest(receipt.quarantinePlanDigest, plan.quarantinePlanDigest) &&
    equalDigest(receipt.quarantineReceiptDigest, plan.quarantineReceiptDigest) &&
    equalDigest(receipt.quarantineMarkerDigest, plan.quarantineMarkerDigest) &&
    equalDigest(receipt.destinationPathSha256, plan.destinationPathSha256) &&
    receipt.derivedAccountingCanonicalBase64 === plan.derivedAccountingCanonicalBase64 &&
    equalDigest(receipt.derivedAccountingSha256, plan.derivedAccountingSha256) &&
    receipt.derivedAccountingSizeBytes === plan.derivedAccountingSizeBytes &&
    equalDigest(receipt.freshStateSha256, plan.freshStateSha256) &&
    receipt.freshStateSizeBytes === plan.freshStateSizeBytes &&
    receipt.supervisorObservationCanonicalBase64 === plan.supervisorObservationCanonicalBase64 &&
    equalDigest(receipt.supervisorObservationSha256, plan.supervisorObservationSha256) &&
    receipt.supervisorObservationSizeBytes === plan.supervisorObservationSizeBytes &&
    equalDigest(receipt.quarantineSha256, plan.quarantineSha256) &&
    receipt.quarantineSizeBytes === plan.quarantineSizeBytes && receipt.signingKeyId === plan.signingKeyId;
}

function resolutionAccountingRefusal(
  plan: DaemonStateResolutionPlan,
  chain: AuthenticatedQuarantineChain,
  runtime: DaemonStateResolutionRuntime,
): DaemonStateRecoveryFailure | null {
  try {
    const derived = deriveDaemonAccounting(
      chain.evidence.bytes,
      plan.planId,
      runtime.now?.() ?? new Date(),
      runtime.dailyBudgetUsd(),
    );
    if (!derived.accountingBytes.equals(Buffer.from(plan.derivedAccountingCanonicalBase64, 'base64')) ||
      !equalDigest(sha256Bytes(derived.accountingBytes), plan.derivedAccountingSha256) ||
      !derived.stateBytes.equals(Buffer.from(plan.freshStateCanonicalBase64, 'base64')) ||
      !equalDigest(sha256Bytes(derived.stateBytes), plan.freshStateSha256)) {
      return {
        ok: false,
        reason: 'accounting-state-unknown',
        detail: 'budget day, configured budget, or quarantined accounting no longer matches the signed derivation',
      };
    }
    return null;
  } catch (error) {
    return { ok: false, reason: 'accounting-state-unknown', detail: error instanceof Error ? error.message : String(error) };
  }
}

function resolutionSupervisorRefusal(
  plan: DaemonStateResolutionPlan,
  runtime: DaemonStateResolutionRuntime,
): DaemonStateRecoveryFailure | null {
  const observed = observeAbsentSupervisor(runtime);
  if ('ok' in observed) return observed;
  const bytes = canonicalBytes(observed);
  return bytes.equals(Buffer.from(plan.supervisorObservationCanonicalBase64, 'base64')) &&
    equalDigest(sha256Bytes(bytes), plan.supervisorObservationSha256)
    ? null
    : {
        ok: false,
        reason: 'service-state-unknown',
        detail: 'resident supervisor observation changed from the exact signed plan',
      };
}

function resolutionPreconditionsRefusal(
  plan: DaemonStateResolutionPlan,
  chain: AuthenticatedQuarantineChain,
  runtime: DaemonStateResolutionRuntime,
): DaemonStateRecoveryFailure | null {
  return resolutionSupervisorRefusal(plan, runtime) ?? resolutionAccountingRefusal(plan, chain, runtime);
}

function prepareResolutionIntentTemp(
  intentPath: string,
  plan: DaemonStateResolutionPlan,
  intent: DaemonStateResolutionIntent,
): { path: string; intent: DaemonStateResolutionIntent; reused: boolean } {
  const prefix = `.${basename(intentPath)}.${plan.planId}.`;
  let reusable: { path: string; intent: DaemonStateResolutionIntent; reused: true } | undefined;
  ensurePrivateDirectory(dirname(intentPath));
  for (const name of readdirSync(dirname(intentPath)).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = join(dirname(intentPath), name);
    let parsed: DaemonStateResolutionIntent | null = null;
    try {
      parsed = parseResolutionIntent(readRecord(candidate));
    } catch {
      // A torn private stage has no authority and is retained as abandoned evidence.
    }
    if (parsed && exactResolutionIntent(parsed, plan)) {
      if (!reusable) reusable = { path: candidate, intent: parsed, reused: true };
      else retirePrivateRecord(candidate, 'resolution-intent-temp-duplicate', plan.planId);
      continue;
    }
    if (parsed) throw new Error('valid conflicting resolution intent stage exists');
    retirePrivateRecord(candidate, 'resolution-intent-temp', plan.planId);
  }
  return reusable ?? { path: writePrivateRecordTemp(intentPath, plan.planId, intent), intent, reused: false };
}

function resolutionStateTempPath(plan: DaemonStateResolutionPlan): string {
  return join(
    dirname(daemonStatePath()),
    `.${basename(daemonStatePath())}.resolution.${plan.planId}.${plan.freshStateSha256}.tmp`,
  );
}

function prepareResolutionStateTemp(plan: DaemonStateResolutionPlan): string {
  const path = resolutionStateTempPath(plan);
  const expected = Buffer.from(plan.freshStateCanonicalBase64, 'base64');
  if (pathEntryExists(path)) {
    const stat = lstatSync(path, { bigint: true });
    if (safePrivateFile(stat) && stat.size >= 0n && stat.size < BigInt(expected.length)) {
      retirePrivateRecord(path, 'resolution-state-temp-partial', plan.planId);
      writeExclusiveBytes(path, expected);
      const repaired = stableRead(path, false);
      if (repaired.size !== expected.length || !equalDigest(repaired.sha256, plan.freshStateSha256) ||
        !repaired.bytes.equals(expected)) throw new Error('repaired resolution state temp could not be authenticated');
      return path;
    }
    const existing = stableRead(path, false);
    if (existing.size !== expected.length || !equalDigest(existing.sha256, plan.freshStateSha256) ||
      !existing.bytes.equals(expected)) throw new Error('resolution state temp conflicts with the signed plan');
    return path;
  }
  writeExclusiveBytes(path, expected);
  const staged = stableRead(path, false);
  if (staged.size !== expected.length || !equalDigest(staged.sha256, plan.freshStateSha256) ||
    !staged.bytes.equals(expected)) throw new Error('resolution state temp could not be authenticated');
  return path;
}

type ResolutionStatePhase =
  | { phase: 'blocked-source'; state: StableSource }
  | { phase: 'fresh-published'; state: StableSource }
  | DaemonStateRecoveryFailure;

function resolutionStatePhase(
  plan: DaemonStateResolutionPlan,
  chain: AuthenticatedQuarantineChain,
): ResolutionStatePhase {
  let state: StableSource;
  try {
    state = stableRead(daemonStatePath(), false, [1n, 2n]);
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'source-missing' : 'source-unsafe',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (state.stat.dev === chain.evidence.stat.dev && state.stat.ino === chain.evidence.stat.ino &&
    state.stat.nlink === 2n && chain.evidence.stat.nlink === 2n &&
    sameGeneration(state.stat, plan.sourceGeneration) &&
    sameGeneration(chain.evidence.stat, plan.quarantineGeneration) &&
    equalDigest(state.sha256, plan.sourceSha256) && state.size === plan.sourceSizeBytes) {
    return { phase: 'blocked-source', state };
  }
  if (state.stat.nlink === 1n && chain.evidence.stat.nlink === 1n &&
    equalDigest(state.sha256, plan.freshStateSha256) && state.size === plan.freshStateSizeBytes &&
    state.bytes.equals(Buffer.from(plan.freshStateCanonicalBase64, 'base64')) &&
    sameRelocatedGeneration(chain.evidence.stat, plan.quarantineGeneration)) {
    return { phase: 'fresh-published', state };
  }
  return {
    ok: false,
    reason: 'resolution-state-conflict',
    detail: 'daemon state is neither the signed blocked source nor the signed canonical fresh state',
  };
}

export function previewDaemonStateResolution(
  input: { quarantinePlanId: string; quarantineReceiptDigest: string },
  runtime: DaemonStateResolutionRuntime,
): PreviewDaemonStateResolutionResult {
  if (!UUID_RE.test(input.quarantinePlanId)) {
    return { ok: false, reason: 'invalid-quarantine-plan-id', detail: 'invalid quarantine plan id' };
  }
  const expectedReceiptDigest = input.quarantineReceiptDigest.toLowerCase();
  if (!SHA256_RE.test(expectedReceiptDigest)) {
    return {
      ok: false,
      reason: 'invalid-quarantine-receipt-digest',
      detail: 'quarantine receipt SHA-256 must be 64 lowercase hex characters',
    };
  }
  const supervisor = observeAbsentSupervisor(runtime);
  if ('ok' in supervisor) return supervisor;
  const supervisorBytes = canonicalBytes(supervisor);
  const lock = acquireRecoveryLock();
  if (!lock) return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock unavailable' };
  try {
    if (!ownsLocalStoreLock(lock)) {
      return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock ownership was lost' };
    }
    const chain = readQuarantineChain(
      input.quarantinePlanId,
      expectedReceiptDigest,
      daemonStateRecoveryMarkerPath(),
    );
    if ('ok' in chain) return chain;
    let source: StableSource;
    try {
      source = stableRead(daemonStatePath(), false, [2n]);
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'source-missing' : 'source-unsafe',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (source.stat.dev !== chain.evidence.stat.dev || source.stat.ino !== chain.evidence.stat.ino ||
      !sameRelocatedGeneration(source.stat, chain.plan.sourceGeneration) ||
      !sameRelocatedGeneration(chain.evidence.stat, chain.plan.sourceGeneration) ||
      !equalDigest(source.sha256, chain.plan.expectedSourceSha256) ||
      source.size !== chain.plan.sourceSizeBytes) {
      return {
        ok: false,
        reason: 'source-drift',
        detail: 'live daemon state and quarantine evidence are not the exact authenticated linked source inode',
      };
    }
    const finalSupervisor = observeAbsentSupervisor(runtime);
    if ('ok' in finalSupervisor) return finalSupervisor;
    if (!canonicalBytes(finalSupervisor).equals(supervisorBytes)) {
      return { ok: false, reason: 'service-state-unknown', detail: 'supervisor observation changed during preview' };
    }
    if (!ownsLocalStoreLock(lock)) {
      return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock ownership was lost' };
    }

    const planId = (runtime.randomId ?? randomUUID)();
    if (!UUID_RE.test(planId)) {
      return { ok: false, reason: 'plan-write-failed', detail: 'runtime produced an invalid plan id' };
    }
    let signer: RecoverySigner;
    try {
      signer = resolutionSignerForWrite();
    } catch (error) {
      return { ok: false, reason: 'plan-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    const now = runtime.now?.() ?? new Date();
    let derived: ReturnType<typeof deriveDaemonAccounting>;
    try {
      derived = deriveDaemonAccounting(chain.evidence.bytes, planId, now, runtime.dailyBudgetUsd());
    } catch (error) {
      return { ok: false, reason: 'accounting-state-unknown', detail: error instanceof Error ? error.message : String(error) };
    }
    const freshBytes = derived.stateBytes;
    const sourcePathDigest = sha256Bytes(resolve(daemonStatePath()));
    const unsigned: Omit<DaemonStateResolutionPlan, 'planDigest' | 'signature'> = {
      schemaVersion: 1,
      kind: 'daemon-state-resolution-plan',
      planId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
      operation: 'publish-fresh-state',
      quarantinePlanId: chain.plan.planId,
      quarantinePlanDigest: chain.plan.planDigest,
      quarantineReceiptDigest: chain.receipt.receiptDigest,
      quarantineMarkerDigest: chain.marker.markerDigest,
      quarantineSigningKeyId: chain.receipt.signingKeyId,
      sourcePathSha256: sourcePathDigest,
      sourceGeneration: sourceGeneration(source.stat),
      sourceSha256: source.sha256,
      sourceSizeBytes: source.size,
      quarantinePathSha256: sha256Bytes(resolve(chain.quarantinePath)),
      quarantineGeneration: sourceGeneration(chain.evidence.stat),
      quarantineSha256: chain.evidence.sha256,
      quarantineSizeBytes: chain.evidence.size,
      destinationPathSha256: sourcePathDigest,
      derivedAccountingCanonicalBase64: derived.accountingBytes.toString('base64'),
      derivedAccountingSha256: sha256Bytes(derived.accountingBytes),
      derivedAccountingSizeBytes: derived.accountingBytes.length,
      freshStateCanonicalBase64: freshBytes.toString('base64'),
      freshStateSha256: sha256Bytes(freshBytes),
      freshStateSizeBytes: freshBytes.length,
      supervisorObservationCanonicalBase64: supervisorBytes.toString('base64'),
      supervisorObservationSha256: sha256Bytes(supervisorBytes),
      supervisorObservationSizeBytes: supervisorBytes.length,
      requiredServiceActivity: 'inactive',
      requiredSupervisorRegistration: 'absent',
      authority: {
        dryRunFirst: true,
        operatorAuthorizationRequired: true,
        repeatedAuthorizationRequired: true,
        exactDestinationReplacementAllowed: true,
        quarantineMutationAllowed: false,
        exactMarkerRetirementAllowed: true,
        serviceMutationAllowed: false,
        serviceStartAllowed: false,
        serviceRestartAllowed: false,
        serviceInstallAllowed: false,
      },
      signingKeyId: signer.keyId,
      signatureAlgorithm: SIGNATURE_ALGORITHM,
    };
    const unsignedSigned: Omit<DaemonStateResolutionPlan, 'signature'> = {
      ...unsigned,
      planDigest: domainDigest(RESOLUTION_PLAN_DOMAIN, unsigned),
    };
    const plan: DaemonStateResolutionPlan = {
      ...unsignedSigned,
      signature: keyedSignature(RESOLUTION_PLAN_DOMAIN, unsignedSigned, signer),
    };
    const planPath = daemonStateResolutionPlanPath(plan.planId);
    try {
      writeExclusiveRecord(planPath, plan);
    } catch (error) {
      return { ok: false, reason: 'plan-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, plan, planPath };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

export function executeDaemonStateResolution(
  input: { planId: string; planDigest: string; operatorAuthorization: string; operatorConfirmation: string },
  runtime: DaemonStateResolutionRuntime,
): ExecuteDaemonStateResolutionResult {
  if (!UUID_RE.test(input.planId)) return { ok: false, reason: 'invalid-plan-id', detail: 'invalid plan id' };
  if (!SHA256_RE.test(input.planDigest)) {
    return { ok: false, reason: 'invalid-plan-digest', detail: 'invalid plan digest' };
  }
  if (!input.operatorAuthorization || !input.operatorConfirmation) {
    return {
      ok: false,
      reason: 'authorization-required',
      detail: 'two explicit argv authorizations are required',
    };
  }
  if (!equalDigest(input.operatorAuthorization, input.planDigest) ||
    !equalDigest(input.operatorConfirmation, input.planDigest)) {
    return {
      ok: false,
      reason: 'authorization-mismatch',
      detail: 'authorization and confirmation must both equal the exact plan digest',
    };
  }

  let plan: DaemonStateResolutionPlan | null;
  try {
    plan = parseResolutionPlan(readRecord(daemonStateResolutionPlanPath(input.planId)));
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'plan-missing' : 'plan-unsafe',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!plan || !equalDigest(plan.planDigest, input.planDigest)) {
    return { ok: false, reason: 'plan-tampered', detail: 'persisted resolution plan cannot be authenticated exactly' };
  }
  if ((runtime.platform ?? process.platform) === 'win32') {
    return {
      ok: false,
      reason: 'atomic-replacement-unavailable',
      detail: 'Windows resolution execution is disabled until native directory durability is available',
    };
  }
  const destinationPathDigest = sha256Bytes(resolve(daemonStatePath()));
  if (!equalDigest(plan.sourcePathSha256, destinationPathDigest) ||
    !equalDigest(plan.destinationPathSha256, destinationPathDigest)) {
    return { ok: false, reason: 'plan-tampered', detail: 'resolution plan is not bound to this daemon state path' };
  }
  const signer = resolutionSignerForRead();
  if (!signer || !equalDigest(signer.keyId, plan.signingKeyId)) {
    return { ok: false, reason: 'plan-tampered', detail: 'resolution signing authority is unavailable or changed' };
  }

  const recoveryLock = acquireRecoveryLock();
  if (!recoveryLock) {
    return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock unavailable' };
  }
  let daemonLock: DaemonLock | undefined;
  try {
    if (!ownsLocalStoreLock(recoveryLock)) {
      return { ok: false, reason: 'recovery-lock-unavailable', detail: 'recovery lock ownership was lost' };
    }
    const activeMarkerPath = daemonStateRecoveryMarkerPath();
    const retiredMarkerPath = daemonStateResolutionRetiredMarkerPath(plan.planId);
    let activeMarkerPresent: boolean;
    let retiredMarkerPresent: boolean;
    try {
      activeMarkerPresent = pathEntryExists(activeMarkerPath);
      retiredMarkerPresent = pathEntryExists(retiredMarkerPath);
    } catch (error) {
      return { ok: false, reason: 'recovery-marker-conflict', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!activeMarkerPresent && !retiredMarkerPresent) {
      return { ok: false, reason: 'recovery-marker-conflict', detail: 'the exact quarantine marker is unavailable' };
    }
    const markerPath = activeMarkerPresent ? activeMarkerPath : retiredMarkerPath;
    const chain = readQuarantineChain(
      plan.quarantinePlanId,
      plan.quarantineReceiptDigest,
      markerPath,
      activeMarkerPresent && retiredMarkerPresent ? [1n, 2n, 3n] : [1n, 2n],
    );
    if ('ok' in chain) return chain;
    if (!equalDigest(chain.plan.planDigest, plan.quarantinePlanDigest) ||
      !equalDigest(chain.marker.markerDigest, plan.quarantineMarkerDigest) ||
      chain.receipt.signingKeyId !== plan.quarantineSigningKeyId ||
      !equalDigest(chain.plan.expectedSourceSha256, plan.sourceSha256) ||
      chain.plan.sourceSizeBytes !== plan.sourceSizeBytes ||
      !equalDigest(sha256Bytes(resolve(chain.quarantinePath)), plan.quarantinePathSha256) ||
      !equalDigest(chain.evidence.sha256, plan.quarantineSha256) ||
      chain.evidence.size !== plan.quarantineSizeBytes) {
      return {
        ok: false,
        reason: 'quarantine-evidence-drift',
        detail: 'quarantine artifacts no longer match the signed resolution plan',
      };
    }
    const initialPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
    if (initialPreconditions) return initialPreconditions;
    if (activeMarkerPresent && retiredMarkerPresent) {
      try {
        const active = stableRead(activeMarkerPath, false, [1n, 2n, 3n]);
        const retired = stableRead(retiredMarkerPath, false, [1n, 2n, 3n]);
        const parsedRetired = parseMarker(JSON.parse(retired.bytes.toString('utf8')) as unknown);
        if (!parsedRetired || !equalDigest(parsedRetired.markerDigest, plan.quarantineMarkerDigest) ||
          active.stat.dev !== retired.stat.dev || active.stat.ino !== retired.stat.ino) {
          return { ok: false, reason: 'recovery-marker-conflict', detail: 'active and retired marker paths conflict' };
        }
      } catch (error) {
        return { ok: false, reason: 'recovery-marker-conflict', detail: error instanceof Error ? error.message : String(error) };
      }
    }

    let intent: DaemonStateResolutionIntent | null = null;
    let partialIntentPresent = false;
    const intentPath = daemonStateResolutionIntentPath(plan.planId);
    try {
      if (pathEntryExists(intentPath)) {
        try {
          intent = parseResolutionIntent(readPublishedRecord(intentPath));
        } catch {
          partialIntentPresent = true;
        }
        if (intent && !exactResolutionIntent(intent, plan)) {
          return { ok: false, reason: 'resolution-intent-conflict', detail: 'resolution intent cannot be authenticated exactly' };
        }
        if (!intent) partialIntentPresent = true;
      }
    } catch (error) {
      return { ok: false, reason: 'resolution-intent-conflict', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!intent) {
      const timeRefusal = resolutionPlanTimeRefusal(plan, runtime);
      if (timeRefusal) return timeRefusal;
      if (!activeMarkerPresent || retiredMarkerPresent) {
        return { ok: false, reason: 'recovery-marker-conflict', detail: 'marker retirement preceded authorized resolution intent' };
      }
    }

    const preconditionsBeforeLock = resolutionPreconditionsRefusal(plan, chain, runtime);
    if (preconditionsBeforeLock) return preconditionsBeforeLock;
    const daemonLockResult = acquireDaemonLock();
    if (!daemonLockResult.acquired) {
      return { ok: false, reason: 'daemon-lock-unavailable', detail: daemonLockResult.reason };
    }
    daemonLock = daemonLockResult.lock;
    let phase = resolutionStatePhase(plan, chain);
    if ('ok' in phase) return phase;
    if (partialIntentPresent) {
      if (phase.phase !== 'blocked-source' || !activeMarkerPresent || retiredMarkerPresent ||
        pathEntryExists(daemonStateResolutionReceiptPath(plan.planId))) {
        return {
          ok: false,
          reason: 'resolution-intent-conflict',
          detail: 'partial resolution intent cannot be retired after any durable resolution effect',
        };
      }
      try {
        retirePrivateRecord(intentPath, 'partial-resolution-intent', plan.planId);
      } catch (error) {
        return { ok: false, reason: 'resolution-intent-conflict', detail: error instanceof Error ? error.message : String(error) };
      }
    }
    let resumed = intent !== null || partialIntentPresent || phase.phase === 'fresh-published' || retiredMarkerPresent;

    if (!intent) {
      if (phase.phase !== 'blocked-source') {
        return {
          ok: false,
          reason: 'resolution-state-conflict',
          detail: 'fresh state appeared without a signed authorized resolution intent',
        };
      }
      try {
        runtime.beforeIntentPublish?.();
      } catch (error) {
        return { ok: false, reason: 'resolution-intent-conflict', detail: error instanceof Error ? error.message : String(error) };
      }
      const intentLocks = resolutionLocksRefusal(
        recoveryLock,
        daemonLock,
        'lock ownership was lost before resolution intent publication',
      );
      if (intentLocks) return intentLocks;
      const intentPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
      if (intentPreconditions) return intentPreconditions;
      const intentTime = resolutionPlanTimeRefusal(plan, runtime);
      if (intentTime) return intentTime;
      const unsignedIntent: Omit<DaemonStateResolutionIntent, 'intentDigest' | 'signature'> = {
        schemaVersion: 1,
        kind: 'daemon-state-resolution-intent',
        planId: plan.planId,
        planDigest: plan.planDigest,
        previousDigest: plan.quarantineReceiptDigest,
        authorizedAt: (runtime.now?.() ?? new Date()).toISOString(),
        operation: 'publish-fresh-state',
        sourceGeneration: plan.sourceGeneration,
        sourceSha256: plan.sourceSha256,
        quarantineReceiptDigest: plan.quarantineReceiptDigest,
        quarantineMarkerDigest: plan.quarantineMarkerDigest,
        destinationPathSha256: plan.destinationPathSha256,
        derivedAccountingSha256: plan.derivedAccountingSha256,
        freshStateSha256: plan.freshStateSha256,
        supervisorObservationSha256: plan.supervisorObservationSha256,
        operatorAuthorizationCount: 2,
        statePublicationAllowed: true,
        exactMarkerRetirementAllowed: true,
        serviceMutationAllowed: false,
        signingKeyId: signer.keyId,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
      };
      const unsignedSignedIntent: Omit<DaemonStateResolutionIntent, 'signature'> = {
        ...unsignedIntent,
        intentDigest: domainDigest(RESOLUTION_INTENT_DOMAIN, unsignedIntent),
      };
      const proposedIntent: DaemonStateResolutionIntent = {
        ...unsignedSignedIntent,
        signature: keyedSignature(RESOLUTION_INTENT_DOMAIN, unsignedSignedIntent, signer),
      };
      let intentTempPath: string;
      try {
        const stagedIntent = prepareResolutionIntentTemp(intentPath, plan, proposedIntent);
        intentTempPath = stagedIntent.path;
        intent = stagedIntent.intent;
        resumed ||= stagedIntent.reused;
        runtime.afterIntentStage?.();
      } catch (error) {
        return { ok: false, reason: 'resolution-intent-conflict', detail: error instanceof Error ? error.message : String(error) };
      }
      const stagedIntentLocks = resolutionLocksRefusal(
        recoveryLock,
        daemonLock,
        'lock ownership was lost before staged resolution intent publication',
      );
      if (stagedIntentLocks) return stagedIntentLocks;
      const stagedIntentPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
      if (stagedIntentPreconditions) return stagedIntentPreconditions;
      const stagedIntentPhase = resolutionStatePhase(plan, chain);
      if ('ok' in stagedIntentPhase) return stagedIntentPhase;
      if (stagedIntentPhase.phase !== 'blocked-source') {
        return { ok: false, reason: 'resolution-state-conflict', detail: 'state changed before intent publication' };
      }
      const publicationTime = resolutionPlanTimeRefusal(plan, runtime);
      if (publicationTime) return publicationTime;
      try {
        publishRecordNoClobber(intentTempPath, intentPath);
        const publishedIntent = parseResolutionIntent(readPublishedRecord(intentPath));
        if (!publishedIntent || !equalDigest(publishedIntent.intentDigest, intent.intentDigest)) {
          throw new Error('published resolution intent cannot be authenticated exactly');
        }
        intent = publishedIntent;
      } catch (error) {
        return { ok: false, reason: 'resolution-intent-conflict', detail: error instanceof Error ? error.message : String(error) };
      }
    }

    if (phase.phase === 'blocked-source') {
      let stateTempPath: string;
      let destinationParent: BigIntStats;
      let quarantineParent: BigIntStats;
      try {
        destinationParent = lstatSync(dirname(daemonStatePath()), { bigint: true });
        quarantineParent = lstatSync(dirname(chain.quarantinePath), { bigint: true });
        if (!safePrivateDirectory(destinationParent) || !safePrivateDirectory(quarantineParent)) {
          throw new Error('unsafe resolution parent directory');
        }
        stateTempPath = prepareResolutionStateTemp(plan);
        runtime.beforeStatePublish?.();
      } catch (error) {
        return { ok: false, reason: 'state-publication-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const stateLocks = resolutionLocksRefusal(
        recoveryLock,
        daemonLock,
        'lock ownership was lost before fresh state publication',
      );
      if (stateLocks) return stateLocks;
      const statePreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
      if (statePreconditions) return statePreconditions;
      if (!samePrivateDirectoryIdentity(dirname(daemonStatePath()), destinationParent) ||
        !samePrivateDirectoryIdentity(dirname(chain.quarantinePath), quarantineParent)) {
        return {
          ok: false,
          reason: 'unsafe-recovery-storage',
          detail: 'destination or quarantine parent changed before fresh state publication',
        };
      }
      const immediateChain = readQuarantineChain(
        plan.quarantinePlanId,
        plan.quarantineReceiptDigest,
        activeMarkerPath,
        [1n, 2n],
      );
      if ('ok' in immediateChain) return immediateChain;
      const immediatePhase = resolutionStatePhase(plan, immediateChain);
      if ('ok' in immediatePhase) return immediatePhase;
      if (immediatePhase.phase !== 'blocked-source' || retiredMarkerPresent) {
        return { ok: false, reason: 'resolution-state-conflict', detail: 'resolution state changed before publication' };
      }
      try {
        renameSync(stateTempPath, daemonStatePath());
        fsyncDirectory(dirname(daemonStatePath()));
        fsyncDirectory(dirname(chain.quarantinePath));
      } catch (error) {
        return { ok: false, reason: 'state-publication-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const publishedChain = readQuarantineChain(
        plan.quarantinePlanId,
        plan.quarantineReceiptDigest,
        activeMarkerPath,
        [1n, 2n],
      );
      if ('ok' in publishedChain) return publishedChain;
      phase = resolutionStatePhase(plan, publishedChain);
      if ('ok' in phase) return phase;
      if (phase.phase !== 'fresh-published') {
        return { ok: false, reason: 'state-publication-failed', detail: 'canonical fresh state was not durably published' };
      }
      try {
        runtime.afterStatePublish?.();
      } catch (error) {
        return { ok: false, reason: 'state-publication-failed', detail: error instanceof Error ? error.message : String(error) };
      }
    }

    if (phase.phase !== 'fresh-published') {
      return { ok: false, reason: 'state-publication-failed', detail: 'canonical fresh state is not published' };
    }
    let receipt: DaemonStateResolutionReceipt | null = null;
    const receiptPath = daemonStateResolutionReceiptPath(plan.planId);
    try {
      if (pathEntryExists(receiptPath)) {
        receipt = parseResolutionReceipt(readPublishedRecord(receiptPath));
        if (!receipt || !exactResolutionReceipt(receipt, intent, plan) ||
          !sameGeneration(phase.state.stat, receipt.freshStateGeneration) ||
          !sameGeneration(chain.evidence.stat, receipt.quarantineGeneration)) {
          return { ok: false, reason: 'receipt-write-failed', detail: 'resolution receipt conflicts with durable state' };
        }
        resumed = true;
      }
    } catch (error) {
      return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!receipt) {
      try {
        runtime.beforeReceiptPublish?.();
      } catch (error) {
        return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const receiptLocks = resolutionLocksRefusal(
        recoveryLock,
        daemonLock,
        'lock ownership was lost before resolution receipt publication',
      );
      if (receiptLocks) return receiptLocks;
      const receiptPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
      if (receiptPreconditions) return receiptPreconditions;
      const receiptChain = readQuarantineChain(
        plan.quarantinePlanId,
        plan.quarantineReceiptDigest,
        activeMarkerPath,
        [1n, 2n],
      );
      if ('ok' in receiptChain) return receiptChain;
      const receiptPhase = resolutionStatePhase(plan, receiptChain);
      if ('ok' in receiptPhase) return receiptPhase;
      if (receiptPhase.phase !== 'fresh-published') {
        return { ok: false, reason: 'state-publication-failed', detail: 'fresh state changed before receipt publication' };
      }
      const unsignedReceipt: Omit<DaemonStateResolutionReceipt, 'receiptDigest' | 'signature'> = {
        schemaVersion: 1,
        kind: 'daemon-state-resolution-receipt',
        planId: plan.planId,
        planDigest: plan.planDigest,
        previousDigest: intent.intentDigest,
        completedAt: (runtime.now?.() ?? new Date()).toISOString(),
        operation: 'publish-fresh-state',
        quarantinePlanId: plan.quarantinePlanId,
        quarantinePlanDigest: plan.quarantinePlanDigest,
        quarantineReceiptDigest: plan.quarantineReceiptDigest,
        quarantineMarkerDigest: plan.quarantineMarkerDigest,
        destinationPathSha256: plan.destinationPathSha256,
        derivedAccountingCanonicalBase64: plan.derivedAccountingCanonicalBase64,
        derivedAccountingSha256: plan.derivedAccountingSha256,
        derivedAccountingSizeBytes: plan.derivedAccountingSizeBytes,
        freshStateSha256: plan.freshStateSha256,
        freshStateSizeBytes: plan.freshStateSizeBytes,
        supervisorObservationCanonicalBase64: plan.supervisorObservationCanonicalBase64,
        supervisorObservationSha256: plan.supervisorObservationSha256,
        supervisorObservationSizeBytes: plan.supervisorObservationSizeBytes,
        freshStateGeneration: sourceGeneration(receiptPhase.state.stat),
        quarantineFileName: receiptChain.plan.quarantineFileName,
        quarantineSha256: receiptChain.evidence.sha256,
        quarantineSizeBytes: receiptChain.evidence.size,
        quarantineGeneration: sourceGeneration(receiptChain.evidence.stat),
        sourcePathReplaced: true,
        quarantineEvidencePreserved: true,
        markerRetirementAuthorized: true,
        operatorAuthorizationCount: 2,
        operatorIdentityAuthenticated: false,
        serviceMutationPerformed: false,
        serviceStartPerformed: false,
        serviceRestartPerformed: false,
        serviceInstallPerformed: false,
        signingKeyId: signer.keyId,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
      };
      const unsignedSignedReceipt: Omit<DaemonStateResolutionReceipt, 'signature'> = {
        ...unsignedReceipt,
        receiptDigest: domainDigest(RESOLUTION_RECEIPT_DOMAIN, unsignedReceipt),
      };
      receipt = {
        ...unsignedSignedReceipt,
        signature: keyedSignature(RESOLUTION_RECEIPT_DOMAIN, unsignedSignedReceipt, signer),
      };
      let receiptTempPath: string;
      try {
        receiptTempPath = prepareResolutionReceiptTemp(receiptPath, plan, receipt);
        runtime.afterReceiptStage?.();
      } catch (error) {
        return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const publishReceiptLocks = resolutionLocksRefusal(
        recoveryLock,
        daemonLock,
        'lock ownership was lost before staged resolution receipt publication',
      );
      if (publishReceiptLocks) return publishReceiptLocks;
      const publishReceiptPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
      if (publishReceiptPreconditions) return publishReceiptPreconditions;
      const publishReceiptChain = readQuarantineChain(
        plan.quarantinePlanId,
        plan.quarantineReceiptDigest,
        activeMarkerPath,
        [1n, 2n],
      );
      if ('ok' in publishReceiptChain) return publishReceiptChain;
      const publishReceiptPhase = resolutionStatePhase(plan, publishReceiptChain);
      if ('ok' in publishReceiptPhase) return publishReceiptPhase;
      if (publishReceiptPhase.phase !== 'fresh-published' ||
        !sameGeneration(publishReceiptPhase.state.stat, receipt.freshStateGeneration) ||
        !sameGeneration(publishReceiptChain.evidence.stat, receipt.quarantineGeneration)) {
        return { ok: false, reason: 'receipt-write-failed', detail: 'state or quarantine changed before staged receipt publication' };
      }
      try {
        publishRecordNoClobber(receiptTempPath, receiptPath);
        const publishedReceipt = parseResolutionReceipt(readPublishedRecord(receiptPath));
        if (!publishedReceipt || !equalDigest(publishedReceipt.receiptDigest, receipt.receiptDigest)) {
          throw new Error('published resolution receipt cannot be authenticated exactly');
        }
        runtime.afterReceiptPublish?.();
      } catch (error) {
        return { ok: false, reason: 'receipt-write-failed', detail: error instanceof Error ? error.message : String(error) };
      }
    }

    const retirementLocks = resolutionLocksRefusal(
      recoveryLock,
      daemonLock,
      'lock ownership was lost before marker retirement',
    );
    if (retirementLocks) return retirementLocks;
    const retirementPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
    if (retirementPreconditions) return retirementPreconditions;
    const lifecycleFence = acquireDaemonServiceLifecycleFence(homedir());
    if (!lifecycleFence) {
      return {
        ok: false,
        reason: 'marker-retirement-failed',
        detail: 'daemon service lifecycle fence is unavailable',
      };
    }
    try {
      runtime.afterLifecycleFenceAcquire?.();
      activeMarkerPresent = pathEntryExists(activeMarkerPath);
      retiredMarkerPresent = pathEntryExists(retiredMarkerPath);
      ensurePrivateDirectory(dirname(retiredMarkerPath));
      if (activeMarkerPresent && !retiredMarkerPresent) {
        linkSync(activeMarkerPath, retiredMarkerPath);
        fsyncDirectory(dirname(retiredMarkerPath));
        retiredMarkerPresent = true;
      }
      if (!retiredMarkerPresent) throw new Error('retired marker evidence is missing');
      const retired = stableRead(retiredMarkerPath, false, [1n, 2n, 3n]);
      const parsedRetired = parseMarker(JSON.parse(retired.bytes.toString('utf8')) as unknown);
      if (!parsedRetired || !equalDigest(parsedRetired.markerDigest, plan.quarantineMarkerDigest)) {
        throw new Error('retired marker evidence cannot be authenticated exactly');
      }
      if (activeMarkerPresent) {
        const active = stableRead(activeMarkerPath, false, [1n, 2n, 3n]);
        const parsedActive = parseMarker(JSON.parse(active.bytes.toString('utf8')) as unknown);
        if (!parsedActive || !equalDigest(parsedActive.markerDigest, plan.quarantineMarkerDigest) ||
          active.stat.dev !== retired.stat.dev || active.stat.ino !== retired.stat.ino) {
          throw new Error('active marker is not the exact authenticated retired inode');
        }
        runtime.beforeMarkerRetirement?.();
        const finalLocks = resolutionLocksRefusal(
          recoveryLock,
          daemonLock,
          'lock ownership was lost at marker retirement',
        );
        if (finalLocks) return finalLocks;
        if (!ownsDaemonServiceLifecycleFence(lifecycleFence)) {
          return {
            ok: false,
            reason: 'marker-retirement-failed',
            detail: 'daemon service lifecycle fence ownership was lost at marker retirement',
          };
        }
        const finalPreconditions = resolutionPreconditionsRefusal(plan, chain, runtime);
        if (finalPreconditions) return finalPreconditions;
        const finalActive = stableRead(activeMarkerPath, false, [1n, 2n, 3n]);
        const finalRetired = stableRead(retiredMarkerPath, false, [1n, 2n, 3n]);
        if (finalActive.stat.dev !== finalRetired.stat.dev || finalActive.stat.ino !== finalRetired.stat.ino ||
          !finalActive.bytes.equals(finalRetired.bytes)) {
          throw new Error('marker identity changed before retirement');
        }
        const finalReceipt = parseResolutionReceipt(readPublishedRecord(receiptPath));
        if (!finalReceipt || !equalDigest(finalReceipt.receiptDigest, receipt.receiptDigest)) {
          throw new Error('signed resolution receipt changed before marker retirement');
        }
        const finalChain = readQuarantineChain(
          plan.quarantinePlanId,
          plan.quarantineReceiptDigest,
          activeMarkerPath,
          [1n, 2n, 3n],
        );
        if ('ok' in finalChain) return finalChain;
        const finalPhase = resolutionStatePhase(plan, finalChain);
        if ('ok' in finalPhase) return finalPhase;
        if (finalPhase.phase !== 'fresh-published') {
          throw new Error('fresh state or quarantine evidence changed before marker retirement');
        }
        if (!sameGeneration(finalChain.evidence.stat, receipt.quarantineGeneration)) {
          throw new Error('quarantine evidence generation changed before marker retirement');
        }
        if (!ownsDaemonServiceLifecycleFence(lifecycleFence)) {
          throw new Error('daemon service lifecycle fence ownership was lost before marker retirement');
        }
        unlinkSync(activeMarkerPath);
        fsyncDirectory(dirname(activeMarkerPath));
      }
      if (pathEntryExists(activeMarkerPath)) throw new Error('active marker remains after retirement');
      const finalRetired = stableRead(retiredMarkerPath, false, [1n, 2n]);
      const finalMarker = parseMarker(JSON.parse(finalRetired.bytes.toString('utf8')) as unknown);
      if (!finalMarker || !equalDigest(finalMarker.markerDigest, plan.quarantineMarkerDigest)) {
        throw new Error('retired marker evidence changed after durable retirement');
      }
    } catch (error) {
      return { ok: false, reason: 'marker-retirement-failed', detail: error instanceof Error ? error.message : String(error) };
    } finally {
      releaseDaemonServiceLifecycleFence(lifecycleFence);
    }

    const finalChain = readQuarantineChain(
      plan.quarantinePlanId,
      plan.quarantineReceiptDigest,
      retiredMarkerPath,
      [1n, 2n],
    );
    if ('ok' in finalChain) return finalChain;
    const finalPhase = resolutionStatePhase(plan, finalChain);
    if ('ok' in finalPhase) return finalPhase;
    if (finalPhase.phase !== 'fresh-published' ||
      !sameGeneration(finalPhase.state.stat, receipt.freshStateGeneration) ||
      !sameGeneration(finalChain.evidence.stat, receipt.quarantineGeneration)) {
      return { ok: false, reason: 'state-publication-failed', detail: 'final fresh state generation changed' };
    }
    return {
      ok: true,
      receipt,
      receiptPath,
      quarantinePath: finalChain.quarantinePath,
      retiredMarkerPath,
      resumed,
    };
  } finally {
    if (daemonLock) releaseDaemonLock(daemonLock);
    releaseLocalStoreLock(recoveryLock);
  }
}
