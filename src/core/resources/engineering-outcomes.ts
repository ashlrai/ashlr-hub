/** Targeted immutable-evidence joins. No admission, execution, repair or routing. */
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { campaignDirectory, foldCampaignEvents, projectCampaign, readCampaignEvents } from '../universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../universe/campaign-delivery-recovery.js';
import { validateUniverseCampaignDeliveryPlan } from '../universe/campaign-delivery.js';
import { readUniverseDeliveries } from '../universe/delivery.js';
import type { FirmEngineeringControlHost } from '../universe/firm-engineering-control-handler.js';
import { resourceGenerationTaskId } from '../universe/generation.js';
import { validateUniversePortfolioDefinition } from '../universe/portfolio-plan.js';
import { foldPortfolioController, portfolioControllerDirectory, readPortfolioControllerEvents } from '../universe/portfolio-controller-store.js';
import { validateResourceGenerationRuntime } from '../universe/resource-generation.js';
import { manifestRecord, projectUniverse, readRecords, universePath } from '../universe/store.js';
import type { UniverseTrial } from '../universe/types.js';
import type { ResourceConsoleEngineeringEnrollment } from './console-engineering-types.js';
import type { ResourceEngineeringCampaignOutcome, ResourceEngineeringOutcomes, ResourceEngineeringOutcomeUsage, ResourceEngineeringOutcomeTiming } from './engineering-outcomes-types.js';
import { validateResourcePool } from './pool-policy.js';
import { readResourceJson, readResourcePoolHistory, resourcePoolStatus } from './pool-runtime.js';
import { resourceUsageScopeForProvider } from './performance.js';
import { validateResourceBindings } from './worker.js';
import { readEngineeringPhaseEvidence, unavailableEngineeringPhaseEvidence } from './engineering-phase-evidence.js';

export interface ResourceEngineeringOutcomesOptions {
  /** Host-owned captured enrollment, not browser-supplied metadata. */
  enrollment: ResourceConsoleEngineeringEnrollment;
  host: FirmEngineeringControlHost;
  root: string;
  poolFile: string;
  bindingsFile: string;
}
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TRIALS = 4096;
class OutcomeAccountingOverflow extends Error {}
function usage(): ResourceEngineeringOutcomeUsage {
  return { attempts: 0, joinedAttempts: 0, reportedAttempts: 0, unknownAttempts: 0,
    recordedInputTokens: 0, recordedOutputTokens: 0, totalTokens: null, complete: true };
}
function finish(value: ResourceEngineeringOutcomeUsage): void {
  value.unknownAttempts = value.attempts - value.reportedAttempts;
  const total = value.recordedInputTokens + value.recordedOutputTokens;
  value.complete = value.complete && value.joinedAttempts === value.attempts && value.unknownAttempts === 0 && Number.isSafeInteger(total);
  value.totalTokens = value.complete && value.attempts > 0 ? total : null;
}
function unavailable(value: ResourceEngineeringOutcomeUsage): void {
  value.unknownAttempts = value.attempts - value.reportedAttempts; value.complete = false; value.totalTokens = null;
}
function timing(): ResourceEngineeringOutcomeTiming {
  return { scope: 'summed-worker-execution', attempts: 0, measuredAttempts: 0, recordedDurationMs: 0, totalDurationMs: null, complete: true };
}
function finishTiming(value: ResourceEngineeringOutcomeTiming): void {
  value.complete = value.complete && value.attempts === value.measuredAttempts && Number.isFinite(value.recordedDurationMs);
  value.totalDurationMs = value.complete && value.attempts > 0 ? value.recordedDurationMs : null;
}
function unavailableTiming(value: ResourceEngineeringOutcomeTiming): void { value.complete = false; value.totalDurationMs = null; }
function empty(campaignId: string): ResourceEngineeringCampaignOutcome {
  return { campaignId, universeId: null, definitionDigest: null, comparatorDigest: null, state: null,
    sourceState: 'unavailable', reasons: [], metric: null, seed: { status: 'unavailable', score: null, passed: null },
    stages: { trials: 0, evaluated: 0, passed: 0, rejected: 0, selected: 0, strictImprovements: 0, verifiedLocalDeliveries: null },
    usage: usage(), timing: timing(), niches: [], workers: [] };
}
function measured(trial: UniverseTrial): boolean {
  return trial.score !== null && Number.isFinite(trial.score) && trial.artifact !== null &&
    (!trial.generation || trial.generation.status === 'succeeded') &&
    (trial.status === 'passed' || trial.status === 'failed' && trial.error === 'Fixed evaluator rejected the candidate');
}
function capture(input: ResourceEngineeringOutcomesOptions): ResourceEngineeringOutcomesOptions {
  const serialized = canonicalEvidencePackJsonV3(input);
  if (serialized === null || Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Invalid engineering outcome scope');
  const value = JSON.parse(serialized) as ResourceEngineeringOutcomesOptions;
  if (Object.keys(value).sort().join() !== 'bindingsFile,enrollment,host,poolFile,root' ||
      !value.enrollment || !ID.test(value.enrollment.id) || !HASH.test(value.enrollment.enrollmentDigest) ||
      !ID.test(value.enrollment.graphId) || !ID.test(value.enrollment.projectId) ||
      [value.root, value.poolFile, value.bindingsFile, value.host?.root, value.host?.resourceRuntime]
        .some(path => typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/')) {
    throw new Error('Invalid engineering outcome scope');
  }
  value.host.definition = validateUniversePortfolioDefinition(value.host.definition);
  value.host.deliveryPlan = validateUniverseCampaignDeliveryPlan(value.host.deliveryPlan, value.host.definition.tasks.map(task => task.campaignId));
  const summaries = value.enrollment.campaigns;
  if (!Array.isArray(summaries) || summaries.length !== value.host.definition.tasks.length || summaries.length > 32 ||
      value.host.deliveryPlan.deliveries.length !== summaries.length ||
      summaries.some((row, index) => row.id !== value.host.definition.tasks[index]!.campaignId ||
        canonical(row.dependsOn) !== canonical(value.host.definition.tasks[index]!.dependsOn) ||
        row.branch !== value.host.deliveryPlan.deliveries.find(target => target.campaignId === row.id)?.branch)) {
    throw new Error('Invalid engineering outcome enrollment');
  }
  return value;
}

function sample(options: ResourceEngineeringOutcomesOptions): { report: ResourceEngineeringOutcomes; fingerprint: string; phases: Map<string, string> } {
  const { enrollment, host } = options;
  const report: ResourceEngineeringOutcomes = { schemaVersion: 1, enrollmentId: enrollment.id, enrollmentDigest: enrollment.enrollmentDigest,
    sampledAt: '', sourceState: 'healthy', scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only',
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation',
    productionAccepted: null, routingChanged: false, complete: true, reasons: [], usage: usage(), timing: timing(), campaigns: [] };
  const fingerprints: string[] = [];
  const phases = new Map<string, string>();
  const pin = (value: unknown) => fingerprints.push(digest(canonical(value)));
  const seen = new Set<string>();
  try {
    const pool = validateResourcePool(readResourceJson(options.poolFile));
    const bindings = validateResourceBindings(readResourceJson(options.bindingsFile), pool);
    const runtime = validateResourceGenerationRuntime(readResourceJson(host.resourceRuntime));
    if (digest(canonical(runtime)) !== host.expectedRuntimeDigest || runtime.root !== options.root ||
        runtime.poolPath !== options.poolFile || runtime.bindingsPath !== options.bindingsFile) throw new Error();
    const history = readResourcePoolHistory(options.root, pool, bindings);
    const ledger = resourcePoolStatus(options.root, pool, bindings, []);
    pin({ pool, bindings, runtime, history, attempts: ledger.attempts });
    const receipts = new Map(ledger.attempts.map(receipt => [receipt.id, receipt]));
    const controllerDirectory = portfolioControllerDirectory(host.definition.id, { root: host.root });
    let controller: ReturnType<typeof foldPortfolioController> | null = null;
    try { lstatSync(controllerDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A missing controller is ordinary for a prepared, never-started enrollment.
    let controllerPresent = false;
    try { lstatSync(controllerDirectory); controllerPresent = true; } catch { /* checked above */ }
    if (controllerPresent) {
      const events = readPortfolioControllerEvents(controllerDirectory); pin(events); controller = foldPortfolioController(events);
      const prior = controller.first.enrollment;
      if (canonical(prior.definition) !== canonical(host.definition) || canonical(prior.deliveryPlan) !== canonical(host.deliveryPlan) ||
          prior.graphDispatch?.graphId !== enrollment.graphId || prior.graphDispatch.nodeId !== host.nodeId) throw new Error();
    }
    let occurrences = 0;
    for (const summary of enrollment.campaigns) {
      const row = empty(summary.id); report.campaigns.push(row);
      try {
        const events = readCampaignEvents(campaignDirectory(summary.id, { root: host.root })); pin(events);
        const created = foldCampaignEvents(events).created;
        const directory = universePath(host.root, created.definition.universeId);
        const records = readRecords(directory); pin(records);
        const manifest = manifestRecord(directory, records);
        const universe = projectUniverse(directory, records);
        const campaign = projectCampaign(events, universe);
        const target = host.deliveryPlan.deliveries.find(value => value.campaignId === summary.id)!;
        const prior = controller?.first.enrollment.pins.find(value => value.campaignId === summary.id);
        if (campaign.sourceState !== 'healthy' || universe.sourceState !== 'healthy' || campaign.definition.id !== summary.id ||
            universe.manifestDigest !== campaign.manifestDigest || universe.comparatorDigest !== campaign.comparatorDigest ||
            canonical(campaign.definition.budget) !== canonical(summary.campaignBudget) || canonical(universe.manifest.budget) !== canonical(summary.budget) ||
            target.baseCommit !== universe.manifest.seed.revision ||
            prior && (prior.universeId !== universe.manifest.id || prior.definitionDigest !== campaign.definitionDigest ||
              prior.manifestDigest !== campaign.manifestDigest || prior.comparatorDigest !== campaign.comparatorDigest) ||
            !controller && campaign.steps.length > 0) throw new Error();
        for (const variant of universe.manifest.variants) {
          const config = variant.generation;
          if (config?.kind !== 'resource-pool' || !config.fileOperations || config.poolId !== pool.id ||
              !history.some(epoch => epoch.poolDigest === config.poolDigest) || config.allowedWorkerIds.some(id => !pool.workers.some(worker => worker.id === id))) throw new Error();
        }
        row.sourceState = 'healthy'; row.universeId = universe.manifest.id; row.definitionDigest = campaign.definitionDigest;
        row.comparatorDigest = campaign.comparatorDigest; row.metric = { ...universe.manifest.metric }; row.state = campaign.state;
        const seed = campaign.seedEvaluation;
        row.seed = { status: !seed ? 'unmeasured' : !seed.result ? 'pending' : 'unavailable', score: null, passed: null };
        if (seed?.result?.status === 'measured' && seed.result.reason === null && seed.result.processGroupSettlement === 'group-exit-confirmed' &&
            seed.intent.definitionDigest === campaign.definitionDigest && seed.intent.manifestDigest === campaign.manifestDigest &&
            seed.intent.comparatorDigest === campaign.comparatorDigest && seed.intent.seedArtifactDigest === manifest.seedArtifact.digest &&
            seed.result.intentDigest === digest(canonical(seed.intent)) && seed.result.measurement) {
          row.seed = { status: 'measured', score: seed.result.measurement.score, passed: seed.result.measurement.passed };
        }
        const phase = readEngineeringPhaseEvidence({ directory, campaign, universe,
          evaluatorDigest: manifest.evaluationBuiltinDigest ?? null, receipts: ledger.attempts });
        row.phaseEvidence = phase.evidence; phases.set(summary.id, phase.fingerprint);
        const retained = new Map<string, ResourceEngineeringCampaignOutcome['niches'][number]>();
        const workers = new Map<string, ResourceEngineeringCampaignOutcome['workers'][number]>();
        const runs = new Map(universe.runs.map(run => [run.id, run]));
        for (const step of campaign.steps) {
          const run = runs.get(step.runId);
          if (run && (run.campaign?.id !== campaign.definition.id || run.campaign.definitionDigest !== campaign.definitionDigest ||
              run.campaign.ordinal !== step.ordinal || run.generation !== step.generation)) throw new Error();
          for (const variantId of step.variantIds) {
            if (++occurrences > MAX_TRIALS) throw new Error();
            const trial = run?.trials.find(value => value.variantId === variantId);
            if (trial) {
              row.stages.trials++;
              if (measured(trial)) { row.stages.evaluated++; if (trial.status === 'passed') row.stages.passed++; else row.stages.rejected++; }
              if (run?.status === 'completed' && trial.selected && trial.status === 'passed' && trial.artifact && trial.score !== null) {
                row.stages.selected++; if (trial.delta !== null && trial.delta > 0) row.stages.strictImprovements++;
                const delta = row.seed.score === null ? null : (trial.score - row.seed.score) * (row.metric.direction === 'maximize' ? 1 : -1);
                retained.set(trial.niche, { niche: trial.niche, score: trial.score, deltaFromSeed: delta !== null && Number.isFinite(delta) ? delta : null,
                  artifactDigest: trial.artifact.digest, runId: run.id, trialId: trial.id });
              }
            }
            const taskId = resourceGenerationTaskId({ universeId: universe.manifest.id, runId: step.runId, variantId });
            const receipt = receipts.get(taskId); const generation = trial?.generation; const witness = generation?.resource;
            if (witness && ['not-started', 'withheld'].includes(witness.dispatch)) { if (receipt) throw new Error(); continue; }
            if (!trial && !receipt && run?.status === 'completed') throw new Error();
            if (seen.has(taskId)) throw new Error(); seen.add(taskId);
            row.usage.attempts++; report.usage.attempts++; row.timing.attempts++; report.timing.attempts++;
            const epoch = receipt && history.find(value => value.poolDigest === receipt.poolDigest);
            const worker = epoch?.pool.workers.find(value => value.id === receipt?.workerId);
            const binding = epoch?.bindings.find(value => value.workerId === receipt?.workerId);
            const joined = !!(receipt && worker && witness && epoch && binding && witness.taskId === taskId &&
              witness.taskDigest === receipt.taskDigest && witness.receiptDigest === digest(canonical(receipt)) &&
              witness.poolId === pool.id && witness.poolDigest === receipt.poolDigest && witness.workerId === worker.id &&
              witness.workerProvider === worker.provider && witness.workerModel === worker.model && receipt.capacityKey === binding.capacityKey &&
              witness.allowedWorkerIds.includes(worker.id) && witness.taskStatus === receipt.status && receipt.verifiedAccepted === false);
            if (!joined || !receipt || !worker || !generation) {
              row.reasons.push('worker-receipt-unverified'); unavailable(row.usage); unavailable(report.usage);
              unavailableTiming(row.timing); unavailableTiming(report.timing); continue;
            }
            let workerRow = workers.get(worker.id);
            if (!workerRow) { workerRow = { workerId: worker.id, provider: worker.provider, model: worker.model, usage: usage(), timing: timing(), evaluated: 0, passed: 0, rejected: 0 }; workers.set(worker.id, workerRow); }
            workerRow.usage.attempts++;
            workerRow.timing.attempts++;
            for (const total of [row.timing, workerRow.timing, report.timing]) {
              if (witness.dispatch === 'settled' && !['reserved', 'uncertain'].includes(receipt.status) && receipt.execution?.durationMs !== null && receipt.execution?.durationMs !== undefined) {
                total.measuredAttempts++; total.recordedDurationMs += receipt.execution.durationMs;
              }
            }
            if (trial && measured(trial)) { workerRow.evaluated++; if (trial.status === 'passed') workerRow.passed++; else workerRow.rejected++; }
            const known = witness.dispatch === 'settled' && !['reserved', 'uncertain'].includes(receipt.status) &&
              generation.usage.state === 'reported' && receipt.inputTokens !== null && receipt.outputTokens !== null &&
              receipt.execution?.usageScope === resourceUsageScopeForProvider(worker.provider) && witness.usageScope === receipt.execution.usageScope &&
              generation.usage.inputTokens === receipt.inputTokens && generation.usage.outputTokens === receipt.outputTokens;
            for (const total of [row.usage, workerRow.usage, report.usage]) {
              total.joinedAttempts++;
              if (known) {
                const input = total.recordedInputTokens + receipt.inputTokens!;
                const output = total.recordedOutputTokens + receipt.outputTokens!;
                if (![input, output, input + output].every(Number.isSafeInteger)) throw new OutcomeAccountingOverflow();
                total.reportedAttempts++; total.recordedInputTokens = input; total.recordedOutputTokens = output;
              }
            }
          }
        }
        row.niches = [...retained.values()].sort((a, b) => a.niche.localeCompare(b.niche));
        row.workers = [...workers.values()].sort((a, b) => a.workerId.localeCompare(b.workerId));
        const deliveries = readUniverseDeliveries(universe.manifest.id, { root: host.root }); pin(deliveries);
        if (deliveries.sourceState === 'degraded') row.reasons.push('delivery-evidence-unavailable');
        else {
          const receipt = readCompletedCampaignDelivery(campaign, target, { root: host.root }); pin(receipt);
          row.stages.verifiedLocalDeliveries = receipt ? 1 : 0;
          if (!receipt && deliveries.deliveries.some(value => value.branch === target.branch && value.status === 'delivered')) {
            row.stages.verifiedLocalDeliveries = null; row.reasons.push('delivery-evidence-unverified');
          }
        }
        finish(row.usage); finishTiming(row.timing); for (const worker of row.workers) { finish(worker.usage); finishTiming(worker.timing); }
        row.reasons = [...new Set(row.reasons)];
      } catch (error) {
        if (error instanceof OutcomeAccountingOverflow) throw error;
        row.sourceState = 'unavailable'; row.reasons = ['campaign-evidence-unavailable']; unavailable(row.usage);
        row.stages.verifiedLocalDeliveries = null; row.niches = []; unavailable(report.usage);
        unavailableTiming(row.timing); unavailableTiming(report.timing);
        row.phaseEvidence = unavailableEngineeringPhaseEvidence();
      }
    }
    finish(report.usage);
    finishTiming(report.timing);
    report.complete = report.campaigns.every(row => row.sourceState === 'healthy' && row.reasons.length === 0) && report.usage.complete && report.timing.complete;
    if (!report.complete) { report.sourceState = 'degraded'; report.reasons = ['outcome-evidence-incomplete']; }
  } catch (error) {
    report.sourceState = 'unavailable'; report.complete = false;
    report.reasons = [error instanceof OutcomeAccountingOverflow ? 'usage-accounting-overflow' : 'enrollment-or-ledger-unavailable'];
    if (error instanceof OutcomeAccountingOverflow) { report.usage = usage(); report.timing = timing(); }
    report.campaigns = []; unavailable(report.usage); unavailableTiming(report.timing);
  }
  // New observation bytes must not change the legacy acceptance/accounting
  // fingerprint or cause an otherwise valid outcome to exceed its old bound.
  const originalReport = { ...report, campaigns: report.campaigns.map(({ phaseEvidence: _phase, ...row }) => row) };
  if (Buffer.byteLength(canonical(originalReport)) > 192 * 1024) {
    report.campaigns = []; report.sourceState = 'unavailable'; report.complete = false; report.reasons = ['outcome-evidence-bounds-exceeded']; unavailable(report.usage); unavailableTiming(report.timing);
  }
  if (Buffer.byteLength(canonical(report)) > 192 * 1024) for (const row of report.campaigns) delete row.phaseEvidence;
  const fingerprintReport = { ...report, campaigns: report.campaigns.map(({ phaseEvidence: _phase, ...row }) => row) };
  return { report, fingerprint: digest(canonical({ fingerprints, report: fingerprintReport })), phases };
}

/** Two bounded observations, not a lock or an atomic snapshot. Unknown stays unknown. */
export function readResourceEngineeringOutcomes(input: ResourceEngineeringOutcomesOptions): ResourceEngineeringOutcomes {
  const options = capture(input);
  const first = sample(options); const second = sample(options);
  if (first.fingerprint !== second.fingerprint) {
    first.report.sourceState = 'degraded'; first.report.complete = false; first.report.reasons = ['evidence-changed-during-sampling'];
    unavailable(first.report.usage);
    unavailableTiming(first.report.timing);
    for (const row of first.report.campaigns) { row.sourceState = 'unavailable'; row.reasons = ['evidence-changed-during-sampling']; unavailable(row.usage);
      unavailableTiming(row.timing); row.stages.verifiedLocalDeliveries = null; row.niches = [];
      row.phaseEvidence = unavailableEngineeringPhaseEvidence('phase-evidence-changed');
      for (const worker of row.workers) { unavailable(worker.usage); unavailableTiming(worker.timing); } }
  } else {
    for (const row of first.report.campaigns) if (row.phaseEvidence && first.phases.get(row.campaignId) !== second.phases.get(row.campaignId)) {
      row.phaseEvidence = unavailableEngineeringPhaseEvidence('phase-evidence-changed');
    }
  }
  first.report.sampledAt = new Date().toISOString();
  // Invalidation can add an unavailable phase to a previously size-trimmed
  // response. Optional diagnostics must still respect the existing wire bound.
  if (Buffer.byteLength(canonical(first.report)) > 192 * 1024) for (const row of first.report.campaigns) delete row.phaseEvidence;
  return first.report;
}
