/** Cancellable proof isolation. No worker, evaluator or publication effects. */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { canonical, digest } from '../universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { createEngineeringWorkerRpcHost } from './engineering-worker-rpc.js';
import { captureResourceEngineeringLifetime, type ResourceEngineeringLifetime } from './engineering-lifetime.js';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import { readResourceJson, type ResourceTaskReceipt } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import type { ResourceEngineeringAutonomousSetupOptions, ResourceEngineeringAutonomousSetupPlan } from './engineering-autonomous-setup-types.js';
import type { ResourceEngineeringPredecessorCheck, ResourceEngineeringPredecessorCheckOptions } from './engineering-predecessor-check.js';

export type EngineeringMissionProofRequest =
  { kind: 'setup'; input: ResourceEngineeringAutonomousSetupOptions } |
  { kind: 'predecessor'; input: ResourceEngineeringPredecessorCheckOptions };
export interface EngineeringMissionProofHost {
  lifetime: ResourceEngineeringLifetime;
  custody?: ResourceWorkspaceCustody;
}
const MAX_BYTES = 2 * 1024 * 1024;
const unavailable = () => new ResourceSupervisorError('UNAVAILABLE', 'Mission proof unavailable or stopped');
function copy<T>(value: unknown): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
  return JSON.parse(text) as T;
}
function entrypoint(): URL {
  if (import.meta.url.endsWith('/engineering-mission-proof.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./engineering-mission-proof-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./engineering-mission-proof-worker.js', import.meta.url);
}

export async function readEngineeringMissionProof(request: { kind: 'setup'; input: ResourceEngineeringAutonomousSetupOptions }, host: EngineeringMissionProofHost): Promise<ResourceEngineeringAutonomousSetupPlan>;
export async function readEngineeringMissionProof(request: { kind: 'predecessor'; input: ResourceEngineeringPredecessorCheckOptions }, host: EngineeringMissionProofHost): Promise<ResourceEngineeringPredecessorCheck>;
export async function readEngineeringMissionProof(request: EngineeringMissionProofRequest, host: EngineeringMissionProofHost): Promise<ResourceEngineeringAutonomousSetupPlan | ResourceEngineeringPredecessorCheck> {
  if (!host || ![Object.prototype, null].includes(Object.getPrototypeOf(host)) || !Object.hasOwn(host, 'lifetime') ||
    Reflect.ownKeys(host).some(key => typeof key !== 'string' || !['lifetime', 'custody'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(host, key)!, 'value'))) throw unavailable();
  const custody = host.custody;
  const captured = copy<EngineeringMissionProofRequest>(request);
  if (!captured || Object.keys(captured).sort().join(',') !== 'input,kind' || !['setup', 'predecessor'].includes(captured.kind)) throw unavailable();
  const lifetime = captureResourceEngineeringLifetime({ engineeringLifetime: host.lifetime });
  if (!lifetime.deadlineAt) throw unavailable();
  const assertActive = () => {
    if (lifetime.isStopped()) throw unavailable();
    if (custody !== undefined) readResourceWorkspaceCustody(custody);
  };
  assertActive();
  const closeFlag = new Int32Array(new SharedArrayBuffer(4));
  const samples = new Map<number, ReturnType<typeof readResourceWorkspaceCustody>>();
  let sampleId = 0;
  const rpc = createEngineeringWorkerRpcHost({ closeFlag, handlers: {
    'custody.sample': input => {
      assertActive(); if (input !== null || !custody || samples.size >= 128) throw unavailable();
      const owner = readResourceWorkspaceCustody(custody);
      // The actual owner validates its FULL durable state. Only then may a
      // read-only worker ignore concurrent ordinary job rows, as the existing
      // predecessor evidence projection already does. Never ignore scope drift.
      const state = readResourceJson(join(owner.root, 'resource-console-state.json'), 4 * 1024 * 1024) as object;
      if (digest(canonical(state)) !== owner.stateDigest) throw unavailable();
      samples.set(++sampleId, owner);
      return { sampleId, root: owner.root, workspace: owner.workspace, poolDigest: owner.poolDigest,
        stateDigest: owner.stateDigest, consoleScopeDigest: digest(canonical({ ...state, jobs: [] })),
        lockPaths: owner.locks.map(lock => lock.path), metadataPending: owner.metadataPending };
    },
    'custody.receipt': input => {
      assertActive();
      const value = copy<{ sampleId: number; receipt: ResourceTaskReceipt }>(input);
      if (!value || Object.keys(value).sort().join(',') !== 'receipt,sampleId' || !Number.isSafeInteger(value.sampleId)) throw unavailable();
      const owner = samples.get(value.sampleId); if (!owner) throw unavailable();
      return owner.ownsReceipt(value.receipt);
    },
  } });
  const worker = new Worker(entrypoint(), { workerData: { schemaVersion: 1, request: captured,
    hasCustody: custody !== undefined, closeBuffer: closeFlag.buffer }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return; finished = true; clearInterval(timer); rpc.close(); samples.clear();
      // Every path waits for terminal worker exit; a later read never shares
      // an abandoned thread or accepts a late result from a stopped request.
      void worker.terminate().then(() => {
        if (error) { reject(error); return; }
        try { assertActive(); resolve(copy(value)); } catch (cause) { reject(cause); }
      }, () => reject(unavailable()));
    };
    const timer = setInterval(() => { try { assertActive(); } catch { finish(unavailable()); } }, 25);
    worker.on('message', (message: unknown) => {
      if (finished || rpc.handle(message)) return;
      try {
        const result = copy<{ type: string; ok: boolean; value?: unknown; reason?: string; location?: string }>(message);
        if (!result || result.type !== 'mission-proof-result' || typeof result.ok !== 'boolean' ||
          Object.keys(result).sort().join(',') !== (result.ok ? 'ok,type,value' : result.location !== undefined ? 'location,ok,reason,type' : result.reason === undefined ? 'ok,type' : 'ok,reason,type')) throw unavailable();
        if (!result.ok) {
          if (result.reason !== undefined && !['proof-refused', 'workspace-state-changed', 'rpc-invalid-data', 'rpc-unavailable'].includes(result.reason)) throw unavailable();
          if (result.location !== undefined && !/^[a-z][a-z0-9-]{0,80}\.(?:ts|js):[1-9][0-9]{0,5}$/.test(result.location)) throw unavailable();
          finish(new ResourceSupervisorError('UNAVAILABLE', `Mission proof ${result.reason ?? 'proof-refused'}${result.location ? ` (${result.location})` : ''}`)); return;
        }
        finish(undefined, result.value);
      } catch { finish(unavailable()); }
    });
    worker.on('error', () => finish(unavailable()));
    worker.on('exit', () => { if (!finished) finish(unavailable()); });
  });
}
