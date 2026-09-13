/** Fixed effectful entrypoint. Stop unwinds guards and owned locks before exit. */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { canonical } from '../universe/artifacts.js';
import { prepareResourceEngineeringAutonomousSetupInWorker } from './engineering-autonomous-setup.js';
import { checkResourceEngineeringPredecessor } from './engineering-predecessor-check.js';
import { createEngineeringWorkerRpcClient } from './engineering-worker-rpc.js';
import { createWorkerSetupExecutionContext } from './engineering-setup-context.js';
import { validateEngineeringSetupRequest } from './engineering-setup.js';

if (isMainThread || !parentPort) throw new Error('Setup requires its worker');
const port = parentPort;
try {
  if (!workerData || Object.keys(workerData).sort().join(',') !== 'closeBuffer,request,schemaVersion' || workerData.schemaVersion !== 1 ||
    !(workerData.closeBuffer instanceof SharedArrayBuffer)) throw new Error('Invalid setup worker');
  const client = createEngineeringWorkerRpcClient({ port, closeFlag: new Int32Array(workerData.closeBuffer) });
  const request = validateEngineeringSetupRequest(workerData.request);
  const context = createWorkerSetupExecutionContext(request, client);
  const result = prepareResourceEngineeringAutonomousSetupInWorker(request.input, context, (locks, custody) => {
    if (client.isClosed()) throw new Error('Setup stopped');
    if (request.predecessor) {
      const proof = checkResourceEngineeringPredecessor(request.predecessor.options, locks, custody);
      if (proof.status !== 'verified' || proof.continuation !== 'eligible' ||
        canonical(proof.tip) !== canonical(request.predecessor.expectedTip)) throw new Error('Setup predecessor changed');
    }
    if (client.isClosed()) throw new Error('Setup stopped');
  });
  if (client.isClosed()) throw new Error('Setup stopped');
  port.postMessage({ type: 'engineering-setup-result', ok: true, value: result });
} catch (error) {
  const reason = error instanceof Error && error.message === 'Setup ownership cleanup could not be confirmed' ? 'setup-cleanup-unconfirmed' : 'setup-refused';
  port.postMessage({ type: 'engineering-setup-result', ok: false, reason });
} finally { port.close(); }
