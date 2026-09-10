/** Recorded initial-repair proof only; never evaluates, reads artifacts or changes selection. */
import { canonical, digest } from './artifacts.js';
import { scheduledVariants } from './store.js';
import type { UniverseCampaignStep, UniverseCampaignSummary, UniverseRun, UniverseSummary, UniverseTrial } from './types.js';

interface VerifiedFailedTrialRepair {
  baselineRunId: string;
  baselineTrialId: string;
  baselineArtifactDigest: string;
  delta: number;
}
export type VerifiedInitialCampaignRepair = VerifiedFailedTrialRepair | {
  kind: 'seed-evaluation';
  seedIntentDigest: string;
  seedResultDigest: string;
  baselineArtifactDigest: string;
  delta: number;
};
const HASH = /^[a-f0-9]{64}$/;
const REJECTED_BY_EVALUATOR = 'Fixed evaluator rejected the candidate';
const finite = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value);
function timestamp(value: string | null): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A first admitted elite has no passed parent or archive delta. An explicitly
 * opted-in caller may instead prove improvement over a measured failed SEED
 * either in an earlier step of this same campaign/niche or in its explicit,
 * evaluator-only seed receipt before any step. This does not invent a parent
 * or a passed baseline. Callers must independently verify both artifact bytes
 * and their normal delivery/ownership/deadline gates before using this proof.
 */
export function verifiedInitialCampaignRepair(universe: UniverseSummary, campaign: UniverseCampaignSummary,
  trial: UniverseTrial, seedDigest: string): VerifiedInitialCampaignRepair | null {
  const generationSucceeded = (value: UniverseTrial): boolean => {
    const variant = universe.manifest.variants.find(row => row.id === value.variantId);
    return !!variant && Boolean(variant.generation) === Boolean(value.generation) &&
      (!value.generation || value.generation.status === 'succeeded' && value.generation.error === undefined);
  };
  if (universe.sourceState !== 'healthy' || campaign.sourceState !== 'healthy' ||
      universe.reasons.length || campaign.reasons.length || campaign.state !== 'completed' ||
      universe.manifest.id !== campaign.definition.universeId || universe.manifestDigest !== campaign.manifestDigest ||
      universe.comparatorDigest !== campaign.comparatorDigest || !HASH.test(seedDigest) ||
      !Number.isFinite(universe.manifest.metric.minImprovement) || universe.manifest.metric.minImprovement < 0 ||
      !['maximize', 'minimize'].includes(universe.manifest.metric.direction) ||
      !trial.selected || trial.status !== 'passed' || !finite(trial.score) || trial.error !== undefined ||
      trial.parentTrialId !== null || trial.delta !== null || !trial.artifact || !HASH.test(trial.artifact.digest) ||
      trial.artifact.digest === seedDigest || trial.artifact.revision !== universe.manifest.seed.revision ||
      !generationSucceeded(trial)) return null;

  const linkedStep = (run: UniverseRun): UniverseCampaignStep | null => {
    const start = timestamp(run.startedAt); const finish = timestamp(run.finishedAt);
    if (run.status !== 'completed' || run.error !== undefined || start === null || finish === null || finish < start ||
        run.universeId !== universe.manifest.id || run.manifestDigest !== universe.manifestDigest ||
        run.comparatorDigest !== universe.comparatorDigest || run.campaign?.id !== campaign.definition.id ||
        run.campaign.definitionDigest !== campaign.definitionDigest ||
        !Number.isSafeInteger(run.generation) || run.generation < 1) return null;
    const steps = campaign.steps.filter(step => step.runId === run.id);
    if (steps.length !== 1) return null;
    const step = steps[0]!;
    if (step.state !== 'completed' || step.ordinal !== run.campaign.ordinal || step.generation !== run.generation ||
        !Number.isSafeInteger(step.ordinal) || step.ordinal < 1 ||
        canonical(step.variantIds) !== canonical(scheduledVariants(universe.manifest, run.generation).slice(0, step.variantIds.length).map(value => value.id)) ||
        step.variantIds.length !== run.trials.length || new Set(step.variantIds).size !== step.variantIds.length ||
        new Set(run.trials.map(value => value.variantId)).size !== run.trials.length ||
        run.trials.some(value => !step.variantIds.includes(value.variantId) ||
          !universe.manifest.variants.some(variant => variant.id === value.variantId && variant.niche === value.niche))) return null;
    return step;
  };
  const recorded = universe.runs.flatMap(run => run.trials.filter(value => value.id === trial.id).map(value => ({ run, value })));
  if (recorded.length !== 1 || canonical(recorded[0]!.value) !== canonical(trial)) return null;
  const candidateRun = recorded[0]!.run; const candidateStep = linkedStep(candidateRun);
  if (!candidateStep) return null;
  const seed = campaign.seedEvaluation;
  if (campaign.definition.measureSeed === true && seed?.result) {
    const { intent, result } = seed;
    const started = timestamp(intent.startedAt); const finished = timestamp(result.finishedAt);
    const campaignStarted = timestamp(campaign.startedAt); const deadline = timestamp(campaign.deadlineAt);
    const intentDigest = digest(canonical(intent));
    if (intent.schemaVersion === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(intent.id) &&
        Number.isSafeInteger(intent.sessionSequence) && intent.sessionSequence > 0 &&
        intent.context === 'campaign-seed-v1' && intent.definitionDigest === campaign.definitionDigest &&
        intent.manifestDigest === universe.manifestDigest && intent.comparatorDigest === universe.comparatorDigest &&
        intent.seedArtifactDigest === seedDigest && intent.deadlineAt === campaign.deadlineAt &&
        started !== null && finished !== null && campaignStarted !== null && deadline !== null &&
        started >= campaignStarted && finished >= started && finished < deadline &&
        finished <= timestamp(candidateRun.startedAt)! && campaign.steps.every(step => {
          const reservedAt = timestamp(step.createdAt); return reservedAt !== null && reservedAt >= finished;
        }) && result.schemaVersion === 1 && result.intentDigest === intentDigest && result.status === 'measured' &&
        result.processGroupSettlement === 'group-exit-confirmed' && result.reason === null &&
        Number.isFinite(result.durationMs) && result.durationMs >= 0 && result.durationMs <= 86_400_000 &&
        result.measurement?.passed === false && finite(result.measurement.score)) {
      const delta = (universe.manifest.metric.direction === 'maximize' ? 1 : -1) * (trial.score - result.measurement.score);
      if (Number.isFinite(delta) && delta > 0 && delta >= universe.manifest.metric.minImprovement) {
        return { kind: 'seed-evaluation', seedIntentDigest: intentDigest, seedResultDigest: digest(canonical(result)),
          baselineArtifactDigest: seedDigest, delta };
      }
    }
  }
  const candidates: Array<VerifiedFailedTrialRepair & { ordinal: number; generation: number }> = [];
  for (const run of universe.runs) {
    const step = linkedStep(run);
    if (!step || step.ordinal >= candidateStep.ordinal || run.generation >= candidateRun.generation ||
        timestamp(run.finishedAt)! > timestamp(candidateRun.startedAt)!) continue;
    for (const baseline of run.trials) {
      // The runner records this exact error for a successfully parsed, negative
      // evaluator verdict. All operational/generation errors remain ineligible.
      if (baseline.niche !== trial.niche || baseline.status !== 'failed' || !finite(baseline.score) ||
          baseline.error !== REJECTED_BY_EVALUATOR || baseline.selected || baseline.parentTrialId !== null || baseline.delta !== null ||
          !baseline.artifact || baseline.artifact.digest !== seedDigest || baseline.artifact.revision !== universe.manifest.seed.revision ||
          !generationSucceeded(baseline)) continue;
      const delta = (universe.manifest.metric.direction === 'maximize' ? 1 : -1) * (trial.score - baseline.score);
      if (!Number.isFinite(delta) || delta <= 0 || delta < universe.manifest.metric.minImprovement) continue;
      candidates.push({ baselineRunId: run.id, baselineTrialId: baseline.id, baselineArtifactDigest: baseline.artifact.digest,
        delta, ordinal: step.ordinal, generation: run.generation });
    }
  }
  candidates.sort((a, b) => b.ordinal - a.ordinal || b.generation - a.generation ||
    a.baselineTrialId.localeCompare(b.baselineTrialId));
  const selected = candidates[0];
  return selected ? { baselineRunId: selected.baselineRunId, baselineTrialId: selected.baselineTrialId,
    baselineArtifactDigest: selected.baselineArtifactDigest, delta: selected.delta } : null;
}
