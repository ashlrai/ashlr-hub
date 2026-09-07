import type { UniverseCampaignComparison, UniverseComparisonArm, UniverseComparisonArmSource } from './comparison-types.js';
import type { UniverseRun, UniverseTrial } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const MAX_RUNS = 10_000;
const MAX_STEPS = 128;
const MAX_TRIALS = 64;

// Compare only bounded configuration fields. Do not retain prompts, commands, paths,
// evaluator diagnostics, or arbitrary caller reasons in the public report.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function count(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function finite(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function add(values: number[]): number | null {
  let total = 0;
  for (const value of values) { if (!finite(value) || !finite(total + value)) return null; total += value; }
  return total;
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function empty(source: UniverseComparisonArmSource): UniverseComparisonArm {
  return { campaignId: source.campaignId, universeId: null, definitionDigest: null, manifestDigest: null,
    comparatorDigest: null, sourceState: source.sourceState, campaignState: null, reasons: [], completed: false,
    fresh: false, fullyAttributed: false, nonempty: false, metric: null,
    feedback: { configured: null, observed: 'unobserved', runs: { disabled: 0, legacyV1: 0, searchV2: 0 },
      receipts: { modelTrials: 0, legacyFeedback: 0, searchContext: 0 } },
    counts: { attempts: 0, completedRuns: 0, interruptedRuns: 0, failedRuns: 0, passedTrials: 0,
      admissions: 0, improvements: 0, distinctSelectedArtifacts: 0, modelRequestsStarted: 0, reportedModelRequests: 0,
      reservedModelRequests: 0, verifiedDeliveryBranches: null, distinctDeliveredArtifacts: null },
    usage: { reportedTokens: null, recordedTokens: 0, complete: false },
    timing: { recordedRunDurationMs: null, wallSpanMs: null },
    rates: { scope: 'campaign-recorded-run-time-and-reported-model-tokens', improvementsPerMillionTokens: null,
      distinctSelectedArtifactsPerMillionTokens: null, improvementsPerHour: null, distinctSelectedArtifactsPerHour: null, reasons: [] },
    niches: [], acceptedChanges: null };
}
function eligible(arm: UniverseComparisonArm): boolean {
  return arm.sourceState === 'healthy' && arm.completed && arm.fresh && arm.fullyAttributed && arm.nonempty;
}
function summarize(source: UniverseComparisonArmSource): UniverseComparisonArm {
  const arm = empty(source);
  const { campaign, universe } = source;
  const issue = (reason: string): void => { arm.sourceState = 'degraded'; arm.reasons.push(reason); };
  if (!campaign || !universe) {
    if (source.sourceState !== 'missing') issue('campaign-or-universe-unavailable');
    else arm.reasons.push('campaign-or-universe-missing');
    arm.rates.reasons.push('arm-evidence-unavailable');
    return arm;
  }
  arm.universeId = campaign.definition.universeId;
  arm.definitionDigest = campaign.definitionDigest;
  arm.manifestDigest = campaign.manifestDigest;
  arm.comparatorDigest = campaign.comparatorDigest;
  arm.campaignState = campaign.state;
  arm.feedback.configured = campaign.definition.feedback;
  arm.metric = { name: universe.manifest.metric.name, direction: universe.manifest.metric.direction,
    minImprovement: universe.manifest.metric.minImprovement };
  if (source.sourceState !== 'healthy' || campaign.sourceState !== 'healthy' || universe.sourceState !== 'healthy') issue('source-evidence-degraded');
  if (source.reasons.includes('Selected evidence changed while the comparison was sampled')) issue('source-changed-during-sampling');
  if (source.campaignId !== campaign.definition.id || campaign.definition.universeId !== universe.manifest.id ||
      campaign.manifestDigest !== universe.manifestDigest || campaign.comparatorDigest !== universe.comparatorDigest ||
      ![campaign.definitionDigest, campaign.manifestDigest, campaign.comparatorDigest, source.seedDigest].every((value) => typeof value === 'string' && HASH.test(value))) {
    issue('source-identity-mismatch');
  }
  if (!Array.isArray(campaign.steps) || campaign.steps.length > MAX_STEPS || !Array.isArray(universe.runs) ||
      universe.runs.length > MAX_RUNS || !Array.isArray(universe.manifest.variants) || universe.manifest.variants.length > MAX_TRIALS ||
      campaign.steps.some((step) => !Array.isArray(step.variantIds) || step.variantIds.length > MAX_TRIALS) ||
      universe.runs.some((run) => !Array.isArray(run.trials) || run.trials.length > MAX_TRIALS)) {
    issue('source-bounds-exceeded'); arm.rates.reasons.push('arm-evidence-unavailable'); return arm;
  }
  const runs = new Map(universe.runs.map((run) => [run.id, run]));
  const stepIds = new Set(campaign.steps.map((step) => step.runId));
  if (runs.size !== universe.runs.length || stepIds.size !== campaign.steps.length) issue('duplicate-run-occurrence');
  arm.counts.attempts = campaign.steps.length;
  arm.fresh = campaign.steps.length > 0 && campaign.steps[0].generation === 1;
  arm.fullyAttributed = universe.runs.every((run) => stepIds.has(run.id));
  if (!arm.fresh) arm.reasons.push('campaign-not-fresh');
  if (!arm.fullyAttributed) arm.reasons.push('unrelated-universe-history');
  const scoped: UniverseRun[] = [];
  const tokens: number[] = [];
  const durations: number[] = [];
  const reservations: number[] = [];
  const selected = new Set<string>();
  const retained = new Map<string, UniverseComparisonArm['niches'][number]>();
  const occurrences = new Map<string, { run: UniverseRun; trial: UniverseTrial }>();
  const observed = new Set<'disabled' | 'legacy-v1' | 'search-v2'>();
  let usageComplete = true;
  for (const [index, step] of campaign.steps.entries()) {
    reservations.push(step.reservedModelRequests);
    if (step.ordinal !== index + 1 || !count(step.reservedModelRequests) || !Array.isArray(step.variantIds) ||
        step.variantIds.length > MAX_TRIALS || new Set(step.variantIds).size !== step.variantIds.length) issue('step-evidence-mismatch');
    if (step.state === 'interrupted') arm.counts.interruptedRuns++;
    if (step.state === 'failed') arm.counts.failedRuns++;
    const run = runs.get(step.runId);
    if (!run) {
      arm.fullyAttributed = false;
      if (step.reservedModelRequests > 0) usageComplete = false;
      if (step.state === 'completed') issue('completed-run-missing');
      continue;
    }
    scoped.push(run);
    if (run.universeId !== universe.manifest.id || run.manifestDigest !== campaign.manifestDigest ||
        run.comparatorDigest !== campaign.comparatorDigest || run.campaign?.id !== campaign.definition.id ||
        run.campaign.ordinal !== step.ordinal || run.campaign.definitionDigest !== campaign.definitionDigest ||
        run.generation !== step.generation || run.status !== step.state ||
        Boolean(run.feedbackEnabled) !== campaign.definition.feedback || new Set(run.trials.map((trial) => trial.id)).size !== run.trials.length ||
        new Set(run.trials.map((trial) => trial.variantId)).size !== run.trials.length ||
        run.trials.some((trial) => !step.variantIds.includes(trial.variantId)) ||
        (run.status === 'completed' && run.trials.length !== step.variantIds.length)) issue('run-attribution-mismatch');
    const protocol = !run.feedbackEnabled ? 'disabled' : run.feedbackVersion === 2 ? 'search-v2' : 'legacy-v1';
    arm.feedback.runs[protocol === 'disabled' ? 'disabled' : protocol === 'search-v2' ? 'searchV2' : 'legacyV1']++;
    if (run.status === 'completed') arm.counts.completedRuns++;
    durations.push(run.durationMs);
    if (step.reservedModelRequests > 0 && run.status !== 'completed') usageComplete = false;
    for (const trial of run.trials) {
      occurrences.set(`${run.id}\0${trial.id}`, { run, trial });
      if (trial.status === 'passed') arm.counts.passedTrials++;
      if (trial.generation) {
        const receipt = trial.generation;
        arm.feedback.receipts.modelTrials++;
        if (receipt.feedback) arm.feedback.receipts.legacyFeedback++;
        if (receipt.search) arm.feedback.receipts.searchContext++;
        if (receipt.requestStarted) {
          arm.counts.modelRequestsStarted++;
          observed.add(protocol);
          if ((protocol === 'search-v2') !== Boolean(receipt.search) || (protocol === 'disabled' && receipt.feedback)) issue('feedback-protocol-mismatch');
          if (receipt.usage.state === 'reported') {
            arm.counts.reportedModelRequests++;
            const input = receipt.usage.inputTokens;
            const output = receipt.usage.outputTokens;
            if (input === null || output === null || !count(input) || !count(output)) issue('token-accounting-invalid');
            else tokens.push(input, output);
          } else usageComplete = false;
        } else if (receipt.usage.state === 'reported') issue('token-accounting-invalid');
      }
      // Incomplete generations cannot admit artifacts or replace the archive.
      if (run.status !== 'completed' || !trial.selected) continue;
      if (trial.status !== 'passed' || trial.score === null || !Number.isFinite(trial.score) || !trial.artifact || !HASH.test(trial.artifact.digest) ||
          (trial.delta !== null && (!Number.isFinite(trial.delta) || trial.delta <= 0))) { issue('selected-outcome-invalid'); continue; }
      if (trial.delta === null) arm.counts.admissions++;
      else arm.counts.improvements++;
      if (trial.artifact.digest !== source.seedDigest) selected.add(trial.artifact.digest);
      retained.set(trial.niche, { niche: trial.niche, score: trial.score, runId: run.id, trialId: trial.id, artifactDigest: trial.artifact.digest });
    }
  }
  arm.feedback.observed = observed.size > 1 ? 'mixed' : [...observed][0] ?? 'unobserved';
  arm.counts.distinctSelectedArtifacts = selected.size;
  arm.niches = [...retained.values()].sort((a, b) => a.niche.localeCompare(b.niche));
  arm.nonempty = scoped.some((run) => run.trials.length > 0);
  arm.completed = campaign.state === 'completed' && campaign.steps.length > 0 && campaign.steps.every((step) => step.state === 'completed') && scoped.length === campaign.steps.length;
  if (!arm.completed) arm.reasons.push('campaign-work-incomplete');
  const reserved = add(reservations);
  const recorded = add(tokens);
  if (reserved === null || !count(reserved) || recorded === null || !count(recorded)) issue('resource-accounting-overflow');
  arm.counts.reservedModelRequests = reserved ?? 0;
  if (campaign.progress.attempts !== arm.counts.attempts || campaign.progress.completedRuns !== arm.counts.completedRuns ||
      campaign.progress.interruptedRuns !== arm.counts.interruptedRuns || campaign.progress.reservedModelRequests !== reserved ||
      campaign.progress.admissions !== arm.counts.admissions || campaign.progress.improvements !== arm.counts.improvements) issue('campaign-counter-evidence-mismatch');
  arm.usage.recordedTokens = recorded ?? 0;
  const ledgerUsageComplete = usageComplete && recorded !== null && campaign.progress.usageComplete;
  // Campaign reservations can be fully accounted with zero requests. That is not
  // a measured model-token total (command work and preflight failures stay unmeasured).
  arm.usage.complete = ledgerUsageComplete && arm.counts.modelRequestsStarted > 0;
  if (campaign.progress.recordedTokens !== recorded || campaign.progress.reportedTokens !== (ledgerUsageComplete ? recorded : null)) issue('campaign-token-accounting-mismatch');
  arm.usage.reportedTokens = arm.usage.complete ? recorded : null;
  arm.timing.recordedRunDurationMs = add(durations);
  if (arm.timing.recordedRunDurationMs === null) issue('duration-accounting-invalid');
  if (campaign.startedAt !== null && campaign.finishedAt !== null) {
    const span = Date.parse(campaign.finishedAt) - Date.parse(campaign.startedAt);
    if (finite(span)) arm.timing.wallSpanMs = span;
    else issue('wall-time-evidence-invalid');
  }
  const delivery = source.deliveryReport;
  if (!delivery || delivery.sourceState === 'degraded') issue('delivery-evidence-unavailable');
  else if (delivery.deliveries.length > 128) issue('delivery-bounds-exceeded');
  else {
    const branches = new Set<string>();
    const artifacts = new Set<string>();
    let deliveryValid = true;
    for (const receipt of delivery.deliveries) {
      const occurrence = occurrences.get(`${receipt.runId}\0${receipt.trialId}`);
      if (!occurrence || receipt.status !== 'delivered') continue;
      const { run, trial } = occurrence;
      if (run.status !== 'completed' || !trial.selected || trial.status !== 'passed' ||
          receipt.universeId !== universe.manifest.id || receipt.niche !== trial.niche ||
          receipt.manifestDigest !== campaign.manifestDigest || receipt.comparatorDigest !== campaign.comparatorDigest ||
          receipt.artifactDigest !== trial.artifact?.digest || receipt.repo !== universe.manifest.seed.repo ||
          receipt.baseCommit !== universe.manifest.seed.revision) { issue('delivery-attribution-mismatch'); deliveryValid = false; continue; }
      branches.add(canonical([receipt.repo, receipt.branch]));
      artifacts.add(canonical([receipt.repo, receipt.baseCommit, receipt.artifactDigest]));
    }
    arm.counts.verifiedDeliveryBranches = deliveryValid ? branches.size : null;
    arm.counts.distinctDeliveredArtifacts = deliveryValid ? artifacts.size : null;
  }
  if (arm.sourceState !== 'healthy') {
    arm.usage.reportedTokens = null;
    arm.usage.complete = false;
    arm.counts.verifiedDeliveryBranches = null;
    arm.counts.distinctDeliveredArtifacts = null;
  }
  const ratio = (numerator: number, denominator: number, scale: number): number | null => {
    const value = numerator / denominator * scale;
    return Number.isFinite(value) ? value : null;
  };
  if (!eligible(arm)) arm.rates.reasons.push('requires-healthy-fresh-completed-attributed-nonempty-work');
  if (arm.usage.reportedTokens === null || arm.usage.reportedTokens <= 0) arm.rates.reasons.push('positive-complete-model-token-total-unavailable');
  if (arm.timing.recordedRunDurationMs === null || arm.timing.recordedRunDurationMs <= 0) arm.rates.reasons.push('positive-recorded-run-duration-unavailable');
  if (eligible(arm)) {
    if (arm.usage.reportedTokens !== null && arm.usage.reportedTokens > 0) {
      arm.rates.improvementsPerMillionTokens = ratio(arm.counts.improvements, arm.usage.reportedTokens, 1_000_000);
      arm.rates.distinctSelectedArtifactsPerMillionTokens = ratio(selected.size, arm.usage.reportedTokens, 1_000_000);
    }
    if (arm.timing.recordedRunDurationMs !== null && arm.timing.recordedRunDurationMs > 0) {
      arm.rates.improvementsPerHour = ratio(arm.counts.improvements, arm.timing.recordedRunDurationMs, 3_600_000);
      arm.rates.distinctSelectedArtifactsPerHour = ratio(selected.size, arm.timing.recordedRunDurationMs, 3_600_000);
    }
  }
  arm.reasons = unique(arm.reasons);
  return arm;
}

/** Descriptive paired observations; no model ranking, causal winner, or execution. */
export function buildUniverseCampaignComparison(baselineSource: UniverseComparisonArmSource, challengerSource: UniverseComparisonArmSource,
  sampledAt = new Date().toISOString()): UniverseCampaignComparison {
  if (!Number.isFinite(Date.parse(sampledAt)) || new Date(sampledAt).toISOString() !== sampledAt) throw new Error('Invalid Universe comparison observation time');
  const baseline = summarize(baselineSource);
  const challenger = summarize(challengerSource);
  const sources = [baselineSource, challengerSource];
  const bounded = sources.every((source) => source.campaign && source.universe && source.campaign.steps.length <= MAX_STEPS &&
    source.universe.runs.length <= MAX_RUNS && source.universe.manifest.variants.length <= MAX_TRIALS &&
    source.campaign.steps.every((step) => step.variantIds.length <= MAX_TRIALS) &&
    source.universe.runs.every((run) => run.trials.length <= MAX_TRIALS));
  const comparator = baseline.comparatorDigest !== null && baseline.comparatorDigest === challenger.comparatorDigest;
  const differences: string[] = [];
  let configuration = false;
  let workload = false;
  if (bounded) {
    const [a, b] = sources.map((source) => source.universe!.manifest);
    if (canonical(a.variants) !== canonical(b.variants)) differences.push('ordered-variants-differ');
    if (canonical(a.budget) !== canonical(b.budget)) differences.push('run-budgets-differ');
    if (canonical(baselineSource.campaign!.definition.budget) !== canonical(challengerSource.campaign!.definition.budget)) differences.push('campaign-budgets-differ');
    configuration = differences.length === 0;
    const workloads = sources.map((source) => {
      const runs = new Map(source.universe!.runs.map((run) => [run.id, run]));
      return source.campaign!.steps.map((step) => ({ generation: step.generation, variantIds: step.variantIds,
        recordedVariantIds: runs.get(step.runId)?.trials.map((trial) => trial.variantId) ?? null }));
    });
    workload = canonical(workloads[0]) === canonical(workloads[1]);
  }
  if (!comparator) differences.push('exact-comparator-digests-differ-or-unavailable');
  if (!workload) differences.push('executed-workloads-differ-or-unavailable');
  if (baseline.feedback.configured !== challenger.feedback.configured) differences.push('configured-feedback-differs');
  if (baseline.feedback.observed !== challenger.feedback.observed) differences.push('observed-feedback-protocols-differ');
  const distinct = baseline.campaignId !== challenger.campaignId && baseline.universeId !== null && challenger.universeId !== null && baseline.universeId !== challenger.universeId;
  const reasons: string[] = [];
  if (!distinct) reasons.push('distinct-campaigns-and-universes-required');
  if (!comparator) reasons.push('exact-comparator-match-required');
  if (!configuration) reasons.push('matching-configuration-required');
  if (!workload) reasons.push('equal-executed-work-required');
  if (!eligible(baseline) || !eligible(challenger)) reasons.push('healthy-fresh-completed-attributed-nonempty-arms-required');
  if (baseline.feedback.observed === 'mixed' || challenger.feedback.observed === 'mixed') reasons.push('uniform-observed-feedback-protocols-required');
  const comparable = reasons.length === 0;
  let feedbackContrast: UniverseCampaignComparison['feedbackContrast'] = 'other-or-mixed';
  if (baseline.feedback.observed === 'unobserved' || challenger.feedback.observed === 'unobserved') feedbackContrast = 'unobserved';
  else if (baseline.feedback.configured === false && baseline.feedback.observed === 'disabled' &&
      challenger.feedback.configured === true && challenger.feedback.observed === 'search-v2') feedbackContrast = 'feedback-bundle-v2';
  else if (baseline.feedback.configured === challenger.feedback.configured && baseline.feedback.observed === challenger.feedback.observed &&
      baseline.feedback.observed !== 'mixed') feedbackContrast = 'same-feedback-condition';
  const niches = unique([...baseline.niches, ...challenger.niches].map((item) => item.niche)).sort();
  const scoreDeltas = niches.map((niche) => {
    const baselineScore = baseline.niches.find((item) => item.niche === niche)?.score ?? null;
    const challengerScore = challenger.niches.find((item) => item.niche === niche)?.score ?? null;
    const delta = comparable && baselineScore !== null && challengerScore !== null ?
      (challengerScore - baselineScore) * (baseline.metric?.direction === 'minimize' ? -1 : 1) : null;
    return { niche, baselineScore, challengerScore, directionAdjustedDelta: delta !== null && Number.isFinite(delta) ? delta : null };
  });
  const sourceState = baseline.sourceState === 'missing' && challenger.sourceState === 'missing' ? 'missing' :
    baseline.sourceState === 'healthy' && challenger.sourceState === 'healthy' ? 'healthy' : 'degraded';
  return { schemaVersion: 1, sampledAt, measurementScope: 'local-experiment', authority: 'observation-only', sourceState,
    reasons: sourceState === 'healthy' ? [] : ['comparison-source-evidence-unavailable-or-degraded'], baseline, challenger,
    matching: { comparator, configuration, workload, comparable, reasons }, differences, feedbackContrast, scoreDeltas, acceptedChanges: null };
}
