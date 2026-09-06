import { parentPort, workerData } from 'node:worker_threads';
import type { AshlrConfig } from '../types.js';
import { buildSnapshot } from '../dashboard.js';
import { buildRollup } from '../observability/rollup.js';
import { listProposals } from '../inbox/store.js';
import { listRuns } from '../run/orchestrator.js';
import { listSwarms } from '../swarm/store.js';
import { readFleetDaemonStatus } from '../fleet/status.js';
import { readPublicDaemonObservation } from '../daemon/public-observation.js';
import { buildControlSnapshot, buildFleetActivity } from './control.js';
import { getCachedFleetStatus } from './fleet-status-cache.js';
import { normalizeReadProjectionPayload, type ReadProjectionKind, type ReadProjectionPayloads, type ReadProjectionRequest } from './read-projections.js';

const port = parentPort;
const cfg = (workerData as { cfg?: AshlrConfig } | undefined)?.cfg;
if (!port || !cfg || typeof cfg !== 'object') throw new Error('Read projection worker requires its server configuration');
let running = false;

async function project(kind: ReadProjectionKind, payload: ReadProjectionPayloads[ReadProjectionKind]): Promise<unknown> {
  switch (kind) {
    case 'snapshot': return await buildSnapshot(cfg!);
    case 'control': return await buildControlSnapshot(cfg!);
    case 'fleet': return await getCachedFleetStatus(cfg!);
    case 'fleet-activity': return await buildFleetActivity(cfg!);
    case 'proposals': return listProposals();
    case 'runs': return listRuns({ limit: 200 });
    case 'swarms': return listSwarms({ limit: 200 });
    case 'pulse': {
      const options = payload as ReadProjectionPayloads['pulse'];
      return buildRollup(options.window, cfg!, options.project === undefined ? undefined : { project: options.project });
    }
    case 'daemon-observation': {
      try { return readPublicDaemonObservation((await readFleetDaemonStatus()).daemon); }
      catch { return readPublicDaemonObservation(undefined); }
    }
  }
}

port.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const request = value as ReadProjectionRequest;
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || request.id < 1) return;
  const reject = (): void => port.postMessage({ type: 'result', id: request.id, ok: false, error: 'Read projection unavailable' });
  if (running) { reject(); return; }
  let payload: ReadProjectionPayloads[ReadProjectionKind];
  try { payload = normalizeReadProjectionPayload(request.kind, request.payload); }
  catch { reject(); return; }
  running = true;
  void project(request.kind, payload).then((result) => {
    running = false;
    port.postMessage({ type: 'result', id: request.id, ok: true, value: result });
  }, () => {
    running = false;
    reject();
  }).catch(() => {
    running = false;
    // Message serialization failures are returned as generic read unavailability.
    try { reject(); } catch { /* Parent exit is terminal; do not manufacture a projection. */ }
  });
});
