/** Durable foreground queue. Only this live owner may dispatch or cancel its tasks. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { readResourceJson, resourcePoolStatus, runResourceTask, validateResourceTask,
  type ResourceTask, type ResourceTaskReceipt } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import type { ResourceConsoleOutput, ResourceConsoleTaskInput, ResourceSupervisorJob, ResourceSupervisorSnapshot } from './console-types.js';

export class ResourceSupervisorError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'CAPACITY' | 'UNAVAILABLE' | 'NOT_FOUND', message: string) {
    super(message); this.name = 'ResourceSupervisorError';
  }
}
export const MAX_RESOURCE_SUPERVISOR_JOBS = 256;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['queued', 'dispatching', 'settled', 'cancelled', 'unresolved'];
const OUTCOMES = ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
type DurableJob = Omit<ResourceSupervisorJob, 'cancellable' | 'outputAvailable'> & {
  taskDigest: string; input: ResourceConsoleTaskInput | null;
};
interface DurableState { schemaVersion: 1; scopeDigest: string; paused: boolean; jobs: DurableJob[] }
export interface ResourcePoolSupervisorOptions {
  root: string; pool: ResourcePool; bindings: ResourceBinding[]; workspace: string;
  readObservations(): ResourceObservation[];
  maxParallel?: number; maxQueued?: number; pollIntervalMs?: number; signal?: AbortSignal;
}
export interface ResourcePoolSupervisor {
  snapshot(): ResourceSupervisorSnapshot;
  submit(input: ResourceConsoleTaskInput): ResourceSupervisorJob;
  cancel(id: string): ResourceSupervisorJob;
  setPaused(paused: boolean): ResourceSupervisorSnapshot;
  output(id: string): ResourceConsoleOutput | null;
  close(): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && [...value].every((char) => char.charCodeAt(0) >= 32 &&
      !(char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function limit(value: unknown, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource supervisor limits');
  }
  return Number(value);
}
function detached<T>(value: T): T { return structuredClone(value); }
function entryExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function assertStateHeadroom(next: DurableState): void {
  // Reserve the complete future metadata envelope, not a guessed byte margin.
  // Mutable IDs/reasons are unescaped ASCII bounded at 64/120 characters;
  // canonical ISO dates are at most 27 characters. Every other job field is
  // immutable, or its only future change is to drop the private input. Keeping
  // that input while maximizing all metadata therefore bounds every transition.
  const envelope = { ...next, paused: false, jobs: next.jobs.map((job) => job.input === null ? job : {
    ...job, state: 'dispatching', workerId: 'w'.repeat(64), outcome: 'completed',
    reason: 'r'.repeat(120), updatedAt: '+275760-09-13T00:00:00.000Z',
  }) };
  if (Buffer.byteLength(canonical(envelope) + '\n') > MAX_STATE_BYTES) {
    throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
  }
}

/** Scope is explicit and immutable; no input callback can alter the chosen worker bindings. */
export async function createResourcePoolSupervisor(options: ResourcePoolSupervisorOptions): Promise<ResourcePoolSupervisor> {
  let pool: ResourcePool; let bindings: ResourceBinding[];
  const root = options.root; const workspace = options.workspace;
  const readObservations = options.readObservations; const signal = options.signal;
  const maxParallel = limit(options.maxParallel, 4, 16);
  const maxQueued = limit(options.maxQueued, 64, 64);
  const pollIntervalMs = limit(options.pollIntervalMs, 2000, 60_000, 20);
  const stoppedBeforeStart = () => { if (signal?.aborted) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor startup cancelled'); };
  stoppedBeforeStart();
  try {
    if (process.platform === 'win32' || !path(root) || !path(workspace) ||
      realpathSync(workspace) !== workspace || !lstatSync(workspace).isDirectory() ||
      typeof readObservations !== 'function') throw new Error();
    const nested = relative(workspace, root);
    if (nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)) throw new Error();
    pool = validateResourcePool(options.pool); bindings = validateResourceBindings(options.bindings, pool);
    validateResourceObservations(readObservations(), pool);
    // Read validates an existing ledger but never initializes a missing one.
    resourcePoolStatus(root, pool, bindings, []);
  } catch { throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource supervisor scope or evidence'); }
  const scopeDigest = digest(canonical({ pool, bindings, workspace }));
  const poolDigest = digest(canonical({ pool, bindings }));
  const statePath = join(root, 'resource-console-state.json');
  const instanceId = randomUUID();
  const workerIds = new Set(pool.workers.map((worker) => worker.id));

  function taskInput(value: unknown): ResourceConsoleTaskInput {
    try {
      if (!object(value) || !exact(value, ['id', 'prompt', 'allowedWorkerIds', 'mode', 'timeoutMs', 'maxOutputTokens']) ||
        typeof value.prompt !== 'string' || Buffer.byteLength(value.prompt) > 32 * 1024) throw new Error();
      const ids = value.allowedWorkerIds;
      if (!Array.isArray(ids) || Reflect.ownKeys(ids).length !== ids.length + 1 ||
        !Array.from({ length: ids.length }, (_, index) => index).every((index) =>
          Object.hasOwn(ids, index) && 'value' in Object.getOwnPropertyDescriptor(ids, index)!)) throw new Error();
      const task = validateResourceTask({ ...value, schemaVersion: 1, cwd: workspace });
      if (task.allowedWorkerIds.some((id) => !workerIds.has(id))) throw new Error();
      return { id: task.id, prompt: task.prompt, allowedWorkerIds: task.allowedWorkerIds, mode: task.mode,
        timeoutMs: task.timeoutMs, maxOutputTokens: task.maxOutputTokens };
    } catch { throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource console task'); }
  }
  const taskFor = (input: ResourceConsoleTaskInput): ResourceTask => ({ ...detached(input), schemaVersion: 1, cwd: workspace });
  function decode(value: unknown): DurableState {
    if (!object(value) || !exact(value, ['schemaVersion', 'scopeDigest', 'paused', 'jobs']) || value.schemaVersion !== 1 ||
      value.scopeDigest !== scopeDigest || typeof value.paused !== 'boolean' || !Array.isArray(value.jobs) ||
      value.jobs.length > MAX_RESOURCE_SUPERVISOR_JOBS) throw new Error('Invalid resource supervisor state');
    const ids = new Set<string>();
    for (const row of value.jobs) {
      if (!object(row) || !exact(row, ['id', 'state', 'enqueuedAt', 'updatedAt', 'allowedWorkerIds', 'mode', 'workerId',
        'outcome', 'reason', 'taskDigest', 'input']) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id) ||
        typeof row.state !== 'string' || !STATES.includes(row.state) || !iso(row.enqueuedAt) || !iso(row.updatedAt) ||
        row.updatedAt < row.enqueuedAt || !Array.isArray(row.allowedWorkerIds) || row.allowedWorkerIds.length < 1 ||
        row.allowedWorkerIds.length > 32 || row.allowedWorkerIds.some((id) => typeof id !== 'string' || !workerIds.has(id)) ||
        new Set(row.allowedWorkerIds).size !== row.allowedWorkerIds.length ||
        !['read-only', 'workspace-write'].includes(String(row.mode)) ||
        !(row.workerId === null || typeof row.workerId === 'string' && row.allowedWorkerIds.includes(row.workerId)) ||
        !(row.outcome === null || typeof row.outcome === 'string' && OUTCOMES.includes(row.outcome)) ||
        !(row.reason === null || typeof row.reason === 'string' && /^[a-z0-9-]{1,120}$/.test(row.reason)) ||
        typeof row.taskDigest !== 'string' || !HASH.test(row.taskDigest)) throw new Error('Invalid resource supervisor job');
      if (row.state === 'queued' || row.state === 'dispatching') {
        const input = taskInput(row.input);
        if (input.id !== row.id || input.mode !== row.mode || canonical(input.allowedWorkerIds) !== canonical(row.allowedWorkerIds) ||
          digest(canonical(taskFor(input))) !== row.taskDigest || row.outcome !== null) throw new Error('Invalid queued task identity');
      } else if (row.input !== null) throw new Error('Settled resource task retained private prompt');
      if (row.state === 'settled' && !['completed', 'failed', 'timed-out', 'cancelled'].includes(String(row.outcome))) throw new Error('Invalid settled outcome');
      if (row.state === 'settled' && row.workerId === null) throw new Error('Settled task has no worker');
      if (row.state === 'queued' && row.workerId !== null) throw new Error('Queued task already names a worker');
      if (row.state === 'unresolved' && row.outcome !== null && !['reserved', 'uncertain'].includes(String(row.outcome))) throw new Error('Invalid unresolved outcome');
      if (row.state === 'cancelled' && (row.outcome !== 'cancelled' || row.workerId !== null)) throw new Error('Invalid queued cancellation');
      ids.add(row.id);
    }
    return detached(value as unknown as DurableState);
  }

  stoppedBeforeStart();
  if (!existsSync(root)) {
    if (realpathSync(dirname(root)) !== dirname(root) || !lstatSync(dirname(root)).isDirectory()) {
      throw new ResourceSupervisorError('INVALID_INPUT', 'Resource supervisor store parent unavailable');
    }
    mkdirSync(root, { mode: 0o700 }); fsyncDirectory(dirname(root));
  }
  inspectPrivateDirectory(root);
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor store unavailable');
  }
  stoppedBeforeStart();
  const lock = acquireLocalStoreLock(join(root, '.resource-console.lock'), 100, { anchorPath: root, exactPrivateStorage: true });
  if (!lock) throw new ResourceSupervisorError('CONFLICT', 'Resource supervisor already owned or unavailable');
  let state: DurableState = { schemaVersion: 1, scopeDigest, paused: false, jobs: [] };
  let persistedDigest: string | null = null;
  let error: string | null = null;
  let sourceError: string | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = 0;
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const attemptedAt = new Map<string, number>();
  const dispatched = new Set<string>();
  const outputs = new Map<string, ResourceConsoleOutput>();
  let outputBytes = 0;

  function fault(code: string): void {
    error ??= code;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const owned of active.values()) owned.controller.abort();
  }
  function own(): void {
    if (!ownsLocalStoreLock(lock)) { fault('supervisor-ownership-lost'); throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor ownership lost'); }
  }
  function persist(next: DurableState): void {
    own();
    const temporary = join(root, `.resource-console-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      const before = entryExists(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (before !== persistedDigest) throw new Error('State identity changed');
      const bytes = Buffer.from(canonical(next) + '\n');
      if (bytes.length > MAX_STATE_BYTES) throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let offset = 0;
      while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error('Incomplete state write'); offset += written; }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      own();
      const current = entryExists(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (current !== persistedDigest) throw new Error('State identity changed');
      renameSync(temporary, statePath); fsyncDirectory(root); own();
      state = next; persistedDigest = digest(canonical(next));
    } catch (cause) {
      if (cause instanceof ResourceSupervisorError && cause.code === 'CAPACITY') throw cause;
      fault('supervisor-persistence-unavailable');
      throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor state unavailable');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* Only this exact private temporary file. */ }
    }
  }
  function update(id: string, patch: Partial<DurableJob>): void {
    const next = detached(state); const job = next.jobs.find((row) => row.id === id);
    if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource supervisor job unavailable');
    Object.assign(job, patch, { updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() });
    persist(next);
  }
  function publicJob(job: DurableJob): ResourceSupervisorJob {
    const { taskDigest: _digest, input: _input, ...publicFields } = job;
    return detached({ ...publicFields, cancellable: !closing && !error && (job.state === 'queued' || job.state === 'dispatching' && active.has(job.id)),
      outputAvailable: outputs.has(job.id) });
  }
  function ensureAvailable(): void {
    if (closing || error) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor unavailable');
    own();
  }
  function receiptFor(job: DurableJob, receipts: ResourceTaskReceipt[]): ResourceTaskReceipt | undefined {
    const receipt = receipts.find((row) => row.id === job.id);
    if (receipt && (receipt.taskDigest !== job.taskDigest || receipt.poolDigest !== poolDigest ||
      !job.allowedWorkerIds.includes(receipt.workerId))) throw new ResourceSupervisorError('CONFLICT', 'Task receipt identity mismatch');
    return receipt;
  }
  function settle(job: DurableJob, receipt: ResourceTaskReceipt | undefined, reason: string): void {
    const terminal = receipt && !['reserved', 'uncertain'].includes(receipt.status);
    update(job.id, { state: terminal ? 'settled' : 'unresolved', workerId: receipt?.workerId ?? null,
      outcome: receipt?.status ?? null, reason: receipt?.reason ?? reason, input: null });
  }
  function retainOutput(id: string, text: string): void {
    const bytes = Buffer.from(text); let end = Math.min(bytes.length, MAX_OUTPUT_BYTES);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const retained = bytes.subarray(0, end).toString('utf8');
    while (outputBytes + end > MAX_TOTAL_OUTPUT_BYTES && outputs.size) {
      const first = outputs.keys().next().value!; outputBytes -= Buffer.byteLength(outputs.get(first)!.text); outputs.delete(first);
    }
    outputs.set(id, { id, text: retained, truncated: end < bytes.length, retention: 'this-console-session' }); outputBytes += end;
  }
  function schedule(delay = pollIntervalMs): void {
    if (closing || error) return;
    const at = performance.now() + delay;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => { timer = null; pump(); }, delay);
  }
  function start(job: DurableJob, observations: ResourceObservation[]): void {
    if (!job.input) throw new Error('Queued task input unavailable');
    update(job.id, { state: 'dispatching', reason: 'dispatch-requested', workerId: null });
    // Publish the supervisor's irreversible intent before entering the runtime.
    // A crash anywhere after this point is never recovered by replaying input.
    const controller = new AbortController(); const owned = { controller, promise: Promise.resolve() };
    active.set(job.id, owned);
    dispatched.add(job.id);
    attemptedAt.set(job.id, performance.now());
    const input = taskFor(job.input);
    owned.promise = runResourceTask({ root, pool, bindings, observations, task: input, signal: controller.signal }).then((result) => {
      if (result.replayed || !result.receipt) dispatched.delete(job.id);
      if (!result.receipt) {
        update(job.id, { state: controller.signal.aborted || closing ? 'cancelled' : 'queued',
          outcome: controller.signal.aborted || closing ? 'cancelled' : null, workerId: null,
          input: controller.signal.aborted || closing ? null : job.input, reason: 'no-eligible-capacity' });
      } else {
        const recorded = resourcePoolStatus(root, pool, bindings, []).attempts;
        const receipt = receiptFor(job, recorded);
        if (!receipt || canonical(receipt) !== canonical(result.receipt)) throw new Error('Settlement evidence mismatch');
        settle(job, receipt, 'settlement-unavailable');
        if (receipt.status === 'completed' && !result.replayed && result.output !== null) retainOutput(job.id, result.output);
      }
    }).catch(() => {
      if (error) return;
      try { settle(job, receiptFor(job, resourcePoolStatus(root, pool, bindings, []).attempts), 'dispatch-settlement-unavailable'); }
      catch (cause) {
        if (cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT') {
          dispatched.delete(job.id);
          try { settle(job, undefined, 'task-identity-conflict'); } catch { fault('supervisor-settlement-unavailable'); }
        } else fault('supervisor-settlement-unavailable');
      }
    }).finally(() => { active.delete(job.id); schedule(0); });
    try {
      const reserved = receiptFor(job, resourcePoolStatus(root, pool, bindings, []).attempts);
      if (reserved?.status === 'reserved') update(job.id, { workerId: reserved.workerId });
    } catch (cause) {
      // The attached settlement handler isolates a competing runtime identity.
      if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
    }
  }
  function pump(): void {
    if (closing || error) return;
    try {
      own();
      let observations: ResourceObservation[];
      try { observations = validateResourceObservations(readObservations(), pool); sourceError = null; }
      catch {
        // A quota-file update is not authority to cancel already-admitted work.
        // Keep the queue and controls available, but do not admit more work until
        // the same pinned observation source becomes readable again.
        sourceError = 'supervisor-observations-unavailable'; schedule(); return;
      }
      if (!state.paused) {
        // Oldest-attempt-first remains fair even when one disk transaction takes
        // longer than the configured retry interval. New jobs begin unattempted.
        const jobs = [...state.jobs].sort((left, right) => (attemptedAt.get(left.id) ?? -1) - (attemptedAt.get(right.id) ?? -1));
        for (const job of jobs) {
          if (closing || error || state.paused || active.size >= maxParallel) break;
          if (job.state !== 'queued') continue;
          if (performance.now() - (attemptedAt.get(job.id) ?? -Infinity) < pollIntervalMs) continue;
          const status = resourcePoolStatus(root, pool, bindings, observations);
          let receipt: ResourceTaskReceipt | undefined;
          try { receipt = receiptFor(job, status.attempts); }
          catch (cause) {
            if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
            settle(job, undefined, 'task-identity-conflict'); continue;
          }
          if (receipt) { settle(job, receipt, 'existing-receipt-unresolved'); continue; }
          // Even a denied admission persists new quota evidence in the existing
          // runtime. Recently denied jobs are skipped until their retry interval,
          // so they cannot starve other enrolled workers behind them in the queue.
          start(job, observations);
        }
      }
    } catch { fault('supervisor-evidence-unavailable'); }
    schedule();
  }

  const supervisor: ResourcePoolSupervisor = {
    snapshot() {
      if (!closing && !error) { try { own(); } catch { /* Snapshot reports loss without private diagnostics. */ } }
      return { instanceId, paused: state.paused, closing, error: error ?? sourceError, maxParallel, maxQueued,
        activeCount: active.size, queuedCount: state.jobs.filter((job) => job.state === 'queued').length,
        jobs: state.jobs.map(publicJob) };
    },
    submit(value) {
      ensureAvailable(); const input = taskInput(value); const taskDigest = digest(canonical(taskFor(input)));
      const previous = state.jobs.find((job) => job.id === input.id);
      if (previous) {
        if (previous.taskDigest !== taskDigest) throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
        return publicJob(previous);
      }
      let previousRuntime: ResourceTaskReceipt | undefined;
      try { previousRuntime = resourcePoolStatus(root, pool, bindings, []).attempts.find((row) => row.id === input.id); }
      catch { throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task evidence unavailable'); }
      if (previousRuntime && previousRuntime.taskDigest !== taskDigest) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
      }
      if (state.jobs.length >= MAX_RESOURCE_SUPERVISOR_JOBS || state.jobs.filter((job) => job.state === 'queued').length >= maxQueued) {
        throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor history or queue capacity reached');
      }
      const now = new Date().toISOString();
      const job: DurableJob = { id: input.id, state: 'queued', enqueuedAt: now, updatedAt: now,
        allowedWorkerIds: [...input.allowedWorkerIds], mode: input.mode, workerId: null, outcome: null, reason: null, input, taskDigest };
      const next = { ...detached(state), jobs: [...detached(state.jobs), job] };
      assertStateHeadroom(next); persist(next); schedule(0); return publicJob(job);
    },
    cancel(id) {
      ensureAvailable(); if (typeof id !== 'string' || !ID.test(id)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task id');
      const job = state.jobs.find((row) => row.id === id);
      if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource task unavailable');
      if (job.state === 'queued') update(id, { state: 'cancelled', outcome: 'cancelled', input: null, reason: 'queued-task-cancelled' });
      else if (active.has(id)) { update(id, { reason: 'cancellation-requested' }); active.get(id)!.controller.abort(); }
      else if (job.state === 'dispatching' || job.state === 'unresolved') throw new ResourceSupervisorError('CONFLICT', 'Resource task is not owned by this console');
      return publicJob(state.jobs.find((row) => row.id === id)!);
    },
    setPaused(paused) {
      ensureAvailable(); if (typeof paused !== 'boolean') throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid pause state');
      if (state.paused !== paused) persist({ ...detached(state), paused });
      schedule(0); return supervisor.snapshot();
    },
    output(id) { const value = outputs.get(id); return value ? detached(value) : null; },
    close() {
      if (closePromise) return closePromise;
      closing = true; if (timer) { clearTimeout(timer); timer = null; }
      signal?.removeEventListener('abort', onAbort);
      for (const owned of active.values()) owned.controller.abort();
      closePromise = Promise.allSettled([...active.values()].map((owned) => owned.promise)).then(() => {
        outputs.clear(); outputBytes = 0;
        try {
          if (dispatched.size) {
            const receipts = resourcePoolStatus(root, pool, bindings, []).attempts;
            for (const id of dispatched) {
              const job = state.jobs.find((row) => row.id === id)!; const receipt = receiptFor(job, receipts);
              if (!receipt || ['reserved', 'uncertain'].includes(receipt.status)) error ??= 'supervisor-termination-unconfirmed';
            }
          }
        } catch { error ??= 'supervisor-termination-unconfirmed'; }
        if (!releaseLocalStoreLock(lock)) { fault('supervisor-release-uncertain'); }
        if (error) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor closed with unresolved evidence');
      });
      return closePromise;
    },
  };
  function onAbort(): void { void supervisor.close().catch(() => {}); }
  try {
    stoppedBeforeStart();
    if (entryExists(statePath)) {
      const source = readResourceJson(statePath, MAX_STATE_BYTES); state = decode(source); persistedDigest = digest(canonical(source));
    }
    const receipts = resourcePoolStatus(root, pool, bindings, []).attempts;
    const recovered = detached(state); let changed = persistedDigest === null;
    for (const job of recovered.jobs) {
      if (job.state !== 'dispatching' && job.state !== 'queued') continue;
      let receipt: ResourceTaskReceipt | undefined;
      try { receipt = receiptFor(job, receipts); }
      catch (cause) {
        if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
        Object.assign(job, { state: 'unresolved', workerId: null, outcome: null, reason: 'task-identity-conflict', input: null,
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true; continue;
      }
      if (job.state === 'queued' && !receipt) continue;
      const terminal = receipt && !['reserved', 'uncertain'].includes(receipt.status);
      Object.assign(job, { state: terminal ? 'settled' : 'unresolved', workerId: receipt?.workerId ?? null,
        outcome: receipt?.status ?? null, reason: receipt?.reason ?? 'previous-dispatch-unresolved', input: null,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true;
    }
    stoppedBeforeStart(); if (changed) persist(recovered);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { await supervisor.close(); throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor startup cancelled'); }
    schedule(0); return supervisor;
  } catch (cause) {
    signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer);
    releaseLocalStoreLock(lock);
    if (cause instanceof ResourceSupervisorError) throw cause;
    throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor state unavailable');
  }
}
