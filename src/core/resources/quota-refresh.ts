/** Explicit foreground metadata collection. Reads never start probes or refresh capture timestamps. */
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from '../universe/artifacts.js';
import { mergeResourceObservations } from './pool-runtime.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import { probeCodexResourceAccount, type CodexResourceProbeOptions, type CodexResourceProbeResult } from './codex-account-probe.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from './quota-refresh-lease.js';

export const RESOURCE_QUOTA_REFRESH_INTERVAL_MS = 30_000;
export const RESOURCE_QUOTA_REFRESH_TTL_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const PROBE_TIMEOUT_MS = 10_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface ResourceQuotaRefreshWorker { workerId: string; accountHint: string; bucketIds: string[] }
export interface ResourceQuotaRefreshConfig { schemaVersion: 1; poolDigest: string; workers: ResourceQuotaRefreshWorker[] }
export type ResourceQuotaRefreshStatus = 'pending' | 'refreshing' | 'observed' | 'failed' | 'timed-out' |
  'cancelled' | 'uncertain' | 'expired' | 'closed';
export interface ResourceQuotaRefreshRow {
  workerId: string;
  status: ResourceQuotaRefreshStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  reason: string;
}
export interface ResourceQuotaRefreshSnapshot {
  schemaVersion: 1;
  scope: 'codex-native-metadata';
  state: 'running' | 'closed';
  sampledAt: string;
  workers: ResourceQuotaRefreshRow[];
}
export interface ResourceQuotaRefresherOptions {
  pool: ResourcePool;
  bindings: ResourceBinding[];
  config: ResourceQuotaRefreshConfig;
  cwd: string;
  signal?: AbortSignal;
  /** Existing foreground lease, owned by the caller; failure closes this collector. */
  assertOwnership?: () => void;
  /** Test-owned inert transport; production callers use the fixed native metadata probe. */
  _probe?: (options: CodexResourceProbeOptions) => Promise<CodexResourceProbeResult>;
}
export interface ResourceQuotaRefresher {
  /** Last actual captured readings only. The caller must also apply unavailableWorkerIds AFTER ledger merge. */
  readObservations(base: ResourceObservation[]): ResourceObservation[];
  /** Ephemeral admission constraint, not a fabricated provider observation or persisted quota measurement. */
  unavailableWorkerIds(): string[];
  snapshot(): ResourceQuotaRefreshSnapshot;
  close(): Promise<void>;
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
function array(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!);
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const nested of Object.values(value)) immutable(nested); Object.freeze(value); }
  return value;
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Account hints are pinned reported metadata, NOT proof of globally unique subscription identity. */
export function validateResourceQuotaRefreshConfig(value: unknown, poolValue: ResourcePool,
  bindingsValue: ResourceBinding[]): ResourceQuotaRefreshConfig {
  const pool = validateResourcePool(poolValue); const bindings = validateResourceBindings(bindingsValue, pool);
  const invalid = (): never => { throw new Error('Invalid resource quota refresh configuration'); };
  if (!object(value) || !exact(value, ['schemaVersion', 'poolDigest', 'workers']) || value.schemaVersion !== 1 ||
    typeof value.poolDigest !== 'string' || !HASH.test(value.poolDigest) || value.poolDigest !== digest(canonical({ pool, bindings })) ||
    !array(value.workers, 1, pool.workers.length)) return invalid();
  const seen = new Set<string>(); const workers: ResourceQuotaRefreshWorker[] = [];
  for (const row of value.workers) {
    if (!object(row) || !exact(row, ['workerId', 'accountHint', 'bucketIds']) || typeof row.workerId !== 'string' ||
      !ID.test(row.workerId) || seen.has(row.workerId) || typeof row.accountHint !== 'string' || !HASH.test(row.accountHint) ||
      !array(row.bucketIds, 1, 4) || row.bucketIds.some((bucket) => typeof bucket !== 'string' || !ID.test(bucket)) ||
      new Set(row.bucketIds).size !== row.bucketIds.length ||
      pool.workers.find((worker) => worker.id === row.workerId)?.provider !== 'codex' ||
      bindings.find((binding) => binding.workerId === row.workerId)?.kind !== 'native-cli') return invalid();
    seen.add(row.workerId);
    workers.push({ workerId: row.workerId, accountHint: row.accountHint, bucketIds: [...row.bucketIds as string[]].sort() });
  }
  const hints = new Map<string, string>(); const byWorker = new Map(workers.map((worker) => [worker.workerId, worker]));
  for (const row of workers) {
    const binding = bindings.find((candidate) => candidate.workerId === row.workerId)!;
    const previousCapacity = hints.get(row.accountHint);
    if (previousCapacity !== undefined && previousCapacity !== binding.capacityKey) return invalid();
    hints.set(row.accountHint, binding.capacityKey);
    for (const alias of bindings.filter((candidate) => candidate.capacityKey === binding.capacityKey)) {
      const enrolled = byWorker.get(alias.workerId);
      if (!enrolled || enrolled.accountHint !== row.accountHint || canonical(enrolled.bucketIds) !== canonical(row.bucketIds)) return invalid();
    }
  }
  return immutable({ schemaVersion: 1, poolDigest: value.poolDigest, workers });
}

interface ManagedWorker {
  config: ResourceQuotaRefreshWorker;
  capacityKey: string;
  status: ResourceQuotaRefreshStatus;
  reason: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptMs: number | null;
  failures: number;
  observation: ResourceObservation | null;
}

function checkedOptions(options: ResourceQuotaRefresherOptions) {
  const pool = validateResourcePool(options.pool); const bindings = validateResourceBindings(options.bindings, pool);
  const config = validateResourceQuotaRefreshConfig(options.config, pool, bindings);
  if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || Buffer.byteLength(options.cwd) > 4096 ||
    [...options.cwd].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    options._probe !== undefined && typeof options._probe !== 'function' ||
    options.assertOwnership !== undefined && typeof options.assertOwnership !== 'function') throw new Error('Invalid resource quota refresh options');
  return { pool, bindings, config, cwd: resolve(options.cwd), probe: options._probe ?? probeCodexResourceAccount,
    signal: options.signal, assertOwnership: options.assertOwnership };
}

/**
 * One caller-owned sequential loop, independent of browser polling. Every alias
 * probes its own configured launcher; a shared hint does not attest the wrapper.
 */
export function createResourceQuotaRefresher(options: ResourceQuotaRefresherOptions): ResourceQuotaRefresher {
  return createRefresher(checkedOptions(options), false).refresher;
}

function createRefresher(options: ReturnType<typeof checkedOptions>, once: boolean): {
  refresher: ResourceQuotaRefresher; completed: Promise<void>;
} {
  const { pool, bindings, config, cwd, probe, signal, assertOwnership } = options;
  const controller = new AbortController();
  let closed = false; let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null; let closing: Promise<void> | null = null;
  let terminationUncertain = false;
  const rows: ManagedWorker[] = config.workers.map((row) => ({ config: row,
    capacityKey: bindings.find((binding) => binding.workerId === row.workerId)!.capacityKey,
    status: 'pending', reason: 'managed-quota-pending', lastAttemptAt: null, lastSuccessAt: null,
    nextAttemptMs: Date.now(), failures: 0, observation: null }));

  function owns(): boolean {
    if (closed) return false;
    try { assertOwnership?.(); return true; }
    catch { void close().catch(() => {}); return false; }
  }

  function unavailableReason(row: ManagedWorker, now: number): string | null {
    if (row.status === 'uncertain') return 'managed-quota-uncertain';
    if (closed) return 'managed-quota-closed';
    if (row.status !== 'observed' && row.status !== 'refreshing') return row.reason;
    const observation = row.observation;
    if (!observation) return 'managed-quota-pending';
    if (Date.parse(observation.observedAt) > now || observation.updatedAt !== undefined && Date.parse(observation.updatedAt) > now) {
      return 'managed-quota-future';
    }
    if (Date.parse(observation.expiresAt) <= now) return 'managed-quota-expired';
    if (observation.health !== 'ready') return 'managed-quota-unavailable';
    // A newer external snapshot may win the conservative timestamp merge. It
    // cannot override a currently captured native refusal in this separate gate.
    const reservePercent = pool.workers.find((worker) => worker.id === row.config.workerId)!.reservePercent;
    if (observation.windows.some((window) => window.usedPercent !== null && window.usedPercent >= 100 - reservePercent)) {
      return 'managed-quota-reserve-reached';
    }
    if (observation.windows.length === 0 || observation.windows.some((window) => window.usedPercent === null ||
      window.resetsAt === null || Date.parse(window.resetsAt) <= now)) return 'managed-quota-unknown';
    return null;
  }

  function checkedObservation(result: CodexResourceProbeResult, row: ManagedWorker, attemptAt: string): ResourceObservation | null {
    if (!object(result) || result.schemaVersion !== 1 || result.scope !== 'codex-native-metadata' ||
      result.workerId !== row.config.workerId || result.poolDigest !== config.poolDigest || result.status !== 'observed' ||
      result.accountHint !== row.config.accountHint || !iso(result.startedAt) || !iso(result.finishedAt) ||
      result.startedAt < attemptAt || result.finishedAt < result.startedAt || Date.parse(result.finishedAt) > Date.now() ||
      result.observation === null) return null;
    try {
      const observation = validateResourceObservations([result.observation], pool)[0]!;
      if (observation.workerId !== row.config.workerId || observation.observedAt !== result.startedAt ||
        observation.updatedAt !== undefined && observation.updatedAt !== result.startedAt ||
        Date.parse(observation.expiresAt) - Date.parse(observation.observedAt) > RESOURCE_QUOTA_REFRESH_TTL_MS) return null;
      return observation;
    } catch { return null; }
  }

  function schedule(): void {
    if (closed || active || timer !== null) return;
    const next = rows.reduce((earliest, row) => Math.min(earliest, row.nextAttemptMs ?? Infinity), Infinity);
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(0, Math.min(MAX_BACKOFF_MS, next - Date.now())));
    timer.unref?.();
  }

  async function refresh(row: ManagedWorker): Promise<void> {
    row.status = 'refreshing'; row.reason = 'managed-quota-refreshing';
    row.lastAttemptAt = new Date().toISOString(); row.nextAttemptMs = null;
    let succeeded = false;
    try {
      if (!owns()) return;
      const result = await probe({ pool, bindings, workerId: row.config.workerId, cwd,
        bucketIds: row.config.bucketIds, expectedAccountHint: row.config.accountHint, timeoutMs: PROBE_TIMEOUT_MS,
        signal: controller.signal });
      // Unconfirmed process ownership is terminal, even if cancellation raced
      // the result. Never start another process or claim a clean owner shutdown.
      if (object(result) && result.status === 'uncertain') {
        terminationUncertain = true; row.status = 'uncertain'; row.reason = 'managed-quota-uncertain';
        void close().catch(() => {}); return;
      }
      if (!owns()) return;
      const observation = checkedObservation(result, row, row.lastAttemptAt);
      if (observation) {
        row.observation = mergeResourceObservations(row.observation ? [row.observation] : [], [observation])[0]!;
        row.status = 'observed'; row.reason = 'managed-quota-observed'; row.lastSuccessAt = result.finishedAt;
        row.failures = 0; succeeded = true;
      } else {
        row.status = object(result) && typeof result.status === 'string' &&
          ['failed', 'timed-out', 'cancelled', 'uncertain'].includes(result.status) ? result.status as ManagedWorker['status'] : 'failed';
        row.reason = `managed-quota-${row.status}`;
      }
    } catch { if (!closed) { row.status = 'failed'; row.reason = 'managed-quota-failed'; } }
    finally {
      if (!closed && !once) {
        if (!succeeded) row.failures = Math.min(5, row.failures + 1);
        const delay = succeeded ? RESOURCE_QUOTA_REFRESH_INTERVAL_MS :
          Math.min(MAX_BACKOFF_MS, RESOURCE_QUOTA_REFRESH_INTERVAL_MS * 2 ** (row.failures - 1));
        row.nextAttemptMs = Math.max(Date.now() + delay, row.observation?.retryAfter === null || !row.observation
          ? 0 : Date.parse(row.observation.retryAfter));
      }
    }
  }

  function pump(): void {
    if (closed || active) return;
    const now = Date.now();
    const row = rows.filter((candidate) => candidate.nextAttemptMs !== null && candidate.nextAttemptMs <= now)
      .sort((left, right) => left.nextAttemptMs! - right.nextAttemptMs!)[0];
    if (!row) { schedule(); return; }
    active = refresh(row).finally(() => { active = null; schedule(); });
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    signal?.removeEventListener('abort', onAbort); controller.abort();
    closing = Promise.resolve(active).then(() => {
      if (terminationUncertain) throw new Error('Resource quota refresh termination unconfirmed');
    });
    return closing;
  }
  function onAbort(): void { void close().catch(() => {}); }
  signal?.addEventListener('abort', onAbort, { once: true });
  let completed = Promise.resolve();
  if (signal?.aborted) void close().catch(() => {});
  else if (once) {
    // Own the complete pass before its first asynchronous probe. Closing during
    // any alias awaits the pass and no timer can schedule a retry afterward.
    active = Promise.resolve().then(async () => {
      for (const row of rows) {
        if (!owns()) break;
        await refresh(row);
      }
    }).finally(() => { active = null; });
    completed = active;
  } else schedule();

  const refresher: ResourceQuotaRefresher = Object.freeze({
    readObservations(base: ResourceObservation[]): ResourceObservation[] {
      owns();
      const incoming = validateResourceObservations(base, pool);
      const observations = rows.flatMap((row) => row.observation ? [row.observation] : []);
      return validateResourceObservations(mergeResourceObservations(incoming, observations), pool);
    },
    unavailableWorkerIds(): string[] {
      owns();
      const now = Date.now(); const unavailable = new Set(rows.filter((row) => unavailableReason(row, now) !== null)
        .map((row) => row.capacityKey));
      return Object.freeze(rows.filter((row) => unavailable.has(row.capacityKey)).map((row) => row.config.workerId)) as string[];
    },
    snapshot(): ResourceQuotaRefreshSnapshot {
      const now = Date.now();
      return immutable({ schemaVersion: 1, scope: 'codex-native-metadata', state: closed ? 'closed' : 'running',
        sampledAt: new Date(now).toISOString(), workers: rows.map((row) => {
          const reason = unavailableReason(row, now);
          return { workerId: row.config.workerId,
            status: row.status === 'uncertain' ? 'uncertain' : closed ? 'closed' : reason === 'managed-quota-expired' ? 'expired' : row.status,
            lastAttemptAt: row.lastAttemptAt, lastSuccessAt: row.lastSuccessAt,
            nextAttemptAt: closed || row.nextAttemptMs === null ? null : new Date(row.nextAttemptMs).toISOString(),
            reason: reason ?? row.reason };
        }) });
    },
    close,
  });
  return { refresher, completed };
}

/** One explicit metadata pass, never a task retry or a resident refresh loop. */
export async function refreshResourceQuotaOnce(options: ResourceQuotaRefresherOptions & {
  observations: ResourceObservation[];
  timeoutMs: number;
  capacityWaitMs?: number;
}): Promise<{ observations: ResourceObservation[]; unavailableWorkerIds: string[] }> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
    throw new Error('Invalid resource quota refresh time budget');
  }
  const capacityWaitMs = options.capacityWaitMs === undefined ? 0 : options.capacityWaitMs;
  if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 0 || capacityWaitMs > 60_000) {
    throw new Error('Invalid resource quota refresh capacity wait budget');
  }
  // Detach and validate every input before creating durable state or contacting
  // a provider. An aborted invocation remains inert even with a missing root.
  const checked = checkedOptions(options);
  const observations = validateResourceObservations(options.observations, checked.pool);
  const unavailable = checked.config.workers.map((row) => row.workerId);
  if (checked.signal?.aborted) return { observations, unavailableWorkerIds: unavailable };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  checked.signal?.addEventListener('abort', cancel, { once: true });
  if (checked.signal?.aborted) cancel();
  const remaining = (): number => {
    const value = Math.floor(timeoutMs - (performance.now() - started));
    if (value < 1) controller.abort();
    return value;
  };
  const timer = setTimeout(cancel, Math.max(1, remaining()));
  let lease: ResourceQuotaRefreshLease | undefined;
  let refresher: ResourceQuotaRefresher | undefined;
  let preservePending = false;
  let result: { observations: ResourceObservation[]; unavailableWorkerIds: string[] } | undefined;
  let failure: Error | undefined;
  try {
    const available = remaining();
    if (available < 1 || controller.signal.aborted) throw new Error();
    lease = await acquireResourceQuotaRefreshLease(checked.cwd, {
      waitMs: Math.min(capacityWaitMs, available), signal: controller.signal,
    });
    if (remaining() < 1 || controller.signal.aborted) result = { observations, unavailableWorkerIds: unavailable };
    else {
      const assertOwnership = (): void => {
        lease!.assertOwnership(); checked.assertOwnership?.();
        if (remaining() < 1 || controller.signal.aborted) throw new Error('Resource quota refresh ended');
      };
      assertOwnership();
      lease.markPending();
      const pass = createRefresher({ ...checked, signal: controller.signal, assertOwnership,
        probe: (probeOptions) => {
          const available = remaining();
          if (available < 1 || controller.signal.aborted) throw new Error('Resource quota refresh ended');
          return checked.probe({ ...probeOptions, timeoutMs: Math.min(PROBE_TIMEOUT_MS, available) });
        } }, true);
      refresher = pass.refresher;
      await pass.completed;
      remaining();
      // Preserve capture-time evidence, not the intentionally closed collector's
      // availability. The caller must recheck freshness after awaited cleanup.
      result = { observations: refresher.readObservations(observations),
        unavailableWorkerIds: refresher.unavailableWorkerIds() };
    }
  } catch {
    failure = new Error('Resource quota refresh could not complete');
  } finally {
    try { await refresher?.close(); }
    catch { preservePending = true; failure = new Error('Resource quota refresh cleanup unconfirmed'); }
    try { lease?.close(preservePending); }
    catch { failure = new Error('Resource quota refresh lease cleanup unconfirmed'); }
    clearTimeout(timer); checked.signal?.removeEventListener('abort', cancel);
  }
  if (failure) throw failure;
  return result!;
}
