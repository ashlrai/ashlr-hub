import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { operationalProposalProjectionDir } from './operational-projection.js';

const TRANSACTION_ID_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_STAGE_BYTES = 4 * 1024 * 1024;

export type OperationalProjectionStagedArtifactKind = 'proposal' | 'projection';

export interface OperationalProjectionStagedArtifactMetadata {
  present: boolean;
  digest: string | null;
  bytes: number;
}

export interface OperationalProjectionStagedArtifactValidation {
  digest: string;
  bytes: number;
}

export type ValidateOperationalProjectionStagedArtifact = (
  text: string,
) => OperationalProjectionStagedArtifactValidation | null;

export type OperationalProjectionStageWriteResult =
  | { ok: true }
  | { ok: false; reason: string };

export type OperationalProjectionStageReadResult =
  | { state: 'present'; text: string }
  | { state: 'absent' }
  | { state: 'degraded'; reason: string };

function validMetadata(value: OperationalProjectionStagedArtifactMetadata): boolean {
  return value.present
    ? typeof value.digest === 'string' && DIGEST_RE.test(value.digest) &&
      Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= MAX_STAGE_BYTES
    : value.digest === null && value.bytes === 0;
}

function validTransactionId(transactionId: string): boolean {
  return TRANSACTION_ID_RE.test(transactionId);
}

function validKind(kind: string): kind is OperationalProjectionStagedArtifactKind {
  return kind === 'proposal' || kind === 'projection';
}

function stageRoot(): string {
  return join(operationalProposalProjectionDir(), 'staged');
}

export function operationalProjectionStageDir(transactionId: string): string {
  return join(stageRoot(), transactionId);
}

export function operationalProjectionStagePath(
  transactionId: string,
  kind: OperationalProjectionStagedArtifactKind,
): string {
  return join(operationalProjectionStageDir(transactionId), `${kind}.json`);
}

function ensurePrivateDirectory(path: string, anchorPath: string): boolean {
  try {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    if (!assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-existing', {
      anchorPath,
    }).ok) return false;
    if (created) fsyncDirectory(anchorPath);
    return true;
  } catch {
    return false;
  }
}

function ensureStageDirectory(transactionId: string): boolean {
  if (!validTransactionId(transactionId)) return false;
  const root = operationalProposalProjectionDir();
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: homedir() }).ok) {
    return false;
  }
  return ensurePrivateDirectory(stageRoot(), root) &&
    ensurePrivateDirectory(operationalProjectionStageDir(transactionId), stageRoot());
}

function stageAbsent(path: string): boolean {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function validated(text: string, expected: OperationalProjectionStagedArtifactMetadata,
  validate: ValidateOperationalProjectionStagedArtifact): boolean {
  const observed = validate(text);
  return observed !== null && observed.bytes === expected.bytes && observed.digest === expected.digest;
}

/**
 * Persist a private deterministic stage. Semantic validation is injected so
 * callers bind the bytes to the domain-specific proposal/projection identity.
 */
export function writeOperationalProjectionStage(
  transactionId: string,
  kind: OperationalProjectionStagedArtifactKind,
  value: Buffer,
  expected: OperationalProjectionStagedArtifactMetadata,
  validate: ValidateOperationalProjectionStagedArtifact,
): OperationalProjectionStageWriteResult {
  if (!validTransactionId(transactionId) || !validKind(kind) || !validMetadata(expected) ||
    !Buffer.isBuffer(value) || value.length > MAX_STAGE_BYTES) {
    return { ok: false, reason: 'stage-input-invalid' };
  }
  if (!ensureStageDirectory(transactionId)) return { ok: false, reason: 'stage-directory-unsafe' };
  const path = operationalProjectionStagePath(transactionId, kind);
  if (!expected.present) return stageAbsent(path)
    ? { ok: true } : { ok: false, reason: 'stage-expected-absent' };
  if (value.length !== expected.bytes || !validated(value.toString('utf8'), expected, validate)) {
    return { ok: false, reason: 'stage-content-invalid' };
  }
  try {
    const temporaryPath = join(
      operationalProjectionStageDir(transactionId),
      `.${kind}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    writePrivateFileAtomically(temporaryPath, path, value, {
      anchorPath: operationalProjectionStageDir(transactionId),
      label: `operational projection ${kind} stage`,
    });
    const reread = readStableRegularFile(path, {
      anchorPath: operationalProjectionStageDir(transactionId),
      maxFileBytes: MAX_STAGE_BYTES,
      remainingBytes: MAX_STAGE_BYTES,
    });
    return reread.ok && Buffer.byteLength(reread.text, 'utf8') === expected.bytes &&
      validated(reread.text, expected, validate)
      ? { ok: true } : { ok: false, reason: 'stage-reread-invalid' };
  } catch {
    return { ok: false, reason: 'stage-write-failed' };
  }
}

/** Read a staged artifact without creating stage storage or accepting a tombstone file. */
export function readOperationalProjectionStage(
  transactionId: string,
  kind: OperationalProjectionStagedArtifactKind,
  expected: OperationalProjectionStagedArtifactMetadata,
  validate: ValidateOperationalProjectionStagedArtifact,
): OperationalProjectionStageReadResult {
  if (!validTransactionId(transactionId) || !validKind(kind) || !validMetadata(expected)) {
    return { state: 'degraded', reason: 'stage-input-invalid' };
  }
  const directory = operationalProjectionStageDir(transactionId);
  const path = operationalProjectionStagePath(transactionId, kind);
  try { lstatSync(directory); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'degraded', reason: 'stage-missing' }
      : { state: 'degraded', reason: 'stage-directory-unsafe' };
  }
  const root = operationalProposalProjectionDir();
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: homedir() }).ok ||
    !assurePrivateStoragePath(stageRoot(), 'directory', 'inspect-existing', { anchorPath: root }).ok ||
    !assurePrivateStoragePath(directory, 'directory', 'inspect-existing', { anchorPath: stageRoot() }).ok) {
    return { state: 'degraded', reason: 'stage-directory-unsafe' };
  }
  if (!expected.present) return stageAbsent(path)
    ? { state: 'absent' } : { state: 'degraded', reason: 'stage-expected-absent' };
  const read = readStableRegularFile(path, {
    anchorPath: directory,
    maxFileBytes: MAX_STAGE_BYTES,
    remainingBytes: MAX_STAGE_BYTES,
  });
  if (!read.ok) return { state: 'degraded', reason: `stage-${read.reason}` };
  if (Buffer.byteLength(read.text, 'utf8') !== expected.bytes || !validated(read.text, expected, validate)) {
    return { state: 'degraded', reason: 'stage-content-invalid' };
  }
  return { state: 'present', text: read.text };
}
