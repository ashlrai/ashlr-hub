/** Foreground, explicitly enrolled resource tasks. No daemon or Universe authority is inferred. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { MAX_RESOURCE_OBSERVATION_WINDOWS, RESOURCE_OBSERVATION_OVERFLOW, planResourceAssignment, validateResourceObservations, validateResourcePool,
  type ResourceAssignmentPlan, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { executeResourceWorker, validateResourceBindings, type ResourceBinding, type ResourceWorkerTask } from './worker.js';
import { resourceUsageScopeForProvider, validResourceExecutionDuration, validResourceExecutionMeasurement, type ResourceExecutionMeasurement } from './performance.js';
import { RESOURCE_NATIVE_PROCESS_SIGNALS, validResourceNativeProcessForReceipt, type ResourceNativeProcessDiagnostic } from './native-diagnostics.js';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 4_096;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'cancelled']);

export interface ResourceTask extends ResourceWorkerTask {
  schemaVersion: 1;
  id: string;
  allowedWorkerIds: string[];
}
export interface ResourceTaskReceipt {
  schemaVersion: 1;
  id: string;
  taskDigest: string;
  poolDigest: string;
  workerId: string;
  capacityKey: string;
  status: 'reserved' | 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'uncertain';
  startedAt: string;
  finishedAt: string | null;
  outputDigest: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reason: string;
  verifiedAccepted: false;
  /** Absent on legacy receipts. No wall-clock-derived timing is backfilled. */
  execution?: ResourceExecutionMeasurement;
  /** Optional native invocation facts. Legacy receipts are never reconstructed from current host state. */
  nativeProcess?: ResourceNativeProcessDiagnostic;
}
interface PoolState {
  schemaVersion: 1;
  poolDigest: string;
  observations: ResourceObservation[];
  attempts: ResourceTaskReceipt[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4_096 && [...value].every((character) =>
    character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    isAbsolute(value) && resolve(value) === value && value !== parse(value).root;
}

/** Invocation-only admission vetoes; never part of durable quota or task identity. */
export function validateUnavailableResourceWorkerIds(value: unknown, pool: ResourcePool): string[] {
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1 ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!).every(Boolean)) {
    throw new Error('Invalid unavailable resource workers');
  }
  const ids = Array.from({ length: value.length }, (_, index) => value[index]);
  const known = new Set(pool.workers.map((worker) => worker.id));
  if (ids.some((id) => typeof id !== 'string' || !known.has(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid unavailable resource workers');
  }
  return Object.freeze(ids) as string[];
}

/** Owner-controlled task text; never accepted from a provider response or stored in the ledger. */
export function validateResourceTask(value: unknown): ResourceTask {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'allowedWorkerIds', 'prompt', 'cwd',
    'timeoutMs', 'maxOutputTokens', 'mode']) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID.test(value.id) ||
    !Array.isArray(value.allowedWorkerIds) || !value.allowedWorkerIds.length || value.allowedWorkerIds.length > 32 ||
    !value.allowedWorkerIds.every((id) => typeof id === 'string' && ID.test(id)) ||
    new Set(value.allowedWorkerIds).size !== value.allowedWorkerIds.length ||
    typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.includes('\0') ||
    Buffer.byteLength(value.prompt) > 1_048_576 || !path(value.cwd) ||
    !count(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 900_000 ||
    !count(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 16_384 ||
    typeof value.mode !== 'string' || !['read-only', 'workspace-write'].includes(value.mode)) throw new Error('Invalid resource task');
  return { schemaVersion: 1, id: value.id, allowedWorkerIds: [...value.allowedWorkerIds] as string[],
    prompt: value.prompt, cwd: value.cwd, timeoutMs: value.timeoutMs, maxOutputTokens: value.maxOutputTokens,
    mode: value.mode as ResourceTask['mode'] };
}

/** Bounded descriptor read, private regular file only; no credential-file discovery. */
export function readResourceJson(file: string, maxBytes = 2 * 1024 * 1024): unknown {
  if (!path(file) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STATE_BYTES) {
    throw new Error('Invalid resource file');
  }
  let fd: number | undefined;
  try {
    const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || realpathSync(file) !== file ||
      named.size < 2 || named.size > maxBytes || (named.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && named.uid !== process.getuid()) ||
      !assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: dirname(file) }).ok) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) throw new Error();
    const bytes = Buffer.alloc(named.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error();
    const after = fstatSync(fd); const installed = lstatSync(file);
    if (after.size !== named.size || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs ||
      installed.dev !== named.dev || installed.ino !== named.ino) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('Resource file unavailable, unsafe, oversized, or malformed'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function inspectRoot(root: string, create: boolean): boolean {
  if (process.platform === 'win32' || !path(root)) throw new Error('Resource pools require an explicit canonical POSIX store');
  if (!existsSync(root)) {
    if (!create) return false;
    const parent = dirname(root);
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) throw new Error('Resource store parent unavailable');
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    fsyncDirectory(parent);
  }
  inspectPrivateDirectory(root);
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: root }).ok) throw new Error('Resource store is not private');
  return true;
}

function checkedReceipt(value: unknown, stateDigest: string, bindings: ResourceBinding[], pool: ResourcePool): value is ResourceTaskReceipt {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'taskDigest', 'poolDigest', 'workerId', 'capacityKey',
    'status', 'startedAt', 'finishedAt', 'outputDigest', 'inputTokens', 'outputTokens', 'reason', 'verifiedAccepted',
    ...(Object.hasOwn(value, 'execution') ? ['execution'] : []),
    ...(Object.hasOwn(value, 'nativeProcess') ? ['nativeProcess'] : [])]) ||
    value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID.test(value.id) ||
    typeof value.taskDigest !== 'string' || !HASH.test(value.taskDigest) || value.poolDigest !== stateDigest ||
    !bindings.some((binding) => binding.workerId === value.workerId && binding.capacityKey === value.capacityKey) ||
    typeof value.status !== 'string' || !['reserved', ...TERMINAL, 'uncertain'].includes(value.status) || !iso(value.startedAt) ||
    !(value.finishedAt === null || iso(value.finishedAt) && value.finishedAt >= value.startedAt) ||
    !(value.outputDigest === null || typeof value.outputDigest === 'string' && HASH.test(value.outputDigest)) ||
    !((value.inputTokens === null && value.outputTokens === null) || count(value.inputTokens) && count(value.outputTokens) &&
      count(value.inputTokens + value.outputTokens)) || typeof value.reason !== 'string' || !/^[a-z0-9-]{1,120}$/.test(value.reason) ||
    value.verifiedAccepted !== false || Object.hasOwn(value, 'execution') &&
      (!validResourceExecutionMeasurement(value.execution) || value.status === 'reserved' ||
        value.execution.usageScope !== null && value.inputTokens === null)) return false;
  if (value.status === 'reserved') return value.finishedAt === null && value.outputDigest === null && value.inputTokens === null &&
    !Object.hasOwn(value, 'nativeProcess');
  const worker = pool.workers.find((candidate) => candidate.id === value.workerId);
  if (!worker) return false;
  if (Object.hasOwn(value, 'nativeProcess') && !validResourceNativeProcessForReceipt(value.nativeProcess, value.status, worker.provider)) return false;
  if (value.execution !== undefined && (!validResourceExecutionMeasurement(value.execution) ||
    value.execution.usageScope !== null && value.execution.usageScope !== resourceUsageScopeForProvider(worker.provider))) return false;
  return value.finishedAt !== null && (value.status !== 'completed' || value.outputDigest !== null);
}

function loadState(root: string, pool: ResourcePool, bindings: ResourceBinding[], poolDigest: string): PoolState {
  const file = join(root, 'pool-state.json');
  if (!existsSync(file)) return { schemaVersion: 1, poolDigest, observations: [], attempts: [] };
  const value = readResourceJson(file, MAX_STATE_BYTES);
  if (!object(value) || !exact(value, ['schemaVersion', 'poolDigest', 'observations', 'attempts']) ||
    value.schemaVersion !== 1 || value.poolDigest !== poolDigest || !Array.isArray(value.attempts) ||
    value.attempts.length > MAX_ATTEMPTS || !value.attempts.every((row) => checkedReceipt(row, poolDigest, bindings, pool)) ||
    new Set(value.attempts.map((row) => row.id)).size !== value.attempts.length) throw new Error('Resource ledger invalid or configuration changed');
  return { schemaVersion: 1, poolDigest, observations: validateResourceObservations(value.observations, pool),
    attempts: value.attempts as ResourceTaskReceipt[] };
}

function writeState(root: string, state: PoolState): void {
  const bytes = Buffer.from(canonical(state) + '\n');
  if (bytes.length > MAX_STATE_BYTES) throw new Error('Resource ledger capacity reached');
  const temporary = join(root, `.pool-state-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written < 1) throw new Error('Resource ledger write failed');
      offset += written;
    }
    fsyncSync(fd); closeSync(fd); fd = undefined;
    inspectRoot(root, false);
    renameSync(temporary, join(root, 'pool-state.json'));
    fsyncDirectory(root);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Only this transaction's private temporary file. */ }
  }
}

/** Budget future evidence before contact; never turn settlement into another admission gate. */
function requireSettlementHeadroom(state: PoolState, pool: ResourcePool): void {
  // A nonnegative IEEE-754 value can need 17 significant digits plus the seven
  // characters preceding them at the smallest non-exponential decimal scale.
  // This actual valid sample has that maximal JSON width (24 characters).
  const widestNumber = 1.0000000000000002e-6;
  const widestDate = new Date(8_640_000_000_000_000).toISOString();
  const quotaDate = '9999-12-31T23:59:59.999Z';
  const longestSignal = RESOURCE_NATIVE_PROCESS_SIGNALS.reduce((longest, signal) => signal.length > longest.length ? signal : longest);
  const attempts = state.attempts.map((receipt) => {
    if (receipt.status !== 'reserved') return receipt;
    const provider = pool.workers.find((worker) => worker.id === receipt.workerId)!.provider;
    return { ...receipt, status: 'completed', finishedAt: widestDate, outputDigest: '0'.repeat(64),
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER,
      reason: 'x'.repeat(120), execution: { schemaVersion: 1, scope: 'worker-execution',
        durationMs: widestNumber, usageScope: resourceUsageScopeForProvider(provider) },
      ...(provider === 'local' ? {} : { nativeProcess: { schemaVersion: 1, scope: 'native-process',
        exitCode: null, signal: longestSignal, stderrPresent: false, outputTruncated: false } }) };
  });
  // Other admissions can persist quota refreshes while these tasks run. Reserve
  // the bounded enrollment inventory as well, including native result events.
  // These are byte envelopes, not accepted observations or fabricated receipts.
  const observations = pool.workers.map((worker) => ({ workerId: worker.id, observedAt: quotaDate,
    expiresAt: quotaDate, updatedAt: quotaDate, health: 'unavailable', retryAfter: quotaDate,
    windows: Array.from({ length: MAX_RESOURCE_OBSERVATION_WINDOWS }, (_, index) => ({
      id: String(index).padStart(64, '0'), usedPercent: widestNumber, resetsAt: quotaDate })) }));
  if (Buffer.byteLength(canonical({ ...state, attempts, observations }) + '\n') > MAX_STATE_BYTES) {
    throw new Error('Resource ledger settlement capacity reached');
  }
}

/** Merge validated snapshots; partial/expired refreshes never erase known denials. */
export function mergeResourceObservations(previous: ResourceObservation[], incoming: ResourceObservation[]): ResourceObservation[] {
  const merged = new Map(previous.map((item) => [item.workerId, item]));
  for (const item of incoming) {
    const before = merged.get(item.workerId);
    if (!before) { merged.set(item.workerId, item); continue; }
    const capturedAt = item.updatedAt ?? item.observedAt;
    const previousCapture = before.updatedAt ?? before.observedAt;
    if (capturedAt < previousCapture || capturedAt === previousCapture && canonical(item) === canonical(before)) continue;
    // An incomplete refresh cannot erase a known window or reset an exhausted
    // account into the opt-in unknown-quota path. Only a newer, known reading
    // for that exact window supersedes its previous value. Same-capture events
    // can add denials but cannot clear any existing signal.
    const windows = new Map(item.windows.map((window) => [window.id, window]));
    const fullyFresh = capturedAt > previousCapture && item.observedAt === capturedAt && Date.parse(item.expiresAt) > Date.now();
    let retained = false;
    for (const window of before.windows) {
      const replacement = windows.get(window.id);
      const freshRecovery = fullyFresh &&
        replacement?.usedPercent !== null && replacement?.usedPercent !== undefined &&
        replacement.resetsAt !== null && Date.parse(replacement.resetsAt) > Date.now();
      if (!freshRecovery) {
        if (replacement?.usedPercent !== null && replacement?.usedPercent !== undefined &&
          (window.usedPercent === null || replacement.usedPercent > window.usedPercent)) continue;
        windows.set(window.id, window); retained = true;
      }
    }
    // An evolving bucket inventory can overflow two individually valid snapshots.
    // Persist a bounded, sticky denial instead of an unreadable ledger or silently
    // dropping a limit. Ordinary refresh cannot prove recovery of omitted windows.
    const overflow = windows.size > MAX_RESOURCE_OBSERVATION_WINDOWS || before.windows.some((window) => window.id === RESOURCE_OBSERVATION_OVERFLOW);
    let boundedWindows = [...windows.values()];
    if (overflow) {
      retained = true;
      boundedWindows = boundedWindows.filter((window) => window.id !== RESOURCE_OBSERVATION_OVERFLOW)
        .sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, MAX_RESOURCE_OBSERVATION_WINDOWS - 1);
      boundedWindows.push({ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null });
    }
    const health = overflow || !fullyFresh && before.health === 'unavailable' ? 'unavailable' : item.health;
    merged.set(item.workerId, { ...item, health, windows: boundedWindows, updatedAt: capturedAt,
      observedAt: retained && before.observedAt < item.observedAt ? before.observedAt : item.observedAt,
      expiresAt: retained && before.expiresAt < item.expiresAt ? before.expiresAt : item.expiresAt,
      retryAfter: [before.retryAfter, item.retryAfter].filter((time): time is string => time !== null).sort().at(-1) ?? null });
  }
  return [...merged.values()];
}

function plan(state: PoolState, pool: ResourcePool, bindings: ResourceBinding[], allowedWorkerIds: string[], nowMs: number,
  unavailableWorkerIds: string[]): ResourceAssignmentPlan {
  const activeCounts: Record<string, number> = {};
  const taskReservationCounts: Record<string, { count: number; nextEligibleAt: string | null }> = {};
  // Aliases share all hard denials conservatively until per-model account scope
  // has been proven. Missing an alias observation must never erase a refusal.
  const observations = state.observations.map((row) => ({ ...row, windows: row.windows.map((window) => ({ ...window })) }));
  for (const binding of bindings) {
    const worker = pool.workers.find((row) => row.id === binding.workerId)!;
    const aliases = new Set(bindings.filter((row) => row.capacityKey === binding.capacityKey).map((row) => row.workerId));
    const attempts = state.attempts.filter((row) => row.capacityKey === binding.capacityKey);
    activeCounts[worker.id] = attempts.filter((row) => !TERMINAL.has(row.status)).length;
    const recent = attempts.filter((row) => Date.parse(row.startedAt) > nowMs - worker.taskWindowMs);
    taskReservationCounts[worker.id] = { count: recent.length,
      nextEligibleAt: recent.length ? new Date(Math.min(...recent.map((row) => Date.parse(row.startedAt))) + worker.taskWindowMs).toISOString() : null };
    const shared = state.observations.filter((row) => aliases.has(row.workerId));
    const hard = shared.find((row) => row.health === 'unavailable' || row.windows.some((window) =>
      window.usedPercent !== null && window.usedPercent >= 100 - worker.reservePercent));
    const retryAfter = shared.flatMap((row) => row.retryAfter ? [row.retryAfter] : []).sort().at(-1);
    const failures = attempts.filter((row) => row.status === 'failed' || row.status === 'timed-out');
    const latestFailure = failures.map((row) => Date.parse(row.finishedAt!)).sort((a, b) => b - a)[0];
    const cooldown = latestFailure === undefined ? undefined : new Date(latestFailure + 60_000).toISOString();
    const retry = [retryAfter, cooldown].filter((value): value is string => value !== undefined).sort().at(-1);
    const current = observations.find((row) => row.workerId === worker.id);
    if (hard) {
      const blocked = { ...hard, workerId: worker.id, health: 'unavailable' as const,
        retryAfter: retry ?? hard.retryAfter };
      if (current) Object.assign(current, blocked); else observations.push(blocked);
    } else if (retry && Date.parse(retry) > nowMs) {
      if (current) current.retryAfter = retry;
      else observations.push({ workerId: worker.id, observedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 1_000).toISOString(), health: 'ready', windows: [], retryAfter: retry });
    }
  }
  const unavailable = new Set(unavailableWorkerIds);
  const unavailableCapacities = new Set(bindings.filter((binding) => unavailable.has(binding.workerId)).map((binding) => binding.capacityKey));
  for (const binding of bindings) {
    if (!unavailableCapacities.has(binding.capacityKey)) continue;
    const current = observations.find((row) => row.workerId === binding.workerId);
    if (current) current.health = 'unavailable';
    else observations.push({ workerId: binding.workerId, observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 1_000).toISOString(), health: 'unavailable', windows: [], retryAfter: null });
  }
  // The synthetic health veto exists only in this planning clone. The returned
  // evidence and persisted ledger retain the actual captured observations.
  return planResourceAssignment({ pool, observations, allowedWorkerIds, activeCounts, taskReservationCounts, nowMs });
}

function scope(poolValue: ResourcePool, bindingsValue: ResourceBinding[]): { pool: ResourcePool; bindings: ResourceBinding[]; poolDigest: string } {
  const pool = validateResourcePool(poolValue); const bindings = validateResourceBindings(bindingsValue, pool);
  return { pool, bindings, poolDigest: digest(canonical({ pool, bindings })) };
}

/** Read-only: no directory, lock, observation, or assignment is published. */
export function resourcePoolStatus(root: string, poolValue: ResourcePool, bindingsValue: ResourceBinding[], incoming: ResourceObservation[],
  unavailableWorkerIds: string[] = []) {
  const { pool, bindings, poolDigest } = scope(poolValue, bindingsValue);
  const unavailable = validateUnavailableResourceWorkerIds(unavailableWorkerIds, pool);
  const observed = validateResourceObservations(incoming, pool);
  const exists = inspectRoot(root, false);
  const state = exists ? loadState(root, pool, bindings, poolDigest) : { schemaVersion: 1 as const, poolDigest, observations: [], attempts: [] };
  state.observations = mergeResourceObservations(state.observations, observed);
  return { schemaVersion: 1 as const, sourceState: exists ? 'healthy' as const : 'missing' as const,
    poolId: pool.id, plan: plan(state, pool, bindings, pool.workers.map((row) => row.id), Date.now(), unavailable),
    observations: state.observations, attempts: state.attempts };
}

function transaction<T>(root: string, pool: ResourcePool, bindings: ResourceBinding[], poolDigest: string,
  change: (state: PoolState) => T): T {
  inspectRoot(root, true);
  const lock = acquireLocalStoreLock(join(root, '.pool.lock'), 500);
  if (!lock) throw new Error('Resource store busy or unavailable');
  let outcome: { ok: true; result: T } | { ok: false; error: unknown };
  try {
    const state = loadState(root, pool, bindings, poolDigest);
    const result = change(state);
    state.observations = validateResourceObservations(state.observations, pool);
    if (!ownsLocalStoreLock(lock)) throw new Error('Resource store ownership lost');
    writeState(root, state);
    if (!ownsLocalStoreLock(lock)) throw new Error('Resource store ownership lost');
    outcome = { ok: true, result };
  } catch (error) { outcome = { ok: false, error }; }
  if (!releaseLocalStoreLock(lock)) throw new Error('Resource store release uncertain');
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

export async function runResourceTask(options: { root: string; pool: ResourcePool; bindings: ResourceBinding[];
  observations: ResourceObservation[]; task: ResourceTask; signal?: AbortSignal; unavailableWorkerIds?: string[] }): Promise<{
    receipt: ResourceTaskReceipt | null; plan: ResourceAssignmentPlan | null; replayed: boolean; output: string | null;
  }> {
  const { root, signal } = options;
  const { pool, bindings, poolDigest } = scope(options.pool, options.bindings);
  const unavailable = validateUnavailableResourceWorkerIds(options.unavailableWorkerIds === undefined ? [] : options.unavailableWorkerIds, pool);
  const task = validateResourceTask(options.task);
  if (task.allowedWorkerIds.some((id) => !pool.workers.some((worker) => worker.id === id))) throw new Error('Resource task references an unknown worker');
  if (!path(root)) throw new Error('Invalid resource store');
  const storeWithinTask = relative(task.cwd, root);
  if (task.mode === 'workspace-write' && (storeWithinTask === '' ||
    !storeWithinTask.startsWith(`..${sep}`) && storeWithinTask !== '..' && !isAbsolute(storeWithinTask))) {
    throw new Error('Writable resource task must not contain its accounting store');
  }
  if (realpathSync(task.cwd) !== task.cwd || !lstatSync(task.cwd).isDirectory()) throw new Error('Resource task directory unavailable');
  const incoming = validateResourceObservations(options.observations, pool);
  const taskDigest = digest(canonical(task));
  if (signal?.aborted) throw new Error('Resource task cancelled before reservation');
  const admission = transaction(root, pool, bindings, poolDigest, (state) => {
    state.observations = mergeResourceObservations(state.observations, incoming);
    const previous = state.attempts.find((row) => row.id === task.id);
    if (previous) {
      if (previous.taskDigest !== taskDigest) throw new Error('Resource task identity conflict');
      return { receipt: previous, plan: null, replayed: true };
    }
    const assignment = plan(state, pool, bindings, task.allowedWorkerIds, Date.now(), unavailable);
    if (!assignment.selectedWorkerId) return { receipt: null, plan: assignment, replayed: false };
    if (state.attempts.length >= MAX_ATTEMPTS) throw new Error('Resource ledger capacity reached');
    const binding = bindings.find((row) => row.workerId === assignment.selectedWorkerId)!;
    const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: task.id, taskDigest, poolDigest,
      workerId: binding.workerId, capacityKey: binding.capacityKey, status: 'reserved', startedAt: new Date().toISOString(),
      finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null, reason: 'task-reserved', verifiedAccepted: false };
    state.attempts.push(receipt);
    requireSettlementHeadroom(state, pool);
    return { receipt, plan: assignment, replayed: false };
  });
  if (!admission.receipt || admission.replayed) return { ...admission, output: null };
  const reserved = admission.receipt;
  const worker = pool.workers.find((row) => row.id === reserved.workerId)!;
  const binding = bindings.find((row) => row.workerId === reserved.workerId)!;
  // This interval excludes both durable-store transactions and any supervisor queue.
  // Adapter preparation, execution and cleanup are included; it is not provider latency.
  const executionStarted = performance.now();
  const result = await executeResourceWorker(worker, binding, { prompt: task.prompt, cwd: task.cwd,
    timeoutMs: task.timeoutMs, maxOutputTokens: task.maxOutputTokens, mode: task.mode }, signal);
  const elapsed = performance.now() - executionStarted;
  const finishedAt = new Date(Math.max(Date.now(), Date.parse(reserved.startedAt))).toISOString();
  const knownUsage = count(result.inputTokens) && count(result.outputTokens) && count(result.inputTokens + result.outputTokens);
  const receipt: ResourceTaskReceipt = { ...reserved, status: result.status, finishedAt,
    outputDigest: result.output ? digest(result.output) : null, inputTokens: knownUsage ? result.inputTokens : null,
    outputTokens: knownUsage ? result.outputTokens : null,
    reason: result.reason, ...(result.nativeProcess === undefined ? {} : { nativeProcess: { ...result.nativeProcess } }),
    execution: { schemaVersion: 1, scope: 'worker-execution',
      durationMs: validResourceExecutionDuration(elapsed) ? elapsed : null, usageScope: result.usageScope ?? null } };
  if (!checkedReceipt(receipt, poolDigest, bindings, pool)) throw new Error('Resource worker returned invalid settlement evidence');
  transaction(root, pool, bindings, poolDigest, (state) => {
    const index = state.attempts.findIndex((row) => row.id === reserved.id);
    if (index < 0 || canonical(state.attempts[index]) !== canonical(reserved)) throw new Error('Resource assignment changed before settlement');
    if (result.observation) state.observations = mergeResourceObservations(state.observations,
      validateResourceObservations([result.observation], pool));
    state.attempts[index] = receipt;
  });
  return { ...admission, receipt, output: result.status === 'completed' ? result.output : null };
}
