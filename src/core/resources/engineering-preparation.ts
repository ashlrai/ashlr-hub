/** Trusted local registration bridge. No executor, scheduler, key creation or provider calls. */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, executable, inspectPrivateDirectory, pinSeed, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES } from '../universe/artifacts.js';
import { parseGitBlobBatch } from '../universe/git-blob-batch.js';
import { assertComparatorUnchanged, initUniverse, initUniverseWithCampaignDeliveryOrigin, manifestRecord, universePath, validateUniverseManifest } from '../universe/store.js';
import { PREPARATION_PROCESS_SCORE_BUILTIN, resolveBuiltinEvaluator } from '../universe/builtin-evaluator-registry.js';
import { PREPARATION_TYPECHECK_TARGET } from '../universe/preparation-typecheck-project.js';
import { assertPreparationProcessScope } from '../universe/preparation-process-score.js';
import { deliveryGit } from '../universe/delivery-git.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { readUniverseCampaignDeliverySource, validateUniverseCampaignDeliverySource } from '../universe/campaign-handoff.js';
import type { UniverseCampaignDeliveryOrigin, UniverseCampaignDeliverySource } from '../universe/campaign-handoff-types.js';
import { assertUniverseExecution, withUniverseExecution } from '../universe/execution.js';
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
  ResourceEngineeringRecipe, ResourceEngineeringSuccessorPreparationOptions, ResourceEngineeringSuccessorPreparationPlan,
  ResourceEngineeringSuccessorPreparationReport, ResourceEngineeringPreparationMetadata,
  ResourceEngineeringSuccessorPreparationMetadata } from './engineering-preparation-types.js';
export type { ResourceEngineeringPreparationOptions, ResourceEngineeringPreparationPlan, ResourceEngineeringPreparationReport,
  ResourceEngineeringRecipe, ResourceEngineeringPreparationMetadata, ResourceEngineeringSuccessorPreparationMetadata } from './engineering-preparation-types.js';

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

function evaluatorBlobs(repo: string, oids: string[]): Buffer[] {
  // No launch saving for one file: preserve its exact original command path.
  const original = () => oids.map(oid => git(repo, ['cat-file', 'blob', oid]));
  if (oids.length === 1) return original();
  const maxBuffer = MAX_ARTIFACT_BYTES + 4 * 1024 * 1024;
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, 'cat-file', '--batch'], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
    timeout: 30_000, maxBuffer, input: `${oids.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  // Never retry a killed, timed-out, failed-transport or structurally invalid
  // result. The candidate broker intentionally has no meaningful child PID.
  if (result.error !== undefined || result.signal !== null || !Number.isSafeInteger(result.status) ||
      result.status === null || result.status < 0 || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) ||
      result.stdout.length + result.stderr.length > maxBuffer) fail('UNAVAILABLE', 'Preparation evaluator batch is unavailable');
  // maxBuffer accounts for stdout AND stderr. A normally exited warning or
  // command failure restarts the entire old sequence with its original limits.
  if (result.stderr.length || result.status !== 0) return original();
  const blobs = parseGitBlobBatch(result.stdout, oids, MAX_ARTIFACT_BYTES);
  // Malformed frames and oversized payloads refuse; they never trigger retry.
  if (blobs.some(blob => blob.length > 8 * 1024 * 1024)) fail('INVALID_INPUT', 'Preparation evaluator file exceeds byte bound');
  return blobs;
}

interface SuccessorContext {
  source: UniverseCampaignDeliverySource;
  origin: UniverseCampaignDeliveryOrigin;
  assertSource: () => void;
}
function capture(input: ResourceEngineeringPreparationOptions, successor?: SuccessorContext) {
  successor?.assertSource();
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
  if (successor && (seed.repo !== successor.origin.repo || seed.revision !== successor.origin.commit ||
      recipe.id === successor.origin.universeId || recipe.id === successor.origin.campaignId ||
      overlaps(options.output, successor.source.root))) fail('CONFLICT', 'Successor project, identity or output differs from its source');
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
  const evaluationCommand = manifest.evaluation.command;
  let assertEvaluator = () => {};
  let expectedSeedArtifactDigest: string | undefined;
  let evaluatorPins;
  if (!evaluationCommand) {
    // Diagnostic reports are deliberately not Evaluation evidence. Only the
    // installed closed scorer may replace a tracked command evaluator here.
    if (manifest.evaluation.builtin !== PREPARATION_PROCESS_SCORE_BUILTIN) fail('INVALID_INPUT', 'Preparation recipes require a command evaluator');
    if (recipe.generation.files.length !== 1 || recipe.generation.files[0] !== PREPARATION_TYPECHECK_TARGET ||
        !entries.has(PREPARATION_TYPECHECK_TARGET) || recipe.generation.contextFiles.some(file => !entries.has(file))) {
      fail('INVALID_INPUT', 'Preparation scoring requires the fixed target and tracked context paths');
    }
    const installed = resolveBuiltinEvaluator(PREPARATION_PROCESS_SCORE_BUILTIN);
    const captured = canonical(installed);
    const calibration = installed.files.find(file => file.name === 'calibration.json');
    if (!calibration) fail('UNAVAILABLE', 'Preparation scoring calibration is unavailable');
    const read = readStableRegularFile(calibration.path, { anchorPath: dirname(calibration.path),
      maxFileBytes: 2 * 1024 * 1024, remainingBytes: 2 * 1024 * 1024 });
    if (!read.ok || digest(read.text) !== calibration.digest) fail('UNAVAILABLE', 'Preparation scoring calibration changed');
    // Check the complete immutable Git seed, not the dirty checkout or only its
    // editable file. A private small calibration cannot enroll a larger project.
    const reader = deliveryGit(seed.repo);
    const files = reader.readEntries(reader.entries(seed.revision)).map(entry => ({ path: entry.path,
      executable: entry.executable, bytes: entry.data.length, sha256: digest(entry.data) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const inventory = { files, digest: sha(files.map(file => ({ path: file.path, executable: file.executable,
      size: file.bytes, digest: file.sha256 }))) };
    try { assertPreparationProcessScope(read.text, inventory); }
    catch { fail('CONFLICT', 'Preparation seed does not match the installed scoring scope'); }
    expectedSeedArtifactDigest = inventory.digest;
    evaluatorPins = { builtin: installed };
    assertEvaluator = () => {
      if (canonical(resolveBuiltinEvaluator(PREPARATION_PROCESS_SCORE_BUILTIN)) !== captured) fail('CONFLICT', 'Preparation installed evaluator changed');
    };
  } else {
    // Preserve the historical command pin shape and ordering for saved recipes.
    const command = executable(evaluationCommand, seed.repo);
    const protectedFiles: string[] = [];
    for (const [index, arg] of evaluationCommand.entries()) {
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
    const evaluatorFiles = [...new Set(protectedFiles)].sort();
    const executableDigest = digest(readFileSync(command[0]!));
    // Keep path ordering and duplicate OIDs; no capture or source fence is reused.
    const blobs = evaluatorBlobs(seed.repo, evaluatorFiles.map(file => entries.get(file)!));
    evaluatorPins = { executable: command[0], executableDigest,
      files: evaluatorFiles.map((file, index) => ({ path: file, digest: digest(blobs[index]!) })) };
  }
  const runtimeCheck = checkResourceGenerationRuntime({ resourceRuntime: options.resourceRuntime, expectedRuntimeDigest: runtimeDigest });
  if (runtimeCheck.status !== 'valid') fail('UNAVAILABLE', 'Preparation resource runtime is invalid');
  const quotaDigest = runtime.quotaConfigPath ? sha(readResourceJson(runtime.quotaConfigPath)) : null;
  const pins = { schemaVersion: 1, options, runtimeDigest, poolDigest, projectsDigest: sha(projectsDocument), project,
    quotaDigest, evaluatorPins, manifest, campaign, definition, deliveryPlan,
    ...(successor ? { campaignDeliveryOrigin: successor.origin } : {}) };
  const plan: ResourceEngineeringPreparationPlan = { schemaVersion: 1, status: 'planned', scope: 'local-preparation-only',
    planDigest: sha(pins), output: options.output, enrollmentDigest: null, projectId: recipe.projectId,
    projectRegistration: state?.projects?.some(row => row.id === project.id && row.workspace === project.workspace &&
      row.dev === project.dev && row.ino === project.ino) ? 'persisted' : 'would-register', executionStarted: false,
    providerContacted: false, paths, ids, seedRevision: seed.revision, runtimeDigest, poolDigest };
  successor?.assertSource();
  assertEvaluator();
  return { options, recipe, runtime, preview, paths, plan, manifest, campaign, definition, deliveryPlan, supervisionBase,
    assertEvaluator, expectedSeedArtifactDigest,
    ...(successor ? { campaignDeliveryOrigin: successor.origin } : {}) };
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
function preparedExperiment(current: ReturnType<typeof capture>) {
  const stored = manifestRecord(universePath(current.paths.universeRoot, current.recipe.id)); assertComparatorUnchanged(stored);
  // The existing materializer and hardened scope reader have different Git
  // replacement policies. Bind the actual retained artifact to the validated
  // original tree before any campaign/catalog creation or completed replay.
  if (current.expectedSeedArtifactDigest !== undefined && stored.seedArtifact.digest !== current.expectedSeedArtifactDigest) {
    fail('CONFLICT', 'Prepared materialized seed differs from the installed scoring scope');
  }
  return stored;
}
function evidence(current: ReturnType<typeof capture>, bundle: ReturnType<typeof generated>) {
  const stored = preparedExperiment(current);
  const campaign = readUniverseCampaign(current.recipe.id, { root: current.paths.universeRoot });
  if (stored.manifestDigest !== sha(current.manifest) || campaign.sourceState !== 'healthy' ||
    campaign.definitionDigest !== sha(current.campaign) || campaign.manifestDigest !== stored.manifestDigest ||
    campaign.comparatorDigest !== stored.comparatorDigest ||
    canonical(stored.campaignDeliveryOrigin ?? null) !== canonical(current.campaignDeliveryOrigin ?? null)) fail('CONFLICT', 'Prepared experiment evidence changed');
  const files = { manifest: current.manifest, campaign: current.campaign, engineering: bundle.catalog, supervision: bundle.supervision };
  for (const [key, expected] of Object.entries(files)) {
    const file = current.paths[key as keyof typeof files];
    if (sha(readResourceJson(file)) !== sha(expected)) fail('CONFLICT', 'Prepared bundle content changed');
  }
  return { schemaVersion: 1, planDigest: current.plan.planDigest, enrollmentDigest: bundle.enrollmentDigest,
    manifestDigest: stored.manifestDigest, comparatorDigest: stored.comparatorDigest, seedArtifactDigest: stored.seedArtifact.digest,
    campaignDefinitionDigest: campaign.definitionDigest, files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, sha(value)])),
    ...(current.campaignDeliveryOrigin ? { campaignDeliveryOrigin: current.campaignDeliveryOrigin } : {}) };
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

/** Inspect only a fully committed bundle. Startup recovery must never enter the creator path. */
export function readPreparedResourceEngineeringBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringPreparationReport {
  return readPreparedBundle(input);
}
function readPreparedBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }, successor?: SuccessorContext): ResourceEngineeringPreparationReport {
  const { current, bundle } = inspectPreparedBundle(input, successor);
  const result = report(current, bundle, 'replayed'); successor?.assertSource(); current.assertEvaluator(); return result;
}
/** One-call verification shared by full reporting and private source metadata reads.
 * No positive proof is cached or accepted back as authority at another boundary. */
function inspectPreparedBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }, successor?: SuccessorContext) {
  const captured = data<ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }>(input);
  if (!exact(captured, ['recipe', 'output', 'resourceRuntime', 'workspace', 'projectsFile', 'expectedPlanDigest']) ||
    typeof captured.expectedPlanDigest !== 'string' || !HASH.test(captured.expectedPlanDigest)) fail('INVALID_INPUT', 'Preparation requires an exact plan digest');
  const { expectedPlanDigest, ...options } = captured;
  const current = capture(options, successor);
  if (current.plan.planDigest !== expectedPlanDigest || !present(options.output)) fail('CONFLICT', 'Prepared bundle is missing or changed');
  inspectPrivateDirectory(options.output);
  if (!present(current.paths.receipt)) fail('CONFLICT', 'Incomplete preparation output requires inspection; no automatic repair');
  if (current.expectedSeedArtifactDigest !== undefined) preparedExperiment(current);
  const bundle = generated(current); const expected = evidence(current, bundle);
  if (canonical(readResourceJson(current.paths.receipt)) !== canonical(expected) ||
    canonical(readResourceJson(join(options.output, 'intent.json'))) !== canonical({ schemaVersion: 1, planDigest: expectedPlanDigest })) {
    fail('CONFLICT', 'Preparation receipt changed');
  }
  if (capture(options, successor).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during inspection');
  return { current, bundle };
}
function preparedMetadata(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }, successor?: SuccessorContext): ResourceEngineeringPreparationMetadata {
  const { current, bundle } = inspectPreparedBundle(input, successor);
  const result: ResourceEngineeringPreparationMetadata = { ...current.plan, status: 'prepared', disposition: 'replayed',
    enrollmentDigest: bundle.enrollmentDigest };
  successor?.assertSource(); current.assertEvaluator(); return result;
}
/** Host-only source lookup. Same bundle/pin verification as full read, without
 * computing unused commissioning diagnostics or console command suggestions. */
export function readPreparedResourceEngineeringMetadata(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringPreparationMetadata {
  return preparedMetadata(input);
}

/** Exclusive final-path registration: incomplete output is retained and never automatically repaired. */
export function prepareResourceEngineeringBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringPreparationReport {
  return prepareBundle(input);
}
function prepareBundle(input: ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }, successor?: SuccessorContext): ResourceEngineeringPreparationReport {
  const captured = data<ResourceEngineeringPreparationOptions & { expectedPlanDigest: string }>(input);
  if (!exact(captured, ['recipe', 'output', 'resourceRuntime', 'workspace', 'projectsFile', 'expectedPlanDigest']) ||
    typeof captured.expectedPlanDigest !== 'string' || !HASH.test(captured.expectedPlanDigest)) fail('INVALID_INPUT', 'Preparation requires an exact plan digest');
  const { expectedPlanDigest, ...options } = captured;
  let current = capture(options, successor);
  if (current.plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation plan changed');
  if (present(options.output)) {
    return readPreparedBundle(captured, successor);
  }
  current = capture(options, successor);
  if (current.plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation plan changed before registration');
  mkdirSync(options.output, { mode: 0o700 }); fsyncDirectory(dirname(options.output));
  inspectPrivateDirectory(options.output);
  writePrivate(join(options.output, 'intent.json'), { schemaVersion: 1, planDigest: expectedPlanDigest });
  mkdirSync(current.paths.universeRoot, { mode: 0o700 }); mkdirSync(current.paths.graphRoot, { mode: 0o700 }); fsyncDirectory(options.output);
  if (successor) initUniverseWithCampaignDeliveryOrigin(current.manifest, successor.origin, successor.assertSource, { root: current.paths.universeRoot });
  else initUniverse(current.manifest, { root: current.paths.universeRoot });
  if (current.expectedSeedArtifactDigest !== undefined) preparedExperiment(current);
  initUniverseCampaign(current.campaign, { root: current.paths.universeRoot });
  const bundle = generated(current);
  writePrivate(current.paths.manifest, current.manifest); writePrivate(current.paths.campaign, current.campaign);
  writePrivate(current.paths.engineering, bundle.catalog); writePrivate(current.paths.supervision, bundle.supervision);
  const receipt = evidence(current, bundle);
  if (capture(options, successor).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during registration');
  if (successor) {
    // Source verification must follow staging, immediately before no-clobber
    // publication. An interrupted stage is retained with the incomplete bundle.
    const stage = join(options.output, '.receipt.stage'); writePrivate(stage, receipt);
    const identity = lstatSync(stage, { bigint: true });
    const sameStage = () => {
      const currentStage = lstatSync(stage, { bigint: true });
      return currentStage.isFile() && !currentStage.isSymbolicLink() && currentStage.nlink === 1n &&
        currentStage.dev === identity.dev && currentStage.ino === identity.ino && currentStage.size === identity.size &&
        currentStage.mtimeNs === identity.mtimeNs && currentStage.ctimeNs === identity.ctimeNs &&
        canonical(readResourceJson(stage)) === canonical(receipt);
    };
    if (!sameStage()) fail('CONFLICT', 'Successor receipt stage changed');
    successor.assertSource();
    if (!sameStage()) fail('CONFLICT', 'Successor receipt stage changed during source verification');
    current.assertEvaluator();
    linkSync(stage, current.paths.receipt);
    const installed = lstatSync(current.paths.receipt, { bigint: true }); const linked = lstatSync(stage, { bigint: true });
    if (!installed.isFile() || installed.dev !== identity.dev || installed.ino !== identity.ino || installed.nlink !== 2n ||
        linked.dev !== identity.dev || linked.ino !== identity.ino) fail('CONFLICT', 'Successor receipt publication changed');
    unlinkSync(stage); fsyncDirectory(options.output);
  } else { current.assertEvaluator(); writePrivate(current.paths.receipt, receipt); }
  const result = report(current, bundle, 'created');
  if (successor) {
    successor.assertSource();
    if (canonical(readResourceJson(current.paths.receipt)) !== canonical(receipt)) fail('CONFLICT', 'Successor receipt changed after publication');
  }
  current.assertEvaluator();
  return result;
}

function successorInput(input: unknown, expected: boolean) {
  const value = data<ResourceEngineeringSuccessorPreparationOptions & { expectedPlanDigest?: string }>(input);
  const keys = ['recipe', 'output', 'resourceRuntime', 'workspace', 'projectsFile', 'source', ...(expected ? ['expectedPlanDigest'] : [])];
  if (!exact(value, keys) || expected && (typeof value.expectedPlanDigest !== 'string' || !HASH.test(value.expectedPlanDigest)) ||
      !value.recipe || typeof value.recipe !== 'object' || Array.isArray(value.recipe) || Object.hasOwn(value.recipe, 'seedRevision')) {
    fail('INVALID_INPUT', 'Invalid successor preparation request');
  }
  const source = validateUniverseCampaignDeliverySource(value.source);
  const { expectedPlanDigest, ...request } = value;
  const requestDigest = sha({ domain: 'resource-engineering-successor-v1', request: { ...request, source } });
  const origin = readUniverseCampaignDeliverySource(source, requestDigest);
  const assertSource = () => {
    if (canonical(readUniverseCampaignDeliverySource(source, requestDigest)) !== canonical(origin)) fail('CONFLICT', 'Successor source changed');
  };
  const options: ResourceEngineeringPreparationOptions = { recipe: { ...value.recipe, seedRevision: origin.commit }, output: value.output,
    resourceRuntime: value.resourceRuntime, workspace: value.workspace, projectsFile: value.projectsFile };
  return { options, expectedPlanDigest, context: { source, origin, assertSource } satisfies SuccessorContext };
}

export function checkResourceEngineeringSuccessorPreparation(input: ResourceEngineeringSuccessorPreparationOptions): ResourceEngineeringSuccessorPreparationPlan {
  const { options, context } = successorInput(input, false);
  const first = capture(options, context); const final = capture(options, context);
  if (first.plan.planDigest !== final.plan.planDigest) fail('CONFLICT', 'Successor inputs changed while inspecting');
  return { ...final.plan, campaignDeliveryOrigin: context.origin };
}

export function readResourceEngineeringSuccessorBundle(input: ResourceEngineeringSuccessorPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringSuccessorPreparationReport {
  const { options, context, expectedPlanDigest } = successorInput(input, true);
  return { ...readPreparedBundle({ ...options, expectedPlanDigest: expectedPlanDigest! }, context), campaignDeliveryOrigin: context.origin };
}
/** Read-only source lookup; source proof is freshly checked again before return. */
export function readResourceEngineeringSuccessorMetadata(input: ResourceEngineeringSuccessorPreparationOptions & { expectedPlanDigest: string }): ResourceEngineeringSuccessorPreparationMetadata {
  const { options, context, expectedPlanDigest } = successorInput(input, true);
  return { ...preparedMetadata({ ...options, expectedPlanDigest: expectedPlanDigest! }, context), campaignDeliveryOrigin: context.origin };
}

export async function prepareResourceEngineeringSuccessorBundle(input: ResourceEngineeringSuccessorPreparationOptions & { expectedPlanDigest: string }): Promise<ResourceEngineeringSuccessorPreparationReport> {
  const { options, context, expectedPlanDigest } = successorInput(input, true);
  // Completed replay is a pure inspection, including source and destination ownership files.
  if (present(options.output)) return { ...readPreparedBundle({ ...options, expectedPlanDigest: expectedPlanDigest! }, context), campaignDeliveryOrigin: context.origin };
  const current = capture(options, context);
  if (current.plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Successor plan changed');
  return withUniverseExecution(context.origin.universeId, { root: context.source.root }, async lock => {
    const guard = () => {
      assertUniverseExecution(universePath(context.source.root, context.origin.universeId), lock);
      context.assertSource();
      assertUniverseExecution(universePath(context.source.root, context.origin.universeId), lock);
    };
    const result = prepareBundle({ ...options, expectedPlanDigest: expectedPlanDigest! }, { ...context, assertSource: guard });
    return { ...result, campaignDeliveryOrigin: context.origin };
  });
}
