/**
 * Dormant, permit-gated stopped-release activation transaction.
 *
 * This module never starts, bootstraps, kickstarts, enables, or acknowledges a
 * resident service. It may only replace the stopped launchd plist and select an
 * already-admitted immutable release while preserving loaded=false and the
 * exact observed disabled bit. Production trust roots are intentionally empty.
 *
 * The pointer operation is a host-local cooperative CAS: under Ashlr's outward
 * and service lifecycle fences it compares the exact old symlink inode and raw
 * target immediately before an atomic rename, then verifies the new target.
 * It is not a kernel compare-exchange and is not a boundary against a hostile
 * process running under the same UID.
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { canonicalizeDaemonActivationValue } from './activation-permit.js';
import { installLaunchdPlistTransaction } from './launchd-plist-transaction.js';
import {
  activityAllowsStoppedRecovery,
  observeMaintenanceDefault,
  runtimeActivationStoppedRuntime,
  type RuntimeActivationStoppedConsumerTrustRoot,
  type RuntimeActivationStoppedLaunchdState,
} from './runtime-activation-stopped-runtime.js';
import {
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const PROTOCOL = 'runtime-activation-stopped-consumer-v1' as const;
const PERMIT_DOMAIN = 'ashlr:runtime-activation-stopped-consumer:permit:v1' as const;
const PERMIT_SIGNATURE_DOMAIN = `${PERMIT_DOMAIN}\0`;
const JOURNAL_DOMAIN = 'ashlr:runtime-activation-stopped-consumer:journal:v1';
const CLAIM_DOMAIN = 'ashlr:runtime-activation-stopped-consumer:claim:v1';
const RECEIPT_DOMAIN = 'ashlr:runtime-activation-stopped-consumer:receipt:v1';
const MAX_PERMIT_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 512 * 1024;
const MAX_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA1_RE = /^[a-f0-9]{40}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RECORDS = 25_000;
const MAX_RECORD_BYTES = 32 * 1024;
export {
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS,
  type RuntimeActivationStoppedConsumerTrustRoot,
} from './runtime-activation-stopped-runtime.js';

export interface RuntimeActivationStoppedPermitPayloadV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  permitId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: {
    action: 'select-verified-3.2.7-stopped-release';
    maintenance: true;
    killSwitch: 'healthy-engaged';
    providerEffectsBlocked: true;
    serviceLoaded: false;
    serviceStart: false;
    serviceEnable: false;
    residentAcknowledgement: false;
  };
  bindings: {
    activationId: string;
    admissionDigest: string;
    planDigest: string;
    canonicalRequestSha256: string;
    trustRootCanonicalSha256: string;
    candidateRevision: string;
    candidateVersion: '3.2.7';
    rollbackRevision: string;
    priorCurrentTarget: string;
    priorPlistSha256: string;
    priorServiceDisabled: boolean;
    priorServiceLoaded: false;
  };
}

export interface RuntimeActivationStoppedPermitEnvelopeV1 {
  payload: RuntimeActivationStoppedPermitPayloadV1;
  signature: string;
}

export interface RuntimeActivationStoppedPlan {
  request: {
    signedManifest: {
      payload: {
        planId: string;
        candidate: { expectedRevision: string; packageVersion: string; releaseTag: string };
        rollback: { expectedRevision: string };
        execution: {
          homePath: string;
          currentPointerPath: string;
          releasesRoot: string;
          prior: { currentRevision: string | null; plistSha256: string | null; serviceLoaded: false };
        };
      };
    };
  };
  preflight: {
    plan: { admissionDigest: string | null; planDigest: string | null };
  };
  canonicalRequestSha256: string;
  trustRootCanonicalSha256: string;
  candidateServiceDescriptor: string;
  rollbackServiceDescriptor: string;
}

export interface RuntimeActivationStoppedResult {
  activationId: string | null;
  candidateRevision: string | null;
  admissionDigest: string | null;
  planDigest: string | null;
  activated: boolean;
  serviceStarted: false;
  serviceEnabledChanged: false;
  phase: 'blocked' | 'activated-stopped';
  reason: string;
  rollbackRestored: boolean;
  recoveryJournalRetained: boolean;
  recoveryJournalObserved: boolean;
  durableOutcome: 'none' | 'restored-prior' | 'settled-candidate';
  permitId: string | null;
  receiptPath: string | null;
}

type LaunchdStoppedState = RuntimeActivationStoppedLaunchdState;

type RuntimeActivationStoppedJournalPhase =
  | 'prepared'
  | 'plist-replaced'
  | 'pointer-switched';

interface RuntimeActivationStoppedJournalV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  phase: RuntimeActivationStoppedJournalPhase;
  sequence: number;
  predecessorDigest: string;
  activationId: string;
  permitId: string;
  admissionDigest: string;
  planDigest: string;
  candidateRevision: string;
  currentPointerPath: string;
  priorCurrentTarget: string;
  candidateCurrentTarget: string;
  plistPath: string;
  priorPlistBase64: string;
  priorPlistSha256: string;
  candidatePlistSha256: string;
  priorServiceDisabled: boolean;
  priorServiceLoaded: false;
  recordDigest: string;
  attestation: string;
}

interface ActivationRecordV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  kind: 'claim' | 'receipt';
  permitId: string;
  activationId: string;
  admissionDigest: string;
  planDigest: string;
  candidateRevision: string;
  recordDigest: string;
}

interface RuntimeActivationStoppedIdentity {
  activationId: string;
  candidateRevision: string;
  admissionDigest: string;
  planDigest: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainDigest(domain: string, value: unknown): string {
  return sha256(`${domain}\n${canonicalizeDaemonActivationValue(value)}`);
}

function sameDigest(left: string, right: string): boolean {
  return SHA256_RE.test(left) && SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function base64url(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return (bytes === undefined || decoded.length === bytes) && decoded.toString('base64url') === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function permitSigningBytes(payload: RuntimeActivationStoppedPermitPayloadV1): Buffer {
  return Buffer.from(`${PERMIT_SIGNATURE_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`, 'utf8');
}

export function runtimeActivationStoppedConsumerKeyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return sha256(Buffer.concat([Buffer.from(`${PERMIT_DOMAIN}:key\0`, 'utf8'), spki]));
}

export function signRuntimeActivationStoppedPermit(
  payload: RuntimeActivationStoppedPermitPayloadV1,
  privateKey: KeyObject,
): RuntimeActivationStoppedPermitEnvelopeV1 {
  return {
    payload: structuredClone(payload),
    signature: sign(null, permitSigningBytes(payload), privateKey).toString('base64url'),
  };
}

function parsePermit(value: unknown): RuntimeActivationStoppedPermitEnvelopeV1 | null {
  if (!plainObject(value) || !exactKeys(value, ['payload', 'signature']) || !plainObject(value['payload']) ||
    base64url(value['signature'], 64) === null) return null;
  const payload = value['payload'];
  if (!exactKeys(payload, [
    'schemaVersion', 'protocol', 'permitId', 'keyId', 'issuedAt', 'expiresAt', 'scope', 'bindings',
  ]) || payload['schemaVersion'] !== 1 || payload['protocol'] !== PROTOCOL ||
    typeof payload['permitId'] !== 'string' || !UUID_RE.test(payload['permitId']) ||
    typeof payload['keyId'] !== 'string' || !KEY_ID_RE.test(payload['keyId']) ||
    !canonicalTimestamp(payload['issuedAt']) || !canonicalTimestamp(payload['expiresAt']) ||
    !plainObject(payload['scope']) || !plainObject(payload['bindings'])) return null;
  const scope = payload['scope'];
  if (!exactKeys(scope, [
    'action', 'maintenance', 'killSwitch', 'providerEffectsBlocked', 'serviceLoaded',
    'serviceStart', 'serviceEnable', 'residentAcknowledgement',
  ]) || scope['action'] !== 'select-verified-3.2.7-stopped-release' || scope['maintenance'] !== true ||
    scope['killSwitch'] !== 'healthy-engaged' || scope['providerEffectsBlocked'] !== true ||
    scope['serviceLoaded'] !== false || scope['serviceStart'] !== false ||
    scope['serviceEnable'] !== false || scope['residentAcknowledgement'] !== false) return null;
  const bindings = payload['bindings'];
  if (!exactKeys(bindings, [
    'activationId', 'admissionDigest', 'planDigest', 'canonicalRequestSha256',
    'trustRootCanonicalSha256', 'candidateRevision', 'candidateVersion', 'rollbackRevision',
    'priorCurrentTarget', 'priorPlistSha256', 'priorServiceDisabled', 'priorServiceLoaded',
  ]) || typeof bindings['activationId'] !== 'string' || !UUID_RE.test(bindings['activationId']) ||
    ![bindings['admissionDigest'], bindings['planDigest'], bindings['canonicalRequestSha256'],
      bindings['trustRootCanonicalSha256'], bindings['priorPlistSha256']]
      .every((entry) => typeof entry === 'string' && SHA256_RE.test(entry)) ||
    typeof bindings['candidateRevision'] !== 'string' || !SHA1_RE.test(bindings['candidateRevision']) ||
    bindings['candidateVersion'] !== '3.2.7' ||
    typeof bindings['rollbackRevision'] !== 'string' || !SHA1_RE.test(bindings['rollbackRevision']) ||
    typeof bindings['priorCurrentTarget'] !== 'string' || bindings['priorCurrentTarget'].length > 512 ||
    typeof bindings['priorServiceDisabled'] !== 'boolean' || bindings['priorServiceLoaded'] !== false) return null;
  return value as unknown as RuntimeActivationStoppedPermitEnvelopeV1;
}

function verifyPermit(
  envelope: RuntimeActivationStoppedPermitEnvelopeV1,
  roots: readonly RuntimeActivationStoppedConsumerTrustRoot[],
  nowMs: number,
): string | null {
  const issued = Date.parse(envelope.payload.issuedAt);
  const expires = Date.parse(envelope.payload.expiresAt);
  if (!Number.isFinite(nowMs) || expires <= issued || expires - issued > MAX_VALIDITY_MS ||
    nowMs < issued - MAX_FUTURE_SKEW_MS || nowMs >= expires) return 'runtime activation stopped permit is outside its validity window';
  const root = roots.find((entry) => entry.keyId === envelope.payload.keyId);
  if (!root || root.algorithm !== 'ed25519' || !canonicalTimestamp(root.validFrom) ||
    !canonicalTimestamp(root.validUntil) || nowMs < Date.parse(root.validFrom) || nowMs >= Date.parse(root.validUntil)) {
    return 'runtime activation stopped permit signing root is unavailable';
  }
  const spki = base64url(root.publicKeySpki);
  const signature = base64url(envelope.signature, 64);
  if (!spki || !signature) return 'runtime activation stopped permit signature is invalid';
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || runtimeActivationStoppedConsumerKeyId(key) !== root.keyId ||
      !verify(null, permitSigningBytes(envelope.payload), key, signature)) {
      return 'runtime activation stopped permit signature is invalid';
    }
  } catch {
    return 'runtime activation stopped permit signature is invalid';
  }
  return null;
}

function permitPath(homePath: string, activationId: string): string {
  return join(homePath, '.ashlr', 'control', 'activation', 'consumer-permits', `${activationId}.json`);
}

function readPermit(homePath: string, activationId: string): RuntimeActivationStoppedPermitEnvelopeV1 {
  const path = permitPath(homePath, activationId);
  const read = readStableRegularFile(path, {
    anchorPath: homePath,
    maxFileBytes: MAX_PERMIT_BYTES,
    remainingBytes: MAX_PERMIT_BYTES,
  });
  if (!read.ok) throw new Error('runtime activation stopped permit is unavailable');
  const stat = lstatSync(path, { bigint: true });
  const assurance = assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath: homePath });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !owned(stat) ||
    (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n) || !assurance.ok) {
    throw new Error('runtime activation stopped permit custody is unsafe');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(read.text); } catch { throw new Error('runtime activation stopped permit is invalid'); }
  const envelope = parsePermit(parsed);
  if (!envelope || `${canonicalizeDaemonActivationValue(envelope)}\n` !== read.text) {
    throw new Error('runtime activation stopped permit is not canonical');
  }
  return envelope;
}

function plistPath(homePath: string): string {
  return join(homePath, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
}

function rawReleaseTarget(revision: string): string {
  return join('releases', revision);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function owned(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function safeSymlink(stat: BigIntStats): boolean {
  return stat.isSymbolicLink() && stat.nlink === 1n && owned(stat);
}

function inspectCurrentPointer(path: string, expectedTarget: string): BigIntStats {
  const parent = dirname(path);
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== 'current') {
    throw new Error('runtime activation current pointer path is invalid');
  }
  const parentStat = lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !owned(parentStat) ||
    (process.platform !== 'win32' && (parentStat.mode & 0o022n) !== 0n) || realpathSync(parent) !== parent) {
    throw new Error('runtime activation current pointer parent is unsafe');
  }
  const stat = lstatSync(path, { bigint: true });
  if (!safeSymlink(stat) || readlinkSync(path, 'utf8') !== expectedTarget ||
    resolve(parent, expectedTarget) !== join(parent, expectedTarget)) {
    throw new Error('runtime activation current pointer does not match the signed prior release');
  }
  return stat;
}

function cooperativePointerCas(path: string, expectedTarget: string, desiredTarget: string): void {
  const expected = inspectCurrentPointer(path, expectedTarget);
  const parent = dirname(path);
  const temporary = join(parent, `.current.${process.pid}.${sha256(`${desiredTarget}:${Date.now()}`).slice(0, 24)}.tmp`);
  let temporaryIdentity: BigIntStats | undefined;
  try {
    symlinkSync(desiredTarget, temporary);
    temporaryIdentity = lstatSync(temporary, { bigint: true });
    if (!safeSymlink(temporaryIdentity) || readlinkSync(temporary, 'utf8') !== desiredTarget) {
      throw new Error('runtime activation candidate pointer is unsafe');
    }
    fsyncDirectory(parent);
    const current = lstatSync(path, { bigint: true });
    if (!safeSymlink(current) || !sameIdentity(expected, current) || readlinkSync(path, 'utf8') !== expectedTarget) {
      throw new Error('runtime activation current pointer changed before cooperative CAS');
    }
    renameSync(temporary, path);
    temporaryIdentity = undefined;
    fsyncDirectory(parent);
    inspectCurrentPointer(path, desiredTarget);
  } finally {
    if (temporaryIdentity) {
      try {
        const current = lstatSync(temporary, { bigint: true });
        if (sameIdentity(current, temporaryIdentity)) unlinkSync(temporary);
      } catch { /* exact temporary is absent or replaced */ }
    }
  }
}

function readExactPrivateFile(path: string, expectedSha256: string, homePath: string): Buffer {
  const read = readStableRegularFile(path, {
    anchorPath: homePath,
    maxFileBytes: MAX_JOURNAL_BYTES,
    remainingBytes: MAX_JOURNAL_BYTES,
  });
  if (!read.ok) throw new Error('runtime activation prior plist is unavailable');
  const bytes = Buffer.from(read.text, 'utf8');
  if (!sameDigest(sha256(bytes), expectedSha256)) throw new Error('runtime activation prior plist digest mismatch');
  return bytes;
}

function recordPayload(record: Omit<ActivationRecordV1, 'recordDigest'>): ActivationRecordV1 {
  return { ...record, recordDigest: domainDigest(record.kind === 'claim' ? CLAIM_DOMAIN : RECEIPT_DOMAIN, record) };
}

function parseRecord(value: unknown): ActivationRecordV1 | null {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'protocol', 'kind', 'permitId', 'activationId', 'admissionDigest',
    'planDigest', 'candidateRevision', 'recordDigest',
  ]) || value['schemaVersion'] !== 1 || value['protocol'] !== PROTOCOL ||
    (value['kind'] !== 'claim' && value['kind'] !== 'receipt') ||
    typeof value['permitId'] !== 'string' || !UUID_RE.test(value['permitId']) ||
    typeof value['activationId'] !== 'string' || !UUID_RE.test(value['activationId']) ||
    typeof value['candidateRevision'] !== 'string' || !SHA1_RE.test(value['candidateRevision']) ||
    ![value['admissionDigest'], value['planDigest'], value['recordDigest']]
      .every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))) return null;
  const { recordDigest, ...unsigned } = value as unknown as ActivationRecordV1;
  return sameDigest(recordDigest, domainDigest(value['kind'] === 'claim' ? CLAIM_DOMAIN : RECEIPT_DOMAIN, unsigned))
    ? value as unknown as ActivationRecordV1
    : null;
}

function recordCodec(): ImmutablePrivateRecordCodec<ActivationRecordV1> {
  return {
    parse: parseRecord,
    serialize: (record) => `${canonicalizeDaemonActivationValue(record)}\n`,
    recordId: (record) => `${record.kind}-${record.permitId}`,
    recordFileName: (record) => `${record.kind}-${record.permitId}.json`,
    isRecordFileName: (name) => /^(?:claim|receipt)-[0-9a-f-]{36}\.json$/iu.test(name),
    stageToken: (record) => record.recordDigest,
    equivalent: (left, right) => sameDigest(left.recordDigest, right.recordDigest),
  };
}

function recordStore(homePath: string): ImmutablePrivateRecordStoreConfig<ActivationRecordV1> {
  const anchorPath = join(homePath, '.ashlr', 'control', 'activation');
  const rootPath = join(anchorPath, 'consumer-records');
  return {
    label: 'runtime activation stopped consumer record',
    anchorPath,
    rootPath,
    lockFileName: '.runtime-activation-stopped-consumer.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: MAX_RECORDS,
    hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: MAX_RECORDS * MAX_RECORD_BYTES,
    hardMaxBytes: MAX_RECORDS * MAX_RECORD_BYTES,
    codecForRead: recordCodec,
    codecForWrite: recordCodec,
  };
}

function journalUnsigned(value: RuntimeActivationStoppedJournalV1): Omit<RuntimeActivationStoppedJournalV1, 'recordDigest' | 'attestation'> {
  const { recordDigest: _recordDigest, attestation: _attestation, ...unsigned } = value;
  return unsigned;
}

function journalWithAttestation(
  value: Omit<RuntimeActivationStoppedJournalV1, 'recordDigest' | 'attestation'>,
  key: Buffer,
): RuntimeActivationStoppedJournalV1 {
  const recordDigest = domainDigest(JOURNAL_DOMAIN, value);
  const attestation = createHmac('sha256', key).update(`${JOURNAL_DOMAIN}\n${recordDigest}`).digest('hex');
  return { ...value, recordDigest, attestation };
}

function verifyJournal(value: unknown, key: Buffer): RuntimeActivationStoppedJournalV1 | null {
  if (!plainObject(value)) return null;
  const journal = value as unknown as RuntimeActivationStoppedJournalV1;
  if (!exactKeys(value, [
    'schemaVersion', 'protocol', 'phase', 'sequence', 'predecessorDigest', 'activationId', 'permitId',
    'admissionDigest', 'planDigest', 'candidateRevision', 'currentPointerPath', 'priorCurrentTarget', 'candidateCurrentTarget',
    'plistPath', 'priorPlistBase64', 'priorPlistSha256', 'candidatePlistSha256',
    'priorServiceDisabled', 'priorServiceLoaded', 'recordDigest', 'attestation',
  ]) || journal.schemaVersion !== 1 || journal.protocol !== PROTOCOL ||
    !['prepared', 'plist-replaced', 'pointer-switched'].includes(journal.phase) ||
    !Number.isSafeInteger(journal.sequence) || journal.sequence < 1 ||
    !UUID_RE.test(journal.activationId) || !UUID_RE.test(journal.permitId) || !SHA1_RE.test(journal.candidateRevision) ||
    ![journal.predecessorDigest, journal.admissionDigest, journal.planDigest, journal.priorPlistSha256,
      journal.candidatePlistSha256, journal.recordDigest, journal.attestation]
      .every((entry) => typeof entry === 'string' && SHA256_RE.test(entry)) ||
    !isAbsolute(journal.currentPointerPath) || resolve(journal.currentPointerPath) !== journal.currentPointerPath ||
    !isAbsolute(journal.plistPath) || resolve(journal.plistPath) !== journal.plistPath ||
    typeof journal.priorCurrentTarget !== 'string' || typeof journal.candidateCurrentTarget !== 'string' ||
    typeof journal.priorPlistBase64 !== 'string' || base64url(journal.priorPlistBase64) === null ||
    typeof journal.priorServiceDisabled !== 'boolean' || journal.priorServiceLoaded !== false ||
    !((journal.phase === 'prepared' && journal.sequence === 1 && /^0{64}$/u.test(journal.predecessorDigest)) ||
      (journal.phase === 'plist-replaced' && journal.sequence === 2 && !/^0{64}$/u.test(journal.predecessorDigest)) ||
      (journal.phase === 'pointer-switched' && journal.sequence === 3 && !/^0{64}$/u.test(journal.predecessorDigest)))) return null;
  const recordDigest = domainDigest(JOURNAL_DOMAIN, journalUnsigned(journal));
  const expected = createHmac('sha256', key).update(`${JOURNAL_DOMAIN}\n${recordDigest}`).digest('hex');
  return sameDigest(journal.recordDigest, recordDigest) && sameDigest(journal.attestation, expected) ? journal : null;
}

function journalPath(homePath: string): string {
  return join(homePath, '.ashlr', 'locks', 'runtime-activation-stopped-consumer.journal.json');
}

function writeJournal(homePath: string, journal: RuntimeActivationStoppedJournalV1): void {
  const path = journalPath(homePath);
  const temporary = `${path}.${process.pid}.${journal.sequence}.tmp`;
  writePrivateFileAtomically(
    temporary,
    path,
    `${canonicalizeDaemonActivationValue(journal)}\n`,
    { anchorPath: homePath, label: 'runtime activation stopped consumer journal' },
  );
}

function readJournal(homePath: string, key: Buffer): RuntimeActivationStoppedJournalV1 | null {
  const path = journalPath(homePath);
  if (!existsSync(path)) return null;
  const read = readStableRegularFile(path, {
    anchorPath: homePath,
    maxFileBytes: MAX_JOURNAL_BYTES,
    remainingBytes: MAX_JOURNAL_BYTES,
  });
  if (!read.ok) throw new Error('runtime activation stopped consumer journal is unsafe');
  let parsed: unknown;
  try { parsed = JSON.parse(read.text); } catch { throw new Error('runtime activation stopped consumer journal is invalid'); }
  const journal = verifyJournal(parsed, key);
  if (!journal || `${canonicalizeDaemonActivationValue(journal)}\n` !== read.text) {
    throw new Error('runtime activation stopped consumer journal authentication failed');
  }
  const priorBytes = base64url(journal.priorPlistBase64);
  if (journal.currentPointerPath !== join(homePath, '.local', 'share', 'ashlr', 'current') ||
    journal.plistPath !== plistPath(homePath) ||
    dirname(journal.priorCurrentTarget) !== 'releases' || !SHA1_RE.test(basename(journal.priorCurrentTarget)) ||
    dirname(journal.candidateCurrentTarget) !== 'releases' ||
    basename(journal.candidateCurrentTarget) !== journal.candidateRevision ||
    !priorBytes || !sameDigest(sha256(priorBytes), journal.priorPlistSha256)) {
    throw new Error('runtime activation stopped consumer journal home binding is invalid');
  }
  return journal;
}

function removeJournal(homePath: string): void {
  const path = journalPath(homePath);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !owned(stat) ||
    (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n)) {
    throw new Error('runtime activation stopped consumer journal changed before removal');
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function replaceStoppedPlist(
  homePath: string,
  content: string,
  expectedDisabled: boolean,
  observe: () => LaunchdStoppedState,
): void {
  installLaunchdPlistTransaction({
    plistPath: plistPath(homePath),
    trustedRoot: homePath,
    content,
    lockDir: join(homePath, '.ashlr', 'locks'),
    operationLabel: 'runtime-activation-stopped',
    preflight: ({ hasPrior }) => {
      try {
        const state = observe();
        return hasPrior && state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '', recoveryState: state }
          : { ok: false, stdout: '', stderr: 'prior stopped launchd state or plist is not exact' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    unload: () => {
      try {
        const state = observe();
        return state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: 'launchd state changed before plist replacement' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    load: () => {
      try {
        const state = observe();
        return state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: 'plist replacement changed launchd stopped state' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    verify: () => {
      try {
        const state = observe();
        return state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: 'launchd stopped state was not preserved' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    rollback: () => {
      try {
        const state = observe();
        return state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: 'launchd stopped state cannot be restored without manager mutation' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    recover: () => {
      try {
        const state = observe();
        return state.loaded === false && state.disabled === expectedDisabled
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: 'launchd recovery state is no longer exact' };
      } catch (error) {
        return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    validateRecovery: (state) => plainObject(state) && exactKeys(state, ['loaded', 'disabled']) &&
      state['loaded'] === false && state['disabled'] === expectedDisabled
      ? { ok: true, stdout: '', stderr: '' }
      : { ok: false, stdout: '', stderr: 'persisted stopped launchd state is invalid' },
  });
}

function inspectPrivateRoots(homePath: string, includePermitRoot = true): void {
  const paths = [
    join(homePath, '.ashlr'),
    join(homePath, '.ashlr', 'locks'),
    join(homePath, '.ashlr', 'control'),
    join(homePath, '.ashlr', 'control', 'activation'),
  ];
  if (includePermitRoot) paths.push(join(homePath, '.ashlr', 'control', 'activation', 'consumer-permits'));
  for (const path of paths) {
    const stat = lstatSync(path, { bigint: true });
    const assurance = assurePrivateStoragePath(path, 'directory', 'inspect-owned', { anchorPath: homePath });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o777n) !== BigInt(PRIVATE_DIRECTORY_MODE)) ||
      realpathSync(path) !== path || !assurance.ok) {
      throw new Error('runtime activation private control custody is unsafe');
    }
  }
}

function bindPermit(plan: RuntimeActivationStoppedPlan, envelope: RuntimeActivationStoppedPermitEnvelopeV1): string | null {
  const payload = plan.request.signedManifest.payload;
  const binding = envelope.payload.bindings;
  const admissionDigest = plan.preflight.plan.admissionDigest;
  const planDigest = plan.preflight.plan.planDigest;
  if (!admissionDigest || !planDigest ||
    payload.candidate.packageVersion !== '3.2.7' || payload.candidate.releaseTag !== 'v3.2.7' ||
    binding.activationId !== payload.planId || !sameDigest(binding.admissionDigest, admissionDigest) ||
    !sameDigest(binding.planDigest, planDigest) ||
    !sameDigest(binding.canonicalRequestSha256, plan.canonicalRequestSha256) ||
    !sameDigest(binding.trustRootCanonicalSha256, plan.trustRootCanonicalSha256) ||
    binding.candidateRevision !== payload.candidate.expectedRevision ||
    binding.rollbackRevision !== payload.rollback.expectedRevision ||
    binding.priorCurrentTarget !== rawReleaseTarget(payload.rollback.expectedRevision) ||
    payload.execution.prior.currentRevision !== payload.rollback.expectedRevision ||
    payload.execution.prior.plistSha256 === null ||
    !sameDigest(binding.priorPlistSha256, payload.execution.prior.plistSha256)) {
    return 'runtime activation stopped permit does not bind the exact admitted 3.2.7 plan';
  }
  return null;
}

function blocked(
  reason: string,
  rollbackRestored = false,
  permitId: string | null = null,
  recoveryJournalRetained = false,
  identity?: RuntimeActivationStoppedIdentity,
  durableOutcome: RuntimeActivationStoppedResult['durableOutcome'] = 'none',
  recoveryJournalObserved = false,
): RuntimeActivationStoppedResult {
  return {
    activationId: identity?.activationId ?? null,
    candidateRevision: identity?.candidateRevision ?? null,
    admissionDigest: identity?.admissionDigest ?? null,
    planDigest: identity?.planDigest ?? null,
    activated: false,
    serviceStarted: false,
    serviceEnabledChanged: false,
    phase: 'blocked',
    reason,
    rollbackRestored,
    recoveryJournalRetained,
    recoveryJournalObserved,
    durableOutcome,
    permitId,
    receiptPath: null,
  };
}

function settledCandidate(
  homePath: string,
  identity: RuntimeActivationStoppedIdentity,
  permitId: string,
  reason: string,
  recoveryJournalObserved: boolean,
): RuntimeActivationStoppedResult {
  return {
    ...identity,
    activated: true,
    serviceStarted: false,
    serviceEnabledChanged: false,
    phase: 'activated-stopped',
    reason,
    rollbackRestored: false,
    recoveryJournalRetained: false,
    recoveryJournalObserved,
    durableOutcome: 'settled-candidate',
    permitId,
    receiptPath: join(recordStore(homePath).rootPath, 'records', `receipt-${permitId}.json`),
  };
}

function recordFor(
  kind: 'claim' | 'receipt',
  plan: RuntimeActivationStoppedPlan,
  permitId: string,
): ActivationRecordV1 {
  const payload = plan.request.signedManifest.payload;
  return recordPayload({
    schemaVersion: 1,
    protocol: PROTOCOL,
    kind,
    permitId,
    activationId: payload.planId,
    admissionDigest: plan.preflight.plan.admissionDigest!,
    planDigest: plan.preflight.plan.planDigest!,
    candidateRevision: payload.candidate.expectedRevision,
  });
}

function planIdentity(plan: RuntimeActivationStoppedPlan): RuntimeActivationStoppedIdentity {
  return {
    activationId: plan.request.signedManifest.payload.planId,
    candidateRevision: plan.request.signedManifest.payload.candidate.expectedRevision,
    admissionDigest: plan.preflight.plan.admissionDigest!,
    planDigest: plan.preflight.plan.planDigest!,
  };
}

function readExactRecord(
  homePath: string,
  record: ActivationRecordV1,
): 'missing' | 'exact' | 'degraded' {
  const fileName = `${record.kind}-${record.permitId}.json`;
  const point = readImmutablePrivateRecordPoint(
    recordStore(homePath),
    `${record.kind}-${record.permitId}`,
    fileName,
  );
  if (point.sourceState === 'missing') return 'missing';
  if (!point.exactReadComplete) return 'degraded';
  if (point.record === null) return 'missing';
  return point.record && recordCodec().equivalent(point.record, record) ? 'exact' : 'degraded';
}

function exactFileDigest(path: string, expectedSha256: string, homePath: string): boolean {
  const read = readStableRegularFile(path, {
    anchorPath: homePath,
    maxFileBytes: MAX_JOURNAL_BYTES,
    remainingBytes: MAX_JOURNAL_BYTES,
  });
  return read.ok && sameDigest(sha256(Buffer.from(read.text, 'utf8')), expectedSha256);
}

function journalReceipt(journal: RuntimeActivationStoppedJournalV1): ActivationRecordV1 {
  return recordPayload({
    schemaVersion: 1,
    protocol: PROTOCOL,
    kind: 'receipt',
    permitId: journal.permitId,
    activationId: journal.activationId,
    admissionDigest: journal.admissionDigest,
    planDigest: journal.planDigest,
    candidateRevision: journal.candidateRevision,
  });
}

function journalClaim(journal: RuntimeActivationStoppedJournalV1): ActivationRecordV1 {
  return recordPayload({
    schemaVersion: 1,
    protocol: PROTOCOL,
    kind: 'claim',
    permitId: journal.permitId,
    activationId: journal.activationId,
    admissionDigest: journal.admissionDigest,
    planDigest: journal.planDigest,
    candidateRevision: journal.candidateRevision,
  });
}

function journalIdentity(journal: RuntimeActivationStoppedJournalV1): RuntimeActivationStoppedIdentity {
  return {
    activationId: journal.activationId,
    candidateRevision: journal.candidateRevision,
    admissionDigest: journal.admissionDigest,
    planDigest: journal.planDigest,
  };
}

function restoreJournal(
  homePath: string,
  journal: RuntimeActivationStoppedJournalV1,
  observe: () => LaunchdStoppedState,
  requireFences: () => void,
): 'restored' | 'settled' {
  requireFences();
  if (readExactRecord(homePath, journalClaim(journal)) !== 'exact') {
    throw new Error('runtime activation recovery claim is missing or degraded');
  }
  const receiptState = readExactRecord(homePath, journalReceipt(journal));
  if (receiptState === 'degraded') {
    throw new Error('runtime activation recovery receipt state is degraded');
  }
  if (receiptState === 'exact') {
    requireFences();
    const service = observe();
    if (service.loaded !== false || service.disabled !== journal.priorServiceDisabled ||
      readlinkSync(journal.currentPointerPath, 'utf8') !== journal.candidateCurrentTarget ||
      !exactFileDigest(journal.plistPath, journal.candidatePlistSha256, homePath)) {
      throw new Error('runtime activation settled state drifted and requires reconciliation');
    }
    requireFences();
    removeJournal(homePath);
    return 'settled';
  }
  const currentTarget = (() => {
    try { return readlinkSync(journal.currentPointerPath, 'utf8'); } catch { return null; }
  })();
  if (currentTarget === journal.candidateCurrentTarget) {
    requireFences();
    cooperativePointerCas(journal.currentPointerPath, journal.candidateCurrentTarget, journal.priorCurrentTarget);
  } else if (currentTarget !== journal.priorCurrentTarget) {
    throw new Error('runtime activation recovery found an interleaved current pointer');
  }
  const priorBytes = Buffer.from(journal.priorPlistBase64, 'base64url');
  if (!exactFileDigest(journal.plistPath, journal.priorPlistSha256, homePath)) {
    requireFences();
    replaceStoppedPlist(homePath, priorBytes.toString('utf8'), journal.priorServiceDisabled, observe);
    requireFences();
  }
  requireFences();
  const restoredService = observe();
  if (!exactFileDigest(journal.plistPath, journal.priorPlistSha256, homePath) ||
    readlinkSync(journal.currentPointerPath, 'utf8') !== journal.priorCurrentTarget ||
    restoredService.loaded !== false || restoredService.disabled !== journal.priorServiceDisabled) {
    throw new Error('runtime activation recovery could not restore the exact prior stopped state');
  }
  requireFences();
  removeJournal(homePath);
  return 'restored';
}

function recoverExistingStoppedRuntimeRelease(
  homePath: string,
): RuntimeActivationStoppedResult | null {
  if (!existsSync(journalPath(homePath))) return null;
  const observeLaunchd = runtimeActivationStoppedRuntime.observeLaunchd;
  const observeMaintenance = () => runtimeActivationStoppedRuntime.observeMaintenance(homePath);
  const acquireOutward = runtimeActivationStoppedRuntime.acquireOutward;
  const ownsOutward = runtimeActivationStoppedRuntime.ownsOutward;
  const releaseOutward = runtimeActivationStoppedRuntime.releaseOutward;
  const acquireLifecycle = () => runtimeActivationStoppedRuntime.acquireLifecycle(homePath);
  const ownsLifecycle = runtimeActivationStoppedRuntime.ownsLifecycle;
  const releaseLifecycle = runtimeActivationStoppedRuntime.releaseLifecycle;
  const journalKey = runtimeActivationStoppedRuntime.journalKey();
  if (!journalKey) {
    return blocked('runtime activation recovery journal key is unavailable', false, null, true, undefined, 'none', true);
  }
  let outward: object | null = null;
  let lifecycle: object | null = null;
  let permitId: string | null = null;
  let journalBoundIdentity: RuntimeActivationStoppedIdentity | undefined;
  const requireFences = (): void => {
    if (!outward || !lifecycle || !ownsOutward(outward) || !ownsLifecycle(lifecycle)) {
      throw new Error('runtime activation recovery fence ownership was lost');
    }
  };
  try {
    if (journalKey.length !== 32) {
      return blocked('runtime activation recovery journal key is invalid', false, null, true, undefined, 'none', true);
    }
    inspectPrivateRoots(homePath, false);
    outward = acquireOutward();
    if (!outward || !ownsOutward(outward)) throw new Error('runtime activation recovery outward fence is unavailable');
    lifecycle = acquireLifecycle();
    if (!lifecycle || !ownsLifecycle(lifecycle)) throw new Error('runtime activation recovery lifecycle fence is unavailable');
    const maintenance = observeMaintenance();
    if (!maintenance.ok || maintenance.daemonRoots !== 0 || maintenance.daemonDescendants !== 0) {
      throw new Error(maintenance.reason || 'runtime activation recovery maintenance is not quiescent');
    }
    const journal = readJournal(homePath, journalKey);
    if (!journal) throw new Error('runtime activation recovery journal disappeared');
    permitId = journal.permitId;
    journalBoundIdentity = journalIdentity(journal);
    if (!ownsOutward(outward) || !ownsLifecycle(lifecycle)) {
      throw new Error('runtime activation recovery fence ownership was lost');
    }
    const service = observeLaunchd();
    if (service.loaded !== false || service.disabled !== journal.priorServiceDisabled) {
      throw new Error('runtime activation recovery launchd state is not exact');
    }
    if (!ownsOutward(outward) || !ownsLifecycle(lifecycle)) {
      throw new Error('runtime activation recovery fence ownership was lost');
    }
    const recovered = restoreJournal(homePath, journal, observeLaunchd, requireFences);
    if (recovered === 'settled') {
      return settledCandidate(
        homePath,
        journalBoundIdentity,
        permitId,
        'authenticated stopped-release receipt settled after restart without new mutation authority',
        true,
      );
    }
    return blocked(
      'authenticated stopped-release journal restored the exact prior stopped state after restart',
      true,
      permitId,
      false,
      journalBoundIdentity,
      'restored-prior',
      true,
    );
  } catch (error) {
    return blocked(
      `runtime activation recovery requires reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      false,
      permitId,
      true,
      journalBoundIdentity,
      'none',
      true,
    );
  } finally {
    if (lifecycle) releaseLifecycle(lifecycle);
    if (outward) releaseOutward(outward);
    journalKey.fill(0);
  }
}

function activateVerifiedStoppedRuntimeRelease(
  plan: RuntimeActivationStoppedPlan,
  homePath: string,
  revalidateAdmission: () => boolean,
): RuntimeActivationStoppedResult {
  const recovery = recoverExistingStoppedRuntimeRelease(homePath);
  if (recovery) return recovery;
  const roots = runtimeActivationStoppedRuntime.roots;
  if (roots.length === 0) return blocked('runtime activation stopped consumer authority is unprovisioned');
  const payload = plan.request.signedManifest.payload;
  let envelope: RuntimeActivationStoppedPermitEnvelopeV1;
  try { envelope = readPermit(homePath, payload.planId); } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
  const nowMs = runtimeActivationStoppedRuntime.nowMs();
  const permitReason = verifyPermit(envelope, roots, nowMs) ?? bindPermit(plan, envelope);
  if (permitReason) return blocked(permitReason, false, envelope.payload.permitId);

  const observeLaunchd = runtimeActivationStoppedRuntime.observeLaunchd;
  const observeMaintenance = () => runtimeActivationStoppedRuntime.observeMaintenance(homePath);
  const acquireOutward = runtimeActivationStoppedRuntime.acquireOutward;
  const ownsOutward = runtimeActivationStoppedRuntime.ownsOutward;
  const releaseOutward = runtimeActivationStoppedRuntime.releaseOutward;
  const acquireLifecycle = () => runtimeActivationStoppedRuntime.acquireLifecycle(homePath);
  const ownsLifecycle = runtimeActivationStoppedRuntime.ownsLifecycle;
  const releaseLifecycle = runtimeActivationStoppedRuntime.releaseLifecycle;

  let outward: object | null = null;
  let lifecycle: object | null = null;
  const journalKey = runtimeActivationStoppedRuntime.journalKey();
  if (!journalKey) return blocked('runtime activation stopped consumer journal key is unavailable', false, envelope.payload.permitId);
  let mutationStarted = false;
  let rollbackRestored = false;
  let recoveryJournalObserved = false;
  const fencesOwned = (): boolean => Boolean(
    outward && lifecycle && ownsOutward(outward) && ownsLifecycle(lifecycle),
  );
  const requireFences = (): void => {
    if (!fencesOwned()) throw new Error('runtime activation fence ownership was lost');
  };
  try {
    if (journalKey.length !== 32) {
      return blocked('runtime activation stopped consumer journal key is invalid', false, envelope.payload.permitId);
    }
    inspectPrivateRoots(homePath);
    outward = acquireOutward();
    if (!outward || !ownsOutward(outward)) throw new Error('runtime activation outward maintenance fence is unavailable');
    lifecycle = acquireLifecycle();
    if (!lifecycle || !ownsLifecycle(lifecycle)) throw new Error('runtime activation daemon lifecycle fence is unavailable');
    const maintenance = observeMaintenance();
    if (!maintenance.ok || maintenance.daemonRoots !== 0 || maintenance.daemonDescendants !== 0) {
      throw new Error(maintenance.reason || 'runtime activation maintenance is not quiescent');
    }
    const service = observeLaunchd();
    if (service.loaded !== false || service.disabled !== envelope.payload.bindings.priorServiceDisabled) {
      throw new Error('runtime activation launchd state does not match the explicit permit');
    }
    recoveryJournalObserved = existsSync(journalPath(homePath));
    let existingJournal: RuntimeActivationStoppedJournalV1 | null;
    try {
      existingJournal = readJournal(homePath, journalKey);
    } catch (error) {
      // readJournal only throws after it has observed a journal path. Preserve
      // that fact even when the path arrived after the pre-read observation.
      recoveryJournalObserved = true;
      throw error;
    }
    if (existingJournal) recoveryJournalObserved = true;
    if (recoveryJournalObserved && !existingJournal) {
      throw new Error('runtime activation raced recovery journal disappeared');
    }
    if (existingJournal) {
      requireFences();
      const recovered = restoreJournal(homePath, existingJournal, observeLaunchd, requireFences);
      if (recovered === 'settled') {
        return settledCandidate(
          homePath,
          journalIdentity(existingJournal),
          existingJournal.permitId,
          'authenticated raced stopped-release receipt settled without relabeling it as the supplied plan',
          true,
        );
      }
      return blocked(
        'authenticated raced stopped-release journal restored the exact prior stopped state',
        true,
        existingJournal.permitId,
        false,
        journalIdentity(existingJournal),
        'restored-prior',
        true,
      );
    }
    if (!revalidateAdmission()) throw new Error('runtime activation exact admission changed before stopped selection');

    const pointerPath = payload.execution.currentPointerPath;
    const priorTarget = envelope.payload.bindings.priorCurrentTarget;
    const candidateTarget = rawReleaseTarget(payload.candidate.expectedRevision);
    inspectCurrentPointer(pointerPath, priorTarget);
    const priorPlist = readExactPrivateFile(
      plistPath(homePath),
      envelope.payload.bindings.priorPlistSha256,
      homePath,
    );
    const candidatePlistSha256 = sha256(plan.candidateServiceDescriptor);
    requireFences();
    const claim = recordFor('claim', plan, envelope.payload.permitId);
    const claimDisposition = writeImmutablePrivateRecord(recordStore(homePath), claim);
    if (claimDisposition !== 'recorded') {
      throw new Error(`runtime activation stopped permit claim was ${claimDisposition}`);
    }
    let journal = journalWithAttestation({
      schemaVersion: 1,
      protocol: PROTOCOL,
      phase: 'prepared',
      sequence: 1,
      predecessorDigest: '0'.repeat(64),
      activationId: payload.planId,
      permitId: envelope.payload.permitId,
      admissionDigest: plan.preflight.plan.admissionDigest!,
      planDigest: plan.preflight.plan.planDigest!,
      candidateRevision: payload.candidate.expectedRevision,
      currentPointerPath: pointerPath,
      priorCurrentTarget: priorTarget,
      candidateCurrentTarget: candidateTarget,
      plistPath: plistPath(homePath),
      priorPlistBase64: priorPlist.toString('base64url'),
      priorPlistSha256: envelope.payload.bindings.priorPlistSha256,
      candidatePlistSha256,
      priorServiceDisabled: service.disabled,
      priorServiceLoaded: false,
    }, journalKey);
    writeJournal(homePath, journal);
    mutationStarted = true;

    requireFences();
    replaceStoppedPlist(homePath, plan.candidateServiceDescriptor, service.disabled, observeLaunchd);
    if (!exactFileDigest(plistPath(homePath), candidatePlistSha256, homePath)) {
      throw new Error('runtime activation candidate plist did not settle exactly');
    }
    journal = journalWithAttestation({
      ...journalUnsigned(journal),
      phase: 'plist-replaced',
      sequence: 2,
      predecessorDigest: journal.recordDigest,
    }, journalKey);
    writeJournal(homePath, journal);

    requireFences();
    if (!revalidateAdmission()) throw new Error('runtime activation exact admission changed before pointer selection');
    cooperativePointerCas(pointerPath, priorTarget, candidateTarget);
    journal = journalWithAttestation({
      ...journalUnsigned(journal),
      phase: 'pointer-switched',
      sequence: 3,
      predecessorDigest: journal.recordDigest,
    }, journalKey);
    writeJournal(homePath, journal);

    requireFences();
    if (!revalidateAdmission()) throw new Error('runtime activation exact admission changed before settlement');
    const finalMaintenance = observeMaintenance();
    const finalService = observeLaunchd();
    if (!finalMaintenance.ok || finalMaintenance.daemonRoots !== 0 || finalMaintenance.daemonDescendants !== 0 ||
      finalService.loaded !== false || finalService.disabled !== service.disabled ||
      readlinkSync(pointerPath, 'utf8') !== candidateTarget ||
      !exactFileDigest(plistPath(homePath), candidatePlistSha256, homePath)) {
      throw new Error('runtime activation stopped settlement revalidation failed');
    }
    requireFences();
    if (!revalidateAdmission()) throw new Error('runtime activation exact admission changed before receipt');
    const receipt = recordFor('receipt', plan, envelope.payload.permitId);
    const receiptDisposition = writeImmutablePrivateRecord(recordStore(homePath), receipt);
    if (receiptDisposition !== 'recorded') {
      throw new Error(`runtime activation stopped receipt was ${receiptDisposition}`);
    }
    requireFences();
    if (!revalidateAdmission()) throw new Error('runtime activation exact admission changed after receipt');
    const settledMaintenance = observeMaintenance();
    const settledService = observeLaunchd();
    if (!settledMaintenance.ok || settledMaintenance.daemonRoots !== 0 || settledMaintenance.daemonDescendants !== 0 ||
      settledService.loaded !== false || settledService.disabled !== service.disabled ||
      readlinkSync(pointerPath, 'utf8') !== candidateTarget ||
      !exactFileDigest(plistPath(homePath), candidatePlistSha256, homePath)) {
      throw new Error('runtime activation stopped post-receipt state requires reconciliation');
    }
    requireFences();
    removeJournal(homePath);
    mutationStarted = false;
    return {
      ...planIdentity(plan),
      activated: true,
      serviceStarted: false,
      serviceEnabledChanged: false,
      phase: 'activated-stopped',
      reason: 'verified 3.2.7 release selected while preserving the exact stopped service state',
      rollbackRestored: false,
      recoveryJournalRetained: false,
      recoveryJournalObserved: false,
      durableOutcome: 'settled-candidate',
      permitId: envelope.payload.permitId,
      receiptPath: join(recordStore(homePath).rootPath, 'records', `receipt-${envelope.payload.permitId}.json`),
    };
  } catch (error) {
    if (mutationStarted) {
      if (!fencesOwned()) {
        return blocked(
          `${error instanceof Error ? error.message : String(error)}; exact stopped rollback requires reconciliation: fence ownership lost`,
          false,
          envelope.payload.permitId,
          true,
        );
      }
      try {
        const journal = readJournal(homePath, journalKey);
        if (!journal) throw new Error('runtime activation journal disappeared during rollback');
        const recovery = restoreJournal(homePath, journal, observeLaunchd, requireFences);
        if (recovery === 'settled') {
          return settledCandidate(
            homePath,
            journalIdentity(journal),
            envelope.payload.permitId,
            `${error instanceof Error ? error.message : String(error)}; durable stopped settlement was retained`,
            false,
          );
        }
        rollbackRestored = true;
      } catch (rollbackError) {
        return blocked(
          `${error instanceof Error ? error.message : String(error)}; exact stopped rollback requires reconciliation: ` +
          `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          false,
          envelope.payload.permitId,
          true,
        );
      }
    }
    return blocked(
      error instanceof Error ? error.message : String(error),
      rollbackRestored,
      recoveryJournalObserved ? null : envelope.payload.permitId,
      recoveryJournalObserved,
      recoveryJournalObserved ? undefined : planIdentity(plan),
      rollbackRestored ? 'restored-prior' : 'none',
      recoveryJournalObserved,
    );
  } finally {
    if (lifecycle) releaseLifecycle(lifecycle);
    if (outward) releaseOutward(outward);
    journalKey.fill(0);
  }
}

export function recoverStoppedRuntimeReleaseForTransaction(
  homePath: string,
): RuntimeActivationStoppedResult | null {
  return recoverExistingStoppedRuntimeRelease(homePath);
}

export function consumeStoppedRuntimeReleaseForTransaction(
  plan: RuntimeActivationStoppedPlan,
  homePath: string,
  revalidateAdmission: () => boolean,
): RuntimeActivationStoppedResult {
  return activateVerifiedStoppedRuntimeRelease(plan, homePath, revalidateAdmission);
}

export const runtimeActivationStoppedConsumerInternals = {
  PROTOCOL,
  permitPath,
  journalPath,
  parsePermit,
  verifyPermit,
  activityAllowsStoppedRecovery,
  observeMaintenanceDefault,
  recordStore,
};
