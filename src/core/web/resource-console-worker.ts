import { parentPort, workerData } from 'node:worker_threads';
import { types } from 'node:util';
import { mergeResourceObservations, readResourceJson, resourcePoolStatus } from '../resources/pool-runtime.js';
import { validateResourceObservations } from '../resources/pool-policy.js';
import { normalizeResourceConsoleRead, unavailableManagedResourceWorkers, validateResourceConsoleReadScope,
  withholdResourceConsoleWorkers, type ResourceConsoleReadScope } from './resource-console-reads.js';
import { degradedResourceConsoleEvidence, projectResourceConsoleEvidence, serializeResourceConsoleEvidence } from './resource-console-public.js';

const port = parentPort;
if (!port) throw new Error('Resource console worker requires its owning transport');
const scope = validateResourceConsoleReadScope(workerData as ResourceConsoleReadScope);
let running = false;
port.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message) || types.isProxy(message) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(message))) return;
  const request = message as Record<string, unknown>;
  if (!['type', 'id'].every((key) => Object.hasOwn(request, key) && 'value' in Object.getOwnPropertyDescriptor(request, key)!)) return;
  if (request.type !== 'read' || !Number.isSafeInteger(request.id) || (request.id as number) < 1) return;
  const reject = (): void => { port.postMessage({ type: 'result', id: request.id, ok: false }); };
  if (running || Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !['type', 'id', 'kind', 'payload'].includes(key) ||
    !('value' in Object.getOwnPropertyDescriptor(request, key)!))) { reject(); return; }
  let managed;
  try { managed = normalizeResourceConsoleRead(request.kind, request.payload, scope); } catch { reject(); return; }
  running = true;
  try {
    let evidence;
    try {
      const base = validateResourceObservations(readResourceJson(scope.observationsFile), scope.pool);
      const incoming = managed ? mergeResourceObservations(base, managed.observations) : base;
      // A queued IPC read may outlive its captured freshness. Recheck the exact
      // managed readings here; a newer owner file is not a native refresh.
      const unavailable = managed ? unavailableManagedResourceWorkers(scope, managed, Date.now()) : [];
      evidence = projectResourceConsoleEvidence(scope.pool, scope.bindings,
        managed ? resourcePoolStatus(scope.root, scope.pool, scope.bindings, incoming, unavailable)
          : resourcePoolStatus(scope.root, scope.pool, scope.bindings, incoming));
      if (managed) evidence = withholdResourceConsoleWorkers(evidence, unavailableManagedResourceWorkers(scope, managed, Date.now()));
    } catch { evidence = degradedResourceConsoleEvidence(scope.pool, scope.bindings, new Date().toISOString()); }
    port.postMessage({ type: 'result', id: request.id, ok: true,
      value: serializeResourceConsoleEvidence(evidence, scope.pool, scope.bindings) });
  } catch { reject(); }
  finally { running = false; }
});
