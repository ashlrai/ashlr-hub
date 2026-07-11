/**
 * Bounded advisory observer for authenticated scanner state transitions.
 *
 * This module records metadata-only witnesses and has no lifecycle, proposal,
 * learning, verification, or merge authority.
 */

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
import { dirname, join, resolve } from 'node:path';

import type { Backlog, ScannerObservation, SourceBaseDigestV1 } from '../types.js';
import { loadBacklog } from '../portfolio/backlog.js';
import { deriveMergeContractResolutionWitness } from './merge-contract-resolution-witness.js';
import {
  readResolutionWitnesses,
  recordResolutionWitness,
  type ResolutionWitnessReadResult,
} from './resolution-witness-ledger.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { verifySourceBaseDigest } from './source-base-digest.js';
import { verifyScannerObservationDigest } from './scanner-observation-digest.js';

const SCANNER_ID = 'merge-verify-contract';
const MAX_STATE_BYTES = 512 * 1024;
const DEFAULT_MAX_REPOS = 24;
const HARD_MAX_REPOS = 100;
const DEFAULT_DEADLINE_MS = 250;
const HARD_MAX_DEADLINE_MS = 2_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ResolutionObserverOutcome =
  | 'seeded'
  | 'completed'
  | 'duplicate'
  | 'stale'
  | 'source-unavailable'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'capacity-exceeded'
  | 'write-failed';

export interface ResolutionObserverRunSummary {
  observerRunId: string;
  startedAt: string;
  completedAt: string;
  outcome: ResolutionObserverOutcome;
  backlogGeneratedAt: string | null;
  reposObserved: number;
  pendingObjectives: number;
  transitionsMatched: number;
  recorded: number;
  replayed: number;
  conflicted: number;
  invalid: number;
  failed: number;
}

export interface ResolutionObserverCheckpointV1 {
  schemaVersion: 1;
  backlogGeneratedAt: string;
  updatedAt: string;
  pending: ScannerObservation[];
  lastRun: ResolutionObserverRunSummary;
}

export interface ResolutionObserverReadResult {
  sourceState: 'missing' | 'healthy' | 'degraded';
  checkpoint: ResolutionObserverCheckpointV1 | null;
}

export interface ResolutionObserverRunReadResult {
  sourceState: 'missing' | 'healthy' | 'degraded';
  run: ResolutionObserverRunSummary | null;
}

export interface ResolutionObserverStatus {
  state: 'missing' | 'healthy' | 'degraded';
  checkpointState: ResolutionObserverReadResult['sourceState'];
  runState: ResolutionObserverRunReadResult['sourceState'];
  witnessState: ResolutionWitnessReadResult['sourceState'];
  lastRunAt: string | null;
  lastBacklogAt: string | null;
  lastOutcome: ResolutionObserverOutcome | null;
  pendingObjectives: number;
  witnesses: number;
  latestWitnessAt: string | null;
  invalidRows: number;
  conflictingWitnesses: number;
}

export interface RunResolutionObserverOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  maxRepos?: number;
  expectedBacklogGeneratedAt?: string;
  expectedBacklogSnapshotId?: string;
  now?: () => Date;
  deps?: {
    loadBacklog?: () => Backlog | null;
    readCheckpoint?: () => ResolutionObserverReadResult;
    writeCheckpoint?: (checkpoint: ResolutionObserverCheckpointV1) => boolean;
    writeRunSummary?: (run: ResolutionObserverRunSummary) => boolean;
    recordWitness?: (input: Parameters<typeof recordResolutionWitness>[0]) => ReturnType<typeof recordResolutionWitness>;
  };
}

export interface ScheduledResolutionObserver {
  disposition: 'scheduled' | 'overlap-suppressed';
  completion: Promise<ResolutionObserverRunSummary>;
}

export function resolutionObserverStatePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'resolution-observer.json');
}

export function resolutionObserverRunStatePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'resolution-observer-run.json');
}

function observerLockPath(): string {
  return `${resolutionObserverStatePath()}.lock`;
}

function observerRunLockPath(): string {
  return `${resolutionObserverRunStatePath()}.lock`;
}

function observerExecutionLockPath(): string {
  return `${resolutionObserverStatePath()}.run.lock`;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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

function ensurePrivateDirectories(): { path: string; stat: Stats } {
  const ashlr = join(homedir(), '.ashlr');
  const fleet = join(ashlr, 'fleet');
  if (!existsSync(ashlr)) mkdirSync(ashlr, { mode: 0o700 });
  const ashlrStat = lstatSync(ashlr);
  if (!privateDirectory(ashlrStat)) throw new Error('unsafe observer storage ancestor');
  if (!existsSync(fleet)) mkdirSync(fleet, { mode: 0o700 });
  const fleetStat = lstatSync(fleet);
  if (!privateDirectory(fleetStat)) throw new Error('unsafe observer storage directory');
  chmodSync(ashlr, 0o700);
  chmodSync(fleet, 0o700);
  return { path: fleet, stat: lstatSync(fleet) };
}

function readOpened(fd: number, size: number): Buffer | null {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) return null;
    offset += count;
  }
  return bytes;
}

function sanitizeSourceBase(value: unknown, repo: string): SourceBaseDigestV1 | null {
  return verifySourceBaseDigest(repo, SCANNER_ID, value);
}

function sanitizePendingObservation(value: unknown): ScannerObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const repo = typeof row['repo'] === 'string' ? resolve(row['repo']) : '';
  if (
    row['schemaVersion'] !== 1 ||
    !canonicalTimestamp(row['observedAt']) ||
    !repo || repo !== row['repo'] ||
    row['scannerId'] !== SCANNER_ID ||
    row['domain'] !== 'verification' ||
    row['source'] !== 'test' ||
    row['status'] !== 'present' ||
    row['reason'] !== 'item-observed' ||
    typeof row['itemId'] !== 'string' || row['itemId'].length < 1 || row['itemId'].length > 180 ||
    typeof row['objectiveHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['objectiveHash'])
  ) return null;
  const sourceBase = sanitizeSourceBase(row['sourceBase'], repo);
  const observationDigest = typeof row['observationDigest'] === 'string' ? row['observationDigest'] : '';
  if (!sourceBase || sourceBase.dirty !== 'clean' || !/^[a-f0-9]{64}$/.test(observationDigest)) return null;
  const observation: ScannerObservation = {
    schemaVersion: 1,
    observedAt: row['observedAt'],
    repo,
    scannerId: SCANNER_ID,
    domain: 'verification',
    source: 'test',
    status: 'present',
    reason: 'item-observed',
    itemId: row['itemId'],
    objectiveHash: row['objectiveHash'],
    sourceBase,
    observationDigest,
  };
  if (!verifyScannerObservationDigest(observation)) return null;
  return observation;
}

function sanitizeRunSummary(value: unknown): ResolutionObserverRunSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const outcomes = new Set<ResolutionObserverOutcome>([
    'seeded', 'completed', 'duplicate', 'stale', 'source-unavailable',
    'cancelled', 'deadline-exceeded', 'capacity-exceeded', 'write-failed',
  ]);
  if (
    typeof row['observerRunId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row['observerRunId']) ||
    !canonicalTimestamp(row['startedAt']) || !canonicalTimestamp(row['completedAt']) ||
    !outcomes.has(row['outcome'] as ResolutionObserverOutcome) ||
    !(row['backlogGeneratedAt'] === null || canonicalTimestamp(row['backlogGeneratedAt'])) ||
    !safeInteger(row['reposObserved']) || !safeInteger(row['pendingObjectives']) ||
    !safeInteger(row['transitionsMatched']) || !safeInteger(row['recorded']) ||
    !safeInteger(row['replayed']) || !safeInteger(row['conflicted']) ||
    !safeInteger(row['invalid']) || !safeInteger(row['failed'])
  ) return null;
  return {
    observerRunId: row['observerRunId'],
    startedAt: row['startedAt'],
    completedAt: row['completedAt'],
    outcome: row['outcome'] as ResolutionObserverOutcome,
    backlogGeneratedAt: row['backlogGeneratedAt'] as string | null,
    reposObserved: row['reposObserved'] as number,
    pendingObjectives: row['pendingObjectives'] as number,
    transitionsMatched: row['transitionsMatched'] as number,
    recorded: row['recorded'] as number,
    replayed: row['replayed'] as number,
    conflicted: row['conflicted'] as number,
    invalid: row['invalid'] as number,
    failed: row['failed'] as number,
  };
}

function readPrivateRunSummary(): ResolutionObserverRunReadResult {
  const path = resolutionObserverRunStatePath();
  const ashlr = join(homedir(), '.ashlr');
  const fleet = dirname(path);
  if (!existsSync(ashlr)) return { sourceState: 'missing', run: null };
  let fd: number | undefined;
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    if (!privateDirectory(lstatSync(ashlr))) return { sourceState: 'degraded', run: null };
    if (!existsSync(fleet)) return { sourceState: 'missing', run: null };
    if (!privateDirectory(lstatSync(fleet))) return { sourceState: 'degraded', run: null };
    if (!existsSync(path)) return { sourceState: 'missing', run: null };
    lock = acquireLocalStoreLock(observerRunLockPath(), 20);
    if (!lock) return { sourceState: 'degraded', run: null };
    const before = lstatSync(path);
    if (!privateFile(before) || before.size < 2 || before.size > MAX_STATE_BYTES) {
      return { sourceState: 'degraded', run: null };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(before, opened) || opened.size !== before.size) {
      return { sourceState: 'degraded', run: null };
    }
    const bytes = readOpened(fd, opened.size);
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!bytes || !privateFile(after) || !privateFile(rebound) || !sameNode(opened, after) ||
      !sameNode(after, rebound) || after.size !== opened.size || rebound.size !== after.size) {
      return { sourceState: 'degraded', run: null };
    }
    const run = sanitizeRunSummary(JSON.parse(bytes.toString('utf8')) as unknown);
    return run ? { sourceState: 'healthy', run } : { sourceState: 'degraded', run: null };
  } catch {
    return { sourceState: 'degraded', run: null };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

export function readResolutionObserverRunSummary(): ResolutionObserverRunReadResult {
  return readPrivateRunSummary();
}

function sanitizeCheckpoint(value: unknown): ResolutionObserverCheckpointV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row['schemaVersion'] !== 1 || !canonicalTimestamp(row['backlogGeneratedAt']) ||
    !canonicalTimestamp(row['updatedAt']) || !Array.isArray(row['pending']) ||
    row['pending'].length > HARD_MAX_REPOS
  ) return null;
  const pending = row['pending'].map(sanitizePendingObservation);
  if (pending.some((entry) => entry === null)) return null;
  const exact = pending as ScannerObservation[];
  if (new Set(exact.map((entry) => entry.repo)).size !== exact.length) return null;
  const lastRun = sanitizeRunSummary(row['lastRun']);
  if (!lastRun) return null;
  return {
    schemaVersion: 1,
    backlogGeneratedAt: row['backlogGeneratedAt'],
    updatedAt: row['updatedAt'],
    pending: exact.sort((left, right) => left.repo.localeCompare(right.repo)),
    lastRun,
  };
}

export function readResolutionObserverCheckpoint(): ResolutionObserverReadResult {
  const path = resolutionObserverStatePath();
  const ashlr = join(homedir(), '.ashlr');
  const fleet = dirname(path);
  if (!existsSync(ashlr)) return { sourceState: 'missing', checkpoint: null };
  let fd: number | undefined;
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    if (!privateDirectory(lstatSync(ashlr))) return { sourceState: 'degraded', checkpoint: null };
    if (!existsSync(fleet)) return { sourceState: 'missing', checkpoint: null };
    if (!privateDirectory(lstatSync(fleet))) return { sourceState: 'degraded', checkpoint: null };
    if (!existsSync(path)) return { sourceState: 'missing', checkpoint: null };
    lock = acquireLocalStoreLock(observerLockPath(), 20);
    if (!lock) return { sourceState: 'degraded', checkpoint: null };
    const before = lstatSync(path);
    if (!privateFile(before) || before.size < 2 || before.size > MAX_STATE_BYTES) {
      return { sourceState: 'degraded', checkpoint: null };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(before, opened) || opened.size !== before.size) {
      return { sourceState: 'degraded', checkpoint: null };
    }
    const bytes = readOpened(fd, opened.size);
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!bytes || !privateFile(after) || !privateFile(rebound) || !sameNode(opened, after) ||
      !sameNode(after, rebound) || after.size !== opened.size || rebound.size !== after.size) {
      return { sourceState: 'degraded', checkpoint: null };
    }
    const checkpoint = sanitizeCheckpoint(JSON.parse(bytes.toString('utf8')) as unknown);
    return checkpoint
      ? { sourceState: 'healthy', checkpoint }
      : { sourceState: 'degraded', checkpoint: null };
  } catch {
    return { sourceState: 'degraded', checkpoint: null };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!privateDirectory(fstatSync(fd))) throw new Error('unsafe observer directory');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readCheckpointUnlocked(path: string): ResolutionObserverCheckpointV1 | null | 'degraded' {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!privateFile(before) || before.size < 2 || before.size > MAX_STATE_BYTES) return 'degraded';
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(before, opened) || opened.size !== before.size) return 'degraded';
    const bytes = readOpened(fd, opened.size);
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!bytes || !privateFile(rebound) || !sameNode(opened, after) || !sameNode(after, rebound) ||
      after.size !== opened.size || rebound.size !== after.size) return 'degraded';
    return sanitizeCheckpoint(JSON.parse(bytes.toString('utf8')) as unknown) ?? 'degraded';
  } catch {
    return 'degraded';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function samePending(left: ScannerObservation[], right: ScannerObservation[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function writeResolutionObserverCheckpoint(
  checkpoint: ResolutionObserverCheckpointV1,
  options: { lockWaitMs?: number } = {},
): boolean {
  let sanitized: ResolutionObserverCheckpointV1 | null;
  try {
    sanitized = sanitizeCheckpoint(checkpoint);
  } catch {
    return false;
  }
  if (!sanitized) return false;
  const path = resolutionObserverStatePath();
  let directory: { path: string; stat: Stats };
  try {
    directory = ensurePrivateDirectories();
  } catch {
    return false;
  }
  const lockWaitMs = typeof options.lockWaitMs === 'number' && Number.isFinite(options.lockWaitMs)
    ? Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs)))
    : 2_000;
  const lock = acquireLocalStoreLock(observerLockPath(), lockWaitMs);
  if (!lock) return false;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    const dir = directory.path;
    const lockedDirectory = lstatSync(dir);
    if (!privateDirectory(lockedDirectory) || !sameNode(directory.stat, lockedDirectory)) return false;
    const existing = readCheckpointUnlocked(path);
    if (existing === 'degraded') return false;
    if (existing) {
      const existingCursor = Date.parse(existing.backlogGeneratedAt);
      const incomingCursor = Date.parse(sanitized.backlogGeneratedAt);
      if (existingCursor > incomingCursor) return false;
      if (existingCursor === incomingCursor) {
        if (!samePending(existing.pending, sanitized.pending)) return false;
        if (Date.parse(existing.updatedAt) >= Date.parse(sanitized.updatedAt)) return true;
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(sanitized)}\n`, 'utf8');
    if (bytes.length > MAX_STATE_BYTES) return false;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    const beforeWriteDirectory = lstatSync(dir);
    if (!privateDirectory(beforeWriteDirectory) || !sameNode(directory.stat, beforeWriteDirectory)) return false;
    if (writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(opened, installed) || installed.size !== bytes.length) return false;
    const afterWriteDirectory = lstatSync(dir);
    if (!privateDirectory(afterWriteDirectory) || !sameNode(directory.stat, afterWriteDirectory)) return false;
    fsyncDirectory(dir);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}

export function writeResolutionObserverRunSummary(
  run: ResolutionObserverRunSummary,
  options: { lockWaitMs?: number } = {},
): boolean {
  const sanitized = sanitizeRunSummary(run);
  if (!sanitized) return false;
  const path = resolutionObserverRunStatePath();
  let directory: { path: string; stat: Stats };
  try {
    directory = ensurePrivateDirectories();
  } catch {
    return false;
  }
  const lockWaitMs = typeof options.lockWaitMs === 'number' && Number.isFinite(options.lockWaitMs)
    ? Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs)))
    : 2_000;
  const lock = acquireLocalStoreLock(observerRunLockPath(), lockWaitMs);
  if (!lock) return false;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    const dir = directory.path;
    const lockedDirectory = lstatSync(dir);
    if (!privateDirectory(lockedDirectory) || !sameNode(directory.stat, lockedDirectory)) return false;
    if (existsSync(path)) {
      const before = lstatSync(path);
      if (!privateFile(before) || before.size < 2 || before.size > MAX_STATE_BYTES) return false;
      const current = readPrivateRunSummaryWithoutLock(path);
      if (current === 'degraded') return false;
      if (current && Date.parse(current.completedAt) > Date.parse(sanitized.completedAt)) return false;
    }
    const bytes = Buffer.from(`${JSON.stringify(sanitized)}\n`, 'utf8');
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || writeSync(fd, bytes) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(opened, installed) || installed.size !== bytes.length) return false;
    fsyncDirectory(dir);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}

function readPrivateRunSummaryWithoutLock(path: string): ResolutionObserverRunSummary | null | 'degraded' {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(before) || !privateFile(opened) || !sameNode(before, opened) || opened.size !== before.size) return 'degraded';
    const bytes = readOpened(fd, opened.size);
    const after = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!bytes || !privateFile(rebound) || !sameNode(opened, after) || !sameNode(after, rebound) ||
      after.size !== opened.size || rebound.size !== after.size) return 'degraded';
    return sanitizeRunSummary(JSON.parse(bytes.toString('utf8')) as unknown) ?? 'degraded';
  } catch {
    return 'degraded';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function boundedPositive(value: unknown, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(hardMax, Math.floor(value))
    : fallback;
}

function currentMergeObservations(backlog: Backlog): ScannerObservation[] {
  return (backlog.observations ?? [])
    .filter((observation) => observation.scannerId === SCANNER_ID)
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

function pendingFromCurrent(observations: ScannerObservation[]): ScannerObservation[] {
  return observations
    .map((observation) => observation.status === 'present' ? sanitizePendingObservation(observation) : null)
    .filter((observation): observation is ScannerObservation => observation !== null)
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

function summary(fields: Partial<ResolutionObserverRunSummary> & Pick<ResolutionObserverRunSummary, 'outcome'>): ResolutionObserverRunSummary {
  const now = fields.completedAt ?? new Date().toISOString();
  return {
    observerRunId: fields.observerRunId ?? `resolution-observer:${now}`,
    startedAt: fields.startedAt ?? now,
    completedAt: now,
    outcome: fields.outcome,
    backlogGeneratedAt: fields.backlogGeneratedAt ?? null,
    reposObserved: fields.reposObserved ?? 0,
    pendingObjectives: fields.pendingObjectives ?? 0,
    transitionsMatched: fields.transitionsMatched ?? 0,
    recorded: fields.recorded ?? 0,
    replayed: fields.replayed ?? 0,
    conflicted: fields.conflicted ?? 0,
    invalid: fields.invalid ?? 0,
    failed: fields.failed ?? 0,
  };
}

function transitionObserverRunId(prior: ScannerObservation, current: ScannerObservation): string {
  const digest = createHash('sha256').update(JSON.stringify([
    'ashlr:resolution-observer-transition:v1',
    resolve(prior.repo),
    prior.scannerId,
    prior.objectiveHash ?? null,
    prior.sourceBase?.baseDigest ?? null,
    current.sourceBase?.baseDigest ?? null,
  ])).digest('hex');
  return `resolution-observer:${digest.slice(0, 32)}`;
}

function runResolutionObserverCore(options: RunResolutionObserverOptions = {}): ResolutionObserverRunSummary {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const deadlineMs = boundedPositive(options.deadlineMs, DEFAULT_DEADLINE_MS, HARD_MAX_DEADLINE_MS);
  const deadlineAt = Date.now() + deadlineMs;
  const maxRepos = boundedPositive(options.maxRepos, DEFAULT_MAX_REPOS, HARD_MAX_REPOS);
  const readCheckpoint = options.deps?.readCheckpoint ?? readResolutionObserverCheckpoint;
  const writeCheckpoint = options.deps?.writeCheckpoint ?? ((value) =>
    writeResolutionObserverCheckpoint(value, { lockWaitMs: 20 }));
  const recordWitness = options.deps?.recordWitness ?? ((value) =>
    recordResolutionWitness(value, { lockWaitMs: 20 }));
  const backlog = (options.deps?.loadBacklog ?? loadBacklog)();
  const backlogGeneratedAt = canonicalTimestamp(backlog?.generatedAt) ? backlog.generatedAt : null;
  const observerRunId = backlogGeneratedAt
    ? `resolution-observer:${backlogGeneratedAt}`
    : `resolution-observer:${startedAt}`;
  const base = { observerRunId, startedAt, backlogGeneratedAt };

  if (options.signal?.aborted) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'cancelled' });
  }
  if (Date.now() >= deadlineAt) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'deadline-exceeded' });
  }

  if (
    !backlog || !backlogGeneratedAt || !Array.isArray(backlog.observations) ||
    backlog.observationSourceState === 'degraded' || backlog.observationsTruncated === true
  ) return summary({ ...base, completedAt: now().toISOString(), outcome: 'source-unavailable' });
  if (
    (options.expectedBacklogGeneratedAt !== undefined && backlog.generatedAt !== options.expectedBacklogGeneratedAt) ||
    (options.expectedBacklogSnapshotId !== undefined && backlog.snapshotId !== options.expectedBacklogSnapshotId)
  ) return summary({ ...base, completedAt: now().toISOString(), outcome: 'source-unavailable' });

  const current = currentMergeObservations(backlog);
  let expectedRepos: string[];
  try {
    expectedRepos = [...new Set(backlog.repos.map((repo) => resolve(repo)))].sort();
  } catch {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'source-unavailable' });
  }
  const observedRepos = current.map((observation) => resolve(observation.repo)).sort();
  if (
    expectedRepos.length !== backlog.repos.length ||
    observedRepos.length !== expectedRepos.length ||
    new Set(observedRepos).size !== observedRepos.length ||
    observedRepos.some((repo, index) => repo !== expectedRepos[index])
  ) return summary({ ...base, completedAt: now().toISOString(), outcome: 'source-unavailable' });
  if (current.length > maxRepos) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'capacity-exceeded', reposObserved: current.length });
  }
  const loaded = readCheckpoint();
  if (options.signal?.aborted) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'cancelled', reposObserved: current.length });
  }
  if (Date.now() >= deadlineAt) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'deadline-exceeded', reposObserved: current.length });
  }
  if (loaded.sourceState === 'degraded') {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'write-failed', failed: 1 });
  }

  if (!loaded.checkpoint) {
    const pending = pendingFromCurrent(current);
    const run = summary({
      ...base,
      completedAt: now().toISOString(),
      outcome: 'seeded',
      reposObserved: current.length,
      pendingObjectives: pending.length,
    });
    const checkpoint: ResolutionObserverCheckpointV1 = {
      schemaVersion: 1,
      backlogGeneratedAt,
      updatedAt: run.completedAt,
      pending,
      lastRun: run,
    };
    if (options.signal?.aborted) return { ...run, outcome: 'cancelled' };
    if (Date.now() >= deadlineAt) return { ...run, outcome: 'deadline-exceeded' };
    const persisted = writeCheckpoint(checkpoint);
    if (Date.now() >= deadlineAt) return { ...run, outcome: 'deadline-exceeded' };
    return persisted ? run : { ...run, outcome: 'write-failed', failed: 1 };
  }

  const checkpointMs = Date.parse(loaded.checkpoint.backlogGeneratedAt);
  const currentMs = Date.parse(backlogGeneratedAt);
  if (currentMs === checkpointMs) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'duplicate', pendingObjectives: loaded.checkpoint.pending.length });
  }
  if (currentMs < checkpointMs) {
    return summary({ ...base, completedAt: now().toISOString(), outcome: 'stale', pendingObjectives: loaded.checkpoint.pending.length });
  }

  const priorByRepo = new Map(loaded.checkpoint.pending.map((observation) => [observation.repo, observation]));
  const nextByRepo = new Map(priorByRepo);
  let transitionsMatched = 0;
  let recorded = 0;
  let replayed = 0;
  let conflicted = 0;
  let invalid = 0;
  let failed = 0;

  for (const observation of current) {
    if (options.signal?.aborted) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'cancelled', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    if (Date.now() > deadlineAt) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'deadline-exceeded', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    const repo = resolve(observation.repo);
    const prior = priorByRepo.get(repo);
    if (observation.status === 'unavailable') continue;
    if (!verifyScannerObservationDigest(observation)) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'source-unavailable', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    if (prior && Date.parse(observation.observedAt) <= Date.parse(prior.observedAt)) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'source-unavailable', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    if (observation.status === 'present') {
      const sanitized = sanitizePendingObservation(observation);
      if (sanitized) nextByRepo.set(repo, sanitized);
      continue;
    }
    if (!prior || observation.status !== 'absent') continue;
    const currentBase = verifySourceBaseDigest(repo, SCANNER_ID, observation.sourceBase);
    if (!currentBase || currentBase.dirty !== 'clean') continue;
    const witness = deriveMergeContractResolutionWitness({
      prior,
      current: observation,
      observerRunId: transitionObserverRunId(prior, observation),
      decidedAt: observation.observedAt,
    });
    if (!witness) {
      nextByRepo.delete(repo);
      continue;
    }
    nextByRepo.delete(repo);
    transitionsMatched += 1;
    if (options.signal?.aborted) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'cancelled', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    if (Date.now() >= deadlineAt) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'deadline-exceeded', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
    const write = recordWitness(witness);
    recorded += write.recorded;
    replayed += write.replayed;
    conflicted += write.conflicted;
    invalid += write.invalid;
    failed += write.failed;
    if (write.conflicted > 0 || write.invalid > 0 || write.failed > 0) {
      return summary({
        ...base, completedAt: now().toISOString(), outcome: 'write-failed', reposObserved: current.length,
        pendingObjectives: loaded.checkpoint.pending.length, transitionsMatched, recorded, replayed, conflicted, invalid, failed,
      });
    }
  }

  const pending = [...nextByRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo));
  const run = summary({
    ...base,
    completedAt: now().toISOString(),
    outcome: 'completed',
    reposObserved: current.length,
    pendingObjectives: pending.length,
    transitionsMatched,
    recorded,
    replayed,
    conflicted,
    invalid,
    failed,
  });
  const next: ResolutionObserverCheckpointV1 = {
    schemaVersion: 1,
    backlogGeneratedAt,
    updatedAt: run.completedAt,
    pending,
    lastRun: run,
  };
  if (options.signal?.aborted) return { ...run, outcome: 'cancelled' };
  if (Date.now() >= deadlineAt) return { ...run, outcome: 'deadline-exceeded' };
  const persisted = writeCheckpoint(next);
  if (Date.now() >= deadlineAt) return { ...run, outcome: 'deadline-exceeded' };
  return persisted ? run : { ...run, outcome: 'write-failed', failed: run.failed + 1 };
}

export function runResolutionObserver(options: RunResolutionObserverOptions = {}): ResolutionObserverRunSummary {
  let executionLock: ReturnType<typeof acquireLocalStoreLock> = null;
  let run: ResolutionObserverRunSummary;
  try {
    ensurePrivateDirectories();
    executionLock = acquireLocalStoreLock(observerExecutionLockPath(), 20);
    if (!executionLock) {
      const timestamp = (options.now ?? (() => new Date()))().toISOString();
      run = summary({
        observerRunId: `resolution-observer:${timestamp}`,
        startedAt: timestamp,
        completedAt: timestamp,
        outcome: 'write-failed',
        failed: 1,
      });
    } else {
      run = runResolutionObserverCore(options);
    }
  } catch {
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    run = summary({
      observerRunId: `resolution-observer:${timestamp}`,
      startedAt: timestamp,
      completedAt: timestamp,
      outcome: 'write-failed',
      failed: 1,
    });
  } finally {
    releaseLocalStoreLock(executionLock);
  }
  const writeRunSummary = options.deps?.writeRunSummary ?? ((value: ResolutionObserverRunSummary) =>
    writeResolutionObserverRunSummary(value, { lockWaitMs: 20 }));
  if (writeRunSummary(run)) return run;
  return run.outcome === 'write-failed' ? run : { ...run, outcome: 'write-failed', failed: run.failed + 1 };
}

let inFlight: Promise<ResolutionObserverRunSummary> | null = null;

export function scheduleResolutionObserver(options: RunResolutionObserverOptions = {}): ScheduledResolutionObserver {
  if (inFlight) return { disposition: 'overlap-suppressed', completion: inFlight };
  const completion = Promise.resolve()
    .then(() => runResolutionObserver(options))
    .finally(() => {
      if (inFlight === completion) inFlight = null;
    });
  inFlight = completion;
  return { disposition: 'scheduled', completion };
}

export function readResolutionObserverStatus(): ResolutionObserverStatus {
  const checkpoint = readResolutionObserverCheckpoint();
  const latestRun = readResolutionObserverRunSummary();
  const witness = readResolutionWitnesses({ lockWaitMs: 20 });
  const failedLatestRun = latestRun.run !== null && [
    'stale',
    'source-unavailable',
    'cancelled',
    'deadline-exceeded',
    'capacity-exceeded',
    'write-failed',
  ].includes(latestRun.run.outcome);
  const degraded = checkpoint.sourceState === 'degraded' || latestRun.sourceState === 'degraded' ||
    witness.sourceState === 'degraded' || failedLatestRun;
  const missing = checkpoint.sourceState === 'missing' || latestRun.sourceState === 'missing';
  return {
    state: degraded ? 'degraded' : missing ? 'missing' : 'healthy',
    checkpointState: checkpoint.sourceState,
    runState: latestRun.sourceState,
    witnessState: witness.sourceState,
    lastRunAt: latestRun.run?.completedAt ?? null,
    lastBacklogAt: checkpoint.checkpoint?.backlogGeneratedAt ?? null,
    lastOutcome: latestRun.run?.outcome ?? null,
    pendingObjectives: checkpoint.checkpoint?.pending.length ?? 0,
    witnesses: witness.witnesses.length,
    latestWitnessAt: witness.witnesses[0]?.decidedAt ?? null,
    invalidRows: witness.invalidRows,
    conflictingWitnesses: witness.conflictingDigests,
  };
}
