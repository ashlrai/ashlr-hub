import { createHash, randomBytes } from 'node:crypto';
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
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';

const MAX_STATE_BYTES = 16 * 1024;
const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EXACT_STATE_KEYS = new Set([
  'schemaVersion',
  'enrollmentDigest',
  'outcome',
  'regressionRepoAfter',
]);
const EXACT_OUTCOME_KEYS = new Set(['candidateAfter', 'sweepComplete', 'hadIncomplete', 'candidateSetDigest']);
const EXACT_CANDIDATE_KEYS = new Set(['proposalId', 'mergeCommitOid']);

export interface MonitoringOutcomeCandidateCursor {
  /** Proposal identity and immutable merge OID form the stable composite key. */
  proposalId: string;
  mergeCommitOid: string;
}

export interface MonitoringCursorV1 {
  schemaVersion: 1;
  /** Digest of the canonical, sorted enrolled repository set. */
  enrollmentDigest: string;
  outcome: {
    /** Last fully handled candidate, or null before the first candidate. */
    candidateAfter: MonitoringOutcomeCandidateCursor | null;
    /** True only after the current candidate set was traversed to its end. */
    sweepComplete: boolean;
    /** True when any candidate/source in the current sweep was inconclusive. */
    hadIncomplete: boolean;
    /** Stable digest of the candidate identities traversed by this sweep. */
    candidateSetDigest: string | null;
  };
  /** Last fully handled canonical repository path for regression monitoring. */
  regressionRepoAfter: string | null;
}

export interface MonitoringCursorReadResult {
  cursor: MonitoringCursorV1 | null;
  /** Valid bytes currently on disk, including a prior enrollment generation, for CAS replacement. */
  storedCursor: MonitoringCursorV1 | null;
  sourceState: 'healthy' | 'missing' | 'degraded';
  /** False means valid state belongs to a different enrollment generation. */
  enrollmentMatches: boolean;
}

export interface SuccessorSelection<T> {
  selected: T[];
  wrapped: boolean;
}

export interface Successor<T> {
  value: T | null;
  wrapped: boolean;
}

function noControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || !noControlCharacters(value)) {
    return null;
  }
  try {
    const canonical = resolve(value);
    return isAbsolute(canonical) && canonical.length <= 4_096 ? canonical : null;
  } catch {
    return null;
  }
}

function canonicalEnrollment(repos: readonly string[]): string[] | null {
  const canonical = repos.map(canonicalRepo);
  if (canonical.some((repo) => repo === null)) return null;
  return [...new Set(canonical as string[])].sort((left, right) => left.localeCompare(right));
}

/** Pure digest of canonical absolute repo paths; input order and duplicates do not matter. */
export function canonicalEnrollmentDigest(repos: readonly string[]): string {
  const canonical = canonicalEnrollment(repos);
  if (!canonical) return '';
  return createHash('sha256').update(JSON.stringify([
    'ashlr:fleet-monitoring-enrollment:v1',
    canonical,
  ])).digest('hex');
}

export const monitoringEnrollmentDigest = canonicalEnrollmentDigest;

function safeProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 240 && noControlCharacters(value);
}

function sanitizeCandidate(value: unknown): MonitoringOutcomeCandidateCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== EXACT_CANDIDATE_KEYS.size || keys.some((key) => !EXACT_CANDIDATE_KEYS.has(key))) return null;
  if (!safeProposalId(row['proposalId']) || typeof row['mergeCommitOid'] !== 'string' || !SHA1_RE.test(row['mergeCommitOid'])) {
    return null;
  }
  return { proposalId: row['proposalId'], mergeCommitOid: row['mergeCommitOid'] };
}

/** Stable lexicographic key for outcome rotation. It never relies on wall-clock order. */
export function outcomeCandidateKey(candidate: MonitoringOutcomeCandidateCursor): string {
  return JSON.stringify([candidate.proposalId, candidate.mergeCommitOid]);
}

/**
 * Select up to `limit` successors from a stable-key ordering, wrapping once.
 * Duplicate keys are collapsed so one identity cannot consume a bounded pass.
 */
export function selectSuccessorsWithWrap<T>(
  values: readonly T[],
  after: string | null,
  limit: number,
  keyOf: (value: T) => string,
): SuccessorSelection<T> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { selected: [], wrapped: false };
  const keyed = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (typeof key === 'string' && key.length > 0 && noControlCharacters(key) && !keyed.has(key)) keyed.set(key, value);
  }
  const ordered = [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (ordered.length === 0) return { selected: [], wrapped: false };

  let start = 0;
  if (after !== null) {
    const exact = ordered.findIndex(([key]) => key === after);
    if (exact >= 0) start = exact + 1;
    else {
      const successor = ordered.findIndex(([key]) => key.localeCompare(after) > 0);
      start = successor >= 0 ? successor : ordered.length;
    }
  }
  const wrapped = start >= ordered.length;
  if (wrapped) start = 0;
  const count = Math.min(limit, ordered.length);
  const selected: T[] = [];
  for (let offset = 0; offset < count; offset++) {
    selected.push(ordered[(start + offset) % ordered.length]![1]);
  }
  return { selected, wrapped: wrapped || start + count > ordered.length };
}

/** Select one successor and wrap to the first identity after the final key. */
export function selectSuccessorWithWrap<T>(
  values: readonly T[],
  after: string | null,
  keyOf: (value: T) => string,
): T | null {
  return selectSuccessorsWithWrap(values, after, 1, keyOf).selected[0] ?? null;
}

/** Simple one-at-a-time rotation primitive for daemon integrations. */
export function selectSuccessor<T>(
  values: readonly T[],
  after: string | null,
  keyOf: (value: T) => string,
): Successor<T> {
  const result = selectSuccessorsWithWrap(values, after, 1, keyOf);
  return { value: result.selected[0] ?? null, wrapped: result.wrapped };
}

export function selectOutcomeCandidateSuccessors(
  candidates: readonly MonitoringOutcomeCandidateCursor[],
  after: MonitoringOutcomeCandidateCursor | null,
  limit: number,
): SuccessorSelection<MonitoringOutcomeCandidateCursor> {
  return selectSuccessorsWithWrap(candidates, after ? outcomeCandidateKey(after) : null, limit, outcomeCandidateKey);
}

export function selectRegressionRepoSuccessors(
  repos: readonly string[],
  after: string | null,
  limit: number,
): SuccessorSelection<string> {
  const canonical = canonicalEnrollment(repos) ?? [];
  const canonicalAfter = after === null ? null : canonicalRepo(after);
  return selectSuccessorsWithWrap(canonical, canonicalAfter, limit, (repo) => repo);
}

export function buildMonitoringCursor(
  repos: readonly string[],
  progress: Partial<Pick<MonitoringCursorV1, 'outcome' | 'regressionRepoAfter'>> = {},
): MonitoringCursorV1 | null {
  const enrollmentDigest = canonicalEnrollmentDigest(repos);
  if (!enrollmentDigest) return null;
  return sanitizeMonitoringCursor({
    schemaVersion: 1,
    enrollmentDigest,
    outcome: progress.outcome ?? {
      candidateAfter: null,
      sweepComplete: false,
      hadIncomplete: false,
      candidateSetDigest: null,
    },
    regressionRepoAfter: progress.regressionRepoAfter ?? null,
  });
}

/** Strictly reconstruct v1 state. Unknown fields and future versions are rejected. */
export function sanitizeMonitoringCursor(value: unknown): MonitoringCursorV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== EXACT_STATE_KEYS.size || keys.some((key) => !EXACT_STATE_KEYS.has(key))) return null;
  if (row['schemaVersion'] !== 1 || typeof row['enrollmentDigest'] !== 'string' || !SHA256_RE.test(row['enrollmentDigest'])) {
    return null;
  }
  const outcome = row['outcome'];
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  const outcomeRow = outcome as Record<string, unknown>;
  const outcomeKeys = Object.keys(outcomeRow);
  if (![2, 3, EXACT_OUTCOME_KEYS.size].includes(outcomeKeys.length) ||
    outcomeKeys.some((key) => !EXACT_OUTCOME_KEYS.has(key)) ||
    !Object.hasOwn(outcomeRow, 'candidateAfter') || !Object.hasOwn(outcomeRow, 'sweepComplete')) return null;
  if (typeof outcomeRow['sweepComplete'] !== 'boolean') return null;
  if (outcomeRow['hadIncomplete'] !== undefined && typeof outcomeRow['hadIncomplete'] !== 'boolean') return null;
  if (outcomeRow['candidateSetDigest'] !== undefined && outcomeRow['candidateSetDigest'] !== null &&
    (typeof outcomeRow['candidateSetDigest'] !== 'string' || !SHA256_RE.test(outcomeRow['candidateSetDigest']))) return null;
  const candidateAfter = outcomeRow['candidateAfter'] === null ? null : sanitizeCandidate(outcomeRow['candidateAfter']);
  if (outcomeRow['candidateAfter'] !== null && !candidateAfter) return null;
  const regressionRepoAfter = row['regressionRepoAfter'] === null ? null : canonicalRepo(row['regressionRepoAfter']);
  if (row['regressionRepoAfter'] !== null && (!regressionRepoAfter || regressionRepoAfter !== row['regressionRepoAfter'])) return null;
  return {
    schemaVersion: 1,
    enrollmentDigest: row['enrollmentDigest'],
    outcome: {
      candidateAfter,
      sweepComplete: outcomeRow['sweepComplete'],
      hadIncomplete: outcomeRow['hadIncomplete'] === true,
      candidateSetDigest: typeof outcomeRow['candidateSetDigest'] === 'string'
        ? outcomeRow['candidateSetDigest']
        : null,
    },
    regressionRepoAfter,
  };
}

function storageRoot(): string {
  const configured = process.env.ASHLR_HOME;
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed && noControlCharacters(trimmed) && isAbsolute(trimmed)) {
      try { return resolve(trimmed); } catch { /* use the private default */ }
    }
  }
  return join(homedir(), '.ashlr');
}

export function monitoringCursorPath(): string {
  return join(storageRoot(), 'fleet', 'monitoring-cursor.json');
}

function lockPath(): string {
  return `${monitoringCursorPath()}.lock`;
}

function privateOwner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateOwner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface PrivateDirectories {
  rootPath: string;
  root: Stats;
  fleetPath: string;
  fleet: Stats;
}

function createPrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  if (!privateDirectory(before)) throw new Error('unsafe monitoring cursor directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) throw new Error('monitoring cursor directory changed');
  return after;
}

function ensurePrivateDirectories(): PrivateDirectories {
  const rootPath = storageRoot();
  const root = createPrivateDirectory(rootPath);
  const fleetPath = join(rootPath, 'fleet');
  const fleet = createPrivateDirectory(fleetPath);
  const rebound = lstatSync(rootPath);
  if (!privateDirectory(rebound) || !sameNode(root, rebound)) throw new Error('monitoring cursor root changed');
  return { rootPath, root: rebound, fleetPath, fleet };
}

function verifyDirectories(expected: PrivateDirectories): void {
  const root = lstatSync(expected.rootPath);
  const fleet = lstatSync(expected.fleetPath);
  if (!privateDirectory(root) || !privateDirectory(fleet) || !sameNode(root, expected.root) || !sameNode(fleet, expected.fleet)) {
    throw new Error('monitoring cursor directory replaced');
  }
}

function readAll(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) return null;
    offset += count;
  }
  return bytes;
}

function readUnlocked(path: string, directories: PrivateDirectories): MonitoringCursorV1 | null | 'missing' | 'degraded' {
  if (!existsSync(path)) return 'missing';
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    const before = lstatSync(path);
    if (!privateFile(before) || before.size < 2 || before.size > MAX_STATE_BYTES) return 'degraded';
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(before, opened) || opened.size !== before.size) return 'degraded';
    const bytes = readAll(fd, opened.size);
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!bytes || !privateFile(after) || !privateFile(rebound) || !sameNode(opened, after) ||
      !sameNode(after, rebound) || after.size !== opened.size || rebound.size !== after.size) return 'degraded';
    return sanitizeMonitoringCursor(JSON.parse(bytes.toString('utf8')) as unknown) ?? 'degraded';
  } catch {
    return 'degraded';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function readMonitoringCursor(repos?: readonly string[]): MonitoringCursorReadResult {
  const path = monitoringCursorPath();
  const root = storageRoot();
  const fleet = dirname(path);
  if (!existsSync(root)) return { cursor: null, storedCursor: null, sourceState: 'missing', enrollmentMatches: true };
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    const rootStat = lstatSync(root);
    if (!privateDirectory(rootStat)) return { cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false };
    if (!existsSync(fleet)) return { cursor: null, storedCursor: null, sourceState: 'missing', enrollmentMatches: true };
    const fleetStat = lstatSync(fleet);
    if (!privateDirectory(fleetStat)) return { cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false };
    if (!existsSync(path)) return { cursor: null, storedCursor: null, sourceState: 'missing', enrollmentMatches: true };
    lock = acquireLocalStoreLock(lockPath(), 20);
    if (!lock) return { cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false };
    const cursor = readUnlocked(path, { rootPath: root, root: rootStat, fleetPath: fleet, fleet: fleetStat });
    if (cursor === 'missing') return { cursor: null, storedCursor: null, sourceState: 'missing', enrollmentMatches: true };
    if (cursor === 'degraded' || cursor === null) return { cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false };
    const expected = repos === undefined ? cursor.enrollmentDigest : canonicalEnrollmentDigest(repos);
    const enrollmentMatches = expected !== '' && cursor.enrollmentDigest === expected;
    return { cursor: enrollmentMatches ? cursor : null, storedCursor: cursor, sourceState: 'healthy', enrollmentMatches };
  } catch {
    return { cursor: null, storedCursor: null, sourceState: 'degraded', enrollmentMatches: false };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Daemon-facing name for the tri-state durable read. */
export function loadMonitoringCursor(repos?: readonly string[]): MonitoringCursorReadResult {
  return readMonitoringCursor(repos);
}

function completeWrite(fd: number, bytes: Buffer): boolean {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) return false;
    offset += count;
  }
  return true;
}

/** Durable atomic replace. Any uncertainty is reported as false. */
export function writeMonitoringCursor(
  cursor: MonitoringCursorV1,
  options: {
    lockWaitMs?: number;
    enrolledRepos?: readonly string[];
    expectedCursor?: MonitoringCursorV1 | null;
  } = {},
): boolean {
  const sanitized = sanitizeMonitoringCursor(cursor);
  if (!sanitized) return false;
  if (options.enrolledRepos && canonicalEnrollmentDigest(options.enrolledRepos) !== sanitized.enrollmentDigest) return false;
  let directories: PrivateDirectories;
  try { directories = ensurePrivateDirectories(); } catch { return false; }
  const path = monitoringCursorPath();
  const waitMs = typeof options.lockWaitMs === 'number' && Number.isFinite(options.lockWaitMs)
    ? Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs)))
    : 2_000;
  const lock = acquireLocalStoreLock(lockPath(), waitMs);
  if (!lock) return false;
  const tmp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    let prior: Stats | undefined;
    if (existsSync(path)) {
      prior = lstatSync(path);
      if (!privateFile(prior)) return false;
    }
    const existing = readUnlocked(path, directories);
    if (existing === 'degraded') return false;
    if ((existing === 'missing') !== (prior === undefined)) return false;
    if (Object.hasOwn(options, 'expectedCursor')) {
      const expected = options.expectedCursor;
      if (expected === null) {
        if (existing !== 'missing') return false;
      } else {
        const sanitizedExpected = sanitizeMonitoringCursor(expected);
        if (!sanitizedExpected || existing === 'missing' ||
          JSON.stringify(existing) !== JSON.stringify(sanitizedExpected)) return false;
      }
    }
    if (prior) {
      const afterRead = lstatSync(path);
      if (!privateFile(afterRead) || !sameNode(prior, afterRead)) return false;
    }
    const bytes = Buffer.from(`${JSON.stringify(sanitized)}\n`, 'utf8');
    if (bytes.length > MAX_STATE_BYTES) return false;

    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    verifyDirectories(directories);
    if (!completeWrite(fd, bytes)) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const persistedTemp = fstatSync(fd);
    if (!privateFile(persistedTemp) || !sameNode(opened, persistedTemp) || persistedTemp.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;

    verifyDirectories(directories);
    if (prior) {
      const current = lstatSync(path);
      if (!privateFile(current) || !sameNode(prior, current)) return false;
    } else if (existsSync(path)) {
      return false;
    }
    renameSync(tmp, path);
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(persistedTemp, installed) || installed.size !== bytes.length) return false;
    verifyDirectories(directories);
    fsyncDirectory(directories.fleetPath);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}

/** Daemon-facing name for the fail-closed durable write. */
export function saveMonitoringCursor(
  cursor: MonitoringCursorV1,
  options: {
    lockWaitMs?: number;
    enrolledRepos?: readonly string[];
    expectedCursor?: MonitoringCursorV1 | null;
  } = {},
): boolean {
  return writeMonitoringCursor(cursor, options);
}
