/** Standalone inspection: no owner, collector, provider, evaluator or repair is started. */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalEvidencePackJsonV3, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { canonical, digest } from '../universe/artifacts.js';
import { readControlGraph, type ControlGraphReport } from '../universe/control-graph.js';
import { campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { readUniverseCampaignReadiness } from '../universe/campaign-readiness.js';
import { portfolioControllerDirectory } from '../universe/portfolio-controller-store.js';
import { checkResourceGenerationRuntime, type ResourceGenerationRuntimeCheck } from '../universe/resource-runtime-check.js';
import { prepareResourceConsoleEngineeringEnrollments, validateResourceConsoleEngineeringCatalog } from './console-engineering.js';
import { matchesResourceConsoleProject, validateResourceConsoleProjects } from './console-projects.js';
import { decodeResourceConsoleState, previewResourceConsoleProjects } from './pool-supervisor.js';
import { readResourceJson, resourcePoolStatus } from './pool-runtime.js';
import { validateResourcePool, validateResourceObservations } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';

export interface ResourceConsoleEngineeringCheckOptions {
  root: string; poolFile: string; bindingsFile: string; observationsFile: string;
  workspace: string; projectsFile: string; engineeringFile: string; quotaConfigFile?: string;
}
const STAGES = ['inputs', 'pool', 'bindings', 'observations', 'projects', 'supervisor', 'enrollment', 'snapshot-stability'] as const;
export interface ResourceConsoleEngineeringCheck {
  schemaVersion: 1; scope: 'local-commissioning-check-only'; admission: 'not-attested';
  effectsExecuted: false; providerContacted: false; sampledAt: string;
  status: 'configured' | 'held' | 'unavailable'; reasons: string[];
  checks: Array<{ code: typeof STAGES[number]; status: 'passed' | 'failed' | 'not-checked' }>;
  enrollments: Array<{ id: string; projectId: string; graphId: string; enrollmentDigest: string;
    projectRegistration: 'persisted' | 'would-register'; status: 'configured' | 'held'; reasons: string[];
    graph: Pick<ControlGraphReport, 'sourceState' | 'status' | 'definitionDigest'>;
    runtime: ResourceGenerationRuntimeCheck }>;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function contains(parent: string, child: string): boolean {
  const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Valid local configuration does not attest capacity or authorize a future launch. */
export function checkResourceConsoleEngineering(input: ResourceConsoleEngineeringCheckOptions): ResourceConsoleEngineeringCheck {
  const report: ResourceConsoleEngineeringCheck = { schemaVersion: 1, scope: 'local-commissioning-check-only', admission: 'not-attested',
    effectsExecuted: false, providerContacted: false, sampledAt: new Date().toISOString(), status: 'unavailable', reasons: [],
    checks: STAGES.map(code => ({ code, status: 'not-checked' })), enrollments: [] };
  let current: typeof STAGES[number] = 'inputs';
  const failureDetails: string[] = [];
  const stage = <T>(code: typeof STAGES[number], read: () => T): T => {
    current = code; const value = read(); report.checks.find(row => row.code === code)!.status = 'passed'; return value;
  };
  // Re-read captured configuration after inspection. Never repair missing
  // state or erase a historical ledger whose digest no longer matches its pool.
  const captured = new Map<string, { bytes: number; hash: string | null }>();
  const read = (file: string, bytes = 2 * 1024 * 1024, optional = false): unknown => {
    const value = optional && !present(file) ? undefined : readResourceJson(file, bytes);
    const hash = value === undefined ? null : digest(canonical(value));
    if (captured.has(file) && captured.get(file)!.hash !== hash) throw new Error();
    captured.set(file, { bytes, hash }); return value;
  };
  try {
    const options = stage('inputs', () => {
      const json = canonicalEvidencePackJsonV3(input);
      if (json === null || Buffer.byteLength(json) > 64 * 1024) throw new Error();
      const value = JSON.parse(json) as ResourceConsoleEngineeringCheckOptions;
      const keys = ['root', 'poolFile', 'bindingsFile', 'observationsFile', 'workspace', 'projectsFile', 'engineeringFile',
        ...(Object.hasOwn(value, 'quotaConfigFile') ? ['quotaConfigFile'] : [])];
      if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
        Object.values(value).some(path => typeof path !== 'string' || Buffer.byteLength(path) > 4096 ||
          !isAbsolute(path) || resolve(path) !== path || parse(path).root === path ||
          [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) || process.platform === 'win32') throw new Error();
      return value;
    });
    const pool = stage('pool', () => validateResourcePool(read(options.poolFile)));
    const bindings = stage('bindings', () => validateResourceBindings(read(options.bindingsFile), pool));
    stage('observations', () => validateResourceObservations(read(options.observationsFile), pool));
    const projects = stage('projects', () => {
      const value = read(options.projectsFile, 256 * 1024) as { schemaVersion: unknown; projects: unknown };
      if (!value || Object.keys(value).sort().join(',') !== 'projects,schemaVersion' || value.schemaVersion !== 1) throw new Error();
      return validateResourceConsoleProjects(value.projects);
    });
    const inspected = stage('supervisor', () => {
      const value = read(join(options.root, 'resource-console-state.json'), 4 * 1024 * 1024, true);
      const state = value === undefined ? undefined : decodeResourceConsoleState(value, { pool, bindings, workspace: options.workspace });
      const preview = previewResourceConsoleProjects({ workspace: options.workspace, projects, state });
      read(join(options.root, 'pool-state.json'), 4 * 1024 * 1024, true);
      resourcePoolStatus(options.root, pool, bindings, []);
      if (!preview.bindings || !preview.projects) throw new Error();
      return { state, preview };
    });
    stage('enrollment', () => {
      const catalog = validateResourceConsoleEngineeringCatalog(read(options.engineeringFile, 1024 * 1024));
      const controls = [options.poolFile, options.bindingsFile, options.observationsFile, options.projectsFile,
        options.engineeringFile, ...(options.quotaConfigFile ? [options.quotaConfigFile] : [])];
      for (const project of inspected.preview.bindings!) {
        if (contains(options.root, project.workspace) || contains(project.workspace, options.root) ||
          controls.some(file => contains(project.workspace, file))) throw new Error();
      }
      if (options.quotaConfigFile) read(options.quotaConfigFile);
      const prepared = prepareResourceConsoleEngineeringEnrollments({ ...options, catalog,
        projectBindings: inspected.preview.bindings!, projects: inspected.preview.projects! });
      const runtimes = new Map<string, ResourceGenerationRuntimeCheck>();
      const common: string[] = [];
      const kill = readKillSwitch();
      if (kill.state !== 'inactive' || kill.sourceState !== 'healthy') common.push(kill.state === 'active' ? 'global-kill-active' : 'global-kill-unavailable');
      if (!loadExistingProvenanceKeyReadOnly()) common.push('provenance-unavailable');
      if (inspected.state?.paused) common.push('queue-paused');
      if (present(join(options.root, '.resource-console.lock'))) common.push('supervisor-ownership-present');
      for (const entry of prepared) {
        read(entry.row.host.resourceRuntime);
        const runtimeKey = canonical([entry.row.host.resourceRuntime, entry.row.host.expectedRuntimeDigest]);
        let runtime = runtimes.get(runtimeKey);
        if (!runtime) {
          runtime = checkResourceGenerationRuntime({ resourceRuntime: entry.row.host.resourceRuntime, expectedRuntimeDigest: entry.row.host.expectedRuntimeDigest });
          runtimes.set(runtimeKey, runtime);
        }
        if (runtime.status !== 'valid') {
          const failed = runtime.checks.filter(check => check.status === 'failed');
          failureDetails.push(...(failed.length ? failed.map(check => `commissioning-runtime-${check.code}-unavailable`) : ['commissioning-runtime-unavailable']));
          throw new Error();
        }
        const reasons = [...common]; const project = inspected.preview.projects!.find(row => row.id === entry.row.projectId)!;
        if (!project.enabled) reasons.push('project-disabled');
        if (!matchesResourceConsoleProject(inspected.preview.bindings!.find(row => row.id === entry.row.projectId)!)) reasons.push('project-unavailable');
        if (present(join(entry.row.graphRoot, 'KILL'))) reasons.push('graph-kill-active');
        if (present(join(entry.row.graphRoot, '.control-execution.lock')) || present(join(entry.row.graphRoot, '.console-engineering.lock'))) reasons.push('graph-ownership-present');
        const graph = readControlGraph(entry.row.graphRoot);
        if (graph.sourceState === 'degraded' || graph.definitionDigest !== null && graph.definitionDigest !== entry.definitionDigest) reasons.push('graph-evidence-unavailable');
        else if (graph.sourceState !== 'missing') reasons.push(graph.status === 'completed' ? 'graph-already-completed' : 'graph-requires-console-inspection');
        if (present(join(entry.row.graphRoot, 'console-engineering'))) reasons.push('launch-history-requires-console-inspection');
        if (present(portfolioControllerDirectory(entry.row.host.definition.id, { root: entry.row.host.root }))) reasons.push('controller-already-enrolled');
        for (const task of entry.row.host.definition.tasks) {
          const campaign = readUniverseCampaignReadiness(task.campaignId, { root: entry.row.host.root });
          if (campaign.sourceState !== 'healthy' || !(campaign.automaticAction === 'run' || campaign.observedState === 'completed' ||
            campaign.observedState === 'ready' && campaign.disposition === 'owned')) reasons.push('campaign-not-startable');
          const universe = campaignUniverse(readUniverseCampaign(task.campaignId, { root: entry.row.host.root }), { root: entry.row.host.root });
          for (const variant of universe.manifest.variants) {
            const generation = variant.generation;
            if (generation?.kind !== 'resource-pool') continue;
            const allowed = runtime.workers.filter(worker => generation.allowedWorkerIds.includes(worker.workerId));
            if (!allowed.length) reasons.push('campaign-workers-unavailable');
            else if (allowed.every(worker => worker.policyHolds.length > 0)) reasons.push('account-policy-held');
          }
        }
        report.enrollments.push({ id: entry.row.id, projectId: entry.row.projectId, graphId: entry.row.graphId,
          enrollmentDigest: entry.summary.enrollmentDigest,
          projectRegistration: inspected.state?.projects?.some(row => row.id === entry.row.projectId) ? 'persisted' : 'would-register',
          status: reasons.length ? 'held' : 'configured', reasons: [...new Set(reasons)],
          graph: { sourceState: graph.sourceState, status: graph.status, definitionDigest: graph.definitionDigest }, runtime });
      }
    });
    stage('snapshot-stability', () => {
      for (const [file, sample] of captured) {
        const value = present(file) ? readResourceJson(file, sample.bytes) : undefined;
        if ((value === undefined ? null : digest(canonical(value))) !== sample.hash) throw new Error();
      }
    });
    report.status = report.enrollments.some(row => row.status === 'configured') ? 'configured' : 'held';
  } catch {
    report.checks.find(row => row.code === current)!.status = 'failed';
    report.status = 'unavailable'; report.reasons = [`commissioning-${current}-unavailable`, ...failureDetails];
    report.enrollments = []; // Never leak partial manifests, paths or private history.
  }
  return report;
}
