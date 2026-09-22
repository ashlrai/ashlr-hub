import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResourcePool, validateResourceObservations } from '../resources/pool-policy.js';
import { readResourceJson, resourcePoolStatus, readResourcePoolAllocation, setResourcePoolAllocation,
  readResourceWorkerAccess, setResourceWorkerAccess, readResourceQuotaScopeAccess, setResourceQuotaScopeAccess } from '../resources/pool-runtime.js';
import { validateResourceQuotaScopeExclusions, excludedResourceQuotaScopeWorkerIds } from '../resources/quota-scope-access.js';
import { validateResourceBindings } from '../resources/worker.js';
import { createResourcePoolSupervisor, ResourceSupervisorError } from '../resources/pool-supervisor.js';
import { createResourceQuotaRefresher, validateResourceQuotaRefreshConfig, type ResourceQuotaRefresher } from '../resources/quota-refresh.js';
import { acquireResourceQuotaRefreshLease, inspectResourceQuotaRefreshPending, ResourceQuotaRefreshLeaseError,
  type ResourceQuotaRefreshLease } from '../resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence } from '../resources/quota-shared-evidence.js';
import { expandResourceQuotaDenials } from '../resources/quota-scope.js';
import { validateResourceConsoleProjects } from '../resources/console-projects.js';
import { createResourceConsoleEngineeringOwner, validateResourceConsoleEngineeringCatalog,
  type ResourceConsoleEngineeringOwner } from '../resources/console-engineering.js';
import { createResourceConsoleEngineeringSupervisor, validateResourceConsoleEngineeringSupervisionConfig,
  type ResourceConsoleEngineeringSupervisor } from '../resources/console-engineering-supervisor.js';
import { listResourceConsoleFiles, readResourceConsoleFile, ResourceConsoleFileError } from '../resources/console-files.js';
import { createResourceConnectionMonitor, validateResourceConnectionConfig, type ResourceConnectionMonitor } from '../resources/connection-monitor.js';
import { createNativeMetadataCoordinator, type NativeMetadataCoordinator } from '../resources/metadata-coordinator.js';
import type { ResourceConsoleScope, ResourceConsoleTaskInput, ResourceConsoleSnapshot } from '../resources/console-types.js';
import { createResourceConsoleEngineeringPreparation, validateResourceConsoleEngineeringPreparationConfig,
  type ResourceConsoleEngineeringPreparationOwner } from '../resources/console-engineering-preparation.js';
import { createResourceConsoleReader, withholdResourceConsoleWorkers, withholdResourceConsoleQuotaScopeWorkers } from './resource-console-reads.js';
import { createReadSessionBoundary, headerValue, requestUrl, safeEqual, sendJson } from './read-session.js';
import { validateUniverseConsoleRoot } from './universe-console-reads.js';
import { serveStatic } from './static.js';
import { createEngineeringBackground } from '../resources/engineering-background.js';
import type { EngineeringBackground } from '../resources/engineering-background-types.js';
import { createResourceEngineeringAutomaticAdmission } from '../resources/engineering-automatic-admission.js';
import { validateResourceEngineeringSuccessorCoordinatorConfig } from '../resources/engineering-successor-coordinator.js';
import { captureResourceExecutionVeto } from '../resources/execution-veto.js';

export interface ResourceConsoleServerOptions {
  /** Host-only mission veto, never exposed as browser-configurable policy. */
  isExecutionStopped?: () => boolean;
  root: string;
  poolFile: string;
  bindingsFile: string;
  observationsFile: string;
  /** Explicit opt-in to no-generation native metadata collection. */
  quotaConfigFile?: string;
  connectionsConfigFile?: string;
  /** Explicit private catalog of additional workspaces; default remains workspace. */
  projectsFile?: string;
  /** Explicit private evaluated-engineering enrollment; never browser configuration. */
  engineeringFile?: string;
  engineeringPreparationFile?: string;
  /** Explicit digest-pinned automatic engineering queue; absent means no auto-launch. */
  engineeringSupervisionFile?: string;
  /** Explicit private policy for accounted proposal and delivered-seed successor work. */
  engineeringSuccessorsFile?: string;
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

function sendSnapshot(res: ServerResponse, value: unknown, status = 200): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) throw new RequestError(503, 'Resource evidence exceeds the response limit');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(json) }); res.end(json);
}

/** One fixed pool; independent read and control capabilities. No default dashboard imports. */
export async function startResourceConsoleServer(options: ResourceConsoleServerOptions): Promise<ResourceConsoleServerHandle> {
  const hostStopped = captureResourceExecutionVeto(options);
  if (hostStopped()) throw new Error('Host console execution stopped');
  const signal = options.signal;
  const root = validateUniverseConsoleRoot(options.root);
  const poolFile = validateUniverseConsoleRoot(options.poolFile);
  const bindingsFile = validateUniverseConsoleRoot(options.bindingsFile);
  const observationsFile = validateUniverseConsoleRoot(options.observationsFile);
  const quotaConfigFile = options.quotaConfigFile === undefined ? null : validateUniverseConsoleRoot(options.quotaConfigFile);
  const connectionsConfigFile = options.connectionsConfigFile === undefined ? null : validateUniverseConsoleRoot(options.connectionsConfigFile);
  const projectsFile = options.projectsFile === undefined ? null : validateUniverseConsoleRoot(options.projectsFile);
  const engineeringFile = options.engineeringFile === undefined ? null : validateUniverseConsoleRoot(options.engineeringFile);
  const engineeringPreparationFile = options.engineeringPreparationFile === undefined ? null : validateUniverseConsoleRoot(options.engineeringPreparationFile);
  const engineeringSupervisionFile = options.engineeringSupervisionFile === undefined ? null : validateUniverseConsoleRoot(options.engineeringSupervisionFile);
  const engineeringSuccessorsFile = options.engineeringSuccessorsFile === undefined ? null : validateUniverseConsoleRoot(options.engineeringSuccessorsFile);
  const requestedPort = options.port ?? 0;
  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535 ||
    !Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 16 ||
    (options.execute !== undefined && typeof options.execute !== 'boolean') ||
    (options.allocationControls !== undefined && typeof options.allocationControls !== 'boolean') ||
    (options.execute === true ? !options.workspace : options.workspace !== undefined || options.maxParallel !== undefined || projectsFile !== null) ||
    engineeringFile !== null && (options.execute !== true || projectsFile === null) ||
    engineeringPreparationFile !== null && (options.execute !== true || projectsFile === null) ||
    engineeringSupervisionFile !== null && engineeringFile === null && engineeringPreparationFile === null ||
    engineeringSuccessorsFile !== null && (engineeringSupervisionFile === null || engineeringPreparationFile === null)) {
    throw new Error('Invalid resource console options');
  }
  const workspace = options.execute ? validateUniverseConsoleRoot(options.workspace) : null;
  // Load and freeze explicit authority before readers, listeners or collectors.
  // The supervisor pins directory identities and holds drifted historical roots.
  const catalog = projectsFile ? readResourceJson(projectsFile, 256 * 1024) : undefined;
  if (projectsFile && (!exact(catalog, ['schemaVersion', 'projects']) || catalog.schemaVersion !== 1)) {
    throw new Error('Invalid resource console project catalog');
  }
  const projects = projectsFile ? validateResourceConsoleProjects((catalog as { projects: unknown }).projects) : undefined;
  if (projects) { projects.forEach((project) => Object.freeze(project)); Object.freeze(projects); }
  const engineeringCatalog = engineeringFile ? validateResourceConsoleEngineeringCatalog(readResourceJson(engineeringFile, 1024 * 1024)) : null;
  const engineeringPreparationConfig = engineeringPreparationFile ?
    validateResourceConsoleEngineeringPreparationConfig(readResourceJson(engineeringPreparationFile, 1024 * 1024)) : null;
  const engineeringSupervisionConfig = engineeringSupervisionFile ?
    validateResourceConsoleEngineeringSupervisionConfig(readResourceJson(engineeringSupervisionFile, 128 * 1024)) : null;
  if (engineeringSupervisionConfig?.autoAdmitPrepared && !engineeringPreparationConfig) {
    throw new Error('Automatic prepared-work admission requires preparation profiles');
  }
  const engineeringSuccessorsConfig = engineeringSuccessorsFile
    ? validateResourceEngineeringSuccessorCoordinatorConfig(readResourceJson(engineeringSuccessorsFile, 16 * 1024)) : null;
  const successorProfile = engineeringPreparationConfig?.profiles.find(row => row.id === engineeringSuccessorsConfig?.profileId);
  if (engineeringSuccessorsConfig && (!successorProfile || engineeringSupervisionConfig?.maxEnrollments === undefined ||
      engineeringSuccessorsConfig.supervisionId !== engineeringSupervisionConfig.id ||
      engineeringSuccessorsConfig.maxSuccessors > engineeringSupervisionConfig.maxEnrollments)) {
    throw new Error('Successor policy requires a matching appendable supervision queue and preparation profile');
  }
  const configuredWorkspaces = workspace ? [workspace, ...(projects?.map((project) => project.workspace) ?? [])] : [];
  const contains = (parent: string, target: string) => {
    const nested = relative(parent, target);
    return nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
  };
  const controlFiles = [poolFile, bindingsFile, observationsFile, ...(quotaConfigFile ? [quotaConfigFile] : []),
    ...(connectionsConfigFile ? [connectionsConfigFile] : []), ...(projectsFile ? [projectsFile] : []),
    ...(engineeringFile ? [engineeringFile] : []), ...(engineeringSupervisionFile ? [engineeringSupervisionFile] : []),
    ...(engineeringPreparationFile ? [engineeringPreparationFile] : []), ...(engineeringSuccessorsFile ? [engineeringSuccessorsFile] : [])];
  for (const selectedWorkspace of configuredWorkspaces) {
    // Legacy scopes allowed a workspace below the store; catalog adoption is stricter.
    if (contains(selectedWorkspace, root) || projects !== undefined && contains(root, selectedWorkspace) ||
      controlFiles.some((file) => contains(selectedWorkspace, file))) {
      throw new Error('Resource control files must remain outside the writable workspace');
    }
  }
  if (new Set(configuredWorkspaces).size !== configuredWorkspaces.length) throw new Error('Duplicate resource project workspace');
  if (signal?.aborted || hostStopped()) throw new Error('Resource console startup cancelled');
  const pool = validateResourcePool(readResourceJson(poolFile));
  const bindings = validateResourceBindings(readResourceJson(bindingsFile), pool);
  if (engineeringSuccessorsConfig?.allowedWorkerIds.some(id => !pool.workers.some(worker => worker.id === id))) {
    throw new Error('Successor proposal worker is not in the resource pool');
  }
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
    ...(options.allocationControls ? { allocationWritable: true } : {}),
    ...(options.execute ? { historySupported: true, followUpSupported: true } : {}) };
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'public');
  let supervisor: Awaited<ReturnType<typeof createResourcePoolSupervisor>> | null = null;
  let engineering: ResourceConsoleEngineeringOwner | null = null;
  let engineeringPreparation: Pick<ResourceConsoleEngineeringPreparationOwner, 'profiles' | 'check' | 'prepare' | 'prepareAutomatically' | 'pendingAutomaticAdmissions'> |
    Pick<EngineeringBackground, 'profiles' | 'check' | 'prepare' | 'prepareAutomatically' | 'pendingAutomaticAdmissions'> | null = null;
  let automaticAdmission: ReturnType<typeof createResourceEngineeringAutomaticAdmission> | null = null;
  let engineeringSupervision: ResourceConsoleEngineeringSupervisor | null = null;
  let engineeringBackground: EngineeringBackground | null = null;
  let engineeringSuccessors: Pick<EngineeringBackground, 'snapshot' | 'start' | 'close'> | null = null;
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
      unavailableWorkerIds: quotaRefresher.unavailableWorkerIds(), quotaUnavailableWorkerIds: quotaRefresher.quotaUnavailableWorkerIds() } : {
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
          quotaUnavailableWorkerIds: quotaRefresher.quotaUnavailableWorkerIds(true),
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
        if (url.pathname === '/api/resources/quota-scope-access') {
          if (!options.allocationControls || !controlToken) throw new RequestError(403, 'Quota scope controls are disabled');
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Matching Origin required');
          if (!safeEqual(headerValue(req, 'x-ashlr-token'), controlToken)) throw new RequestError(401, 'Control token required');
          const input = await body(req);
          if (!exact(input, ['exclusions', 'expectedRevision']) || !Number.isSafeInteger(input.expectedRevision) ||
            Number(input.expectedRevision) < 0 || Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER) {
            throw new RequestError(400, 'Expected enrolled quota scopes and a current revision');
          }
          let exclusions: ReturnType<typeof validateResourceQuotaScopeExclusions>;
          try { exclusions = validateResourceQuotaScopeExclusions(input.exclusions, pool, bindings); }
          catch { throw new RequestError(400, 'Expected enrolled quota scopes and a current revision'); }
          if (closing) throw new RequestError(503, 'Console is closing');
          try {
            const quotaScopeAccess = setResourceQuotaScopeAccess(root, pool, bindings, exclusions, Number(input.expectedRevision));
            sendJson(res, 200, { quotaScopeAccess });
          } catch { throw new RequestError(409, 'Quota scope reservations changed or are unavailable; refresh before saving'); }
          return;
        }
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
        if (url.pathname === '/api/resources/engineering/profiles') {
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Engineering requires an explicit matching Origin');
          if (!engineeringPreparation) throw new RequestError(403, 'Engineering preparation is not configured');
          const input = await body(req);
          if (!exact(input, ['projectId']) || typeof input.projectId !== 'string') throw new RequestError(400, 'Expected one project ID');
          sendSnapshot(res, { profiles: await engineeringPreparation.profiles(input.projectId) }); return;
        }
        if (url.pathname === '/api/resources/engineering/prepare/check' || url.pathname === '/api/resources/engineering/prepare') {
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Engineering requires an explicit matching Origin');
          if (!engineeringPreparation) throw new RequestError(403, 'Engineering preparation is not configured');
          const input = await body(req);
          if (closing) throw new RequestError(503, 'Console is closing');
          if (url.pathname.endsWith('/check')) { sendSnapshot(res, await engineeringPreparation.check(input)); return; }
          sendSnapshot(res, automaticAdmission ? await automaticAdmission.prepare(input) : await engineeringPreparation.prepare(input)); return;
        }
        if (url.pathname === '/api/resources/engineering-supervision/admit') {
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Engineering requires an explicit matching Origin');
          if (!engineeringSupervision) throw new RequestError(403, 'Engineering supervision is not configured');
          const input = await body(req);
          if (closing) throw new RequestError(503, 'Console is closing');
          sendSnapshot(res, engineeringSupervision.admit(input)); return;
        }
        if (url.pathname === '/api/resources/engineering-supervision') {
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Engineering requires an explicit matching Origin');
          if (!engineeringSupervision) throw new RequestError(403, 'Engineering supervision is not configured');
          const input = await body(req);
          if (!exact(input, ['paused', 'expectedRevision']) || typeof input.paused !== 'boolean' ||
            !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
            throw new RequestError(400, 'Expected a pause mode and current supervision revision');
          }
          if (closing) throw new RequestError(503, 'Console is closing');
          sendSnapshot(res, engineeringSupervision.setPaused(input.paused, Number(input.expectedRevision))); return;
        }
        const engineeringCancel = /^\/api\/resources\/engineering\/([a-z0-9][a-z0-9_-]{0,63})\/cancel$/.exec(url.pathname);
        if (url.pathname === '/api/resources/engineering/start' || engineeringCancel) {
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Engineering requires an explicit matching Origin');
          if (!engineering) throw new RequestError(403, 'Engineering is not enrolled for this console');
          const input = await body(req);
          if (closing) throw new RequestError(503, 'Console is closing');
          if (engineeringCancel) {
            if (!exact(input, [])) throw new RequestError(400, 'Engineering cancellation expects an empty JSON object');
            sendSnapshot(res, engineering.cancel(engineeringCancel[1]!));
          } else {
            if (!exact(input, ['enrollmentId', 'expectedEnrollmentDigest']) || typeof input.enrollmentId !== 'string' ||
              !ID.test(input.enrollmentId) || typeof input.expectedEnrollmentDigest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(input.expectedEnrollmentDigest)) {
              throw new RequestError(400, 'Expected an enrolled engineering ID and current digest');
            }
            sendSnapshot(res, engineering.launch({ enrollmentId: input.enrollmentId, expectedEnrollmentDigest: input.expectedEnrollmentDigest }), 202);
          }
          return;
        }
        const files = /^\/api\/resources\/projects\/([a-z0-9][a-z0-9_-]{0,63})\/files\/(list|read)$/.exec(url.pathname);
        if (files) {
          // Project content is a separate control-unlocked read capability. A
          // GET session or an originless local request cannot expose file text.
          if (headerValue(req, 'origin') !== origin) throw new RequestError(403, 'Project file inspection requires an explicit matching Origin');
          if (!scope.workspaceFilesSupported) throw new RequestError(403, 'Project file inspection requires a registered project catalog');
          const input = await body(req);
          if (!exact(input, ['path']) || typeof input.path !== 'string') throw new RequestError(400, 'Expected one project-relative path');
          if (closing) throw new RequestError(503, 'Console is closing');
          const binding = supervisor.projectFileBinding(files[1]!);
          const result = files[2] === 'list' ? listResourceConsoleFiles(binding, input.path) : readResourceConsoleFile(binding, input.path);
          sendSnapshot(res, result); return;
        }
        const cancel = /^\/api\/resources\/tasks\/([a-z0-9][a-z0-9_-]{0,63})\/cancel$/.exec(url.pathname);
        const deleteHistory = /^\/api\/resources\/tasks\/([a-z0-9][a-z0-9_-]{0,63})\/history\/delete$/.exec(url.pathname);
        if (url.pathname !== '/api/resources/tasks' && url.pathname !== '/api/resources/queue' && !cancel && !deleteHistory) {
          throw new RequestError(404, 'Unknown resource control route');
        }
        const input = await body(req);
        if (closing) throw new RequestError(503, 'Console is closing');
        if (url.pathname === '/api/resources/tasks') {
          const historyField = input !== null && typeof input === 'object' && Object.hasOwn(input, 'retainHistory');
          const parentField = input !== null && typeof input === 'object' && Object.hasOwn(input, 'parent');
          const projectField = input !== null && typeof input === 'object' && Object.hasOwn(input, 'projectId');
          if (!exact(input, ['id', 'prompt', 'allowedWorkerIds', 'mode', 'timeoutMs', 'maxOutputTokens',
            ...(historyField ? ['retainHistory'] : []), ...(parentField ? ['parent'] : []), ...(projectField ? ['projectId'] : [])]) ||
            projectField && (typeof input.projectId !== 'string' || !ID.test(input.projectId)) ||
            historyField && typeof input.retainHistory !== 'boolean' || parentField &&
            (!exact(input.parent, ['taskId', 'expectedTranscriptDigest']) ||
              typeof input.parent.taskId !== 'string' || !ID.test(input.parent.taskId) ||
              typeof input.parent.expectedTranscriptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.parent.expectedTranscriptDigest))) {
            throw new RequestError(400, 'Expected a scoped task without filesystem or command fields');
          }
          const job = supervisor.submit(input as unknown as ResourceConsoleTaskInput);
          sendJson(res, 202, { job });
        } else if (deleteHistory) {
          if (!exact(input, [])) throw new RequestError(400, 'History deletion expects an empty JSON object');
          sendJson(res, 200, { job: supervisor.deleteHistory(deleteHistory[1]!) });
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
      if (url.pathname === '/api/resources/engineering-supervision') {
        if (!engineeringSupervision) throw new RequestError(403, 'Engineering supervision is not configured');
        sendSnapshot(res, engineeringSupervision.snapshot()); return;
      }
      if (url.pathname === '/api/resources/engineering/automatic-admission') {
        if (!automaticAdmission) throw new RequestError(403, 'Automatic admission is not configured');
        sendSnapshot(res, automaticAdmission.snapshot()); return;
      }
      if (url.pathname === '/api/resources/engineering-successors') {
        if (!engineeringSuccessors) throw new RequestError(403, 'Engineering successors are not configured');
        sendSnapshot(res, await engineeringSuccessors.snapshot()); return;
      }
      const engineeringReadiness = /^\/api\/resources\/engineering\/([a-z0-9][a-z0-9_-]{0,63})\/readiness$/.exec(url.pathname);
      if (engineeringReadiness) {
        if (!engineering) throw new RequestError(403, 'Engineering is not enrolled for this console');
        sendSnapshot(res, engineering.readiness(engineeringReadiness[1]!)); return;
      }
      const engineeringOutcomes = /^\/api\/resources\/engineering\/([a-z0-9][a-z0-9_-]{0,63})\/outcomes$/.exec(url.pathname);
      if (engineeringOutcomes) {
        if (!engineering) throw new RequestError(403, 'Engineering is not enrolled for this console');
        sendSnapshot(res, engineering.outcomes(engineeringOutcomes[1]!)); return;
      }
      const engineeringStatus = /^\/api\/resources\/engineering\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(url.pathname);
      if (url.pathname === '/api/resources/engineering' || engineeringStatus) {
        if (!engineering) throw new RequestError(403, 'Engineering is not enrolled for this console');
        sendSnapshot(res, engineeringStatus ? engineering.snapshot(engineeringStatus[1]!) : engineering.catalog()); return;
      }
      if (url.pathname === '/api/resources') {
        for (let attempt = 0; attempt < 2; attempt++) {
          const allocation = readResourcePoolAllocation(root, pool, bindings);
          const workerAccess = readResourceWorkerAccess(root, pool, bindings);
          const quotaScopeAccess = readResourceQuotaScopeAccess(root, pool, bindings);
          const managed = managedQuotaEvidence();
          let evidence = await reader.snapshot(managed);
          if (closing) throw new RequestError(503, 'Console is closing');
          if (JSON.stringify(allocation) !== JSON.stringify(readResourcePoolAllocation(root, pool, bindings))) continue;
          if (JSON.stringify(workerAccess) !== JSON.stringify(readResourceWorkerAccess(root, pool, bindings))) continue;
          if (JSON.stringify(quotaScopeAccess) !== JSON.stringify(readResourceQuotaScopeAccess(root, pool, bindings))) continue;
          if (quotaConfig) {
            const current = managedQuotaEvidence()!;
            // Both successful refresh and failure can race the worker read.
            // Retry once, then withhold rather than attach newer collector
            // metadata to an earlier eligibility decision.
            if (JSON.stringify(managed) !== JSON.stringify(current)) continue;
            evidence = withholdResourceConsoleWorkers(evidence, current.unavailableWorkerIds, current.quotaUnavailableWorkerIds);
          }
          // A deduplicated worker read can predate this request's policy read.
          // Reapply current pauses so a cached projection cannot show readiness.
          evidence = withholdResourceConsoleWorkers(evidence, workerAccess.pausedWorkerIds);
          evidence = withholdResourceConsoleQuotaScopeWorkers(evidence,
            excludedResourceQuotaScopeWorkerIds(pool, bindings, quotaScopeAccess.exclusions));
          const ceiling = allocation.ceilingPercent;
          if (ceiling !== null && ceiling < 100) {
            const now = Date.now();
            // This is a subtractive display gate only: preserve the sampled
            // plan, but never pair old eligibility with a newly lowered ceiling.
            // Ceiling/freshness is quota-only. Expand same-bucket and unknown
            // aliases conservatively without withholding a pinned independent
            // bucket. Account health/access vetoes remain on their own path.
            const quotaUnavailable = pool.workers.filter((worker) => {
              if (worker.provider === 'local') return false;
              const row = evidence.observations.find((item) => item.workerId === worker.id);
              return ceiling === 0 || !row || Date.parse(row.observedAt) > now ||
                row.updatedAt !== undefined && Date.parse(row.updatedAt) > now || Date.parse(row.expiresAt) <= now ||
                !row.windows.length || row.windows.some((window) => window.usedPercent === null ||
                  window.usedPercent >= ceiling || window.resetsAt === null || Date.parse(window.resetsAt) <= now);
            }).map((worker) => worker.id);
            evidence = withholdResourceConsoleWorkers(evidence, [], expandResourceQuotaDenials(pool, bindings, quotaUnavailable));
          }
          sendSnapshot(res, { ...evidence, supervisor: supervisor?.snapshot() ?? null,
            // Passive local evidence is not an acquisition attempt or provider
            // health. Keep configured/executing collector lifecycle unchanged.
            ...(!options.execute && !quotaConfigFile && !connectionsConfigFile ? {
              collectorInspection: inspectResourceQuotaRefreshPending(root),
            } : {}),
            ...(metadataCollector ? { metadataCollector: collectorLifecycle() } : {}),
            ...(quotaRefresher ? { quotaRefresh: quotaRefresher.snapshot() } : {}),
            ...(connectionMonitor ? { connections: connectionMonitor.snapshot() } : {}),
            allocation, workerAccess, quotaScopeAccess }); return;
        }
        throw new RequestError(503, 'Resource quota or allocation evidence changed during this read');
      }
      const history = /^\/api\/resources\/tasks\/([a-z0-9][a-z0-9_-]{0,63})\/history$/.exec(url.pathname);
      if (history) {
        const value = supervisor?.history(history[1]!);
        if (!value) throw new RequestError(404, 'No retained local transcript for this task');
        sendSnapshot(res, value); return;
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
      if (error instanceof ResourceConsoleFileError) {
        const statuses = { INVALID_INPUT: 400, NOT_FOUND: 404, UNAVAILABLE: 503, LIMIT_EXCEEDED: 413 };
        sendJson(res, statuses[error.code], { error: `Project file operation refused: ${error.code.toLowerCase().replaceAll('_', ' ')}` }); return;
      }
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
    closing = (async () => {
      // Fence worker RPC before a pending recovery read reaches registration.
      // The existing worker close still drains queued work before termination;
      // the actual parent owners remain held until recovery has also drained.
      const backgroundClosing = engineeringBackground?.close();
      void backgroundClosing?.catch(() => {}); // Retained below in executionResults.
      await automaticAdmission?.close();
      // Keep the paired collector alive while owned execution settles. Closing
      // invalidates requests immediately, not the evidence required by teardown.
      const executionResults = await Promise.allSettled([
        Promise.resolve().then(() => backgroundClosing),
        Promise.resolve().then(() => engineeringSupervision?.close()),
        Promise.resolve().then(() => engineering?.close()),
        Promise.resolve().then(() => supervisor?.close()),
      ]);
      if (quotaHeartbeat !== null) { clearInterval(quotaHeartbeat); quotaHeartbeat = null; }
      metadataCoordinator?.dispose();
      // A reader may be terminated, but task subprocesses must settle through
      // their owning supervisor before the server can declare shutdown complete.
      const results = await Promise.allSettled([
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
      try { quotaLease?.close(quotaPublicationFailed || results[0]?.status !== 'fulfilled' || results[1]?.status !== 'fulfilled'); } catch { quotaClosed = false; }
      quotaLease = null;
      if (quotaPublicationFailed || !quotaClosed || [...executionResults, ...results].some((result) => result.status === 'rejected')) throw new Error('Resource console shutdown uncertain');
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
    if (signal?.aborted || hostStopped()) throw new Error('Resource console startup cancelled');
    if (quotaConfig || connectionsConfig) {
      // Only explicit quota collection creates this private control root. No
      // provider is contacted before configuration, ownership and bind succeed.
      try {
        quotaLease = await acquireResourceQuotaRefreshLease(root, { signal, trackNativeActivity: true,
          scope: connectionsConfig ? 'native-connection-metadata' : 'codex-native-metadata' });
      } catch (error) {
        // Only a typed, cleanly released acquisition refusal may degrade into
        // observation mode. Cancellation and uncertain cleanup still fail startup.
        if (signal?.aborted || hostStopped() || !(error instanceof ResourceQuotaRefreshLeaseError) || !error.safeReadOnlyFallback ||
          error.code !== 'collector-owned' && error.code !== 'reconciliation-required' && error.code !== 'collector-unavailable') throw error;
        metadataCollector = { state: 'blocked', reasonCode: error.code,
          sampledAt: new Date().toISOString(),
          ...(error.recovery ? { recovery: { reasonCode: error.recovery.reasonCode, markerVersion: error.recovery.markerVersion } } : {}) };
      }
    }
    if (workspace) supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, maxParallel,
      ...(Object.hasOwn(options, 'isExecutionStopped') ? { isExecutionStopped: hostStopped } : {}),
      ...(projects === undefined ? {} : { projects }),
      readObservations: () => { const base = validateResourceObservations(readResourceJson(observationsFile), pool);
        return quotaRefresher ? quotaRefresher.readObservations(base) : base; },
      ...(quotaConfig ? { readUnavailableWorkerIds: () => quotaRefresher ? quotaRefresher.unavailableWorkerIds()
        : quotaConfig.workers.map((row) => row.workerId),
        readQuotaUnavailableWorkerIds: () => quotaRefresher?.quotaUnavailableWorkerIds() ?? [] } : {}), signal });
    const publishedProjects = supervisor?.projects?.();
    if (publishedProjects !== undefined) { scope.projects = publishedProjects; scope.defaultProjectId = 'default'; }
    if (publishedProjects !== undefined && typeof supervisor?.projectFileBinding === 'function') scope.workspaceFilesSupported = true;
    if ((engineeringCatalog || engineeringPreparationConfig) && supervisor) {
      engineering = createResourceConsoleEngineeringOwner({ ...(engineeringCatalog ? { catalog: engineeringCatalog } : {}),
        isExecutionStopped: hostStopped,
        ...(engineeringPreparationConfig ? { registrationEnabled: true } : {}), supervisor, root,
        poolFile, bindingsFile, observationsFile, ...(quotaConfigFile ? { quotaConfigFile } : {}), signal,
        waitForResourceDrain: async () => {
          // Both peers share this ledger. Their own idempotent close paths must
          // settle before the graph owner judges remaining reserved receipts.
          await Promise.all([supervisor!.close(), engineeringBackground?.close()]);
        } });
      scope.engineeringSupported = true;
      scope.engineeringOutcomesSupported = true;
      if (engineeringPreparationConfig && engineeringPreparationFile && workspace && projectsFile) {
        const preparationOptions = { config: engineeringPreparationConfig,
          configFile: engineeringPreparationFile, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile,
          ...(quotaConfigFile ? { quotaConfigFile } : {}) };
        if (engineeringSuccessorsConfig || engineeringSupervisionConfig?.autoAdmitPrepared) {
          // The worker creates and retains its own preparation/coordinator leases.
          // Main-thread owner callbacks never synchronously wait on that worker;
          // HTTP controls and the durable queue keep their original ownership.
          engineeringBackground = await createEngineeringBackground({ preparation: preparationOptions,
            owner: engineering, supervisor, isClosing: () => closing !== null || hostStopped(), signal,
            onFault: () => { void close().catch(() => {}); } });
          engineeringPreparation = engineeringBackground;
        } else engineeringPreparation = createResourceConsoleEngineeringPreparation({ ...preparationOptions, owner: engineering });
        scope.engineeringPreparationSupported = true;
      }
      if (engineeringSupervisionConfig) {
        engineeringSupervision = createResourceConsoleEngineeringSupervisor({ owner: engineering, root,
          config: engineeringSupervisionConfig, signal });
        scope.engineeringSupervisionSupported = true;
        if (engineeringSupervisionConfig.autoAdmitPrepared) scope.engineeringPreparationAutoAdmission = true;
      }
      if (engineeringSupervisionConfig?.autoAdmitPrepared && engineeringPreparation && engineeringSupervision) {
        automaticAdmission = createResourceEngineeringAutomaticAdmission({ preparation: engineeringPreparation,
          supervision: engineeringSupervision, isClosing: () => closing !== null || hostStopped(), onFatal: () => { void close().catch(() => {}); } });
      }
      if (engineeringSuccessorsConfig && engineeringSuccessorsFile && successorProfile && engineeringBackground && engineeringSupervision) {
        await engineeringBackground.configureSuccessors({ root, configFile: engineeringSuccessorsFile,
          config: engineeringSuccessorsConfig, projectId: successorProfile.recipe.projectId, acceptance: successorProfile.acceptance,
          pool, bindings }, engineeringSupervision, () => {
            const base = validateResourceObservations(readResourceJson(observationsFile), pool);
            return { observations: quotaRefresher ? quotaRefresher.readObservations(base) : base,
              unavailableWorkerIds: quotaRefresher ? quotaRefresher.unavailableWorkerIds() : quotaConfig?.workers.map(row => row.workerId) ?? [],
              quotaUnavailableWorkerIds: quotaRefresher?.quotaUnavailableWorkerIds() ?? [] };
          });
        engineeringSuccessors = engineeringBackground;
        scope.engineeringSuccessorsSupported = true;
      }
    }
    if (signal?.aborted || hostStopped()) throw new Error('Resource console startup cancelled');
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
    if (signal?.aborted || hostStopped()) throw new Error('Resource console startup cancelled');
    signal?.addEventListener('abort', aborted, { once: true }); ready = true;
    engineeringSupervision?.start();
    automaticAdmission?.start();
    await engineeringSuccessors?.start();
    if (closing || signal?.aborted || hostStopped()) throw new Error('Resource console startup cancelled');
    return { url: origin, consoleUrl: `${origin}/resources/`, port, readToken: sessions.readToken, controlToken,
      scope: { ...scope }, close };
  } catch (error) { await close(); throw error; }
}
