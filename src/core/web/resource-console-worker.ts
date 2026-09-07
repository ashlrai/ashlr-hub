import { parentPort, workerData } from 'node:worker_threads';
import { readResourceJson, resourcePoolStatus } from '../resources/pool-runtime.js';
import { validateResourceObservations } from '../resources/pool-policy.js';
import { normalizeResourceConsoleRead, validateResourceConsoleReadScope, type ResourceConsoleReadScope } from './resource-console-reads.js';
import { degradedResourceConsoleEvidence, projectResourceConsoleEvidence, serializeResourceConsoleEvidence } from './resource-console-public.js';

const port = parentPort;
if (!port) throw new Error('Resource console worker requires its owning transport');
const scope = validateResourceConsoleReadScope(workerData as ResourceConsoleReadScope);
let running = false;
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const request = message as Record<string, unknown>;
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || (request.id as number) < 1) return;
  const reject = (): void => { port.postMessage({ type: 'result', id: request.id, ok: false }); };
  if (running || Object.keys(request).some((key) => !['type', 'id', 'kind', 'payload'].includes(key))) { reject(); return; }
  try { normalizeResourceConsoleRead(request.kind, request.payload); } catch { reject(); return; }
  running = true;
  try {
    let evidence;
    try {
      const incoming = validateResourceObservations(readResourceJson(scope.observationsFile), scope.pool);
      evidence = projectResourceConsoleEvidence(scope.pool, scope.bindings,
        resourcePoolStatus(scope.root, scope.pool, scope.bindings, incoming));
    } catch { evidence = degradedResourceConsoleEvidence(scope.pool, scope.bindings, new Date().toISOString()); }
    port.postMessage({ type: 'result', id: request.id, ok: true,
      value: serializeResourceConsoleEvidence(evidence, scope.pool, scope.bindings) });
  } catch { reject(); }
  finally { running = false; }
});
