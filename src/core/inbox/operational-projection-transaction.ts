import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  operationalProposalProjectionDir,
} from './operational-projection.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

const V1_SCHEMA_VERSION = 1 as const;
const V2_SCHEMA_VERSION = 2 as const;
const MAX_TRANSACTION_BYTES = 64 * 1024;
const MAX_STAGED_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_STAGED_PROJECTION_BYTES = 4 * 1024 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const KEY_DOMAIN = 'ashlr.operational-projection-transaction.key.v1';
const KEY_ID_DOMAIN = 'ashlr.operational-projection-transaction.key-id.v1';
const V1_ATTESTATION_DOMAIN = 'ashlr.operational-projection-transaction.record.v1';
const V2_ATTESTATION_DOMAIN = 'ashlr.operational-projection-transaction.record.v2';

export type OperationalProjectionTransactionPhase =
  | 'prepared'
  | 'proposal-installed'
  | 'projection-installed'
  | 'committed';

export interface OperationalProjectionTransactionDigestsV1 {
  proposal: string | null;
  projection: string | null;
}

/** Metadata-only description of a deterministic private staged artifact. */
export interface OperationalProjectionTransactionStagedArtifactV2 {
  present: boolean;
  digest: string | null;
  bytes: number;
}

export interface OperationalProjectionTransactionStagedArtifactsV2 {
  proposal: OperationalProjectionTransactionStagedArtifactV2;
  projection: OperationalProjectionTransactionStagedArtifactV2;
}

export interface OperationalProjectionTransactionV1 {
  schemaVersion: 1;
  transactionId: string;
  signingKeyId: string;
  proposalId: string;
  phase: OperationalProjectionTransactionPhase;
  before: OperationalProjectionTransactionDigestsV1;
  after: OperationalProjectionTransactionDigestsV1;
  createdAt: string;
  updatedAt: string;
  attestation: string;
}

/** V2 binds deterministic staged-artifact metadata without retaining bytes or paths. */
export interface OperationalProjectionTransactionV2 extends Omit<OperationalProjectionTransactionV1, 'schemaVersion'> {
  schemaVersion: 2;
  staged: OperationalProjectionTransactionStagedArtifactsV2;
}

export type OperationalProjectionTransaction =
  | OperationalProjectionTransactionV1
  | OperationalProjectionTransactionV2;

export type OperationalProjectionTransactionReadResult =
  | { state: 'missing'; transaction: null }
  | { state: 'healthy'; transaction: OperationalProjectionTransaction }
  | { state: 'degraded'; reason: string; transaction: null };

export type OperationalProjectionRecoveryState =
  | 'no-effect'
  | 'proposal-only'
  | 'projection-only'
  | 'complete'
  | 'unknown';

export interface PrepareOperationalProjectionTransactionInput {
  proposalId: string;
  before: OperationalProjectionTransactionDigestsV1;
  after: OperationalProjectionTransactionDigestsV1;
  /** Omit for byte-for-byte V1 issuance; present metadata emits an authenticated V2 record. */
  staged?: OperationalProjectionTransactionStagedArtifactsV2;
  storeLock: ProposalStoreMutationLock;
  now?: Date;
}

const PHASE_ORDER: Record<OperationalProjectionTransactionPhase, number> = {
  prepared: 0,
  'proposal-installed': 1,
  'projection-installed': 2,
  committed: 3,
};

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validDigest(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && DIGEST_RE.test(value));
}

function validDigestPair(value: unknown): value is OperationalProjectionTransactionDigestsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'projection,proposal' &&
    validDigest(record['proposal']) && validDigest(record['projection']);
}

/**
 * Validates only bounded metadata. Artifact paths and bytes are intentionally
 * absent: a later recovery executor derives paths from a transaction id and
 * revalidates stable-read bytes under the global writer lock.
 */
export function validOperationalProjectionStagedArtifactsV2(
  value: unknown,
  after: OperationalProjectionTransactionDigestsV1,
): value is OperationalProjectionTransactionStagedArtifactsV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const staged = value as Record<string, unknown>;
  if (Object.keys(staged).sort().join(',') !== 'projection,proposal') return false;
  const validArtifact = (artifact: unknown, digest: string | null, maxBytes: number): boolean => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
    const record = artifact as Record<string, unknown>;
    const present = record['present'];
    const artifactDigest = record['digest'];
    const bytes = record['bytes'];
    if (Object.keys(record).sort().join(',') !== 'bytes,digest,present' ||
      typeof present !== 'boolean' || typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) return false;
    if (present === false) return artifactDigest === null && bytes === 0 && digest === null;
    return typeof artifactDigest === 'string' && DIGEST_RE.test(artifactDigest) &&
      artifactDigest === digest && bytes > 0 && bytes <= maxBytes;
  };
  return validArtifact(staged['proposal'], after.proposal, MAX_STAGED_PROPOSAL_BYTES) &&
    validArtifact(staged['projection'], after.projection, MAX_STAGED_PROJECTION_BYTES);
}

function validProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 &&
    PROPOSAL_ID_RE.test(value) && value !== '.' && value !== '..';
}

function validPhase(value: unknown): value is OperationalProjectionTransactionPhase {
  return typeof value === 'string' && Object.hasOwn(PHASE_ORDER, value);
}

type UnsignedOperationalProjectionTransaction =
  | Omit<OperationalProjectionTransactionV1, 'attestation'>
  | Omit<OperationalProjectionTransactionV2, 'attestation'>;

function canonicalRecordV1(value: Omit<OperationalProjectionTransactionV1, 'attestation'>): string {
  return JSON.stringify({
    after: { projection: value.after.projection, proposal: value.after.proposal },
    before: { projection: value.before.projection, proposal: value.before.proposal },
    createdAt: value.createdAt,
    phase: value.phase,
    proposalId: value.proposalId,
    schemaVersion: value.schemaVersion,
    signingKeyId: value.signingKeyId,
    transactionId: value.transactionId,
    updatedAt: value.updatedAt,
  });
}

function canonicalRecordV2(value: Omit<OperationalProjectionTransactionV2, 'attestation'>): string {
  return JSON.stringify({
    after: { projection: value.after.projection, proposal: value.after.proposal },
    before: { projection: value.before.projection, proposal: value.before.proposal },
    createdAt: value.createdAt,
    phase: value.phase,
    proposalId: value.proposalId,
    schemaVersion: value.schemaVersion,
    signingKeyId: value.signingKeyId,
    staged: {
      projection: {
        bytes: value.staged.projection.bytes,
        digest: value.staged.projection.digest,
        present: value.staged.projection.present,
      },
      proposal: {
        bytes: value.staged.proposal.bytes,
        digest: value.staged.proposal.digest,
        present: value.staged.proposal.present,
      },
    },
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

function attest(
  key: Buffer,
  value: UnsignedOperationalProjectionTransaction,
): string {
  const domain = value.schemaVersion === V1_SCHEMA_VERSION
    ? V1_ATTESTATION_DOMAIN : V2_ATTESTATION_DOMAIN;
  const canonical = value.schemaVersion === V1_SCHEMA_VERSION
    ? canonicalRecordV1(value) : canonicalRecordV2(value);
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) && DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseRecord(text: string): OperationalProjectionTransaction | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const schemaVersion = value['schemaVersion'];
    const exactV1Keys = 'after,attestation,before,createdAt,phase,proposalId,schemaVersion,signingKeyId,transactionId,updatedAt';
    const exactV2Keys = 'after,attestation,before,createdAt,phase,proposalId,schemaVersion,signingKeyId,staged,transactionId,updatedAt';
    if ((schemaVersion === V1_SCHEMA_VERSION && Object.keys(value).sort().join(',') !== exactV1Keys) ||
      (schemaVersion === V2_SCHEMA_VERSION && Object.keys(value).sort().join(',') !== exactV2Keys) ||
      (schemaVersion !== V1_SCHEMA_VERSION && schemaVersion !== V2_SCHEMA_VERSION) ||
      typeof value['transactionId'] !== 'string' || !DIGEST_RE.test(value['transactionId']) ||
      typeof value['signingKeyId'] !== 'string' || !DIGEST_RE.test(value['signingKeyId']) ||
      !validProposalId(value['proposalId']) || !validPhase(value['phase']) ||
      !validDigestPair(value['before']) || !validDigestPair(value['after']) ||
      !canonicalTimestamp(value['createdAt']) || !canonicalTimestamp(value['updatedAt']) ||
      Date.parse(value['updatedAt']) < Date.parse(value['createdAt']) ||
      typeof value['attestation'] !== 'string' || !DIGEST_RE.test(value['attestation']) ||
      (schemaVersion === V2_SCHEMA_VERSION &&
        !validOperationalProjectionStagedArtifactsV2(value['staged'], value['after']))) return null;
    return value as unknown as OperationalProjectionTransaction;
  } catch {
    return null;
  }
}

function keyId(key: Buffer): string {
  return createHmac('sha256', key)
    .update(KEY_ID_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .digest('hex');
}

function loadKey(): { key: Buffer; id: string } | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    if (!key || key.length !== 32) return null;
    const derived = signingKey(key);
    return { key: derived, id: keyId(derived) };
  } catch {
    return null;
  }
}

function safeDirectory(): boolean {
  try {
    const dir = operationalProposalProjectionDir();
    const stat = lstatSync(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
    if (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== 0o700) return false;
    return assurePrivateStoragePath(dir, 'directory', 'inspect-existing', {
      anchorPath: homedir(),
    }).ok;
  } catch {
    return false;
  }
}

export function operationalProjectionTransactionPath(): string {
  return join(operationalProposalProjectionDir(), 'active-transaction.json');
}

export function readOperationalProjectionTransaction(): OperationalProjectionTransactionReadResult {
  const path = operationalProjectionTransactionPath();
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'degraded', reason: 'transaction-unavailable', transaction: null };
    }
    try {
      lstatSync(operationalProposalProjectionDir());
    } catch (directoryError) {
      return (directoryError as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'missing', transaction: null }
        : { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
    }
    return safeDirectory()
      ? { state: 'missing', transaction: null }
      : { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
  }
  if (!safeDirectory()) {
    return { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
  }
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_TRANSACTION_BYTES,
    remainingBytes: MAX_TRANSACTION_BYTES,
  });
  if (!read.ok) return { state: 'degraded', reason: read.reason, transaction: null };
  const transaction = parseRecord(read.text);
  if (!transaction) return { state: 'degraded', reason: 'transaction-invalid', transaction: null };
  const signing = loadKey();
  if (!signing) return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  if (!equalDigest(transaction.signingKeyId, signing.id)) {
    return { state: 'degraded', reason: 'transaction-key-generation-mismatch', transaction: null };
  }
  const { attestation, ...unsigned } = transaction;
  if (!equalDigest(attest(signing.key, unsigned), attestation)) {
    return { state: 'degraded', reason: 'transaction-integrity-failed', transaction: null };
  }
  return { state: 'healthy', transaction };
}

function writeRecord(
  transaction: OperationalProjectionTransaction,
  storeLock: ProposalStoreMutationLock,
): boolean {
  if (!ownsProposalStoreMutationLock(storeLock) || !safeDirectory()) return false;
  const json = `${JSON.stringify(transaction)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_TRANSACTION_BYTES) return false;
  try {
    const temporaryPath = join(
      operationalProposalProjectionDir(),
      `.active-transaction.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    writePrivateFileAtomically(temporaryPath, operationalProjectionTransactionPath(), json, {
      anchorPath: operationalProposalProjectionDir(),
      label: 'operational projection transaction',
    });
    if (!ownsProposalStoreMutationLock(storeLock)) return false;
    const reread = readOperationalProjectionTransaction();
    return ownsProposalStoreMutationLock(storeLock) && reread.state === 'healthy' &&
      reread.transaction.schemaVersion === transaction.schemaVersion &&
      reread.transaction.transactionId === transaction.transactionId &&
      reread.transaction.phase === transaction.phase &&
      equalDigest(reread.transaction.attestation, transaction.attestation);
  } catch {
    return false;
  }
}

export function prepareOperationalProjectionTransactionJournalOnly(
  input: PrepareOperationalProjectionTransactionInput,
): OperationalProjectionTransactionReadResult {
  if (!ownsProposalStoreMutationLock(input.storeLock) || !validProposalId(input.proposalId) ||
    !validDigestPair(input.before) || !validDigestPair(input.after) ||
    (input.staged !== undefined && !validOperationalProjectionStagedArtifactsV2(input.staged, input.after)) ||
    input.before.proposal === input.after.proposal ||
    input.before.projection === input.after.projection) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const current = readOperationalProjectionTransaction();
  if (current.state === 'degraded') return current;
  if (current.state === 'healthy' && current.transaction.phase !== 'committed') {
    return { state: 'degraded', reason: 'transaction-already-active', transaction: null };
  }
  const signing = loadKey();
  const now = input.now ?? new Date();
  if (!signing || !Number.isFinite(now.getTime())) {
    return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  }
  if (current.state === 'healthy' &&
    now.getTime() < Date.parse(current.transaction.updatedAt)) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const timestamp = now.toISOString();
  const transactionId = createHmac('sha256', signing.key)
    .update('ashlr.operational-projection-transaction.id.v1\n', 'utf8')
    .update(input.proposalId, 'utf8')
    .update('\n', 'utf8')
    .update(timestamp, 'utf8')
    .update('\n', 'utf8')
    .update(randomBytes(16))
    .digest('hex');
  const common = {
    transactionId,
    signingKeyId: signing.id,
    proposalId: input.proposalId,
    phase: 'prepared' as const,
    before: input.before,
    after: input.after,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const unsigned: UnsignedOperationalProjectionTransaction = input.staged === undefined
    ? { schemaVersion: V1_SCHEMA_VERSION, ...common }
    : { schemaVersion: V2_SCHEMA_VERSION, ...common, staged: input.staged };
  const transaction: OperationalProjectionTransaction = {
    ...unsigned,
    attestation: attest(signing.key, unsigned),
  } as OperationalProjectionTransaction;
  return writeRecord(transaction, input.storeLock)
    ? { state: 'healthy', transaction }
    : { state: 'degraded', reason: 'transaction-write-failed', transaction: null };
}

export function advanceOperationalProjectionTransactionJournalOnly(
  transactionId: string,
  phase: OperationalProjectionTransactionPhase,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionTransactionReadResult {
  if (!DIGEST_RE.test(transactionId) || !validPhase(phase) ||
    !ownsProposalStoreMutationLock(storeLock) || !Number.isFinite(now.getTime())) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const current = readOperationalProjectionTransaction();
  if (current.state !== 'healthy') return current;
  if (current.transaction.transactionId !== transactionId) {
    return { state: 'degraded', reason: 'transaction-identity-mismatch', transaction: null };
  }
  const currentOrder = PHASE_ORDER[current.transaction.phase];
  const nextOrder = PHASE_ORDER[phase];
  if (nextOrder < currentOrder || nextOrder > currentOrder + 1 ||
    now.getTime() < Date.parse(current.transaction.updatedAt)) {
    return { state: 'degraded', reason: 'transaction-phase-invalid', transaction: null };
  }
  if (nextOrder === currentOrder) return current;
  const signing = loadKey();
  if (!signing) return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  if (!equalDigest(current.transaction.signingKeyId, signing.id)) {
    return { state: 'degraded', reason: 'transaction-key-generation-mismatch', transaction: null };
  }
  const { attestation: _attestation, ...prior } = current.transaction;
  const unsigned = { ...prior, phase, updatedAt: now.toISOString() };
  const transaction: OperationalProjectionTransaction = {
    ...unsigned,
    attestation: attest(signing.key, unsigned),
  } as OperationalProjectionTransaction;
  return writeRecord(transaction, storeLock)
    ? { state: 'healthy', transaction }
    : { state: 'degraded', reason: 'transaction-write-failed', transaction: null };
}

export function classifyOperationalProjectionRecovery(
  transaction: Pick<OperationalProjectionTransaction, 'before' | 'after'>,
  actual: OperationalProjectionTransactionDigestsV1,
): OperationalProjectionRecoveryState {
  if (!validDigestPair(transaction.before) || !validDigestPair(transaction.after) ||
    !validDigestPair(actual) ||
    transaction.before.proposal === transaction.after.proposal ||
    transaction.before.projection === transaction.after.projection) return 'unknown';
  const proposalBefore = actual.proposal === transaction.before.proposal;
  const proposalAfter = actual.proposal === transaction.after.proposal;
  const projectionBefore = actual.projection === transaction.before.projection;
  const projectionAfter = actual.projection === transaction.after.projection;
  if (proposalBefore && projectionBefore) return 'no-effect';
  if (proposalAfter && projectionBefore) return 'proposal-only';
  if (proposalBefore && projectionAfter) return 'projection-only';
  if (proposalAfter && projectionAfter) return 'complete';
  return 'unknown';
}
