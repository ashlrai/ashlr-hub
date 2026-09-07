import { createRequire } from 'node:module';
import { isAbsolute, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { validateResourceObservations, validateResourcePool, type ResourceAssignmentExclusion,
  type ResourceObservation, type ResourcePool } from '../resources/pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from '../resources/worker.js';
import type { ResourceConsoleEvidence } from '../resources/console-types.js';
import { createBoundedReadWorker, ReadProjectionError, type BoundedReadWorkerOptions } from './bounded-read-worker.js';
import { degradedResourceConsoleEvidence, validateResourceConsoleResponse } from './resource-console-public.js';

export interface ResourceConsoleReadScope { root: string; pool: ResourcePool; bindings: ResourceBinding[]; observationsFile: string;
  managedWorkerIds?: string[] }
export interface ResourceConsoleManagedRead { observations: ResourceObservation[]; unavailableWorkerIds: string[] }
export interface ResourceConsoleReader { snapshot(managed?: ResourceConsoleManagedRead): Promise<ResourceConsoleEvidence>; close(): Promise<void> }

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_MANAGED_BYTES = 128 * 1024;
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function denseArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype &&
    value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!);
}
function workerIds(value: unknown, known: string[]): value is string[] {
  return denseArray(value, 32) && value.every((id) => typeof id === 'string' && ID.test(id) && known.includes(id)) &&
    new Set(value).size === value.length;
}

/** Reject accessors, prototypes and oversized data before any serialization. */
function boundedPlainData(value: unknown): boolean {
  let nodes = 0; let bytes = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 2_048 || depth > 5 || bytes > MAX_MANAGED_BYTES) return false;
    if (item === null || typeof item === 'boolean') { bytes += 5; return true; }
    if (typeof item === 'number') { bytes += 32; return Number.isFinite(item); }
    if (typeof item === 'string') {
      if (item.length > MAX_MANAGED_BYTES) return false;
      bytes += Buffer.byteLength(item) + 2; return bytes <= MAX_MANAGED_BYTES;
    }
    if (Array.isArray(item)) {
      if (!denseArray(item, 32)) return false;
      bytes += item.length + 2; return item.every((entry) => visit(entry, depth + 1));
    }
    if (!plain(item)) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > 8) return false;
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 64 || !('value' in Object.getOwnPropertyDescriptor(item, key)!)) return false;
      bytes += key.length + 4;
      if (!visit(item[key], depth + 1)) return false;
    }
    return true;
  }
  return visit(value, 0) && bytes <= MAX_MANAGED_BYTES;
}

export function validateResourceConsolePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > 4_096 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) ||
    resolve(value) === parse(value).root) throw new Error('Resource console requires explicit absolute non-root paths');
  return resolve(value);
}

export function validateResourceConsoleReadScope(value: ResourceConsoleReadScope): ResourceConsoleReadScope {
  if (!plain(value) || !exact(value, ['root', 'pool', 'bindings', 'observationsFile'], ['managedWorkerIds'])) {
    throw new Error('Invalid resource console read scope');
  }
  const root = validateResourceConsolePath(value.root); const observationsFile = validateResourceConsolePath(value.observationsFile);
  const pool = validateResourcePool(value.pool); const bindings = validateResourceBindings(value.bindings, pool);
  let managedWorkerIds: string[] | undefined;
  if (value.managedWorkerIds !== undefined) {
    if (!workerIds(value.managedWorkerIds, pool.workers.filter((worker) => worker.provider === 'codex').map((worker) => worker.id)) ||
      !value.managedWorkerIds.length) {
      throw new Error('Invalid managed resource worker scope');
    }
    managedWorkerIds = [...value.managedWorkerIds];
    const selected = new Set(managedWorkerIds);
    const capacities = new Set(bindings.filter((binding) => selected.has(binding.workerId)).map((binding) => binding.capacityKey));
    if (bindings.some((binding) => capacities.has(binding.capacityKey) && !selected.has(binding.workerId))) {
      throw new Error('Invalid managed resource worker scope');
    }
    Object.freeze(managedWorkerIds);
  }
  return Object.freeze({ root, pool, bindings, observationsFile, ...(managedWorkerIds ? { managedWorkerIds } : {}) });
}

export function normalizeResourceConsoleRead(kind: unknown, payload: unknown, scope?: ResourceConsoleReadScope): ResourceConsoleManagedRead | undefined {
  const invalid = (): never => { throw new ReadProjectionError('Invalid resource console read', 'READ_PROJECTION_INVALID_REQUEST'); };
  if (kind !== 'snapshot') return invalid();
  if (!scope?.managedWorkerIds) { if (payload !== undefined) return invalid(); return undefined; }
  // This payload comes only from the owning collector, never browser input.
  // A managed reader without its paired admission gate must fail closed.
  if (!plain(payload) || !exact(payload, ['observations', 'unavailableWorkerIds']) || !boundedPlainData(payload) ||
    !workerIds(payload.unavailableWorkerIds, scope.managedWorkerIds)) return invalid();
  let observations: ResourceObservation[];
  try { observations = validateResourceObservations(payload.observations, scope.pool); } catch { return invalid(); }
  if (observations.some((row) => !scope.managedWorkerIds!.includes(row.workerId))) return invalid();
  const normalized = { observations, unavailableWorkerIds: [...payload.unavailableWorkerIds] };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_MANAGED_BYTES) return invalid();
  Object.freeze(normalized.unavailableWorkerIds);
  return Object.freeze(normalized);
}

/** Current gate for captured managed readings; an owner file cannot refresh them. */
export function unavailableManagedResourceWorkers(scope: ResourceConsoleReadScope, managed: ResourceConsoleManagedRead,
  nowMs: number): string[] {
  const unavailable = new Set(managed.unavailableWorkerIds);
  for (const id of scope.managedWorkerIds ?? []) {
    const row = managed.observations.find((observation) => observation.workerId === id);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !row || row.health !== 'ready' || Date.parse(row.observedAt) > nowMs ||
      row.updatedAt !== undefined && Date.parse(row.updatedAt) > nowMs || Date.parse(row.expiresAt) <= nowMs ||
      !row.windows.length || row.windows.some((window) => window.usedPercent === null ||
        window.resetsAt === null || Date.parse(window.resetsAt) <= nowMs)) unavailable.add(id);
  }
  return [...unavailable];
}

/**
 * Reapply an ephemeral gate to an already validated public sample. This can only
 * remove candidates, never create admission or rewrite recorded source evidence.
 * Shared aliases are withheld together, including aliases absent from the veto.
 */
export function withholdResourceConsoleWorkers(evidence: ResourceConsoleEvidence, unavailableWorkerIds: string[]): ResourceConsoleEvidence {
  if (!workerIds(unavailableWorkerIds, evidence.pool.workers.map((worker) => worker.id))) {
    throw new ReadProjectionError('Invalid managed resource admission gate', 'READ_PROJECTION_INVALID_REQUEST');
  }
  if (!evidence.plan || unavailableWorkerIds.length === 0) return evidence;
  const selected = new Set(unavailableWorkerIds);
  const capacities = new Set(evidence.pool.workers.filter((worker) => selected.has(worker.id)).map((worker) => worker.capacityKey));
  const blocked = new Set(evidence.pool.workers.filter((worker) => capacities.has(worker.capacityKey)).map((worker) => worker.id));
  const candidates = evidence.plan.candidates.filter((candidate) => !blocked.has(candidate.workerId));
  const exclusions: ResourceAssignmentExclusion[] = evidence.pool.workers.flatMap((worker) => {
    const prior = evidence.plan!.exclusions.find((row) => row.workerId === worker.id);
    if (!blocked.has(worker.id)) return prior ? [prior] : [];
    return [{ workerId: worker.id, reasons: prior?.reasons.includes('worker-unavailable')
      ? prior.reasons : [...prior?.reasons ?? [], 'worker-unavailable'], nextEligibleAt: null }];
  });
  const nextEligibleAt = exclusions.flatMap((row) => row.nextEligibleAt ? [row.nextEligibleAt] : []).sort()[0] ?? null;
  return { ...evidence, plan: { ...evidence.plan, candidates, exclusions, selectedWorkerId: candidates[0]?.workerId ?? null, nextEligibleAt } };
}

function workerEntrypoint(): URL {
  if (import.meta.url.endsWith('/resource-console-reads.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./resource-console-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./resource-console-worker.js', import.meta.url);
}

/** Pinned configuration and one private file; browser requests cannot choose paths. */
export function createResourceConsoleReader(options: ResourceConsoleReadScope,
  transportOptions: Pick<BoundedReadWorkerOptions, 'maxPending' | 'timeoutMs' | '_workerFactory'> = {}): ResourceConsoleReader {
  const scope = validateResourceConsoleReadScope(options);
  const transport = createBoundedReadWorker({ ...transportOptions, workerEntrypoint, workerData: scope,
    normalize: (kind, payload) => normalizeResourceConsoleRead(kind, payload, scope), timeoutMs: transportOptions.timeoutMs ?? 30_000 });
  let closed = false;
  return {
    async snapshot(managed) {
      if (closed) throw new ReadProjectionError('Resource console reader is closed', 'READ_PROJECTION_CLOSED');
      try {
        // Pin caller-owned data before queuing and reuse the exact detached
        // capture for the final freshness check after asynchronous worker IO.
        const captured = normalizeResourceConsoleRead('snapshot', managed, scope);
        const value = await transport.read('snapshot', captured);
        if (closed) throw new ReadProjectionError('Resource console reader is closed', 'READ_PROJECTION_CLOSED');
        const evidence = validateResourceConsoleResponse(value, scope.pool, scope.bindings);
        return captured ? withholdResourceConsoleWorkers(evidence, unavailableManagedResourceWorkers(scope, captured, Date.now())) : evidence;
      }
      catch (error) {
        if (closed) throw error;
        return degradedResourceConsoleEvidence(scope.pool, scope.bindings, new Date().toISOString());
      }
    },
    close() { closed = true; return transport.close(); },
  };
}
