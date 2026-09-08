/** Explicit inventory-only freshness; never starts, loads, or invokes a local model. */
import { performance } from 'node:perf_hooks';
import { normalizeNumericLoopbackOllamaBaseUrl, verifyOllamaModelIdentity } from '../run/ollama-identity.js';
import { canonical, digest } from '../universe/artifacts.js';
import { MAX_RESOURCE_OBSERVATION_AGE_MS, MAX_RESOURCE_POOL_WORKERS, validateResourceObservations,
  validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';

export const RESOURCE_LOCAL_MODEL_REFRESH_TTL_MS = Math.min(60_000, MAX_RESOURCE_OBSERVATION_AGE_MS);
export interface ResourceLocalModelWorker { workerId: string; modelDigest: string }
export interface ResourceLocalModelConfig { schemaVersion: 1; poolDigest: string; workers: ResourceLocalModelWorker[] }
export interface ResourceLocalModelRefreshOptions {
  pool: ResourcePool;
  bindings: ResourceBinding[];
  config: ResourceLocalModelConfig;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface ResourceLocalModelRefreshResult {
  /** Actual successful captures only. Expired captures remain evidence, not availability. */
  observations: ResourceObservation[];
  /** Apply after ordinary ledger merging; old ready rows cannot erase these refusals. */
  unavailableWorkerIds: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function roster(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_RESOURCE_POOL_WORKERS &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!);
}

/** Exact immutable enrollment. The pool digest pins model, policy, and actual endpoint bindings. */
export function validateResourceLocalModelConfig(value: unknown, poolValue: ResourcePool,
  bindingsValue: ResourceBinding[]): ResourceLocalModelConfig {
  const pool = validateResourcePool(poolValue); const bindings = validateResourceBindings(bindingsValue, pool);
  const invalid = (): never => { throw new Error('Invalid resource local model configuration'); };
  if (!object(value) || !exact(value, ['schemaVersion', 'poolDigest', 'workers']) || value.schemaVersion !== 1 ||
    typeof value.poolDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.poolDigest) ||
    value.poolDigest !== digest(canonical({ pool, bindings })) || !roster(value.workers)) return invalid();
  const seen = new Set<string>(); const workers: ResourceLocalModelWorker[] = [];
  for (const row of value.workers) {
    if (!object(row) || !exact(row, ['workerId', 'modelDigest']) || typeof row.workerId !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.workerId) || seen.has(row.workerId) ||
      typeof row.modelDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.modelDigest)) return invalid();
    const worker = pool.workers.find((worker) => worker.id === row.workerId);
    const binding = bindings.find((binding) => binding.workerId === row.workerId);
    if (worker?.provider !== 'local' || binding?.kind !== 'local-chat' ||
      normalizeNumericLoopbackOllamaBaseUrl(binding.endpoint) !== binding.endpoint) return invalid();
    seen.add(row.workerId); workers.push(Object.freeze({ workerId: row.workerId, modelDigest: row.modelDigest }));
  }
  Object.freeze(workers);
  return Object.freeze({ schemaVersion: 1, poolDigest: value.poolDigest, workers });
}

/** One sequential bounded inventory pass. A ready inventory does not attest inference or engineering quality. */
export async function refreshResourceLocalModelsOnce(options: ResourceLocalModelRefreshOptions): Promise<ResourceLocalModelRefreshResult> {
  const started = performance.now(); const { timeoutMs, signal } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 ||
    signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid resource local model refresh budget or signal');
  // Validate and detach every enrollment before the first read, including when
  // already cancelled. Nothing discovers a default endpoint or loads a model.
  const pool = validateResourcePool(options.pool); const bindings = validateResourceBindings(options.bindings, pool);
  const config = validateResourceLocalModelConfig(options.config, pool, bindings);
  const observations: ResourceObservation[] = [];
  const unavailable = new Set(config.workers.map((row) => row.workerId));
  const controller = new AbortController(); const cancel = (): void => controller.abort();
  const remaining = (): number => Math.floor(timeoutMs - (performance.now() - started));
  const result = (): ResourceLocalModelRefreshResult => {
    const now = Date.now();
    for (const row of observations) {
      if (!Number.isSafeInteger(now) || Date.parse(row.observedAt) > now || Date.parse(row.expiresAt) <= now) unavailable.add(row.workerId);
    }
    return Object.freeze({ observations: Object.freeze(observations) as ResourceObservation[],
      unavailableWorkerIds: Object.freeze(config.workers.filter((row) => unavailable.has(row.workerId)).map((row) => row.workerId)) as string[] });
  };
  if (signal?.aborted || remaining() < 1) return result();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(1, remaining()));
  try {
    for (const row of config.workers) {
      const available = remaining();
      if (controller.signal.aborted || available < 1) break;
      const worker = pool.workers.find((worker) => worker.id === row.workerId)!;
      const binding = bindings.find((binding) => binding.workerId === row.workerId)!;
      if (binding.kind !== 'local-chat') break; // Enrollment already enforces this before contact.
      try {
        const verified = await verifyOllamaModelIdentity({ baseUrl: binding.endpoint, model: worker.model,
          expectedDigest: row.modelDigest, timeoutMs: Math.min(5000, available), signal: controller.signal });
        if (controller.signal.aborted || remaining() < 1) break;
        if (!verified.ok || verified.identity.digest !== row.modelDigest) continue;
        const captured = Date.now();
        const observation = validateResourceObservations([{ workerId: row.workerId, health: 'ready', windows: [], retryAfter: null,
          observedAt: new Date(captured).toISOString(), expiresAt: new Date(captured + RESOURCE_LOCAL_MODEL_REFRESH_TTL_MS).toISOString() }], pool)[0]!;
        observations.push(observation); unavailable.delete(row.workerId);
      } catch { /* A refusal/failed read withholds this worker; never retain raw errors or retry it. */ }
    }
  } finally {
    // Await each verifier before returning; abort never detaches an in-flight
    // inventory request. There is no resident timer or on-disk state to reconcile.
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
  return result();
}
