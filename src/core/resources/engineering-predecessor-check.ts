/** Historical completion evidence only. Never opens an execution owner or renews a budget. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { ownsLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest } from '../universe/artifacts.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { assertCampaignSeedEvaluatorsSettled, campaignUniverse, readUniverseCampaign } from '../universe/campaign-store.js';
import { assertPreparationMeasurementsSettled } from '../universe/preparation-measurement-capture-store.js';
import { assertBuiltinTrialEvaluatorsSettled } from '../universe/builtin-trial-custody.js';
import { universePath } from '../universe/store.js';
import { portfolioControllerDirectory } from '../universe/portfolio-controller-store.js';
import { readResourceEngineeringAutonomousSetupEvidence, type ResourceEngineeringAutonomousSetupOptions } from './engineering-autonomous-setup.js';
import { validateResourceConsoleEngineeringPreparationConfig } from './engineering-preparation-registry.js';
import { readResourceEngineeringOutcomes } from './engineering-outcomes.js';
import { MISSION_MEASURED_FEEDBACK, projectEngineeringMissionFeedback, type EngineeringMissionFeedback } from './engineering-mission-feedback.js';
import { prepareResourceConsoleEngineeringEnrollments, readResourceConsoleEngineeringGraphCompletion } from './console-engineering.js';
import { readResourceConsoleEngineeringSupervisionState, validateResourceConsoleEngineeringSupervisionConfig } from './console-engineering-supervision-state.js';
import { pinResourceConsoleProject, validateResourceConsoleProjects } from './console-projects.js';
import { decodeResourceConsoleState, previewResourceConsoleProjects } from './pool-supervisor.js';
import { readResourceJson, resourcePoolStatus, readResourcePoolHistory } from './pool-runtime.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import { hash, readEngineeringSuccessorJournal, parseResourceEngineeringSuccessorProposal,
  validateResourceEngineeringSuccessorCoordinatorConfig, type Intent, type Result, type Prepared, type Admitted } from './engineering-successor-store.js';

export interface ResourceEngineeringPredecessorCheckOptions {
  setup: ResourceEngineeringAutonomousSetupOptions;
  expectedPlanDigest: string;
  /** Original persisted deadline from the calling mission, not a freshly calculated allowance. */
  expectedDeadlineAt: string;
  /** Explicit proposal context only; omitted callers retain their exact proof shape. */
  proposalFeedback?: typeof MISSION_MEASURED_FEEDBACK;
}
export interface ResourceEngineeringPredecessorCheck {
  schemaVersion: 1; scope: 'predecessor-completion-evidence-only';
  status: 'verified' | 'held'; reasons: string[]; sampledAt: string;
  executionAuthorized: false; effectsExecuted: false; providerContacted: false;
  evidenceDigest: string | null;
  tip: { enrollmentId: string; enrollmentDigest: string; projectId: string; commit: string } | null;
  continuation: 'eligible' | 'stop-requested' | null;
  feedback?: EngineeringMissionFeedback;
}
type Stage = 'inputs' | 'setup' | 'configuration' | 'projects' | 'queue' | 'completion' | 'custody' | 'successors' | 'lineage' | 'stability';
function requireEvidence(value: unknown): asserts value { if (!value) throw new Error('Incomplete predecessor evidence'); }
function absent(file: string): void {
  try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Predecessor ownership or pending work is present');
}

/** A bounded, double-read join, NOT an atomic seal or dispatch permission. A mission
 * must still own its execution scope and revalidate at successor publication.
 * Global stops and quota policy remain enforced by the existing action-time gates. */
export function checkResourceEngineeringPredecessor(input: ResourceEngineeringPredecessorCheckOptions,
  ownedResourceLocks: readonly LocalStoreLock[] = [], custody?: ResourceWorkspaceCustody): ResourceEngineeringPredecessorCheck {
  const report: ResourceEngineeringPredecessorCheck = { schemaVersion: 1, scope: 'predecessor-completion-evidence-only',
    status: 'held', reasons: [], sampledAt: new Date().toISOString(), executionAuthorized: false,
    effectsExecuted: false, providerContacted: false, evidenceDigest: null, tip: null, continuation: null };
  let stage: Stage = 'inputs';
  try {
    const json = canonicalEvidencePackJsonV3(input);
    requireEvidence(json !== null && Buffer.byteLength(json) <= 256 * 1024);
    const options = JSON.parse(json) as ResourceEngineeringPredecessorCheckOptions;
    // Only in-process acquired capabilities are recognized by the lock module's
    // private registry. JSON-shaped copies and locks on unrelated scopes fail.
    requireEvidence(Array.isArray(ownedResourceLocks) && ownedResourceLocks.length <= 3 && ownedResourceLocks.every(lock => ownsLocalStoreLock(lock)));
    const borrowed = custody === undefined ? [] : readResourceWorkspaceCustody(custody).locks;
    const locks = [...new Set([...ownedResourceLocks, ...borrowed])];
    requireEvidence(locks.length <= 3);
    requireEvidence(options && Object.keys(options).sort().join(',') === (options.proposalFeedback === undefined
      ? 'expectedDeadlineAt,expectedPlanDigest,setup' : 'expectedDeadlineAt,expectedPlanDigest,proposalFeedback,setup') &&
      (options.proposalFeedback === undefined || options.proposalFeedback === MISSION_MEASURED_FEEDBACK) &&
      typeof options.expectedPlanDigest === 'string' && /^[a-f0-9]{64}$/.test(options.expectedPlanDigest) &&
      typeof options.expectedDeadlineAt === 'string' && Number.isFinite(Date.parse(options.expectedDeadlineAt)) &&
      new Date(options.expectedDeadlineAt).toISOString() === options.expectedDeadlineAt);
    const sample = () => {
      stage = 'setup';
      const setupEvidence = readResourceEngineeringAutonomousSetupEvidence(options.setup, custody);
      const plan = setupEvidence.plan;
      requireEvidence(plan.planDigest === options.expectedPlanDigest && plan.initialEnrollmentDigest);
      const runtime = validateResourceGenerationRuntime(readResourceJson(options.setup.resourceRuntime));
      const permittedLocks = ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].map(name => join(runtime.root, name));
      requireEvidence(new Set(locks.map(lock => lock.path)).size === locks.length &&
        locks.every(lock => permittedLocks.includes(lock.path) && ownsLocalStoreLock(lock)));
      const owned = (name: string) => locks.some(lock => lock.path === join(runtime.root, name) && ownsLocalStoreLock(lock));
      // A global kill or exhausted allowance does not erase historical completion.
      // Outstanding work and ownership, however, cannot establish a settled predecessor.
      const ownedHolds = new Set([...(owned('.resource-console.lock') ? ['console-ownership-present'] : []),
        ...(owned('.pool.lock') ? ['pool-ownership-present'] : []), ...(owned('.resource-quota-refresh.lock') ? ['quota-ownership-present'] : [])]);
      requireEvidence(!plan.holds.some(reason => !ownedHolds.has(reason) && (reason.endsWith('-ownership-present') || reason.endsWith('-work-unresolved') ||
        reason === 'console-work-unresolved' || reason === 'ordinary-queued-work-retained')));
      stage = 'configuration';
      const pool = validateResourcePool(readResourceJson(runtime.poolPath));
      const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
      const poolDigest = hash({ pool, bindings });
      const owner = custody === undefined ? null : readResourceWorkspaceCustody(custody,
        { root: runtime.root, workspace: options.setup.workspace, poolDigest });
      const config = validateResourceConsoleEngineeringPreparationConfig(readResourceJson(plan.paths.profiles));
      const supervision = validateResourceConsoleEngineeringSupervisionConfig(readResourceJson(plan.paths.supervision));
      const successor = validateResourceEngineeringSuccessorCoordinatorConfig(readResourceJson(plan.paths.successors));
      requireEvidence(successor.supervisionId === supervision.id);
      const profile = config.profiles.find(row => row.id === successor.profileId);
      requireEvidence(profile);
      const registrations = setupEvidence.entries.map(row => row.registration);
      requireEvidence(registrations.length > 0 && registrations.length <= 32);
      const catalog = { schemaVersion: 1 as const, enrollments: setupEvidence.entries.flatMap(row => row.verified.catalog.enrollments) };
      requireEvidence(catalog.enrollments.length === registrations.length);
      stage = 'projects';
      const projectsDocument = readResourceJson(options.setup.projectsFile, 256 * 1024) as { schemaVersion: unknown; projects: unknown };
      requireEvidence(projectsDocument?.schemaVersion === 1 && Object.keys(projectsDocument).sort().join(',') === 'projects,schemaVersion');
      const projects = validateResourceConsoleProjects(projectsDocument.projects);
      const consoleState = decodeResourceConsoleState(readResourceJson(join(runtime.root, 'resource-console-state.json'), 4 * 1024 * 1024),
        { pool, bindings, workspace: options.setup.workspace, configHistory: readResourcePoolHistory(runtime.root, pool, bindings) });
      requireEvidence(!owner || hash(consoleState) === owner.stateDigest);
      const preview = previewResourceConsoleProjects({ workspace: options.setup.workspace, projects, state: consoleState });
      requireEvidence(preview.bindings && preview.projects);
      const project = preview.bindings.find(row => row.id === plan.projectId);
      requireEvidence(project);
      const enrollments = prepareResourceConsoleEngineeringEnrollments({ root: runtime.root, catalog,
        poolFile: runtime.poolPath, bindingsFile: runtime.bindingsPath, observationsFile: runtime.observationsPath,
        ...(runtime.quotaConfigPath ? { quotaConfigFile: runtime.quotaConfigPath } : {}),
        projectBindings: preview.bindings, projects: preview.projects });
      stage = 'queue';
      const durable = readResourceConsoleEngineeringSupervisionState({ root: runtime.root, config: supervision,
        catalog: enrollments.map(row => ({ id: row.summary.id, enrollmentDigest: row.summary.enrollmentDigest })) });
      requireEvidence(durable.state.deadlineAt === options.expectedDeadlineAt && durable.state.entries.length === registrations.length);
      for (const row of registrations) requireEvidence(durable.state.entries.some(entry => entry.enrollmentId === row.request.id &&
        entry.enrollmentDigest === row.enrollmentDigest && entry.attempts > 0 && entry.lastOutcome === 'settled'));
      const completed = enrollments.map(enrollment => {
        stage = 'completion';
        const graph = readResourceConsoleEngineeringGraphCompletion(enrollment);
        const source = setupEvidence.entries.find(row => row.registration.request.id === enrollment.summary.id &&
          row.registration.enrollmentDigest === enrollment.summary.enrollmentDigest)?.source;
        requireEvidence(graph && source && source.projectId === plan.projectId);
        const measured = readResourceEngineeringOutcomes({ enrollment: enrollment.summary, host: enrollment.row.host,
          root: runtime.root, poolFile: runtime.poolPath, bindingsFile: runtime.bindingsPath });
        // Missing token/timing measurements stay unknown; missing or mismatched
        // generation receipts cannot count as a completed accounting obligation.
        requireEvidence(measured.sourceState !== 'unavailable' && measured.campaigns.length === enrollment.summary.campaigns.length &&
          measured.campaigns.every(row => row.sourceState === 'healthy' && row.reasons.length === 0) &&
          measured.usage.attempts === measured.usage.joinedAttempts);
        const { sampledAt: _sampledAt, ...outcomes } = measured;
        stage = 'custody';
        for (const name of ['.console-engineering.lock', '.control-execution.lock']) absent(join(enrollment.row.graphRoot, name));
        for (const name of ['.control.lock', '.execution.lock']) {
          absent(join(portfolioControllerDirectory(enrollment.row.host.definition.id, { root: enrollment.row.host.root }), name));
        }
        for (const task of enrollment.row.host.definition.tasks) {
          const campaign = readUniverseCampaign(task.campaignId, { root: enrollment.row.host.root });
          const universe = campaignUniverse(campaign, { root: enrollment.row.host.root });
          requireEvidence(universe.sourceState === 'healthy' && universe.runs.every(run => {
            const attribution = run.campaign;
            return attribution?.id !== campaign.definition.id || campaign.steps.some(step => step.runId === run.id &&
              step.ordinal === attribution.ordinal && attribution.definitionDigest === campaign.definitionDigest && step.generation === run.generation);
          }));
          const directory = universePath(enrollment.row.host.root, campaign.definition.universeId);
          for (const name of ['.execution.lock', '.run.lock']) absent(join(directory, name));
          absent(join(enrollment.row.host.root, 'campaigns', task.campaignId, '.control.lock'));
          assertCampaignSeedEvaluatorsSettled(campaign.definition.universeId, { root: enrollment.row.host.root });
          assertPreparationMeasurementsSettled(directory);
          assertBuiltinTrialEvaluatorsSettled(directory);
        }
        return { graph, source, outcomes };
      });
      stage = 'custody';
      for (const name of ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock', '.resource-quota-refresh-pending.json']) {
        if (name === '.resource-quota-refresh-pending.json' && owner?.metadataPending) continue;
        if (!owned(name)) absent(join(runtime.root, name));
      }
      absent(join(runtime.root, 'engineering-supervision', supervision.id, '.execution.lock'));
      absent(join(runtime.root, 'engineering-successors', successor.supervisionId, '.execution.lock'));
      const accounting = resourcePoolStatus(runtime.root, pool, bindings, []);
      requireEvidence(!accounting.attempts.some(row => row.status === 'uncertain' || row.status === 'reserved' && !owner?.ownsReceipt(row)));
      stage = 'successors';
      const journal = readEngineeringSuccessorJournal({ directory: join(runtime.root, 'engineering-successors', successor.supervisionId),
        config: successor, expectedEnrollment: { id: 'enrollment', kind: 'enrollment', configDigest: hash(successor),
          supervisionDigest: durable.state.configDigest, deadlineAt: durable.state.deadlineAt, poolDigest,
          cwd: pinResourceConsoleProject({ id: 'proposal', label: 'Proposal workspace', workspace: project.workspace }) } });
      const intents = journal.records.filter((row): row is Intent => row.kind === 'intent');
      const edges = new Map<string, string>(); const stopped = new Set<string>();
      for (const intent of intents) {
        const actual = completed.find(row => row.graph.enrollmentId === intent.source.enrollmentId && row.graph.enrollmentDigest === intent.source.enrollmentDigest);
        requireEvidence(actual);
        const evidence = { enrollmentId: actual.graph.enrollmentId, enrollmentDigest: actual.graph.enrollmentDigest,
          projectId: actual.source.projectId, deliveryDigest: actual.source.source.expectedDeliveryDigest,
          commit: actual.source.commit, objective: actual.source.objective,
          context: canonical({ acceptance: profile.acceptance, source: JSON.parse(actual.source.context) }) };
        requireEvidence(canonical(evidence) === canonical(intent.source));
        const result = journal.records.find((row): row is Result => row.kind === 'result' && row.key === intent.key);
        const receipt = accounting.attempts.find(row => row.id === intent.task.id);
        requireEvidence(result && receipt && receipt.status === 'completed' && receipt.taskDigest === hash(intent.task) &&
          receipt.poolDigest === poolDigest && successor.allowedWorkerIds.includes(receipt.workerId) &&
          hash(receipt) === result.receiptDigest && receipt.outputDigest === digest(result.output));
        const prepared = journal.records.find((row): row is Prepared => row.kind === 'prepared' && row.key === intent.key);
        const admitted = journal.records.find((row): row is Admitted => row.kind === 'admitted' && row.key === intent.key);
        const proposal = parseResourceEngineeringSuccessorProposal(result.output);
        if (proposal.action === 'stop') {
          requireEvidence(!prepared && !admitted); stopped.add(actual.graph.enrollmentId); continue;
        }
        requireEvidence(prepared && admitted && prepared.enrollmentDigest === admitted.enrollmentDigest);
        const child = registrations.find(row => row.request.id === prepared.enrollmentId && row.enrollmentDigest === prepared.enrollmentDigest);
        requireEvidence(child && child.request.profileId === successor.profileId && prepared.projectId === plan.projectId &&
          child.request.name === proposal.name && child.request.objective === proposal.objective &&
          canonical(child.source) === canonical(actual.source.source));
        edges.set(actual.graph.enrollmentId, child.request.id);
      }
      stage = 'lineage';
      const initial = registrations.filter(row => row.enrollmentDigest === plan.initialEnrollmentDigest && row.source === undefined);
      requireEvidence(initial.length === 1);
      let tipId = initial[0]!.request.id; const visited = new Set<string>();
      while (true) {
        requireEvidence(!visited.has(tipId)); visited.add(tipId);
        const next = edges.get(tipId); if (!next) break;
        requireEvidence(!stopped.has(tipId)); tipId = next;
      }
      requireEvidence(visited.size === registrations.length);
      const tip = completed.find(row => row.graph.enrollmentId === tipId);
      requireEvidence(tip);
      // A verified live owner may progress ordinary human tasks between samples.
      // Keep project/epoch state and every engineering/unknown receipt in the
      // join; unrelated prompt history and collector timestamps are not delivery.
      return { planDigest: plan.planDigest, runtime, config, supervision, successor, project,
        consoleState: owner ? { ...consoleState, jobs: [] } : consoleState,
        registrations, durable, completed, journal,
        // Scheduling previews use wall-clock quota freshness. Compare persisted
        // accounting facts, not a time-varying plan, during the second sample.
        accounting: { attempts: owner ? accounting.attempts.filter(row => !owner.ownsReceipt(row)) : accounting.attempts,
          observations: owner?.metadataPending ? [] : accounting.observations, allocation: accounting.allocation,
          workerAccess: accounting.workerAccess, quotaScopeAccess: accounting.quotaScopeAccess },
        tip: { enrollmentId: tipId, enrollmentDigest: tip.graph.enrollmentDigest, projectId: tip.source.projectId, commit: tip.source.commit },
        continuation: stopped.has(tipId) ? 'stop-requested' as const : 'eligible' as const };
    };
    const first = sample(); const second = sample();
    stage = 'stability'; requireEvidence(hash(first) === hash(second) && locks.every(lock => ownsLocalStoreLock(lock)));
    let feedback: EngineeringMissionFeedback | undefined;
    if (options.proposalFeedback === MISSION_MEASURED_FEEDBACK) {
      const selected = second.completed.find(row => row.graph.enrollmentId === second.tip.enrollmentId)!;
      feedback = projectEngineeringMissionFeedback({ tip: second.tip,
        deliveryDigest: selected.source.source.expectedDeliveryDigest, outcomes: selected.outcomes });
    }
    // Publish the verified result only after every requested projection has
    // completed, so projection refusal cannot leave a partial verified proof.
    if (custody !== undefined) readResourceWorkspaceCustody(custody);
    report.evidenceDigest = hash(second); report.tip = second.tip; report.continuation = second.continuation; report.status = 'verified';
    if (feedback) report.feedback = feedback;
  } catch { report.reasons = [`${stage}-evidence-unavailable`]; }
  return report;
}
