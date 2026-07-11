/**
 * Advisory, metadata-only evidence that a scanned objective needs no change.
 *
 * This ledger deliberately has no lifecycle, proposal, verification, or merge
 * consumer. It records independently observed facts for later inspection only.
 */

import { createHash } from 'node:crypto';
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
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 25_000;
const MAX_ROW_BYTES = 4_096;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SCANNER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OBSERVER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const EXACT_KEYS = new Set([
  'schemaVersion',
  'decision',
  'repo',
  'scannerId',
  'scannerRevision',
  'itemId',
  'objectiveHash',
  'observerRunId',
  'postStateBaseDigest',
  'observationBaseDigest',
  'resolutionKind',
  'resolutionDigest',
  'decidedAt',
]);

export type ResolutionWitnessDecision = 'no-change-required';
export type ResolutionWitnessKind = 'merge-contract-satisfied';

/** Fixed v1 persistence schema. Keep free-form execution data out of this type. */
export interface ResolutionWitness {
  schemaVersion: 1;
  decision: ResolutionWitnessDecision;
  repo: string;
  scannerId: string;
  scannerRevision: number;
  itemId: string;
  objectiveHash: string;
  observerRunId: string;
  postStateBaseDigest: string;
  observationBaseDigest: string;
  resolutionKind: ResolutionWitnessKind;
  resolutionDigest: string;
  decidedAt: string;
}

export type ResolutionWitnessInput = Omit<ResolutionWitness, 'schemaVersion' | 'decision' | 'resolutionDigest'> & {
  schemaVersion?: 1;
  decision?: ResolutionWitnessDecision;
  resolutionDigest?: string;
};

export interface ResolutionWitnessWriteResult {
  attempted: number;
  recorded: number;
  replayed: number;
  conflicted: number;
  invalid: number;
  failed: number;
}

export interface ResolutionWitnessReadResult {
  witnesses: ResolutionWitness[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  invalidRows: number;
  conflictingDigests: number;
  limitExceeded: boolean;
  physicalRows: number;
}

export function resolutionWitnessLedgerPath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'resolution-witnesses.jsonl');
}

function resolutionWitnessLockPath(): string {
  return `${resolutionWitnessLedgerPath()}.lock`;
}

function privateOwner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function noControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function safeRepo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 || !noControlCharacters(value)) return null;
  try {
    const canonical = resolve(value);
    return isAbsolute(canonical) && canonical.length <= 1_024 ? canonical : null;
  } catch {
    return null;
  }
}

function safeItemId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 240 && noControlCharacters(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

type ResolutionIdentity = Pick<
  ResolutionWitness,
  | 'decision'
  | 'repo'
  | 'scannerId'
  | 'scannerRevision'
  | 'itemId'
  | 'objectiveHash'
  | 'observerRunId'
  | 'postStateBaseDigest'
  | 'observationBaseDigest'
  | 'resolutionKind'
  | 'decidedAt'
>;

/** Stable advisory identity for this exact observation and its evidence. */
export function resolutionWitnessDigest(fields: ResolutionIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:resolution-witness:v1',
    fields.decision,
    fields.repo,
    fields.scannerId,
    fields.scannerRevision,
    fields.itemId,
    fields.objectiveHash,
    fields.observerRunId,
    fields.postStateBaseDigest,
    fields.observationBaseDigest,
    fields.resolutionKind,
    fields.decidedAt,
  ])).digest('hex');
}

function reconstructWitness(value: unknown, requireExactKeys: boolean): ResolutionWitness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (requireExactKeys) {
    const keys = Object.keys(row);
    if (keys.length !== EXACT_KEYS.size || keys.some((key) => !EXACT_KEYS.has(key))) return null;
  }
  const repo = safeRepo(row['repo']);
  if (
    (row['schemaVersion'] !== undefined && row['schemaVersion'] !== 1) ||
    (row['decision'] !== undefined && row['decision'] !== 'no-change-required') ||
    !repo ||
    typeof row['scannerId'] !== 'string' || !SCANNER_ID_RE.test(row['scannerId']) ||
    !Number.isSafeInteger(row['scannerRevision']) || Number(row['scannerRevision']) < 1 ||
    !safeItemId(row['itemId']) ||
    typeof row['objectiveHash'] !== 'string' || !SHA256_RE.test(row['objectiveHash']) ||
    typeof row['observerRunId'] !== 'string' || !OBSERVER_RUN_ID_RE.test(row['observerRunId']) ||
    typeof row['postStateBaseDigest'] !== 'string' || !SHA256_RE.test(row['postStateBaseDigest']) ||
    typeof row['observationBaseDigest'] !== 'string' || !SHA256_RE.test(row['observationBaseDigest']) ||
    row['resolutionKind'] !== 'merge-contract-satisfied' ||
    !canonicalTimestamp(row['decidedAt'])
  ) return null;

  const witness: ResolutionWitness = {
    schemaVersion: 1,
    decision: 'no-change-required',
    repo,
    scannerId: row['scannerId'],
    scannerRevision: row['scannerRevision'] as number,
    itemId: row['itemId'],
    objectiveHash: row['objectiveHash'],
    observerRunId: row['observerRunId'],
    postStateBaseDigest: row['postStateBaseDigest'],
    observationBaseDigest: row['observationBaseDigest'],
    resolutionKind: 'merge-contract-satisfied',
    resolutionDigest: '',
    decidedAt: row['decidedAt'],
  };
  const expectedDigest = resolutionWitnessDigest(witness);
  if (row['resolutionDigest'] !== undefined && row['resolutionDigest'] !== expectedDigest) return null;
  witness.resolutionDigest = expectedDigest;
  return witness;
}

/** Reconstruct the fixed schema and discard every unrecognized input field. */
export function sanitizeResolutionWitness(value: unknown): ResolutionWitness | null {
  return reconstructWitness(value, false);
}

export function buildResolutionWitness(input: ResolutionWitnessInput): ResolutionWitness | null {
  return sanitizeResolutionWitness(input);
}

function exactFingerprint(witness: ResolutionWitness): string {
  return JSON.stringify(witness);
}

interface PrivatePathState {
  ashlr: Stats;
  fleet: Stats;
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && privateOwner(stat.uid)
    && (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateLedger(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && privateOwner(stat.uid) && stat.nlink === 1
    && (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function createAndValidatePrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  if (!privateDirectory(before)) throw new Error('unsafe resolution witness directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) {
    throw new Error('resolution witness directory changed during validation');
  }
  return after;
}

function ensurePrivateDirectories(): PrivatePathState {
  const ashlrPath = join(homedir(), '.ashlr');
  const ashlr = createAndValidatePrivateDirectory(ashlrPath);
  const fleet = createAndValidatePrivateDirectory(join(ashlrPath, 'fleet'));
  const currentAshlr = lstatSync(ashlrPath);
  if (!privateDirectory(currentAshlr) || !sameNode(ashlr, currentAshlr)) {
    throw new Error('resolution witness ancestor changed during validation');
  }
  return { ashlr: currentAshlr, fleet };
}

function verifyPrivateDirectories(expected: PrivatePathState): void {
  const ashlr = lstatSync(join(homedir(), '.ashlr'));
  const fleet = lstatSync(dirname(resolutionWitnessLedgerPath()));
  if (
    !privateDirectory(ashlr) || !privateDirectory(fleet)
    || !sameNode(ashlr, expected.ashlr) || !sameNode(fleet, expected.fleet)
  ) throw new Error('resolution witness directory replaced');
}

function existingPrivateLedger(path: string): Stats | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!privateLedger(stat)) throw new Error('unsafe resolution witness ledger');
  return stat;
}

function verifyOpenedLedger(path: string, opened: Stats, expectedDirectories: PrivatePathState): Stats {
  const authoritative = lstatSync(path);
  verifyPrivateDirectories(expectedDirectories);
  if (!privateLedger(opened) || !privateLedger(authoritative) || !sameNode(opened, authoritative)) {
    throw new Error('resolution witness ledger replaced');
  }
  return authoritative;
}

function readOpenedFile(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) break;
    offset += count;
  }
  return bytes.subarray(0, offset);
}

function completeLines(text: string): { lines: string[]; tornTail: boolean } {
  if (text.length === 0) return { lines: [], tornTail: false };
  return text.endsWith('\n')
    ? { lines: text.slice(0, -1).split('\n'), tornTail: false }
    : { lines: text.split('\n').slice(0, -1), tornTail: true };
}

function appendWitness(witness: ResolutionWitness): 'recorded' | 'replayed' | 'conflicted' | 'failed' {
  const path = resolutionWitnessLedgerPath();
  let directories: PrivatePathState;
  try {
    directories = ensurePrivateDirectories();
    existingPrivateLedger(path);
  } catch {
    return 'failed';
  }
  const lock = acquireLocalStoreLock(resolutionWitnessLockPath());
  if (!lock) return 'failed';
  let fd: number | undefined;
  try {
    verifyPrivateDirectories(directories);
    const before = existingPrivateLedger(path);
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    let opened = fstatSync(fd);
    if (
      !privateLedger(opened) || (before && !sameNode(before, opened)) ||
      opened.size > MAX_FILE_BYTES
    ) return 'failed';
    fchmodSync(fd, 0o600);
    opened = fstatSync(fd);
    if (!privateLedger(opened)) return 'failed';
    verifyOpenedLedger(path, opened, directories);

    const existingBytes = readOpenedFile(fd, opened.size);
    const afterRead = fstatSync(fd);
    if (!privateLedger(afterRead) || !sameNode(opened, afterRead) || afterRead.size !== opened.size) return 'failed';
    const parsedLines = completeLines(existingBytes.toString('utf8')).lines.filter(Boolean);
    if (parsedLines.length >= MAX_ROWS) return 'failed';
    let replay = false;
    let conflict = false;
    const fingerprint = exactFingerprint(witness);
    for (const line of parsedLines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch { continue; }
      const existing = reconstructWitness(parsed, true);
      if (!existing || existing.resolutionDigest !== witness.resolutionDigest) continue;
      if (exactFingerprint(existing) === fingerprint) replay = true;
      else conflict = true;
    }
    if (replay && !conflict) return 'replayed';

    const needsSeparator = existingBytes.length > 0 && existingBytes.at(-1) !== 0x0a;
    const bytes = Buffer.from(`${needsSeparator ? '\n' : ''}${JSON.stringify(witness)}\n`, 'utf8');
    if (bytes.length > MAX_ROW_BYTES || opened.size + bytes.length > MAX_FILE_BYTES) return 'failed';
    verifyOpenedLedger(path, afterRead, directories);
    if (writeSync(fd, bytes) !== bytes.length) return 'failed';
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (
      !privateLedger(persisted) || !sameNode(opened, persisted)
      || persisted.size !== opened.size + bytes.length
    ) return 'failed';
    verifyOpenedLedger(path, persisted, directories);
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedDirectory = fstatSync(dirFd);
      if (!privateDirectory(openedDirectory) || !sameNode(openedDirectory, directories.fleet)) return 'failed';
      fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
    return conflict || replay ? 'conflicted' : 'recorded';
  } catch {
    return 'failed';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

export function recordResolutionWitnesses(
  input: ResolutionWitnessInput | ResolutionWitnessInput[],
): ResolutionWitnessWriteResult {
  const result: ResolutionWitnessWriteResult = {
    attempted: 0,
    recorded: 0,
    replayed: 0,
    conflicted: 0,
    invalid: 0,
    failed: 0,
  };
  for (const candidate of Array.isArray(input) ? input : [input]) {
    result.attempted += 1;
    const witness = sanitizeResolutionWitness(candidate);
    if (!witness) { result.invalid += 1; continue; }
    const disposition = appendWitness(witness);
    result[disposition] += 1;
  }
  return result;
}

export function recordResolutionWitness(input: ResolutionWitnessInput): ResolutionWitnessWriteResult {
  return recordResolutionWitnesses(input);
}

function emptyRead(
  sourceState: ResolutionWitnessReadResult['sourceState'],
  overrides: Partial<ResolutionWitnessReadResult> = {},
): ResolutionWitnessReadResult {
  return {
    witnesses: [],
    sourceState,
    invalidRows: 0,
    conflictingDigests: 0,
    limitExceeded: false,
    physicalRows: 0,
    ...overrides,
  };
}

export function readResolutionWitnesses(): ResolutionWitnessReadResult {
  const path = resolutionWitnessLedgerPath();
  const ashlrPath = join(homedir(), '.ashlr');
  if (!existsSync(ashlrPath)) return emptyRead('missing');
  try {
    if (!privateDirectory(lstatSync(ashlrPath))) return emptyRead('degraded', { invalidRows: 1 });
  } catch {
    return emptyRead('degraded', { invalidRows: 1 });
  }
  if (!existsSync(dirname(path))) return emptyRead('missing');
  let directories: PrivatePathState;
  try {
    directories = ensurePrivateDirectories();
    existingPrivateLedger(path);
  } catch {
    return emptyRead('degraded', { invalidRows: 1 });
  }
  const lock = acquireLocalStoreLock(resolutionWitnessLockPath());
  if (!lock) return emptyRead('degraded', { invalidRows: 1 });
  let fd: number | undefined;
  try {
    verifyPrivateDirectories(directories);
    const before = existingPrivateLedger(path);
    if (!before) return emptyRead('missing');
    if (before.size > MAX_FILE_BYTES) {
      return emptyRead('degraded', { limitExceeded: before.size > MAX_FILE_BYTES });
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !privateLedger(opened) || !sameNode(opened, before)
    ) throw new Error('resolution witness ledger changed during open');
    verifyOpenedLedger(path, opened, directories);

    const { lines, tornTail } = completeLines(readOpenedFile(fd, opened.size).toString('utf8'));
    const physicalRows = lines.filter(Boolean).length;
    const limitExceeded = physicalRows > MAX_ROWS;
    const byDigest = new Map<string, { fingerprint: string; witness: ResolutionWitness; conflict: boolean }>();
    let invalidRows = tornTail ? 1 : 0;
    for (const line of lines.slice(0, MAX_ROWS)) {
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) { invalidRows += 1; continue; }
      try {
        const witness = reconstructWitness(JSON.parse(line) as unknown, true);
        if (!witness) { invalidRows += 1; continue; }
        const fingerprint = exactFingerprint(witness);
        const existing = byDigest.get(witness.resolutionDigest);
        if (!existing) byDigest.set(witness.resolutionDigest, { fingerprint, witness, conflict: false });
        else if (existing.fingerprint !== fingerprint) existing.conflict = true;
      } catch {
        invalidRows += 1;
      }
    }
    const after = fstatSync(fd);
    if (!privateLedger(after) || !sameNode(after, opened) || after.size !== opened.size) {
      throw new Error('resolution witness ledger changed during read');
    }
    verifyOpenedLedger(path, after, directories);
    const conflictingDigests = [...byDigest.values()].filter((entry) => entry.conflict).length;
    const witnesses = [...byDigest.values()]
      .filter((entry) => !entry.conflict)
      .map((entry) => entry.witness)
      .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt));
    return {
      witnesses,
      sourceState: invalidRows > 0 || conflictingDigests > 0 || limitExceeded ? 'degraded' : 'healthy',
      invalidRows,
      conflictingDigests,
      limitExceeded,
      physicalRows,
    };
  } catch {
    return emptyRead('degraded', { invalidRows: 1 });
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}
