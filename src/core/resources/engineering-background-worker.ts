/** Fixed, effectful engineering entrypoint. All acquired locks stay in this isolate. */
import { parentPort, workerData } from 'node:worker_threads';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { createResourceConsoleEngineeringPreparation, type ResourceConsoleEngineeringPreparationOwner } from './console-engineering-preparation.js';
import { createResourceConsoleEngineeringSuccessors } from './console-engineering-successors.js';
import type { ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourcePoolSupervisor } from './pool-supervisor.js';
import type { ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';
import { createEngineeringWorkerRpcClient } from './engineering-worker-rpc.js';
import { createEngineeringBackgroundHostCalls } from './engineering-background-errors.js';
import type { EngineeringBackgroundPreparation, EngineeringBackgroundSuccessors } from './engineering-background-types.js';

const port = parentPort;
if (!port || !workerData || typeof workerData !== 'object' || workerData.schemaVersion !== 1 ||
    Object.keys(workerData).some(key => !['schemaVersion', 'closeBuffer'].includes(key)) ||
    !(workerData.closeBuffer instanceof SharedArrayBuffer) || workerData.closeBuffer.byteLength !== 4) {
  throw new Error('Engineering worker requires its fixed owning transport');
}
const closeFlag = new Int32Array(workerData.closeBuffer);
const rpc = createEngineeringWorkerRpcClient({ port, closeFlag });
const abort = new AbortController();
const hostCall = createEngineeringBackgroundHostCalls({ call: (method, input) => rpc.call(method, input),
  isClosed: () => rpc.isClosed(), onFault: () => {
    Atomics.store(closeFlag, 0, 1); Atomics.notify(closeFlag, 0); abort.abort();
    port.postMessage({ type: 'engineering-fault' });
  } });
let preparation: ResourceConsoleEngineeringPreparationOwner | undefined;
let successors: ReturnType<typeof createResourceConsoleEngineeringSuccessors> | undefined;
let closing = false; let initialized = false; let startRequested = false;
let sequence = 0; let pending = 0; let queue = Promise.resolve();
let scheduledStart: ReturnType<typeof setImmediate> | undefined;
const MAX_BYTES = 2 * 1024 * 1024;
function data<T>(value: unknown): T {
  const serialized = canonicalEvidencePackJsonV3(value);
  if (serialized === null || Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Invalid engineering worker data');
  return JSON.parse(serialized) as T;
}
function open(): void { if (closing || rpc.isClosed()) throw new Error('Engineering worker closed'); }
// These are transport capabilities, not fabricated owners: every call executes
// the original parent's method. No parent lease or prepared handler is copied.
const owner = {
  catalog: () => hostCall('owner.catalog', []),
  snapshot: (id: string) => hostCall('owner.snapshot', [id]),
  checkRegistration: (value: unknown) => hostCall('owner.checkRegistration', [value]),
  register: (value: unknown) => hostCall('owner.register', [value]),
} as Pick<ResourceConsoleEngineeringOwner, 'catalog' | 'snapshot' | 'checkRegistration' | 'register'>;
const supervision = {
  snapshot: () => hostCall('supervision.snapshot', []),
  admit: (value: unknown) => hostCall('supervision.admit', [value]),
  isExecutionStopped: () => rpc.isClosed() || hostCall<boolean>('supervision.isExecutionStopped', []),
} as Pick<ResourceConsoleEngineeringSupervisor, 'snapshot' | 'admit' | 'isExecutionStopped'>;
const supervisor = {
  projectFileBinding: (id: string) => hostCall('supervisor.projectFileBinding', [id]),
  projectExecutionBinding: (id: string) => hostCall('supervisor.projectExecutionBinding', [id]),
} as Pick<ResourcePoolSupervisor, 'projectFileBinding' | 'projectExecutionBinding'>;

async function execute(kind: string, input: unknown): Promise<unknown> {
  if (kind === 'close') {
    closing = true; abort.abort(); if (scheduledStart) clearImmediate(scheduledStart);
    await successors?.close(); return null;
  }
  open();
  if (kind === 'initialize') {
    if (initialized) throw new Error('Engineering worker already initialized'); initialized = true;
    preparation = createResourceConsoleEngineeringPreparation({ ...data<EngineeringBackgroundPreparation>(input),
      owner: owner as ResourceConsoleEngineeringOwner });
    return null;
  }
  if (!preparation) throw new Error('Engineering preparation unavailable');
  switch (kind) {
    case 'profiles': return preparation.profiles(input as string);
    case 'check': return preparation.check(input);
    case 'prepare': return preparation.prepare(input);
    case 'configure-successors': {
      if (successors) throw new Error('Engineering successor coordinator already initialized');
      successors = createResourceConsoleEngineeringSuccessors({ ...data<EngineeringBackgroundSuccessors>(input), preparation,
        supervision: supervision as ResourceConsoleEngineeringSupervisor, supervisor: supervisor as ResourcePoolSupervisor,
        readAdmissionEvidence: () => hostCall('readAdmissionEvidence', []),
        isClosing: () => rpc.isClosed() || hostCall<boolean>('isClosing', []), signal: abort.signal });
      return null;
    }
    case 'start': {
      if (!successors || startRequested) throw new Error('Engineering successor start unavailable');
      startRequested = true;
      // Acknowledge startup before the first synchronous proof. The caller must
      // already have made its HTTP listener and parent host services available.
      scheduledStart = setImmediate(() => {
        scheduledStart = undefined;
        if (closing || rpc.isClosed()) return;
        try { successors!.start(); }
        catch { Atomics.store(closeFlag, 0, 1); port!.postMessage({ type: 'engineering-fault' }); }
      });
      return null;
    }
    case 'snapshot': if (!successors) throw new Error('Engineering successors unavailable'); return successors.snapshot();
    default: throw new Error('Unknown engineering worker operation');
  }
}

port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) { port.postMessage({ type: 'engineering-fault' }); return; }
  const value = message as Record<string, unknown>;
  if (value.type !== 'engineering-command' || !Number.isSafeInteger(value.id) || (value.id as number) <= sequence ||
      typeof value.kind !== 'string' || !['initialize', 'profiles', 'check', 'prepare', 'configure-successors', 'start', 'snapshot', 'close'].includes(value.kind) ||
      Object.keys(value).length !== 4 || !Object.hasOwn(value, 'input') || pending >= 8 && value.kind !== 'close') {
    port.postMessage({ type: 'engineering-fault' }); return;
  }
  sequence = value.id as number; pending++;
  const id = sequence; const kind = value.kind; let input: unknown;
  try { input = data(value.input); }
  catch { pending--; port.postMessage({ type: 'engineering-result', id, ok: false, code: 'INVALID_INPUT' }); return; }
  queue = queue.then(async () => {
    try { const result = data(await execute(kind, input)); port.postMessage({ type: 'engineering-result', id, ok: true, value: result }); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error &&
        ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'CAPACITY', 'UNAVAILABLE'].includes(String(error.code)) ? String(error.code) : 'UNAVAILABLE';
      port.postMessage({ type: 'engineering-result', id, ok: false, code });
    } finally { pending--; }
  });
});
