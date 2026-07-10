import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isOuterAttemptIdentity, isSafeExecutionIdentity } from './attempt-identity.js';
import { isTrustedGeneratedRepairItem } from './self-heal-trust.js';
import type { WorkItem } from '../types.js';

const MAX_RECORDS = 2_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LOCK_CONTENTION_WAIT_MS = 250;
const LOCK_CONTENTION_POLL_MS = 5;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

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

export function generatedRepairGenerationId(item: WorkItem): string | null {
  if (!isTrustedGeneratedRepairItem(item)) return null;
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
  if (!existsSync(path)) return { ok: true, ledger: { schemaVersion: 1, records: [] } };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    const value = parsed as Record<string, unknown>;
    if (value['schemaVersion'] !== 1 || !Array.isArray(value['records'])) return { ok: false };
    if (!value['records'].every(validRecord)) return { ok: false };
    const records = value['records'] as GeneratedRepairLifecycleRecord[];
    if (new Set(records.map((record) => record.generationId)).size !== records.length) return { ok: false };
    return {
      ok: true,
      ledger: {
        schemaVersion: 1,
        records: records.slice(-MAX_RECORDS),
      },
    };
  } catch {
    return { ok: false };
  }
}

function lifecycleLockPath(): string {
  return `${generatedRepairLifecyclePath()}.lock`;
}

function lifecycleFailurePath(): string {
  return `${generatedRepairLifecyclePath()}.failed`;
}

function markLifecycleWriteFailure(): void {
  try {
    writeFileSync(lifecycleFailurePath(), 'lifecycle write failed\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // The transition still returns unavailable; no false success is reported.
  }
}

function clearLifecycleWriteFailure(): void {
  try {
    const path = lifecycleFailurePath();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // A lingering marker is fail-closed and can be cleared by a later success.
  }
}

function acquireLifecycleLock(): string | null {
  const token = randomUUID();
  let fd: number | undefined;
  try {
    const dir = join(homedir(), '.ashlr', 'fleet');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = lifecycleLockPath();
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${token}\n`, 'utf8');
    closeSync(fd);
    fd = undefined;
    return token;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    return null;
  }
}

function releaseLifecycleLock(token: string): void {
  try {
    const path = lifecycleLockPath();
    if (existsSync(path) && readFileSync(path, 'utf8').trim() === token) unlinkSync(path);
  } catch {
    // Best-effort; an uncertain lock remains fail-closed.
  }
}

function markContentionAfterWriter(): void {
  const deadline = Date.now() + LOCK_CONTENTION_WAIT_MS;
  while (existsSync(lifecycleLockPath()) && Date.now() < deadline) {
    Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, LOCK_CONTENTION_POLL_MS);
  }
  markLifecycleWriteFailure();
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
    if (existsSync(lifecycleFailurePath())) return false;
    const path = generatedRepairLifecyclePath();
    const dir = dirname(path);
    if (existsSync(path)) {
      accessSync(path, constants.R_OK);
    }
    if (existsSync(dir)) {
      accessSync(dir, constants.W_OK | constants.X_OK);
      return true;
    }
    let parent = dirname(dir);
    while (!existsSync(parent)) {
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
    accessSync(parent, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function saveLedger(ledger: GeneratedRepairLifecycleLedger): boolean {
  try {
    const path = generatedRepairLifecyclePath();
    const dir = join(homedir(), '.ashlr', 'fleet');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      schemaVersion: 1,
      records: ledger.records.slice(-MAX_RECORDS),
    }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    clearLifecycleWriteFailure();
    return true;
  } catch {
    markLifecycleWriteFailure();
    return false;
  }
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
  const lockToken = acquireLifecycleLock();
  if (!lockToken) {
    markContentionAfterWriter();
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  try {
    return recordGeneratedRepairLifecycleUnlocked(id, evidence);
  } finally {
    releaseLifecycleLock(lockToken);
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
