/** Trusted local registration bridge. No executor, scheduler, key creation or provider calls. */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, executable, inspectPrivateDirectory, pinSeed, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES } from '../universe/artifacts.js';
import { assertComparatorUnchanged, initUniverse, manifestRecord, universePath, validateUniverseManifest } from '../universe/store.js';
import { initUniverseCampaign, readUniverseCampaign, validateUniverseCampaignDefinition } from '../universe/campaign-store.js';
import { validateUniverseCampaignDeliveryPlan } from '../universe/campaign-delivery.js';
import { validateUniversePortfolioDefinition } from '../universe/portfolio-plan.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { checkResourceGenerationRuntime } from '../universe/resource-runtime-check.js';
import { fsyncDirectory } from '../util/durability.js';
import { readResourceJson, readResourcePoolHistory } from './pool-runtime.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import { matchesResourceConsoleProject, validateResourceConsoleProjects } from './console-projects.js';
import { decodeResourceConsoleState, previewResourceConsoleProjects, ResourceSupervisorError } from './pool-supervisor.js';
import { prepareResourceConsoleEngineeringEnrollments, type ResourceConsoleEngineeringCatalog } from './console-engineering.js';
import { checkResourceConsoleEngineering } from './console-engineering-check.js';
import { validateResourceConsoleEngineeringSupervisionConfig } from './console-engineering-supervisor.js';
import type { ResourceEngineeringPreparationOptions, ResourceEngineeringPreparationPlan, ResourceEngineeringPreparationReport,
  ResourceEngineeringRecipe } from './engineering-preparation-types.js';
export type { ResourceEngineeringPreparationOptions, ResourceEngineeringPreparationPlan, ResourceEngineeringPreparationReport,
  ResourceEngineeringRecipe } from './engineering-preparation-types.js';

const HASH = /^[a-f0-9]{64}$/;
function fail(code: 'INVALID_INPUT' | 'CONFLICT' | 'UNAVAILABLE', message: string): never { throw new ResourceSupervisorError(code, message); }
function data<T>(input: unknown): T {
  const text = canonicalEvidencePackJsonV3(input);
  if (text === null || Buffer.byteLength(text) > 256 * 1024) fail('INVALID_INPUT', 'Invalid preparation data');
  return JSON.parse(text) as T;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function path(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && [...value].every(c => c.charCodeAt(0) >= 32 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function sha(value: unknown): string { return digest(canonical(value)); }
function git(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
    timeout: 30_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

function capture(input: ResourceEngineeringPreparationOptions) {
  const options = data<ResourceEngineeringPreparationOptions>(input);
  if (!exact(options, ['recipe', 'output', 'resourceRuntime', 'workspace', 'projectsFile']) ||
      ![options.output, options.resourceRuntime, options.workspace, options.projectsFile].every(path)) fail('INVALID_INPUT', 'Invalid preparation options');
  inspectPrivateDirectory(dirname(options.output));
  const recipe = options.recipe as ResourceEngineeringRecipe;
  if (!exact(recipe, ['schemaVersion', 'id', 'name', 'objective', 'projectId', 'seedRevision', 'metric', 'evaluation', 'trialBudget',
    'campaignBudget', 'generation', 'delivery', 'execution', 'supervision']) || recipe.schemaVersion !== 1 ||
    !exact(recipe.generation, ['files', 'contextFiles', 'allowedWorkerIds', 'maxOutputTokens', 'hypotheses']) ||
    !Array.isArray(recipe.generation.hypotheses) || recipe.generation.hypotheses.some(h => !exact(h, ['id', 'niche', 'hypothesis'])) ||
    !exact(recipe.delivery, ['branch', ...(Object.hasOwn(recipe.delivery ?? {}, 'allowInitialRepair') ? ['allowInitialRepair'] : [])]) ||
    !exact(recipe.execution, ['maxDurationMs', 'constitutionVersion', 'policyEpoch']) ||
    !exact(recipe.supervision, ['maxDurationMs', 'pollIntervalMs', 'maxAttemptsPerEnrollment']) ||
    typeof recipe.execution.constitutionVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(recipe.execution.constitutionVersion) ||
    !Number.isSafeInteger(recipe.execution.policyEpoch) || recipe.execution.policyEpoch < 0) fail('INVALID_INPUT', 'Invalid preparation recipe');
  const runtime = validateResourceGenerationRuntime(readResourceJson(options.resourceRuntime));
  if (runtime.localModelConfigPath !== undefined || (runtime.quotaConfigPath !== undefined
    ? runtime.quotaEvidenceMode !== 'shared-collector' : runtime.quotaEvidenceMode !== undefined)) fail('INVALID_INPUT', 'Preparation requires console shared collector semantics');
  const pool = validateResourcePool(readResourceJson(runtime.poolPath));
  const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
  const poolDigest = sha({ pool, bindings }); const runtimeDigest = sha(runtime);
  const projectsDocument = readResourceJson(options.projectsFile, 256 * 1024) as { schemaVersion: unknown; projects: unknown };
  if (!exact(projectsDocument, ['schemaVersion', 'projects']) || projectsDocument.schemaVersion !== 1) fail('INVALID_INPUT', 'Invalid preparation project catalog');
  const projects = validateResourceConsoleProjects(projectsDocument.projects);
  const stateFile = join(runtime.root, 'resource-console-state.json');
  const state = present(stateFile) ? decodeResourceConsoleState(readResourceJson(stateFile, 4 * 1024 * 1024), {
    pool, bindings, workspace: options.workspace, configHistory: readResourcePoolHistory(runtime.root, pool, bindings) }) : undefined;
  const preview = previewResourceConsoleProjects({ workspace: options.workspace, projects, state });
  const project = preview.bindings?.find(row => row.id === recipe.projectId);
  if (!project || !preview.projects?.find(row => row.id === recipe.projectId)?.enabled || !matchesResourceConsoleProject(project)) {
    fail('CONFLICT', 'Preparation project is missing, disabled or changed');
  }
  const controls = [options.resourceRuntime, options.projectsFile, runtime.poolPath, runtime.bindingsPath, runtime.observationsPath,
    ...(runtime.quotaConfigPath ? [runtime.quotaConfigPath] : [])];
  if (preview.projects!.some(row => overlaps(options.output, row.workspace) || overlaps(runtime.root, row.workspace) ||
    controls.some(file => contains(row.workspace, file))) || [runtime.root, runtime.workspace, ...controls].some(file => overlaps(options.output, file))) {
    fail('INVALID_INPUT', 'Preparation output and controls must be outside projects and shared accounting');
  }
  const seed = pinSeed(project.workspace, recipe.seedRevision);
  const paths = { output: options.output, universeRoot: join(options.output, 'universe'), graphRoot: join(options.output, 'graph'),
    manifest: join(options.output, 'manifest.json'), campaign: join(options.output, 'campaign.json'),
    engineering: join(options.output, 'engineering.json'), supervision: join(options.output, 'supervision.json'), receipt: join(options.output, 'receipt.json') };
  const ids = { universeId: recipe.id, campaignId: recipe.id, enrollmentId: recipe.id, graphId: recipe.id, controllerId: recipe.id };
  const manifest = validateUniverseManifest({ schemaVersion: 1, id: recipe.id, name: recipe.name, objective: recipe.objective, seed,
    metric: recipe.metric, budget: recipe.trialBudget, evaluation: recipe.evaluation,
    variants: recipe.generation.hypotheses.map(h => ({ ...h, generation: { kind: 'resource-pool', poolId: pool.id, poolDigest,
      allowedWorkerIds: recipe.generation.allowedWorkerIds, files: recipe.generation.files, maxOutputTokens: recipe.generation.maxOutputTokens,
      fileOperations: { schemaVersion: 1, contextFiles: recipe.generation.contextFiles } } })) });
  if (recipe.generation.allowedWorkerIds.some(id => !pool.workers.some(worker => worker.id === id))) fail('INVALID_INPUT', 'Preparation worker is not in the existing pool');
  const campaign = validateUniverseCampaignDefinition({ schemaVersion: 1, id: recipe.id, universeId: recipe.id,
    feedback: true, measureSeed: true, budget: recipe.campaignBudget });
  const definition = validateUniversePortfolioDefinition({ schemaVersion: 1, id: recipe.id,
    tasks: [{ campaignId: recipe.id, dependsOn: [] }], maxParallel: 1, maxDurationMs: recipe.execution.maxDurationMs });
  const deliveryPlan = validateUniverseCampaignDeliveryPlan({ schemaVersion: 1, deliveries: [{ campaignId: recipe.id,
    branch: recipe.delivery.branch, baseCommit: seed.revision, ...(recipe.delivery.allowInitialRepair === true ? { allowInitialRepair: true } : {}) }] }, [recipe.id]);
  // A completed bundle may legitimately have delivered this branch already.
  // Fresh preparation must not knowingly enroll an occupied publication target.
  if (!present(options.output) && git(seed.repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${recipe.delivery.branch}`])
    .toString('utf8').trim()) fail('CONFLICT', 'Preparation delivery branch already exists');
  if (Object.hasOwn(recipe.delivery, 'allowInitialRepair') && recipe.delivery.allowInitialRepair !== true) fail('INVALID_INPUT', 'Initial repair policy must be explicit true or absent');
  const supervisionBase = { schemaVersion: 1 as const, id: recipe.id, ...recipe.supervision, maxConcurrent: 1 };
  validateResourceConsoleEngineeringSupervisionConfig({ ...supervisionBase, enrollments: [{ enrollmentId: recipe.id, expectedEnrollmentDigest: '0'.repeat(64) }] });
  const tree = git(seed.repo, ['ls-tree', '-rlz', '--full-tree', seed.revision]).toString('utf8').split('\0').filter(Boolean);
  const directories = new Set<string>(); let seedBytes = 0;
  const entries = new Map<string, string>();
  for (const entry of tree) {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\s+([0-9]+)\t(.+)$/.exec(entry);
    if (!match) fail('INVALID_INPUT', 'Preparation seed contains unsupported entries');
    const file = match[4]!; const parts = file.split('/');
    if (parts.some(part => !part || ['.', '..', '.git', '.ashlr'].includes(part))) fail('INVALID_INPUT', 'Preparation seed contains unsupported paths');
    seedBytes += Number(match[3]);
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
    entries.set(file, match[2]!);
  }
  // Match the artifact reader's shared capacity limits, including directories.
  if (entries.size + directories.size > MAX_ARTIFACT_ENTRIES || seedBytes > MAX_ARTIFACT_BYTES) fail('INVALID_INPUT', 'Preparation seed exceeds artifact bounds');
  const command = executable(manifest.evaluation.command, seed.repo);
  const protectedFiles: string[] = [];
  for (const [index, arg] of manifest.evaluation.command.entries()) {
    if (index === 0) { if (contains(seed.repo, command[0]!)) protectedFiles.push(relative(seed.repo, command[0]!)); continue; }
    if (arg.split(/[\\/]/).includes('..')) fail('INVALID_INPUT', 'Evaluator paths cannot escape the pinned source');
    const target = /^([^=]+=)(.*)$/.exec(arg)?.[2] ?? arg;
    if (isAbsolute(target) && !contains(seed.repo, target)) fail('INVALID_INPUT', 'Evaluator file arguments must belong to the pinned source');
    const local = isAbsolute(target) ? relative(seed.repo, target) : target.replace(/^\.\//, '');
    if (entries.has(local)) protectedFiles.push(local);
    else if (isAbsolute(target) || target.includes('/') && !target.startsWith('-')) fail('INVALID_INPUT', 'Evaluator file is absent from the pinned source');
  }
  if (!protectedFiles.length || protectedFiles.some(file => recipe.generation.files.includes(file)) ||
    recipe.generation.contextFiles.some(file => !entries.has(file))) fail('INVALID_INPUT', 'Fixed evaluator must be tracked and outside mutable paths');
  const evaluatorPins = { executable: command[0], executableDigest: digest(readFileSync(command[0]!)),
    files: [...new Set(protectedFiles)].sort().map(file => ({ path: file, digest: digest(git(seed.repo, ['cat-file', 'blob', entries.get(file)!])) })) };
  const runtimeCheck = checkResourceGenerationRuntime({ resourceRuntime: options.resourceRuntime, expectedRuntimeDigest: runtimeDigest });
  if (runtimeCheck.status !== 'valid') fail('UNAVAILABLE', 'Preparation resource runtime is invalid');
  const quotaDigest = runtime.quotaConfigPath ? sha(readResourceJson(runtime.quotaConfigPath)) : null;
  const pins = { schemaVersion: 1, options, runtimeDigest, poolDigest, projectsDigest: sha(projectsDocument), project,
    quotaDigest, evaluatorPins, manifest, campaign, definition, deliveryPlan };
  const plan: ResourceEngineeringPreparationPlan = { schemaVersion: 1, status: 'planned', scope: 'local-preparation-only',
    planDigest: sha(pins), output: options.output, enrollmentDigest: null, projectId: recipe.projectId,
    projectRegistration: state?.projects?.some(row => row.id === project.id && row.workspace === project.workspace &&
      row.dev === project.dev && row.ino === project.ino) ? 'persisted' : 'would-register', executionStarted: false,
    providerContacted: false, paths, ids, seedRevision: seed.revision, runtimeDigest, poolDigest };
  return { options, recipe, runtime, preview, paths, plan, manifest, campaign, definition, deliveryPlan, supervisionBase };
}

/** All observations are nonexecuting. A matching digest is configuration confirmation, not launch authority. */
export function checkResourceEngineeringPreparation(options: ResourceEngineeringPreparationOptions): ResourceEngineeringPreparationPlan {
  const first = capture(options); const final = capture(options);
  if (first.plan.planDigest !== final.plan.planDigest) fail('CONFLICT', 'Preparation inputs changed while inspecting');
  return final.plan;
}

function writePrivate(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(dirname(file));
}
function generated(current: ReturnType<typeof capture>) {
  const { recipe, runtime, paths, options } = current;
  const catalog: ResourceConsoleEngineeringCatalog = { schemaVersion: 1, enrollments: [{ id: recipe.id, projectId: recipe.projectId,
    graphId: recipe.id, graphRoot: paths.graphRoot, host: { nodeId: recipe.id, root: paths.universeRoot,
      constitutionVersion: recipe.execution.constitutionVersion, policyEpoch: recipe.execution.policyEpoch,
      definition: current.definition, deliveryPlan: current.deliveryPlan, resourceRuntime: options.resourceRuntime,
      expectedRuntimeDigest: current.plan.runtimeDigest } }] };
  const controls = { root: runtime.root, poolFile: runtime.poolPath, bindingsFile: runtime.bindingsPath,
    observationsFile: runtime.observationsPath, ...(runtime.quotaConfigPath ? { quotaConfigFile: runtime.quotaConfigPath } : {}) };
  const prepared = prepareResourceConsoleEngineeringEnrollments({ ...controls, catalog,
    projectBindings: current.preview.bindings!, projects: current.preview.projects! });
  const enrollmentDigest = prepared[0]!.summary.enrollmentDigest;
  const supervision = validateResourceConsoleEngineeringSupervisionConfig({ ...current.supervisionBase,
    enrollments: [{ enrollmentId: recipe.id, expectedEnrollmentDigest: enrollmentDigest }] });
  return { catalog, supervision, enrollmentDigest, controls };
}
function evidence(current: ReturnType<typeof capture>, bundle: ReturnType<typeof generated>) {
  const stored = manifestRecord(universePath(current.paths.universeRoot, current.recipe.id)); assertComparatorUnchanged(stored);
  const campaign = readUniverseCampaign(current.recipe.id, { root: current.paths.universeRoot });
  if (stored.manifestDigest !== sha(current.manifest) || campaign.sourceState !== 'healthy' ||
    campaign.definitionDigest !== sha(current.campaign) || campaign.manifestDigest !== stored.manifestDigest ||
    campaign.comparatorDigest !== stored.comparatorDigest) fail('CONFLICT', 'Prepared experiment evidence changed');
  const files = { manifest: current.manifest, campaign: current.campaign, engineering: bundle.catalog, supervision: bundle.supervision };
  for (const [key, expected] of Object.entries(files)) {
    const file = current.paths[key as keyof typeof files];
    if (sha(readResourceJson(file)) !== sha(expected)) fail('CONFLICT', 'Prepared bundle content changed');
  }
  return { schemaVersion: 1, planDigest: current.plan.planDigest, enrollmentDigest: bundle.enrollmentDigest,
    manifestDigest: stored.manifestDigest, comparatorDigest: stored.comparatorDigest, seedArtifactDigest: stored.seedArtifact.digest,
    campaignDefinitionDigest: campaign.definitionDigest, files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, sha(value)])) };
}
function report(current: ReturnType<typeof capture>, bundle: ReturnType<typeof generated>, disposition: 'created' | 'replayed'): ResourceEngineeringPreparationReport {
  const commissioning = checkResourceConsoleEngineering({ ...bundle.controls, workspace: current.options.workspace,
    projectsFile: current.options.projectsFile, engineeringFile: current.paths.engineering });
  const manual = ['resources', 'pool', 'console', '--execute', '--root', current.runtime.root, '--pool', current.runtime.poolPath,
    '--bindings', current.runtime.bindingsPath, '--observations', current.runtime.observationsPath, '--workspace', current.options.workspace,
    '--projects', current.options.projectsFile, '--engineering', current.paths.engineering,
    ...(current.runtime.quotaConfigPath ? ['--quota-config', current.runtime.quotaConfigPath] : [])];
  return { ...current.plan, status: 'prepared', disposition, enrollmentDigest: bundle.enrollmentDigest,
    commissioning: { status: commissioning.status, reasons: [...new Set([...commissioning.reasons,
      ...commissioning.enrollments.flatMap(row => row.reasons)])].slice(0, 32) },
    consoleArguments: { manual, automatic: [...manual, '--engineering-supervision', current.paths.supervision] } };
}

/** Exclusive final-path registration: incomplete output is retained and never automatically repaired. */
export function prepareResourceEngineeringBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringPreparationReport {
  const captured = data<ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }>(input);
  if (!exact(captured, ['recipe', 'output', 'resourceRuntime', 'workspace', 'projectsFile', 'expectedPlanDigest']) ||
    typeof captured.expectedPlanDigest !== 'string' || !HASH.test(captured.expectedPlanDigest)) fail('INVALID_INPUT', 'Preparation requires an exact plan digest');
  const { expectedPlanDigest, ...options } = captured;
  let current = capture(options);
  if (current.plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation plan changed');
  if (present(options.output)) {
    inspectPrivateDirectory(options.output);
    if (!present(current.paths.receipt)) fail('CONFLICT', 'Incomplete preparation output requires inspection; no automatic repair');
    const bundle = generated(current); const expected = evidence(current, bundle);
    if (canonical(readResourceJson(current.paths.receipt)) !== canonical(expected) ||
      canonical(readResourceJson(join(options.output, 'intent.json'))) !== canonical({ schemaVersion: 1, planDigest: expectedPlanDigest })) {
      fail('CONFLICT', 'Preparation receipt changed');
    }
    if (capture(options).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during replay');
    return report(current, bundle, 'replayed');
  }
  current = capture(options);
  if (current.plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation plan changed before registration');
  mkdirSync(options.output, { mode: 0o700 }); fsyncDirectory(dirname(options.output));
  inspectPrivateDirectory(options.output);
  writePrivate(join(options.output, 'intent.json'), { schemaVersion: 1, planDigest: expectedPlanDigest });
  mkdirSync(current.paths.universeRoot, { mode: 0o700 }); mkdirSync(current.paths.graphRoot, { mode: 0o700 }); fsyncDirectory(options.output);
  initUniverse(current.manifest, { root: current.paths.universeRoot });
  initUniverseCampaign(current.campaign, { root: current.paths.universeRoot });
  const bundle = generated(current);
  writePrivate(current.paths.manifest, current.manifest); writePrivate(current.paths.campaign, current.campaign);
  writePrivate(current.paths.engineering, bundle.catalog); writePrivate(current.paths.supervision, bundle.supervision);
  const receipt = evidence(current, bundle);
  if (capture(options).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during registration');
  writePrivate(current.paths.receipt, receipt);
  return report(current, bundle, 'created');
}
