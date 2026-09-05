/** Private metadata-only diagnostics for external agent invocations. */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import type { EngineId } from '../types.js';
import type { TerminationReason } from './run-monitor.js';
import { isSafeExecutionIdentity } from '../fleet/attempt-identity.js';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_DIAGNOSTIC_FILE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_FILES = 2_000;
const MAX_DIAGNOSTIC_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_DIRECTORY_ENTRIES = 4_096;
const DIAGNOSTIC_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const APPEND_LOCK_WAIT_MS = 5_000;
const RUN_REF_DOMAIN = 'ashlr:agent-diagnostic-run:v1';
const lockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function processStartRef(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 1_024,
    });
    const rawStdout: unknown = result.stdout;
    const stdout = typeof rawStdout === 'string'
      ? rawStdout
      : Buffer.isBuffer(rawStdout) ? rawStdout.toString('utf8') : '';
    const value = result.status === 0 ? stdout.trim() : '';
    if (value === '' || value.length > 128) return undefined;
    return createHash('sha256').update(value).digest('hex');
  } catch {
    return undefined;
  }
}

let cachedCurrentProcessStartRef: string | undefined;
let currentProcessStartRefResolved = false;
const observedProcessStarts = new Map<number, { ref: string | undefined; expiresAt: number }>();
const unknownLockObservations = new Map<string, { dev: number; ino: number; seenAt: number }>();

function currentProcessStartRef(): string | undefined {
  if (!currentProcessStartRefResolved) {
    cachedCurrentProcessStartRef = process.platform === 'win32' ? undefined : processStartRef(process.pid);
    currentProcessStartRefResolved = true;
  }
  return cachedCurrentProcessStartRef;
}

function observedProcessStartRef(pid: number): string | undefined {
  if (pid === process.pid) return currentProcessStartRef();
  const now = performance.now();
  const cached = observedProcessStarts.get(pid);
  if (cached && cached.expiresAt > now) return cached.ref;
  const ref = processStartRef(pid);
  observedProcessStarts.set(pid, { ref, expiresAt: now + LOCK_INITIALIZATION_GRACE_MS });
  return ref;
}

const ENGINE_IDS = new Set<EngineId>([
  'builtin',
  'local-coder',
  'ashlrcode',
  'aw',
  'claude',
  'codex',
  'hermes',
  'kimi',
  'nim',
  'opencode',
  'grok',
]);

const TERMINATION_REASONS = new Set<TerminationReason>([
  'backstop-timeout',
  'idle-stall',
  'loop-stall',
  'no-diff-stall',
  'clean-exit',
  'error-exit',
]);

export type AgentDiagnosticErrorClass =
  | 'none'
  | 'authentication'
  | 'configuration'
  | 'command-missing'
  | 'rate-limit'
  | 'timeout'
  | 'terminated'
  | 'execution';

const ERROR_CLASSES = new Set<AgentDiagnosticErrorClass>([
  'none',
  'authentication',
  'configuration',
  'command-missing',
  'rate-limit',
  'timeout',
  'terminated',
  'execution',
]);

export interface AgentDiagnosticTextShape {
  bytes: number;
  lines: number;
  present: boolean;
}

export interface AgentDiagnosticInput {
  runId: string;
  engine: EngineId;
  ok: boolean;
  terminationReason?: TerminationReason;
  errorClass: AgentDiagnosticErrorClass;
  durationMs: number;
  attempt: number;
  maxAttempts: number;
  configRecoveryAttempts?: number;
  tokensIn?: number;
  tokensOut?: number;
  output: AgentDiagnosticTextShape;
  error: AgentDiagnosticTextShape;
}

export interface AgentDiagnosticRecord extends Omit<AgentDiagnosticInput, 'runId'> {
  schemaVersion: 1;
  ts: string;
  runRef: string;
}

export interface AgentDiagnosticStoreStatus {
  hardened: boolean;
  legacyFiles: number;
  metadataFiles: number;
  removedMetadataFiles: number;
  unsafeEntries: number;
  limitExceeded: boolean;
}

export function agentDiagnosticsDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.ashlr');
  return join(root, 'agent-logs');
}

export function measureAgentDiagnosticText(value: unknown): AgentDiagnosticTextShape {
  const text = typeof value === 'string' ? value : '';
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text === '' ? 0 : text.split(/\r?\n/).length,
    present: text.length > 0,
  };
}

export function agentDiagnosticRunRef(runId: string): string | undefined {
  if (!isSafeExecutionIdentity(runId)) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([RUN_REF_DOMAIN, runId]))
    .digest('hex');
}

export function classifyAgentDiagnosticError(value: unknown): AgentDiagnosticErrorClass {
  if (typeof value !== 'string' || value.trim() === '') return 'none';
  if (/rate.?limit|too many requests|\b429\b/i.test(value)) return 'rate-limit';
  if (/auth|credential|unauthorized|forbidden|\b40[13]\b/i.test(value)) return 'authentication';
  if (/not found|enoent|unknown command|command missing/i.test(value)) return 'command-missing';
  if (/config|unknown variant|expected one of|invalid option/i.test(value)) return 'configuration';
  if (/timeout|timed out|etimedout/i.test(value)) return 'timeout';
  if (/signal|killed|terminated|abort/i.test(value)) return 'terminated';
  return 'execution';
}

function boundedCounter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function positiveAttempt(value: unknown): number | undefined {
  const count = boundedCounter(value);
  return count !== undefined && count >= 1 && count <= 100 ? count : undefined;
}

function sanitizeShape(value: unknown): AgentDiagnosticTextShape | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const bytes = boundedCounter(input['bytes']);
  const lines = boundedCounter(input['lines']);
  if (bytes === undefined || lines === undefined || typeof input['present'] !== 'boolean') return undefined;
  if (input['present'] !== (bytes > 0) || (bytes === 0 ? lines !== 0 : lines < 1)) return undefined;
  return { bytes, lines, present: input['present'] };
}

function sanitizeRecord(input: AgentDiagnosticInput): AgentDiagnosticRecord | null {
  const runRef = agentDiagnosticRunRef(input.runId);
  if (!runRef || !ENGINE_IDS.has(input.engine)) return null;
  if (!ERROR_CLASSES.has(input.errorClass)) return null;
  const durationMs = boundedCounter(input.durationMs);
  const attempt = positiveAttempt(input.attempt);
  const maxAttempts = positiveAttempt(input.maxAttempts);
  const output = sanitizeShape(input.output);
  const error = sanitizeShape(input.error);
  if (
    durationMs === undefined ||
    attempt === undefined ||
    maxAttempts === undefined ||
    attempt > maxAttempts ||
    !output ||
    !error
  ) return null;
  const terminationReason = input.terminationReason && TERMINATION_REASONS.has(input.terminationReason)
    ? input.terminationReason
    : undefined;
  const configRecoveryAttempts = boundedCounter(input.configRecoveryAttempts);
  const tokensIn = boundedCounter(input.tokensIn);
  const tokensOut = boundedCounter(input.tokensOut);
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    runRef,
    engine: input.engine,
    ok: input.ok === true,
    ...(terminationReason ? { terminationReason } : {}),
    errorClass: input.errorClass,
    durationMs,
    attempt,
    maxAttempts,
    ...(configRecoveryAttempts !== undefined ? { configRecoveryAttempts } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    output,
    error,
  };
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function ensurePrivateDirectory(): void {
  if (process.platform === 'win32') throw new Error('private agent diagnostics unsupported on win32');
  const dir = agentDiagnosticsDir();
  const root = dirname(dir);
  for (const candidate of [root, dir]) {
    if (!existsSync(candidate)) mkdirSync(candidate, { recursive: true, mode: PRIVATE_DIR_MODE });
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) {
      throw new Error('unsafe agent diagnostics directory');
    }
    chmodSync(candidate, PRIVATE_DIR_MODE);
  }
  if (dirname(realpathSync(dir)) !== realpathSync(root)) {
    throw new Error('agent diagnostics directory escaped configured home');
  }
}

function safelyUnlinkOwnedFile(filePath: string, expected: { dev: number; ino: number }): boolean {
  try {
    const current = lstatSync(filePath);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !ownedByCurrentUser(current.uid) ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) return false;
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function lockOwnerState(
  lockPath: string,
  expected: { dev: number; ino: number },
): 'alive' | 'dead' | 'unknown' {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !ownedByCurrentUser(opened.uid) ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size < 1 ||
      opened.size > 128
    ) return 'unknown';
    const buffer = Buffer.alloc(opened.size);
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return 'unknown';
    const parsed = JSON.parse(buffer.toString('utf8')) as { pid?: unknown; startRef?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1) return 'unknown';
    const recordedStartRef = typeof parsed.startRef === 'string' && /^[a-f0-9]{64}$/.test(parsed.startRef)
      ? parsed.startRef
      : undefined;
    if (!recordedStartRef) return 'unknown';
    try {
      const pid = Number(parsed.pid);
      process.kill(pid, 0);
      const observedStartRef = observedProcessStartRef(pid);
      if (observedStartRef && observedStartRef !== recordedStartRef) {
        const confirmedStartRef = processStartRef(pid);
        if (confirmedStartRef && confirmedStartRef !== recordedStartRef) return 'dead';
        if (confirmedStartRef === recordedStartRef) {
          observedProcessStarts.set(pid, {
            ref: confirmedStartRef,
            expiresAt: performance.now() + LOCK_INITIALIZATION_GRACE_MS,
          });
        }
      }
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
    }
  } catch {
    return 'unknown';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort lock inspection */ }
    }
  }
}

function acquireLock(lockPath: string, waitMs = 0): number | undefined {
  const deadline = performance.now() + waitMs;
  let unknownOwner: { dev: number; ino: number; seenAt: number } | undefined;
  let attempt = 0;
  while (true) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      const opened = fstatSync(fd);
      if (!opened.isFile() || !ownedByCurrentUser(opened.uid)) {
        closeSync(fd);
        return undefined;
      }
      fchmodSync(fd, PRIVATE_FILE_MODE);
      const startRef = currentProcessStartRef();
      if (!startRef) {
        releaseLock(lockPath, fd);
        return undefined;
      }
      const owner = `${JSON.stringify({
        pid: process.pid,
        startRef,
      })}\n`;
      if (writeSync(fd, owner, undefined, 'utf8') !== Buffer.byteLength(owner, 'utf8')) {
        releaseLock(lockPath, fd);
        return undefined;
      }
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      try {
        const stale = lstatSync(lockPath);
        if (
          stale.isSymbolicLink() ||
          !stale.isFile() ||
          !ownedByCurrentUser(stale.uid)
        ) return undefined;
        const ownerState = lockOwnerState(lockPath, stale);
        const now = performance.now();
        if (ownerState === 'dead') {
          if (!safelyUnlinkOwnedFile(lockPath, stale)) return undefined;
          continue;
        }
        if (ownerState === 'unknown') {
          if (!unknownOwner || unknownOwner.dev !== stale.dev || unknownOwner.ino !== stale.ino) {
            unknownOwner = { dev: stale.dev, ino: stale.ino, seenAt: now };
          }
          if (now - unknownOwner.seenAt >= LOCK_INITIALIZATION_GRACE_MS) {
            if (!safelyUnlinkOwnedFile(lockPath, stale)) return undefined;
            unknownOwner = undefined;
            continue;
          }
        } else {
          unknownOwner = undefined;
        }
      } catch {
        if (performance.now() >= deadline) return undefined;
        continue;
      }
      if (performance.now() >= deadline) return undefined;
      const remainingMs = deadline - performance.now();
      const delayMs = Math.min(remainingMs, 10 + (attempt % 7) * 5);
      Atomics.wait(lockSleepBuffer, 0, 0, delayMs);
      attempt += 1;
    }
  }
}

function releaseLock(lockPath: string, fd: number | undefined): void {
  if (fd === undefined) return;
  let snapshot: { dev: number; ino: number } | undefined;
  try {
    const opened = fstatSync(fd);
    snapshot = { dev: opened.dev, ino: opened.ino };
  } catch { /* best-effort lock cleanup */ }
  try { closeSync(fd); } catch { /* best-effort lock cleanup */ }
  if (snapshot) safelyUnlinkOwnedFile(lockPath, snapshot);
}

function maintainPrivateStore(reserveForAppend: boolean): AgentDiagnosticStoreStatus {
  const empty: AgentDiagnosticStoreStatus = {
    hardened: false,
    legacyFiles: 0,
    metadataFiles: 0,
    removedMetadataFiles: 0,
    unsafeEntries: 0,
    limitExceeded: false,
  };
  try {
    ensurePrivateDirectory();
    const dir = agentDiagnosticsDir();
    const maintenanceLockPath = join(dir, '.maintenance.lock');
    const maintenanceLock = acquireLock(maintenanceLockPath, LOCK_INITIALIZATION_GRACE_MS);
    if (maintenanceLock === undefined) return empty;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.length > MAX_DIAGNOSTIC_DIRECTORY_ENTRIES) {
        return { ...empty, hardened: true, limitExceeded: true };
      }
      const metadata: Array<{ path: string; size: number; mtimeMs: number; dev: number; ino: number }> = [];
      const lockStates = new Map<string, {
        state: 'alive' | 'dead' | 'unknown';
        dev: number;
        ino: number;
      }>();
      const observedUnknownLocks = new Set<string>();
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.name.endsWith('.jsonl.lock')) continue;
        const path = join(dir, entry.name);
        try {
          const stat = lstatSync(path);
          if (!stat.isSymbolicLink() && stat.isFile() && ownedByCurrentUser(stat.uid)) {
            let state = lockOwnerState(path, stat);
            if (state === 'unknown') {
              const observed = unknownLockObservations.get(path);
              const observedAt = performance.now();
              if (observed && observed.dev === stat.dev && observed.ino === stat.ino) {
                if (observedAt - observed.seenAt >= LOCK_INITIALIZATION_GRACE_MS) {
                  state = 'dead';
                  unknownLockObservations.delete(path);
                } else {
                  observedUnknownLocks.add(path);
                }
              } else {
                unknownLockObservations.set(path, { dev: stat.dev, ino: stat.ino, seenAt: observedAt });
                observedUnknownLocks.add(path);
              }
            } else {
              unknownLockObservations.delete(path);
            }
            lockStates.set(entry.name, { state, dev: stat.dev, ino: stat.ino });
          }
        } catch { /* classified during the main scan */ }
      }
      for (const path of unknownLockObservations.keys()) {
        if (dirname(path) === dir && !observedUnknownLocks.has(path)) unknownLockObservations.delete(path);
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.name === '.maintenance.lock') continue;
        let stat;
        try { stat = lstatSync(path); } catch { empty.unsafeEntries += 1; continue; }
        if (stat.isSymbolicLink() || !stat.isFile() || !ownedByCurrentUser(stat.uid)) {
          empty.unsafeEntries += 1;
          continue;
        }
        if (entry.name.endsWith('.lock')) {
          const classified = lockStates.get(entry.name);
          if (classified?.state === 'dead') safelyUnlinkOwnedFile(path, classified);
          continue;
        }
        if (entry.name.endsWith('.log')) {
          chmodSync(path, PRIVATE_FILE_MODE);
          empty.legacyFiles += 1;
          continue;
        }
        if (!entry.name.endsWith('.jsonl')) continue;
        chmodSync(path, PRIVATE_FILE_MODE);
        const lockName = `${entry.name}.lock`;
        let lock = lockStates.get(lockName);
        const lockPath = join(dir, lockName);
        try {
          const currentLock = lstatSync(lockPath);
          if (currentLock.isSymbolicLink() || !currentLock.isFile() || !ownedByCurrentUser(currentLock.uid)) {
            continue;
          }
          if (!lock || lock.dev !== currentLock.dev || lock.ino !== currentLock.ino) {
            lock = {
              state: lockOwnerState(lockPath, currentLock),
              dev: currentLock.dev,
              ino: currentLock.ino,
            };
            lockStates.set(lockName, lock);
          }
        } catch {
          lock = undefined;
        }
        if (lock && lock.state !== 'dead') continue;
        metadata.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
      }
      metadata.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
      const maxFiles = MAX_DIAGNOSTIC_FILES - (reserveForAppend ? 1 : 0);
      const maxBytes = MAX_DIAGNOSTIC_TOTAL_BYTES - (reserveForAppend ? MAX_DIAGNOSTIC_FILE_BYTES : 0);
      let keptFiles = 0;
      let keptBytes = 0;
      for (const file of metadata) {
        const expired = now - file.mtimeMs > DIAGNOSTIC_TTL_MS;
        const overCap = keptFiles >= maxFiles || keptBytes + file.size > maxBytes;
        if (expired || overCap) {
          if (safelyUnlinkOwnedFile(file.path, file)) empty.removedMetadataFiles += 1;
          continue;
        }
        keptFiles += 1;
        keptBytes += file.size;
      }
      empty.metadataFiles = keptFiles;
      empty.hardened = true;
      return empty;
    } finally {
      releaseLock(maintenanceLockPath, maintenanceLock);
    }
  } catch {
    return empty;
  }
}

/** Harden legacy permissions and enforce retention for metadata-only records. */
export function hardenAgentDiagnosticsStore(): AgentDiagnosticStoreStatus {
  let appendLock: number | undefined;
  let appendLockPath = '';
  try {
    ensurePrivateDirectory();
    appendLockPath = join(agentDiagnosticsDir(), '.append.lock');
    appendLock = acquireLock(appendLockPath, APPEND_LOCK_WAIT_MS);
    if (appendLock === undefined) {
      return {
        hardened: false,
        legacyFiles: 0,
        metadataFiles: 0,
        removedMetadataFiles: 0,
        unsafeEntries: 0,
        limitExceeded: false,
      };
    }
    return maintainPrivateStore(false);
  } catch {
    return {
      hardened: false,
      legacyFiles: 0,
      metadataFiles: 0,
      removedMetadataFiles: 0,
      unsafeEntries: 0,
      limitExceeded: false,
    };
  } finally {
    releaseLock(appendLockPath, appendLock);
  }
}

function appendPrivateRecord(filePath: string, contents: string): boolean {
  let fd: number | undefined;
  let lockFd: number | undefined;
  const lockPath = `${filePath}.lock`;
  try {
    ensurePrivateDirectory();
    lockFd = acquireLock(lockPath, LOCK_INITIALIZATION_GRACE_MS);
    if (lockFd === undefined) return false;
    if (existsSync(filePath)) {
      const before = lstatSync(filePath);
      if (before.isSymbolicLink() || !before.isFile() || !ownedByCurrentUser(before.uid)) return false;
    }
    fd = openSync(
      filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || !ownedByCurrentUser(opened.uid)) return false;
    fchmodSync(fd, PRIVATE_FILE_MODE);
    ensurePrivateDirectory();
    const bytes = Buffer.byteLength(contents, 'utf8');
    if (opened.size + bytes > MAX_DIAGNOSTIC_FILE_BYTES) return false;
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1 || tail[0] !== 0x0a) return false;
    }
    const written = writeSync(fd, contents, undefined, 'utf8');
    const after = fstatSync(fd);
    return written === bytes && after.size === opened.size + bytes && after.size <= MAX_DIAGNOSTIC_FILE_BYTES;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort diagnostics */ }
    }
    releaseLock(lockPath, lockFd);
  }
}

/** Never throws and persists only the explicit fixed-schema metadata fields. */
export function recordAgentDiagnostic(input: AgentDiagnosticInput): boolean {
  let appendLock: number | undefined;
  let appendLockPath = '';
  try {
    const record = sanitizeRecord(input);
    if (!record) return false;
    ensurePrivateDirectory();
    appendLockPath = join(agentDiagnosticsDir(), '.append.lock');
    appendLock = acquireLock(appendLockPath, APPEND_LOCK_WAIT_MS);
    if (appendLock === undefined) return false;
    const store = maintainPrivateStore(true);
    if (!store.hardened || store.limitExceeded || store.unsafeEntries > 0) return false;
    return appendPrivateRecord(
      join(agentDiagnosticsDir(), `${record.runRef}.jsonl`),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    return false;
  } finally {
    releaseLock(appendLockPath, appendLock);
  }
}
