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
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServiceStatusResult } from './service.js';
import { serviceActivity } from './service-activity.js';
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
  | 'receipt-write-failed';

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

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePrivateDirectoryIdentity(path: string, expected: BigIntStats): boolean {
  const observed = lstatSync(path, { bigint: true });
  return safePrivateDirectory(observed) && observed.dev === expected.dev && observed.ino === expected.ino &&
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
  if (!safePrivateDirectory(homeStat)) throw new Error('unsafe-home');
  const parts = relative(home, target).split(sep).filter(Boolean);
  let cursor = home;
  for (const part of parts) {
    cursor = join(cursor, part);
    let created = false;
    if (!existsSync(cursor)) {
      mkdirSync(cursor, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    }
    const stat = lstatSync(cursor, { bigint: true });
    if (!safePrivateDirectory(stat)) throw new Error(`unsafe-directory:${cursor}`);
    if (created) {
      if (process.platform !== 'win32') chmodSync(cursor, PRIVATE_DIRECTORY_MODE);
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
  }
}

function assureSourceStorage(path: string): void {
  const home = resolve(homedir());
  const target = resolve(path);
  if (!nestedWithin(home, target)) throw new Error('source-outside-home');
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
  assureSourceStorage(path);
  const namedBefore = lstatSync(path, { bigint: true });
  if (!safePrivateFile(namedBefore, allowedLinks) || namedBefore.size <= 0n ||
    namedBefore.size > BigInt(MAX_STATE_BYTES)) throw new Error('unsafe-source-file');
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

function writeExclusiveRecord(path: string, value: unknown): void {
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
    const bytes = Buffer.from(`${canonicalizeDaemonActivationValue(value)}\n`, 'utf8');
    writeAll(fd, bytes);
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!safePrivateFile(after) || after.dev !== initial.dev || after.ino !== initial.ino ||
      after.size !== BigInt(bytes.length)) throw new Error('record-changed-during-write');
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', {
      anchorPath: homedir(),
    });
    if (!assurance.ok) throw new Error(`unsafe-record:${assurance.reason}`);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve fail-closed evidence */ }
    }
  }
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
