import type { WorkerOptions } from 'node:worker_threads';
import { createBoundedReadWorker, ReadProjectionError, type ReadProjectionWorkerHandle } from './bounded-read-worker.js';
export { ReadProjectionError, type ReadProjectionWorkerHandle } from './bounded-read-worker.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AshlrConfig, ActivityRollup, Proposal } from '../types.js';
import type { DashboardSnapshotWithSourceQuality } from '../dashboard.js';
import type { PublicDaemonObservation } from '../daemon/public-observation.js';
import type { ControlSnapshot, FleetActivitySnapshot } from './control.js';
import type { CachedFleetStatus } from './fleet-status-cache.js';
import type { listRuns } from '../run/orchestrator.js';
import type { listSwarms } from '../swarm/store.js';

/** Fixed read operations only: there is no caller-selected module, code, or argv. */
export interface ReadProjectionResults {
  snapshot: DashboardSnapshotWithSourceQuality;
  control: ControlSnapshot;
  fleet: CachedFleetStatus;
  pulse: ActivityRollup;
  'fleet-activity': FleetActivitySnapshot;
  proposals: Proposal[];
  runs: ReturnType<typeof listRuns>;
  swarms: ReturnType<typeof listSwarms>;
  'daemon-observation': PublicDaemonObservation;
}

export interface ReadProjectionPayloads {
  snapshot: undefined;
  control: undefined;
  fleet: undefined;
  pulse: { window: '1d' | '7d' | '30d'; project?: string };
  'fleet-activity': undefined;
  proposals: undefined;
  runs: undefined;
  swarms: undefined;
  'daemon-observation': undefined;
}

export type ReadProjectionKind = keyof ReadProjectionResults;
export interface ReadProjectionReader {
  read<K extends ReadProjectionKind>(kind: K, payload?: ReadProjectionPayloads[K]): Promise<ReadProjectionResults[K]>;
  /** Reject pending projections and discard the worker's read caches. */
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

export interface ReadProjectionWorkerOptions {
  /** Includes the active projection and the bounded queue. Default 8, maximum 32. */
  maxPending?: number;
  /** Time from enqueue to result, including queue wait. Default/max 60 seconds. */
  timeoutMs?: number;
  /** Test seam: compiled production always uses the fixed Worker URL below. */
  _workerFactory?: (url: URL, options: WorkerOptions) => ReadProjectionWorkerHandle;
}

export interface ReadProjectionRequest {
  type: 'read';
  id: number;
  kind: ReadProjectionKind;
  payload?: ReadProjectionPayloads[ReadProjectionKind];
}

const KINDS: ReadonlySet<string> = new Set<ReadProjectionKind>([
  'snapshot', 'control', 'fleet', 'pulse', 'fleet-activity', 'proposals', 'runs', 'swarms', 'daemon-observation',
]);

/** Shared validation keeps even malformed internal messages inside the read allowlist. */
export function normalizeReadProjectionPayload(kind: unknown, payload: unknown): ReadProjectionPayloads[ReadProjectionKind] {
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new ReadProjectionError('Unsupported read projection', 'READ_PROJECTION_INVALID_REQUEST');
  if (kind !== 'pulse') {
    if (payload !== undefined) throw new ReadProjectionError('Read projection does not accept a payload', 'READ_PROJECTION_INVALID_REQUEST');
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReadProjectionError('Pulse requires a valid window', 'READ_PROJECTION_INVALID_REQUEST');
  }
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'window' && key !== 'project') ||
      typeof value.window !== 'string' || !['1d', '7d', '30d'].includes(value.window) ||
      (value.project !== undefined && (typeof value.project !== 'string' || value.project.length > 512 ||
        [...value.project].some((character) => character.charCodeAt(0) < 32)))) {
    throw new ReadProjectionError('Invalid pulse projection options', 'READ_PROJECTION_INVALID_REQUEST');
  }
  return { window: value.window as '1d' | '7d' | '30d', ...(value.project === undefined ? {} : { project: value.project as string }) };
}

function workerEntrypoint(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === 'file:' && moduleUrl.pathname.endsWith('/read-projections.ts')) {
    // `npm run dev` runs the source tree, where sibling .js files do not exist.
    // Register the installed dev-only loader inside the thread before loading
    // our fixed TS entry; inheriting --import tsx does not cover worker imports.
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./read-projection-worker.ts', import.meta.url).href;
    const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`;
    return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
  }
  // npm dist and Bun's sibling compiled shim use the same fixed module name.
  return new URL('./read-projection-worker.js', import.meta.url);
}

/**
 * One lazily-created thread per HTTP server moves existing synchronous reads
 * off its event loop. Read algorithms and their CLI callers remain unchanged.
 * Results are coalesced only while pending; freshness caches belong to callers.
 */
export function createReadProjectionWorker(cfg: AshlrConfig, options: ReadProjectionWorkerOptions = {}): ReadProjectionReader {
  return createBoundedReadWorker({ ...options, workerEntrypoint, workerData: { cfg },
    normalize: normalizeReadProjectionPayload }) as ReadProjectionReader;
}
