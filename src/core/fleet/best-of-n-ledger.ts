/**
 * Append-only, metadata-only records for multi-model best-of-N dispatches.
 *
 * The compatibility reader remains an array, while the detailed reader makes
 * source completeness explicit for callers that use this as learning input.
 */

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
  opendirSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DEFAULT_EVENT_LIMIT = 10_000;
const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 100_000;
const HARD_EVENT_LIMIT = 100_000;
const HARD_MAX_FILES = 366;
const HARD_MAX_BYTES = 256 * 1024 * 1024;
const HARD_MAX_ROWS = 1_000_000;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROW_BYTES = 128 * 1024;
const MAX_CANDIDATES = 64;
const MAX_SCORE = 1_000_000_000;
const MAX_COST_USD = 10_000_000;
const MAX_LATENCY_MS = 30 * 24 * 60 * 60 * 1_000;

const RECORD_KEYS = new Set([
  'schemaVersion', 'ts', 'attemptId', 'workItemId', 'source', 'repo', 'n',
  'winnerIndex', 'winnerProposalId', 'totalCostUsd', 'candidates',
]);
const LEGACY_RECORD_KEYS = new Set([...RECORD_KEYS].filter((key) => key !== 'schemaVersion'));
const CANDIDATE_KEYS = new Set([
  'index', 'runId', 'engine', 'model', 'score', 'testsPassed', 'costUsd',
  'latencyMs', 'error', 'proposalOutcome', 'proposalOutcomeReason',
  'proposalId', 'won',
]);

export interface BestOfNCandidateRecord {
  index: number;
  runId?: string;
  engine: string;
  model: string | null;
  score: number;
  testsPassed?: boolean;
  costUsd?: number;
  latencyMs?: number;
  error?: string;
  proposalOutcome?: string;
  proposalOutcomeReason?: string;
  proposalId: string | null;
  won: boolean;
}

export interface BestOfNRecord {
  /** Added during persistence; optional here for compatibility with producers. */
  schemaVersion?: 1;
  ts: string;
  attemptId?: string;
  workItemId?: string;
  source: string;
  repo: string | null;
  n: number;
  winnerIndex: number;
  winnerProposalId: string | null;
  totalCostUsd: number;
  candidates: BestOfNCandidateRecord[];
}

export interface ReadBestOfNRecordsOptions {
  sinceMs?: number;
  limit?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  /** Return an empty compatibility array when the selected source is partial. */
  requireComplete?: boolean;
  /** Inspect an already-private store without locks or permission migration. */
  inspectionOnly?: boolean;
}

export type BestOfNReadStopReason =
  | 'event-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error';

export interface BestOfNSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: BestOfNReadStopReason[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface BestOfNRecordsReadResult extends BestOfNSourceQuality {
  records: BestOfNRecord[];
}

function storageRoot(): string {
  const configured = process.env.ASHLR_HOME;
  return typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
}

export function bestOfNDir(): string {
  return join(storageRoot(), 'best-of-n');
}

function lockPath(): string {
  return join(bestOfNDir(), '.best-of-n.lock');
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function migratableDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0);
}

function privateFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function migratableFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface DirectoryState {
  root: Stats;
  ledger: Stats;
}

function createPrivateDirectory(path: string): Stats {
  const created = !existsSync(path);
  if (created) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!migratableDirectory(before)) throw new Error('unsafe best-of-N directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) throw new Error('best-of-N directory changed');
  if (created) {
    let fd: number | undefined;
    try {
      fd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return after;
}

function ensurePrivateDirectories(): DirectoryState {
  const rootPath = storageRoot();
  const root = createPrivateDirectory(rootPath);
  const ledger = createPrivateDirectory(bestOfNDir());
  const rootAfter = lstatSync(rootPath);
  if (!privateDirectory(rootAfter) || !sameNode(root, rootAfter)) throw new Error('best-of-N root changed');
  return { root: rootAfter, ledger };
}

function existingPrivateDirectories(): DirectoryState | undefined {
  const rootPath = storageRoot();
  const dir = bestOfNDir();
  if (!existsSync(rootPath) || !existsSync(dir)) return undefined;
  const root = lstatSync(rootPath);
  const ledger = lstatSync(dir);
  if (!migratableDirectory(root) || !migratableDirectory(ledger)) throw new Error('unsafe best-of-N directory');
  chmodSync(rootPath, 0o700);
  chmodSync(dir, 0o700);
  const privateRoot = lstatSync(rootPath);
  const privateLedger = lstatSync(dir);
  if (!privateDirectory(privateRoot) || !privateDirectory(privateLedger) ||
    !sameNode(root, privateRoot) || !sameNode(ledger, privateLedger)) throw new Error('best-of-N directory changed');
  return { root: privateRoot, ledger: privateLedger };
}

function inspectPrivateDirectories(): DirectoryState | undefined {
  const rootPath = storageRoot();
  const dir = bestOfNDir();
  if (!existsSync(rootPath) || !existsSync(dir)) return undefined;
  const root = lstatSync(rootPath);
  const ledger = lstatSync(dir);
  if (!privateDirectory(root) || !privateDirectory(ledger)) throw new Error('unsafe best-of-N directory');
  return { root, ledger };
}

function verifyDirectories(expected: DirectoryState): void {
  const root = lstatSync(storageRoot());
  const ledger = lstatSync(bestOfNDir());
  if (
    !privateDirectory(root) || !privateDirectory(ledger) ||
    !sameNode(root, expected.root) || !sameNode(ledger, expected.ledger)
  ) throw new Error('best-of-N directory replaced');
}

function boundedText(value: unknown, max: number, required = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return required ? undefined : undefined;
  const scrubbed = scrubSecrets(trimmed);
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 3)}...` : scrubbed;
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : undefined;
}

function sanitizeCandidate(value: unknown, persisted: boolean): BestOfNCandidateRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (persisted && !exactKeys(raw, CANDIDATE_KEYS)) return undefined;
  const index = Number.isInteger(raw['index']) && Number(raw['index']) >= 0 && Number(raw['index']) < MAX_CANDIDATES
    ? Number(raw['index'])
    : undefined;
  const engine = boundedText(raw['engine'], 80, true);
  const model = raw['model'] === null ? null : boundedText(raw['model'], 160, true);
  const score = boundedNumber(raw['score'], -MAX_SCORE, MAX_SCORE);
  const proposalId = raw['proposalId'] === null ? null : boundedText(raw['proposalId'], 160, true);
  if (
    index === undefined || !engine || model === undefined || score === undefined ||
    proposalId === undefined || typeof raw['won'] !== 'boolean'
  ) return undefined;

  const runId = boundedText(raw['runId'], 160);
  const costUsd = boundedNumber(raw['costUsd'], 0, MAX_COST_USD);
  const latencyMs = boundedNumber(raw['latencyMs'], 0, MAX_LATENCY_MS);
  const error = boundedText(raw['error'], 500);
  const proposalOutcome = boundedText(raw['proposalOutcome'], 80);
  const proposalOutcomeReason = boundedText(raw['proposalOutcomeReason'], 500);
  if (raw['testsPassed'] !== undefined && typeof raw['testsPassed'] !== 'boolean') return undefined;
  if (raw['runId'] !== undefined && runId === undefined) return undefined;
  if (raw['costUsd'] !== undefined && costUsd === undefined) return undefined;
  if (raw['latencyMs'] !== undefined && latencyMs === undefined) return undefined;
  if (raw['error'] !== undefined && error === undefined) return undefined;
  if (raw['proposalOutcome'] !== undefined && proposalOutcome === undefined) return undefined;
  if (raw['proposalOutcomeReason'] !== undefined && proposalOutcomeReason === undefined) return undefined;

  return {
    index,
    ...(runId ? { runId } : {}),
    engine,
    model,
    score,
    ...(typeof raw['testsPassed'] === 'boolean' ? { testsPassed: raw['testsPassed'] } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(error ? { error } : {}),
    ...(proposalOutcome ? { proposalOutcome } : {}),
    ...(proposalOutcomeReason ? { proposalOutcomeReason } : {}),
    proposalId,
    won: raw['won'],
  };
}

function reconstructRecord(value: unknown, persisted: boolean): BestOfNRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (persisted) {
    const current = raw['schemaVersion'] === 1 && exactKeys(raw, RECORD_KEYS);
    const legacy = raw['schemaVersion'] === undefined && exactKeys(raw, LEGACY_RECORD_KEYS);
    if (!current && !legacy) return undefined;
  }
  if (raw['schemaVersion'] !== undefined && raw['schemaVersion'] !== 1) return undefined;
  const ts = canonicalTimestamp(raw['ts']);
  const attemptId = boundedText(raw['attemptId'], 160);
  const workItemId = boundedText(raw['workItemId'], 240);
  const source = boundedText(raw['source'], 80, true);
  const repo = raw['repo'] === null ? null : boundedText(raw['repo'], 500, true);
  const n = Number.isInteger(raw['n']) && Number(raw['n']) >= 1 && Number(raw['n']) <= MAX_CANDIDATES
    ? Number(raw['n'])
    : undefined;
  const winnerIndex = Number.isInteger(raw['winnerIndex']) && Number(raw['winnerIndex']) >= -1 &&
    Number(raw['winnerIndex']) < MAX_CANDIDATES ? Number(raw['winnerIndex']) : undefined;
  const winnerProposalId = raw['winnerProposalId'] === null
    ? null
    : boundedText(raw['winnerProposalId'], 160, true);
  const totalCostUsd = boundedNumber(raw['totalCostUsd'], 0, MAX_COST_USD);
  if (
    !ts || !source || repo === undefined || n === undefined || winnerIndex === undefined ||
    winnerProposalId === undefined || totalCostUsd === undefined || !Array.isArray(raw['candidates']) ||
    raw['candidates'].length !== n
  ) return undefined;
  if (raw['attemptId'] !== undefined && attemptId === undefined) return undefined;
  if (raw['workItemId'] !== undefined && workItemId === undefined) return undefined;

  const candidates = raw['candidates'].map((candidate) => sanitizeCandidate(candidate, persisted));
  if (candidates.some((candidate) => candidate === undefined)) return undefined;
  const completeCandidates = candidates as BestOfNCandidateRecord[];
  const indexes = new Set(completeCandidates.map((candidate) => candidate.index));
  if (indexes.size !== n || [...indexes].some((index) => index < 0 || index >= n)) return undefined;
  const winners = completeCandidates.filter((candidate) => candidate.won);
  if (winnerIndex === -1) {
    if (winnerProposalId !== null || winners.length !== 0) return undefined;
  } else {
    const winner = completeCandidates.find((candidate) => candidate.index === winnerIndex);
    if (!winner || winners.length !== 1 || winners[0] !== winner || winnerProposalId === null ||
      winner.proposalId !== winnerProposalId) return undefined;
  }
  return {
    schemaVersion: 1,
    ts,
    ...(attemptId ? { attemptId } : {}),
    ...(workItemId ? { workItemId } : {}),
    source,
    repo,
    n,
    winnerIndex,
    winnerProposalId,
    totalCostUsd,
    candidates: completeCandidates,
  };
}

function existingPrivateFile(path: string): Stats | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!migratableFile(stat)) throw new Error('unsafe best-of-N ledger file');
  return stat;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('best-of-N append made no progress');
    offset += written;
  }
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error('short best-of-N read');
    offset += count;
  }
  return bytes;
}

function appendRecord(record: BestOfNRecord): void {
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  let fd: number | undefined;
  try {
    const directories = ensurePrivateDirectories();
    lock = acquireLocalStoreLock(lockPath(), 2_000);
    if (!lock) return;
    verifyDirectories(directories);
    const partition = record.ts.slice(0, 10);
    const path = join(bestOfNDir(), `${partition}.jsonl`);
    const before = existingPrivateFile(path);
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (before ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    let opened = fstatSync(fd);
    if (!migratableFile(opened) || (before && !sameNode(before, opened))) return;
    fchmodSync(fd, 0o600);
    opened = fstatSync(fd);
    if (!privateFile(opened)) return;
    if (opened.size > MAX_FILE_BYTES) return;
    let separator = '';
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, opened.size - 1) !== 1) return;
      if (tail[0] !== 0x0a) separator = '\n';
    }
    const bytes = Buffer.from(`${separator}${JSON.stringify(record)}\n`, 'utf8');
    if (bytes.length > MAX_ROW_BYTES || opened.size + bytes.length > MAX_FILE_BYTES) return;
    verifyDirectories(directories);
    const authoritative = lstatSync(path);
    if (!privateFile(authoritative) || !sameNode(opened, authoritative)) return;
    writeAll(fd, bytes);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      !privateFile(persisted) || !privateFile(pathAfter) || !sameNode(opened, persisted) ||
      !sameNode(persisted, pathAfter) || persisted.size !== opened.size + bytes.length
    ) return;
    verifyDirectories(directories);
    if (!before) {
      let dirFd: number | undefined;
      try {
        dirFd = openSync(bestOfNDir(), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const openedDir = fstatSync(dirFd);
        if (!privateDirectory(openedDir) || !sameNode(openedDir, directories.ledger)) return;
        fsyncSync(dirFd);
      } finally {
        if (dirFd !== undefined) closeSync(dirFd);
      }
    }
  } catch {
    // Telemetry must never disrupt dispatch.
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

/** Append one valid, scrubbed record. Never throws and intentionally returns void. */
export function recordBestOfN(record: BestOfNRecord): void {
  try {
    const sanitized = reconstructRecord(record, false);
    if (!sanitized || !reconstructRecord(sanitized, true)) return;
    const line = `${JSON.stringify(sanitized)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) return;
    appendRecord(sanitized);
  } catch {
    // Telemetry must never disrupt dispatch.
  }
}

function boundedOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyRead(
  sourceState: BestOfNSourceQuality['sourceState'],
  overrides: Partial<BestOfNRecordsReadResult> = {},
): BestOfNRecordsReadResult {
  return {
    records: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushReason(reasons: BestOfNReadStopReason[], reason: BestOfNReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function validDateFile(file: string): boolean {
  const date = DATE_FILE_RE.exec(file)?.[1];
  if (!date) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const date = DATE_FILE_RE.exec(file)?.[1];
  if (!date) return false;
  return Date.parse(`${date}T23:59:59.999Z`) >= sinceMs;
}

function readPrivateFile(
  path: string,
  maxBytes: number,
  inspectionOnly = false,
): { text: string; bytes: number } | BestOfNReadStopReason {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (inspectionOnly ? !privateFile(pathBefore) : !migratableFile(pathBefore)) return 'io-error';
    if (pathBefore.size > maxBytes) return 'byte-limit';
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let opened = fstatSync(fd);
    if ((inspectionOnly ? !privateFile(opened) : !migratableFile(opened)) ||
      !sameNode(pathBefore, opened) || opened.size > maxBytes) {
      return opened.size > maxBytes ? 'byte-limit' : 'io-error';
    }
    if (!inspectionOnly) {
      fchmodSync(fd, 0o600);
      opened = fstatSync(fd);
      if (!privateFile(opened)) return 'io-error';
    }
    const bytes = readAll(fd, opened.size);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      !privateFile(after) || !privateFile(pathAfter) || !sameNode(opened, after) ||
      !sameNode(after, pathAfter) || after.size !== opened.size
    ) return 'io-error';
    return { text: bytes.toString('utf8'), bytes: bytes.length };
  } catch {
    return 'io-error';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

/** Read bounded records with an explicit, fail-closed source-quality contract. */
export function readBestOfNRecordsDetailed(
  opts: ReadBestOfNRecordsOptions = {},
): BestOfNRecordsReadResult {
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  try {
    const maxFiles = boundedOption(opts.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES);
    const maxBytes = boundedOption(opts.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const maxRows = boundedOption(opts.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const eventLimit = boundedOption(opts.limit, DEFAULT_EVENT_LIMIT, HARD_EVENT_LIMIT);
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined;
    const directories = opts.inspectionOnly ? inspectPrivateDirectories() : existingPrivateDirectories();
    if (!directories) return emptyRead('missing');
    if (!opts.inspectionOnly) {
      lock = acquireLocalStoreLock(lockPath(), 250);
      if (!lock) return emptyRead('degraded', {
        complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
      });
    }
    verifyDirectories(directories);
    const directorySnapshot = lstatSync(bestOfNDir());

    const files: string[] = [];
    let entries = 0;
    const handle = opendirSync(bestOfNDir());
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entries++;
        if (entries > MAX_DIRECTORY_ENTRIES) {
          return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
        }
        if (entry.name.endsWith('.jsonl')) {
          if (!DATE_FILE_RE.test(entry.name) || !validDateFile(entry.name)) {
            return emptyRead('degraded', {
              sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
            });
          }
          if (sinceMs === undefined || fileMayContainSince(entry.name, sinceMs)) files.push(entry.name);
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
    files.sort().reverse();
    if (files.length === 0) {
      verifyDirectories(directories);
      const directoryAfter = lstatSync(bestOfNDir());
      return sameNode(directorySnapshot, directoryAfter) &&
        directorySnapshot.mtimeMs === directoryAfter.mtimeMs && directorySnapshot.ctimeMs === directoryAfter.ctimeMs
        ? emptyRead('healthy', { sourcePresent: true })
        : emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }

    const result = emptyRead('healthy', { sourcePresent: true });
    let stop = false;
    for (const file of files) {
      if (stop) break;
      if (result.filesRead >= maxFiles) {
        pushReason(result.stopReasons, 'file-limit');
        result.complete = false;
        break;
      }
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) {
        pushReason(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }
      const loaded = readPrivateFile(join(bestOfNDir(), file), remainingBytes, opts.inspectionOnly === true);
      result.filesRead++;
      if (typeof loaded === 'string') {
        if (loaded === 'io-error') result.unreadableFiles++;
        pushReason(result.stopReasons, loaded);
        result.complete = false;
        break;
      }
      result.bytesRead += loaded.bytes;
      const lines = loaded.text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (let index = lines.length - 1; index >= 0; index--) {
        if (result.rowsScanned >= maxRows) {
          pushReason(result.stopReasons, 'row-limit');
          result.complete = false;
          stop = true;
          break;
        }
        const line = lines[index]!;
        result.rowsScanned++;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) {
          result.invalidRows++;
          continue;
        }
        let record: BestOfNRecord | undefined;
        try { record = reconstructRecord(JSON.parse(line) as unknown, true); }
        catch { record = undefined; }
        const partition = DATE_FILE_RE.exec(file)![1]!;
        if (!record || record.ts.slice(0, 10) !== partition) {
          result.invalidRows++;
          continue;
        }
        const timestamp = Date.parse(record.ts);
        if (sinceMs !== undefined && timestamp < sinceMs) continue;
        if (result.records.length >= eventLimit) {
          pushReason(result.stopReasons, 'event-limit');
          result.complete = false;
          stop = true;
          break;
        }
        result.records.push(record);
      }
    }
    const directoryAfter = lstatSync(bestOfNDir());
    if (
      !privateDirectory(directoryAfter) || !sameNode(directorySnapshot, directoryAfter) ||
      directorySnapshot.mtimeMs !== directoryAfter.mtimeMs || directorySnapshot.ctimeMs !== directoryAfter.ctimeMs
    ) {
      pushReason(result.stopReasons, 'io-error');
      result.unreadableFiles++;
      result.complete = false;
    }
    result.records.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.sourceState = 'degraded';
      result.complete = false;
    }
    return result;
  } catch {
    return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Compatibility array reader with non-enumerable source quality. Never throws. */
export function readBestOfNRecords(opts: ReadBestOfNRecordsOptions = {}): BestOfNRecord[] {
  const result = readBestOfNRecordsDetailed(opts);
  const records = opts.requireComplete === true && !result.complete ? [] : result.records;
  Object.defineProperty(records, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      stopReasons: result.stopReasons,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      rowsScanned: result.rowsScanned,
      invalidRows: result.invalidRows,
      unreadableFiles: result.unreadableFiles,
    } satisfies BestOfNSourceQuality,
    enumerable: false,
  });
  return records;
}
