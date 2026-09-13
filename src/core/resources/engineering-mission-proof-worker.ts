/** Fixed read-only entrypoint; no caller-supplied module, code or effect method. */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { checkResourceEngineeringAutonomousSetup } from './engineering-autonomous-setup.js';
import { checkResourceEngineeringPredecessor } from './engineering-predecessor-check.js';
import { createEngineeringWorkerRpcClient, EngineeringWorkerRpcError } from './engineering-worker-rpc.js';
import { createWorkerWorkspaceProofContext } from './workspace-proof-context.js';
import type { EngineeringMissionProofRequest } from './engineering-mission-proof.js';

if (isMainThread || !parentPort) throw new Error('Mission proof requires its worker');
const port = parentPort;
try {
  if (!workerData || Object.keys(workerData).sort().join(',') !== 'closeBuffer,hasCustody,request,schemaVersion' ||
    workerData.schemaVersion !== 1 || typeof workerData.hasCustody !== 'boolean' ||
    !(workerData.closeBuffer instanceof SharedArrayBuffer)) throw new Error('Invalid proof worker');
  const client = createEngineeringWorkerRpcClient({ port, closeFlag: new Int32Array(workerData.closeBuffer) });
  const custody = workerData.hasCustody ? createWorkerWorkspaceProofContext(client) : undefined;
  const request = workerData.request as EngineeringMissionProofRequest;
  if (!request || Object.keys(request).sort().join(',') !== 'input,kind' || !['setup', 'predecessor'].includes(request.kind)) throw new Error('Invalid proof request');
  if (client.isClosed()) throw new Error('Proof stopped');
  const value = request.kind === 'setup' ? checkResourceEngineeringAutonomousSetup(request.input, custody) :
    checkResourceEngineeringPredecessor(request.input, [], custody);
  if (client.isClosed()) throw new Error('Proof stopped');
  port.postMessage({ type: 'mission-proof-result', ok: true, value });
} catch (error) {
  const reason = error instanceof EngineeringWorkerRpcError ? error.code === 'INVALID_DATA' ? 'rpc-invalid-data' : 'rpc-unavailable' :
    error instanceof Error && error.message === 'Workspace state changed during setup' ? 'workspace-state-changed' : 'proof-refused';
  const stack = error instanceof Error ? error.stack?.split('\n').filter(line => !/\bat (?:fail|requireEvidence|unavailable)\b/.test(line)).join('\n') : undefined;
  const frame = stack?.match(/\/(?:src|dist)\/core\/(?:[a-z-]+\/)*([a-z][a-z0-9-]{0,80}\.(?:ts|js)):(\d{1,6}):/);
  const location = frame ? `${frame[1]}:${frame[2]}` : undefined;
  // Only fixed reason codes cross the boundary, never paths or provider text.
  port.postMessage({ type: 'mission-proof-result', ok: false, reason, ...(location ? { location } : {}) });
}
finally { port.close(); }
