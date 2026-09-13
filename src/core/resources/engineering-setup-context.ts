/** One-use worker-local setup authority; read-only proof tokens cannot substitute. */
import { isMainThread } from 'node:worker_threads';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { digest } from '../universe/artifacts.js';
import type { ResourceEngineeringAutonomousSetupOptions } from './engineering-autonomous-setup-types.js';
import type { ResourceEngineeringPredecessorCheck, ResourceEngineeringPredecessorCheckOptions } from './engineering-predecessor-check.js';
import type { createEngineeringWorkerRpcClient } from './engineering-worker-rpc.js';
import { createWorkerWorkspaceProofContext, type ResourceWorkspaceProofContext } from './workspace-proof-context.js';

export interface EngineeringSetupRequest {
  input: ResourceEngineeringAutonomousSetupOptions & { expectedPlanDigest: string };
  predecessor?: { options: ResourceEngineeringPredecessorCheckOptions; expectedTip: NonNullable<ResourceEngineeringPredecessorCheck['tip']> };
}
export interface EngineeringSetupExecutionContext { readonly kind: 'engineering-setup-worker' }
type Execution = { inputDigest: string; proof?: ResourceWorkspaceProofContext; assertActive(): void };
const executions = new WeakMap<EngineeringSetupExecutionContext, Execution>();
const unavailable = () => new Error('Unrecognized setup execution context');
export function setupRequestDigest(value: unknown): string {
  const bytes = canonicalEvidencePackJsonV3(value);
  if (bytes === null || Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw unavailable();
  return digest(bytes);
}
export function createWorkerSetupExecutionContext(request: EngineeringSetupRequest,
  client: ReturnType<typeof createEngineeringWorkerRpcClient>): EngineeringSetupExecutionContext {
  if (isMainThread) throw unavailable();
  const grant = client.call<{ hasCustody: boolean }>('setup.authorize', setupRequestDigest(request));
  if (!grant || Object.keys(grant).join(',') !== 'hasCustody' || typeof grant.hasCustody !== 'boolean') throw unavailable();
  const context = Object.freeze({ kind: 'engineering-setup-worker' as const });
  executions.set(context, { inputDigest: setupRequestDigest(request.input),
    ...(grant.hasCustody ? { proof: createWorkerWorkspaceProofContext(client) } : {}),
    assertActive: () => { if (client.isClosed() || client.call('setup.active') !== true) throw unavailable(); } });
  return context;
}
export function takeWorkerSetupExecutionContext(context: EngineeringSetupExecutionContext, input: unknown): Execution {
  const execution = executions.get(context);
  if (isMainThread || !execution || execution.inputDigest !== setupRequestDigest(input)) throw unavailable();
  executions.delete(context); execution.assertActive(); return execution;
}
