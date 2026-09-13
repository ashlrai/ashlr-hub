/** Offline startup preparation. Never constructs an execution owner or modifies accounting policy. */
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { checkResourceEngineeringPreparation } from './engineering-preparation.js';
import type { ResourceEngineeringRecipe } from './engineering-preparation-types.js';
import { createResourceEngineeringPreparationRegistry, readResourceEngineeringPreparationRegistrations,
  resourceEngineeringPreparationRegistrationRoot, validateResourceConsoleEngineeringPreparationConfig } from './engineering-preparation-registry.js';
import { validateResourceConsoleEngineeringSupervisionConfig } from './console-engineering-supervisor.js';
import { validateResourceEngineeringSuccessorCoordinatorConfig } from './engineering-successor-coordinator.js';
import { prepareResourceConsoleEngineeringEnrollments, type ResourceConsoleEngineeringCatalog } from './console-engineering.js';
import { readResourceEngineeringDeliveredRegistration, type ResourceEngineeringDeliveredRegistration } from './engineering-delivered-source.js';
import { previewResourceConsoleProjects, ResourceSupervisorError } from './pool-supervisor.js';
import { matchesResourceConsoleProject, pinResourceConsoleProject, validateResourceConsoleProjects } from './console-projects.js';
import { readResourceConsoleStorage } from './console-state-storage.js';
import { readResourceJson, readResourcePoolHistory, resourcePoolStatus } from './pool-runtime.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import { captureResourceExecutionVeto } from './execution-veto.js';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import { matchesWorkspaceProofStorage, readResourceWorkspaceProof, type ResourceWorkspaceProofSource } from './workspace-proof-context.js';
import { takeWorkerSetupExecutionContext, type EngineeringSetupExecutionContext } from './engineering-setup-context.js';
import type { ResourceEngineeringAutonomousSetupOptions as Options, ResourceEngineeringAutonomousSetupPolicy as Policy,
  ResourceEngineeringAutonomousSetupPlan as Plan, ResourceEngineeringAutonomousSetupReport as Report } from './engineering-autonomous-setup-types.js';
export type * from './engineering-autonomous-setup-types.js';

const hash = (value: unknown) => digest(canonical(value));
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const SETUP_LOCK = '.resource-engineering-setup.lock';
function fail(message: string): never { throw new ResourceSupervisorError('CONFLICT', message); }
function data<T>(value: unknown): T {
  const json = canonicalEvidencePackJsonV3(value);
  if (json === null || Buffer.byteLength(json) > 256 * 1024) fail('Invalid autonomous setup data');
  return JSON.parse(json) as T;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function path(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && isAbsolute(value) && resolve(value) === value && parse(value).root !== value &&
    ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
}
export function validateResourceEngineeringAutonomousSetupPolicy(input: unknown): Policy {
  const value = data<Policy>(input);
  if (!exact(value, ['schemaVersion', 'id', 'profileId', 'label', 'acceptance', 'maxEnrollments', 'maxConcurrent', 'successors',
    ...(Object.hasOwn(value ?? {}, 'autoAdmitPrepared') ? ['autoAdmitPrepared'] : []),
    ...(Object.hasOwn(value ?? {}, 'registrationScope') ? ['registrationScope'] : [])]) || value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || !ID.test(value.id) || typeof value.profileId !== 'string' || !ID.test(value.profileId) ||
    Object.hasOwn(value, 'autoAdmitPrepared') && value.autoAdmitPrepared !== true ||
    Object.hasOwn(value, 'registrationScope') && (typeof value.registrationScope !== 'string' || !ID.test(value.registrationScope)) ||
    !Number.isSafeInteger(value.maxEnrollments) || value.maxEnrollments < 2 || value.maxEnrollments > 32 ||
    !Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 8 ||
    !exact(value.successors, ['allowedWorkerIds', 'maxOutputTokens', 'proposalTimeoutMs', 'maxSuccessors', 'pollIntervalMs'])) fail('Invalid autonomous setup policy');
  validateResourceEngineeringSuccessorCoordinatorConfig({ schemaVersion: 1, supervisionId: value.id, profileId: value.profileId, ...value.successors });
  if (value.successors.maxSuccessors > value.maxEnrollments - 1) fail('Successor capacity excludes the initial enrollment');
  return value;
}
function capture(input: Options, internal = false, custody?: ResourceWorkspaceProofSource) {
  const options = data<Options>(input);
  if (!exact(options, ['recipe', 'policy', 'output', 'resourceRuntime', 'workspace', 'projectsFile']) ||
    ![options.output, options.resourceRuntime, options.workspace, options.projectsFile].every(path)) fail('Invalid autonomous setup options');
  const policy = validateResourceEngineeringAutonomousSetupPolicy(options.policy);
  const recipe = options.recipe as ResourceEngineeringRecipe;
  if (!recipe || typeof recipe.id !== 'string' || !ID.test(recipe.id) || recipe.delivery?.branch !== `codex/${recipe.id}`) fail('Setup requires the exact manager delivery branch');
  inspectPrivateDirectory(options.output);
  const outputBinding = pinResourceConsoleProject({ id: 'setup-output', label: 'Setup output', workspace: options.output });
  const runtime = validateResourceGenerationRuntime(readResourceJson(options.resourceRuntime));
  inspectPrivateDirectory(runtime.root);
  if (!present(join(runtime.root, 'pool-state.json'))) fail('Setup requires an existing resource ledger');
  const pool = validateResourcePool(readResourceJson(runtime.poolPath));
  const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
  const projectsDocument = readResourceJson(options.projectsFile, 256 * 1024);
  if (!exact(projectsDocument, ['schemaVersion', 'projects']) || projectsDocument.schemaVersion !== 1) fail('Invalid setup projects');
  const projects = validateResourceConsoleProjects(projectsDocument.projects);
  const statePath = join(runtime.root, 'resource-console-state.json');
  const consoleStorage = present(statePath) ? readResourceConsoleStorage(readResourceJson(statePath, 4 * 1024 * 1024), {
    root: runtime.root, pool, bindings, workspace: options.workspace, configHistory: readResourcePoolHistory(runtime.root, pool, bindings) }) : undefined;
  const state = consoleStorage?.hotState;
  const preview = previewResourceConsoleProjects({ workspace: options.workspace, projects, state });
  if (!preview.bindings || !preview.projects) fail('Setup requires explicit project bindings');
  const paths: Plan['paths'] = { profiles: join(options.output, 'profiles.json'), supervision: join(options.output, 'supervision.json'),
    successors: join(options.output, 'successors.json'), intent: join(options.output, 'setup-intent.json'), receipt: join(options.output, 'setup-receipt.json'),
    initialBundle: join(options.output, recipe.id), registration: join(resourceEngineeringPreparationRegistrationRoot(runtime.root, policy.registrationScope), 'records', `${recipe.id}.json`) };
  const controls = [options.resourceRuntime, options.projectsFile, runtime.poolPath, runtime.bindingsPath, runtime.observationsPath,
    ...(runtime.quotaConfigPath ? [runtime.quotaConfigPath] : [])];
  for (const other of [runtime.root, runtime.workspace, ...preview.bindings.map(row => row.workspace), ...controls]) {
    if (contains(options.output, other) || contains(other, options.output)) fail('Setup output must be outside projects, runtime and accounting controls');
  }
  const profileConfig = validateResourceConsoleEngineeringPreparationConfig({ schemaVersion: 1, outputRoot: options.output, resourceRuntime: options.resourceRuntime,
    ...(policy.registrationScope === undefined ? {} : { registrationScope: policy.registrationScope }),
    profiles: [{ id: policy.profileId, label: policy.label, acceptance: policy.acceptance, recipe }] });
  const successorConfig = validateResourceEngineeringSuccessorCoordinatorConfig({ schemaVersion: 1, supervisionId: policy.id, profileId: policy.profileId, ...policy.successors });
  if (successorConfig.allowedWorkerIds.some(id => !pool.workers.some(row => row.id === id))) fail('Unknown proposal worker');
  const supervision = (enrollmentDigest: string) => validateResourceConsoleEngineeringSupervisionConfig({ schemaVersion: 1, id: policy.id,
    ...recipe.supervision, maxConcurrent: policy.maxConcurrent, maxEnrollments: policy.maxEnrollments,
    ...(policy.autoAdmitPrepared ? { autoAdmitPrepared: true } : {}), enrollments: [{ enrollmentId: recipe.id, expectedEnrollmentDigest: enrollmentDigest }] });
  supervision('0'.repeat(64));
  const bundleOptions = { recipe, output: paths.initialBundle, resourceRuntime: options.resourceRuntime, workspace: options.workspace, projectsFile: options.projectsFile };
  const bundlePlan = checkResourceEngineeringPreparation(bundleOptions);
  const poolState = resourcePoolStatus(runtime.root, pool, bindings, []);
  const owner = custody === undefined ? null : readResourceWorkspaceProof(custody,
    { root: runtime.root, workspace: options.workspace, poolDigest: hash({ pool, bindings }) });
  if (owner && (!consoleStorage || !matchesWorkspaceProofStorage(owner, consoleStorage))) fail('Workspace state changed during setup');
  const holds: string[] = [];
  const kill = readKillSwitch(); if (kill.state !== 'inactive' || kill.sourceState !== 'healthy') holds.push('global-kill-active-or-unavailable');
  if (!loadExistingProvenanceKeyReadOnly()) holds.push('provenance-unavailable');
  if (state?.paused) holds.push('queue-paused');
  if (!owner && state?.jobs.some(row => row.state === 'queued')) holds.push('ordinary-queued-work-retained');
  if (!owner && state?.jobs.some(row => row.state === 'dispatching' || row.state === 'unresolved')) holds.push('console-work-unresolved');
  const lockPath = join(runtime.root, '.resource-console.lock');
  if (!owner && present(lockPath)) holds.push('console-ownership-present');
  if (owner ? !owner.isPoolAvailable() : present(join(runtime.root, '.pool.lock'))) holds.push('pool-ownership-present');
  if (!owner?.lockPaths.includes(join(runtime.root, '.resource-quota-refresh.lock')) &&
    present(join(runtime.root, '.resource-quota-refresh.lock'))) holds.push('quota-ownership-present');
  if (!owner?.metadataPending && present(join(runtime.root, '.resource-quota-refresh-pending.json'))) holds.push('quota-work-unresolved');
  if (poolState.attempts.some(row => row.status === 'uncertain' || row.status === 'reserved' && !owner?.ownsReceipt(row))) holds.push('resource-work-unresolved');
  const completed = present(paths.receipt);
  if (!internal && !completed) {
    if (present(join(runtime.root, SETUP_LOCK))) fail('Setup publication ownership unavailable');
    if (readdirSync(options.output).length) fail('Incomplete setup requires inspection; no automatic repair');
    if (holds.some(reason => reason.endsWith('-ownership-present') || reason.endsWith('-work-unresolved'))) fail('Setup requires stopped, resolved console ownership');
    if (readResourceEngineeringPreparationRegistrations(runtime.root, policy.registrationScope).length) fail('Existing preparation history requires its original setup context');
    if (present(join(runtime.root, 'engineering-supervision', policy.id)) || present(join(runtime.root, 'engineering-successors', policy.id))) fail('Setup policy identity already exists');
  }
  const planDigest = hash({ schemaVersion: 1, options, outputBinding, runtimeDigest: hash(runtime), poolDigest: hash({ pool, bindings }),
    projectBindings: preview.bindings, projects: preview.projects, bundlePlanDigest: bundlePlan.planDigest, profileConfig, successorConfig });
  const plan: Plan = { schemaVersion: 1, status: 'planned', scope: 'local-autonomous-setup-only', planDigest, output: options.output,
    projectId: recipe.projectId, seedRevision: recipe.seedRevision, initialEnrollmentDigest: null, executionStarted: false, providerContacted: false, paths, holds };
  if (consoleStorage && !consoleStorage.isCurrent()) fail('Console history changed during setup');
  return { options, policy, recipe, runtime, pool, bindings, preview, paths, plan, completed, outputBinding, lockPath, profileConfig, successorConfig, supervision, custody };
}
function registry(current: ReturnType<typeof capture>) {
  return createResourceEngineeringPreparationRegistry({ configFile: current.paths.profiles, config: current.profileConfig, root: current.runtime.root,
    workspace: current.options.workspace, projectsFile: current.options.projectsFile, poolFile: current.runtime.poolPath,
    bindingsFile: current.runtime.bindingsPath, observationsFile: current.runtime.observationsPath,
    ...(current.runtime.quotaConfigPath ? { quotaConfigFile: current.runtime.quotaConfigPath } : {}) });
}
function verified(current: ReturnType<typeof capture>, includeDeliveredSources = false) {
  const saved = readResourceJson(current.paths.receipt, 64 * 1024);
  if (!exact(saved, ['schemaVersion', 'planDigest', 'initialEnrollmentDigest', 'registrationDigest', 'files']) || saved.schemaVersion !== 1 ||
    saved.planDigest !== current.plan.planDigest || typeof saved.initialEnrollmentDigest !== 'string' || !HASH.test(saved.initialEnrollmentDigest) ||
    typeof saved.registrationDigest !== 'string' || !HASH.test(saved.registrationDigest)) fail('Setup receipt changed');
  const expectedFiles = { profiles: current.profileConfig, supervision: current.supervision(saved.initialEnrollmentDigest), successors: current.successorConfig };
  const files = Object.fromEntries(Object.entries(expectedFiles).map(([name, value]) => {
    const file = current.paths[name as keyof typeof expectedFiles]; if (canonical(readResourceJson(file)) !== canonical(value)) fail('Setup configuration changed');
    return [name, hash(value)];
  }));
  if (canonical(files) !== canonical(saved.files) || canonical(readResourceJson(current.paths.intent)) !== canonical({ schemaVersion: 1, planDigest: current.plan.planDigest })) fail('Setup evidence changed');
  const entries = registry(current); const rows = entries.registrations();
  const initial = rows.find(row => row.request.id === current.recipe.id);
  if (!initial || hash(initial) !== saved.registrationDigest || initial.enrollmentDigest !== saved.initialEnrollmentDigest) fail('Initial preparation registration changed');
  const verifiedEntries: ResourceEngineeringDeliveredRegistration[] = rows.map(row => {
    if (!includeDeliveredSources) return { registration: row, verified: entries.committed(row, row.request, true), source: null };
    const result = readResourceEngineeringDeliveredRegistration(entries, row.request.id, row.enrollmentDigest);
    if (canonical(result.registration) !== canonical(row)) fail('Preparation registration changed during read');
    return result;
  });
  if (capture(current.options, true, current.custody).plan.planDigest !== current.plan.planDigest) fail('Setup changed during read');
  return { initialEnrollmentDigest: saved.initialEnrollmentDigest, registry: entries, entries: verifiedEntries };
}
export function checkResourceEngineeringAutonomousSetup(options: Options, custody?: ResourceWorkspaceProofSource): Plan {
  const current = capture(options, false, custody);
  if (current.completed) current.plan.initialEnrollmentDigest = verified(current).initialEnrollmentDigest;
  return current.plan;
}

export interface ResourceEngineeringAutonomousSetupEvidence {
  plan: Plan;
  registry: ReturnType<typeof createResourceEngineeringPreparationRegistry>;
  entries: ResourceEngineeringDeliveredRegistration[];
}

/** One private read-only sample of a completed setup. Each registration's full
 * metadata verification feeds its catalog and delivered-source projection once.
 * No proof is cached across invocations; consumers must take their independent
 * second sample and retain publication/custody guards. A null source is not a
 * completed delivery, and these facts alone do not authorize continuation. */
export function readResourceEngineeringAutonomousSetupEvidence(options: Options, custody?: ResourceWorkspaceProofSource): ResourceEngineeringAutonomousSetupEvidence {
  const current = capture(options, false, custody);
  if (!current.completed) fail('Completed setup evidence is required');
  const result = verified(current, true);
  current.plan.initialEnrollmentDigest = result.initialEnrollmentDigest;
  return { plan: current.plan, registry: result.registry, entries: result.entries };
}
function report(current: ReturnType<typeof capture>, enrollmentDigest: string, disposition: Report['disposition']): Report {
  const runtime = current.runtime;
  return { ...current.plan, status: 'prepared', initialEnrollmentDigest: enrollmentDigest, disposition,
    consoleArguments: ['resources', 'pool', 'console', '--execute', '--root', runtime.root, '--pool', runtime.poolPath,
      '--bindings', runtime.bindingsPath, '--observations', runtime.observationsPath, '--workspace', current.options.workspace,
      '--projects', current.options.projectsFile, '--engineering-preparation', current.paths.profiles,
      '--engineering-supervision', current.paths.supervision, '--engineering-successors', current.paths.successors,
      ...(runtime.quotaConfigPath ? ['--quota-config', runtime.quotaConfigPath] : [])] };
}
function writePrivate(file: string, value: unknown, guard: () => void): void {
  guard(); const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dirname(file)); guard();
}
export function prepareResourceEngineeringAutonomousSetup(input: Options & { expectedPlanDigest: string },
  host: { isExecutionStopped?: () => boolean; beforePublication?: (locks: readonly LocalStoreLock[]) => void;
    workspaceCustody?: ResourceWorkspaceCustody } = {}): Report {
  const property = Object.getOwnPropertyDescriptor(host, 'workspaceCustody');
  if (property && !Object.hasOwn(property, 'value') || !property && 'workspaceCustody' in host) fail('Invalid workspace custody');
  const custody = property?.value as ResourceWorkspaceCustody | undefined;
  if (property) readResourceWorkspaceCustody(custody!);
  return prepareSetup(input, host, custody, custody ? [...readResourceWorkspaceCustody(custody).locks] : []);
}

/** Private fixed-worker entrypoint. A serialized value or proof reader is never execution authority. */
export function prepareResourceEngineeringAutonomousSetupInWorker(input: Options & { expectedPlanDigest: string },
  context: EngineeringSetupExecutionContext,
  beforePublication: (locks: readonly LocalStoreLock[], proof?: ResourceWorkspaceProofSource) => void): Report {
  const execution = takeWorkerSetupExecutionContext(context, input);
  const verify = (locks: readonly LocalStoreLock[]) => { execution.assertActive(); beforePublication(locks, execution.proof); execution.assertActive(); };
  verify([]);
  return prepareSetup(input, { isExecutionStopped: () => { execution.assertActive(); return false; }, beforePublication: verify }, execution.proof, [], true);
}

function prepareSetup(input: Options & { expectedPlanDigest: string },
  host: { isExecutionStopped?: () => boolean; beforePublication?: (locks: readonly LocalStoreLock[]) => void },
  custody?: ResourceWorkspaceProofSource, borrowedLocks: LocalStoreLock[] = [], auditInitialization = false): Report {
  const hostStopped = captureResourceExecutionVeto(host);
  const publication = Object.getOwnPropertyDescriptor(host, 'beforePublication');
  if (publication && (!Object.hasOwn(publication, 'value') || typeof publication.value !== 'function') ||
      !publication && 'beforePublication' in host) fail('Invalid host publication guard');
  const beforeHostPublication = publication?.value as ((locks: readonly LocalStoreLock[]) => unknown) | undefined;
  const supplied = data<Options & { expectedPlanDigest: string }>(input);
  if (!exact(supplied, ['recipe', 'policy', 'output', 'resourceRuntime', 'workspace', 'projectsFile', 'expectedPlanDigest']) ||
    typeof supplied.expectedPlanDigest !== 'string' || !HASH.test(supplied.expectedPlanDigest)) fail('Setup requires a checked plan digest');
  const { expectedPlanDigest, ...options } = supplied;
  const current = capture(options, false, custody);
  if (current.plan.planDigest !== expectedPlanDigest) fail('Setup plan changed');
  if (current.completed) return report(current, verified(current).initialEnrollmentDigest, 'replayed');
  if (hostStopped()) fail('Host setup publication stopped');
  const locks = [...borrowedLocks];
  const borrowedPaths = custody ? readResourceWorkspaceProof(custody).lockPaths : [];
  if (borrowedPaths.some(file => !['.resource-console.lock', '.resource-quota-refresh.lock'].some(name => file === join(current.runtime.root, name)))) fail('Setup ownership scope changed');
  const acquiredLocks: LocalStoreLock[] = [];
  let setupLock: LocalStoreLock | undefined;
  let result: Report;
  try {
    if (custody) {
      // The live console fences pool-epoch changes. Serialize preparation
      // separately so ordinary receipt settlement can still transact on the
      // ledger. This lease is not a resource lock lent to predecessor proofs.
      const file = join(current.runtime.root, SETUP_LOCK);
      if (present(file)) fail('Setup publication ownership unavailable');
      const next = acquireLocalStoreLockWithOutcome(file, 0, { anchorPath: current.runtime.root, exactPrivateStorage: true });
      if (next.state !== 'acquired') fail('Setup publication ownership unavailable');
      setupLock = next.lock; acquiredLocks.push(next.lock);
    }
    const resourceLocks = custody ? ['.resource-console.lock', '.resource-quota-refresh.lock'] :
      ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'];
    for (const name of resourceLocks) {
      const file = join(current.runtime.root, name);
      if (locks.some(lock => lock.path === file) || borrowedPaths.includes(file)) continue;
      if (present(file)) fail('Setup requires stopped resource ownership');
      const next = acquireLocalStoreLockWithOutcome(file, 0, { anchorPath: current.runtime.root, exactPrivateStorage: true });
      if (next.state !== 'acquired') fail('Setup resource ownership unavailable');
      locks.push(next.lock); acquiredLocks.push(next.lock);
    }
    const guard = () => {
      if (hostStopped()) fail('Host setup publication stopped');
      if (locks.some(lock => !ownsLocalStoreLock(lock)) || setupLock && !ownsLocalStoreLock(setupLock) ||
        !matchesResourceConsoleProject(current.outputBinding)) fail('Setup ownership changed');
      if (custody && borrowedPaths.some(file => !readResourceWorkspaceProof(custody).lockPaths.includes(file))) fail('Setup borrowed ownership changed');
      const fresh = capture(options, true, custody);
      if (fresh.plan.planDigest !== expectedPlanDigest || fresh.plan.holds.some(reason => reason.endsWith('-work-unresolved') ||
        custody && reason === 'pool-ownership-present')) fail('Setup inputs or resource ownership changed');
      if (hostStopped()) fail('Host setup publication stopped');
    };
    guard();
    if (readdirSync(options.output).length || readResourceEngineeringPreparationRegistrations(current.runtime.root, current.policy.registrationScope).length) fail('Setup target changed before publication');
    writePrivate(current.paths.intent, { schemaVersion: 1, planDigest: expectedPlanDigest }, guard);
    writePrivate(current.paths.profiles, current.profileConfig, guard);
    writePrivate(current.paths.successors, current.successorConfig, guard);
    const entries = registry(current);
    const request = { id: current.recipe.id, profileId: current.policy.profileId, name: current.recipe.name, objective: current.recipe.objective };
    const checked = entries.materialize(request);
    const beforePublication = (catalog: ResourceConsoleEngineeringCatalog) => {
      guard();
      const fresh = capture(options, true, custody);
      prepareResourceConsoleEngineeringEnrollments({ root: current.runtime.root, poolFile: current.runtime.poolPath,
        bindingsFile: current.runtime.bindingsPath, observationsFile: current.runtime.observationsPath,
        ...(current.runtime.quotaConfigPath ? { quotaConfigFile: current.runtime.quotaConfigPath } : {}), catalog,
        projects: fresh.preview.projects!, projectBindings: fresh.preview.bindings! });
      const result = beforeHostPublication?.(Object.freeze([...locks]));
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) fail('Host publication guard must be synchronous');
      guard();
    };
    const prepared = entries.prepare({ ...request, expectedPlanDigest: checked.plan.planDigest }, {
      beforeNew: () => { guard(); if (entries.registrations().length) fail('Preparation identity already exists'); }, beforePublication });
    writePrivate(current.paths.supervision, current.supervision(prepared.enrollmentDigest), guard);
    const registration = entries.registrations().find(row => row.request.id === request.id);
    if (!registration) fail('Initial registration was not published');
    const receipt = { schemaVersion: 1, planDigest: expectedPlanDigest, initialEnrollmentDigest: prepared.enrollmentDigest,
      registrationDigest: hash(registration), files: { profiles: hash(current.profileConfig), supervision: hash(current.supervision(prepared.enrollmentDigest)), successors: hash(current.successorConfig) } };
    beforePublication(prepared.catalog);
    writePrivate(current.paths.receipt, receipt, guard);
    result = report(current, verified(current).initialEnrollmentDigest, 'created');
  } finally {
    let released = true;
    // Borrowed workspace/collector locks outlive this setup. Release only the
    // leases acquired here, including on partial preparation failure.
    for (const lock of acquiredLocks.reverse()) if (!releaseLocalStoreLock(lock)) released = false;
    if (auditInitialization) {
      // Initializers release their own leases in finally. A normal return is
      // insufficient if that release failed; inspect only the exact known
      // initialization stores, never reclaim someone else's lock or staging.
      const universe = join(current.paths.initialBundle, 'universe', 'universes', current.recipe.id);
      const campaign = join(current.paths.initialBundle, 'universe', 'campaigns', current.recipe.id);
      for (const file of [join(universe, '.run.lock'), join(universe, 'ledger', '.records.lock'),
        join(campaign, 'ledger', '.records.lock'), join(dirname(dirname(current.paths.registration)), '.records.lock')]) {
        try { if (present(file)) released = false; } catch { released = false; }
      }
    }
    if (!released) fail('Setup ownership cleanup could not be confirmed');
  }
  return result;
}
