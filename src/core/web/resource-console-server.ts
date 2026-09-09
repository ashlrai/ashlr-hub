import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResourcePool, validateResourceObservations } from '../resources/pool-policy.js';
import { readResourceJson, resourcePoolStatus, readResourcePoolAllocation, setResourcePoolAllocation,
  readResourceWorkerAccess, setResourceWorkerAccess } from '../resources/pool-runtime.js';
import { validateResourceBindings } from '../resources/worker.js';
import { createResourcePoolSupervisor, ResourceSupervisorError } from '../resources/pool-supervisor.js';
import { createResourceQuotaRefresher, validateResourceQuotaRefreshConfig, type ResourceQuotaRefresher } from '../resources/quota-refresh.js';
import { acquireResourceQuotaRefreshLease, ResourceQuotaRefreshLeaseError, type ResourceQuotaRefreshLease } from '../resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence } from '../resources/quota-shared-evidence.js';
import { createResourceConnectionMonitor, validateResourceConnectionConfig, type ResourceConnectionMonitor } from '../resources/connection-monitor.js';
import { createNativeMetadataCoordinator, type NativeMetadataCoordinator } from '../resources/metadata-coordinator.js';
import type { ResourceConsoleScope, ResourceConsoleTaskInput, ResourceConsoleSnapshot } from '../resources/console-types.js';
import { createResourceConsoleReader, withholdResourceConsoleWorkers } from './resource-console-reads.js';
import { createReadSessionBoundary, headerValue, requestUrl, safeEqual, sendJson } from './read-session.js';
import { validateUniverseConsoleRoot } from './universe-console-reads.js';
import { serveStatic } from './static.js';

export interface ResourceConsoleServerOptions {
  root: string;
  poolFile: string;
  bindingsFile: string;
  observationsFile: string;
  /** Explicit opt-in to no-generation native metadata collection. */
  quotaConfigFile?: string;
  connectionsConfigFile?: string;
  allocationControls?: boolean;
  port?: number;
  execute?: boolean;
  workspace?: string;
  maxParallel?: number;
  signal?: AbortSignal;
}
export interface ResourceConsoleServerHandle {
  url: string;
  consoleUrl: string;
  port: number;
  readToken: string;
  controlToken: string | null;
  scope: ResourceConsoleScope;
  close(): Promise<void>;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Only authenticated, same-origin JSON requests reach this bounded reader. */
function body(req: IncomingMessage): Promise<unknown> {
  if (headerValue(req, 'content-type').toLowerCase() !== 'application/json') {
    return Promise.reject(new RequestError(415, 'Expected application/json'));
  }
  const declared = headerValue(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return Promise.reject(new RequestError(413, 'Request body exceeds the limit'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const cleanup = () => {
      clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('aborted', failed); req.removeListener('close', closed);
    };
    const fail = (error: RequestError) => {
      if (finished) return; finished = true; cleanup(); req.resume(); reject(error);
    };
    const failed = () => fail(new RequestError(400, 'Request body unavailable'));
    const closed = () => { if (!req.complete) failed(); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(new RequestError(413, 'Request body exceeds the limit')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      if (finished) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        finished = true; cleanup(); resolve(value);
      } catch { fail(new RequestError(400, 'Malformed JSON request')); }
    };
    const timer = setTimeout(() => fail(new RequestError(408, 'Request body timed out')), 5_000);
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed); req.once('close', closed);
    // A rejected body can still emit a socket error while being drained.
    req.once('close', () => req.removeListener('error', failed));
    if (req.aborted || req.destroyed) failed();
  });
}

function sendSnapshot(res: ServerResponse, value: unknown): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) throw new RequestError(503, 'Resource evidence exceeds the response limit');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(json) }); res.end(json);
}

/** One fixed pool; independent read and control capabilities. No default dashboard imports. */
export async function startResourceConsoleServer(options: ResourceConsoleServerOptions): Promise<ResourceConsoleServerHandle> {
  const signal = options.signal;
  const root = validateUniverseConsoleRoot(options.root);
  const poolFile = validateUniverseConsoleRoot(options.poolFile);
  const bindingsFile = validateUniverseConsoleRoot(options.bindingsFile);
  const observationsFile = validateUniverseConsoleRoot(options.observationsFile);
  const quotaConfigFile = options.quotaConfigFile === undefined ? null : validateUniverseConsoleRoot(options.quotaConfigFile);
  const connectionsConfigFile = options.connectionsConfigFile === undefined ? null : validateUniverseConsoleRoot(options.connectionsConfigFile);
  const requestedPort = options.port ?? 0;
  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535 ||
    !Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 16 ||
    (options.execute !== undefined && typeof options.execute !== 'boolean') ||
    (options.allocationControls !== undefined && typeof options.allocationControls !== 'boolean') ||
    (options.execute === true ? !options.workspace : options.workspace !== undefined || options.maxParallel !== undefined)) {
    throw new Error('Invalid resource console options');
  }
  const workspace = options.execute ? validateUniverseConsoleRoot(options.workspace) : null;
  if (workspace && [root, poolFile, bindingsFile, observationsFile, ...(quotaConfigFile ? [quotaConfigFile] : []),
    ...(connectionsConfigFile ? [connectionsConfigFile] : [])].some((target) => {
    const nested = relative(workspace, target);
    return nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
  })) throw new Error('Resource control files must remain outside the writable workspace');
  if (signal?.aborted) throw new Error('Resource console startup cancelled');
  const pool = validateResourcePool(readResourceJson(poolFile));
  const bindings = validateResourceBindings(readResourceJson(bindingsFile), pool);
  const quotaConfig = quotaConfigFile ? validateResourceQuotaRefreshConfig(readResourceJson(quotaConfigFile), pool, bindings) : null;
  const connectionsConfig = connectionsConfigFile ? validateResourceConnectionConfig(readResourceJson(connectionsConfigFile)) : null;
  if (quotaConfig) validateResourceObservations(readResourceJson(observationsFile), pool);
  const reader = createResourceConsoleReader({ root, pool, bindings, observationsFile,
    ...(quotaConfig ? { managedWorkerIds: quotaConfig.workers.map((row) => row.workerId) } : {}) });
  const sessions = createReadSessionBoundary({ cookieName: `ashlr_resources_${randomBytes(12).toString('hex')}` });
  const controlToken = options.execute || options.allocationControls ? randomBytes(32).toString('hex') : null;
  const scope: ResourceConsoleScope = { schemaVersion: 1, mode: 'resource-pool', root, poolId: pool.id,
    readOnly: !options.execute, workspace, maxParallel: options.execute ? maxParallel : 0, maxQueued: options.execute ? 64 : 0,
    ...(quotaConfig ? { quotaRefreshEnabled: true } : {}), ...(connectionsConfig ? { connectionsEnabled: true } : {}),
    ...(options.allocationControls ? { allocationWritable: true } : {}) };
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'public');
  let supervisor: Awaited<ReturnType<typeof createResourcePoolSupervisor>> | null = null;
  let quotaRefresher: ResourceQuotaRefresher | null = null;
  let quotaLease: ResourceQuotaRefreshLease | null = null;
  let connectionMonitor: ResourceConnectionMonitor | null = null;
  let metadataCoordinator: NativeMetadataCoordinator | null = null;
  let quotaHeartbeat: ReturnType<typeof setInterval> | null = null;
  let quotaPublicationFailed = false;
  let metadataCollector: ResourceConsoleSnapshot['metadataCollector'];
  let origin = ''; let port = 0; let closing: Promise<void> | null = null; let ready = false;

  // Configured-but-blocked collection remains managed. Never fall back to
  // owner-supplied observations as if they were a current native quota read.
  function managedQuotaEvidence() {
    if (!quotaConfig) return undefined;
    return quotaRefresher ? { observations: quotaRefresher.readObservations([]),
      unavailableWorkerIds: quotaRefresher.unavailableWorkerIds() } : {
      observations: [], unavailableWorkerIds: quotaConfig.workers.map((row) => row.workerId),
    };
  }

  function collectorLifecycle() {
    if (metadataCollector?.state === 'running' && (quotaRefresher?.snapshot().state === 'closed' ||
      connectionMonitor?.snapshot().accounts.some((row) => row.reason === 'connection-monitor-stopped'))) {
      metadataCollector = { state: 'blocked', reasonCode: 'collector-unavailable', sampledAt: new Date().toISOString() };
    }
    return metadataCollector ? { ...metadataCollector,
      ...(metadataCollector.recovery ? { recovery: { ...metadataCollector.recovery } } : {}) } : undefined;
  }

  function publishQuotaEvidence(): void {
    if (!quotaConfig || !quotaLease || !quotaRefresher || quotaPublicationFailed) return;
    try {
      publishSharedQuotaEvidence({ root, pool, bindings, config: quotaConfig, lease: quotaLease,
        state: quotaRefresher.snapshot().state, evidence: {
          observations: quotaRefresher.readObservations([]),
          // Allocation may change independently; the consuming admission lock
          // applies the current ceiling, rather than a cached policy veto.
          unavailableWorkerIds: quotaRefresher.unavailableWorkerIds(true),
        } });
    } catch {
      // Invalidate the preceding success immediately, even if native teardown
      // is still pending. The durable marker survives for reconciliation.
      quotaPublicationFailed = true;
      metadataCollector = { state: 'blocked', reasonCode: 'collector-unavailable', sampledAt: new Date().toISOString() };
      if (quotaHeartbeat !== null) { clearInterval(quotaHeartbeat); quotaHeartbeat = null; }
      metadataCoordinator?.abort();
      try { quotaLease.close(true); } catch { /* Keep the terminal fence. */ }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'");
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(headerValue(req, 'host'))) {
      throw new RequestError(403, 'Forbidden: invalid Host header');
    }
    if (req.headers.origin !== undefined && headerValue(req, 'origin') !== origin) {
      throw new RequestError(403, 'Forbidden: invalid Origin header');
    }
    const url = requestUrl(req);
    if (!url || url.search) throw new RequestError(400, 'This console does not accept query parameters');
    const method = (req.method ?? 'GET').toUpperCase();
    if (url.pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'Method not allowed');
      sendJson(res, 200, { ok: true }); return;
    }
    if (sessions.handleSession(req, res, url)) return;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (method === 'POST') {
        if (url.pathname === '/api/resources/worker-access') {
          if (!options.allocationControls || !controlToken) throw new RequestError(403, 'Fleet access controls are disabled');
          if (!safeEqual(headerValue(req, 'x-ashlr-token'), controlToken)) throw new RequestError(401, 'Control token required');
          const input = await body(req);
          if (!exact(input, ['pausedWorkerIds', 'expectedRevision']) || !Array.isArray(input.pausedWorkerIds) ||
            input.pausedWorkerIds.length > pool.workers.length || input.pausedWorkerIds.some((id) =>
              typeof id !== 'string' || !pool.workers.some((worker) => worker.id === id)) ||
            new Set(input.pausedWorkerIds).size !== input.pausedWorkerIds.length ||
            !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
            throw new RequestError(400, 'Expected enrolled workers and a current access revision');
          }
          if (closing) throw new RequestError(503, 'Console is closing');
          try {
            const workerAccess = setResourceWorkerAccess(root, pool, bindings, input.pausedWorkerIds as string[], Number(input.expectedRevision));
            sendJson(res, 200, { workerAccess });
          } catch { throw new RequestError(409, 'Fleet access changed or is unavailable; refresh before saving'); }
          return;
        }
        if (url.pathname === '/api/resources/allocation') {
          if (!options.allocationControls || !controlToken) throw new RequestError(403, 'Allocation controls are disabled');
          if (!safeEqual(headerValue(req, 'x-ashlr-token'), controlToken)) throw new RequestError(401, 'Control token required');
          const input = await body(req);
          if (!exact(input, ['ceilingPercent', 'expectedRevision']) || !Number.isSafeInteger(input.ceilingPercent) ||
            Number(input.ceilingPercent) < 0 || Number(input.ceilingPercent) > 100 || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
            throw new RequestError(400, 'Expected a bounded allocation and current revision');
          }
          if (closing) throw new RequestError(503, 'Console is closing');
          try {
            const allocation = setResourcePoolAllocation(root, pool, bindings, Number(input.ceilingPercent), Number(input.expectedRevision));
            sendJson(res, 200, { allocation });
          } catch { throw new RequestError(409, 'Allocation changed or is unavailable; refresh before saving'); }
          return;
        }
        if (!supervisor || !controlToken) throw new RequestError(403, 'Execution is disabled for this console');
        if (!safeEqual(headerValue(req, 'x-ashlr-token'), controlToken)) throw new RequestError(401, 'Control token required');
        const cancel = /^\/api\/resources\/tasks\/([a-z0-9][a-z0-9_-]{0,63})\/cancel$/.exec(url.pathname);
        if (url.pathname !== '/api/resources/tasks' && url.pathname !== '/api/resources/queue' && !cancel) {
          throw new RequestError(404, 'Unknown resource control route');
        }
        const input = await body(req);
        if (closing) throw new RequestError(503, 'Console is closing');
        if (url.pathname === '/api/resources/tasks') {
          if (!exact(input, ['id', 'prompt', 'allowedWorkerIds', 'mode', 'timeoutMs', 'maxOutputTokens'])) {
            throw new RequestError(400, 'Expected a scoped task without filesystem or command fields');
          }
          const job = supervisor.submit(input as unknown as ResourceConsoleTaskInput);
          sendJson(res, 202, { job });
        } else if (cancel) {
          if (!exact(input, [])) throw new RequestError(400, 'Cancel expects an empty JSON object');
          sendJson(res, 200, { job: supervisor.cancel(cancel[1]!) });
        } else {
          if (!exact(input, ['paused']) || typeof input.paused !== 'boolean') throw new RequestError(400, 'Expected paused boolean');
          sendJson(res, 200, { supervisor: supervisor.setPaused(input.paused) });
        }
        return;
      }
      if (!sessions.authority(req, url)) {
        sendJson(res, 401, { error: 'Read session required' }, { Vary: 'Cookie, X-Ashlr-Token, X-Ashlr-Read-Client' }); return;
      }
      if (method !== 'GET') throw new RequestError(405, 'Method not allowed');
      if (url.pathname === '/api/resources/console') { sendJson(res, 200, scope); return; }
      if (url.pathname === '/api/resources') {
        for (let attempt = 0; attempt < 2; attempt++) {
          const allocation = readResourcePoolAllocation(root, pool, bindings);
          const workerAccess = readResourceWorkerAccess(root, pool, bindings);
          const managed = managedQuotaEvidence();
          let evidence = await reader.snapshot(managed);
          if (closing) throw new RequestError(503, 'Console is closing');
          if (JSON.stringify(allocation) !== JSON.stringify(readResourcePoolAllocation(root, pool, bindings))) continue;
          if (JSON.stringify(workerAccess) !== JSON.stringify(readResourceWorkerAccess(root, pool, bindings))) continue;
          if (quotaConfig) {
            const current = managedQuotaEvidence()!;
            // Both successful refresh and failure can race the worker read.
            // Retry once, then withhold rather than attach newer collector
            // metadata to an earlier eligibility decision.
            if (JSON.stringify(managed) !== JSON.stringify(current)) continue;
            evidence = withholdResourceConsoleWorkers(evidence, current.unavailableWorkerIds);
          }
          // A deduplicated worker read can predate this request's policy read.
          // Reapply current pauses so a cached projection cannot show readiness.
          evidence = withholdResourceConsoleWorkers(evidence, workerAccess.pausedWorkerIds);
          const ceiling = allocation.ceilingPercent;
          if (ceiling !== null && ceiling < 100) {
            const now = Date.now();
            // This is a subtractive display gate only: preserve the sampled
            // plan, but never pair old eligibility with a newly lowered ceiling.
            // Check every alias; withholding expands to its shared capacity.
            const unavailable = pool.workers.filter((worker) => {
              if (worker.provider === 'local') return false;
              const row = evidence.observations.find((item) => item.workerId === worker.id);
              return ceiling === 0 || !row || Date.parse(row.observedAt) > now ||
                row.updatedAt !== undefined && Date.parse(row.updatedAt) > now || Date.parse(row.expiresAt) <= now ||
                !row.windows.length || row.windows.some((window) => window.usedPercent === null ||
                  window.usedPercent >= ceiling || window.resetsAt === null || Date.parse(window.resetsAt) <= now);
            }).map((worker) => worker.id);
            evidence = withholdResourceConsoleWorkers(evidence, unavailable);
          }
          sendSnapshot(res, { ...evidence, supervisor: supervisor?.snapshot() ?? null,
            ...(metadataCollector ? { metadataCollector: collectorLifecycle() } : {}),
            ...(quotaRefresher ? { quotaRefresh: quotaRefresher.snapshot() } : {}),
            ...(connectionMonitor ? { connections: connectionMonitor.snapshot() } : {}),
            allocation, workerAccess }); return;
        }
        throw new RequestError(503, 'Resource quota or allocation evidence changed during this read');
      }
      const output = /^\/api\/resources\/tasks\/([^/]+)\/output$/.exec(url.pathname);
      if (output && ID.test(output[1]!)) {
        const value = supervisor?.output(output[1]!);
        if (!value) throw new RequestError(404, 'No retained output for this task in this console session');
        sendSnapshot(res, value); return;
      }
      throw new RequestError(404, 'Route unavailable in this scoped console');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'Method not allowed');
    if (url.pathname === '/' || url.pathname === '/resources') {
      res.writeHead(308, { Location: '/resources/' }); res.end(); return;
    }
    if (url.pathname === '/resources/' || url.pathname.startsWith('/next/assets/')) {
      const staticRequest = Object.create(req) as IncomingMessage;
      staticRequest.url = url.pathname === '/resources/' ? '/next/index.html' : url.pathname;
      if (serveStatic(staticRequest, res, assets)) return;
    }
    throw new RequestError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    if (closing || !ready) { sendJson(res, 503, { error: 'Console unavailable' }); return; }
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.end(); return; }
      if (error instanceof RequestError) { sendJson(res, error.status, { error: error.message }); return; }
      if (error instanceof ResourceSupervisorError) {
        const statuses = { INVALID_INPUT: 400, CONFLICT: 409, CAPACITY: 429, NOT_FOUND: 404, UNAVAILABLE: 503 };
        sendJson(res, statuses[error.code] ?? 503, { error: `Resource operation refused: ${error.code.toLowerCase().replaceAll('_', ' ')}` }); return;
      }
      sendJson(res, 503, { error: 'Resource evidence or operation is temporarily unavailable' });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;

  const close = (): Promise<void> => {
    if (closing) return closing;
    ready = false; sessions.clear(); signal?.removeEventListener('abort', aborted);
    if (quotaHeartbeat !== null) { clearInterval(quotaHeartbeat); quotaHeartbeat = null; }
    metadataCoordinator?.dispose();
    closing = (async () => {
      // A reader may be terminated, but task subprocesses must settle through
      // their owning supervisor before the server can declare shutdown complete.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => supervisor?.close()),
        Promise.resolve().then(() => quotaRefresher?.close()),
        Promise.resolve().then(() => connectionMonitor?.close()),
        reader.close(),
        new Promise<void>((done) => {
          if (!server.listening) { done(); return; }
          server.close(() => done()); server.closeIdleConnections(); server.closeAllConnections();
        }),
      ]);
      // Remove only our own marker and only after confirmed collector cleanup.
      // On uncertainty it stays durable even after this process exits.
      let quotaClosed = true;
      try { quotaLease?.close(quotaPublicationFailed || results[1]?.status !== 'fulfilled' || results[2]?.status !== 'fulfilled'); } catch { quotaClosed = false; }
      quotaLease = null;
      if (quotaPublicationFailed || !quotaClosed || results.some((result) => result.status === 'rejected')) throw new Error('Resource console shutdown uncertain');
    })();
    return closing;
  };
  const aborted = () => { void close().catch(() => {}); };
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener('listening', listening); reject(error); };
      const listening = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', listening); server.listen(requestedPort, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Resource console address unavailable');
    port = address.port; origin = `http://127.0.0.1:${port}`;
    if (signal?.aborted) throw new Error('Resource console startup cancelled');
    if (quotaConfig || connectionsConfig) {
      // Only explicit quota collection creates this private control root. No
      // provider is contacted before configuration, ownership and bind succeed.
      try {
        quotaLease = await acquireResourceQuotaRefreshLease(root, { signal, trackNativeActivity: true,
          scope: connectionsConfig ? 'native-connection-metadata' : 'codex-native-metadata' });
      } catch (error) {
        // Only a typed, cleanly released acquisition refusal may degrade into
        // observation mode. Cancellation and uncertain cleanup still fail startup.
        if (signal?.aborted || !(error instanceof ResourceQuotaRefreshLeaseError) || !error.safeReadOnlyFallback ||
          error.code !== 'collector-owned' && error.code !== 'reconciliation-required' && error.code !== 'collector-unavailable') throw error;
        metadataCollector = { state: 'blocked', reasonCode: error.code,
          sampledAt: new Date().toISOString(),
          ...(error.recovery ? { recovery: { reasonCode: error.recovery.reasonCode, markerVersion: error.recovery.markerVersion } } : {}) };
      }
    }
    if (workspace) supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, maxParallel,
      readObservations: () => { const base = validateResourceObservations(readResourceJson(observationsFile), pool);
        return quotaRefresher ? quotaRefresher.readObservations(base) : base; },
      ...(quotaConfig ? { readUnavailableWorkerIds: () => quotaRefresher ? quotaRefresher.unavailableWorkerIds()
        : quotaConfig.workers.map((row) => row.workerId) } : {}), signal });
    if (signal?.aborted) throw new Error('Resource console startup cancelled');
    if (quotaConfig || connectionsConfig) {
      // Execution ownership and all startup preflight must succeed before the
      // collector can schedule native metadata. Until then its workers are gated.
      resourcePoolStatus(root, pool, bindings, []);
      if (quotaLease) {
        quotaLease.markPending();
        metadataCoordinator = createNativeMetadataCoordinator({ signal,
          beginNativeActivity: () => quotaLease!.beginNativeActivity() });
        metadataCollector = { state: 'running', reasonCode: 'collector-running', sampledAt: new Date().toISOString() };
      }
    }
    if (quotaConfig && quotaLease) {
      quotaRefresher = createResourceQuotaRefresher({ pool, bindings, config: quotaConfig, cwd: root, signal,
        assertOwnership: quotaLease!.assertOwnership, coordinator: metadataCoordinator!, onChange: publishQuotaEvidence });
      publishQuotaEvidence();
      if (quotaPublicationFailed) throw new Error('Resource quota evidence publication failed');
      quotaHeartbeat = setInterval(publishQuotaEvidence, 1_000); quotaHeartbeat.unref?.();
    }
    if (connectionsConfig && quotaLease) connectionMonitor = createResourceConnectionMonitor({ config: connectionsConfig, cwd: root,
      signal, assertOwnership: quotaLease!.assertOwnership, coordinator: metadataCoordinator! });
    if (signal?.aborted) throw new Error('Resource console startup cancelled');
    signal?.addEventListener('abort', aborted, { once: true }); ready = true;
    return { url: origin, consoleUrl: `${origin}/resources/`, port, readToken: sessions.readToken, controlToken,
      scope: { ...scope }, close };
  } catch (error) { await close(); throw error; }
}
