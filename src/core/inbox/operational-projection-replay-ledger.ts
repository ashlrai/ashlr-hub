import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import type {
  OperationalProjectionTransaction,
  OperationalProjectionTransactionDigestsV1,
  OperationalProjectionTransactionPhase,
} from './operational-projection-transaction.js';
import {
  readOperationalProjectionTransaction,
  validOperationalProjectionStagedArtifactsV2,
} from './operational-projection-transaction.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

const MAX_ROWS = 4_096;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ROW_BYTES = 4 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const KEY_DOMAIN = 'ashlr.operational-projection-replay-ledger.key.v1';
const KEY_ID_DOMAIN = 'ashlr.operational-projection-replay-ledger.key-id.v1';
const ROW_DOMAIN = 'ashlr.operational-projection-replay-ledger.row.v1';
const ROW_ATTESTATION_DOMAIN = 'ashlr.operational-projection-replay-ledger.row-attestation.v1';
const ROOT_ATTESTATION_DOMAIN = 'ashlr.operational-projection-replay-ledger.root-attestation.v1';

const PHASE_ORDER: Record<OperationalProjectionTransactionPhase, number> = {
  prepared: 0,
  'proposal-installed': 1,
  'projection-installed': 2,
  committed: 3,
};

export interface OperationalProjectionReplayRowV1 {
  schemaVersion: 1;
  sequence: number;
  transactionId: string;
  phase: OperationalProjectionTransactionPhase;
  phaseOrdinal: number;
  transactionAttestation: string;
  previousEntryDigest: string | null;
  recordedAt: string;
  signingKeyId: string;
  entryDigest: string;
  attestation: string;
}

export interface OperationalProjectionReplayRootV1 {
  schemaVersion: 1;
  sequence: number;
  rowCount: number;
  entryDigest: string;
  signingKeyId: string;
  updatedAt: string;
  rollbackProtected: false;
  historicalAuthority: false;
  attestation: string;
}

interface OperationalProjectionReplayStateV1 {
  schemaVersion: 1;
  rows: OperationalProjectionReplayRowV1[];
  root: OperationalProjectionReplayRootV1;
}

export type OperationalProjectionReplayLedgerReadResult =
  | { state: 'missing'; latest: null; root: null }
  | {
      state: 'healthy';
      latest: OperationalProjectionReplayRowV1;
      rows: OperationalProjectionReplayRowV1[];
      root: OperationalProjectionReplayRootV1;
    }
  | { state: 'degraded'; reason: string; latest: null; root: null };

export type OperationalProjectionReplayVerdict =
  | 'consistent-with-local-ledger'
  | 'missing-local-ledger'
  | 'transaction-replayed'
  | 'transaction-ahead-of-ledger'
  | 'transaction-identity-mismatch'
  | 'degraded';

export interface OperationalProjectionReplayVerification {
  verdict: OperationalProjectionReplayVerdict;
  rollbackProtected: false;
  historicalAuthority: false;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validPhase(value: unknown): value is OperationalProjectionTransactionPhase {
  return typeof value === 'string' && Object.hasOwn(PHASE_ORDER, value);
}

function equalDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) && DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function deriveKey(): { key: Buffer; id: string } | null {
  try {
    const provenance = loadExistingProvenanceKeyReadOnly();
    if (!provenance || provenance.length !== 32) return null;
    const key = createHmac('sha256', provenance).update(`${KEY_DOMAIN}\n`, 'utf8').digest();
    const id = createHmac('sha256', key).update(`${KEY_ID_DOMAIN}\n`, 'utf8').digest('hex');
    return { key, id };
  } catch {
    return null;
  }
}

function hmac(key: Buffer, domain: string, canonical: string): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function rowPayload(row: Omit<OperationalProjectionReplayRowV1, 'entryDigest' | 'attestation'>): string {
  return JSON.stringify({
    phase: row.phase,
    phaseOrdinal: row.phaseOrdinal,
    previousEntryDigest: row.previousEntryDigest,
    recordedAt: row.recordedAt,
    schemaVersion: row.schemaVersion,
    sequence: row.sequence,
    signingKeyId: row.signingKeyId,
    transactionAttestation: row.transactionAttestation,
    transactionId: row.transactionId,
  });
}

function rowAttestationPayload(row: Omit<OperationalProjectionReplayRowV1, 'attestation'>): string {
  return JSON.stringify({
    entryDigest: row.entryDigest,
    phase: row.phase,
    phaseOrdinal: row.phaseOrdinal,
    previousEntryDigest: row.previousEntryDigest,
    recordedAt: row.recordedAt,
    schemaVersion: row.schemaVersion,
    sequence: row.sequence,
    signingKeyId: row.signingKeyId,
    transactionAttestation: row.transactionAttestation,
    transactionId: row.transactionId,
  });
}

function rootPayload(root: Omit<OperationalProjectionReplayRootV1, 'attestation'>): string {
  return JSON.stringify({
    entryDigest: root.entryDigest,
    historicalAuthority: root.historicalAuthority,
    rollbackProtected: root.rollbackProtected,
    rowCount: root.rowCount,
    schemaVersion: root.schemaVersion,
    sequence: root.sequence,
    signingKeyId: root.signingKeyId,
    updatedAt: root.updatedAt,
  });
}

export function operationalProjectionReplayLedgerDir(): string {
  const home = homedir();
  if (!isAbsolute(home)) throw new Error('invalid home directory for projection replay ledger');
  return join(resolve(home), '.ashlr', 'proposal-projection-replay-ledger');
}

export function operationalProjectionReplayLedgerPath(): string {
  return join(operationalProjectionReplayLedgerDir(), 'state.json');
}

function safeDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return !stat.isSymbolicLink() && stat.isDirectory() &&
      (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
      (process.platform === 'win32' || Number(stat.mode & 0o777n) === 0o700) &&
      assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: homedir() }).ok;
  } catch {
    return false;
  }
}

function secureCreatedOrRecoverEmptyWindowsDirectory(path: string, created: boolean): boolean {
  if (created) {
    return assurePrivateStoragePath(
      path, 'directory', 'secure-created', { anchorPath: homedir() },
    ).ok && safeDirectory(path);
  }
  if (safeDirectory(path)) return true;
  if (process.platform !== 'win32') return false;
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(path).length !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) return false;
    return assurePrivateStoragePath(
      path, 'directory', 'secure-created', { anchorPath: homedir() },
    ).ok && safeDirectory(path);
  } catch {
    return false;
  }
}

function ensureDirectory(): boolean {
  try {
    const root = join(resolve(homedir()), '.ashlr');
    let rootCreated = false;
    let dirCreated = false;
    try { mkdirSync(root, { mode: 0o700 }); rootCreated = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false; }
    try { mkdirSync(operationalProjectionReplayLedgerDir(), { mode: 0o700 }); dirCreated = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false; }
    if (rootCreated && !secureCreatedOrRecoverEmptyWindowsDirectory(root, true)) return false;
    if (!safeDirectory(root) || !secureCreatedOrRecoverEmptyWindowsDirectory(
      operationalProjectionReplayLedgerDir(), dirCreated,
    )) return false;
    if (rootCreated) fsyncDirectory(dirname(root));
    if (dirCreated) fsyncDirectory(root);
    return true;
  } catch {
    return false;
  }
}

function parseRow(
  value: unknown,
  key: Buffer,
  previous: OperationalProjectionReplayRowV1 | null,
  sequence: number,
): OperationalProjectionReplayRowV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !==
    'attestation,entryDigest,phase,phaseOrdinal,previousEntryDigest,recordedAt,schemaVersion,sequence,signingKeyId,transactionAttestation,transactionId' ||
    row['schemaVersion'] !== 1 || row['sequence'] !== sequence ||
    typeof row['transactionId'] !== 'string' || !DIGEST_RE.test(row['transactionId']) ||
    !validPhase(row['phase']) || row['phaseOrdinal'] !== PHASE_ORDER[row['phase']] ||
    typeof row['transactionAttestation'] !== 'string' || !DIGEST_RE.test(row['transactionAttestation']) ||
    row['previousEntryDigest'] !== (previous?.entryDigest ?? null) ||
    !canonicalTimestamp(row['recordedAt']) ||
    typeof row['signingKeyId'] !== 'string' || !DIGEST_RE.test(row['signingKeyId']) ||
    typeof row['entryDigest'] !== 'string' || !DIGEST_RE.test(row['entryDigest']) ||
    typeof row['attestation'] !== 'string' || !DIGEST_RE.test(row['attestation'])) return null;
  const typed = row as unknown as OperationalProjectionReplayRowV1;
  if ((!previous && typed.phase !== 'prepared') ||
    (previous && typed.transactionId === previous.transactionId &&
      typed.phaseOrdinal !== previous.phaseOrdinal + 1) ||
    (previous && typed.transactionId !== previous.transactionId &&
      (previous.phase !== 'committed' || typed.phase !== 'prepared')) ||
    (previous && Date.parse(typed.recordedAt) < Date.parse(previous.recordedAt))) return null;
  const { entryDigest: _entryDigest, attestation: _attestation, ...payload } = typed;
  const { attestation: _signature, ...attested } = typed;
  return equalDigest(hmac(key, ROW_DOMAIN, rowPayload(payload)), typed.entryDigest) &&
    equalDigest(hmac(key, ROW_ATTESTATION_DOMAIN, rowAttestationPayload(attested)), typed.attestation)
    ? typed : null;
}

function parseRoot(value: unknown, key: Buffer): OperationalProjectionReplayRootV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !==
    'attestation,entryDigest,historicalAuthority,rollbackProtected,rowCount,schemaVersion,sequence,signingKeyId,updatedAt' ||
    root['schemaVersion'] !== 1 || !Number.isSafeInteger(root['sequence']) || Number(root['sequence']) < 1 ||
    !Number.isSafeInteger(root['rowCount']) || Number(root['rowCount']) < 1 ||
    typeof root['entryDigest'] !== 'string' || !DIGEST_RE.test(root['entryDigest']) ||
    typeof root['signingKeyId'] !== 'string' || !DIGEST_RE.test(root['signingKeyId']) ||
    !canonicalTimestamp(root['updatedAt']) || root['rollbackProtected'] !== false ||
    root['historicalAuthority'] !== false ||
    typeof root['attestation'] !== 'string' || !DIGEST_RE.test(root['attestation'])) return null;
  const typed = root as unknown as OperationalProjectionReplayRootV1;
  const { attestation: _attestation, ...payload } = typed;
  return equalDigest(hmac(key, ROOT_ATTESTATION_DOMAIN, rootPayload(payload)), typed.attestation)
    ? typed : null;
}

export function readOperationalProjectionReplayLedger(): OperationalProjectionReplayLedgerReadResult {
  const path = operationalProjectionReplayLedgerPath();
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'degraded', reason: 'replay-ledger-unavailable', latest: null, root: null };
    }
    try { lstatSync(operationalProjectionReplayLedgerDir()); }
    catch (directoryError) {
      return (directoryError as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'missing', latest: null, root: null }
        : { state: 'degraded', reason: 'replay-ledger-directory-unsafe', latest: null, root: null };
    }
    return safeDirectory(operationalProjectionReplayLedgerDir())
      ? { state: 'missing', latest: null, root: null }
      : { state: 'degraded', reason: 'replay-ledger-directory-unsafe', latest: null, root: null };
  }
  if (!safeDirectory(operationalProjectionReplayLedgerDir())) {
    return { state: 'degraded', reason: 'replay-ledger-directory-unsafe', latest: null, root: null };
  }
  const signing = deriveKey();
  if (!signing) return { state: 'degraded', reason: 'replay-ledger-key-unavailable', latest: null, root: null };
  const read = readStableRegularFile(path, {
    anchorPath: homedir(), maxFileBytes: MAX_STATE_BYTES, remainingBytes: MAX_STATE_BYTES,
  });
  if (!read.ok) return { state: 'degraded', reason: 'replay-ledger-read-failed', latest: null, root: null };
  let parsed: unknown;
  try { parsed = JSON.parse(read.text); }
  catch { return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null }; }
  if (`${JSON.stringify(parsed)}\n` !== read.text) {
    return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null };
  }
  const state = parsed as Record<string, unknown>;
  if (Object.keys(state).sort().join(',') !== 'root,rows,schemaVersion' ||
    state['schemaVersion'] !== 1 || !Array.isArray(state['rows']) ||
    state['rows'].length < 1 || state['rows'].length > MAX_ROWS) {
    return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null };
  }
  const rows: OperationalProjectionReplayRowV1[] = [];
  for (let index = 0; index < state['rows'].length; index += 1) {
    if (Buffer.byteLength(JSON.stringify(state['rows'][index]), 'utf8') > MAX_ROW_BYTES) {
      return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null };
    }
    const row = parseRow(state['rows'][index], signing.key, rows[index - 1] ?? null, index + 1);
    if (!row || !equalDigest(row.signingKeyId, signing.id)) {
      return { state: 'degraded', reason: 'replay-ledger-invalid', latest: null, root: null };
    }
    rows.push(row);
  }
  const latest = rows.at(-1)!;
  const root = parseRoot(state['root'], signing.key);
  if (!root || !equalDigest(root.signingKeyId, signing.id) ||
    root.sequence !== latest.sequence || root.rowCount !== rows.length ||
    root.updatedAt !== latest.recordedAt || !equalDigest(root.entryDigest, latest.entryDigest)) {
    return { state: 'degraded', reason: 'replay-ledger-root-mismatch', latest: null, root: null };
  }
  return { state: 'healthy', latest, rows, root };
}

function matchesActiveTransaction(
  candidate: OperationalProjectionTransaction,
  active: OperationalProjectionTransaction,
): boolean {
  const sameStaged = candidate.schemaVersion === 1
    ? active.schemaVersion === 1
    : active.schemaVersion === 2 &&
      candidate.staged.proposal.present === active.staged.proposal.present &&
      candidate.staged.proposal.digest === active.staged.proposal.digest &&
      candidate.staged.proposal.bytes === active.staged.proposal.bytes &&
      candidate.staged.projection.present === active.staged.projection.present &&
      candidate.staged.projection.digest === active.staged.projection.digest &&
      candidate.staged.projection.bytes === active.staged.projection.bytes;
  return candidate.schemaVersion === active.schemaVersion &&
    candidate.transactionId === active.transactionId &&
    candidate.signingKeyId === active.signingKeyId &&
    candidate.proposalId === active.proposalId && candidate.phase === active.phase &&
    candidate.before.proposal === active.before.proposal &&
    candidate.before.projection === active.before.projection &&
    candidate.after.proposal === active.after.proposal &&
    candidate.after.projection === active.after.projection &&
    candidate.createdAt === active.createdAt && candidate.updatedAt === active.updatedAt && sameStaged &&
    equalDigest(candidate.attestation, active.attestation);
}

function validTransactionShape(value: unknown): value is OperationalProjectionTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const transaction = value as Record<string, unknown>;
  const digestPair = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const pair = candidate as Record<string, unknown>;
    return Object.keys(pair).sort().join(',') === 'projection,proposal' &&
      [pair['proposal'], pair['projection']].every((digest) =>
        digest === null || (typeof digest === 'string' && DIGEST_RE.test(digest)));
  };
  const common = (transaction['schemaVersion'] === 1 || transaction['schemaVersion'] === 2) &&
    typeof transaction['transactionId'] === 'string' && DIGEST_RE.test(transaction['transactionId']) &&
    typeof transaction['signingKeyId'] === 'string' && DIGEST_RE.test(transaction['signingKeyId']) &&
    typeof transaction['proposalId'] === 'string' && validPhase(transaction['phase']) &&
    digestPair(transaction['before']) && digestPair(transaction['after']) &&
    canonicalTimestamp(transaction['createdAt']) && canonicalTimestamp(transaction['updatedAt']) &&
    typeof transaction['attestation'] === 'string' && DIGEST_RE.test(transaction['attestation']);
  return common && (transaction['schemaVersion'] === 1 ||
    validOperationalProjectionStagedArtifactsV2(
      transaction['staged'],
      transaction['after'] as OperationalProjectionTransactionDigestsV1,
    ));
}

export function recordOperationalProjectionReplay(
  transaction: OperationalProjectionTransaction,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionReplayLedgerReadResult {
  if (!ownsProposalStoreMutationLock(storeLock) || !validTransactionShape(transaction) ||
    !Number.isFinite(now.getTime())) {
    return { state: 'degraded', reason: 'replay-ledger-input-invalid', latest: null, root: null };
  }
  const active = readOperationalProjectionTransaction();
  if (active.state !== 'healthy') {
    return { state: 'degraded', reason: 'replay-ledger-transaction-unavailable', latest: null, root: null };
  }
  if (!matchesActiveTransaction(transaction, active.transaction)) {
    return { state: 'degraded', reason: 'replay-ledger-transaction-mismatch', latest: null, root: null };
  }
  if (!ensureDirectory()) {
    return { state: 'degraded', reason: 'replay-ledger-storage-unavailable', latest: null, root: null };
  }
  const signing = deriveKey();
  if (!signing) return { state: 'degraded', reason: 'replay-ledger-key-unavailable', latest: null, root: null };
  const current = readOperationalProjectionReplayLedger();
  if (current.state === 'degraded') return current;
  if (current.state === 'healthy') {
    if (now.getTime() < Date.parse(current.latest.recordedAt)) {
      return { state: 'degraded', reason: 'replay-ledger-clock-invalid', latest: null, root: null };
    }
    const sameTransaction = current.latest.transactionId === transaction.transactionId;
    if (sameTransaction && current.latest.phaseOrdinal === PHASE_ORDER[transaction.phase] &&
      equalDigest(current.latest.transactionAttestation, transaction.attestation)) return current;
    if (sameTransaction && PHASE_ORDER[transaction.phase] !== current.latest.phaseOrdinal + 1) {
      return { state: 'degraded', reason: 'replay-ledger-phase-invalid', latest: null, root: null };
    }
    if (!sameTransaction && (current.latest.phase !== 'committed' || transaction.phase !== 'prepared' ||
      current.rows.some((row) => row.transactionId === transaction.transactionId) ||
      Date.parse(transaction.createdAt) < Date.parse(current.latest.recordedAt))) {
      return { state: 'degraded', reason: 'replay-ledger-lineage-invalid', latest: null, root: null };
    }
  } else if (transaction.phase !== 'prepared') {
    return { state: 'degraded', reason: 'replay-ledger-lineage-invalid', latest: null, root: null };
  }
  if (now.getTime() < Date.parse(transaction.updatedAt)) {
    return { state: 'degraded', reason: 'replay-ledger-clock-invalid', latest: null, root: null };
  }
  const priorRows = current.state === 'healthy' ? current.rows : [];
  if (priorRows.length >= MAX_ROWS) {
    return { state: 'degraded', reason: 'replay-ledger-capacity', latest: null, root: null };
  }
  const recordedAt = now.toISOString();
  const payload = {
    schemaVersion: 1 as const,
    sequence: priorRows.length + 1,
    transactionId: transaction.transactionId,
    phase: transaction.phase,
    phaseOrdinal: PHASE_ORDER[transaction.phase],
    transactionAttestation: transaction.attestation,
    previousEntryDigest: current.state === 'healthy' ? current.latest.entryDigest : null,
    recordedAt,
    signingKeyId: signing.id,
  };
  const entryDigest = hmac(signing.key, ROW_DOMAIN, rowPayload(payload));
  const attested = { ...payload, entryDigest };
  const row: OperationalProjectionReplayRowV1 = {
    ...attested,
    attestation: hmac(signing.key, ROW_ATTESTATION_DOMAIN, rowAttestationPayload(attested)),
  };
  const rootPayloadValue = {
    schemaVersion: 1 as const,
    sequence: row.sequence,
    rowCount: row.sequence,
    entryDigest: row.entryDigest,
    signingKeyId: signing.id,
    updatedAt: recordedAt,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
  };
  const root: OperationalProjectionReplayRootV1 = {
    ...rootPayloadValue,
    attestation: hmac(signing.key, ROOT_ATTESTATION_DOMAIN, rootPayload(rootPayloadValue)),
  };
  const state: OperationalProjectionReplayStateV1 = {
    schemaVersion: 1,
    rows: [...priorRows, row],
    root,
  };
  const json = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES ||
    Buffer.byteLength(JSON.stringify(row), 'utf8') > MAX_ROW_BYTES ||
    !ownsProposalStoreMutationLock(storeLock)) {
    return { state: 'degraded', reason: 'replay-ledger-capacity', latest: null, root: null };
  }
  try {
    writePrivateFileAtomically(
      join(operationalProjectionReplayLedgerDir(), `.state.${process.pid}.${randomBytes(12).toString('hex')}.tmp`),
      operationalProjectionReplayLedgerPath(),
      json,
      { anchorPath: operationalProjectionReplayLedgerDir(), label: 'operational projection replay ledger' },
    );
    if (!ownsProposalStoreMutationLock(storeLock)) throw new Error('replay ledger writer lock lost');
    const reread = readOperationalProjectionReplayLedger();
    return reread.state === 'healthy' && reread.latest.sequence === row.sequence &&
      equalDigest(reread.latest.entryDigest, row.entryDigest) ? reread : {
        state: 'degraded', reason: 'replay-ledger-write-failed', latest: null, root: null,
      };
  } catch {
    return { state: 'degraded', reason: 'replay-ledger-write-failed', latest: null, root: null };
  }
}

function verification(verdict: OperationalProjectionReplayVerdict): OperationalProjectionReplayVerification {
  return { verdict, rollbackProtected: false, historicalAuthority: false };
}

export function verifyOperationalProjectionReplay(): OperationalProjectionReplayVerification {
  const active = readOperationalProjectionTransaction();
  if (active.state !== 'healthy') return verification('degraded');
  const ledger = readOperationalProjectionReplayLedger();
  if (ledger.state === 'missing') return verification('missing-local-ledger');
  if (ledger.state === 'degraded') return verification('degraded');
  if (ledger.latest.transactionId !== active.transaction.transactionId) {
    return verification('transaction-identity-mismatch');
  }
  const transactionPhase = PHASE_ORDER[active.transaction.phase];
  if (ledger.latest.phaseOrdinal > transactionPhase) return verification('transaction-replayed');
  if (ledger.latest.phaseOrdinal < transactionPhase) return verification('transaction-ahead-of-ledger');
  return verification(equalDigest(ledger.latest.transactionAttestation, active.transaction.attestation)
    ? 'consistent-with-local-ledger' : 'transaction-identity-mismatch');
}
