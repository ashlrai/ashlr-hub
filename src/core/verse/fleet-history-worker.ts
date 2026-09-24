/**
 * Fixed-operation worker for the fleet-history scorecard trend (V3.10, A8).
 *
 * WHY A THREAD: `snapshotScorecardIfDue` computes two full fleet scorecards
 * (measured ~0.5 s of synchronous proposal/decision reads on a real inbox) and
 * the history read goes through a synchronous helper process. Either would
 * stall every Verse request behind it, so fleet-history.ts runs them here.
 *
 * The only operation is `scorecard`: the payload is re-validated on this side
 * too, so even a malformed internal message cannot select code, paths or argv.
 */
import { parentPort } from 'node:worker_threads';
import { runScorecardHistoryMaintenance } from '../fleet/scorecard.js';
import { normalizeFleetHistoryWorkerRequest } from './fleet-history-worker-protocol.js';

const port = parentPort;
if (!port) throw new Error('fleet-history worker must run inside a worker thread');

port.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const request = value as { type?: unknown; id?: unknown; kind?: unknown; payload?: unknown };
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || (request.id as number) < 1) return;
  const id = request.id as number;
  let payload: ReturnType<typeof normalizeFleetHistoryWorkerRequest>;
  try {
    payload = normalizeFleetHistoryWorkerRequest(request.kind, request.payload);
  } catch {
    port.postMessage({ type: 'result', id, ok: false, error: 'invalid request' });
    return;
  }
  try {
    // Synchronous by design: this thread exists to absorb the blocking reads.
    const result = runScorecardHistoryMaintenance(payload);
    port.postMessage({ type: 'result', id, ok: true, value: result });
  } catch {
    try { port.postMessage({ type: 'result', id, ok: false, error: 'unavailable' }); } catch { /* parent gone */ }
  }
});
