/** Bounded descriptive measurements, never a quality score or routing policy. */
import { validateResourcePool, type ResourcePool, type ResourceWorker } from './pool-policy.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';

export const MAX_RESOURCE_EXECUTION_DURATION_MS = 86_400_000;
export const RESOURCE_USAGE_SCOPES = ['codex-turn', 'claude-main-loop', 'local-chat-completion'] as const;
export type ResourceUsageScope = typeof RESOURCE_USAGE_SCOPES[number];
export interface ResourceExecutionMeasurement {
  schemaVersion: 1;
  scope: 'worker-execution';
  /** Monotonic adapter invocation through return, including its cleanup; not provider latency. */
  durationMs: number | null;
  /** Meaning of reported counters, not billing or whole-agent-tree consumption. */
  usageScope: ResourceUsageScope | null;
}
export type ResourcePerformanceStatus = Exclude<ResourceTaskReceipt['status'], 'reserved'>;
export interface ResourcePerformanceDuration {
  status: ResourcePerformanceStatus;
  attempts: number;
  samples: number;
  unknownAttempts: number;
  /** Nearest-rank quantiles over measured attempts in this exact terminal status. */
  p50Ms: number | null;
  p95Ms: number | null;
}
export interface ResourcePerformanceUsage {
  reportedAttempts: number;
  unknownAttempts: number;
  reportedInputTokens: number | null;
  reportedOutputTokens: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  complete: boolean;
  /** Null retains legacy/unavailable provenance instead of reinterpreting old counters. */
  scopes: Array<{ scope: ResourceUsageScope | null; attempts: number; reportedAttempts: number }>;
}
export interface ResourceWorkerPerformance {
  workerId: string;
  provider: ResourceWorker['provider'];
  model: string;
  counts: { total: number; reserved: number; completed: number; failed: number; timedOut: number; cancelled: number; uncertain: number };
  usage: ResourcePerformanceUsage;
  durations: ResourcePerformanceDuration[];
}
export interface ResourcePerformanceReport {
  schemaVersion: 1;
  scope: 'recorded-worker-execution';
  comparability: 'unmatched-tasks';
  quality: 'unmeasured';
  poolId: string;
  attempts: number;
  workers: ResourceWorkerPerformance[];
}

const MAX_ATTEMPTS = 4_096;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATUSES: ResourcePerformanceStatus[] = ['completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
const COUNT_KEYS = ['total', 'reserved', 'completed', 'failed', 'timedOut', 'cancelled', 'uncertain'] as const;
const TOKEN_KEYS = ['reportedInputTokens', 'reportedOutputTokens', 'totalInputTokens', 'totalOutputTokens'] as const;
const SCOPES: Array<ResourceUsageScope | null> = [...RESOURCE_USAGE_SCOPES, null];
const PROVIDER_SCOPE: Record<ResourceWorker['provider'], ResourceUsageScope> = {
  codex: 'codex-turn', claude: 'claude-main-loop', local: 'local-chat-completion',
};
export function resourceUsageScopeForProvider(provider: ResourceWorker['provider']): ResourceUsageScope {
  return PROVIDER_SCOPE[provider];
}
function invalid(): never { throw new Error('Invalid resource performance evidence'); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
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
export function validResourceExecutionDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RESOURCE_EXECUTION_DURATION_MS;
}
export function validResourceExecutionMeasurement(value: unknown): value is ResourceExecutionMeasurement {
  try {
    object(value, ['schemaVersion', 'scope', 'durationMs', 'usageScope']);
    return value.schemaVersion === 1 && value.scope === 'worker-execution' &&
      (value.durationMs === null || validResourceExecutionDuration(value.durationMs)) &&
      (value.usageScope === null || RESOURCE_USAGE_SCOPES.some((scope) => scope === value.usageScope));
  } catch { return false; }
}
function safeSum(values: number[]): number | null {
  let total = 0;
  for (const value of values) { total += value; if (!count(total)) return null; }
  return total;
}
function quantile(values: number[], percentile: number): number | null {
  return values.length ? values[Math.ceil(values.length * percentile) - 1]! : null;
}
function summarize(worker: ResourceWorker, rows: readonly ResourceTaskReceipt[]): ResourceWorkerPerformance {
  const tally = (status: ResourceTaskReceipt['status']) => rows.filter((row) => row.status === status).length;
  const reported = rows.filter((row) => row.inputTokens !== null && row.outputTokens !== null);
  const input = safeSum(reported.map((row) => row.inputTokens!));
  const output = safeSum(reported.map((row) => row.outputTokens!));
  const complete = rows.length > 0 && reported.length === rows.length && !tally('reserved') && !tally('uncertain') &&
    input !== null && output !== null && count(input + output);
  return { workerId: worker.id, provider: worker.provider, model: worker.model,
    counts: { total: rows.length, reserved: tally('reserved'), completed: tally('completed'), failed: tally('failed'),
      timedOut: tally('timed-out'), cancelled: tally('cancelled'), uncertain: tally('uncertain') },
    usage: { reportedAttempts: reported.length, unknownAttempts: rows.length - reported.length,
      reportedInputTokens: reported.length ? input : null, reportedOutputTokens: reported.length ? output : null,
      totalInputTokens: complete ? input : null, totalOutputTokens: complete ? output : null, complete,
      scopes: SCOPES.flatMap((scope) => {
        const scoped = rows.filter((row) => (row.execution?.usageScope ?? null) === scope);
        return scoped.length ? [{ scope, attempts: scoped.length, reportedAttempts: scoped.filter((row) => row.inputTokens !== null).length }] : [];
      }) },
    durations: STATUSES.map((status) => {
      const scoped = rows.filter((row) => row.status === status);
      const values = scoped.flatMap((row) => row.execution?.durationMs === undefined || row.execution.durationMs === null ? [] : [row.execution.durationMs])
        .sort((a, b) => a - b);
      return { status, attempts: scoped.length, samples: values.length, unknownAttempts: scoped.length - values.length,
        p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) };
    }) };
}

/** Inputs are one validated ledger scope. Never infer missing measurements from wall-clock timestamps. */
export function buildResourcePerformance(poolValue: ResourcePool, attempts: readonly ResourceTaskReceipt[]): ResourcePerformanceReport {
  const pool = validateResourcePool(poolValue);
  array(attempts, MAX_ATTEMPTS);
  const seen = new Set<string>(); const identities = new Set<string>();
  for (const row of attempts) {
    const worker = pool.workers.find((candidate) => candidate.id === row?.workerId);
    if (!worker || typeof row.id !== 'string' || !ID.test(row.id) || seen.has(row.id) ||
      !['reserved', ...STATUSES].includes(row.status) ||
      !((row.inputTokens === null && row.outputTokens === null) || count(row.inputTokens) && count(row.outputTokens) && count(row.inputTokens + row.outputTokens)) ||
      row.execution !== undefined && (!validResourceExecutionMeasurement(row.execution) || row.status === 'reserved' ||
        row.execution.usageScope !== null && (row.execution.usageScope !== PROVIDER_SCOPE[worker.provider] || row.inputTokens === null))) invalid();
    if (row.status === 'reserved' && row.inputTokens !== null) invalid();
    seen.add(row.id); identities.add(row.poolDigest);
  }
  if (identities.size > 1) invalid();
  return { schemaVersion: 1, scope: 'recorded-worker-execution', comparability: 'unmatched-tasks', quality: 'unmeasured',
    poolId: pool.id, attempts: attempts.length, workers: pool.workers.map((worker) => summarize(worker, attempts.filter((row) => row.workerId === worker.id))) };
}

/** Strict public transport validation. This validates shape/consistency, not independent authenticity. */
export function validateResourcePerformanceReport(value: unknown, poolValue: ResourcePool): ResourcePerformanceReport {
  const pool = validateResourcePool(poolValue);
  object(value, ['schemaVersion', 'scope', 'comparability', 'quality', 'poolId', 'attempts', 'workers']);
  if (value.schemaVersion !== 1 || value.scope !== 'recorded-worker-execution' || value.comparability !== 'unmatched-tasks' ||
    value.quality !== 'unmeasured' || value.poolId !== pool.id || !count(value.attempts, MAX_ATTEMPTS)) invalid();
  array(value.workers, 32);
  if (value.workers.length !== pool.workers.length) invalid();
  let total = 0;
  for (const [index, row] of value.workers.entries()) {
    const worker = pool.workers[index]!;
    object(row, ['workerId', 'provider', 'model', 'counts', 'usage', 'durations']);
    if (row.workerId !== worker.id || row.provider !== worker.provider || row.model !== worker.model) invalid();
    object(row.counts, COUNT_KEYS);
    const countValues = row.counts;
    if (COUNT_KEYS.some((key) => !count(countValues[key], MAX_ATTEMPTS))) invalid();
    const counts = row.counts as ResourceWorkerPerformance['counts'];
    if (counts.total !== counts.reserved + counts.completed + counts.failed + counts.timedOut + counts.cancelled + counts.uncertain) invalid();
    total += counts.total;
    object(row.usage, ['reportedAttempts', 'unknownAttempts', ...TOKEN_KEYS, 'complete', 'scopes']);
    const usage = row.usage;
    if (!count(usage.reportedAttempts, counts.total - counts.reserved) || !count(usage.unknownAttempts, counts.total) ||
      usage.reportedAttempts + usage.unknownAttempts !== counts.total || typeof usage.complete !== 'boolean' ||
      TOKEN_KEYS.some((key) => usage[key] !== null && !count(usage[key]))) invalid();
    if (usage.reportedAttempts === 0 && (usage.reportedInputTokens !== null || usage.reportedOutputTokens !== null)) invalid();
    const complete = counts.total > 0 && counts.reserved === 0 && counts.uncertain === 0 && usage.unknownAttempts === 0 &&
      count(usage.reportedInputTokens) && count(usage.reportedOutputTokens) && count(usage.reportedInputTokens + usage.reportedOutputTokens);
    if (usage.complete !== complete) invalid();
    if (usage.complete) {
      if (!counts.total || counts.reserved || counts.uncertain || usage.unknownAttempts ||
        !count(usage.totalInputTokens) || !count(usage.totalOutputTokens) || !count(usage.totalInputTokens + usage.totalOutputTokens) ||
        usage.totalInputTokens !== usage.reportedInputTokens || usage.totalOutputTokens !== usage.reportedOutputTokens) invalid();
    } else if (usage.totalInputTokens !== null || usage.totalOutputTokens !== null) invalid();
    array(usage.scopes, SCOPES.length);
    let last = -1; let scoped = 0; let reported = 0;
    for (const item of usage.scopes) {
      object(item, ['scope', 'attempts', 'reportedAttempts']);
      const position = SCOPES.findIndex((scope) => scope === item.scope);
      if (position <= last || position < 0 || item.scope !== null && item.scope !== PROVIDER_SCOPE[worker.provider] ||
        !count(item.attempts, counts.total) || !item.attempts || !count(item.reportedAttempts, item.attempts) ||
        item.scope !== null && item.reportedAttempts !== item.attempts) invalid();
      last = position; scoped += item.attempts; reported += item.reportedAttempts;
    }
    if (scoped !== counts.total || reported !== usage.reportedAttempts) invalid();
    array(row.durations, STATUSES.length);
    if (row.durations.length !== STATUSES.length) invalid();
    for (const [position, duration] of row.durations.entries()) {
      object(duration, ['status', 'attempts', 'samples', 'unknownAttempts', 'p50Ms', 'p95Ms']);
      const status = STATUSES[position]!;
      const attempted = counts[status === 'timed-out' ? 'timedOut' : status];
      if (duration.status !== status || duration.attempts !== attempted || !count(duration.samples, attempted) ||
        !count(duration.unknownAttempts, attempted) || duration.samples + duration.unknownAttempts !== attempted) invalid();
      if (duration.samples === 0 ? duration.p50Ms !== null || duration.p95Ms !== null :
        !validResourceExecutionDuration(duration.p50Ms) || !validResourceExecutionDuration(duration.p95Ms) || duration.p50Ms > duration.p95Ms) invalid();
    }
  }
  if (total !== value.attempts) invalid();
  return JSON.parse(JSON.stringify(value)) as ResourcePerformanceReport;
}
