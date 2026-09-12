/** Read-only fixed entrypoint: no coordinator construction, ownership or dispatch. */
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from '../universe/artifacts.js';
import { readResourceJson } from './pool-runtime.js';
import { EngineeringSuccessorJournalReadError, projectEngineeringSuccessorJournal, type ResourceEngineeringSuccessorJournalScope } from './engineering-successor-store.js';

const port = parentPort;
const data = workerData as { schemaVersion: number; scope: ResourceEngineeringSuccessorJournalScope; configFile: string };
if (!port || !data || data.schemaVersion !== 1 || Object.keys(data).length !== 3 ||
    !data.scope || typeof data.configFile !== 'string') throw new Error('Invalid successor observation worker scope');
const expectedConfigDigest = digest(canonical(data.scope.config));
function checkConfig(): void {
  if (digest(canonical(readResourceJson(data.configFile, 16 * 1024))) !== expectedConfigDigest) throw new Error('Successor configuration changed');
}
async function sampleSettledJournal() {
  const deadline = performance.now() + 500;
  let pending: EngineeringSuccessorJournalReadError | undefined;
  for (let attempt = 0; ; attempt++) {
    if (pending && performance.now() >= deadline) throw pending;
    checkConfig();
    try {
      const value = projectEngineeringSuccessorJournal(data.scope);
      checkConfig(); return value;
    } catch (error) {
      // Publication can leave a fully valid record set momentarily writer-locked.
      // Wait only for that classified race, never for corrupt/staged/unsafe data.
      // Every sample repeats the complete proof; no old result or ownership is used.
      if (!(error instanceof EngineeringSuccessorJournalReadError) || !error.canRetry || attempt >= 9 || performance.now() >= deadline) throw error;
      pending = error;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
    }
  }
}
let sequence = 0; let running = false;
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const request = message as Record<string, unknown>;
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || Number(request.id) <= sequence) return;
  sequence = Number(request.id);
  const reject = () => port.postMessage({ type: 'result', id: request.id, ok: false });
  if (running || Object.keys(request).length !== 4 || request.kind !== 'snapshot' ||
      !Number.isSafeInteger(request.payload) || Number(request.payload) < 1) { reject(); return; }
  running = true;
  void sampleSettledJournal().then(value => {
    port.postMessage({ type: 'result', id: request.id, ok: true, value });
  }, reject).catch(() => {
    // Never return paths, proposal/source text or partially verified records.
    try { reject(); } catch { /* Parent exit is terminal for this read-only worker. */ }
  }).finally(() => { running = false; });
});
