import { captureResourceExecutionVeto } from './execution-veto.js';
import { performance } from 'node:perf_hooks';

/** In-process child control only. It cannot change pool policy or host shutdown. */
export interface ResourceEngineeringLifetime {
  signal?: AbortSignal;
  isExecutionStopped?: () => boolean;
  /** Original wall-clock deadline; capturing also pins a monotonic upper bound. */
  deadlineAt?: string;
}

export function captureResourceEngineeringLifetime(options: object): {
  signal?: AbortSignal; deadlineAt?: string; configured: boolean; isStopped(): boolean;
} {
  const property = Object.getOwnPropertyDescriptor(options, 'engineeringLifetime');
  if (!property) {
    if ('engineeringLifetime' in options) throw new Error('Inherited engineering lifetime is not supported');
    return { configured: false, isStopped: () => false };
  }
  const value = property.value as ResourceEngineeringLifetime;
  if (!Object.hasOwn(property, 'value') || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['signal', 'isExecutionStopped', 'deadlineAt'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('Invalid engineering lifetime');
  const signal = value.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid engineering lifetime signal');
  const veto = captureResourceExecutionVeto(value);
  const deadlineAt = value.deadlineAt;
  if (Object.hasOwn(value, 'deadlineAt') && (typeof deadlineAt !== 'string' || !Number.isFinite(Date.parse(deadlineAt)) ||
    new Date(deadlineAt).toISOString() !== deadlineAt)) throw new Error('Invalid engineering lifetime deadline');
  const deadline = deadlineAt === undefined ? Infinity : Date.parse(deadlineAt);
  const monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
  return { configured: true, ...(signal ? { signal } : {}), ...(deadlineAt ? { deadlineAt } : {}),
    isStopped: () => signal?.aborted === true || Date.now() >= deadline || performance.now() >= monotonicDeadline || veto() };
}
