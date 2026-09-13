/** One cooperative effectful setup isolate; never retried or terminated mid-write. */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { captureResourceEngineeringLifetime, type ResourceEngineeringLifetime } from './engineering-lifetime.js';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import { createWorkspaceProofHandlers } from './workspace-proof-host.js';
import { createEngineeringWorkerRpcHost } from './engineering-worker-rpc.js';
import { startEngineeringActiveMonitor } from './engineering-active-monitor.js';
import { setupRequestDigest, type EngineeringSetupRequest } from './engineering-setup-context.js';
import type { ResourceEngineeringAutonomousSetupReport } from './engineering-autonomous-setup-types.js';

export type { EngineeringSetupRequest } from './engineering-setup-context.js';
export interface EngineeringSetupHost { lifetime: ResourceEngineeringLifetime; custody?: ResourceWorkspaceCustody }
const unavailable = () => new ResourceSupervisorError('UNAVAILABLE', 'Engineering setup unavailable or cleanup unconfirmed');
function copy<T>(value: unknown): T {
  const bytes = canonicalEvidencePackJsonV3(value);
  if (bytes === null || Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw unavailable();
  return JSON.parse(bytes) as T;
}
export function validateEngineeringSetupRequest(value: unknown): EngineeringSetupRequest {
  const request = copy<EngineeringSetupRequest>(value);
  if (!request || Object.keys(request).sort().join(',') !== (request.predecessor === undefined ? 'input' : 'input,predecessor') ||
    !request.input || typeof request.input.expectedPlanDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.input.expectedPlanDigest) ||
    request.predecessor !== undefined && (!request.predecessor || Object.keys(request.predecessor).sort().join(',') !== 'expectedTip,options' ||
      !request.predecessor.expectedTip || !request.predecessor.options)) throw unavailable();
  return request;
}
function entrypoint(): URL {
  if (import.meta.url.endsWith('/engineering-setup.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./engineering-setup-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./engineering-setup-worker.js', import.meta.url);
}

export async function prepareEngineeringMissionSetup(input: EngineeringSetupRequest, host: EngineeringSetupHost): Promise<ResourceEngineeringAutonomousSetupReport> {
  if (!host || ![Object.prototype, null].includes(Object.getPrototypeOf(host)) || !Object.hasOwn(host, 'lifetime') ||
    Reflect.ownKeys(host).some(key => typeof key !== 'string' || !['lifetime', 'custody'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(host, key)!, 'value'))) throw unavailable();
  const request = validateEngineeringSetupRequest(input), requestDigest = setupRequestDigest(request);
  const lifetime = captureResourceEngineeringLifetime({ engineeringLifetime: host.lifetime });
  const custody = host.custody;
  if (!lifetime.deadlineAt) throw unavailable();
  const assertActive = () => {
    if (lifetime.isStopped()) throw unavailable();
    if (custody !== undefined) readResourceWorkspaceCustody(custody);
  };
  assertActive();
  const closeFlag = new Int32Array(new SharedArrayBuffer(4));
  // Setup invokes several full predecessor proofs. Bound the entire operation's
  // samples without reusing an old proof or renewing its execution deadline.
  const proof = createWorkspaceProofHandlers(custody, assertActive, 4096);
  let authorized = false;
  const rpc = createEngineeringWorkerRpcHost({ closeFlag, handlers: { ...proof.handlers,
    'setup.authorize': value => {
      assertActive(); if (authorized || value !== requestDigest) throw unavailable();
      authorized = true; return { hasCustody: custody !== undefined };
    },
    'setup.active': value => { assertActive(); if (!authorized || value !== null) throw unavailable(); return true; },
  } });
  let worker: Worker;
  try {
    worker = new Worker(entrypoint(), { workerData: { schemaVersion: 1, request, closeBuffer: closeFlag.buffer }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
  } catch { rpc.close(); proof.close(); throw unavailable(); }
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let result: ResourceEngineeringAutonomousSetupReport | undefined;
    let received = false;
    const stop = (error: Error) => { failure ??= error; stopMonitor(); rpc.close(); Atomics.notify(closeFlag, 0); };
    const stopMonitor = startEngineeringActiveMonitor(assertActive, () => stop(unavailable()));
    worker.on('message', (message: unknown) => {
      if (rpc.handle(message)) return;
      try {
        const reply = copy<{ type: string; ok: boolean; value?: ResourceEngineeringAutonomousSetupReport; reason?: string }>(message);
        if (received || !reply || reply.type !== 'engineering-setup-result' || typeof reply.ok !== 'boolean' ||
          Object.keys(reply).sort().join(',') !== (reply.ok ? 'ok,type,value' : 'ok,reason,type')) throw unavailable();
        received = true;
        if (!reply.ok) {
          if (!['setup-refused', 'setup-cleanup-unconfirmed'].includes(reply.reason ?? '')) throw unavailable();
          stop(new ResourceSupervisorError('UNAVAILABLE', `Engineering ${reply.reason}`)); return;
        }
        const value = reply.value;
        if (!authorized || !value || value.schemaVersion !== 1 || value.status !== 'prepared' || value.scope !== 'local-autonomous-setup-only' ||
          value.planDigest !== request.input.expectedPlanDigest || value.output !== request.input.output ||
          typeof value.initialEnrollmentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.initialEnrollmentDigest) ||
          !['created', 'replayed'].includes(value.disposition) || value.executionStarted !== false || value.providerContacted !== false) throw unavailable();
        result = value; rpc.close();
      } catch { stop(unavailable()); }
    });
    worker.on('error', () => stop(unavailable()));
    worker.once('exit', code => {
      stopMonitor(); rpc.close(); proof.close();
      // Natural exit follows all worker finally blocks. A crash, missing result,
      // stop, or failed cleanup never becomes a usable prepared enrollment.
      if (code !== 0 || failure || !received || !result) { reject(failure ?? unavailable()); return; }
      try { assertActive(); resolve(copy(result)); } catch { reject(unavailable()); }
    });
  });
}
