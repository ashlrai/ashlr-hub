/**
 * Signed, observation-only post-merge outcomes.
 *
 * This append-only ledger is deliberately outside proposal, verification, and
 * merge authority. It stores bounded causal metadata only; execution content
 * such as prompts, diffs, output, environment, and file contents is discarded.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
import { loadOrCreateKey } from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_ROWS = 25_000;
const MAX_ROW_BYTES = 4_096;
const DEFAULT_MAX_BYTES = HARD_MAX_FILE_BYTES;
const DEFAULT_MAX_ROWS = HARD_MAX_ROWS;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/#-]{0,239}$/;
const COMMAND_KIND_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const MAX_COMMAND_KINDS = 16;
const KNOWN_KEYS = new Set([
  'schemaVersion',
  'eventId',
  'observedAt',
  'authority',
  'outcome',
  'basis',
  'confidence',
  'repo',
  'proposalId',
  'runId',
  'trajectoryId',
  'workItemId',
  'mergeCommit',
  'observedHead',
  'baselineHead',
  'candidateCount',
  'commandKinds',
  'labelBasis',
  'attestation',
]);

export type PostMergeOutcome = 'regressed' | 'followed-up' | 'reverted';
export type PostMergeObservationBasis = 'bisect-first-bad' | 'git-revert-reference' | 'overlapping-fix';
export type PostMergeObservationConfidence = 'deterministic' | 'heuristic';

/** Fixed metadata-only v1 persistence schema. */
export interface PostMergeObservation {
  schemaVersion: 1;
  eventId: string;
  observedAt: string;
  authority: 'observation-only';
  outcome: PostMergeOutcome;
  basis: PostMergeObservationBasis;
  confidence: PostMergeObservationConfidence;
  repo: string;
  proposalId: string;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
  mergeCommit: string;
  observedHead: string;
  baselineHead?: string;
  candidateCount?: number;
  commandKinds?: string[];
  labelBasis: 'post-merge-regression';
  attestation: string;
}

export type PostMergeObservationInput = Omit<
  PostMergeObservation,
  'schemaVersion' | 'eventId' | 'authority' | 'labelBasis' | 'attestation'
> & {
  schemaVersion?: 1;
  eventId?: string;
  authority?: 'observation-only';
  labelBasis?: 'post-merge-regression';
  attestation?: string;
};

export interface PostMergeObservationWriteResult {
  attempted: number;
  recorded: number;
  upgraded: number;
  replayed: number;
  obsolete: number;
  conflicted: number;
  invalid: number;
  failed: number;
}

export type PostMergeObservationStopReason =
  | 'byte-limit'
  | 'file-limit'
  | 'row-limit'
  | 'invalid-row'
  | 'conflict'
  | 'io-error';

export interface PostMergeObservationReadOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  requireComplete?: boolean;
  lockWaitMs?: number;
}

export interface PostMergeObservationReadResult {
  observations: PostMergeObservation[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: PostMergeObservationStopReason[];
  filesRead: number;
  bytesRead: number;
  physicalRows: number;
  invalidRows: number;
  conflictingEvents: number;
  duplicateRows: number;
  supersededRows: number;
  limitExceeded: boolean;
}

function postMergeObservationHome(): string {
  const configured = process.env.ASHLR_HOME;
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed !== '' && noControlCharacters(trimmed) && isAbsolute(trimmed)) {
      try { return resolve(trimmed); } catch { /* fall through to the private user store */ }
    }
  }
  return resolve(join(homedir(), '.ashlr'));
}

export function postMergeObservationLedgerPath(): string {
  return join(postMergeObservationHome(), 'fleet', 'post-merge-observations.jsonl');
}

function lockPath(): string {
  return `${postMergeObservationLedgerPath()}.lock`;
}

function noControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024 || !noControlCharacters(value)) return null;
  try {
    const canonical = resolve(value);
    return isAbsolute(canonical) && canonical.length <= 1_024 ? canonical : null;
  } catch {
    return null;
  }
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function optionalId(row: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(row, key) || row[key] === undefined) return undefined;
  return safeId(row[key]) ? row[key] : null;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalCommandKinds(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMAND_KINDS) return null;
  if (value.some((entry) => typeof entry !== 'string' || !COMMAND_KIND_RE.test(entry))) return null;
  const canonical = [...new Set(value as string[])].sort();
  return canonical.length === value.length ? canonical : null;
}

type EventIdentity = Pick<
  PostMergeObservation,
  'repo' | 'proposalId' | 'mergeCommit'
>;

/** Stable identity for all observations about one merged proposal incident. */
export function postMergeObservationEventId(identity: EventIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:post-merge-observation-event:v1',
    identity.repo,
    identity.proposalId,
    identity.mergeCommit,
  ])).digest('hex');
}

function attestationPayload(observation: Omit<PostMergeObservation, 'attestation'>): string {
  return JSON.stringify([
    'ashlr:post-merge-observation-attestation:v1',
    observation.schemaVersion,
    observation.eventId,
    observation.observedAt,
    observation.authority,
    observation.outcome,
    observation.basis,
    observation.confidence,
    observation.repo,
    observation.proposalId,
    observation.runId ?? null,
    observation.trajectoryId ?? null,
    observation.workItemId ?? null,
    observation.mergeCommit,
    observation.observedHead,
    observation.baselineHead ?? null,
    observation.candidateCount ?? null,
    observation.commandKinds ?? null,
    observation.labelBasis,
  ]);
}

function observationAttestation(observation: Omit<PostMergeObservation, 'attestation'>): string | null {
  try {
    return createHmac('sha256', loadOrCreateKey()).update(attestationPayload(observation)).digest('hex');
  } catch {
    return null;
  }
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function reconstructObservation(value: unknown, persisted: boolean): PostMergeObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (persisted && Object.keys(row).some((key) => !KNOWN_KEYS.has(key))) return null;
  const repo = canonicalRepo(row['repo']);
  const runId = optionalId(row, 'runId');
  const trajectoryId = optionalId(row, 'trajectoryId');
  const workItemId = optionalId(row, 'workItemId');
  const commandKinds = canonicalCommandKinds(row['commandKinds']);
  if (
    (row['schemaVersion'] !== undefined && row['schemaVersion'] !== 1) ||
    (row['authority'] !== undefined && row['authority'] !== 'observation-only') ||
    (row['labelBasis'] !== undefined && row['labelBasis'] !== 'post-merge-regression') ||
    !canonicalTimestamp(row['observedAt']) ||
    !['regressed', 'followed-up', 'reverted'].includes(String(row['outcome'])) ||
    !['bisect-first-bad', 'git-revert-reference', 'overlapping-fix'].includes(String(row['basis'])) ||
    !['deterministic', 'heuristic'].includes(String(row['confidence'])) ||
    !repo || !safeId(row['proposalId']) ||
    runId === null || trajectoryId === null || workItemId === null ||
    typeof row['mergeCommit'] !== 'string' || !GIT_SHA_RE.test(row['mergeCommit']) ||
    typeof row['observedHead'] !== 'string' || !GIT_SHA_RE.test(row['observedHead']) ||
    (row['baselineHead'] !== undefined &&
      (typeof row['baselineHead'] !== 'string' || !GIT_SHA_RE.test(row['baselineHead']))) ||
    (row['candidateCount'] !== undefined &&
      (!Number.isSafeInteger(row['candidateCount']) || Number(row['candidateCount']) < 1 || Number(row['candidateCount']) > 10_000)) ||
    commandKinds === null
  ) return null;

  const unsigned: Omit<PostMergeObservation, 'attestation'> = {
    schemaVersion: 1,
    eventId: '',
    observedAt: row['observedAt'] as string,
    authority: 'observation-only',
    outcome: row['outcome'] as PostMergeOutcome,
    basis: row['basis'] as PostMergeObservationBasis,
    confidence: row['confidence'] as PostMergeObservationConfidence,
    repo,
    proposalId: row['proposalId'],
    ...(runId === undefined ? {} : { runId }),
    ...(trajectoryId === undefined ? {} : { trajectoryId }),
    ...(workItemId === undefined ? {} : { workItemId }),
    mergeCommit: row['mergeCommit'],
    observedHead: row['observedHead'],
    ...(row['baselineHead'] === undefined ? {} : { baselineHead: row['baselineHead'] as string }),
    ...(row['candidateCount'] === undefined ? {} : { candidateCount: row['candidateCount'] as number }),
    ...(commandKinds === undefined ? {} : { commandKinds }),
    labelBasis: 'post-merge-regression',
  };
  unsigned.eventId = postMergeObservationEventId(unsigned);
  if (row['eventId'] !== undefined && !equalDigest(String(row['eventId']), unsigned.eventId)) return null;
  if (persisted && typeof row['eventId'] !== 'string') return null;
  const attestation = observationAttestation(unsigned);
  if (!attestation) return null;
  if (row['attestation'] !== undefined && !equalDigest(String(row['attestation']), attestation)) return null;
  if (persisted && typeof row['attestation'] !== 'string') return null;

  const observation = { ...unsigned, attestation };
  if (persisted) {
    const expectedKeys = Object.keys(observation).sort();
    const actualKeys = Object.keys(row).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) return null;
    if (commandKinds && JSON.stringify(row['commandKinds']) !== JSON.stringify(commandKinds)) return null;
  }
  return observation;
}

/** Rebuilds the fixed schema and discards every unrecognized input field. */
export function sanitizePostMergeObservation(value: unknown): PostMergeObservation | null {
  return reconstructObservation(value, false);
}

export function buildPostMergeObservation(input: PostMergeObservationInput): PostMergeObservation | null {
  return sanitizePostMergeObservation(input);
}

/** Verifies exact persisted shape, deterministic identity, and host attestation. */
export function verifyPostMergeObservation(value: unknown): value is PostMergeObservation {
  return reconstructObservation(value, true) !== null;
}

const OUTCOME_RANK: Record<PostMergeOutcome, number> = {
  'followed-up': 0,
  'regressed': 1,
  'reverted': 2,
};

function observationRank(observation: PostMergeObservation): number {
  return OUTCOME_RANK[observation.outcome] * 10 + (observation.confidence === 'deterministic' ? 1 : 0);
}

function semanticFingerprint(observation: PostMergeObservation): string {
  const { observedAt: _observedAt, attestation: _attestation, ...semantic } = observation;
  return JSON.stringify(semantic);
}

function owner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && owner(stat.uid)
    && (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateLedger(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && owner(stat.uid) && stat.nlink === 1
    && (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

interface PrivateDirectories {
  ashlr: Stats;
  fleet: Stats;
}

function createPrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!privateDirectory(before)) throw new Error('unsafe post-merge observation directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) throw new Error('post-merge observation directory changed');
  return after;
}

function ensurePrivateDirectories(): PrivateDirectories {
  const ashlrPath = postMergeObservationHome();
  const ashlr = createPrivateDirectory(ashlrPath);
  const fleet = createPrivateDirectory(join(ashlrPath, 'fleet'));
  const current = lstatSync(ashlrPath);
  if (!privateDirectory(current) || !sameNode(ashlr, current)) throw new Error('post-merge observation ancestor changed');
  return { ashlr: current, fleet };
}

function verifyDirectories(expected: PrivateDirectories): void {
  const ashlr = lstatSync(postMergeObservationHome());
  const fleet = lstatSync(dirname(postMergeObservationLedgerPath()));
  if (!privateDirectory(ashlr) || !privateDirectory(fleet) ||
      !sameNode(ashlr, expected.ashlr) || !sameNode(fleet, expected.fleet)) {
    throw new Error('post-merge observation directory replaced');
  }
}

function existingLedger(path: string): Stats | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!privateLedger(stat)) throw new Error('unsafe post-merge observation ledger');
  return stat;
}

function verifyOpened(path: string, opened: Stats, directories: PrivateDirectories): void {
  const current = lstatSync(path);
  verifyDirectories(directories);
  if (!privateLedger(opened) || !privateLedger(current) || !sameNode(opened, current)) {
    throw new Error('post-merge observation ledger replaced');
  }
}

function readOpened(fd: number, size: number): Buffer {
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

function bounded(value: number | undefined, fallback: number, hardMax: number, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(allowZero ? 0 : 1, Math.min(hardMax, Math.floor(value)));
}

function lockWait(value: number | undefined): number {
  return bounded(value, 2_000, 2_000, true);
}

interface ParsedLedger {
  rows: PostMergeObservation[];
  physicalRows: number;
  invalidRows: number;
  tornTail: boolean;
}

function parseCompleteLedger(bytes: Buffer): ParsedLedger {
  const { lines, tornTail } = completeLines(bytes.toString('utf8'));
  const rows: PostMergeObservation[] = [];
  let invalidRows = tornTail ? 1 : 0;
  for (const line of lines) {
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) { invalidRows += 1; continue; }
    try {
      const row = reconstructObservation(JSON.parse(line) as unknown, true);
      if (row) rows.push(row);
      else invalidRows += 1;
    } catch {
      invalidRows += 1;
    }
  }
  return { rows, physicalRows: lines.filter(Boolean).length + (tornTail ? 1 : 0), invalidRows, tornTail };
}

function appendObservation(
  observation: PostMergeObservation,
  waitMs: number,
): 'recorded' | 'upgraded' | 'replayed' | 'obsolete' | 'conflicted' | 'failed' {
  const path = postMergeObservationLedgerPath();
  let directories: PrivateDirectories;
  try {
    directories = ensurePrivateDirectories();
    existingLedger(path);
  } catch {
    return 'failed';
  }
  const lock = acquireLocalStoreLock(lockPath(), waitMs);
  if (!lock) return 'failed';
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    const before = existingLedger(path);
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    let opened = fstatSync(fd);
    if (!privateLedger(opened) || (before && !sameNode(before, opened)) || opened.size > HARD_MAX_FILE_BYTES) return 'failed';
    fchmodSync(fd, 0o600);
    opened = fstatSync(fd);
    verifyOpened(path, opened, directories);

    const bytes = readOpened(fd, opened.size);
    const parsed = parseCompleteLedger(bytes);
    if (parsed.invalidRows > 0 || parsed.tornTail || parsed.physicalRows >= HARD_MAX_ROWS) return 'failed';
    const sameEvent = parsed.rows.filter((row) => row.eventId === observation.eventId);
    if (sameEvent.length > 0) {
      const highestRank = Math.max(...sameEvent.map(observationRank));
      const candidateRank = observationRank(observation);
      const sameRank = sameEvent.filter((row) => observationRank(row) === candidateRank);
      if (candidateRank < highestRank) return 'obsolete';
      if (sameRank.some((row) => semanticFingerprint(row) === semanticFingerprint(observation))) return 'replayed';
      if (candidateRank === highestRank) return 'conflicted';
    }

    const afterRead = fstatSync(fd);
    if (!privateLedger(afterRead) || !sameNode(opened, afterRead) || afterRead.size !== opened.size) return 'failed';
    const serialized = Buffer.from(`${JSON.stringify(observation)}\n`, 'utf8');
    if (serialized.length > MAX_ROW_BYTES || opened.size + serialized.length > HARD_MAX_FILE_BYTES) return 'failed';
    verifyOpened(path, afterRead, directories);
    if (writeSync(fd, serialized) !== serialized.length) return 'failed';
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (!privateLedger(persisted) || !sameNode(opened, persisted) ||
        persisted.size !== opened.size + serialized.length) return 'failed';
    verifyOpened(path, persisted, directories);
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return sameEvent.length > 0 ? 'upgraded' : 'recorded';
  } catch {
    return 'failed';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

export function recordPostMergeObservations(
  input: PostMergeObservationInput | PostMergeObservationInput[],
  options: { lockWaitMs?: number } = {},
): PostMergeObservationWriteResult {
  const result: PostMergeObservationWriteResult = {
    attempted: 0,
    recorded: 0,
    upgraded: 0,
    replayed: 0,
    obsolete: 0,
    conflicted: 0,
    invalid: 0,
    failed: 0,
  };
  for (const candidate of Array.isArray(input) ? input : [input]) {
    result.attempted += 1;
    const observation = sanitizePostMergeObservation(candidate);
    if (!observation) { result.invalid += 1; continue; }
    const disposition = appendObservation(observation, lockWait(options.lockWaitMs));
    result[disposition] += 1;
  }
  return result;
}

export function recordPostMergeObservation(
  input: PostMergeObservationInput,
  options: { lockWaitMs?: number } = {},
): PostMergeObservationWriteResult {
  return recordPostMergeObservations(input, options);
}

function emptyRead(
  sourceState: PostMergeObservationReadResult['sourceState'],
  overrides: Partial<PostMergeObservationReadResult> = {},
): PostMergeObservationReadResult {
  return {
    observations: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    physicalRows: 0,
    invalidRows: 0,
    conflictingEvents: 0,
    duplicateRows: 0,
    supersededRows: 0,
    limitExceeded: false,
    ...overrides,
  };
}

function resolveRows(rows: PostMergeObservation[]): {
  observations: PostMergeObservation[];
  conflictingEvents: number;
  duplicateRows: number;
  supersededRows: number;
} {
  const grouped = new Map<string, PostMergeObservation[]>();
  for (const row of rows) {
    const eventRows = grouped.get(row.eventId) ?? [];
    eventRows.push(row);
    grouped.set(row.eventId, eventRows);
  }
  const observations: PostMergeObservation[] = [];
  let conflictingEvents = 0;
  let duplicateRows = 0;
  let supersededRows = 0;
  for (const eventRows of grouped.values()) {
    const highestRank = Math.max(...eventRows.map(observationRank));
    const highest = eventRows.filter((row) => observationRank(row) === highestRank);
    const byFingerprint = new Map(highest.map((row) => [semanticFingerprint(row), row]));
    duplicateRows += highest.length - byFingerprint.size;
    supersededRows += eventRows.length - highest.length;
    if (byFingerprint.size !== 1) { conflictingEvents += 1; continue; }
    const chosen = [...byFingerprint.values()].sort((left, right) =>
      Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    if (chosen) observations.push(chosen);
  }
  observations.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  return { observations, conflictingEvents, duplicateRows, supersededRows };
}

export function readPostMergeObservations(
  options: PostMergeObservationReadOptions = {},
): PostMergeObservationReadResult {
  const path = postMergeObservationLedgerPath();
  const ashlrPath = postMergeObservationHome();
  if (!existsSync(ashlrPath)) return emptyRead('missing', { sourcePresent: false });
  try {
    if (!privateDirectory(lstatSync(ashlrPath))) return emptyRead('degraded', { stopReasons: ['io-error'] });
  } catch {
    return emptyRead('degraded', { stopReasons: ['io-error'] });
  }
  if (!existsSync(dirname(path))) return emptyRead('missing', { sourcePresent: false });
  if (bounded(options.maxFiles, 1, 1, true) < 1 && existsSync(path)) {
    return emptyRead('degraded', {
      sourcePresent: true,
      complete: false,
      stopReasons: ['file-limit'],
      limitExceeded: true,
    });
  }
  let directories: PrivateDirectories;
  try {
    directories = ensurePrivateDirectories();
    existingLedger(path);
  } catch {
    return emptyRead('degraded', { stopReasons: ['io-error'] });
  }
  const lock = acquireLocalStoreLock(lockPath(), lockWait(options.lockWaitMs));
  if (!lock) return emptyRead('degraded', { stopReasons: ['io-error'] });
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    const before = existingLedger(path);
    if (!before) return emptyRead('missing', { sourcePresent: false });
    const maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_FILE_BYTES);
    if (before.size > maxBytes || before.size > HARD_MAX_FILE_BYTES) {
      return emptyRead('degraded', {
        sourcePresent: true,
        complete: false,
        stopReasons: ['byte-limit'],
        filesRead: 1,
        limitExceeded: true,
      });
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateLedger(opened) || !sameNode(opened, before)) throw new Error('post-merge observation ledger changed');
    verifyOpened(path, opened, directories);
    const bytes = readOpened(fd, opened.size);
    const parsed = parseCompleteLedger(bytes);
    const maxRows = bounded(options.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const rowLimit = parsed.physicalRows > maxRows || parsed.physicalRows > HARD_MAX_ROWS;
    const considered = parsed.rows.slice(0, maxRows);
    const resolved = resolveRows(considered);
    const after = fstatSync(fd);
    if (!privateLedger(after) || !sameNode(after, opened) || after.size !== opened.size) {
      throw new Error('post-merge observation ledger changed during read');
    }
    verifyOpened(path, after, directories);
    const stopReasons = new Set<PostMergeObservationStopReason>();
    if (rowLimit) stopReasons.add('row-limit');
    if (parsed.invalidRows > 0) stopReasons.add('invalid-row');
    if (resolved.conflictingEvents > 0) stopReasons.add('conflict');
    const degraded = stopReasons.size > 0;
    const observations = options.requireComplete === true && degraded ? [] : resolved.observations;
    return {
      observations,
      sourceState: degraded ? 'degraded' : 'healthy',
      sourcePresent: true,
      complete: !degraded,
      stopReasons: [...stopReasons],
      filesRead: 1,
      bytesRead: bytes.length,
      physicalRows: parsed.physicalRows,
      invalidRows: parsed.invalidRows,
      conflictingEvents: resolved.conflictingEvents,
      duplicateRows: resolved.duplicateRows,
      supersededRows: resolved.supersededRows,
      limitExceeded: rowLimit,
    };
  } catch {
    return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'] });
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}
