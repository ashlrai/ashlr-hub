import { parentPort, workerData } from 'node:worker_threads';
import { readUniverseOverview } from '../universe/overview.js';
import { readUniverseGraph } from '../universe/graph-reader.js';
import { normalizeUniverseConsoleRead, validateUniverseConsoleRoot } from './universe-console-reads.js';
import { serializeUniverseConsoleGraph, serializeUniverseConsoleOverview } from './universe-console-public.js';

const port = parentPort;
const root = validateUniverseConsoleRoot((workerData as { root?: unknown } | undefined)?.root);
if (!port) throw new Error('Universe console worker requires its owning transport');
let running = false;
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const request = message as Record<string, unknown>;
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || (request.id as number) < 1) return;
  const reject = (): void => { port.postMessage({ type: 'result', id: request.id, ok: false }); };
  if (running || Object.keys(request).some((key) => !['type', 'id', 'kind', 'payload'].includes(key))) { reject(); return; }
  running = true;
  try {
    const payload = normalizeUniverseConsoleRead(request.kind, request.payload);
    const value = request.kind === 'overview'
      ? serializeUniverseConsoleOverview(readUniverseOverview({ root }))
      : serializeUniverseConsoleGraph(readUniverseGraph(payload!.universeId, { root }));
    port.postMessage({ type: 'result', id: request.id, ok: true, value });
  } catch { reject(); }
  finally { running = false; }
});
