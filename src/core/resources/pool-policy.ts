/** Pure task admission: no credential lookup, provider contact, reservation or execution. */
export interface ResourceWorker {
  id: string;
  provider: 'codex' | 'claude' | 'local';
  model: string;
  maxConcurrent: number;
  reservePercent: number;
  maxTasksPerWindow: number;
  taskWindowMs: number;
  /** Larger numbers are preferred before measured pressure; this is not a quality score. */
  priority: number;
  /** Explicit bootstrap under operator caps only; known refusal/exhaustion still blocks. */
  allowUnknownQuota?: boolean;
}

export interface ResourcePool { schemaVersion: 1; id: string; workers: ResourceWorker[] }
export interface ResourceQuotaWindow { id: string; usedPercent: number | null; resetsAt: string | null }
export interface ResourceObservation {
  workerId: string;
  observedAt: string;
  expiresAt: string;
  /** Latest partial update; older retained windows keep observedAt/expiresAt conservative. */
  updatedAt?: string;
  /** Transport/worker readiness is distinct from whether quota percentages are known. */
  health: 'ready' | 'unavailable';
  windows: ResourceQuotaWindow[];
  retryAfter: string | null;
}

export interface ResourceTaskReservationCount {
  count: number;
  /** Earliest recheck from the authoritative rolling ledger, not promised capacity. */
  nextEligibleAt: string | null;
}
export interface ResourceAssignmentInput {
  pool: ResourcePool;
  observations: ResourceObservation[];
  allowedWorkerIds: string[];
  /** Sparse maps mean known zero; the caller must obtain a consistent reservation/lease snapshot. */
  activeCounts: Record<string, number>;
  taskReservationCounts: Record<string, ResourceTaskReservationCount>;
  nowMs: number;
}
export type ResourceExclusionReason =
  | 'worker-not-allowed'
  | 'worker-unavailable'
  | 'provider-retry-after'
  | 'observation-missing'
  | 'observation-future'
  | 'observation-stale'
  | 'quota-windows-missing'
  | 'quota-window-unknown'
  | 'quota-window-reset-passed'
  | 'quota-reserve-reached'
  | 'concurrency-exhausted'
  | 'operator-task-cap-reached';
export interface ResourceAssignmentCandidate {
  workerId: string;
  provider: ResourceWorker['provider'];
  model: string;
  priority: number;
  reason: 'eligible' | 'operator-capped-unknown-quota';
  /** Null for unknown quota or local workers; never an estimate or an invented zero. */
  usedPercent: number | null;
  activeCount: number;
  taskReservationCount: number;
  /** Maximum of known quota/usable-percent, active/concurrent, and tasks/task-cap. */
  pressure: number;
}
export interface ResourceAssignmentExclusion {
  workerId: string;
  reasons: ResourceExclusionReason[];
  /** Retry/re-evaluation hint only. Fresh provider evidence may still be required. */
  nextEligibleAt: string | null;
}
export interface ResourceAssignmentPlan {
  schemaVersion: 1;
  poolId: string;
  sampledAt: string;
  selectedWorkerId: string | null;
  candidates: ResourceAssignmentCandidate[];
  exclusions: ResourceAssignmentExclusion[];
  /** Earliest known recheck among exclusions, not a guarantee that any worker opens. */
  nextEligibleAt: string | null;
}

export const MAX_RESOURCE_POOL_WORKERS = 32;
export const MAX_RESOURCE_OBSERVATION_WINDOWS = 8;
export const MAX_RESOURCE_OBSERVATION_AGE_MS = 5 * 60_000;
/** Sticky bounded-inventory denial, not a provider usage measurement. */
export const RESOURCE_OBSERVATION_OVERFLOW = 'hub_observation_overflow';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, low: number, high: number): value is unknown[] {
  return Array.isArray(value) && value.length >= low && value.length <= high &&
    Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => index)
      .every((index) => Object.prototype.hasOwnProperty.call(value, index) &&
        'value' in Object.getOwnPropertyDescriptor(value, index)!);
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function integer(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}
function percent(value: unknown, high = 100): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= high;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
function model(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && value.trim().length > 0 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}

/** Validate and detach the exact policy manifest. No runtime or credential locators are accepted. */
export function validateResourcePool(value: unknown): ResourcePool {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'workers']) || value.schemaVersion !== 1 ||
      !identifier(value.id) || !array(value.workers, 1, MAX_RESOURCE_POOL_WORKERS)) {
    throw new Error('Invalid resource pool: explicit identity and bounded worker roster required');
  }
  const known = new Set<string>(); const workers: ResourceWorker[] = [];
  for (const worker of value.workers) {
    if (!object(worker) || !exact(worker, ['id', 'provider', 'model', 'maxConcurrent', 'reservePercent',
      'maxTasksPerWindow', 'taskWindowMs', 'priority'], ['allowUnknownQuota']) || !identifier(worker.id) ||
      known.has(worker.id) || typeof worker.provider !== 'string' || !['codex', 'claude', 'local'].includes(worker.provider) ||
      !model(worker.model) || !integer(worker.maxConcurrent, 1, 16) || !percent(worker.reservePercent, 99) ||
      !integer(worker.maxTasksPerWindow, 1, 10_000) || !integer(worker.taskWindowMs, 1_000, 604_800_000) ||
      !integer(worker.priority, 0, 100) || (worker.allowUnknownQuota !== undefined && typeof worker.allowUnknownQuota !== 'boolean')) {
      throw new Error('Invalid resource pool: unique workers and finite explicit resource bounds required');
    }
    known.add(worker.id);
    workers.push({ id: worker.id, provider: worker.provider as ResourceWorker['provider'], model: worker.model,
      maxConcurrent: worker.maxConcurrent, reservePercent: worker.reservePercent, maxTasksPerWindow: worker.maxTasksPerWindow,
      taskWindowMs: worker.taskWindowMs, priority: worker.priority,
      ...(worker.allowUnknownQuota === undefined ? {} : { allowUnknownQuota: worker.allowUnknownQuota }) });
  }
  return immutable({ schemaVersion: 1, id: value.id, workers });
}

/** Missing observations are allowed as input, never implicitly interpreted as known capacity. */
export function validateResourceObservations(value: unknown, pool: ResourcePool): ResourceObservation[] {
  const definition = validateResourcePool(pool);
  if (!array(value, 0, MAX_RESOURCE_POOL_WORKERS)) throw new Error('Invalid resource observations: bounded array required');
  const known = new Set(definition.workers.map((worker) => worker.id)); const seen = new Set<string>();
  const observations: ResourceObservation[] = [];
  for (const observation of value) {
    if (!object(observation) || !exact(observation, ['workerId', 'observedAt', 'expiresAt', 'health', 'windows', 'retryAfter'], ['updatedAt']) ||
        !identifier(observation.workerId) || !known.has(observation.workerId) || seen.has(observation.workerId) ||
        !timestamp(observation.observedAt) || !timestamp(observation.expiresAt) || observation.expiresAt <= observation.observedAt ||
        Date.parse(observation.expiresAt) - Date.parse(observation.observedAt) > MAX_RESOURCE_OBSERVATION_AGE_MS ||
        (observation.updatedAt !== undefined && (!timestamp(observation.updatedAt) || observation.updatedAt < observation.observedAt)) ||
        typeof observation.health !== 'string' || !['ready', 'unavailable'].includes(observation.health) ||
        !array(observation.windows, 0, MAX_RESOURCE_OBSERVATION_WINDOWS) ||
        (observation.retryAfter !== null && !timestamp(observation.retryAfter))) {
      throw new Error('Invalid resource observations: unique enrolled identities and canonical time bounds required');
    }
    const windowIds = new Set<string>(); const windows: ResourceQuotaWindow[] = [];
    for (const window of observation.windows) {
      if (!object(window) || !exact(window, ['id', 'usedPercent', 'resetsAt']) || !identifier(window.id) ||
          windowIds.has(window.id) || (window.usedPercent !== null && !percent(window.usedPercent)) ||
          (window.resetsAt !== null && !timestamp(window.resetsAt))) {
        throw new Error('Invalid resource observations: unique bounded quota windows required');
      }
      windowIds.add(window.id); windows.push({ id: window.id, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
    }
    seen.add(observation.workerId); observations.push({ workerId: observation.workerId, observedAt: observation.observedAt,
      expiresAt: observation.expiresAt, health: observation.health as ResourceObservation['health'], windows,
      retryAfter: observation.retryAfter, ...(observation.updatedAt === undefined ? {} : { updatedAt: observation.updatedAt }) });
  }
  return immutable(observations);
}

function validateCounts(value: unknown, known: Set<string>, reservations: false): Record<string, number>;
function validateCounts(value: unknown, known: Set<string>, reservations: true): Record<string, ResourceTaskReservationCount>;
function validateCounts(value: unknown, known: Set<string>, reservations: boolean): Record<string, number | ResourceTaskReservationCount> {
  if (!object(value) || Reflect.ownKeys(value).length > known.size) throw new Error('Invalid resource assignment: bounded count map required');
  const result: Record<string, number | ResourceTaskReservationCount> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !known.has(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) {
      throw new Error('Invalid resource assignment: count map contains an unknown worker');
    }
    const row = value[key];
    if (reservations) {
      if (!object(row) || !exact(row, ['count', 'nextEligibleAt']) || !integer(row.count, 0, Number.MAX_SAFE_INTEGER) ||
          (row.nextEligibleAt !== null && !timestamp(row.nextEligibleAt))) {
        throw new Error('Invalid resource assignment: reservation counts require bounded integers and canonical retry times');
      }
      result[key] = { count: row.count, nextEligibleAt: row.nextEligibleAt };
    } else {
      if (!integer(row, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid resource assignment: active counts require bounded integers');
      result[key] = row;
    }
  }
  return result;
}

/**
 * One task, one decision. The caller must reserve under its store lock and
 * recheck admission before execution; this function neither reserves nor retries.
 * All vendor windows intersect. Reset/expiry creates a refresh requirement, not
 * fresh quota. Known exhaustion/unavailability cannot be erased by stale data.
 */
export function planResourceAssignment(input: ResourceAssignmentInput): ResourceAssignmentPlan {
  if (!object(input) || !exact(input, ['pool', 'observations', 'allowedWorkerIds', 'activeCounts', 'taskReservationCounts', 'nowMs']) ||
      !integer(input.nowMs, 0, Date.parse('9999-12-31T23:59:59.999Z'))) {
    throw new Error('Invalid resource assignment: exact snapshot and bounded current time required');
  }
  const pool = validateResourcePool(input.pool); const observations = validateResourceObservations(input.observations, pool);
  const known = new Set(pool.workers.map((worker) => worker.id));
  if (!array(input.allowedWorkerIds, 0, MAX_RESOURCE_POOL_WORKERS) ||
      input.allowedWorkerIds.some((id) => typeof id !== 'string' || !known.has(id)) ||
      new Set(input.allowedWorkerIds).size !== input.allowedWorkerIds.length) {
    throw new Error('Invalid resource assignment: unique enrolled allowed worker identities required');
  }
  const active = validateCounts(input.activeCounts, known, false);
  const reservations = validateCounts(input.taskReservationCounts, known, true);
  const allowed = new Set(input.allowedWorkerIds); const byId = new Map(observations.map((row) => [row.workerId, row]));
  const candidates: ResourceAssignmentCandidate[] = []; const exclusions: ResourceAssignmentExclusion[] = [];
  const future = (value: string | null): value is string => value !== null && Date.parse(value) > input.nowMs;
  for (const worker of pool.workers) {
    const reasons = new Set<ResourceExclusionReason>(); const retry: string[] = [];
    if (!allowed.has(worker.id)) {
      exclusions.push({ workerId: worker.id, reasons: ['worker-not-allowed'], nextEligibleAt: null }); continue;
    }
    const observed = byId.get(worker.id); const count = active[worker.id] ?? 0;
    const tasks = reservations[worker.id] ?? { count: 0, nextEligibleAt: null };
    if (count >= worker.maxConcurrent) reasons.add('concurrency-exhausted');
    if (tasks.count >= worker.maxTasksPerWindow) {
      reasons.add('operator-task-cap-reached'); if (future(tasks.nextEligibleAt)) retry.push(tasks.nextEligibleAt);
    }
    // Refusal/exhaustion is sticky across stale timestamps. Only a superseding
    // observation can establish recovery; advancing the clock alone never does.
    if (observed?.health === 'unavailable') reasons.add('worker-unavailable');
    if (observed && future(observed.retryAfter)) { reasons.add('provider-retry-after'); retry.push(observed.retryAfter); }
    if (observed && (Date.parse(observed.observedAt) > input.nowMs ||
      observed.updatedAt !== undefined && Date.parse(observed.updatedAt) > input.nowMs)) reasons.add('observation-future');
    let unknown = false; let usedPercent: number | null = null;
    const freshness: ResourceExclusionReason | null = !observed ? 'observation-missing' :
      Date.parse(observed.expiresAt) <= input.nowMs ? 'observation-stale' : null;
    if (worker.provider === 'local') {
      if (freshness) reasons.add(freshness);
    } else {
      if (observed?.windows.some((window) => window.usedPercent !== null && window.usedPercent >= 100 - worker.reservePercent)) {
        reasons.add('quota-reserve-reached');
      }
      const quotaUnknown = new Set<ResourceExclusionReason>();
      if (freshness) quotaUnknown.add(freshness);
      if (!observed || observed.windows.length === 0) quotaUnknown.add('quota-windows-missing');
      for (const window of observed?.windows ?? []) {
        if (window.usedPercent === null || window.resetsAt === null) quotaUnknown.add('quota-window-unknown');
        if (window.resetsAt !== null && Date.parse(window.resetsAt) <= input.nowMs) quotaUnknown.add('quota-window-reset-passed');
      }
      unknown = quotaUnknown.size > 0;
      if (unknown && !worker.allowUnknownQuota) for (const reason of quotaUnknown) reasons.add(reason);
      if (!unknown && observed) usedPercent = Math.max(...observed.windows.map((window) => window.usedPercent!));
    }
    if (reasons.size) {
      exclusions.push({ workerId: worker.id, reasons: [...reasons], nextEligibleAt: retry.sort()[0] ?? null }); continue;
    }
    const pressure = Math.max(count / worker.maxConcurrent, tasks.count / worker.maxTasksPerWindow,
      usedPercent === null ? 0 : usedPercent / (100 - worker.reservePercent));
    candidates.push({ workerId: worker.id, provider: worker.provider, model: worker.model, priority: worker.priority,
      reason: unknown ? 'operator-capped-unknown-quota' : 'eligible', usedPercent, activeCount: count,
      taskReservationCount: tasks.count, pressure });
  }
  candidates.sort((left, right) => right.priority - left.priority || left.pressure - right.pressure ||
    (left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0));
  const retry = exclusions.flatMap((row) => row.nextEligibleAt === null ? [] : [row.nextEligibleAt]).sort();
  return immutable({ schemaVersion: 1, poolId: pool.id, sampledAt: new Date(input.nowMs).toISOString(),
    selectedWorkerId: candidates[0]?.workerId ?? null, candidates, exclusions, nextEligibleAt: retry[0] ?? null });
}
