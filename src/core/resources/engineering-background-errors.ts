import { EngineeringWorkerRpcError } from './engineering-worker-rpc.js';
import { ENGINEERING_BACKGROUND_HOST_METHODS } from './engineering-background-types.js';

const METHODS = new Set<string>(ENGINEERING_BACKGROUND_HOST_METHODS);
const MUTATIONS = new Set(['owner.register', 'supervision.admit']);

/** Uncertain mutations must stop the isolate before subordinate catches can retry. */
export function createEngineeringBackgroundHostCalls(options: {
  call(method: string, input: unknown): unknown;
  isClosed(): boolean;
  onFault(): void;
}) {
  const properties = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).length !== 3 || !['call', 'isClosed', 'onFault'].every(key => {
    const property = properties[key]; return property && Object.hasOwn(property, 'value') && typeof property.value === 'function';
  })) throw new EngineeringWorkerRpcError('INVALID_OPTIONS');
  const invoke = options.call.bind(options); const isClosed = options.isClosed.bind(options); const onFault = options.onFault.bind(options);
  let faulted = false;
  function fault(): void {
    if (faulted) return;
    faulted = true;
    try { onFault(); } catch { /* The local latch remains closed even if notification fails. */ }
  }
  return function call<T = unknown>(method: string, input: unknown): T {
    if (faulted) throw new EngineeringWorkerRpcError('BACKGROUND_FAULTED', true);
    try {
      if (!METHODS.has(method)) throw new EngineeringWorkerRpcError('INVALID_METHOD');
      if (isClosed()) throw new EngineeringWorkerRpcError('CLOSED');
      return invoke(method, input) as T;
    } catch (error) {
      const code = error instanceof EngineeringWorkerRpcError ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      const uncertain = error instanceof EngineeringWorkerRpcError ? Object.getOwnPropertyDescriptor(error, 'uncertain')?.value : undefined;
      // A read validation refusal grants no effect. CLOSED before execution is
      // likewise normal during drain. Every protocol/transport/timeout failure
      // is fatal, as is an unconfirmed registration/admission—even during close.
      if (!['HANDLER_FAILED', 'CLOSED'].includes(code) || typeof uncertain !== 'boolean' || MUTATIONS.has(method) && uncertain) fault();
      throw error;
    }
  };
}
