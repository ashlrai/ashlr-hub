import { createRequire } from 'node:module';
import { isAbsolute, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoundedReadWorker, ReadProjectionError, type BoundedReadWorkerOptions } from './bounded-read-worker.js';
import { validateUniverseConsoleResponse } from './universe-console-public.js';

export interface UniverseConsoleReader {
  overview(): Promise<string>;
  graph(universeId: string): Promise<string>;
  campaignReadiness(campaignId: string): Promise<string>;
  close(): Promise<void>;
}

export function validateUniverseConsoleRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 ||
    [...value].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    resolve(value) === parse(value).root) throw new Error('Universe console requires an explicit absolute non-root path');
  return resolve(value);
}

export function normalizeUniverseConsoleRead(kind: unknown, payload: unknown): undefined | { universeId: string } | { campaignId: string } {
  if (kind === 'overview' && payload === undefined) return undefined;
  if (kind === 'graph' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    if (Object.keys(value).length === 1 && typeof value.universeId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.universeId)) return { universeId: value.universeId };
  }
  if (kind === 'campaign-readiness' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    if (Object.keys(value).length === 1 && Object.hasOwn(value, 'campaignId') && typeof value.campaignId === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.campaignId)) return { campaignId: value.campaignId };
  }
  throw new ReadProjectionError('Invalid Universe console read', 'READ_PROJECTION_INVALID_REQUEST');
}

function workerEntrypoint(): URL {
  if (import.meta.url.endsWith('/universe-console-reads.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./universe-console-worker.ts', import.meta.url).href;
    return new URL(`data:text/javascript,${encodeURIComponent(`import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`)}`);
  }
  return new URL('./universe-console-worker.js', import.meta.url);
}

/** Root is pinned in workerData, never taken from a browser request or default configuration. */
export function createUniverseConsoleReader(root: string, options: Pick<BoundedReadWorkerOptions,
  'maxPending' | 'timeoutMs' | '_workerFactory'> = {}): UniverseConsoleReader {
  const transport = createBoundedReadWorker({ ...options, workerEntrypoint,
    workerData: { root: validateUniverseConsoleRoot(root) }, normalize: normalizeUniverseConsoleRead,
    timeoutMs: options.timeoutMs ?? 30_000 });
  return { overview: () => transport.read('overview').then(validateUniverseConsoleResponse),
    graph: (universeId) => transport.read('graph', { universeId }).then(validateUniverseConsoleResponse),
    campaignReadiness: (campaignId) => transport.read('campaign-readiness', { campaignId }).then(validateUniverseConsoleResponse),
    close: () => transport.close() };
}
