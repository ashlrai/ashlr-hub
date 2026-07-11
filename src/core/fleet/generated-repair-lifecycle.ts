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
import { isOuterAttemptIdentity, isSafeExecutionIdentity } from './attempt-identity.js';
import { isTrustedDiagnosticResliceItem, isTrustedGeneratedRepairItem } from './self-heal-trust.js';
import type { WorkItem } from '../types.js';
import {
  readRepairHandoffs,
  repairGenerationIdFromHandoffId,
  repairHandoffJournalPath,
  type RepairHandoffObservation,
} from './repair-handoff-journal.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const MAX_RECORDS = 100_000;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type GeneratedRepairDisposition = 'active' | 'retired' | 'exhausted';

interface GeneratedRepairLifecycleRecord {
  generationId: string;
  disposition: GeneratedRepairDisposition;
  emptyAttemptHashes: string[];
  updatedAt: string;
}

interface GeneratedRepairLifecycleLedger {
  schemaVersion: 1;
  records: GeneratedRepairLifecycleRecord[];
}

let lifecycleLedgerCache: { fingerprint: string; ledger: GeneratedRepairLifecycleLedger } | undefined;

function cloneLedger(ledger: GeneratedRepairLifecycleLedger): GeneratedRepairLifecycleLedger {
  return {
    schemaVersion: 1,
    records: ledger.records.map((record) => ({
      ...record,
      emptyAttemptHashes: record.emptyAttemptHashes.slice(),
    })),
  };
}

export interface GeneratedRepairLifecycleResult {
  available: boolean;
  disposition: GeneratedRepairDisposition;
  authoritativeEmptyRuns: number;
}

export type GeneratedRepairLifecycleEvidence =
  | { kind: 'proposal-created'; attemptId: string; proposalId: string; ts?: string }
  | { kind: 'empty-diff'; attemptId: string; ts?: string }
  | { kind: 'non-terminal'; attemptId?: string; ts?: string };

export interface GeneratedRepairLifecycleTransitionResult extends GeneratedRepairLifecycleResult {
  recorded: boolean;
}

export function generatedRepairLifecyclePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'generated-repair-lifecycle.json');
}

let handoffAuthorityCache: {
  fingerprint: string;
  byEventId: Map<string, RepairHandoffObservation>;
} | undefined;

function handoffAuthorityByEventId(): Map<string, RepairHandoffObservation> {
  const path = repairHandoffJournalPath();
  let fingerprint = `${path}:missing`;
  try {
    const stat = lstatSync(path);
    fingerprint = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { /* missing or unsafe state is represented by the reader */ }
  if (handoffAuthorityCache?.fingerprint === fingerprint) return handoffAuthorityCache.byEventId;
  const byEventId = new Map(readRepairHandoffs().observations.map((entry) => [entry.eventId, entry]));
  handoffAuthorityCache = { fingerprint, byEventId };
  return byEventId;
}

export function generatedRepairGenerationId(item: WorkItem): string | null {
  if (!isTrustedGeneratedRepairItem(item)) return null;
  if (item.repairHandoffId !== undefined || item.repairGenerationId !== undefined) {
    if (
      typeof item.repairHandoffId !== 'string' ||
      typeof item.repairGenerationId !== 'string' ||
      repairGenerationIdFromHandoffId(item.repairHandoffId) !== item.repairGenerationId
    ) return null;
    const handoff = handoffAuthorityByEventId().get(item.repairHandoffId);
    if (!handoff || handoff.generationId !== item.repairGenerationId || handoff.childItemId !== item.id) return null;
    try { if (resolve(handoff.repo) !== resolve(item.repo)) return null; } catch { return null; }
    if (isTrustedDiagnosticResliceItem(item)) {
      if (
        handoff.kind !== 'no-diff-reslice' ||
        handoff.parentSource === undefined ||
        handoff.parentBackend === undefined ||
        handoff.parentTier === undefined ||
        item.repairParentItemId !== handoff.parentItemId ||
        item.repairParentSource !== handoff.parentSource ||
        item.repairParentBackend !== handoff.parentBackend ||
        item.repairParentTier !== handoff.parentTier ||
        handoff.parentObjectiveHash === undefined ||
        item.repairParentObjectiveHash !== handoff.parentObjectiveHash
      ) return null;
    }
    return item.repairGenerationId;
  }
  // Diagnostic reslices derive authority from a durable parent handoff. Older
  // hashless/fallback generations remain readable but can never dispatch.
  if (isTrustedDiagnosticResliceItem(item)) return null;
  let repo: string;
  try {
    repo = resolve(item.repo);
  } catch {
    return null;
  }
  const ts = Date.parse(item.ts);
  if (!Number.isFinite(ts)) return null;
  return createHash('sha256').update(JSON.stringify([
    'ashlr:generated-repair-generation:v1',
    repo,
    item.id,
    item.source,
    new Date(ts).toISOString(),
  ])).digest('hex');
}

export function generatedRepairCooldownKey(item: WorkItem): string {
  if (item.repairHandoffId === undefined && item.repairGenerationId === undefined) return item.id;
  const generationId = generatedRepairGenerationId(item);
  return generationId ? `${item.id}::generation:${generationId}` : item.id;
}

function attemptHash(attemptId: string): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:generated-repair-attempt:v1',
    attemptId,
  ])).digest('hex');
}

function isLifecycleAttemptIdentity(value: unknown): value is string {
  if (isSafeExecutionIdentity(value)) return true;
  return typeof value === 'string' && value.startsWith('run:') && isOuterAttemptIdentity(value.slice(4));
}

function validRecord(value: unknown): value is GeneratedRepairLifecycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const disposition = record['disposition'];
  const hashes = record['emptyAttemptHashes'];
  if (
    !SHA256_RE.test(String(record['generationId'] ?? '')) ||
    (disposition !== 'active' && disposition !== 'retired' && disposition !== 'exhausted') ||
    !Array.isArray(hashes) ||
    hashes.length > 2 ||
    hashes.some((hash) => typeof hash !== 'string' || !SHA256_RE.test(hash)) ||
    new Set(hashes).size !== hashes.length ||
    typeof record['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['updatedAt']))
  ) return false;
  if (disposition === 'active' && hashes.length > 1) return false;
  if (disposition === 'exhausted' && hashes.length !== 2) return false;
  return true;
}

function loadLedger(): { ok: true; ledger: GeneratedRepairLifecycleLedger } | { ok: false } {
  const path = generatedRepairLifecyclePath();
  if (!existsSync(path)) {
    const fingerprint = `${path}:missing`;
    if (lifecycleLedgerCache?.fingerprint === fingerprint) {
      return { ok: true, ledger: cloneLedger(lifecycleLedgerCache.ledger) };
    }
    const ledger: GeneratedRepairLifecycleLedger = { schemaVersion: 1, records: [] };
    lifecycleLedgerCache = { fingerprint, ledger };
    return { ok: true, ledger: cloneLedger(ledger) };
  }
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!safeStoreFile(before) || before.size > MAX_LEDGER_BYTES) return { ok: false };
    const fingerprint = `${path}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    if (lifecycleLedgerCache?.fingerprint === fingerprint) {
      return { ok: true, ledger: cloneLedger(lifecycleLedgerCache.ledger) };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeStoreFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_LEDGER_BYTES) {
      return { ok: false };
    }
    const bytes = Buffer.alloc(opened.size);
    if (opened.size > 0 && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { ok: false };
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) return { ok: false };
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    const value = parsed as Record<string, unknown>;
    if (value['schemaVersion'] !== 1 || !Array.isArray(value['records'])) return { ok: false };
    if (!value['records'].every(validRecord)) return { ok: false };
    const records = value['records'] as GeneratedRepairLifecycleRecord[];
    if (new Set(records.map((record) => record.generationId)).size !== records.length) return { ok: false };
    const ledger: GeneratedRepairLifecycleLedger = {
      schemaVersion: 1,
      records: records.slice(-MAX_RECORDS),
    };
    lifecycleLedgerCache = { fingerprint, ledger };
    return { ok: true, ledger: cloneLedger(ledger) };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function lifecycleLockPath(): string {
  return `${generatedRepairLifecyclePath()}.lock`;
}

function lifecycleFailurePath(): string {
  return `${generatedRepairLifecyclePath()}.failed`;
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function safeStoreFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && ownedByCurrentUser(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function ensureLifecycleDirectory(): string {
  const dir = dirname(generatedRepairLifecyclePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) {
    throw new Error('unsafe generated repair lifecycle directory');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o300) !== 0o300) {
    throw new Error('generated repair lifecycle directory is not owner-writable');
  }
  chmodSync(dir, 0o700);
  return dir;
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicPrivateWrite(path: string, bytes: Buffer): void {
  const dir = ensureLifecycleDirectory();
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!safeStoreFile(opened)) throw new Error('unsafe generated repair lifecycle temporary file');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short generated repair lifecycle write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function markLifecycleWriteFailure(): void {
  try {
    atomicPrivateWrite(lifecycleFailurePath(), Buffer.from('lifecycle write failed\n', 'utf8'));
  } catch {
    // The transition still returns unavailable; no false success is reported.
  }
}

function clearLifecycleWriteFailure(): void {
  try {
    const path = lifecycleFailurePath();
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!safeStoreFile(stat)) return;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch {
    // A lingering marker is fail-closed and can be cleared by a later success.
  }
}

function lifecycleWriteInProgress(): boolean {
  try {
    return existsSync(lifecycleLockPath());
  } catch {
    return true;
  }
}

function lifecycleStorageAvailable(): boolean {
  try {
    const failure = lifecycleFailurePath();
    if (existsSync(failure)) {
      if (!safeStoreFile(lstatSync(failure))) return false;
      return false;
    }
    const path = generatedRepairLifecyclePath();
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!safeStoreFile(stat) || stat.size > MAX_LEDGER_BYTES) return false;
    }
    ensureLifecycleDirectory();
    return true;
  } catch {
    return false;
  }
}

function saveLedger(ledger: GeneratedRepairLifecycleLedger): boolean {
  try {
    const path = generatedRepairLifecyclePath();
    if (existsSync(path) && !safeStoreFile(lstatSync(path))) throw new Error('unsafe generated repair lifecycle ledger');
    const bytes = serializeLedger(ledger.records);
    atomicPrivateWrite(path, bytes);
    clearLifecycleWriteFailure();
    return true;
  } catch {
    markLifecycleWriteFailure();
    return false;
  }
}

function serializeLedger(records: GeneratedRepairLifecycleRecord[]): Buffer {
  const bounded = records.slice(-MAX_RECORDS);
  const encode = (count: number): Buffer => Buffer.from(JSON.stringify({
    schemaVersion: 1,
    records: bounded.slice(-count),
  }, null, 2) + '\n', 'utf8');
  let low = 0;
  let high = bounded.length;
  let best = encode(0);
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = encode(count);
    if (candidate.length <= MAX_LEDGER_BYTES) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function resultFromRecord(
  available: boolean,
  record: GeneratedRepairLifecycleRecord | undefined,
): GeneratedRepairLifecycleResult {
  return {
    available,
    disposition: record?.disposition ?? 'active',
    authoritativeEmptyRuns: record?.emptyAttemptHashes.length ?? 0,
  };
}

function upsertNewest(
  ledger: GeneratedRepairLifecycleLedger,
  record: GeneratedRepairLifecycleRecord,
): void {
  ledger.records = ledger.records.filter((candidate) => candidate.generationId !== record.generationId);
  ledger.records.push(record);
}

/** Read one immutable generation; callers block dispatch when availability is false. */
export function readGeneratedRepairLifecycle(item: WorkItem): GeneratedRepairLifecycleResult {
  const id = generatedRepairGenerationId(item);
  if (!id) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  if (!lifecycleStorageAvailable() || lifecycleWriteInProgress()) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  }
  const loaded = loadLedger();
  if (!loaded.ok) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  return resultFromRecord(true, loaded.ledger.records.find((record) => record.generationId === id));
}

/**
 * Record a typed local-daemon transition. Terminal states are absorbing and
 * duplicate attempt ids are idempotent. Callers must independently verify that
 * proposal-created evidence exists durably in the inbox.
 */
export function recordGeneratedRepairLifecycle(
  item: WorkItem,
  evidence: GeneratedRepairLifecycleEvidence,
): GeneratedRepairLifecycleTransitionResult {
  const id = generatedRepairGenerationId(item);
  if (!id || evidence.kind === 'non-terminal') {
    return { available: id !== null, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (!isLifecycleAttemptIdentity(evidence.attemptId)) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (evidence.kind === 'proposal-created' && !isSafeExecutionIdentity(evidence.proposalId)) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const lock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lock) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  try {
    return recordGeneratedRepairLifecycleUnlocked(id, evidence);
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function recordGeneratedRepairLifecycleUnlocked(
  id: string,
  evidence: Exclude<GeneratedRepairLifecycleEvidence, { kind: 'non-terminal' }>,
): GeneratedRepairLifecycleTransitionResult {
  const loaded = loadLedger();
  if (!loaded.ok) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const existingIndex = loaded.ledger.records.findIndex((record) => record.generationId === id);
  const existing = existingIndex >= 0 ? loaded.ledger.records[existingIndex] : undefined;
  if (existing?.disposition === 'retired' || existing?.disposition === 'exhausted') {
    return { ...resultFromRecord(true, existing), recorded: false };
  }

  const now = evidence.ts && Number.isFinite(Date.parse(evidence.ts))
    ? new Date(evidence.ts).toISOString()
    : new Date().toISOString();
  const emptyAttemptHashes = existing?.emptyAttemptHashes.slice() ?? [];
  let disposition: Exclude<GeneratedRepairDisposition, 'active'>;
  if (evidence.kind === 'proposal-created') {
    disposition = 'retired';
  } else {
    const hash = attemptHash(evidence.attemptId);
    if (emptyAttemptHashes.includes(hash)) {
      return { ...resultFromRecord(true, existing), recorded: false };
    }
    emptyAttemptHashes.push(hash);
    if (emptyAttemptHashes.length < 2) {
      const recorded = saveActiveEmptyProgress(loaded.ledger, id, emptyAttemptHashes, now);
      return recorded
        ? {
          available: true,
          disposition: 'active',
          authoritativeEmptyRuns: emptyAttemptHashes.length,
          recorded: true,
        }
        : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
    }
    disposition = 'exhausted';
  }

  const record: GeneratedRepairLifecycleRecord = {
    generationId: id,
    disposition,
    emptyAttemptHashes: emptyAttemptHashes.slice(0, 2),
    updatedAt: now,
  };
  upsertNewest(loaded.ledger, record);
  const recorded = saveLedger(loaded.ledger);
  return recorded
    ? { ...resultFromRecord(true, record), recorded: true }
    : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
}

function saveActiveEmptyProgress(
  ledger: GeneratedRepairLifecycleLedger,
  id: string,
  emptyAttemptHashes: string[],
  updatedAt: string,
): boolean {
  const record: GeneratedRepairLifecycleRecord = {
    generationId: id,
    disposition: 'active',
    emptyAttemptHashes: emptyAttemptHashes.slice(0, 2),
    updatedAt,
  };
  upsertNewest(ledger, record);
  return saveLedger(ledger);
}
