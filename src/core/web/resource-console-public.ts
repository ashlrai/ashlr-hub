import { validateResourceObservations, validateResourcePool, type ResourceAssignmentPlan, type ResourcePool } from '../resources/pool-policy.js';
import type { ResourceConsoleEvidence, ResourceConsoleGroup } from '../resources/console-types.js';
import type { ResourceBinding } from '../resources/worker.js';
import type { ResourceTaskReceipt, resourcePoolStatus } from '../resources/pool-runtime.js';
import { buildResourcePerformance, resourceUsageScopeForProvider, validateResourcePerformanceReport,
  validResourceExecutionMeasurement } from '../resources/performance.js';

export const MAX_RESOURCE_CONSOLE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_RESOURCE_CONSOLE_RECENT_ATTEMPTS = 100;
const MAX_ATTEMPTS = 4_096;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const ACTIVE = new Set(['reserved', 'uncertain']);
const STATUSES = ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
const EXCLUSIONS = ['worker-not-allowed', 'worker-unavailable', 'provider-retry-after', 'observation-missing',
  'observation-future', 'observation-stale', 'quota-windows-missing', 'quota-window-unknown',
  'quota-window-reset-passed', 'quota-reserve-reached', 'concurrency-exhausted', 'operator-task-cap-reached'];
type Status = ReturnType<typeof resourcePoolStatus>;
type JsonObject = Record<string, unknown>;

function invalid(): never { throw new Error('Invalid resource console response'); }
function object(value: unknown, keys: string[]): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key) ||
    !('value' in Object.getOwnPropertyDescriptor(value, key)!))) invalid();
}
function array(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1 ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)) invalid();
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function nullableTime(value: unknown): boolean { return value === null || iso(value); }
function safeSum(values: number[]): number | null {
  let total = 0;
  for (const value of values) { total += value; if (!count(total)) return null; }
  return total;
}

function configuration(pool: ResourcePool, bindings: ResourceBinding[]): {
  pool: ResourceConsoleEvidence['pool']; groups: ResourceConsoleGroup[];
} {
  const definition = validateResourcePool(pool);
  if (bindings.length !== definition.workers.length) invalid();
  const mapped = new Map(bindings.map((binding) => [binding.workerId, binding.capacityKey]));
  if (mapped.size !== bindings.length) invalid();
  const workers = definition.workers.map((worker) => {
    const capacityKey = mapped.get(worker.id);
    if (!capacityKey || !ID.test(capacityKey)) invalid();
    return { ...worker, capacityKey };
  });
  const groups: ResourceConsoleGroup[] = [];
  for (const worker of workers) {
    const existing = groups.find((group) => group.capacityKey === worker.capacityKey);
    if (existing) {
      if (existing.maxConcurrent !== worker.maxConcurrent || existing.maxTasksPerWindow !== worker.maxTasksPerWindow ||
        existing.taskWindowMs !== worker.taskWindowMs) invalid();
      existing.workerIds.push(worker.id);
    } else groups.push({ capacityKey: worker.capacityKey, workerIds: [worker.id], maxConcurrent: worker.maxConcurrent,
      maxTasksPerWindow: worker.maxTasksPerWindow, taskWindowMs: worker.taskWindowMs,
      occupiedSlots: null, reservedCount: null, uncertainCount: null, recentTaskCount: null });
  }
  return { pool: { id: definition.id, workers }, groups };
}

/** Fixed unavailable evidence, never raw source errors or a fabricated empty history. */
export function degradedResourceConsoleEvidence(pool: ResourcePool, bindings: ResourceBinding[], sampledAt: string): ResourceConsoleEvidence {
  if (!iso(sampledAt)) invalid();
  return { schemaVersion: 1, mode: 'resource-pool', authority: 'local-evidence', sampledAt, sourceState: 'degraded',
    reasons: ['resource-evidence-unavailable'], ...configuration(pool, bindings), plan: null, observations: [],
    activeAttempts: [], recentAttempts: [], counts: { total: null, active: null, completed: null, failed: null,
      cancelled: null, timedOut: null, uncertain: null, omittedHistory: null },
    usage: { reportedAttempts: null, unknownAttempts: null, reportedInputTokens: null, reportedOutputTokens: null,
      totalInputTokens: null, totalOutputTokens: null, complete: false }, performance: null };
}

function receipt(row: ResourceTaskReceipt): ResourceTaskReceipt {
  return { schemaVersion: 1, id: row.id, taskDigest: row.taskDigest, poolDigest: row.poolDigest,
    workerId: row.workerId, capacityKey: row.capacityKey, status: row.status, startedAt: row.startedAt,
    finishedAt: row.finishedAt, outputDigest: row.outputDigest, inputTokens: row.inputTokens,
    outputTokens: row.outputTokens, reason: row.reason, verifiedAccepted: false,
    ...(row.execution === undefined ? {} : { execution: { ...row.execution } }) };
}

/** Pure projection of one validated ledger sample; no process liveness or provider polling. */
export function projectResourceConsoleEvidence(pool: ResourcePool, bindings: ResourceBinding[], status: Status): ResourceConsoleEvidence {
  const result = degradedResourceConsoleEvidence(pool, bindings, status.plan.sampledAt);
  if (!['missing', 'healthy'].includes(status.sourceState) || status.poolId !== pool.id || status.attempts.length > MAX_ATTEMPTS) invalid();
  const now = Date.parse(result.sampledAt);
  result.sourceState = status.sourceState; result.reasons = [];
  // Copy only the plan's public fields; definition and binding locators never enter the DTO.
  result.plan = { schemaVersion: 1, poolId: status.plan.poolId, sampledAt: status.plan.sampledAt,
    selectedWorkerId: status.plan.selectedWorkerId, nextEligibleAt: status.plan.nextEligibleAt,
    candidates: status.plan.candidates.map((row) => ({ workerId: row.workerId, provider: row.provider, model: row.model,
      priority: row.priority, reason: row.reason, usedPercent: row.usedPercent, activeCount: row.activeCount,
      taskReservationCount: row.taskReservationCount, pressure: row.pressure })),
    exclusions: status.plan.exclusions.map((row) => ({ workerId: row.workerId, reasons: [...row.reasons], nextEligibleAt: row.nextEligibleAt })) };
  result.observations = validateResourceObservations(status.observations, pool);
  const ordered = [...status.attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  result.activeAttempts = ordered.filter((row) => ACTIVE.has(row.status)).map(receipt);
  const terminal = ordered.filter((row) => !ACTIVE.has(row.status));
  result.recentAttempts = terminal.slice(0, MAX_RESOURCE_CONSOLE_RECENT_ATTEMPTS).map(receipt);
  const tally = (state: ResourceTaskReceipt['status']): number => status.attempts.filter((row) => row.status === state).length;
  result.counts = { total: status.attempts.length, active: result.activeAttempts.length, completed: tally('completed'),
    failed: tally('failed'), cancelled: tally('cancelled'), timedOut: tally('timed-out'), uncertain: tally('uncertain'),
    omittedHistory: terminal.length - result.recentAttempts.length };
  for (const group of result.groups) {
    const rows = status.attempts.filter((row) => row.capacityKey === group.capacityKey);
    group.reservedCount = rows.filter((row) => row.status === 'reserved').length;
    group.uncertainCount = rows.filter((row) => row.status === 'uncertain').length;
    group.occupiedSlots = group.reservedCount + group.uncertainCount;
    group.recentTaskCount = rows.filter((row) => Date.parse(row.startedAt) > now - group.taskWindowMs).length;
  }
  const reported = status.attempts.filter((row) => count(row.inputTokens) && count(row.outputTokens));
  const input = safeSum(reported.map((row) => row.inputTokens!));
  const output = safeSum(reported.map((row) => row.outputTokens!));
  const complete = status.attempts.length > 0 && reported.length === status.attempts.length &&
    result.activeAttempts.length === 0 && input !== null && output !== null && count(input + output);
  result.usage = { reportedAttempts: reported.length, unknownAttempts: status.attempts.length - reported.length,
    reportedInputTokens: reported.length ? input : null, reportedOutputTokens: reported.length ? output : null,
    totalInputTokens: complete ? input : null, totalOutputTokens: complete ? output : null, complete };
  result.performance = buildResourcePerformance(pool, status.attempts);
  return result;
}

function validateReceipt(value: unknown, pool: ResourceConsoleEvidence['pool']): asserts value is ResourceTaskReceipt {
  const hasExecution = value !== null && typeof value === 'object' && Object.hasOwn(value, 'execution');
  object(value, ['schemaVersion', 'id', 'taskDigest', 'poolDigest', 'workerId', 'capacityKey', 'status', 'startedAt',
    'finishedAt', 'outputDigest', 'inputTokens', 'outputTokens', 'reason', 'verifiedAccepted', ...(hasExecution ? ['execution'] : [])]);
  const worker = pool.workers.find((row) => row.id === value.workerId);
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID.test(value.id) ||
    !worker || worker.capacityKey !== value.capacityKey || typeof value.status !== 'string' || !STATUSES.includes(value.status) ||
    !iso(value.startedAt) || !nullableTime(value.finishedAt) || typeof value.taskDigest !== 'string' || !HASH.test(value.taskDigest) ||
    typeof value.poolDigest !== 'string' || !HASH.test(value.poolDigest) ||
    !(value.outputDigest === null || typeof value.outputDigest === 'string' && HASH.test(value.outputDigest)) ||
    !((value.inputTokens === null && value.outputTokens === null) ||
      count(value.inputTokens) && count(value.outputTokens) && count(value.inputTokens + value.outputTokens)) ||
    typeof value.reason !== 'string' || !/^[a-z0-9-]{1,120}$/.test(value.reason) || value.verifiedAccepted !== false) invalid();
  if (hasExecution && (!validResourceExecutionMeasurement(value.execution) || value.status === 'reserved' ||
    value.execution.usageScope !== null && (value.inputTokens === null || value.execution.usageScope !== resourceUsageScopeForProvider(worker.provider)))) invalid();
  if (value.status === 'reserved') {
    if (value.finishedAt !== null || value.inputTokens !== null || value.outputDigest !== null) invalid();
  } else if (!iso(value.finishedAt) || value.finishedAt < value.startedAt || value.status === 'completed' && value.outputDigest === null) invalid();
}

function validatePlan(value: unknown, pool: ResourceConsoleEvidence['pool'], sampledAt: string): asserts value is ResourceAssignmentPlan {
  object(value, ['schemaVersion', 'poolId', 'sampledAt', 'selectedWorkerId', 'candidates', 'exclusions', 'nextEligibleAt']);
  if (value.schemaVersion !== 1 || value.poolId !== pool.id || value.sampledAt !== sampledAt || !nullableTime(value.nextEligibleAt)) invalid();
  array(value.candidates, 32); array(value.exclusions, 32);
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    object(candidate, ['workerId', 'provider', 'model', 'priority', 'reason', 'usedPercent', 'activeCount', 'taskReservationCount', 'pressure']);
    const worker = pool.workers.find((row) => row.id === candidate.workerId);
    if (!worker || seen.has(worker.id) || candidate.provider !== worker.provider || candidate.model !== worker.model ||
      candidate.priority !== worker.priority || !['eligible', 'operator-capped-unknown-quota'].includes(candidate.reason as string) ||
      !(candidate.usedPercent === null || typeof candidate.usedPercent === 'number' && Number.isFinite(candidate.usedPercent) &&
        candidate.usedPercent >= 0 && candidate.usedPercent <= 100) || !count(candidate.activeCount, MAX_ATTEMPTS) ||
      !count(candidate.taskReservationCount, MAX_ATTEMPTS) || typeof candidate.pressure !== 'number' ||
      !Number.isFinite(candidate.pressure) || candidate.pressure < 0 || candidate.pressure > MAX_ATTEMPTS) invalid();
    seen.add(worker.id);
  }
  for (const exclusion of value.exclusions) {
    object(exclusion, ['workerId', 'reasons', 'nextEligibleAt']);
    if (typeof exclusion.workerId !== 'string' || !pool.workers.some((worker) => worker.id === exclusion.workerId) ||
      seen.has(exclusion.workerId) || !nullableTime(exclusion.nextEligibleAt)) invalid();
    array(exclusion.reasons, EXCLUSIONS.length);
    if (!exclusion.reasons.length || new Set(exclusion.reasons).size !== exclusion.reasons.length ||
      exclusion.reasons.some((reason) => typeof reason !== 'string' || !EXCLUSIONS.includes(reason))) invalid();
    seen.add(exclusion.workerId);
  }
  if (seen.size !== pool.workers.length || value.selectedWorkerId !==
    ((value.candidates[0] as JsonObject | undefined)?.workerId ?? null)) invalid();
}

/** Strict serialized boundary: no extra fields, raw diagnostics, or unpinned configuration. */
export function validateResourceConsoleResponse(value: unknown, pool: ResourcePool, bindings: ResourceBinding[]): ResourceConsoleEvidence {
  if (typeof value !== 'string' || value.length < 2 || Buffer.byteLength(value, 'utf8') > MAX_RESOURCE_CONSOLE_RESPONSE_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid(); }
  const hasPerformance = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'performance');
  object(parsed, ['schemaVersion', 'mode', 'authority', 'sampledAt', 'sourceState', 'reasons', 'pool', 'groups', 'plan',
    'observations', 'activeAttempts', 'recentAttempts', 'counts', 'usage', ...(hasPerformance ? ['performance'] : [])]);
  if (parsed.schemaVersion !== 1 || parsed.mode !== 'resource-pool' || parsed.authority !== 'local-evidence' ||
    !iso(parsed.sampledAt) || !['missing', 'healthy', 'degraded'].includes(parsed.sourceState as string)) invalid();
  const expected = configuration(pool, bindings);
  if (!equal(parsed.pool, expected.pool)) invalid();
  array(parsed.reasons, 1);
  if (!equal(parsed.reasons, parsed.sourceState === 'degraded' ? ['resource-evidence-unavailable'] : [])) invalid();
  array(parsed.groups, 32);
  if (parsed.groups.length !== expected.groups.length) invalid();
  const groupCounts = ['occupiedSlots', 'reservedCount', 'uncertainCount', 'recentTaskCount'];
  for (const [index, group] of parsed.groups.entries()) {
    object(group, ['capacityKey', 'workerIds', 'maxConcurrent', 'maxTasksPerWindow', 'taskWindowMs', ...groupCounts]);
    const baseline = expected.groups[index]!;
    if (['capacityKey', 'workerIds', 'maxConcurrent', 'maxTasksPerWindow', 'taskWindowMs'].some((key) =>
      !equal(group[key], baseline[key as keyof ResourceConsoleGroup]))) invalid();
    if (groupCounts.some((key) => parsed.sourceState === 'degraded' ? group[key] !== null : !count(group[key], MAX_ATTEMPTS))) invalid();
    if (parsed.sourceState !== 'degraded' && group.occupiedSlots !== Number(group.reservedCount) + Number(group.uncertainCount)) invalid();
  }
  const observations = validateResourceObservations(parsed.observations, pool);
  array(parsed.activeAttempts, MAX_ATTEMPTS); array(parsed.recentAttempts, MAX_RESOURCE_CONSOLE_RECENT_ATTEMPTS);
  const allRows = [...parsed.activeAttempts, ...parsed.recentAttempts];
  for (const row of allRows) validateReceipt(row, expected.pool);
  const rows = allRows as ResourceTaskReceipt[];
  if (new Set(rows.map((row) => row.id)).size !== rows.length ||
    (parsed.activeAttempts as ResourceTaskReceipt[]).some((row) => !ACTIVE.has(row.status)) ||
    (parsed.recentAttempts as ResourceTaskReceipt[]).some((row) => ACTIVE.has(row.status))) invalid();
  const countKeys = ['total', 'active', 'completed', 'failed', 'cancelled', 'timedOut', 'uncertain', 'omittedHistory'];
  object(parsed.counts, countKeys);
  const usageKeys = ['reportedAttempts', 'unknownAttempts', 'reportedInputTokens', 'reportedOutputTokens', 'totalInputTokens', 'totalOutputTokens'];
  object(parsed.usage, [...usageKeys, 'complete']);
  const counts = parsed.counts; const usage = parsed.usage;
  if (parsed.sourceState === 'degraded') {
    if (parsed.plan !== null || observations.length || rows.length || countKeys.some((key) => counts[key] !== null) ||
      usageKeys.some((key) => usage[key] !== null) || usage.complete !== false || hasPerformance && parsed.performance !== null) invalid();
  } else {
    validatePlan(parsed.plan, expected.pool, parsed.sampledAt);
    if (countKeys.some((key) => !count(counts[key], MAX_ATTEMPTS)) ||
      parsed.counts.active !== parsed.activeAttempts.length ||
      parsed.counts.uncertain !== (parsed.activeAttempts as ResourceTaskReceipt[]).filter((row) => row.status === 'uncertain').length ||
      parsed.counts.total !== rows.length + Number(parsed.counts.omittedHistory) ||
      parsed.counts.total !== Number(parsed.counts.active) + Number(parsed.counts.completed) + Number(parsed.counts.failed) +
        Number(parsed.counts.cancelled) + Number(parsed.counts.timedOut)) invalid();
    if (!count(parsed.usage.reportedAttempts, MAX_ATTEMPTS) || !count(parsed.usage.unknownAttempts, MAX_ATTEMPTS) ||
      parsed.usage.reportedAttempts + parsed.usage.unknownAttempts !== parsed.counts.total ||
      parsed.usage.reportedAttempts > Number(counts.total) - Number(counts.active) + Number(counts.uncertain) ||
      typeof parsed.usage.complete !== 'boolean' || usageKeys.slice(2).some((key) => usage[key] !== null && !count(usage[key]))) invalid();
    if (parsed.usage.reportedAttempts === 0 && (parsed.usage.reportedInputTokens !== null || parsed.usage.reportedOutputTokens !== null)) invalid();
    if (parsed.usage.complete) {
      if (!parsed.counts.total || parsed.counts.active || parsed.usage.unknownAttempts ||
        !count(parsed.usage.totalInputTokens) || !count(parsed.usage.totalOutputTokens) ||
        !count(parsed.usage.totalInputTokens + parsed.usage.totalOutputTokens) ||
        parsed.usage.totalInputTokens !== parsed.usage.reportedInputTokens || parsed.usage.totalOutputTokens !== parsed.usage.reportedOutputTokens) invalid();
    } else if (parsed.usage.totalInputTokens !== null || parsed.usage.totalOutputTokens !== null) invalid();
    if (hasPerformance) {
      const performance = validateResourcePerformanceReport(parsed.performance, pool);
      const sum = (key: keyof typeof performance.workers[number]['counts']) => performance.workers.reduce((total, row) => total + row.counts[key], 0);
      if (performance.attempts !== counts.total || sum('reserved') + sum('uncertain') !== counts.active ||
        ['completed', 'failed', 'cancelled', 'timedOut', 'uncertain'].some((key) => sum(key as keyof typeof performance.workers[number]['counts']) !== counts[key]) ||
        performance.workers.reduce((total, row) => total + row.usage.reportedAttempts, 0) !== usage.reportedAttempts ||
        performance.workers.reduce((total, row) => total + row.usage.unknownAttempts, 0) !== usage.unknownAttempts) invalid();
      // The displayed rows can be truncated, but the independent whole-ledger
      // worker and global summaries must still describe the same token evidence.
      const subtotal = (key: 'reportedInputTokens' | 'reportedOutputTokens'): number | null => {
        if (usage.reportedAttempts === 0) return null;
        const reported = performance.workers.filter((row) => row.usage.reportedAttempts > 0);
        if (reported.some((row) => row.usage[key] === null)) return null;
        return safeSum(reported.map((row) => row.usage[key]!));
      };
      const input = subtotal('reportedInputTokens'); const output = subtotal('reportedOutputTokens');
      const complete = Number(counts.total) > 0 && counts.active === 0 && usage.unknownAttempts === 0 &&
        input !== null && output !== null && count(input + output);
      if (usage.reportedInputTokens !== input || usage.reportedOutputTokens !== output || usage.complete !== complete ||
        usage.totalInputTokens !== (complete ? input : null) || usage.totalOutputTokens !== (complete ? output : null)) invalid();
      // When the public history is complete, recompute rather than trusting a
      // second, potentially inconsistent summary of the same included records.
      if (counts.omittedHistory === 0 && !equal(performance, buildResourcePerformance(pool, rows))) invalid();
    }
  }
  return parsed as unknown as ResourceConsoleEvidence;
}

export function serializeResourceConsoleEvidence(value: ResourceConsoleEvidence, pool: ResourcePool, bindings: ResourceBinding[]): string {
  const encoded = JSON.stringify(value);
  validateResourceConsoleResponse(encoded, pool, bindings);
  return encoded;
}
