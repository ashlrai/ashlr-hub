/** Receipt domain validation only. No storage, execution, or admission authority. */
import { validResourceTaskOrigin, type ResourceTaskOrigin } from './task-origin.js';
import type { ResourcePool } from './pool-policy.js';
import type { ResourceBinding } from './worker.js';
import { resourceUsageScopeForProvider, validResourceExecutionMeasurement, type ResourceExecutionMeasurement } from './performance.js';
import { validResourceNativeProcessForReceipt, type ResourceNativeProcessDiagnostic } from './native-diagnostics.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'cancelled']);

export interface ResourceTaskReceipt {
  schemaVersion: 1;
  id: string;
  taskDigest: string;
  poolDigest: string;
  workerId: string;
  capacityKey: string;
  status: 'reserved' | 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'uncertain';
  startedAt: string;
  finishedAt: string | null;
  outputDigest: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reason: string;
  verifiedAccepted: false;
  /** Persisted atomically at reservation, before execution or trial publication. */
  origin?: ResourceTaskOrigin;
  /** Absent on legacy receipts. No wall-clock-derived timing is backfilled. */
  execution?: ResourceExecutionMeasurement;
  /** Optional native invocation facts. Legacy receipts are never reconstructed from current host state. */
  nativeProcess?: ResourceNativeProcessDiagnostic;
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
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** The caller supplies the validated originating pool/bindings and its exact digest.
 * Durable state decoding captures the outer document before reaching this predicate;
 * settlement supplies host-created evidence. This does not validate a whole ledger. */
export function checkedResourceTaskReceipt(value: unknown, stateDigest: string, bindings: ResourceBinding[], pool: ResourcePool): value is ResourceTaskReceipt {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'taskDigest', 'poolDigest', 'workerId', 'capacityKey',
    'status', 'startedAt', 'finishedAt', 'outputDigest', 'inputTokens', 'outputTokens', 'reason', 'verifiedAccepted',
    ...(Object.hasOwn(value, 'origin') ? ['origin'] : []),
    ...(Object.hasOwn(value, 'execution') ? ['execution'] : []),
    ...(Object.hasOwn(value, 'nativeProcess') ? ['nativeProcess'] : [])]) ||
    value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID.test(value.id) ||
    Object.hasOwn(value, 'origin') && !validResourceTaskOrigin(value.origin, value.id) ||
    typeof value.taskDigest !== 'string' || !HASH.test(value.taskDigest) || value.poolDigest !== stateDigest ||
    !bindings.some((binding) => binding.workerId === value.workerId && binding.capacityKey === value.capacityKey) ||
    typeof value.status !== 'string' || !['reserved', ...TERMINAL, 'uncertain'].includes(value.status) || !iso(value.startedAt) ||
    !(value.finishedAt === null || iso(value.finishedAt) && value.finishedAt >= value.startedAt) ||
    !(value.outputDigest === null || typeof value.outputDigest === 'string' && HASH.test(value.outputDigest)) ||
    !((value.inputTokens === null && value.outputTokens === null) || count(value.inputTokens) && count(value.outputTokens) &&
      count(value.inputTokens + value.outputTokens)) || typeof value.reason !== 'string' || !/^[a-z0-9-]{1,120}$/.test(value.reason) ||
    value.verifiedAccepted !== false || Object.hasOwn(value, 'execution') &&
      (!validResourceExecutionMeasurement(value.execution) || value.status === 'reserved' ||
        value.execution.usageScope !== null && value.inputTokens === null)) return false;
  if (value.status === 'reserved') return value.finishedAt === null && value.outputDigest === null && value.inputTokens === null &&
    !Object.hasOwn(value, 'nativeProcess');
  const worker = pool.workers.find((candidate) => candidate.id === value.workerId);
  if (!worker) return false;
  if (Object.hasOwn(value, 'nativeProcess') && !validResourceNativeProcessForReceipt(value.nativeProcess, value.status, worker.provider)) return false;
  if (value.execution !== undefined && (!validResourceExecutionMeasurement(value.execution) ||
    value.execution.usageScope !== null && value.execution.usageScope !== resourceUsageScopeForProvider(worker.provider))) return false;
  return value.finishedAt !== null && (value.status !== 'completed' || value.outputDigest !== null);
}
