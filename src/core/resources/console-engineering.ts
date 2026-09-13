/** Explicit console ownership of fixed engineering graphs; no discovery or extra scheduler. */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock, ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { readUniverseCampaignReadiness } from '../universe/campaign-readiness.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../universe/portfolio-controller-store.js';
import { readCompletedCampaignDelivery } from '../universe/campaign-delivery-recovery.js';
import { createFirmEngineeringControlHandler, type FirmEngineeringControlHost } from '../universe/firm-engineering-control-handler.js';
import { readControlGraph, runControlGraph, validateControlGraph, type ControlGraphDefinition } from '../universe/control-graph.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { readResourceJson, resourcePoolStatus } from './pool-runtime.js';
import { readResourceEngineeringOutcomes } from './engineering-outcomes.js';
import type { ResourceEngineeringOutcomes } from './engineering-outcomes-types.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import { matchesResourceConsoleProject, validateResourceConsoleProjectBindings, type ResourceConsoleProjectBinding } from './console-projects.js';
import type { ResourceConsoleProject } from './console-types.js';
import { ResourceSupervisorError, type ResourcePoolSupervisor } from './pool-supervisor.js';
import { captureResourceExecutionVeto } from './execution-veto.js';
import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob, ResourceConsoleEngineeringLaunch,
  ResourceConsoleEngineeringReadiness, ResourceConsoleEngineeringReadinessReason } from './console-engineering-types.js';

export interface ResourceConsoleEngineeringCatalog {
  schemaVersion: 1;
  enrollments: Array<{ id: string; projectId: string; graphId: string; graphRoot: string; host: FirmEngineeringControlHost }>;
}
export interface ResourceConsoleEngineeringOwnerOptions {
  /** Synchronous mission ownership/deadline veto, including already running work. */
  isExecutionStopped?: () => boolean;
  catalog?: ResourceConsoleEngineeringCatalog;
  /** Host-only enrollment insertion; never enables launch or automatic supervision. */
  registrationEnabled?: true;
  supervisor: ResourcePoolSupervisor;
  root: string;
  poolFile: string;
  bindingsFile: string;
  observationsFile: string;
  quotaConfigFile?: string;
  signal?: AbortSignal;
  /** Host-only shutdown coordination; wait for this console's ordinary task drain. */
  waitForResourceDrain?: () => Promise<void>;
}
export interface ResourceConsoleEngineeringOwner {
  catalog(): ResourceConsoleEngineeringEnrollment[];
  /** Validate the combined catalog before the caller publishes its durable receipt. */
  checkRegistration(catalog: ResourceConsoleEngineeringCatalog): ResourceConsoleEngineeringEnrollment[];
  /** Host-only, nonexecuting registration after the caller's durable preparation receipt. */
  register(catalog: ResourceConsoleEngineeringCatalog): ResourceConsoleEngineeringEnrollment[];
  snapshot(id: string): ResourceConsoleEngineeringJob;
  readiness(id: string): ResourceConsoleEngineeringReadiness;
  outcomes(id: string): ResourceEngineeringOutcomes;
  /** Host-only observational key. Null means incomplete/unstable evidence, never retry permission. */
  evidenceFingerprint(id: string): string | null;
  /** Await this owner's current invocation, including its existing cleanup. */
  awaitSettlement(id: string): Promise<void>;
  launch(input: ResourceConsoleEngineeringLaunch, controls?: ResourceConsoleEngineeringLaunchControls): ResourceConsoleEngineeringJob;
  cancel(id: string): ResourceConsoleEngineeringJob;
  /** Preserve only provably live ordinary supervisor tasks during component close. */
  close(options?: { preserveSupervisorTasks: true }): Promise<void>;
}
export interface ResourceConsoleEngineeringLaunchControls {
  signal?: AbortSignal;
  /** Must be writer-safe: no graph/controller/campaign ledger reads. */
  isExecutionStopped?: () => boolean;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ACTIVE = 4;
function fail(code: ConstructorParameters<typeof ResourceSupervisorError>[0], message: string): never {
  throw new ResourceSupervisorError(code, message);
}
function snapshot<T>(value: unknown, bytes = 1024 * 1024): T {
  const text = canonicalEvidencePackJsonV3(value);
  if (text === null || Buffer.byteLength(text) > bytes) fail('INVALID_INPUT', 'Invalid engineering enrollment');
  return JSON.parse(text) as T;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    parse(value).root !== value && [...value].every((character) => {
      const code = character.charCodeAt(0); return code >= 32 && !(code >= 127 && code <= 159);
    });
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/** Closed startup input, detached before any reads. Host validation remains read-only. */
export function validateResourceConsoleEngineeringCatalog(value: unknown): ResourceConsoleEngineeringCatalog {
  const result = snapshot<ResourceConsoleEngineeringCatalog>(value);
  if (!exact(result, ['schemaVersion', 'enrollments']) || result.schemaVersion !== 1 ||
    !Array.isArray(result.enrollments) || result.enrollments.length < 1 || result.enrollments.length > 32) {
    fail('INVALID_INPUT', 'Invalid engineering catalog');
  }
  const ids = new Set<string>(); const controllers = new Set<string>();
  const graphRoots: string[] = [];
  for (const row of result.enrollments) {
    if (!exact(row, ['id', 'projectId', 'graphId', 'graphRoot', 'host']) || typeof row.id !== 'string' || !ID.test(row.id) ||
      typeof row.projectId !== 'string' || !ID.test(row.projectId) || typeof row.graphId !== 'string' || !GRAPH_ID.test(row.graphId) ||
      !path(row.graphRoot) || ids.has(row.id) || graphRoots.some((root) => overlaps(root, row.graphRoot))) {
      fail('INVALID_INPUT', 'Invalid engineering enrollment identity');
    }
    inspectPrivateDirectory(row.graphRoot);
    createFirmEngineeringControlHandler(row.host);
    const controller = canonical([row.host.root, row.host.definition.id]);
    if (controllers.has(controller)) fail('INVALID_INPUT', 'Engineering controllers must be distinct');
    ids.add(row.id); controllers.add(controller); graphRoots.push(row.graphRoot);
  }
  return result;
}

interface OwnershipRecord {
  schemaVersion: 1; kind: 'launch' | 'cancel'; enrollmentDigest: string; definitionDigest: string; at: string;
}
function records(root: string): ImmutablePrivateRecordStoreConfig<OwnershipRecord> {
  const parseRecord = (value: unknown): OwnershipRecord | null => {
    if (!exact(value, ['schemaVersion', 'kind', 'enrollmentDigest', 'definitionDigest', 'at']) || value.schemaVersion !== 1 ||
      !['launch', 'cancel'].includes(String(value.kind)) || typeof value.enrollmentDigest !== 'string' || !HASH.test(value.enrollmentDigest) ||
      typeof value.definitionDigest !== 'string' || !HASH.test(value.definitionDigest) || typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return null;
    return value as unknown as OwnershipRecord;
  };
  const codec = { parse: parseRecord, serialize: (value: OwnershipRecord) => canonical(value) + '\n',
    recordId: (value: OwnershipRecord) => value.kind, recordFileName: (value: OwnershipRecord) => `${value.kind}.json`,
    isRecordFileName: (name: string) => /^(launch|cancel)\.json$/.test(name),
    stageToken: (value: OwnershipRecord) => digest(canonical(value)),
    equivalent: (a: OwnershipRecord, b: OwnershipRecord) => canonical(a) === canonical(b) };
  return { label: 'Console engineering ownership', anchorPath: root, rootPath: join(root, 'console-engineering'),
    lockFileName: '.records.lock', maxRecordBytes: 1024, defaultMaxFiles: 2, hardMaxFiles: 2,
    defaultMaxBytes: 2048, hardMaxBytes: 2048, codecForRead: () => codec, codecForWrite: () => codec };
}

export interface ResourceConsoleEngineeringPreparedEnrollment {
  row: ResourceConsoleEngineeringCatalog['enrollments'][number];
  binding: ReturnType<typeof createFirmEngineeringControlHandler>;
  definition: ControlGraphDefinition;
  definitionDigest: string;
  summary: ResourceConsoleEngineeringEnrollment;
  projectIdentity: Pick<ResourceConsoleProjectBinding, 'id' | 'workspace' | 'dev' | 'ino'>;
  accountingPoolDigest: string;
}

function readEngineeringOwnership(value: Pick<ResourceConsoleEngineeringPreparedEnrollment, 'row' | 'summary' | 'definitionDigest'>) {
  inspectPrivateDirectory(value.row.graphRoot);
  const result = readImmutablePrivateRecords(records(value.row.graphRoot), { requireComplete: true });
  if (result.sourceState === 'degraded' || result.sourceState !== 'missing' && !result.complete || result.records.some((record) =>
    record.enrollmentDigest !== value.summary.enrollmentDigest || record.definitionDigest !== value.definitionDigest)) {
    fail('UNAVAILABLE', 'Engineering ownership evidence unavailable');
  }
  const launch = result.records.find((record) => record.kind === 'launch');
  const cancel = result.records.find((record) => record.kind === 'cancel');
  if (cancel && (!launch || Date.parse(cancel.at) < Date.parse(launch.at))) fail('UNAVAILABLE', 'Engineering cancellation evidence unavailable');
  return { launch, cancel };
}

export interface ResourceConsoleEngineeringGraphCompletion {
  enrollmentId: string; enrollmentDigest: string; graphId: string; definitionDigest: string;
  graphDigest: string; ownershipDigest: string; launchedAt: string; deadlineAt: string;
}

/** Host-only observation from a freshly prepared enrollment, not custody or launch authority. */
export function readResourceConsoleEngineeringGraphCompletion(
  prepared: ResourceConsoleEngineeringPreparedEnrollment,
): ResourceConsoleEngineeringGraphCompletion | null {
  try {
    // Prepared bindings contain executable handlers. Capture only their inert
    // identity fields, without invoking caller accessors or constructing an owner.
    const fields = ['row', 'summary', 'definition', 'definitionDigest'] as const;
    const captured = Object.fromEntries(fields.map(key => {
      const property = Object.getOwnPropertyDescriptor(prepared, key);
      if (!property || !Object.hasOwn(property, 'value')) fail('INVALID_INPUT', 'Invalid prepared engineering identity');
      return [key, property.value];
    }));
    const value = snapshot<Pick<ResourceConsoleEngineeringPreparedEnrollment, typeof fields[number]>>(captured);
    const definition = validateControlGraph(value.definition);
    if (!path(value.row.graphRoot) || !ID.test(value.row.id) || !HASH.test(value.summary.enrollmentDigest) ||
      value.row.id !== value.summary.id || value.row.graphId !== value.summary.graphId || definition.id !== value.row.graphId ||
      definition.hostEnrollmentDigest !== value.summary.enrollmentDigest || digest(canonical(definition)) !== value.definitionDigest) return null;
    const sample = () => ({ ownership: readEngineeringOwnership(value), graph: readControlGraph(value.row.graphRoot) });
    const first = sample(); const { graph, ownership } = first;
    if (!ownership.launch || ownership.cancel || graph.sourceState !== 'healthy' || graph.status !== 'completed' ||
      graph.graphId !== value.row.graphId || graph.definitionDigest !== value.definitionDigest || graph.deadlineAt === null ||
      graph.nodes.length !== definition.nodes.length || graph.nodes.some((node, index) => node.state !== 'completed' ||
        node.id !== definition.nodes[index]!.id || node.kind !== definition.nodes[index]!.kind)) return null;
    // Completion facts can race a cancellation or graph publication. The seal
    // caller still supplies its own quiescence and final-publication guards.
    if (canonical(first) !== canonical(sample())) return null;
    return { enrollmentId: value.row.id, enrollmentDigest: value.summary.enrollmentDigest, graphId: graph.graphId,
      definitionDigest: value.definitionDigest, graphDigest: digest(canonical(graph)),
      ownershipDigest: digest(canonical(ownership.launch)), launchedAt: ownership.launch.at, deadlineAt: graph.deadlineAt };
  } catch { return null; }
}

/** Shared read-only enrollment validation. Prepared handlers are host-only, never a public report. */
export function prepareResourceConsoleEngineeringEnrollments(options: {
  catalog: ResourceConsoleEngineeringCatalog; root: string; poolFile: string; bindingsFile: string;
  observationsFile: string; quotaConfigFile?: string;
  projectBindings: ResourceConsoleProjectBinding[]; projects: ResourceConsoleProject[];
}): ResourceConsoleEngineeringPreparedEnrollment[] {
  const catalog = validateResourceConsoleEngineeringCatalog(options.catalog);
  const control = snapshot<{ root: string; poolFile: string; bindingsFile: string; observationsFile: string; quotaConfigFile?: string }>({
    root: options.root, poolFile: options.poolFile, bindingsFile: options.bindingsFile, observationsFile: options.observationsFile,
    ...(options.quotaConfigFile === undefined ? {} : { quotaConfigFile: options.quotaConfigFile }) });
  if (Object.values(control).some((value) => !path(value))) fail('INVALID_INPUT', 'Invalid engineering resource controls');
  const pool = validateResourcePool(readResourceJson(control.poolFile));
  const bindings = validateResourceBindings(readResourceJson(control.bindingsFile), pool);
  const poolDigest = digest(canonical({ pool, bindings }));
  const captured = snapshot<{ projectBindings: ResourceConsoleProjectBinding[]; projects: ResourceConsoleProject[] }>({
    projectBindings: options.projectBindings, projects: options.projects });
  const projectBindings = validateResourceConsoleProjectBindings(captured.projectBindings, captured.projectBindings?.[0]?.workspace);
  const projects = captured.projects;
  if (!Array.isArray(projects) || projects.length !== projectBindings.length ||
      projects.some((project, index) => !exact(project, ['id', 'label', 'workspace', 'enabled']) ||
        typeof project.enabled !== 'boolean' || project.id !== projectBindings[index]!.id ||
        project.label !== projectBindings[index]!.label || project.workspace !== projectBindings[index]!.workspace)) {
    fail('INVALID_INPUT', 'Invalid engineering project projection');
  }
  return catalog.enrollments.map((row) => {
    const project = projectBindings.find((value) => value.id === row.projectId);
    if (!project) fail('NOT_FOUND', 'Resource project was not found');
    const scope = { project };
    const runtime = validateResourceGenerationRuntime(readResourceJson(row.host.resourceRuntime));
    if (runtime.root !== control.root || runtime.poolPath !== control.poolFile || runtime.bindingsPath !== control.bindingsFile ||
      runtime.observationsPath !== control.observationsFile || runtime.quotaConfigPath !== control.quotaConfigFile ||
      (control.quotaConfigFile !== undefined ? runtime.quotaEvidenceMode !== 'shared-collector' : runtime.quotaEvidenceMode !== undefined) ||
      runtime.localModelConfigPath !== undefined) fail('CONFLICT', 'Engineering must use this console resource accounting and collector');
    const paths = [row.graphRoot, row.host.root, row.host.resourceRuntime, runtime.workspace, ...Object.values(control)];
    if (projects.some((project) => paths.some((file) => contains(project.workspace, file))) ||
      projects.some((project) => [row.graphRoot, row.host.root, runtime.workspace, control.root].some((directory) => overlaps(project.workspace, directory))) ||
      overlaps(row.graphRoot, control.root) || overlaps(runtime.workspace, row.graphRoot) || overlaps(runtime.workspace, row.host.root) ||
      projects.some((project) => overlaps(runtime.workspace, project.workspace))) {
      fail('INVALID_INPUT', 'Engineering controls must be outside writable projects and accounting storage');
    }
    const binding = createFirmEngineeringControlHandler(row.host);
    const projectIdentity = { id: scope.project.id, workspace: scope.project.workspace, dev: scope.project.dev, ino: scope.project.ino };
    const enrollmentDigest = digest(canonical({ schemaVersion: 1, domain: 'resource-console-engineering-v1',
      row, project: projectIdentity, accounting: { root: control.root, poolDigest }, bindingDigest: binding.nodeInput.bindingDigest }));
    const definition: ControlGraphDefinition = validateControlGraph({ schemaVersion: 1, id: row.graphId,
      hostEnrollmentDigest: enrollmentDigest, maxConcurrent: 1, maxDurationMs: row.host.definition.maxDurationMs,
      nodes: [{ id: row.host.nodeId, kind: 'deliver', requires: [], input: binding.nodeInput }] });
    const definitionDigest = digest(canonical(definition));
    const campaigns = row.host.definition.tasks.map((task) => {
      const campaign = readUniverseCampaign(task.campaignId, { root: row.host.root });
      const universe = campaignUniverse(campaign, { root: row.host.root });
      if (universe.manifest.seed.repo !== scope.project.workspace) fail('CONFLICT', 'Engineering campaign belongs to another project');
      return { id: task.campaignId, dependsOn: task.dependsOn, objective: universe.manifest.objective.slice(0, 512),
        branch: row.host.deliveryPlan.deliveries.find((target) => target.campaignId === task.campaignId)!.branch,
        budget: universe.manifest.budget, campaignBudget: campaign.definition.budget };
    });
    const summary: ResourceConsoleEngineeringEnrollment = { id: row.id, projectId: row.projectId, graphId: row.graphId,
      enrollmentDigest, objective: campaigns.map((campaign) => campaign.objective).join('\n').slice(0, 1024), campaigns,
      budget: { maxParallel: row.host.definition.maxParallel, maxDurationMs: row.host.definition.maxDurationMs },
      ...(row.host.allowPendingContinuation === true ? { allowPendingContinuation: true as const } : {}),
      acceptanceScope: 'fixed-evaluator-and-local-branch-only' };
    return { row, binding, definition, definitionDigest, summary, projectIdentity, accountingPoolDigest: poolDigest };
  });
}

/** Construction/status never write graph roots or dispatch. Only explicit launch/cancel does. */
export function createResourceConsoleEngineeringOwner(options: ResourceConsoleEngineeringOwnerOptions): ResourceConsoleEngineeringOwner {
  const hostStopped = captureResourceExecutionVeto(options);
  const registrationProperty = Object.getOwnPropertyDescriptor(options, 'registrationEnabled');
  if (registrationProperty && (!Object.hasOwn(registrationProperty, 'value') || registrationProperty.value !== true) ||
    !registrationProperty && 'registrationEnabled' in options) fail('INVALID_INPUT', 'Invalid engineering registration capability');
  const registrationEnabled = registrationProperty?.value === true;
  const catalogProperty = Object.getOwnPropertyDescriptor(options, 'catalog');
  if (catalogProperty && !Object.hasOwn(catalogProperty, 'value') || !catalogProperty && 'catalog' in options) {
    fail('INVALID_INPUT', 'Invalid engineering catalog');
  }
  const startupCatalog = catalogProperty?.value === undefined ? undefined : snapshot<ResourceConsoleEngineeringCatalog>(catalogProperty.value);
  const emptyCatalog = startupCatalog === undefined || exact(startupCatalog, ['schemaVersion', 'enrollments']) &&
    startupCatalog.schemaVersion === 1 && Array.isArray(startupCatalog.enrollments) && startupCatalog.enrollments.length === 0;
  if (emptyCatalog && !registrationEnabled) fail('INVALID_INPUT', 'Engineering catalog required without registration capability');
  const drainProperty = Object.getOwnPropertyDescriptor(options, 'waitForResourceDrain');
  if (drainProperty && (!Object.hasOwn(drainProperty, 'value') ||
      drainProperty.value !== undefined && typeof drainProperty.value !== 'function') ||
    !drainProperty && 'waitForResourceDrain' in options) fail('INVALID_INPUT', 'Invalid engineering shutdown coordinator');
  const waitForResourceDrain = drainProperty?.value as (() => Promise<void>) | undefined;
  const supervisor = options.supervisor; const signal = options.signal;
  const control = snapshot<{ root: string; poolFile: string; bindingsFile: string; observationsFile: string; quotaConfigFile?: string }>({
    root: options.root, poolFile: options.poolFile, bindingsFile: options.bindingsFile, observationsFile: options.observationsFile,
    ...(options.quotaConfigFile === undefined ? {} : { quotaConfigFile: options.quotaConfigFile }) });
  if (Object.values(control).some((value) => !path(value))) fail('INVALID_INPUT', 'Invalid engineering resource controls');
  const pool = validateResourcePool(readResourceJson(control.poolFile));
  const bindings = validateResourceBindings(readResourceJson(control.bindingsFile), pool);
  const poolDigest = digest(canonical({ pool, bindings }));
  const projects = supervisor.projects();
  if (!projects) fail('UNAVAILABLE', 'Register engineering projects first');
  let closing = false; let closePromise: Promise<void> | undefined;
  let ranGraph = false;
  const active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  const faults = new Set<string>();
  const projectBindings = projects.map((project) => {
    const scope = supervisor.engineeringBinding(project.id);
    if (scope.root !== control.root || scope.poolDigest !== poolDigest) fail('CONFLICT', 'Engineering accounting scope changed');
    return scope.project;
  });
  const prepared = emptyCatalog ? [] : prepareResourceConsoleEngineeringEnrollments({ ...control, catalog: startupCatalog!, projects, projectBindings });
  if (prepared.some((row) => row.accountingPoolDigest !== poolDigest)) fail('CONFLICT', 'Engineering accounting scope changed');
  let enrolled = new Map(prepared.map((value) => [value.row.id, value] as const));
  type Entry = NonNullable<ReturnType<typeof enrolled.get>>;
  const entry = (id: string): Entry => {
    if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_INPUT', 'Invalid engineering enrollment');
    return enrolled.get(id) ?? fail('NOT_FOUND', 'Engineering enrollment was not found');
  };
  const ownership = readEngineeringOwnership;
  const admit = (value: Entry, running = false) => {
    if (hostStopped()) fail('UNAVAILABLE', 'Host engineering execution stopped');
    if (closing || signal?.aborted) fail('UNAVAILABLE', 'Engineering owner is closing');
    // Queue pause gates new launches, not work already running. Explicit cancel
    // is the durable stop operation; closing/ownership/project loss still veto.
    const project = running ? supervisor.projectFileBinding(value.row.projectId) : supervisor.projectExecutionBinding(value.row.projectId);
    if (canonical({ id: project.id, workspace: project.workspace, dev: project.dev, ino: project.ino }) !== canonical(value.projectIdentity)) {
      fail('CONFLICT', 'Engineering project identity changed');
    }
    if (digest(canonical(validateResourceGenerationRuntime(readResourceJson(value.row.host.resourceRuntime)))) !== value.row.host.expectedRuntimeDigest) {
      fail('CONFLICT', 'Engineering resource runtime changed');
    }
  };
  // These are hard, currently observable blockers only. No provider refresh,
  // eligible-worker-count gate, mutex acquisition or permission repair occurs.
  const hardBlockers = (value: Entry, fresh: boolean): ResourceConsoleEngineeringReadinessReason[] => {
    const reasons: ResourceConsoleEngineeringReadinessReason[] = [];
    if (closing || signal?.aborted || faults.has(value.row.id)) reasons.push('owner-unavailable');
    if (supervisor.snapshot().paused) reasons.push('queue-paused');
    try {
      const project = supervisor.projectFileBinding(value.row.projectId);
      if (canonical({ id: project.id, workspace: project.workspace, dev: project.dev, ino: project.ino }) !== canonical(value.projectIdentity)) throw new Error();
    } catch { reasons.push('project-unavailable'); }
    try {
      const kill = readKillSwitch();
      if (kill.state === 'active') reasons.push('global-kill-active');
      else if (kill.state !== 'inactive' || kill.sourceState !== 'healthy') reasons.push('global-kill-unavailable');
    } catch { reasons.push('global-kill-unavailable'); }
    try { lstatSync(join(value.row.graphRoot, 'KILL')); reasons.push('graph-kill-active'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push('graph-kill-unavailable'); }
    try { if (!loadExistingProvenanceKeyReadOnly()) reasons.push('provenance-unavailable'); }
    catch { reasons.push('provenance-unavailable'); }
    try {
      if (digest(canonical(validateResourceGenerationRuntime(readResourceJson(value.row.host.resourceRuntime)))) !== value.row.host.expectedRuntimeDigest) throw new Error();
    } catch { reasons.push('runtime-pin-changed'); }
    try {
      const current = createFirmEngineeringControlHandler(value.row.host);
      if (canonical(current.nodeInput) !== canonical(value.binding.nodeInput)) throw new Error();
    } catch { reasons.push('enrollment-pin-changed'); }
    if (fresh) {
      // Presence is not proof of a live or unsafe owner. Fresh launches wait
      // for release/inspection; linked receipt recovery keeps existing proven-
      // dead lease reclamation and is deliberately not gated by this hint.
      if (present(join(value.row.graphRoot, '.control-execution.lock'))) reasons.push('graph-ownership-unavailable');
      if (present(portfolioControllerDirectory(value.row.host.definition.id, { root: value.row.host.root }))) reasons.push('controller-already-enrolled');
      for (const task of value.row.host.definition.tasks) {
        try {
          const campaign = readUniverseCampaignReadiness(task.campaignId, { root: value.row.host.root });
          // Match the controller's existing fresh-enrollment acceptance. A
          // transient owner of untouched ready work may still be waited on.
          if (campaign.sourceState !== 'healthy' || !(campaign.automaticAction === 'run' ||
            campaign.observedState === 'completed' || campaign.observedState === 'ready' && campaign.disposition === 'owned')) {
            reasons.push('campaign-not-startable'); break;
          }
        } catch { reasons.push('campaign-not-startable'); break; }
      }
    }
    return [...new Set(reasons)];
  };
  const readiness = (value: Entry): ResourceConsoleEngineeringReadiness => {
    const result: ResourceConsoleEngineeringReadiness = { schemaVersion: 1, enrollmentId: value.row.id,
      enrollmentDigest: value.summary.enrollmentDigest, sampledAt: new Date().toISOString(), status: 'blocked', action: 'none',
      reasons: [], scope: 'local-admission-check-only', effectsExecuted: false, providerContacted: false };
    if (active.has(value.row.id)) return { ...result, status: 'not-applicable', reasons: ['already-running'] };
    try {
      const owned = ownership(value); const graph = readControlGraph(value.row.graphRoot);
      if (!owned.launch && (graph.sourceState !== 'missing' || present(join(value.row.graphRoot, 'control-graph'))) ||
        graph.sourceState !== 'missing' && graph.definitionDigest !== value.definitionDigest || graph.sourceState === 'degraded') {
        return { ...result, reasons: ['graph-evidence-unavailable'] };
      }
      if (owned.cancel) return { ...result, reasons: ['launch-cancelled'] };
      if (graph.status === 'completed') return { ...result, status: 'not-applicable', reasons: ['already-completed'] };
      if (owned.launch && (graph.sourceState === 'missing' || graph.nodes.some((node) => node.state === 'pending'))) {
        return { ...result, reasons: ['launch-unresolved'] };
      }
      if (owned.launch && Date.now() >= Date.parse(owned.launch.at) + value.row.host.definition.maxDurationMs ||
        graph.deadlineAt !== null && Date.now() >= Date.parse(graph.deadlineAt)) return { ...result, reasons: ['deadline-exhausted'] };
      if (owned.launch && graph.nodes.every((node) => node.state !== 'unresolved')) {
        return { ...result, status: 'not-applicable', reasons: ['graph-terminal'] };
      }
      const reasons = hardBlockers(value, !owned.launch);
      if (active.size >= MAX_ACTIVE) reasons.push('owner-capacity');
      return reasons.length ? { ...result, reasons } : { ...result, status: 'ready',
        action: owned.launch ? value.summary.allowPendingContinuation ? 'continue' : 'reconcile' : 'launch' };
    } catch { return { ...result, reasons: ['graph-evidence-unavailable'] }; }
  };
  const requireReady = (value: Entry) => {
    const state = readiness(value);
    if (state.status === 'blocked') {
      const conflict = state.reasons.some((reason) => ['launch-cancelled', 'launch-unresolved', 'deadline-exhausted',
        'controller-already-enrolled', 'graph-evidence-unavailable'].includes(reason));
      fail(conflict ? 'CONFLICT' : state.reasons.includes('owner-capacity') ? 'CAPACITY' : 'UNAVAILABLE',
        `Engineering readiness blocked: ${state.reasons.join(', ')}`);
    }
    return state;
  };
  const append = (value: Entry, kind: 'launch' | 'cancel', at: string, prepublish?: () => boolean) => {
    const record: OwnershipRecord = { schemaVersion: 1, kind, enrollmentDigest: value.summary.enrollmentDigest,
      definitionDigest: value.definitionDigest, at };
    const written = writeImmutablePrivateRecord(records(value.row.graphRoot), record, prepublish ? { prepublish } : {});
    if (!['recorded', 'replayed'].includes(written)) fail('UNAVAILABLE', 'Engineering ownership publication unavailable');
  };
  const prepareRegistration = (input: ResourceConsoleEngineeringCatalog) => {
      if (!registrationEnabled) fail('UNAVAILABLE', 'Engineering registration is disabled');
      if (closing || signal?.aborted) fail('UNAVAILABLE', 'Engineering owner is closing');
      const incoming = validateResourceConsoleEngineeringCatalog(input);
      const combined = [...enrolled.values()].map(value => value.row);
      for (const row of incoming.enrollments) {
        const existing = enrolled.get(row.id);
        if (existing) {
          if (canonical(existing.row) !== canonical(row)) fail('CONFLICT', 'Engineering enrollment identity changed');
        } else {
          if (combined.some(value => value.graphId === row.graphId)) fail('CONFLICT', 'Engineering graph identity is already enrolled');
          combined.push(row);
        }
      }
      if (combined.length > 32) fail('CAPACITY', 'Engineering enrollment capacity reached');
      const currentProjects = supervisor.projects();
      if (!currentProjects) fail('UNAVAILABLE', 'Register engineering projects first');
      const currentBindings = currentProjects.map(project => {
        const current = supervisor.engineeringBinding(project.id);
        if (current.root !== control.root || current.poolDigest !== poolDigest) fail('CONFLICT', 'Engineering accounting scope changed');
        if (combined.some(row => row.projectId === project.id) && !matchesResourceConsoleProject(current.project)) {
          fail('CONFLICT', 'Engineering project identity changed');
        }
        return current.project;
      });
      const checked = prepareResourceConsoleEngineeringEnrollments({ ...control, catalog: { schemaVersion: 1, enrollments: combined },
        projects: currentProjects, projectBindings: currentBindings });
      for (const value of checked) {
        const previous = enrolled.get(value.row.id);
        if (value.accountingPoolDigest !== poolDigest || previous &&
          (value.summary.enrollmentDigest !== previous.summary.enrollmentDigest || value.definitionDigest !== previous.definitionDigest)) {
          fail('CONFLICT', 'Engineering enrollment pins changed');
        }
      }
      if (closing || signal?.aborted) fail('UNAVAILABLE', 'Engineering owner is closing');
      // Preserve active invocation objects; publish the complete validated map
      // once. The caller owns persistence, and no automatic queue is amended.
      return new Map(checked.map(value => [value.row.id, enrolled.get(value.row.id) ?? value]));
  };
  const owner: ResourceConsoleEngineeringOwner = {
    catalog: () => snapshot([...enrolled.values()].map((value) => value.summary)),
    checkRegistration: (input) => snapshot([...prepareRegistration(input).values()].map(value => value.summary)),
    register(input) { enrolled = prepareRegistration(input); return owner.catalog(); },
    readiness: (id) => readiness(entry(id)),
    outcomes(id) {
      const value = entry(id);
      const verify = () => {
        if (closing) fail('UNAVAILABLE', 'Engineering owner is closing');
        const current = supervisor.engineeringBinding(value.row.projectId);
        const project = current.project;
        if (current.root !== control.root || current.poolDigest !== poolDigest ||
          canonical({ id: project.id, workspace: project.workspace, dev: project.dev, ino: project.ino }) !== canonical(value.projectIdentity) ||
          !matchesResourceConsoleProject(project)) fail('UNAVAILABLE', 'Engineering outcome project changed');
        if (canonical(createFirmEngineeringControlHandler(value.row.host).nodeInput) !== canonical(value.binding.nodeInput)) {
          fail('UNAVAILABLE', 'Engineering outcome enrollment changed');
        }
      };
      // Observation never calls admission, claims a lease, clears a stop, or
      // attributes a different campaign to this enrollment after source drift.
      verify();
      const report = readResourceEngineeringOutcomes({ enrollment: value.summary, host: value.row.host,
        root: control.root, poolFile: control.poolFile, bindingsFile: control.bindingsFile });
      verify(); return report;
    },
    evidenceFingerprint(id) {
      const value = entry(id);
      try {
        const collect = () => {
          const owned = ownership(value); const graph = readControlGraph(value.row.graphRoot);
          if (graph.sourceState === 'degraded') throw new Error();
          const directory = portfolioControllerDirectory(value.row.host.definition.id, { root: value.row.host.root });
          const controller = present(directory) ? readPortfolioControllerEvents(directory) : null;
          const campaigns = value.row.host.definition.tasks.map(({ campaignId }) => {
            const readiness = readUniverseCampaignReadiness(campaignId, { root: value.row.host.root });
            if (readiness.sourceState !== 'healthy') throw new Error();
            const target = value.row.host.deliveryPlan.deliveries.find(row => row.campaignId === campaignId)!;
            const delivery = readiness.observedState === 'completed'
              ? readCompletedCampaignDelivery(readUniverseCampaign(campaignId, { root: value.row.host.root }), target, { root: value.row.host.root }) : null;
            return { campaignId, identity: readiness.expectedIdentity, recordsDigest: readiness.recordsDigest, delivery };
          });
          return digest(canonical({ owned, graph, controller, campaigns }));
        };
        // No sampled timestamps or live owner-map state enters this identity.
        const before = collect(); return before === collect() ? before : null;
      } catch { return null; }
    },
    async awaitSettlement(id) {
      entry(id); await active.get(id)?.promise;
      if (faults.has(id)) fail('UNAVAILABLE', 'Engineering invocation settlement unavailable');
    },
    snapshot(id) {
      const value = entry(id);
      const base = { enrollmentId: id, projectId: value.row.projectId, graphId: value.row.graphId,
        enrollmentDigest: value.summary.enrollmentDigest, acceptanceScope: 'fixed-evaluator-and-local-branch-only' as const };
      try {
        const owned = ownership(value); const graph = readControlGraph(value.row.graphRoot);
        if (!owned.launch && (graph.sourceState !== 'missing' || present(join(value.row.graphRoot, 'control-graph'))) ||
          graph.sourceState !== 'missing' && graph.definitionDigest !== value.definitionDigest) throw new Error();
        const unavailable = graph.sourceState === 'degraded' || faults.has(id);
        const recoveryHeld = !!owned.launch && !active.has(id) && !owned.cancel &&
          (graph.sourceState === 'missing' || graph.nodes.some((node) => node.state === 'pending'));
        return { ...base, state: unavailable ? 'unavailable' : active.has(id) ? 'running' : owned.cancel ? 'stopped' :
          graph.sourceState === 'missing' ? owned.launch ? 'incomplete' : 'ready' : graph.status,
        sourceState: graph.sourceState, cancellable: !closing && !!owned.launch && !owned.cancel && graph.status !== 'completed',
        launched: !!owned.launch, cancelled: !!owned.cancel, definitionDigest: graph.definitionDigest,
        deadlineAt: graph.deadlineAt, nodes: graph.nodes, reasons: unavailable ? ['engineering-evidence-unavailable'] :
          owned.cancel ? ['engineering-cancelled'] : recoveryHeld ? ['engineering-launch-unresolved'] : graph.reasons };
      } catch {
        return { ...base, state: 'unavailable', sourceState: 'degraded', cancellable: false, launched: false, cancelled: false,
          definitionDigest: null, deadlineAt: null, nodes: [], reasons: ['engineering-evidence-unavailable'] };
      }
    },
    launch(input, controls) {
      if (controls !== undefined && (!controls || ![Object.prototype, null].includes(Object.getPrototypeOf(controls)) ||
          Reflect.ownKeys(controls).some(key => typeof key !== 'string' || !['signal', 'isExecutionStopped'].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(controls, key)!, 'value')) ||
          controls.signal !== undefined && !(controls.signal instanceof AbortSignal) ||
          controls.isExecutionStopped !== undefined && typeof controls.isExecutionStopped !== 'function')) {
        fail('INVALID_INPUT', 'Invalid engineering launch controls');
      }
      const launchSignal = controls?.signal; const launchGuard = controls?.isExecutionStopped;
      const stopped = () => { try { return launchSignal?.aborted === true || !!launchGuard?.(); } catch { return true; } };
      if (stopped()) fail('UNAVAILABLE', 'Engineering enclosing execution stopped');
      const request = snapshot<ResourceConsoleEngineeringLaunch>(input, 1024);
      if (!exact(request, ['enrollmentId', 'expectedEnrollmentDigest']) || typeof request.expectedEnrollmentDigest !== 'string' ||
        !HASH.test(request.expectedEnrollmentDigest)) fail('INVALID_INPUT', 'Invalid engineering launch');
      const value = entry(request.enrollmentId);
      if (request.expectedEnrollmentDigest !== value.summary.enrollmentDigest) fail('CONFLICT', 'Engineering enrollment changed');
      if (active.has(value.row.id)) return owner.snapshot(value.row.id);
      const ready = requireReady(value);
      if (ready.status === 'not-applicable') return owner.snapshot(value.row.id);
      admit(value);
      if (active.size >= MAX_ACTIVE) fail('CAPACITY', 'Engineering owner capacity reached');
      const acquired = acquireLocalStoreLockWithOutcome(join(value.row.graphRoot, '.console-engineering.lock'), 0,
        { anchorPath: value.row.graphRoot, exactPrivateStorage: true });
      if (acquired.state !== 'acquired') fail('UNAVAILABLE', 'Engineering graph is owned elsewhere');
      let handedOff = false;
      try {
        if (stopped()) fail('UNAVAILABLE', 'Engineering enclosing execution stopped');
        requireReady(value);
        const owned = ownership(value);
        if (owned.cancel) fail('CONFLICT', 'Engineering launch was cancelled');
        const graph = readControlGraph(value.row.graphRoot);
        if (!owned.launch && (graph.sourceState !== 'missing' || present(join(value.row.graphRoot, 'control-graph'))) ||
          graph.sourceState !== 'missing' && graph.definitionDigest !== value.definitionDigest) fail('CONFLICT', 'Engineering graph is not owned by this enrollment');
        if (graph.sourceState === 'degraded') fail('UNAVAILABLE', 'Engineering graph evidence unavailable');
        if (graph.status === 'completed') return owner.snapshot(value.row.id);
        if (owned.launch && (graph.sourceState === 'missing' || graph.nodes.some((node) => node.state === 'pending'))) {
          fail('CONFLICT', 'Engineering launch is unresolved; new dispatch is withheld');
        }
        if (owned.launch && Date.now() >= Date.parse(owned.launch.at) + value.row.host.definition.maxDurationMs) {
          fail('CONFLICT', 'Engineering launch deadline is exhausted');
        }
        if (!owned.launch) append(value, 'launch', new Date().toISOString(), () => {
          return ownsLocalStoreLock(acquired.lock) && hardBlockers(value, true).length === 0 && !stopped();
        });
        const abort = new AbortController();
        const stopLaunch = () => abort.abort();
        launchSignal?.addEventListener('abort', stopLaunch, { once: true });
        if (stopped()) abort.abort();
        const promise = Promise.resolve().then(async () => {
          if (abort.signal.aborted || closing) return;
          ranGraph = true;
          await runControlGraph(value.definition, { root: value.row.graphRoot, handlers: { deliver: value.binding.handler },
            signal: abort.signal, requireNewGraph: !owned.launch,
            isExecutionStopped: () => {
              admit(value, true);
              const current = ownership(value);
              return stopped() || !ownsLocalStoreLock(acquired.lock) || !!current.cancel || !current.launch ||
                Date.now() >= Date.parse(current.launch.at) + value.row.host.definition.maxDurationMs;
            } });
        }).catch(() => { faults.add(value.row.id); }).finally(() => {
          launchSignal?.removeEventListener('abort', stopLaunch);
          if (!releaseLocalStoreLock(acquired.lock)) faults.add(value.row.id);
          active.delete(value.row.id);
        });
        active.set(value.row.id, { abort, promise }); handedOff = true;
        return owner.snapshot(value.row.id);
      } finally { if (!handedOff) releaseLocalStoreLock(acquired.lock); }
    },
    cancel(id) {
      const value = entry(id);
      if (closing) fail('UNAVAILABLE', 'Engineering owner is closing');
      // Cancellation is permitted while paused/disabled: it only narrows effects.
      supervisor.engineeringBinding(value.row.projectId);
      const owned = ownership(value);
      if (!owned.launch) fail('CONFLICT', 'Engineering launch has not been accepted');
      if (owned.cancel) return owner.snapshot(id);
      if (owner.snapshot(id).state === 'completed') fail('CONFLICT', 'Engineering graph already completed');
      append(value, 'cancel', new Date(Math.max(Date.now(), Date.parse(owned.launch.at))).toISOString());
      active.get(id)?.abort.abort();
      return owner.snapshot(id);
    },
    close(closeOptions) {
      if (closeOptions !== undefined && (!exact(closeOptions, ['preserveSupervisorTasks']) || closeOptions.preserveSupervisorTasks !== true)) {
        fail('INVALID_INPUT', 'Invalid engineering close options');
      }
      const preserveSupervisorTasks = closeOptions?.preserveSupervisorTasks === true;
      if (closePromise) return closePromise;
      closing = true; signal?.removeEventListener('abort', onAbort);
      for (const value of active.values()) value.abort.abort();
      closePromise = Promise.allSettled([...active.values()].map((value) => value.promise)).then(async () => {
        // The server starts ordinary task shutdown alongside graph shutdown.
        // Await that same idempotent drain before inspecting their shared pool,
        // so a still-cancelling ordinary task is not a false uncertainty report.
        try { await waitForResourceDrain?.(); }
        catch { fail('UNAVAILABLE', 'Resource peer drain did not confirm termination'); }
        if (ranGraph) {
          // A settled graph promise does not prove that every worker exited.
          // Failed trial publication can omit attributable generation task IDs,
          // so conservatively inspect the existing shared ledger. This fence
          // deliberately makes no claim that an unresolved receipt is ours.
          // Component-only close can preserve a peer only when its live
          // supervisor proves fresh-dispatch custody of the exact task.
          try {
            const receipts = resourcePoolStatus(control.root, pool, bindings, []).attempts;
            if (receipts.some((receipt) => (receipt.status === 'reserved' || receipt.status === 'uncertain') &&
              !(preserveSupervisorTasks && supervisor.ownsActiveTaskReceipt?.(receipt) === true))) throw new Error();
          } catch { fail('UNAVAILABLE', 'Shared resource pool termination evidence unavailable'); }
        }
        if (faults.size) fail('UNAVAILABLE', 'Engineering shutdown evidence unavailable');
      });
      return closePromise;
    },
  };
  function onAbort() { void owner.close().catch(() => {}); }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { void owner.close(); fail('UNAVAILABLE', 'Engineering startup cancelled'); }
  return owner;
}
