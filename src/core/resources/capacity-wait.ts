/** Bounded read-only observation of occupied slots; never reserves or retries worker execution. */
import { isAbsolute, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { resourcePoolStatus, validateResourceTask, validateUnavailableResourceWorkerIds, type ResourceTask } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';

export interface ResourceCapacityEvidence {
  observations: ResourceObservation[];
  unavailableWorkerIds: string[];
}
export interface ResourceCapacityWaitOptions {
  root: string;
  pool: ResourcePool;
  bindings: ResourceBinding[];
  task: ResourceTask;
  waitMs: number;
  signal?: AbortSignal;
  /** The owner must recompute freshness and any invocation-only admission vetoes. */
  readEvidence: () => ResourceCapacityEvidence;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Resource capacity wait cancelled');
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = (aborted: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(new Error('Resource capacity wait cancelled')); else resolve();
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    signal?.addEventListener('abort', abort, { once: true });
    // Also covers a signal that became aborted before listener registration.
    if (signal?.aborted) abort();
  });
}

/**
 * A ready result is only a hint for final atomic admission or exact replay/conflict.
 * A reservation is not evidence that its owner is alive, and is never cleared here.
 */
export async function waitForResourceCapacity(options: ResourceCapacityWaitOptions): Promise<ResourceCapacityEvidence & { ready: boolean }> {
  const started = performance.now();
  const { root, waitMs, signal, readEvidence } = options;
  const pool = validateResourcePool(options.pool);
  const bindings = validateResourceBindings(options.bindings, pool);
  const task = validateResourceTask(options.task);
  if (typeof root !== 'string' || root.length > 4_096 || [...root].some((character) => {
    const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
  }) ||
    !isAbsolute(root) || resolve(root) !== root || root === parse(root).root ||
    !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000 || typeof readEvidence !== 'function' ||
    signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid resource capacity wait');
  const allowed = new Set(task.allowedWorkerIds);
  if ([...allowed].some((id) => !pool.workers.some((worker) => worker.id === id))) {
    throw new Error('Resource task references an unknown worker');
  }
  const deadline = started + waitMs;
  while (true) {
    cancelled(signal);
    const source = readEvidence();
    const observations = validateResourceObservations(source.observations, pool);
    const unavailableWorkerIds = validateUnavailableResourceWorkerIds(source.unavailableWorkerIds, pool);
    const evidence = { observations, unavailableWorkerIds };
    cancelled(signal);
    const status = resourcePoolStatus(root, pool, bindings, observations, unavailableWorkerIds);
    cancelled(signal);
    if (status.attempts.some((receipt) => receipt.id === task.id)) return { ready: true, ...evidence };
    // A zero budget still performs one useful check. Later samples cannot turn
    // an expired bounded wait into renewed permission to contact a worker.
    if (waitMs > 0 && performance.now() >= deadline) return { ready: false, ...evidence };
    if (status.plan.candidates.some((candidate) => allowed.has(candidate.workerId))) return { ready: true, ...evidence };
    const maySettle = status.plan.exclusions.some((exclusion) => {
      if (!allowed.has(exclusion.workerId) || exclusion.reasons.length !== 1 ||
        exclusion.reasons[0] !== 'concurrency-exhausted') return false;
      const capacity = bindings.find((binding) => binding.workerId === exclusion.workerId)!.capacityKey;
      const occupied = status.attempts.filter((receipt) => receipt.capacityKey === capacity);
      return occupied.some((receipt) => receipt.status === 'reserved') &&
        !occupied.some((receipt) => receipt.status === 'uncertain');
    });
    const remaining = deadline - performance.now();
    if (!maySettle || remaining <= 0) return { ready: false, ...evidence };
    await pause(Math.min(250, remaining), signal);
  }
}
