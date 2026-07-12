import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { isAbsolute, join, resolve } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readCutoffObservationCheckpointsSnapshot } from '../fleet/cutoff-observation-checkpoints.js';
import { killSwitchOn } from '../sandbox/policy.js';

export const CUTOFF_CAPTURE_DEADLINE_MS = 30_000;
export const CUTOFF_CAPTURE_SUCCESS_CADENCE_MS = 24 * 60 * 60 * 1_000;
export const CUTOFF_CAPTURE_FAILURE_RETRY_MS = 60 * 60 * 1_000;
const KILL_CONFIRM_MS = 1_000;
const MAX_STATE_BYTES = 8 * 1_024;
const FUTURE_TOLERANCE_MS = 5_000;
const ATTEMPT_RE = /^[a-f0-9-]{36}$/;
const STATE_KEYS = new Set([
  'schemaVersion', 'active', 'lastAttemptAt', 'lastSuccessAt', 'lastFailureAt',
  'nextEligibleAt', 'lastOutcome', 'lastReason',
]);
const ACTIVE_KEYS = new Set(['attemptId', 'startedAt', 'deadlineAt', 'phase']);

export type CutoffCaptureOutcome = 'running' | 'success' | 'failure' | 'cancelled';

export interface CutoffCaptureSchedulerState {
  schemaVersion: 1;
  active: {
    attemptId: string;
    startedAt: string;
    deadlineAt: string;
    phase: 'capturing' | 'committing';
    supervisorPid?: number;
  } | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextEligibleAt: string | null;
  lastOutcome: CutoffCaptureOutcome | null;
  lastReason: string | null;
}

export interface CutoffCaptureSchedulerReadResult {
  sourceState: 'missing' | 'healthy' | 'degraded' | 'unsupported';
  state: CutoffCaptureSchedulerState | null;
  stopReasons: string[];
}

export type CutoffCaptureScheduleReason =
  | 'due'
  | 'cadence-active'
  | 'active'
  | 'state-degraded'
  | 'platform-unsupported'
  | 'invalid-time';

export interface CutoffCaptureScheduleDecision {
  due: boolean;
  reason: CutoffCaptureScheduleReason;
  nextEligibleAt: string | null;
}

export interface CutoffCaptureChildResult {
  outcome: 'completed' | 'failed' | 'timed-out' | 'cancelled';
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ScheduledCutoffCapture {
  disposition: 'scheduled' | 'overlap-suppressed' | 'not-due' | 'unsupported' | 'state-degraded' | 'spawn-failed';
  reason: string;
  completion: Promise<CutoffCaptureChildResult>;
  cancel: () => void;
}

interface ChildHandle {
  pid?: number;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

export interface ScheduleCutoffCaptureOptions {
  platform?: NodeJS.Platform;
  deps?: {
    spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildHandle;
    now?: () => number;
    killSwitchOn?: () => boolean;
    processKill?: (pid: number, signal: NodeJS.Signals) => void;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    invocation?: (flag: string, args: readonly string[]) => { command: string; args: string[] };
    reserve?: (nowMs: number) => ReserveResult;
    complete?: (attemptId: string, outcome: Exclude<CutoffCaptureOutcome, 'running'>, reason: string, nowMs: number) => boolean;
    cancelAttempt?: typeof cancelCutoffCaptureAttempt;
    attemptReleased?: (attemptId: string) => boolean;
  };
}

type ReserveResult =
  | { reserved: true; attemptId: string; deadlineAt: string }
  | { reserved: false; reason: CutoffCaptureScheduleReason };

let active: ScheduledCutoffCapture | null = null;

function storageRoot(): string {
  const configured = process.env['ASHLR_HOME'];
  if (!configured) return join(homedir(), '.ashlr');
  if (!isAbsolute(configured) || resolve(configured) !== configured) throw new Error('unsafe ASHLR_HOME');
  return configured;
}

export function cutoffCaptureSchedulerStatePath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-scheduler.json');
}

export function cutoffCaptureAttemptReleased(attemptId: string): boolean {
  if (!ATTEMPT_RE.test(attemptId)) return false;
  const read = readCutoffObservationCheckpointsSnapshot();
  return read.checkpoints.some((checkpoint) => checkpoint.captureAttemptId === attemptId);
}

function schedulerLockPath(): string {
  return join(storageRoot(), 'fleet', '.cutoff-observation-scheduler.lock');
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function privateNode(stat: Stats, kind: 'file' | 'directory'): boolean {
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return false;
  if (stat.isSymbolicLink()) return false;
  if (kind === 'file' && stat.nlink !== 1) return false;
  const uid = process.getuid?.();
  return (uid === undefined || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & (kind === 'file' ? 0o077 : 0o077)) === 0);
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function emptyState(): CutoffCaptureSchedulerState {
  return {
    schemaVersion: 1,
    active: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextEligibleAt: null,
    lastOutcome: null,
    lastReason: null,
  };
}

function validNullableTimestamp(value: unknown): value is string | null {
  return value === null || canonicalTimestamp(value);
}

function parseState(value: unknown): CutoffCaptureSchedulerState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as CutoffCaptureSchedulerState;
  if (Object.keys(state).length !== STATE_KEYS.size || Object.keys(state).some((key) => !STATE_KEYS.has(key)) ||
    state.schemaVersion !== 1 || !validNullableTimestamp(state.lastAttemptAt) ||
    !validNullableTimestamp(state.lastSuccessAt) || !validNullableTimestamp(state.lastFailureAt) ||
    !validNullableTimestamp(state.nextEligibleAt) ||
    !(state.lastOutcome === null || state.lastOutcome === 'running' || state.lastOutcome === 'success' ||
      state.lastOutcome === 'failure' || state.lastOutcome === 'cancelled') ||
    !(state.lastReason === null || (typeof state.lastReason === 'string' && state.lastReason.length <= 80 &&
      /^[a-z0-9-]+$/.test(state.lastReason)))) return null;
  if (state.active !== null) {
    const activeKeys = new Set(ACTIVE_KEYS);
    if (state.active.supervisorPid !== undefined) activeKeys.add('supervisorPid');
    if (typeof state.active !== 'object' || Array.isArray(state.active) ||
      Object.keys(state.active).length !== activeKeys.size ||
      Object.keys(state.active).some((key) => !activeKeys.has(key)) ||
      !ATTEMPT_RE.test(state.active.attemptId) || !canonicalTimestamp(state.active.startedAt) ||
      !canonicalTimestamp(state.active.deadlineAt) ||
      !(state.active.phase === 'capturing' || state.active.phase === 'committing') ||
      (state.active.supervisorPid !== undefined &&
        (!Number.isSafeInteger(state.active.supervisorPid) || state.active.supervisorPid <= 0)) ||
      state.lastOutcome !== 'running' ||
      state.lastAttemptAt !== state.active.startedAt ||
      Date.parse(state.active.deadlineAt) <= Date.parse(state.active.startedAt) ||
      Date.parse(state.active.deadlineAt) - Date.parse(state.active.startedAt) > CUTOFF_CAPTURE_DEADLINE_MS) return null;
  } else if (state.lastOutcome === 'running') return null;
  return state;
}

export function readCutoffCaptureSchedulerState(
  platform: NodeJS.Platform = process.platform,
): CutoffCaptureSchedulerReadResult {
  if (platform === 'win32') return { sourceState: 'unsupported', state: null, stopReasons: ['platform-unsupported'] };
  let fd: number | undefined;
  try {
    const root = storageRoot();
    const fleet = join(root, 'fleet');
    const path = cutoffCaptureSchedulerStatePath();
    if (!existsSync(path)) return { sourceState: 'missing', state: null, stopReasons: [] };
    const rootStat = lstatSync(root);
    const fleetStat = lstatSync(fleet);
    const named = lstatSync(path);
    if (!privateNode(rootStat, 'directory') || !privateNode(fleetStat, 'directory') ||
      !privateNode(named, 'file') || named.size > MAX_STATE_BYTES) throw new Error('unsafe state storage');
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateNode(opened, 'file') || !sameNode(opened, named) || opened.size > MAX_STATE_BYTES) {
      throw new Error('unsafe opened state');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('short state read');
      offset += count;
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (!privateNode(after, 'file') || !privateNode(namedAfter, 'file') ||
      !sameNode(opened, after) || !sameNode(opened, namedAfter) || after.size !== opened.size) {
      throw new Error('state changed during read');
    }
    const state = parseState(JSON.parse(bytes.toString('utf8')));
    if (!state) throw new Error('invalid state');
    return { sourceState: 'healthy', state, stopReasons: [] };
  } catch {
    return { sourceState: 'degraded', state: null, stopReasons: ['io-error'] };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function ensurePrivateStorage(): string {
  const root = storageRoot();
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const rootStat = lstatSync(root);
  if (!privateNode(rootStat, 'directory')) throw new Error('unsafe scheduler root');
  const fleet = join(root, 'fleet');
  if (!existsSync(fleet)) mkdirSync(fleet, { mode: 0o700 });
  chmodSync(fleet, 0o700);
  if (!privateNode(lstatSync(fleet), 'directory')) throw new Error('unsafe scheduler directory');
  return fleet;
}

function writeState(state: CutoffCaptureSchedulerState): boolean {
  if (!parseState(state)) return false;
  let fd: number | undefined;
  let tmp: string | undefined;
  try {
    const dir = ensurePrivateStorage();
    const path = cutoffCaptureSchedulerStatePath();
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
    if (bytes.length > MAX_STATE_BYTES) return false;
    if (existsSync(path) && !privateNode(lstatSync(path), 'file')) return false;
    tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateNode(opened, 'file')) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error('short state write');
      offset += count;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!privateNode(written, 'file') || !sameNode(opened, written) || written.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    tmp = undefined;
    fsyncDirectory(dir);
    const installed = lstatSync(path);
    return privateNode(installed, 'file') && sameNode(written, installed);
  } catch { return false; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (tmp) { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ } }
  }
}

export function decideCutoffCaptureSchedule(
  read: CutoffCaptureSchedulerReadResult,
  nowMs: number,
  platform: NodeJS.Platform = process.platform,
): CutoffCaptureScheduleDecision {
  if (platform === 'win32' || read.sourceState === 'unsupported') {
    return { due: false, reason: 'platform-unsupported', nextEligibleAt: null };
  }
  if (!Number.isFinite(nowMs)) return { due: false, reason: 'invalid-time', nextEligibleAt: null };
  if (read.sourceState === 'degraded') return { due: false, reason: 'state-degraded', nextEligibleAt: null };
  if (read.sourceState === 'missing' || !read.state) return { due: true, reason: 'due', nextEligibleAt: null };
  const state = read.state;
  const timestamps = [state.lastAttemptAt, state.lastSuccessAt, state.lastFailureAt]
    .filter((value): value is string => value !== null)
    .map(Date.parse);
  if (timestamps.some((value) => !Number.isFinite(value) || value > nowMs + FUTURE_TOLERANCE_MS)) {
    return { due: false, reason: 'state-degraded', nextEligibleAt: state.nextEligibleAt };
  }
  if (state.active && Date.parse(state.active.deadlineAt) > nowMs) {
    return { due: false, reason: 'active', nextEligibleAt: state.active.deadlineAt };
  }
  if (state.nextEligibleAt && Date.parse(state.nextEligibleAt) > nowMs) {
    return { due: false, reason: 'cadence-active', nextEligibleAt: state.nextEligibleAt };
  }
  return { due: true, reason: 'due', nextEligibleAt: state.nextEligibleAt };
}

function withSchedulerLock<T>(fallback: T, fn: () => T): T {
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    ensurePrivateStorage();
    lock = acquireLocalStoreLock(schedulerLockPath(), 250);
    return lock ? fn() : fallback;
  } catch { return fallback; }
  finally { if (lock) releaseLocalStoreLock(lock); }
}

export function reserveCutoffCaptureAttempt(nowMs: number): ReserveResult {
  return withSchedulerLock<ReserveResult>({ reserved: false, reason: 'state-degraded' }, () => {
    let read = readCutoffCaptureSchedulerState();
    if (read.sourceState === 'degraded' || read.sourceState === 'unsupported') {
      return { reserved: false, reason: read.sourceState === 'unsupported' ? 'platform-unsupported' : 'state-degraded' };
    }
    let state = read.state ?? emptyState();
    if (state.active && Date.parse(state.active.deadlineAt) <= nowMs) {
      if (state.active.supervisorPid !== undefined) {
        try {
          process.kill(-state.active.supervisorPid, 0);
          return { reserved: false, reason: 'active' };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            return { reserved: false, reason: 'state-degraded' };
          }
        }
      }
      const completedAt = state.active.deadlineAt;
      const released = cutoffCaptureAttemptReleased(state.active.attemptId);
      state = {
        ...state,
        active: null,
        lastSuccessAt: released ? completedAt : state.lastSuccessAt,
        lastFailureAt: released ? state.lastFailureAt : completedAt,
        lastOutcome: released ? 'success' : 'failure',
        lastReason: released ? 'released-before-recovery' : 'expired-attempt',
        nextEligibleAt: new Date(Date.parse(completedAt) + (released
          ? CUTOFF_CAPTURE_SUCCESS_CADENCE_MS : CUTOFF_CAPTURE_FAILURE_RETRY_MS)).toISOString(),
      };
      if (!writeState(state)) return { reserved: false, reason: 'state-degraded' };
      read = { sourceState: 'healthy', state, stopReasons: [] };
    }
    const decision = decideCutoffCaptureSchedule(read, nowMs);
    if (!decision.due) return { reserved: false, reason: decision.reason };
    const attemptId = randomUUID();
    const startedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(nowMs + CUTOFF_CAPTURE_DEADLINE_MS).toISOString();
    const next: CutoffCaptureSchedulerState = {
      ...state,
      active: { attemptId, startedAt, deadlineAt, phase: 'capturing' },
      lastAttemptAt: startedAt,
      nextEligibleAt: deadlineAt,
      lastOutcome: 'running',
      lastReason: null,
    };
    return writeState(next)
      ? { reserved: true, attemptId, deadlineAt }
      : { reserved: false, reason: 'state-degraded' };
  });
}

export function bindCutoffCaptureSupervisor(
  attemptId: string,
  deadlineAt: string,
  supervisorPid: number,
): boolean {
  if (!ATTEMPT_RE.test(attemptId) || !canonicalTimestamp(deadlineAt) ||
    !Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) return false;
  return withSchedulerLock(false, () => {
    const read = readCutoffCaptureSchedulerState();
    if (read.sourceState !== 'healthy' || !read.state?.active ||
      read.state.active.attemptId !== attemptId || read.state.active.deadlineAt !== deadlineAt ||
      read.state.active.phase !== 'capturing' ||
      (read.state.active.supervisorPid !== undefined && read.state.active.supervisorPid !== supervisorPid)) return false;
    return writeState({
      ...read.state,
      active: { ...read.state.active, supervisorPid },
    });
  });
}

export function completeCutoffCaptureAttempt(
  attemptId: string,
  outcome: Exclude<CutoffCaptureOutcome, 'running'>,
  reason: string,
  nowMs = Date.now(),
): boolean {
  if (!ATTEMPT_RE.test(attemptId) || !Number.isFinite(nowMs) || !/^[a-z0-9-]{1,80}$/.test(reason)) return false;
  return withSchedulerLock(false, () => {
    const read = readCutoffCaptureSchedulerState();
    if (read.sourceState !== 'healthy' || !read.state?.active || read.state.active.attemptId !== attemptId) return false;
    const completedAt = new Date(nowMs).toISOString();
    const state: CutoffCaptureSchedulerState = {
      ...read.state,
      active: null,
      lastSuccessAt: outcome === 'success' ? completedAt : read.state.lastSuccessAt,
      lastFailureAt: outcome === 'failure' ? completedAt : read.state.lastFailureAt,
      nextEligibleAt: new Date(nowMs + (outcome === 'success'
        ? CUTOFF_CAPTURE_SUCCESS_CADENCE_MS
        : outcome === 'failure' ? CUTOFF_CAPTURE_FAILURE_RETRY_MS : 0)).toISOString(),
      lastOutcome: outcome,
      lastReason: reason,
    };
    return writeState(state);
  });
}

export function beginCutoffCaptureCommit(
  attemptId: string,
  deadlineAt: string,
  nowMs = Date.now(),
): boolean {
  if (!ATTEMPT_RE.test(attemptId) || !canonicalTimestamp(deadlineAt) || !Number.isFinite(nowMs) ||
    nowMs >= Date.parse(deadlineAt)) return false;
  return withSchedulerLock(false, () => {
    const read = readCutoffCaptureSchedulerState();
    if (read.sourceState !== 'healthy' || !read.state?.active ||
      read.state.active.attemptId !== attemptId || read.state.active.deadlineAt !== deadlineAt ||
      read.state.active.phase !== 'capturing') return false;
    return writeState({
      ...read.state,
      active: { ...read.state.active, phase: 'committing' },
    });
  });
}

export function cancelCutoffCaptureAttempt(
  attemptId: string,
  nowMs = Date.now(),
  outcome: 'cancelled' | 'failure' = 'cancelled',
  reason = outcome === 'cancelled' ? 'cancelled' : 'timeout',
): 'cancelled' | 'commit-in-progress' | 'not-active' | 'failed' {
  if (!ATTEMPT_RE.test(attemptId) || !Number.isFinite(nowMs) ||
    !/^[a-z0-9-]{1,80}$/.test(reason)) return 'failed';
  return withSchedulerLock<'cancelled' | 'commit-in-progress' | 'not-active' | 'failed'>('failed', () => {
    const read = readCutoffCaptureSchedulerState();
    if (read.sourceState !== 'healthy' || !read.state?.active || read.state.active.attemptId !== attemptId) {
      return 'not-active';
    }
    if (read.state.active.phase === 'committing') return 'commit-in-progress';
    const completedAt = new Date(nowMs).toISOString();
    return writeState({
      ...read.state,
      active: null,
      lastFailureAt: outcome === 'failure' ? completedAt : read.state.lastFailureAt,
      nextEligibleAt: new Date(nowMs + (outcome === 'failure' ? CUTOFF_CAPTURE_FAILURE_RETRY_MS : 0)).toISOString(),
      lastOutcome: outcome,
      lastReason: reason,
    }) ? 'cancelled' : 'failed';
  });
}

function childRuntimeArgs(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]!;
    if (arg.startsWith('--import=') || arg.startsWith('--require=')) args.push(arg);
    else if (arg === '--import' || arg === '--require') {
      const value = process.execArgv[index + 1];
      if (value) args.push(arg, value);
      index += 1;
    }
  }
  return args;
}

export function cutoffCaptureCliInvocation(flag: string, args: readonly string[]): { command: string; args: string[] } {
  const entry = process.argv[1];
  const compiled = !entry || resolve(entry) === resolve(process.execPath);
  return {
    command: process.execPath,
    args: compiled ? [flag, ...args] : [...childRuntimeArgs(), entry, flag, ...args],
  };
}

export function cutoffCaptureChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'ASHLR_HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) continue;
    if ((key === 'HOME' || key === 'ASHLR_HOME') && (!isAbsolute(value) || resolve(value) !== value)) continue;
    env[key] = value;
  }
  return env;
}

function inert(disposition: ScheduledCutoffCapture['disposition'], reason: string): ScheduledCutoffCapture {
  return {
    disposition,
    reason,
    completion: Promise.resolve({ outcome: 'failed', code: null, signal: null }),
    cancel: () => {},
  };
}

export function scheduleCutoffCheckpointCapture(
  options: ScheduleCutoffCaptureOptions = {},
): ScheduledCutoffCapture {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return inert('unsupported', 'platform-unsupported');
  if ((options.deps?.killSwitchOn ?? killSwitchOn)()) return inert('not-due', 'kill-switch');
  if (active) return { ...active, disposition: 'overlap-suppressed', reason: 'process-active' };
  const now = options.deps?.now ?? Date.now;
  const reserve = options.deps?.reserve ?? reserveCutoffCaptureAttempt;
  const complete = options.deps?.complete ?? completeCutoffCaptureAttempt;
  const cancelAttempt = options.deps?.cancelAttempt ?? cancelCutoffCaptureAttempt;
  const attemptReleased = options.deps?.attemptReleased ?? cutoffCaptureAttemptReleased;
  const reservation = reserve(now());
  if (!reservation.reserved) {
    return inert(reservation.reason === 'platform-unsupported' ? 'unsupported' :
      reservation.reason === 'state-degraded' ? 'state-degraded' : 'not-due', reservation.reason);
  }
  if ((options.deps?.killSwitchOn ?? killSwitchOn)()) {
    complete(reservation.attemptId, 'cancelled', 'kill-switch', now());
    return inert('not-due', 'kill-switch');
  }

  const spawnChild = options.deps?.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const invocation = (options.deps?.invocation ?? cutoffCaptureCliInvocation)(
    '--_cutoff-checkpoint-supervisor', [reservation.attemptId, reservation.deadlineAt],
  );
  const scheduleTimeout = options.deps?.setTimeout ?? setTimeout;
  const clearScheduledTimeout = options.deps?.clearTimeout ?? clearTimeout;
  const processKill = options.deps?.processKill ?? ((pid, signal) => { process.kill(pid, signal); });
  let child: ChildHandle;
  try {
    child = spawnChild(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: cutoffCaptureChildEnvironment(),
    });
    child.unref();
  } catch {
    complete(reservation.attemptId, 'failure', 'spawn-failed', now());
    return inert('spawn-failed', 'spawn-failed');
  }

  let settle!: (result: CutoffCaptureChildResult) => void;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let requested: 'timed-out' | 'cancelled' | null = null;
  const completion = new Promise<CutoffCaptureChildResult>((resolve) => { settle = resolve; });
  const finish = (result: CutoffCaptureChildResult): void => {
    if (settled) return;
    settled = true;
    clearScheduledTimeout(timer);
    if (killTimer !== undefined) clearScheduledTimeout(killTimer);
    if (active === scheduled) active = null;
    settle(result);
  };
  const killGroup = (): void => {
    try {
      if (child.pid && child.pid > 0) processKill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  };
  const scheduled: ScheduledCutoffCapture = {
    disposition: 'scheduled',
    reason: 'due',
    completion,
    cancel: () => {
      if (settled || requested) return;
      const cancellation = cancelAttempt(reservation.attemptId, now());
      if (cancellation !== 'cancelled') return;
      requested = 'cancelled';
      killGroup();
      killTimer = scheduleTimeout(() => finish({ outcome: 'cancelled', code: null, signal: null }), KILL_CONFIRM_MS);
    },
  };
  active = scheduled;
  child.once('error', () => {
    complete(reservation.attemptId, 'failure', 'supervisor-error', now());
    finish({ outcome: 'failed', code: null, signal: null });
  });
  child.once('close', (code, signal) => {
    if (requested === 'cancelled') {
      finish({ outcome: 'cancelled', code, signal });
      return;
    }
    const released = attemptReleased(reservation.attemptId);
    if (released) complete(reservation.attemptId, 'success', 'released-before-exit', now());
    if (requested === 'timed-out') {
      if (!released) complete(reservation.attemptId, 'failure', 'timeout', now());
      finish({ outcome: 'timed-out', code, signal });
      return;
    }
    const state = readCutoffCaptureSchedulerState();
    const committed = state.sourceState === 'healthy' && state.state?.active === null &&
      state.state.lastAttemptAt !== null && state.state.lastOutcome === 'success';
    if (!committed) complete(reservation.attemptId, 'failure', 'supervisor-exited', now());
    finish({ outcome: committed && (code === 0 || released) ? 'completed' : 'failed', code, signal });
  });
  const remaining = Math.max(1, Date.parse(reservation.deadlineAt) - now());
  const timer = scheduleTimeout(() => {
    if (settled || requested) return;
    const revocation = cancelAttempt(reservation.attemptId, now(), 'failure', 'timeout');
    // A capturing revocation is already terminal. A committing attempt remains
    // active until close so its signed root can be reconciled after the group dies.
    void revocation;
    requested = 'timed-out';
    killGroup();
  }, remaining);
  return scheduled;
}
