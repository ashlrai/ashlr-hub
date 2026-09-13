/** Read-only ownership questions for proof isolates, never execution custody. */
import { isMainThread } from 'node:worker_threads';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';
import type { createEngineeringWorkerRpcClient } from './engineering-worker-rpc.js';
import { canonical, digest } from '../universe/artifacts.js';

export interface ResourceWorkspaceProofContext { readonly kind: 'workspace-proof-reader' }
export type ResourceWorkspaceProofSource = ResourceWorkspaceCustody | ResourceWorkspaceProofContext;
export interface ResourceWorkspaceProofSample {
  root: string; workspace: string; poolDigest: string; stateDigest: string;
  /** Worker reads may overlap known human rows; scope/pause/epoch remain exact. */
  consoleScopeDigest?: string;
  lockPaths: string[]; metadataPending: boolean;
  ownsReceipt(receipt: ResourceTaskReceipt): boolean;
}
const readers = new WeakMap<ResourceWorkspaceProofContext, () => ResourceWorkspaceProofSample>();

export function matchesWorkspaceProofState(sample: ResourceWorkspaceProofSample, state: object): boolean {
  return digest(canonical(state)) === sample.stateDigest || sample.consoleScopeDigest !== undefined &&
    digest(canonical({ ...state, jobs: [] })) === sample.consoleScopeDigest;
}

/** Only the fixed proof worker calls this. Its RPC peer must hold real custody.
 * This token is deliberately unrecognized by every mutating workspace API. */
export function createWorkerWorkspaceProofContext(client: ReturnType<typeof createEngineeringWorkerRpcClient>): ResourceWorkspaceProofContext {
  if (isMainThread) throw new Error('Workspace proof bridge is worker-only');
  const context = Object.freeze({ kind: 'workspace-proof-reader' as const });
  readers.set(context, () => {
    const { sampleId, ...sample } = client.call<Omit<ResourceWorkspaceProofSample, 'ownsReceipt'> & { sampleId: number }>('custody.sample');
    return { ...sample, ownsReceipt: receipt => client.call<boolean>('custody.receipt', { sampleId, receipt }) };
  });
  return context;
}

export function readResourceWorkspaceProof(source: ResourceWorkspaceProofSource,
  scope?: { root: string; workspace: string; poolDigest: string }): ResourceWorkspaceProofSample {
  const remote = readers.get(source as ResourceWorkspaceProofContext);
  const sample = remote ? remote() : (() => {
    const owner = readResourceWorkspaceCustody(source as ResourceWorkspaceCustody);
    return { root: owner.root, workspace: owner.workspace, poolDigest: owner.poolDigest,
      stateDigest: owner.stateDigest, lockPaths: owner.locks.map(lock => lock.path),
      metadataPending: owner.metadataPending, ownsReceipt: owner.ownsReceipt };
  })();
  if (scope && (sample.root !== scope.root || sample.workspace !== scope.workspace || sample.poolDigest !== scope.poolDigest)) {
    throw new Error('Workspace proof scope changed');
  }
  return sample;
}
