import { Worker, type WorkerOptions } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AshlrConfig, ActivityRollup, Proposal } from '../types.js';
import type { DashboardSnapshotWithSourceQuality } from '../dashboard.js';
import type { PublicDaemonObservation } from '../daemon/public-observation.js';
import type { ControlSnapshot, FleetActivitySnapshot } from './control.js';
import type { CachedFleetStatus } from './fleet-status-cache.js';
import type { listRuns } from '../run/orchestrator.js';
import type { listSwarms } from '../swarm/store.js';

/** Fixed read operations only: there is no caller-selected module, code, or argv. */
export interface ReadProjectionResults {
  snapshot: DashboardSnapshotWithSourceQuality;
  control: ControlSnapshot;
  fleet: CachedFleetStatus;
  pulse: ActivityRollup;
  'fleet-activity': FleetActivitySnapshot;
  proposals: Proposal[];
  runs: ReturnType<typeof listRuns>;
  swarms: ReturnType<typeof listSwarms>;
  'daemon-observation': PublicDaemonObservation;
}

export interface ReadProjectionPayloads {
  snapshot: undefined;
  control: undefined;
  fleet: undefined;
  pulse: { window: '1d' | '7d' | '30d'; project?: string };
  'fleet-activity': undefined;
  proposals: undefined;
  runs: undefined;
  swarms: undefined;
  'daemon-observation': undefined;
}

export type ReadProjectionKind = keyof ReadProjectionResults;
export interface ReadProjectionReader {
  read<K extends ReadProjectionKind>(kind: K, payload?: ReadProjectionPayloads[K]): Promise<ReadProjectionResults[K]>;
  /** Reject pending projections and discard the worker's read caches. */
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

export class ReadProjectionError extends Error {
  constructor(message: string, readonly code = 'READ_PROJECTION_UNAVAILABLE') {
    super(message);
    this.name = 'ReadProjectionError';
  }
}

export type ReadProjectionWorkerHandle = Pick<Worker, 'on' | 'postMessage' | 'terminate'>;

export interface ReadProjectionWorkerOptions {
  /** Includes the active projection and the bounded queue. Default 8, maximum 32. */
  maxPending?: number;
  /** Time from enqueue to result, including queue wait. Default/max 60 seconds. */
  timeoutMs?: number;
  /** Test seam: compiled production always uses the fixed Worker URL below. */
  _workerFactory?: (url: URL, options: WorkerOptions) => ReadProjectionWorkerHandle;
}

export interface ReadProjectionRequest {
  type: 'read';
  id: number;
  kind: ReadProjectionKind;
  payload?: ReadProjectionPayloads[ReadProjectionKind];
}

interface PendingProjection {
  id: number;
  key: string;
  request: ReadProjectionRequest;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: ReadProjectionError): void;
  timer: ReturnType<typeof setTimeout>;
}

const KINDS: ReadonlySet<string> = new Set<ReadProjectionKind>([
  'snapshot', 'control', 'fleet', 'pulse', 'fleet-activity', 'proposals', 'runs', 'swarms', 'daemon-observation',
]);

/** Shared validation keeps even malformed internal messages inside the read allowlist. */
export function normalizeReadProjectionPayload(kind: unknown, payload: unknown): ReadProjectionPayloads[ReadProjectionKind] {
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new ReadProjectionError('Unsupported read projection', 'READ_PROJECTION_INVALID_REQUEST');
  if (kind !== 'pulse') {
    if (payload !== undefined) throw new ReadProjectionError('Read projection does not accept a payload', 'READ_PROJECTION_INVALID_REQUEST');
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReadProjectionError('Pulse requires a valid window', 'READ_PROJECTION_INVALID_REQUEST');
  }
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'window' && key !== 'project') ||
      typeof value.window !== 'string' || !['1d', '7d', '30d'].includes(value.window) ||
      (value.project !== undefined && (typeof value.project !== 'string' || value.project.length > 512 ||
        [...value.project].some((character) => character.charCodeAt(0) < 32)))) {
    throw new ReadProjectionError('Invalid pulse projection options', 'READ_PROJECTION_INVALID_REQUEST');
  }
  return { window: value.window as '1d' | '7d' | '30d', ...(value.project === undefined ? {} : { project: value.project as string }) };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ReadProjectionError('Invalid read projection limits', 'READ_PROJECTION_INVALID_REQUEST');
  return value;
}

function workerEntrypoint(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === 'file:' && moduleUrl.pathname.endsWith('/read-projections.ts')) {
    // `npm run dev` runs the source tree, where sibling .js files do not exist.
    // Register the installed dev-only loader inside the thread before loading
    // our fixed TS entry; inheriting --import tsx does not cover worker imports.
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./read-projection-worker.ts', import.meta.url).href;
    const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`;
    return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
  }
  // npm dist and Bun's sibling compiled shim use the same fixed module name.
  return new URL('./read-projection-worker.js', import.meta.url);
}

/**
 * One lazily-created thread per HTTP server moves existing synchronous reads
 * off its event loop. Read algorithms and their CLI callers remain unchanged.
 * Results are coalesced only while pending; freshness caches belong to callers.
 */
export function createReadProjectionWorker(cfg: AshlrConfig, options: ReadProjectionWorkerOptions = {}): ReadProjectionReader {
  const maxPending = boundedInteger(options.maxPending, 8, 32);
  const timeoutMs = boundedInteger(options.timeoutMs, 60_000, 60_000);
  const factory = options._workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  const pending = new Map<string, PendingProjection>();
  const queue: PendingProjection[] = [];
  let worker: ReadProjectionWorkerHandle | null = null;
  let active: PendingProjection | null = null;
  let sequence = 0;
  let generation = 0;
  let closed = false;
  let stopping: Promise<void> | null = null;

  function remove(job: PendingProjection): void {
    clearTimeout(job.timer);
    pending.delete(job.key);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (active === job) active = null;
  }

  function rejectAll(error: ReadProjectionError): void {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
    queue.length = 0;
    active = null;
  }

  function reset(error: ReadProjectionError): Promise<void> {
    rejectAll(error);
    if (stopping) return stopping;
    const previous = worker;
    worker = null;
    generation++;
    if (!previous) return Promise.resolve();
    // The next thread cannot exist until the previous terminate promise settles.
    const termination = Promise.resolve().then(() => previous.terminate()).then(() => undefined);
    const tracked = termination.then(() => {
      if (stopping === tracked) stopping = null;
      pump();
    }, () => {
      if (stopping === tracked) stopping = null;
      closed = true;
      rejectAll(new ReadProjectionError('Read projection worker could not be stopped'));
    });
    stopping = tracked;
    return tracked;
  }

  function startWorker(): ReadProjectionWorkerHandle {
    const currentGeneration = ++generation;
    const created = factory(workerEntrypoint(), {
      workerData: { cfg }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
    });
    worker = created;
    const current = (): boolean => worker === created && generation === currentGeneration;
    created.on('message', (message: unknown) => {
      if (!current() || !active) return;
      if (!message || typeof message !== 'object') {
        void reset(new ReadProjectionError('Invalid read projection worker response'));
        return;
      }
      const result = message as Record<string, unknown>;
      if (result.type !== 'result' || result.id !== active.id || typeof result.ok !== 'boolean' ||
          (result.ok && (!Object.prototype.hasOwnProperty.call(result, 'value') || result.value === undefined))) {
        void reset(new ReadProjectionError('Invalid read projection worker response'));
        return;
      }
      const job = active;
      remove(job);
      if (result.ok) job.resolve(result.value);
      else job.reject(new ReadProjectionError('Read projection is temporarily unavailable'));
      pump();
    });
    created.on('error', () => { if (current()) void reset(new ReadProjectionError('Read projection worker failed')); });
    created.on('exit', () => { if (current()) void reset(new ReadProjectionError('Read projection worker exited')); });
    return created;
  }

  function pump(): void {
    if (closed || stopping || active || queue.length === 0) return;
    const next = queue.shift()!;
    active = next;
    try {
      const target = worker ?? startWorker();
      target.postMessage(next.request);
    } catch {
      void reset(new ReadProjectionError('Read projection worker could not start'));
    }
  }

  function read<K extends ReadProjectionKind>(kind: K, payload?: ReadProjectionPayloads[K]): Promise<ReadProjectionResults[K]> {
    if (closed) return Promise.reject(new ReadProjectionError('Read projection service is closed', 'READ_PROJECTION_CLOSED'));
    let normalized: ReadProjectionPayloads[ReadProjectionKind];
    try { normalized = normalizeReadProjectionPayload(kind, payload); }
    catch (error) { return Promise.reject(error); }
    const key = `${kind}:${JSON.stringify(normalized) ?? ''}`;
    const existing = pending.get(key);
    if (existing) return existing.promise as Promise<ReadProjectionResults[K]>;
    if (pending.size >= maxPending) return Promise.reject(new ReadProjectionError('Read projection queue is full', 'READ_PROJECTION_BUSY'));
    let resolveJob!: (value: unknown) => void;
    let rejectJob!: (error: ReadProjectionError) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => { resolveJob = resolvePromise; rejectJob = rejectPromise; });
    const id = ++sequence;
    const job: PendingProjection = {
      id, key, promise, resolve: resolveJob, reject: rejectJob,
      request: { type: 'read', id, kind, ...(normalized === undefined ? {} : { payload: normalized }) },
      timer: setTimeout(() => {
        const error = new ReadProjectionError('Read projection timed out', 'READ_PROJECTION_TIMEOUT');
        if (active === job) { void reset(error); return; }
        remove(job);
        job.reject(error);
      }, timeoutMs),
    };
    pending.set(key, job);
    queue.push(job);
    pump();
    return promise as Promise<ReadProjectionResults[K]>;
  }

  return {
    read,
    invalidate: () => reset(new ReadProjectionError('Read projections invalidated by a state change')),
    close: () => {
      closed = true;
      return reset(new ReadProjectionError('Read projection service is closed', 'READ_PROJECTION_CLOSED'));
    },
  };
}
