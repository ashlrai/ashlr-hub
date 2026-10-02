import { parentPort, workerData } from 'node:worker_threads';
import { normalizeOutcomeOperation } from './outcomes-input.js';
import { executeOutcomeOperation } from './outcomes-operations.js';

// One fixed local metadata operation. No caller-selected import, graph,
// command, provider, execution directory or credential travels here.
if (!parentPort) throw new Error('Outcome metadata worker requires its port.');
try {
  parentPort.postMessage({ ok: true, value: executeOutcomeOperation(normalizeOutcomeOperation(workerData)) });
} catch {
  parentPort.postMessage({ ok: false });
}
parentPort.close();
