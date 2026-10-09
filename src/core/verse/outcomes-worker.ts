import { parentPort, workerData } from 'node:worker_threads';
import { normalizeOutcomeOperation } from './outcomes-input.js';
import { executeOutcomeOperation } from './outcomes-operations.js';
import { readOutcomeTaskContext, validOutcomeTaskContextRequest } from './outcome-task-context.js';

// One fixed local metadata operation. No caller-selected import, graph,
// command, provider, execution directory or credential travels here.
if (!parentPort) throw new Error('Outcome metadata worker requires its port.');
try {
  const contextRead = workerData?.kind === 'task-context' && Object.keys(workerData).length === 2;
  parentPort.postMessage({ ok: true, value: contextRead ? validOutcomeTaskContextRequest(workerData.input)
    ? readOutcomeTaskContext(workerData.input) : { ok: false, reason: 'invalid' } :
    executeOutcomeOperation(normalizeOutcomeOperation(workerData)) });
} catch {
  parentPort.postMessage({ ok: false });
}
parentPort.close();
