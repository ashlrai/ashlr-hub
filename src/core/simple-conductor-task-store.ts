import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { EngineId } from './types.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from './fleet/local-store-lock.js';
import { isSafeExecutionIdentity } from './fleet/attempt-identity.js';
import { readStableRegularFile } from './util/stable-file-read.js';
import { assurePrivateStoragePath } from './util/private-storage.js';
import { writePrivateFileAtomically } from './util/private-file-write.js';

const TASK_GENERATION_DOMAIN = 'ashlr:simple-conductor-task-generation:v1';
const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 10_000;
const MAX_TEXT_BYTES = 1_000_000;
const LEASE_DURATION_MS = 24 * 60 * 60_000;
const LEASE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex',
  'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);

export interface SimpleConductorDispatchLease {
  token: string;
  generationId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface TaskSpec {
  id: string;
  repo: string;
  engine?: EngineId;
  instruction: string;
  priority?: number;
  done?: boolean;
  dispatchedAt?: string;
  proposalId?: string;
  candidateProposalId?: string;
  lastError?: string;
  attempts?: number;
  retryAfter?: string;
  revision?: number;
  dispatchLease?: SimpleConductorDispatchLease;
}

export interface ClaimedSimpleConductorTask {
  task: TaskSpec;
  token: string;
  generationId: string;
  revision: number;
  rowDigest: string;
}

export type TaskStoreReadResult =
  | { ok: true; tasks: TaskSpec[] }
  | { ok: false; reason: string };

export type TaskClaimResult =
  | { ok: true; claim: ClaimedSimpleConductorTask }
  | { ok: false; reason: 'busy' | 'changed' | 'done' | 'cooling' | 'reconciliation-required' | 'unavailable'; detail: string };

export type TaskSettlement = {
  done?: boolean;
  proposalId?: string;
  candidateProposalId?: string;
  lastError?: string;
  retryAfter?: string;
};

export type TaskSettlementResult =
  | { ok: true; task: TaskSpec }
  | { ok: false; reason: 'changed' | 'unavailable'; detail: string };

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

export function simpleConductorTasksPath(): string {
  return join(stateRoot(), 'tasks.json');
}

function taskLockPath(): string {
  return join(stateRoot(), '.tasks.lock');
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function ensureStateRoot(): boolean {
  try {
    const root = stateRoot();
    let created = false;
    if (!existsSync(root)) {
      mkdirSync(root, { mode: 0o700 });
      created = true;
    }
    const before = lstatSync(root);
    if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid)) return false;
    if (process.platform !== 'win32') chmodSync(root, 0o700);
    const assurance = assurePrivateStoragePath(
      root,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      {
        anchorPath: homedir(),
      },
    );
    if (!assurance.ok) return false;
    const after = lstatSync(root);
    return !after.isSymbolicLink() && after.isDirectory() && owned(after.uid) &&
      after.dev === before.dev && after.ino === before.ino;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, maxBytes = MAX_TEXT_BYTES): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validLease(value: unknown): value is SimpleConductorDispatchLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return Object.keys(lease).sort().join(',') === 'claimedAt,expiresAt,generationId,token' &&
    typeof lease['token'] === 'string' && LEASE_TOKEN_RE.test(lease['token']) &&
    typeof lease['generationId'] === 'string' && /^[a-f0-9]{64}$/.test(lease['generationId']) &&
    validIso(lease['claimedAt']) && validIso(lease['expiresAt']) &&
    Date.parse(lease['expiresAt']) > Date.parse(lease['claimedAt']);
}

function validTask(value: unknown): value is TaskSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (!isSafeExecutionIdentity(task['id']) || !boundedString(task['repo'], 16_384) ||
    !boundedString(task['instruction']) || task['instruction'].trim().length === 0) return false;
  if (!isAbsolute(task['repo']) || task['repo'].includes('\0')) return false;
  if (task['engine'] !== undefined &&
    (!boundedString(task['engine'], 160) || !ENGINE_IDS.has(task['engine'] as EngineId))) return false;
  if (task['priority'] !== undefined && !Number.isSafeInteger(task['priority'])) return false;
  if (task['done'] !== undefined && typeof task['done'] !== 'boolean') return false;
  if (task['attempts'] !== undefined &&
    (!Number.isSafeInteger(task['attempts']) || Number(task['attempts']) < 0)) return false;
  if (task['revision'] !== undefined &&
    (!Number.isSafeInteger(task['revision']) || Number(task['revision']) < 0)) return false;
  for (const key of ['dispatchedAt', 'retryAfter'] as const) {
    if (task[key] !== undefined && !validIso(task[key])) return false;
  }
  for (const key of ['proposalId', 'candidateProposalId'] as const) {
    if (task[key] !== undefined && !isSafeExecutionIdentity(task[key])) return false;
  }
  if (task['lastError'] !== undefined && !boundedString(task['lastError'], 16_384)) return false;
  return task['dispatchLease'] === undefined || validLease(task['dispatchLease']);
}

function parseTasks(raw: string): TaskStoreReadResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_TASKS || !parsed.every(validTask)) {
      return { ok: false, reason: 'task store is not a bounded valid task array' };
    }
    const ids = new Set<string>();
    for (const task of parsed) {
      if (ids.has(task.id)) return { ok: false, reason: `task store contains duplicate id ${task.id}` };
      ids.add(task.id);
    }
    return { ok: true, tasks: parsed };
  } catch {
    return { ok: false, reason: 'task store contains malformed JSON' };
  }
}

function readTasksUnlocked(): TaskStoreReadResult {
  const path = simpleConductorTasksPath();
  if (!existsSync(path)) return { ok: true, tasks: [] };
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_TASK_FILE_BYTES,
    remainingBytes: MAX_TASK_FILE_BYTES,
  });
  if (!read.ok) return { ok: false, reason: `task store is unreadable: ${read.reason}` };
  return parseTasks(read.text);
}

function withTaskLock<T>(fn: () => T): T | null {
  if (!ensureStateRoot()) return null;
  const lock = acquireLocalStoreLock(taskLockPath(), 2_000, { anchorPath: homedir() });
  if (!lock) return null;
  try {
    return fn();
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function writeTasksUnlocked(tasks: TaskSpec[]): void {
  const encoded = `${JSON.stringify(tasks, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TASK_FILE_BYTES) {
    throw new Error('task store exceeds the maximum encoded size');
  }
  const target = simpleConductorTasksPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writePrivateFileAtomically(temporary, target, encoded, {
    anchorPath: homedir(),
    label: 'simple conductor task store',
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function simpleConductorTaskGenerationId(
  task: Pick<TaskSpec, 'id' | 'repo' | 'instruction' | 'engine'>,
): string {
  if (!isAbsolute(task.repo) || task.repo.includes('\0')) {
    throw new Error('task repository path is not canonicalizable');
  }
  const canonicalRepo = resolve(task.repo);
  return createHash('sha256').update(stableJson({
    domain: TASK_GENERATION_DOMAIN,
    id: task.id,
    repo: canonicalRepo,
    instruction: task.instruction,
    engine: task.engine ?? 'claude',
  })).digest('hex');
}

export function readSimpleConductorTasks(): TaskStoreReadResult {
  const result = withTaskLock(readTasksUnlocked);
  return result ?? { ok: false, reason: 'task store lock is unavailable' };
}

export function claimSimpleConductorTask(
  taskId: string,
  expectedGenerationId: string,
  nowMs = Date.now(),
): TaskClaimResult {
  const result = withTaskLock<TaskClaimResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    if (current.done) return { ok: false, reason: 'done', detail: 'task is already complete' };
    if (simpleConductorTaskGenerationId(current) !== expectedGenerationId) {
      return { ok: false, reason: 'changed', detail: 'task generation changed before dispatch' };
    }
    if (current.retryAfter && Date.parse(current.retryAfter) > nowMs) {
      return { ok: false, reason: 'cooling', detail: 'task retry window has not opened' };
    }
    if (current.dispatchLease && current.dispatchLease.generationId === expectedGenerationId) {
      return Date.parse(current.dispatchLease.expiresAt) > nowMs
        ? { ok: false, reason: 'busy', detail: 'task has an active dispatch lease' }
        : {
            ok: false,
            reason: 'reconciliation-required',
            detail: 'task dispatch lease expired without terminal authority',
          };
    }
    const token = randomUUID();
    const now = new Date(nowMs).toISOString();
    const lease: SimpleConductorDispatchLease = {
      token,
      generationId: expectedGenerationId,
      claimedAt: now,
      expiresAt: new Date(nowMs + LEASE_DURATION_MS).toISOString(),
    };
    const revision = (current.revision ?? 0) + 1;
    const claimed: TaskSpec = {
      ...current,
      attempts: (current.attempts ?? 0) + 1,
      dispatchedAt: now,
      revision,
      dispatchLease: lease,
    };
    const next = [...read.tasks];
    next[index] = claimed;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task claim persistence failed',
      };
    }
    return {
      ok: true,
      claim: {
        task: claimed,
        token,
        generationId: expectedGenerationId,
        revision,
        rowDigest: createHash('sha256').update(stableJson(claimed)).digest('hex'),
      },
    };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}

export function settleSimpleConductorTask(
  claim: ClaimedSimpleConductorTask,
  settlement: TaskSettlement,
): TaskSettlementResult {
  const result = withTaskLock<TaskSettlementResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === claim.task.id);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    const lease = current.dispatchLease;
    if (simpleConductorTaskGenerationId(current) !== claim.generationId ||
      current.revision !== claim.revision ||
      createHash('sha256').update(stableJson(current)).digest('hex') !== claim.rowDigest ||
      !lease || lease.token !== claim.token || lease.generationId !== claim.generationId) {
      return { ok: false, reason: 'changed', detail: 'task generation or dispatch lease changed' };
    }
    const nextTask: TaskSpec = { ...current, ...settlement, revision: claim.revision + 1 };
    delete nextTask.dispatchLease;
    if (settlement.proposalId === undefined) delete nextTask.proposalId;
    if (settlement.candidateProposalId === undefined) delete nextTask.candidateProposalId;
    if (settlement.retryAfter === undefined) delete nextTask.retryAfter;
    const next = [...read.tasks];
    next[index] = nextTask;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task settlement persistence failed',
      };
    }
    return { ok: true, task: nextTask };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}

export function reconcileSimpleConductorTask(
  taskId: string,
  expectedGenerationId: string,
  settlement: TaskSettlement,
  nowMs = Date.now(),
): TaskSettlementResult {
  const result = withTaskLock<TaskSettlementResult>(() => {
    const read = readTasksUnlocked();
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.reason };
    const index = read.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, reason: 'changed', detail: 'task row disappeared' };
    const current = read.tasks[index];
    if (simpleConductorTaskGenerationId(current) !== expectedGenerationId) {
      return { ok: false, reason: 'changed', detail: 'task generation changed during reconciliation' };
    }
    if (current.dispatchLease && current.dispatchLease.generationId === expectedGenerationId &&
      Date.parse(current.dispatchLease.expiresAt) > nowMs) {
      return { ok: false, reason: 'changed', detail: 'task has an active dispatch lease' };
    }
    const nextTask: TaskSpec = {
      ...current,
      ...settlement,
      revision: (current.revision ?? 0) + 1,
    };
    delete nextTask.dispatchLease;
    if (settlement.proposalId === undefined) delete nextTask.proposalId;
    if (settlement.candidateProposalId === undefined) delete nextTask.candidateProposalId;
    if (settlement.retryAfter === undefined) delete nextTask.retryAfter;
    const next = [...read.tasks];
    next[index] = nextTask;
    try {
      writeTasksUnlocked(next);
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : 'task reconciliation persistence failed',
      };
    }
    return { ok: true, task: nextTask };
  });
  return result ?? { ok: false, reason: 'unavailable', detail: 'task store lock is unavailable' };
}
