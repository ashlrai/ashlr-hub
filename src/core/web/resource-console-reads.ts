import { createRequire } from 'node:module';
import { isAbsolute, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateResourcePool, type ResourcePool } from '../resources/pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from '../resources/worker.js';
import type { ResourceConsoleEvidence } from '../resources/console-types.js';
import { createBoundedReadWorker, ReadProjectionError, type BoundedReadWorkerOptions } from './bounded-read-worker.js';
import { degradedResourceConsoleEvidence, validateResourceConsoleResponse } from './resource-console-public.js';

export interface ResourceConsoleReadScope { root: string; pool: ResourcePool; bindings: ResourceBinding[]; observationsFile: string }
export interface ResourceConsoleReader { snapshot(): Promise<ResourceConsoleEvidence>; close(): Promise<void> }

export function validateResourceConsolePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || Buffer.byteLength(value) > 4_096 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) ||
    resolve(value) === parse(value).root) throw new Error('Resource console requires explicit absolute non-root paths');
  return resolve(value);
}

export function validateResourceConsoleReadScope(value: ResourceConsoleReadScope): ResourceConsoleReadScope {
  const root = validateResourceConsolePath(value.root); const observationsFile = validateResourceConsolePath(value.observationsFile);
  const pool = validateResourcePool(value.pool); const bindings = validateResourceBindings(value.bindings, pool);
  return { root, pool, bindings, observationsFile };
}

export function normalizeResourceConsoleRead(kind: unknown, payload: unknown): undefined {
  if (kind !== 'snapshot' || payload !== undefined) throw new ReadProjectionError('Invalid resource console read', 'READ_PROJECTION_INVALID_REQUEST');
  return undefined;
}

function workerEntrypoint(): URL {
  if (import.meta.url.endsWith('/resource-console-reads.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./resource-console-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./resource-console-worker.js', import.meta.url);
}

/** Pinned configuration and one private file; browser requests cannot choose paths. */
export function createResourceConsoleReader(options: ResourceConsoleReadScope,
  transportOptions: Pick<BoundedReadWorkerOptions, 'maxPending' | 'timeoutMs' | '_workerFactory'> = {}): ResourceConsoleReader {
  const scope = validateResourceConsoleReadScope(options);
  const transport = createBoundedReadWorker({ ...transportOptions, workerEntrypoint, workerData: scope,
    normalize: normalizeResourceConsoleRead, timeoutMs: transportOptions.timeoutMs ?? 30_000 });
  let closed = false;
  return {
    async snapshot() {
      if (closed) throw new ReadProjectionError('Resource console reader is closed', 'READ_PROJECTION_CLOSED');
      try {
        const value = await transport.read('snapshot');
        if (closed) throw new ReadProjectionError('Resource console reader is closed', 'READ_PROJECTION_CLOSED');
        return validateResourceConsoleResponse(value, scope.pool, scope.bindings);
      }
      catch (error) {
        if (closed) throw error;
        return degradedResourceConsoleEvidence(scope.pool, scope.bindings, new Date().toISOString());
      }
    },
    close() { closed = true; return transport.close(); },
  };
}
