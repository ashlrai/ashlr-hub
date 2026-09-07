import { Worker, type WorkerOptions } from 'node:worker_threads';

export class ReadProjectionError extends Error {
  constructor(message: string, readonly code = 'READ_PROJECTION_UNAVAILABLE') {
    super(message);
    this.name = 'ReadProjectionError';
  }
}

export type ReadProjectionWorkerHandle = Pick<Worker, 'on' | 'postMessage' | 'terminate'>;
export interface BoundedReadWorkerOptions {
  workerEntrypoint(): URL;
  workerData: unknown;
  normalize(kind: unknown, payload: unknown): unknown;
  maxPending?: number;
  timeoutMs?: number;
  _workerFactory?: (url: URL, options: WorkerOptions) => ReadProjectionWorkerHandle;
}
export interface BoundedReadWorker { read(kind: string, payload?: unknown): Promise<unknown>; invalidate(): Promise<void>; close(): Promise<void> }
interface ReadProjectionRequest { type: 'read'; id: number; kind: string; payload?: unknown }
interface PendingProjection {
  id: number;
  key: string;
  request: ReadProjectionRequest;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: ReadProjectionError): void;
  timer: ReturnType<typeof setTimeout>;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ReadProjectionError('Invalid read projection limits', 'READ_PROJECTION_INVALID_REQUEST');
  return value;
}

/** Existing serialized, coalesced read queue shared by fixed dashboard and Universe workers. */
export function createBoundedReadWorker(options: BoundedReadWorkerOptions): BoundedReadWorker {
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
    const created = factory(options.workerEntrypoint(), {
      workerData: options.workerData, execArgv: [],
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

  function read(kind: string, payload?: unknown): Promise<unknown> {
    if (closed) return Promise.reject(new ReadProjectionError('Read projection service is closed', 'READ_PROJECTION_CLOSED'));
    let normalized: unknown;
    try { normalized = options.normalize(kind, payload); }
    catch (error) { return Promise.reject(error); }
    const key = `${kind}:${JSON.stringify(normalized) ?? ''}`;
    const existing = pending.get(key);
    if (existing) return existing.promise;
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
    return promise;
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
