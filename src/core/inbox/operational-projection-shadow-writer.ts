import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { operationalProposalProjectionDir } from './operational-projection.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

const SCHEMA_VERSION = 2 as const;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const KEY_DOMAIN = 'ashlr.operational-projection-shadow-writer.key.v2';
const KEY_ID_DOMAIN = 'ashlr.operational-projection-shadow-writer.key-id.v2';
const RECORD_DOMAIN = 'ashlr.operational-projection-shadow-writer.record.v2';
const ID_DOMAIN = 'ashlr.operational-projection-shadow-writer.id.v2';

export type OperationalProjectionShadowArtifact = 'proposal' | 'projection';
export type OperationalProjectionShadowStage = 'before' | 'after';
export type OperationalProjectionShadowSlot = 'a' | 'b';
export type OperationalProjectionShadowPhase =
  | 'prepared'
  | 'proposal-installed'
  | 'projection-installed'
  | 'committed'
  | 'rolled-back';
export type OperationalProjectionShadowActualState =
  | 'no-effect'
  | 'proposal-only'
  | 'projection-only'
  | 'complete'
  | 'unknown'
  | 'unavailable';
export type OperationalProjectionShadowRequiredAction =
  | 'none'
  | 'rollback'
  | 'roll-forward'
  | 'refuse';

export interface OperationalProjectionShadowArtifactMetadataV2 {
  present: boolean;
  digest: string | null;
  bytes: number;
}

export interface OperationalProjectionShadowArtifactPairV2 {
  proposal: OperationalProjectionShadowArtifactMetadataV2;
  projection: OperationalProjectionShadowArtifactMetadataV2;
}

export interface OperationalProjectionShadowTransactionV2 {
  schemaVersion: 2;
  transactionId: string;
  signingKeyId: string;
  proposalId: string;
  stagingSlot: OperationalProjectionShadowSlot;
  phase: OperationalProjectionShadowPhase;
  /**
   * Host-local crash-recovery direction only. This is never evidence of an
   * external CAS, external acceptance, rollback protection, or authority.
   */
  localRollForwardRequired: boolean;
  historicalAuthority: false;
  rollbackProtected: false;
  operationalAuthority: false;
  before: OperationalProjectionShadowArtifactPairV2;
  after: OperationalProjectionShadowArtifactPairV2;
  createdAt: string;
  updatedAt: string;
  attestation: string;
}

export interface OperationalProjectionShadowInspection {
  state: 'missing' | 'healthy' | 'degraded';
  reason?: string;
  transaction: OperationalProjectionShadowTransactionV2 | null;
  actual: OperationalProjectionShadowActualState;
  requiredAction: OperationalProjectionShadowRequiredAction;
  historicalAuthority: false;
  rollbackProtected: false;
  operationalAuthority: false;
}

export interface PrepareOperationalProjectionShadowWriteInput {
  proposalId: string;
  proposalBytes: Buffer;
  projectionBytes: Buffer;
  storeLock: ProposalStoreMutationLock;
  now?: Date;
}

export type OperationalProjectionShadowWriterHookPoint =
  | 'after-staged'
  | 'after-prepared'
  | 'before-proposal-publish'
  | 'after-proposal-publish'
  | 'after-proposal-installed'
  | 'before-projection-publish'
  | 'after-projection-publish'
  | 'after-projection-installed'
  | 'after-committed'
  | 'after-roll-forward-required-marked'
  | 'after-rollback-projection'
  | 'after-rollback-proposal'
  | 'after-rolled-back';

type TestHook = (point: OperationalProjectionShadowWriterHookPoint) => 'crash' | void;

interface ArtifactData {
  metadata: OperationalProjectionShadowArtifactMetadataV2;
  value: Buffer | null;
}

interface ArtifactPairData {
  proposal: ArtifactData;
  projection: ArtifactData;
}

interface SigningContext {
  key: Buffer;
  id: string;
}

class InjectedShadowWriterCrash extends Error {}

let testHook: TestHook | undefined;

const NO_AUTHORITY = {
  historicalAuthority: false as const,
  rollbackProtected: false as const,
  operationalAuthority: false as const,
};

const PHASE_ORDER: Exclude<OperationalProjectionShadowPhase, 'rolled-back'>[] = [
  'prepared',
  'proposal-installed',
  'projection-installed',
  'committed',
];

function runHook(point: OperationalProjectionShadowWriterHookPoint): void {
  if (testHook?.(point) === 'crash') throw new InjectedShadowWriterCrash(point);
}

/** Test-only deterministic crash and replacement-race injection. */
export function _setOperationalProjectionShadowWriterHookForTest(
  hook: TestHook | undefined,
): void {
  testHook = hook;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 &&
    PROPOSAL_ID_RE.test(value) && value !== '.' && value !== '..';
}

function validArtifactMetadata(
  value: unknown,
): value is OperationalProjectionShadowArtifactMetadataV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['present', 'digest', 'bytes']) ||
    typeof record['present'] !== 'boolean' ||
    !Number.isSafeInteger(record['bytes']) ||
    (record['bytes'] as number) < 0 ||
    (record['bytes'] as number) > MAX_ARTIFACT_BYTES) return false;
  return record['present']
    ? typeof record['digest'] === 'string' && DIGEST_RE.test(record['digest']) &&
      (record['bytes'] as number) > 0
    : record['digest'] === null && record['bytes'] === 0;
}

function validArtifactPair(value: unknown): value is OperationalProjectionShadowArtifactPairV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['proposal', 'projection']) &&
    validArtifactMetadata(record['proposal']) &&
    validArtifactMetadata(record['projection']);
}

function validPhase(value: unknown): value is OperationalProjectionShadowPhase {
  return typeof value === 'string' &&
    (PHASE_ORDER.includes(value as Exclude<OperationalProjectionShadowPhase, 'rolled-back'>) ||
      value === 'rolled-back');
}

function validSlot(value: unknown): value is OperationalProjectionShadowSlot {
  return value === 'a' || value === 'b';
}

function unsignedRecord(
  value: OperationalProjectionShadowTransactionV2,
): Omit<OperationalProjectionShadowTransactionV2, 'attestation'> {
  const { attestation: _attestation, ...unsigned } = value;
  return unsigned;
}

function canonicalRecord(
  value: Omit<OperationalProjectionShadowTransactionV2, 'attestation'>,
): string {
  return JSON.stringify({
    after: value.after,
    before: value.before,
    createdAt: value.createdAt,
    historicalAuthority: value.historicalAuthority,
    localRollForwardRequired: value.localRollForwardRequired,
    operationalAuthority: value.operationalAuthority,
    phase: value.phase,
    proposalId: value.proposalId,
    rollbackProtected: value.rollbackProtected,
    schemaVersion: value.schemaVersion,
    signingKeyId: value.signingKeyId,
    stagingSlot: value.stagingSlot,
    transactionId: value.transactionId,
    updatedAt: value.updatedAt,
  });
}

function signingKey(provenanceKey: Buffer): Buffer {
  return createHmac('sha256', provenanceKey)
    .update(KEY_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .digest();
}

function keyId(key: Buffer): string {
  return createHmac('sha256', key)
    .update(KEY_ID_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .digest('hex');
}

function attest(
  key: Buffer,
  value: Omit<OperationalProjectionShadowTransactionV2, 'attestation'>,
): string {
  return createHmac('sha256', key)
    .update(RECORD_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalRecord(value), 'utf8')
    .digest('hex');
}

function loadSigningContext(): SigningContext | null {
  try {
    const provenanceKey = loadExistingProvenanceKeyReadOnly();
    if (!provenanceKey || provenanceKey.length !== 32) return null;
    const key = signingKey(provenanceKey);
    return { key, id: keyId(key) };
  } catch {
    return null;
  }
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) && DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseRecord(text: string): OperationalProjectionShadowTransactionV2 | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!exactKeys(value, [
      'schemaVersion',
      'transactionId',
      'signingKeyId',
      'proposalId',
      'stagingSlot',
      'phase',
      'localRollForwardRequired',
      'historicalAuthority',
      'rollbackProtected',
      'operationalAuthority',
      'before',
      'after',
      'createdAt',
      'updatedAt',
      'attestation',
    ]) ||
      value['schemaVersion'] !== SCHEMA_VERSION ||
      typeof value['transactionId'] !== 'string' || !DIGEST_RE.test(value['transactionId']) ||
      typeof value['signingKeyId'] !== 'string' || !DIGEST_RE.test(value['signingKeyId']) ||
      !validProposalId(value['proposalId']) ||
      !validSlot(value['stagingSlot']) ||
      !validPhase(value['phase']) ||
      typeof value['localRollForwardRequired'] !== 'boolean' ||
      value['historicalAuthority'] !== false ||
      value['rollbackProtected'] !== false ||
      value['operationalAuthority'] !== false ||
      !validArtifactPair(value['before']) ||
      !validArtifactPair(value['after']) ||
      !canonicalTimestamp(value['createdAt']) ||
      !canonicalTimestamp(value['updatedAt']) ||
      Date.parse(value['updatedAt']) < Date.parse(value['createdAt']) ||
      typeof value['attestation'] !== 'string' || !DIGEST_RE.test(value['attestation'])) {
      return null;
    }
    if (value['phase'] === 'rolled-back' && value['localRollForwardRequired']) return null;
    return value as unknown as OperationalProjectionShadowTransactionV2;
  } catch {
    return null;
  }
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function metadata(value: Buffer | null): OperationalProjectionShadowArtifactMetadataV2 {
  return value === null
    ? { present: false, digest: null, bytes: 0 }
    : { present: true, digest: digest(value), bytes: value.length };
}

function metadataEqual(
  left: OperationalProjectionShadowArtifactMetadataV2,
  right: OperationalProjectionShadowArtifactMetadataV2,
): boolean {
  return left.present === right.present && left.bytes === right.bytes &&
    (left.digest === null
      ? right.digest === null
      : right.digest !== null && equalDigest(left.digest, right.digest));
}

function pairMetadata(value: ArtifactPairData): OperationalProjectionShadowArtifactPairV2 {
  return {
    proposal: value.proposal.metadata,
    projection: value.projection.metadata,
  };
}

function pairEqual(
  left: OperationalProjectionShadowArtifactPairV2,
  right: OperationalProjectionShadowArtifactPairV2,
): boolean {
  return metadataEqual(left.proposal, right.proposal) &&
    metadataEqual(left.projection, right.projection);
}

function validJsonBytes(value: Buffer): boolean {
  if (value.length <= 0 || value.length > MAX_ARTIFACT_BYTES) return false;
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function proposalBytesMatchId(value: Buffer, proposalId: string): boolean {
  if (!validJsonBytes(value)) return false;
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
    return parsed['id'] === proposalId;
  } catch {
    return false;
  }
}

function safeDirectory(path: string, anchorPath: string): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
    if (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o700) return false;
    return assurePrivateStoragePath(path, 'directory', 'inspect-existing', {
      anchorPath,
    }).ok;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(path: string, anchorPath: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created && process.platform !== 'win32') chmodSync(path, 0o700);
  if (!safeDirectory(path, anchorPath)) throw new Error('shadow-directory-unsafe');
  const assurance = assurePrivateStoragePath(
    path,
    'directory',
    created ? 'secure-created' : 'inspect-existing',
    { anchorPath },
  );
  if (!assurance.ok) throw new Error('shadow-directory-unsafe');
  if (created) fsyncDirectory(dirname(path));
}

function assureWriterDirectories(): void {
  const home = resolve(homedir());
  const projection = operationalProposalProjectionDir();
  const ashlrRoot = dirname(projection);
  ensurePrivateDirectory(ashlrRoot, home);
  ensurePrivateDirectory(projection, ashlrRoot);
  ensurePrivateDirectory(operationalProjectionShadowWriterRoot(), projection);
  ensurePrivateDirectory(operationalProjectionShadowCurrentDir(), operationalProjectionShadowWriterRoot());
  ensurePrivateDirectory(operationalProjectionShadowStagingRoot(), operationalProjectionShadowWriterRoot());
  ensurePrivateDirectory(
    join(operationalProjectionShadowStagingRoot(), 'a'),
    operationalProjectionShadowStagingRoot(),
  );
  ensurePrivateDirectory(
    join(operationalProjectionShadowStagingRoot(), 'b'),
    operationalProjectionShadowStagingRoot(),
  );
}

export function operationalProjectionShadowWriterRoot(): string {
  return join(operationalProposalProjectionDir(), 'shadow-writer-v2');
}

export function operationalProjectionShadowJournalPath(): string {
  return join(operationalProjectionShadowWriterRoot(), 'active.json');
}

export function operationalProjectionShadowCurrentDir(): string {
  return join(operationalProjectionShadowWriterRoot(), 'current');
}

export function operationalProjectionShadowStagingRoot(): string {
  return join(operationalProjectionShadowWriterRoot(), 'staged');
}

export function operationalProjectionShadowCurrentPath(
  artifact: OperationalProjectionShadowArtifact,
): string {
  if (artifact !== 'proposal' && artifact !== 'projection') {
    throw new TypeError('invalid shadow artifact');
  }
  return join(operationalProjectionShadowCurrentDir(), `${artifact}.json`);
}

export function operationalProjectionShadowStagedPath(
  slot: OperationalProjectionShadowSlot,
  artifact: OperationalProjectionShadowArtifact,
  stage: OperationalProjectionShadowStage,
): string {
  if (!validSlot(slot) ||
    (artifact !== 'proposal' && artifact !== 'projection') ||
    (stage !== 'before' && stage !== 'after')) {
    throw new TypeError('invalid shadow staging path');
  }
  return join(operationalProjectionShadowStagingRoot(), slot, `${artifact}.${stage}.json`);
}

function readArtifact(path: string, anchorPath: string): ArtifactData {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { metadata: metadata(null), value: null };
    }
    throw new Error('shadow-artifact-unavailable');
  }
  const read = readStableRegularFile(path, {
    anchorPath,
    maxFileBytes: MAX_ARTIFACT_BYTES,
    remainingBytes: MAX_ARTIFACT_BYTES,
  });
  if (!read.ok) throw new Error(`shadow-artifact-${read.reason}`);
  const value = Buffer.from(read.text, 'utf8');
  if (value.length !== read.bytesRead) throw new Error('shadow-artifact-invalid-utf8');
  return { metadata: metadata(value), value };
}

function readCurrentPair(): ArtifactPairData {
  if (!safeDirectory(
    operationalProjectionShadowCurrentDir(),
    operationalProjectionShadowWriterRoot(),
  )) throw new Error('shadow-current-directory-unsafe');
  return {
    proposal: readArtifact(
      operationalProjectionShadowCurrentPath('proposal'),
      operationalProjectionShadowWriterRoot(),
    ),
    projection: readArtifact(
      operationalProjectionShadowCurrentPath('projection'),
      operationalProjectionShadowWriterRoot(),
    ),
  };
}

function stagedPair(
  transaction: OperationalProjectionShadowTransactionV2,
  stage: OperationalProjectionShadowStage,
): ArtifactPairData {
  const slotDir = join(operationalProjectionShadowStagingRoot(), transaction.stagingSlot);
  if (!safeDirectory(slotDir, operationalProjectionShadowWriterRoot())) {
    throw new Error('shadow-staging-directory-unsafe');
  }
  const pair: ArtifactPairData = {
    proposal: readArtifact(
      operationalProjectionShadowStagedPath(transaction.stagingSlot, 'proposal', stage),
      operationalProjectionShadowWriterRoot(),
    ),
    projection: readArtifact(
      operationalProjectionShadowStagedPath(transaction.stagingSlot, 'projection', stage),
      operationalProjectionShadowWriterRoot(),
    ),
  };
  if (!pairEqual(pairMetadata(pair), transaction[stage])) {
    throw new Error('shadow-staging-integrity-failed');
  }
  return pair;
}

function atomicWrite(targetPath: string, value: Buffer | string, label: string): void {
  const parent = dirname(targetPath);
  const temporaryPath = join(parent, `.${label}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  writePrivateFileAtomically(temporaryPath, targetPath, value, {
    anchorPath: parent,
    label,
  });
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeExactArtifact(path: string, anchorPath: string): void {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  readArtifact(path, anchorPath);
  const after = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n ||
    !sameIdentity(before, after)) throw new Error('shadow-artifact-replaced');
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function readJournal():
  | { state: 'missing'; transaction: null }
  | { state: 'healthy'; transaction: OperationalProjectionShadowTransactionV2 }
  | { state: 'degraded'; reason: string; transaction: null } {
  const root = operationalProjectionShadowWriterRoot();
  const path = operationalProjectionShadowJournalPath();
  try {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { state: 'degraded', reason: 'shadow-journal-unavailable', transaction: null };
      }
      try {
        lstatSync(root);
      } catch (rootError) {
        return (rootError as NodeJS.ErrnoException).code === 'ENOENT'
          ? { state: 'missing', transaction: null }
          : { state: 'degraded', reason: 'shadow-directory-unsafe', transaction: null };
      }
      return safeDirectory(root, operationalProposalProjectionDir())
        ? { state: 'missing', transaction: null }
        : { state: 'degraded', reason: 'shadow-directory-unsafe', transaction: null };
    }
    if (!safeDirectory(root, operationalProposalProjectionDir())) {
      return { state: 'degraded', reason: 'shadow-directory-unsafe', transaction: null };
    }
    const read = readStableRegularFile(path, {
      anchorPath: operationalProposalProjectionDir(),
      maxFileBytes: MAX_JOURNAL_BYTES,
      remainingBytes: MAX_JOURNAL_BYTES,
    });
    if (!read.ok) {
      return { state: 'degraded', reason: `shadow-journal-${read.reason}`, transaction: null };
    }
    const transaction = parseRecord(read.text);
    if (!transaction) {
      return { state: 'degraded', reason: 'shadow-journal-invalid', transaction: null };
    }
    const signing = loadSigningContext();
    if (!signing) {
      return { state: 'degraded', reason: 'shadow-journal-key-unavailable', transaction: null };
    }
    if (!equalDigest(transaction.signingKeyId, signing.id)) {
      return { state: 'degraded', reason: 'shadow-journal-key-mismatch', transaction: null };
    }
    if (!equalDigest(attest(signing.key, unsignedRecord(transaction)), transaction.attestation)) {
      return { state: 'degraded', reason: 'shadow-journal-integrity-failed', transaction: null };
    }
    return { state: 'healthy', transaction };
  } catch {
    return { state: 'degraded', reason: 'shadow-journal-unavailable', transaction: null };
  }
}

function classify(
  transaction: OperationalProjectionShadowTransactionV2,
  actual: OperationalProjectionShadowArtifactPairV2,
): Exclude<OperationalProjectionShadowActualState, 'unavailable'> {
  const proposalBefore = metadataEqual(actual.proposal, transaction.before.proposal);
  const proposalAfter = metadataEqual(actual.proposal, transaction.after.proposal);
  const projectionBefore = metadataEqual(actual.projection, transaction.before.projection);
  const projectionAfter = metadataEqual(actual.projection, transaction.after.projection);
  if (proposalBefore && projectionBefore) return 'no-effect';
  if (proposalAfter && projectionBefore) return 'proposal-only';
  if (proposalBefore && projectionAfter) return 'projection-only';
  if (proposalAfter && projectionAfter) return 'complete';
  return 'unknown';
}

function requiredAction(
  transaction: OperationalProjectionShadowTransactionV2,
  actual: Exclude<OperationalProjectionShadowActualState, 'unavailable'>,
): OperationalProjectionShadowRequiredAction {
  if (actual === 'unknown') return 'refuse';
  if (transaction.phase === 'committed' && actual === 'complete') return 'none';
  if (transaction.phase === 'rolled-back' && actual === 'no-effect') return 'none';
  return transaction.localRollForwardRequired ? 'roll-forward' : 'rollback';
}

function degradedInspection(
  reason: string,
  transaction: OperationalProjectionShadowTransactionV2 | null = null,
  actual: OperationalProjectionShadowActualState = 'unavailable',
  action: OperationalProjectionShadowRequiredAction = 'refuse',
): OperationalProjectionShadowInspection {
  return {
    state: 'degraded',
    reason,
    transaction,
    actual,
    requiredAction: action,
    ...NO_AUTHORITY,
  };
}

export function inspectOperationalProjectionShadowWrite():
OperationalProjectionShadowInspection {
  const journal = readJournal();
  if (journal.state === 'missing') {
    return {
      state: 'missing',
      transaction: null,
      actual: 'unavailable',
      requiredAction: 'none',
      ...NO_AUTHORITY,
    };
  }
  if (journal.state === 'degraded') return degradedInspection(journal.reason);
  const transaction = journal.transaction;
  try {
    const actual = classify(transaction, pairMetadata(readCurrentPair()));
    try {
      stagedPair(transaction, 'before');
      stagedPair(transaction, 'after');
    } catch {
      return degradedInspection(
        'shadow-staging-integrity-failed',
        transaction,
        actual,
        transaction.localRollForwardRequired ? 'roll-forward' : 'refuse',
      );
    }
    return {
      state: 'healthy',
      transaction,
      actual,
      requiredAction: requiredAction(transaction, actual),
      ...NO_AUTHORITY,
    };
  } catch {
    return degradedInspection('shadow-current-unavailable', transaction);
  }
}

function writeJournal(
  unsigned: Omit<OperationalProjectionShadowTransactionV2, 'attestation'>,
  signing: SigningContext,
  storeLock: ProposalStoreMutationLock,
): OperationalProjectionShadowTransactionV2 {
  if (!ownsProposalStoreMutationLock(storeLock) ||
    !equalDigest(unsigned.signingKeyId, signing.id)) {
    throw new Error('shadow-store-lock-not-owned');
  }
  const transaction = { ...unsigned, attestation: attest(signing.key, unsigned) };
  const json = `${JSON.stringify(transaction)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new Error('shadow-journal-too-large');
  }
  atomicWrite(operationalProjectionShadowJournalPath(), json, 'shadow-journal');
  if (!ownsProposalStoreMutationLock(storeLock)) throw new Error('shadow-store-lock-lost');
  const reread = readJournal();
  if (reread.state !== 'healthy' ||
    reread.transaction.transactionId !== transaction.transactionId ||
    reread.transaction.phase !== transaction.phase ||
    reread.transaction.localRollForwardRequired !== transaction.localRollForwardRequired ||
    !equalDigest(reread.transaction.attestation, transaction.attestation)) {
    throw new Error('shadow-journal-write-failed');
  }
  return transaction;
}

function nextTimestamp(transaction: OperationalProjectionShadowTransactionV2, now: Date): string {
  if (!Number.isFinite(now.getTime()) ||
    now.getTime() < Date.parse(transaction.updatedAt)) {
    throw new Error('shadow-time-invalid');
  }
  return now.toISOString();
}

function advancePhase(
  transaction: OperationalProjectionShadowTransactionV2,
  phase: Exclude<OperationalProjectionShadowPhase, 'rolled-back'>,
  signing: SigningContext,
  storeLock: ProposalStoreMutationLock,
  now: Date,
): OperationalProjectionShadowTransactionV2 {
  if (transaction.phase === 'rolled-back') throw new Error('shadow-phase-invalid');
  const current = PHASE_ORDER.indexOf(transaction.phase);
  const target = PHASE_ORDER.indexOf(phase);
  if (current < 0 || target < current || target > current + 1) {
    throw new Error('shadow-phase-invalid');
  }
  if (target === current) return transaction;
  return writeJournal({
    ...unsignedRecord(transaction),
    phase,
    updatedAt: nextTimestamp(transaction, now),
  }, signing, storeLock);
}

function installArtifact(
  artifact: OperationalProjectionShadowArtifact,
  desired: ArtifactData,
  before: OperationalProjectionShadowArtifactMetadataV2,
  after: OperationalProjectionShadowArtifactMetadataV2,
): void {
  const target = operationalProjectionShadowCurrentPath(artifact);
  const current = readArtifact(target, operationalProjectionShadowWriterRoot());
  if (metadataEqual(current.metadata, desired.metadata)) return;
  if (!metadataEqual(current.metadata, before) && !metadataEqual(current.metadata, after)) {
    throw new Error('shadow-replacement-race');
  }
  runHook(artifact === 'proposal'
    ? 'before-proposal-publish'
    : 'before-projection-publish');
  const rechecked = readArtifact(target, operationalProjectionShadowWriterRoot());
  if (!metadataEqual(rechecked.metadata, current.metadata)) {
    throw new Error('shadow-replacement-race');
  }
  if (desired.value === null) {
    removeExactArtifact(target, operationalProjectionShadowWriterRoot());
  } else {
    atomicWrite(target, desired.value, `shadow-${artifact}`);
  }
  runHook(artifact === 'proposal'
    ? 'after-proposal-publish'
    : 'after-projection-publish');
  const installed = readArtifact(target, operationalProjectionShadowWriterRoot());
  if (!metadataEqual(installed.metadata, desired.metadata)) {
    throw new Error('shadow-replacement-race');
  }
}

function stageArtifact(
  slot: OperationalProjectionShadowSlot,
  artifact: OperationalProjectionShadowArtifact,
  stage: OperationalProjectionShadowStage,
  data: ArtifactData,
): void {
  const path = operationalProjectionShadowStagedPath(slot, artifact, stage);
  if (data.value === null) {
    removeExactArtifact(path, operationalProjectionShadowWriterRoot());
  } else {
    atomicWrite(path, data.value, `shadow-${slot}-${artifact}-${stage}`);
  }
  const reread = readArtifact(path, operationalProjectionShadowWriterRoot());
  if (!metadataEqual(reread.metadata, data.metadata)) {
    throw new Error('shadow-staging-write-failed');
  }
}

function alternateSlot(
  transaction: OperationalProjectionShadowTransactionV2 | null,
): OperationalProjectionShadowSlot {
  return transaction?.stagingSlot === 'a' ? 'b' : 'a';
}

function operationFailure(
  error: unknown,
  transaction: OperationalProjectionShadowTransactionV2 | null = null,
): OperationalProjectionShadowInspection {
  if (error instanceof InjectedShadowWriterCrash) throw error;
  return degradedInspection(
    error instanceof Error && error.message.startsWith('shadow-')
      ? error.message
      : 'shadow-write-failed',
    transaction,
  );
}

export function prepareOperationalProjectionShadowWrite(
  input: PrepareOperationalProjectionShadowWriteInput,
): OperationalProjectionShadowInspection {
  if (!ownsProposalStoreMutationLock(input.storeLock) ||
    !validProposalId(input.proposalId) ||
    !Buffer.isBuffer(input.proposalBytes) ||
    !Buffer.isBuffer(input.projectionBytes) ||
    !proposalBytesMatchId(input.proposalBytes, input.proposalId) ||
    !validJsonBytes(input.projectionBytes)) {
    return degradedInspection('shadow-input-invalid');
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return degradedInspection('shadow-time-invalid');
  let prior: OperationalProjectionShadowTransactionV2 | null = null;
  try {
    assureWriterDirectories();
    const journal = readJournal();
    if (journal.state === 'degraded') return degradedInspection(journal.reason);
    if (journal.state === 'healthy') {
      prior = journal.transaction;
      if (prior.phase !== 'committed' && prior.phase !== 'rolled-back') {
        return degradedInspection('shadow-transaction-already-active', prior);
      }
      const terminal = inspectOperationalProjectionShadowWrite();
      if (terminal.state !== 'healthy') return terminal;
      if (terminal.requiredAction !== 'none') {
        return degradedInspection(
          'shadow-terminal-state-inconsistent',
          prior,
          terminal.actual,
          'refuse',
        );
      }
      if (now.getTime() < Date.parse(prior.updatedAt)) {
        return degradedInspection('shadow-time-invalid', prior);
      }
    }
    const signing = loadSigningContext();
    if (!signing) return degradedInspection('shadow-journal-key-unavailable');
    const beforeData = readCurrentPair();
    const afterData: ArtifactPairData = {
      proposal: { metadata: metadata(input.proposalBytes), value: input.proposalBytes },
      projection: { metadata: metadata(input.projectionBytes), value: input.projectionBytes },
    };
    const before = pairMetadata(beforeData);
    const after = pairMetadata(afterData);
    if (metadataEqual(before.proposal, after.proposal) ||
      metadataEqual(before.projection, after.projection)) {
      return degradedInspection('shadow-input-noop', prior);
    }
    const stagingSlot = alternateSlot(prior);
    for (const artifact of ['proposal', 'projection'] as const) {
      stageArtifact(stagingSlot, artifact, 'before', beforeData[artifact]);
      stageArtifact(stagingSlot, artifact, 'after', afterData[artifact]);
    }
    runHook('after-staged');
    const timestamp = now.toISOString();
    const transactionId = createHmac('sha256', signing.key)
      .update(ID_DOMAIN, 'utf8')
      .update('\n', 'utf8')
      .update(input.proposalId, 'utf8')
      .update('\n', 'utf8')
      .update(timestamp, 'utf8')
      .update('\n', 'utf8')
      .update(randomBytes(16))
      .digest('hex');
    writeJournal({
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      signingKeyId: signing.id,
      proposalId: input.proposalId,
      stagingSlot,
      phase: 'prepared',
      localRollForwardRequired: false,
      ...NO_AUTHORITY,
      before,
      after,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, signing, input.storeLock);
    runHook('after-prepared');
    return inspectOperationalProjectionShadowWrite();
  } catch (error) {
    return operationFailure(error, prior);
  }
}

function loadStages(transaction: OperationalProjectionShadowTransactionV2): {
  before: ArtifactPairData;
  after: ArtifactPairData;
} {
  return {
    before: stagedPair(transaction, 'before'),
    after: stagedPair(transaction, 'after'),
  };
}

function rollForward(
  initial: OperationalProjectionShadowTransactionV2,
  stages: { before: ArtifactPairData; after: ArtifactPairData },
  signing: SigningContext,
  storeLock: ProposalStoreMutationLock,
  now: Date,
): OperationalProjectionShadowTransactionV2 {
  let transaction = initial;
  installArtifact(
    'proposal',
    stages.after.proposal,
    transaction.before.proposal,
    transaction.after.proposal,
  );
  if (transaction.phase === 'prepared') {
    transaction = advancePhase(transaction, 'proposal-installed', signing, storeLock, now);
    runHook('after-proposal-installed');
  }
  installArtifact(
    'projection',
    stages.after.projection,
    transaction.before.projection,
    transaction.after.projection,
  );
  if (transaction.phase === 'proposal-installed') {
    transaction = advancePhase(transaction, 'projection-installed', signing, storeLock, now);
    runHook('after-projection-installed');
  }
  if (transaction.phase === 'projection-installed') {
    transaction = advancePhase(transaction, 'committed', signing, storeLock, now);
    runHook('after-committed');
  }
  return transaction;
}

export function commitOperationalProjectionShadowWrite(
  transactionId: string,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionShadowInspection {
  if (!DIGEST_RE.test(transactionId) || !ownsProposalStoreMutationLock(storeLock)) {
    return degradedInspection('shadow-input-invalid');
  }
  const inspected = inspectOperationalProjectionShadowWrite();
  if (inspected.state !== 'healthy' || !inspected.transaction) return inspected;
  if (inspected.transaction.transactionId !== transactionId) {
    return degradedInspection('shadow-transaction-identity-mismatch', inspected.transaction);
  }
  if (inspected.transaction.phase === 'rolled-back') {
    return degradedInspection('shadow-phase-invalid', inspected.transaction, inspected.actual);
  }
  if (inspected.actual === 'unknown') {
    return degradedInspection('shadow-replacement-race', inspected.transaction, inspected.actual);
  }
  try {
    const signing = loadSigningContext();
    if (!signing) throw new Error('shadow-journal-key-unavailable');
    rollForward(
      inspected.transaction,
      loadStages(inspected.transaction),
      signing,
      storeLock,
      now,
    );
    return inspectOperationalProjectionShadowWrite();
  } catch (error) {
    return operationFailure(error, inspected.transaction);
  }
}

/**
 * Require roll-forward for this host-local shadow transaction's crash recovery.
 * This directive is never evidence of an external CAS or acceptance, never a
 * remote receipt, and cannot upgrade rollback protection or authority.
 */
export function markOperationalProjectionShadowRollForwardRequired(
  transactionId: string,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionShadowInspection {
  if (!DIGEST_RE.test(transactionId) || !ownsProposalStoreMutationLock(storeLock)) {
    return degradedInspection('shadow-input-invalid');
  }
  const inspected = inspectOperationalProjectionShadowWrite();
  if (inspected.state !== 'healthy' || !inspected.transaction) return inspected;
  const transaction = inspected.transaction;
  if (transaction.transactionId !== transactionId) {
    return degradedInspection('shadow-transaction-identity-mismatch', transaction);
  }
  if (transaction.phase === 'rolled-back') {
    return degradedInspection('shadow-phase-invalid', transaction, inspected.actual);
  }
  if (transaction.localRollForwardRequired) return inspected;
  try {
    const signing = loadSigningContext();
    if (!signing) throw new Error('shadow-journal-key-unavailable');
    writeJournal({
      ...unsignedRecord(transaction),
      localRollForwardRequired: true,
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
      updatedAt: nextTimestamp(transaction, now),
    }, signing, storeLock);
    runHook('after-roll-forward-required-marked');
    return inspectOperationalProjectionShadowWrite();
  } catch (error) {
    return operationFailure(error, transaction);
  }
}

function rollBack(
  transaction: OperationalProjectionShadowTransactionV2,
  stages: { before: ArtifactPairData; after: ArtifactPairData },
  signing: SigningContext,
  storeLock: ProposalStoreMutationLock,
  now: Date,
): OperationalProjectionShadowTransactionV2 {
  if (transaction.localRollForwardRequired) throw new Error('shadow-roll-forward-required');
  installArtifact(
    'projection',
    stages.before.projection,
    transaction.before.projection,
    transaction.after.projection,
  );
  runHook('after-rollback-projection');
  installArtifact(
    'proposal',
    stages.before.proposal,
    transaction.before.proposal,
    transaction.after.proposal,
  );
  runHook('after-rollback-proposal');
  const rolledBack = writeJournal({
    ...unsignedRecord(transaction),
    phase: 'rolled-back',
    localRollForwardRequired: false,
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
    updatedAt: nextTimestamp(transaction, now),
  }, signing, storeLock);
  runHook('after-rolled-back');
  return rolledBack;
}

/**
 * Roll back one exact locally committed shadow candidate after a separately
 * authenticated external conflict. The caller must bind the committed
 * attestation; this primitive does not authenticate remote evidence or grant
 * rollback, historical, or operational authority.
 */
export function rollbackCommittedOperationalProjectionShadowWrite(
  transactionId: string,
  committedAttestation: string,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionShadowInspection {
  if (!DIGEST_RE.test(transactionId) ||
    !DIGEST_RE.test(committedAttestation) ||
    !ownsProposalStoreMutationLock(storeLock)) {
    return degradedInspection('shadow-input-invalid');
  }
  const inspected = inspectOperationalProjectionShadowWrite();
  if (inspected.state !== 'healthy' || !inspected.transaction) return inspected;
  const transaction = inspected.transaction;
  if (transaction.transactionId !== transactionId ||
    !equalDigest(transaction.attestation, committedAttestation)) {
    return degradedInspection('shadow-transaction-identity-mismatch', transaction);
  }
  if (transaction.phase !== 'committed' || transaction.localRollForwardRequired) {
    return degradedInspection('shadow-phase-invalid', transaction, inspected.actual);
  }
  if (inspected.actual === 'unknown') {
    return degradedInspection(
      'shadow-replacement-race',
      transaction,
      inspected.actual,
      'refuse',
    );
  }
  try {
    const signing = loadSigningContext();
    if (!signing) throw new Error('shadow-journal-key-unavailable');
    rollBack(transaction, loadStages(transaction), signing, storeLock, now);
    return inspectOperationalProjectionShadowWrite();
  } catch (error) {
    return operationFailure(error, transaction);
  }
}

export function recoverOperationalProjectionShadowWrite(
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionShadowInspection {
  if (!ownsProposalStoreMutationLock(storeLock)) {
    return degradedInspection('shadow-store-lock-not-owned');
  }
  const inspected = inspectOperationalProjectionShadowWrite();
  if (inspected.state !== 'healthy' || !inspected.transaction) return inspected;
  const transaction = inspected.transaction;
  if (inspected.actual === 'unknown') {
    return degradedInspection(
      transaction.localRollForwardRequired
        ? 'shadow-roll-forward-required'
        : 'shadow-replacement-race',
      transaction,
      inspected.actual,
      transaction.localRollForwardRequired ? 'roll-forward' : 'refuse',
    );
  }
  if ((transaction.phase === 'committed' && inspected.actual === 'complete') ||
    (transaction.phase === 'rolled-back' && inspected.actual === 'no-effect')) {
    return inspected;
  }
  try {
    const signing = loadSigningContext();
    if (!signing) throw new Error('shadow-journal-key-unavailable');
    const stages = loadStages(transaction);
    if (transaction.localRollForwardRequired) {
      rollForward(transaction, stages, signing, storeLock, now);
    } else {
      rollBack(transaction, stages, signing, storeLock, now);
    }
    return inspectOperationalProjectionShadowWrite();
  } catch (error) {
    return operationFailure(error, transaction);
  }
}
