/** One effectful engineering isolate. Unlike read workers it is never restarted automatically. */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { ResourceSupervisorError, type ResourcePoolSupervisor } from './pool-supervisor.js';
import type { ResourceConsoleEngineeringOwner } from './console-engineering.js';
import type { ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';
import { createEngineeringWorkerRpcHost } from './engineering-worker-rpc.js';
import { createEngineeringSuccessorReader, type EngineeringSuccessorReader } from './engineering-successor-reader.js';
import type { ResourceEngineeringSuccessorJournalScope } from './engineering-successor-store.js';
import type { EngineeringCoordinatorLifecycleReport } from './engineering-successor-coordinator-types.js';
import { readEngineeringCoordinatorObservation } from './engineering-coordinator-observation.js';
import { ENGINEERING_BACKGROUND_HOST_METHODS, type EngineeringBackground, type EngineeringBackgroundHost,
  type EngineeringBackgroundPreparation } from './engineering-background-types.js';

const MAX_BYTES = 2 * 1024 * 1024;
const CODES = ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'CAPACITY', 'UNAVAILABLE'] as const;
function unavailable(): ResourceSupervisorError { return new ResourceSupervisorError('UNAVAILABLE', 'Engineering background operation unavailable'); }
function copy<T>(input: unknown): T {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > MAX_BYTES) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid engineering background data');
  return JSON.parse(text) as T;
}
function method<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const property = object && Object.getOwnPropertyDescriptor(object, key);
  if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function') throw unavailable();
  return property.value.bind(object) as T[K];
}
function entrypoint(): URL {
  if (import.meta.url.endsWith('/engineering-background.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./engineering-background-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./engineering-background-worker.js', import.meta.url);
}

export async function createEngineeringBackground(input: {
  preparation: EngineeringBackgroundPreparation; owner: ResourceConsoleEngineeringOwner; supervisor: ResourcePoolSupervisor;
  isClosing(): boolean; onFault(): void; signal?: AbortSignal;
}): Promise<EngineeringBackground> {
  const required = ['preparation', 'owner', 'supervisor', 'isClosing', 'onFault'];
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      required.some(key => !Object.hasOwn(input, key)) || Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
      ![...required, 'signal'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw unavailable();
  const { owner, supervisor, signal } = input;
  const preparation = copy<EngineeringBackgroundPreparation>(input.preparation);
  const isClosing = method(input, 'isClosing'); const onFault = method(input, 'onFault');
  if (signal !== undefined && !(signal instanceof AbortSignal) || signal?.aborted) throw unavailable();
  const ownerMethods = { catalog: method(owner, 'catalog'), snapshot: method(owner, 'snapshot'),
    checkRegistration: method(owner, 'checkRegistration'), register: method(owner, 'register') };
  const projectMethods = { projectFileBinding: method(supervisor, 'projectFileBinding'), projectExecutionBinding: method(supervisor, 'projectExecutionBinding') };
  let supervisionMethods: Pick<ResourceConsoleEngineeringSupervisor, 'snapshot' | 'admit' | 'isExecutionStopped'> | undefined;
  let admission: Parameters<EngineeringBackground['configureSuccessors']>[2] | undefined;
  let observationReader: EngineeringSuccessorReader | undefined;
  let observationPins: Pick<EngineeringCoordinatorLifecycleReport, 'supervisionId' | 'configDigest' | 'deadlineAt'> | undefined;
  let expectedSupervisionId: string | undefined;
  let coordinator: EngineeringCoordinatorLifecycleReport | null = null;
  let initializingReport: EngineeringCoordinatorLifecycleReport | null = null;
  let closing = false; let faulted = false; let exited = false; let configured = false;
  const closeFlag = new Int32Array(new SharedArrayBuffer(4));
  const assertOpen = () => { if (closing || faulted || signal?.aborted || isClosing()) throw unavailable(); };
  const args = (values: unknown[], count: number) => { if (values.length !== count) throw unavailable(); };
  const host: EngineeringBackgroundHost = {
    'owner.catalog': (...values) => { args(values, 0); return ownerMethods.catalog(); },
    'owner.snapshot': (...values) => { args(values, 1); return ownerMethods.snapshot(values[0] as string); },
    'owner.checkRegistration': (...values) => { args(values, 1); assertOpen(); return ownerMethods.checkRegistration(values[0] as Parameters<typeof ownerMethods.checkRegistration>[0]); },
    'owner.register': (...values) => { args(values, 1); assertOpen(); return ownerMethods.register(values[0] as Parameters<typeof ownerMethods.register>[0]); },
    'supervision.snapshot': (...values) => { args(values, 0); if (!supervisionMethods) throw unavailable(); return supervisionMethods.snapshot(); },
    'supervision.isExecutionStopped': (...values) => { args(values, 0); return closing || faulted || isClosing() || !supervisionMethods || supervisionMethods.isExecutionStopped(); },
    'supervision.admit': (...values) => { args(values, 1); assertOpen();
      if (!supervisionMethods || supervisionMethods.isExecutionStopped()) throw unavailable();
      return supervisionMethods.admit(values[0]); },
    'supervisor.projectFileBinding': (...values) => { args(values, 1); return projectMethods.projectFileBinding(values[0] as string); },
    'supervisor.projectExecutionBinding': (...values) => { args(values, 1); return projectMethods.projectExecutionBinding(values[0] as string); },
    readAdmissionEvidence: (...values) => { args(values, 0); assertOpen(); if (!admission) throw unavailable(); return admission(); },
    isClosing: (...values) => { args(values, 0); return closing || faulted || signal?.aborted === true || isClosing(); },
  };
  const handlers = Object.fromEntries(ENGINEERING_BACKGROUND_HOST_METHODS.map(key => [key, (value: unknown) => {
    if (!Array.isArray(value)) throw unavailable(); return host[key](...value);
  }]));
  const rpc = createEngineeringWorkerRpcHost({ handlers, closeFlag });
  const worker = new Worker(entrypoint(), { workerData: { schemaVersion: 1, closeBuffer: closeFlag.buffer }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
  type Pending = { resolve(value: unknown): void; reject(error: Error): void };
  const pending = new Map<number, Pending>(); let sequence = 0; let closePromise: Promise<void> | undefined;
  function fault(): void {
    if (faulted) return; faulted = true; Atomics.store(closeFlag, 0, 1); Atomics.notify(closeFlag, 0);
    for (const item of pending.values()) item.reject(unavailable()); pending.clear();
    try { onFault(); } catch { /* Failure notification cannot grant execution or hide the failed isolate. */ }
  }
  worker.on('message', (message: unknown) => {
    if (rpc.handle(message)) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) { fault(); return; }
    const value = message as Record<string, unknown>;
    if (value.type === 'engineering-coordinator-observation') {
      // Telemetry failure cannot close unrelated work or masquerade as an RPC
      // failure. Retain only the last valid historical report, without renewing
      // its timestamp. The journal remains independently verified on each read.
      if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'report') || exited || faulted) return;
      const report = readEngineeringCoordinatorObservation(value.report, observationPins);
      if (!report || report.supervisionId !== expectedSupervisionId) return;
      if (!observationPins) {
        // Initialization emits idle before returning its verified scope. This
        // bounded mailbox is not exposed until it matches those original pins.
        if (!initializingReport || report.sequence > initializingReport.sequence) initializingReport = report;
      } else if (!coordinator || report.sequence > coordinator.sequence) coordinator = report;
      return;
    }
    if (value.type !== 'engineering-result' || !Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean' ||
        Object.keys(value).some(key => !['type', 'id', 'ok', 'value', 'code'].includes(key))) { fault(); return; }
    const item = pending.get(value.id as number); if (!item) { fault(); return; }
    pending.delete(value.id as number);
    if (!value.ok) { const code = CODES.includes(value.code as typeof CODES[number]) ? value.code as typeof CODES[number] : 'UNAVAILABLE';
      item.reject(new ResourceSupervisorError(code, 'Engineering background operation unavailable')); return; }
    try { item.resolve(copy(value.value)); } catch { item.reject(unavailable()); fault(); }
  });
  worker.on('error', fault);
  worker.on('exit', () => {
    exited = true;
    // A prior protocol fault may have been followed by the sole cleanup
    // command. Terminal exit must reject that new waiter as well.
    const unfinished = pending.size > 0;
    for (const item of pending.values()) item.reject(unavailable()); pending.clear();
    if (!closing || unfinished) fault();
  });
  function command<T>(kind: string, value: unknown = null, cleanup = false): Promise<T> {
    if (exited || !cleanup && (faulted || closing || signal?.aborted) || pending.size >= 8 && !cleanup) return Promise.reject(unavailable());
    let captured: unknown; try { captured = copy(value); } catch (error) { return Promise.reject(error); }
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: result => resolve(result as T), reject });
      try { worker.postMessage({ type: 'engineering-command', id, kind, input: captured }); }
      catch { pending.delete(id); reject(unavailable()); fault(); } });
  }
  const background: EngineeringBackground = {
    profiles: projectId => command('profiles', projectId), check: value => command('check', value), prepare: value => command('prepare', value),
    async configureSuccessors(value, supervision, readAdmissionEvidence) {
      assertOpen(); if (configured) throw unavailable();
      if (typeof readAdmissionEvidence !== 'function') throw unavailable();
      const captured = copy<Parameters<EngineeringBackground['configureSuccessors']>[0]>(value);
      supervisionMethods = { snapshot: method(supervision, 'snapshot'), admit: method(supervision, 'admit'),
        isExecutionStopped: method(supervision, 'isExecutionStopped') };
      admission = readAdmissionEvidence; configured = true;
      expectedSupervisionId = captured.config.supervisionId;
      const scope = await command<ResourceEngineeringSuccessorJournalScope>('configure-successors', captured);
      assertOpen();
      if (scope.directory !== join(captured.root, 'engineering-successors', captured.config.supervisionId) ||
          canonicalEvidencePackJsonV3(scope.config) !== canonicalEvidencePackJsonV3(captured.config)) throw unavailable();
      observationPins = { supervisionId: captured.config.supervisionId, configDigest: scope.expectedEnrollment.configDigest,
        deadlineAt: scope.expectedEnrollment.deadlineAt };
      coordinator = readEngineeringCoordinatorObservation(initializingReport, observationPins); initializingReport = null;
      observationReader = createEngineeringSuccessorReader({ scope, configFile: captured.configFile });
      // Pay module loading and verify the original journal before execution
      // starts. This sample is never reused for later operator reads.
      await observationReader.read(); assertOpen();
    },
    start: () => command('start'),
    async snapshot() {
      assertOpen(); if (!observationReader) throw unavailable();
      const observed = await observationReader.read();
      // A read begun before close/exit/fault cannot resurrect the old owner.
      assertOpen(); if (exited) throw unavailable();
      return { ...observed.snapshot,
        state: Date.parse(observed.sampledAt) >= Date.parse(observed.snapshot.deadlineAt) ? 'timed-out' : 'observing',
        observation: { kind: 'durable-journal', sampledAt: observed.sampledAt, recordsDigest: observed.recordsDigest,
          workerState: 'connected', coordinator: coordinator ? { ...coordinator } : null } };
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; Atomics.store(closeFlag, 0, 1); Atomics.notify(closeFlag, 0); rpc.close();
      signal?.removeEventListener('abort', onAbort);
      // No timeout termination: existing provider execution and metadata owners must drain first.
      closePromise = (async () => {
        // A protocol fault is not proof of worker exit. Still request the one
        // cleanup operation, then retain uncertainty even after a clean drain.
        const results = await Promise.allSettled([
          observationReader?.close(),
          (async () => { if (exited) throw unavailable(); await command('close', null, true); await worker.terminate(); })(),
        ]);
        if (faulted || results.some(result => result.status === 'rejected')) throw unavailable(); })();
      return closePromise;
    },
  };
  const onAbort = () => { void background.close().catch(() => { fault(); }); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try { await command('initialize', preparation); if (signal?.aborted || isClosing()) throw unavailable(); return background; }
  catch (error) { try { await background.close(); } catch { /* Preserve failure/uncertainty; never remove owned files. */ } throw error; }
}
