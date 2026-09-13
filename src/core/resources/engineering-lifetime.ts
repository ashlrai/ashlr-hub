import { captureResourceExecutionVeto } from './execution-veto.js';

/** In-process child control only. It cannot change pool policy or host shutdown. */
export interface ResourceEngineeringLifetime {
  signal?: AbortSignal;
  isExecutionStopped?: () => boolean;
}

export function captureResourceEngineeringLifetime(options: object): {
  signal?: AbortSignal; configured: boolean; isStopped(): boolean;
} {
  const property = Object.getOwnPropertyDescriptor(options, 'engineeringLifetime');
  if (!property) {
    if ('engineeringLifetime' in options) throw new Error('Inherited engineering lifetime is not supported');
    return { configured: false, isStopped: () => false };
  }
  const value = property.value as ResourceEngineeringLifetime;
  if (!Object.hasOwn(property, 'value') || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['signal', 'isExecutionStopped'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('Invalid engineering lifetime');
  const signal = value.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid engineering lifetime signal');
  const veto = captureResourceExecutionVeto(value);
  return { configured: true, ...(signal ? { signal } : {}), isStopped: () => signal?.aborted === true || veto() };
}
