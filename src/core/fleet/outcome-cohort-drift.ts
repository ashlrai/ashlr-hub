/**
 * Privacy-reduced, observation-only cohort drift projection.
 *
 * Attempt cohorts are compared only after the configured outcome maturity
 * delay. Protected merges keep their exact pseudonymous identity and can
 * mature after the attempt window without losing attribution.
 */

import type { EngineTier, WorkSource } from '../types.js';
import type { RepoProjectKind } from '../run/repo-profile.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIMENSIONS = [
  'project-kind',
  'risk-class',
  'work-source',
  'engine-tier-model-family',
  'router-policy-learning-epoch',
  'repo-digest',
] as const;
const DIMENSION_PRIORITY = new Map<OutcomeCohortDimension, number>([
  ['risk-class', 0],
  ['project-kind', 1],
  ['work-source', 2],
  ['engine-tier-model-family', 3],
  ['router-policy-learning-epoch', 4],
  ['repo-digest', 5],
]);
const PROJECT_KINDS = new Set<OutcomeCohortProjectKind>([
  'node', 'rust', 'python', 'homebrew-formula', 'make', 'just', 'bats', 'verify-contract', 'mixed',
]);
const WORK_SOURCES = new Set<WorkSource>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const MODEL_FAMILIES = new Set<OutcomeCohortModelFamily>(['codex', 'claude', 'kimi', 'local', 'other']);
const SAFE_STOP_REASONS = new Set([
  'adverse-source-missing',
  'adverse-source-incomplete',
  'denominator-membership-mismatch',
  'dispatch-source-incomplete',
  'duplicate-observation',
  'exact-merge-identity-ambiguous',
  'exact-merge-identity-invalid',
  'io-error',
  'missing-source',
  'degraded-source',
  'post-merge-evidence-duplicate',
  'post-merge-evidence-invalid',
  'post-merge-evidence-orphaned',
  'post-merge-evidence-stale',
  'post-merge-source-incomplete',
  'post-merge-source-missing',
  'post-merge-snapshot-stale',
  'post-merge-snapshot-time-invalid',
  'protected-merge-duplicate',
  'protected-merge-reconciliation-failed',
  'protected-merge-snapshot-time-invalid',
  'protected-merge-source-incomplete',
  'protected-merge-source-missing',
  'snapshot-stale',
  'source-incomplete',
  'source-stop-reason-invalid',
  'stability-source-incomplete',
  'stability-source-missing',
  'trajectory-record-limit-reached',
  'trajectory-source-incomplete',
  'trajectory-source-unavailable',
  'window-reconciliation-failed',
]);

export const OUTCOME_COHORT_MIN_SAMPLE = 5;
export const OUTCOME_COHORT_WINDOW_MS = 12 * 60 * 60 * 1_000;
export const OUTCOME_COHORT_OUTCOME_MATURITY_MS = 7 * 24 * 60 * 60 * 1_000;
export const OUTCOME_COHORT_EXCLUSION_REGRESSION_THRESHOLD = 0.10;
export const OUTCOME_COHORT_COST_REGRESSION_RELATIVE_THRESHOLD = 0.25;
export const OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD = 1;
const MAX_REPORTED_COHORTS = 48;

export type OutcomeCohortDimension = typeof DIMENSIONS[number];
export type OutcomeCohortProjectKind = RepoProjectKind | 'mixed';
export type OutcomeCohortModelFamily = 'codex' | 'claude' | 'kimi' | 'local' | 'other';
export type OutcomeCohortVerdict =
  | 'stable'
  | 'drift-observed'
  | 'adverse-observed'
  | 'insufficient-sample'
  | 'withheld';
export type OutcomeCohortPostMergeOutcome =
  | 'not-merged'
  | 'pending'
  | 'withheld'
  | 'stable'
  | 'adverse';

export interface OutcomeCohortWindow {
  startedAt: string;
  endedAt: string;
}

export interface OutcomeCohortMergeIdentity {
  repoDigest: string;
  proposalId: string;
  mergeCommit: string;
  mergedAt: string;
}

export interface OutcomeCohortObservation {
  /** Internal deduplication identity. It is never returned by the projection. */
  observationId: string;
  /** Attempt/proposal decision time used for cohort membership. */
  occurredAt: string;
  projectKind: OutcomeCohortProjectKind | null;
  riskClass: 'low' | 'medium' | 'high' | null;
  workSource: WorkSource | null;
  engineTier: EngineTier | null;
  modelFamily: OutcomeCohortModelFamily | null;
  /** Host-keyed digest of the router policy version. Raw labels are not accepted. */
  routerPolicyDigest: string | null;
  learningEpoch: string | null;
  /** Host-keyed digest only. A repository path is never accepted here. */
  repoDigest: string | null;
  eligible: boolean;
  exclusionReason?: 'ineligible' | 'incomplete' | 'degraded';
  proposalCreated: boolean;
  verificationPassed: boolean;
  mergeIdentity: OutcomeCohortMergeIdentity | null;
  postMergeOutcome: OutcomeCohortPostMergeOutcome;
  outcomeObservedAt: string | null;
  costUsd: number | null;
}

export interface OutcomeCohortSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  stopReasons: string[];
  snapshotAt: string;
  /** All protected merges not old enough for a stable witness as of snapshotAt. */
  pendingProtectedMerges?: number;
}

export interface OutcomeCohortMetrics {
  observed: number;
  eligible: number;
  excluded: number;
  proposals: number;
  verified: number;
  protectedMerges: number;
  stableMerges: number;
  adversePostMerge: number;
  pendingPostMerge: number;
  withheldPostMerge: number;
  postMergeObserved: number;
  postMergeDenominatorState: 'empty' | 'complete' | 'pending' | 'withheld';
  costUsd: number;
  proposalYield: number | null;
  verificationRate: number | null;
  protectedMergeRate: number | null;
  adversePostMergeRate: number | null;
  exclusionRate: number | null;
  costToStableMergeUsd: number | null;
}

export interface OutcomeCohortComparison {
  dimension: OutcomeCohortDimension;
  cohort: string;
  matchingPolicy: {
    routerPolicyDigest: string;
    learningEpoch: string;
  };
  sampleState: 'observed' | 'insufficient-sample';
  baseline: OutcomeCohortMetrics | null;
  current: OutcomeCohortMetrics | null;
  drift: {
    proposalYield: number | null;
    verificationRate: number | null;
    protectedMergeRate: number | null;
    adversePostMergeRate: number | null;
    exclusionRate: number | null;
    costToStableMergeUsd: number | null;
    costToStableMergeRelative: number | null;
  };
}

export interface OutcomeCohortDriftStatus {
  schemaVersion: 1;
  authority: {
    mode: 'observation-only';
    mutationEligible: false;
    routingEligible: false;
    mergeEligible: false;
    learningEligible: false;
    rollbackEligible: false;
    deploymentEligible: false;
    readinessEligible: false;
  };
  claim: {
    basis: 'descriptive-only';
    selectionPropensityAvailable: boolean;
    causalClaimEligible: false;
  };
  verdict: OutcomeCohortVerdict;
  windows: { baseline: OutcomeCohortWindow; current: OutcomeCohortWindow };
  maturity: {
    asOf: string;
    minimumAgeMs: number;
    pendingProtectedMerges: number;
    withheldMatureMerges: number;
  };
  thresholds: {
    minimumSample: number;
    exclusionRateRegression: number;
    costToStableMergeRelative: number;
    costToStableMergeAbsoluteUsd: number;
  };
  denominatorQuality: {
    state: 'complete' | 'withheld';
    observed: number;
    eligible: number;
    excluded: number;
    expectedMemberships: number;
    actualMemberships: number;
    dimensions: number;
    stopReasons: string[];
  };
  cohortCount: number;
  reportedCohorts: number;
  comparisons: OutcomeCohortComparison[];
  highestRiskCohort: OutcomeCohortComparison | null;
  nextEvidenceAction: string;
  summary: string;
}

export interface BuildOutcomeCohortDriftInput {
  observations: readonly OutcomeCohortObservation[];
  source: OutcomeCohortSourceQuality;
  observedAt: string;
  windows: { baseline: OutcomeCohortWindow; current: OutcomeCohortWindow };
  minimumSample?: number;
  maxSnapshotAgeMs?: number;
  outcomeMaturityMs?: number;
  selectionPropensityAvailable?: boolean;
}

type CohortMember = {
  dimension: OutcomeCohortDimension;
  cohort: string;
  observation: OutcomeCohortObservation;
};

type ComparisonSignal = 'adverse' | 'drift' | 'insufficient-alert' | 'stable' | 'insufficient';

const AUTHORITY: OutcomeCohortDriftStatus['authority'] = {
  mode: 'observation-only',
  mutationEligible: false,
  routingEligible: false,
  mergeEligible: false,
  learningEligible: false,
  rollbackEligible: false,
  deploymentEligible: false,
  readinessEligible: false,
};

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function safeStopReasons(values: readonly string[]): Set<string> {
  const reasons = new Set<string>();
  for (const value of values) {
    if (SAFE_STOP_REASONS.has(value)) reasons.add(value);
    else reasons.add('source-stop-reason-invalid');
  }
  return reasons;
}

function safeWindows(input: BuildOutcomeCohortDriftInput): OutcomeCohortDriftStatus['windows'] {
  const fallback = canonicalTimestamp(input.observedAt) ? input.observedAt : new Date(0).toISOString();
  const safe = (window: OutcomeCohortWindow): OutcomeCohortWindow => ({
    startedAt: canonicalTimestamp(window.startedAt) ? window.startedAt : fallback,
    endedAt: canonicalTimestamp(window.endedAt) ? window.endedAt : fallback,
  });
  return { baseline: safe(input.windows.baseline), current: safe(input.windows.current) };
}

export function adjacentOutcomeCohortWindows(
  observedAt: string,
  windowMs = OUTCOME_COHORT_WINDOW_MS,
  outcomeMaturityMs = OUTCOME_COHORT_OUTCOME_MATURITY_MS,
): OutcomeCohortDriftStatus['windows'] {
  if (!canonicalTimestamp(observedAt) || !Number.isSafeInteger(windowMs) || windowMs < 1 ||
    !Number.isSafeInteger(outcomeMaturityMs) || outcomeMaturityMs < 1) {
    throw new Error('invalid outcome cohort window');
  }
  const currentEnd = Date.parse(observedAt) - outcomeMaturityMs;
  const currentStart = currentEnd - windowMs;
  const baselineStart = currentStart - windowMs;
  return {
    baseline: {
      startedAt: new Date(baselineStart).toISOString(),
      endedAt: new Date(currentStart).toISOString(),
    },
    current: {
      startedAt: new Date(currentStart).toISOString(),
      endedAt: new Date(currentEnd).toISOString(),
    },
  };
}

export function privacySafeModelFamily(input: {
  backend?: string | null;
  model?: string | null;
  tier?: EngineTier | string | null;
}): OutcomeCohortModelFamily {
  const value = `${input.backend ?? ''}:${input.model ?? ''}`.toLowerCase();
  if (value.includes('claude') || value.includes('anthropic')) return 'claude';
  if (value.includes('kimi') || value.includes('moonshot')) return 'kimi';
  if (value.includes('codex') || value.includes('openai') || /(?:^|[:/_-])gpt/.test(value)) return 'codex';
  if (input.tier === 'local' || /(?:^|:)(?:builtin|local-coder|ashlrcode|aw|hermes)(?::|$)/.test(value)) {
    return 'local';
  }
  return 'other';
}

export function outcomeCohortMergeIdentityKey(identity: OutcomeCohortMergeIdentity): string {
  return JSON.stringify([
    identity.repoDigest,
    identity.proposalId,
    identity.mergeCommit,
  ]);
}

function rate(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
      numerator < 0 || denominator <= 0 || numerator > denominator) return null;
  return numerator / denominator;
}

function finiteCost(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function metadataReason(
  observation: OutcomeCohortObservation,
  observedAtMs: number,
  maturityMs: number,
): string | null {
  if (!canonicalTimestamp(observation.occurredAt)) return 'observation-time-invalid';
  if (typeof observation.observationId !== 'string' || observation.observationId.length < 1 ||
    observation.observationId.length > 240) return 'observation-identity-invalid';
  if (!observation.projectKind || !PROJECT_KINDS.has(observation.projectKind)) return 'project-kind-missing';
  if (observation.riskClass !== 'low' && observation.riskClass !== 'medium' && observation.riskClass !== 'high') {
    return 'risk-class-missing';
  }
  if (!observation.workSource || !WORK_SOURCES.has(observation.workSource)) return 'work-source-missing';
  if (observation.engineTier !== 'local' && observation.engineTier !== 'mid' && observation.engineTier !== 'frontier') {
    return 'engine-tier-missing';
  }
  if (!observation.modelFamily || !MODEL_FAMILIES.has(observation.modelFamily)) return 'model-family-missing';
  if (!observation.routerPolicyDigest || !SHA256_RE.test(observation.routerPolicyDigest)) {
    return 'router-policy-digest-missing';
  }
  if (!canonicalIsoDay(observation.learningEpoch)) return 'learning-epoch-missing';
  if (!observation.repoDigest || !SHA256_RE.test(observation.repoDigest)) return 'repo-digest-missing';
  if (!finiteCost(observation.costUsd)) return 'cost-missing';
  if (observation.eligible && observation.exclusionReason !== undefined) return 'eligibility-conflict';
  if (!observation.eligible && observation.exclusionReason === undefined) return 'exclusion-reason-missing';
  if (!observation.eligible && (observation.proposalCreated || observation.verificationPassed || observation.mergeIdentity)) {
    return 'excluded-funnel-conflict';
  }
  if (observation.verificationPassed && !observation.proposalCreated) return 'verification-funnel-invalid';

  const merge = observation.mergeIdentity;
  if (!merge) {
    if (observation.postMergeOutcome !== 'not-merged' || observation.outcomeObservedAt !== null) {
      return 'post-merge-orphaned';
    }
    return null;
  }
  if (!observation.proposalCreated || !observation.verificationPassed) return 'protected-merge-funnel-invalid';
  if (!SHA256_RE.test(merge.repoDigest) || merge.repoDigest !== observation.repoDigest ||
    typeof merge.proposalId !== 'string' || merge.proposalId.length < 1 || merge.proposalId.length > 160 ||
    !GIT_SHA_RE.test(merge.mergeCommit) || !canonicalTimestamp(merge.mergedAt)) {
    return 'exact-merge-identity-invalid';
  }
  const mergedAtMs = Date.parse(merge.mergedAt);
  if (mergedAtMs > observedAtMs) return 'post-merge-future';
  const matureAtMs = mergedAtMs + maturityMs;
  if (observation.postMergeOutcome === 'pending') {
    return observation.outcomeObservedAt === null && observedAtMs < matureAtMs
      ? null
      : 'post-merge-pending-invalid';
  }
  if (observation.postMergeOutcome === 'withheld') {
    return observation.outcomeObservedAt === null && observedAtMs >= matureAtMs
      ? null
      : 'post-merge-withheld-invalid';
  }
  if (observation.postMergeOutcome !== 'stable' && observation.postMergeOutcome !== 'adverse') {
    return 'post-merge-join-invalid';
  }
  if (!canonicalTimestamp(observation.outcomeObservedAt)) return 'post-merge-observation-time-invalid';
  const outcomeAtMs = Date.parse(observation.outcomeObservedAt);
  if (outcomeAtMs < mergedAtMs || outcomeAtMs > observedAtMs) return 'post-merge-observation-time-invalid';
  if (observation.postMergeOutcome === 'stable' && outcomeAtMs < matureAtMs) {
    return 'post-merge-stability-immature';
  }
  return null;
}

function memberships(observation: OutcomeCohortObservation): CohortMember[] {
  return [
    { dimension: 'project-kind', cohort: observation.projectKind!, observation },
    { dimension: 'risk-class', cohort: observation.riskClass!, observation },
    { dimension: 'work-source', cohort: observation.workSource!, observation },
    {
      dimension: 'engine-tier-model-family',
      cohort: `${observation.engineTier}/${observation.modelFamily}`,
      observation,
    },
    {
      dimension: 'router-policy-learning-epoch',
      cohort: `${observation.routerPolicyDigest}/${observation.learningEpoch}`,
      observation,
    },
    { dimension: 'repo-digest', cohort: observation.repoDigest!, observation },
  ];
}

function metrics(rows: readonly OutcomeCohortObservation[]): OutcomeCohortMetrics {
  const eligibleRows = rows.filter((row) => row.eligible);
  const proposalRows = eligibleRows.filter((row) => row.proposalCreated);
  const protectedRows = eligibleRows.filter((row) => row.mergeIdentity !== null);
  const stableMerges = protectedRows.filter((row) => row.postMergeOutcome === 'stable').length;
  const adversePostMerge = protectedRows.filter((row) => row.postMergeOutcome === 'adverse').length;
  const pendingPostMerge = protectedRows.filter((row) => row.postMergeOutcome === 'pending').length;
  const withheldPostMerge = protectedRows.filter((row) => row.postMergeOutcome === 'withheld').length;
  const postMergeObserved = stableMerges + adversePostMerge;
  const postMergeDenominatorState: OutcomeCohortMetrics['postMergeDenominatorState'] = protectedRows.length === 0
    ? 'empty'
    : withheldPostMerge > 0
      ? 'withheld'
      : pendingPostMerge > 0
        ? 'pending'
        : 'complete';
  const costUsd = eligibleRows.reduce((total, row) => total + row.costUsd!, 0);
  const verified = proposalRows.filter((row) => row.verificationPassed).length;
  const outcomeComplete = postMergeDenominatorState === 'complete';
  return {
    observed: rows.length,
    eligible: eligibleRows.length,
    excluded: rows.length - eligibleRows.length,
    proposals: proposalRows.length,
    verified,
    protectedMerges: protectedRows.length,
    stableMerges,
    adversePostMerge,
    pendingPostMerge,
    withheldPostMerge,
    postMergeObserved,
    postMergeDenominatorState,
    costUsd,
    proposalYield: rate(proposalRows.length, eligibleRows.length),
    verificationRate: rate(verified, proposalRows.length),
    protectedMergeRate: rate(protectedRows.length, eligibleRows.length),
    adversePostMergeRate: outcomeComplete ? rate(adversePostMerge, postMergeObserved) : null,
    exclusionRate: rate(rows.length - eligibleRows.length, rows.length),
    costToStableMergeUsd: outcomeComplete && stableMerges > 0 ? costUsd / stableMerges : null,
  };
}

function delta(current: number | null, baseline: number | null): number | null {
  return current === null || baseline === null ? null : current - baseline;
}

function relativeDelta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) return null;
  if (baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / baseline;
}

function materialCostRegression(comparison: OutcomeCohortComparison): boolean {
  const absolute = comparison.drift.costToStableMergeUsd;
  const relative = comparison.drift.costToStableMergeRelative;
  if (absolute === null || absolute < OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD) return false;
  const baseline = comparison.baseline?.costToStableMergeUsd ?? null;
  const current = comparison.current?.costToStableMergeUsd ?? null;
  if (baseline === 0 && current !== null) return current >= OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD;
  return relative !== null && relative >= OUTCOME_COHORT_COST_REGRESSION_RELATIVE_THRESHOLD;
}

function materialDrift(comparison: OutcomeCohortComparison): boolean {
  if (comparison.sampleState !== 'observed') return false;
  return (comparison.drift.adversePostMergeRate ?? 0) > 0 ||
    (comparison.drift.verificationRate ?? 0) < -0.1 ||
    (comparison.drift.protectedMergeRate ?? 0) < -0.1 ||
    (comparison.drift.proposalYield ?? 0) < -0.1 ||
    (comparison.drift.exclusionRate ?? 0) >= OUTCOME_COHORT_EXCLUSION_REGRESSION_THRESHOLD ||
    materialCostRegression(comparison);
}

function comparisonSignal(comparison: OutcomeCohortComparison): ComparisonSignal {
  if (comparison.sampleState === 'observed') {
    if ((comparison.current?.adversePostMerge ?? 0) > 0) return 'adverse';
    if ((comparison.baseline?.withheldPostMerge ?? 0) > 0 ||
      (comparison.current?.withheldPostMerge ?? 0) > 0) return 'insufficient-alert';
    return materialDrift(comparison) ? 'drift' : 'stable';
  }
  if (!comparison.baseline || !comparison.current) return 'insufficient-alert';
  const current = comparison.current;
  if (current && (current.adversePostMerge > 0 || current.withheldPostMerge > 0 ||
    current.exclusionRate === 1 || current.proposalYield === 0)) {
    return 'insufficient-alert';
  }
  return 'insufficient';
}

function comparisonRisk(left: OutcomeCohortComparison, right: OutcomeCohortComparison): number {
  const signalRank: Record<ComparisonSignal, number> = {
    adverse: 0,
    drift: 1,
    'insufficient-alert': 2,
    stable: 3,
    insufficient: 4,
  };
  const leftSignal = comparisonSignal(left);
  const rightSignal = comparisonSignal(right);
  const rank = signalRank[leftSignal] - signalRank[rightSignal];
  if (rank !== 0) return rank;
  const leftCurrent = left.current;
  const rightCurrent = right.current;
  return (rightCurrent?.adversePostMerge ?? 0) - (leftCurrent?.adversePostMerge ?? 0) ||
    (rightCurrent?.withheldPostMerge ?? 0) - (leftCurrent?.withheldPostMerge ?? 0) ||
    (rightCurrent?.pendingPostMerge ?? 0) - (leftCurrent?.pendingPostMerge ?? 0) ||
    (rightCurrent?.exclusionRate ?? -1) - (leftCurrent?.exclusionRate ?? -1) ||
    (leftCurrent?.protectedMergeRate ?? 1) - (rightCurrent?.protectedMergeRate ?? 1) ||
    (leftCurrent?.proposalYield ?? 1) - (rightCurrent?.proposalYield ?? 1) ||
    (DIMENSION_PRIORITY.get(left.dimension) ?? 99) - (DIMENSION_PRIORITY.get(right.dimension) ?? 99) ||
    left.cohort.localeCompare(right.cohort);
}

function thresholds(input: BuildOutcomeCohortDriftInput): OutcomeCohortDriftStatus['thresholds'] {
  return {
    minimumSample: Number.isSafeInteger(input.minimumSample) && input.minimumSample! > 0
      ? input.minimumSample!
      : OUTCOME_COHORT_MIN_SAMPLE,
    exclusionRateRegression: OUTCOME_COHORT_EXCLUSION_REGRESSION_THRESHOLD,
    costToStableMergeRelative: OUTCOME_COHORT_COST_REGRESSION_RELATIVE_THRESHOLD,
    costToStableMergeAbsoluteUsd: OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD,
  };
}

function maturity(input: BuildOutcomeCohortDriftInput, withheldMatureMerges = 0): OutcomeCohortDriftStatus['maturity'] {
  const pending = input.source.pendingProtectedMerges;
  return {
    asOf: canonicalTimestamp(input.observedAt) ? input.observedAt : new Date(0).toISOString(),
    minimumAgeMs: Number.isSafeInteger(input.outcomeMaturityMs) && input.outcomeMaturityMs! > 0
      ? input.outcomeMaturityMs!
      : OUTCOME_COHORT_OUTCOME_MATURITY_MS,
    pendingProtectedMerges: Number.isSafeInteger(pending) && pending! >= 0 ? pending! : 0,
    withheldMatureMerges,
  };
}

function withheld(
  input: BuildOutcomeCohortDriftInput,
  reasons: Iterable<string>,
  observed = 0,
  eligible = 0,
  excluded = 0,
): OutcomeCohortDriftStatus {
  const stopReasons = [...new Set(reasons)].sort();
  return {
    schemaVersion: 1,
    authority: AUTHORITY,
    claim: {
      basis: 'descriptive-only',
      selectionPropensityAvailable: input.selectionPropensityAvailable === true,
      causalClaimEligible: false,
    },
    verdict: 'withheld',
    windows: safeWindows(input),
    maturity: maturity(input),
    thresholds: thresholds(input),
    denominatorQuality: {
      state: 'withheld',
      observed,
      eligible,
      excluded,
      expectedMemberships: observed * DIMENSIONS.length,
      actualMemberships: 0,
      dimensions: DIMENSIONS.length,
      stopReasons,
    },
    cohortCount: 0,
    reportedCohorts: 0,
    comparisons: [],
    highestRiskCohort: null,
    nextEvidenceAction: stopReasons.length > 0
      ? `Restore complete cohort evidence: ${stopReasons[0]}.`
      : 'Restore complete cohort evidence before interpreting fleet outcomes.',
    summary: 'Outcome cohort drift is withheld; degraded data is never represented as a healthy zero.',
  };
}

/** Build a bounded descriptive projection across mature adjacent attempt windows. */
export function buildOutcomeCohortDrift(input: BuildOutcomeCohortDriftInput): OutcomeCohortDriftStatus {
  const reasons = safeStopReasons(input.source.stopReasons);
  const observedAt = canonicalTimestamp(input.observedAt) ? Date.parse(input.observedAt) : NaN;
  const snapshotAt = canonicalTimestamp(input.source.snapshotAt) ? Date.parse(input.source.snapshotAt) : NaN;
  const maxSnapshotAgeMs = input.maxSnapshotAgeMs ?? 60_000;
  const minimumSample = input.minimumSample ?? OUTCOME_COHORT_MIN_SAMPLE;
  const outcomeMaturityMs = input.outcomeMaturityMs ?? OUTCOME_COHORT_OUTCOME_MATURITY_MS;
  const windows = safeWindows(input);
  const baselineStart = Date.parse(input.windows.baseline.startedAt);
  const baselineEnd = Date.parse(input.windows.baseline.endedAt);
  const currentStart = Date.parse(input.windows.current.startedAt);
  const currentEnd = Date.parse(input.windows.current.endedAt);

  if (input.source.sourceState !== 'healthy') reasons.add(`${input.source.sourceState}-source`);
  if (!input.source.complete) reasons.add('source-incomplete');
  if (!Number.isFinite(observedAt) || !Number.isFinite(snapshotAt)) reasons.add('snapshot-time-invalid');
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0 ||
      (Number.isFinite(observedAt) && Number.isFinite(snapshotAt) &&
        (observedAt < snapshotAt || observedAt - snapshotAt > maxSnapshotAgeMs))) {
    reasons.add('snapshot-stale');
  }
  if (!Number.isSafeInteger(minimumSample) || minimumSample < 1) reasons.add('sample-floor-invalid');
  if (!Number.isSafeInteger(outcomeMaturityMs) || outcomeMaturityMs < 1) reasons.add('outcome-maturity-invalid');
  if (!Number.isSafeInteger(input.source.pendingProtectedMerges ?? 0) ||
    (input.source.pendingProtectedMerges ?? 0) < 0) reasons.add('pending-merge-count-invalid');
  if (![baselineStart, baselineEnd, currentStart, currentEnd].every(Number.isFinite) ||
      baselineStart >= baselineEnd || baselineEnd !== currentStart || currentStart >= currentEnd ||
      currentEnd !== observedAt - outcomeMaturityMs) reasons.add('window-reconciliation-failed');
  if (reasons.size > 0) return withheld(input, reasons);

  const seen = new Set<string>();
  const seenMergeIdentities = new Set<string>();
  let eligible = 0;
  let excluded = 0;
  for (const observation of input.observations) {
    const reason = metadataReason(observation, observedAt, outcomeMaturityMs);
    if (reason) reasons.add(reason);
    if (seen.has(observation.observationId)) reasons.add('duplicate-observation');
    seen.add(observation.observationId);
    const occurredAt = Date.parse(observation.occurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < baselineStart || occurredAt >= currentEnd) {
      reasons.add('out-of-window-observation');
    }
    if (observation.exclusionReason === 'incomplete') reasons.add('incomplete-observation');
    if (observation.exclusionReason === 'degraded') reasons.add('degraded-observation');
    if (observation.mergeIdentity) {
      const key = outcomeCohortMergeIdentityKey(observation.mergeIdentity);
      if (seenMergeIdentities.has(key)) reasons.add('exact-merge-identity-duplicate');
      seenMergeIdentities.add(key);
    }
    if (observation.eligible) eligible++;
    else excluded++;
  }
  if (reasons.size > 0) return withheld(input, reasons, input.observations.length, eligible, excluded);

  const baselineRows = new Map<string, CohortMember[]>();
  const currentRows = new Map<string, CohortMember[]>();
  let actualMemberships = 0;
  for (const observation of input.observations) {
    const occurredAt = Date.parse(observation.occurredAt);
    const target = occurredAt < baselineEnd ? baselineRows : currentRows;
    for (const member of memberships(observation)) {
      const key = JSON.stringify([
        member.dimension,
        member.cohort,
        observation.routerPolicyDigest,
        observation.learningEpoch,
      ]);
      const rows = target.get(key) ?? [];
      rows.push(member);
      target.set(key, rows);
      actualMemberships++;
    }
  }
  const expectedMemberships = input.observations.length * DIMENSIONS.length;
  if (actualMemberships !== expectedMemberships) {
    return withheld(input, ['denominator-membership-mismatch'], input.observations.length, eligible, excluded);
  }

  const comparisons: OutcomeCohortComparison[] = [];
  const allKeys = new Set([...baselineRows.keys(), ...currentRows.keys()]);
  for (const key of allKeys) {
    const [dimension, cohort, routerPolicyDigest, learningEpoch] = JSON.parse(key) as [
      OutcomeCohortDimension,
      string,
      string,
      string,
    ];
    const baselineMembers = baselineRows.get(key);
    const currentMembers = currentRows.get(key);
    const current = currentMembers ? metrics(currentMembers.map((member) => member.observation)) : null;
    const baseline = baselineMembers ? metrics(baselineMembers.map((member) => member.observation)) : null;
    const sampleState = baseline && current && baseline.eligible >= minimumSample && current.eligible >= minimumSample
      ? 'observed'
      : 'insufficient-sample';
    const comparable = sampleState === 'observed';
    comparisons.push({
      dimension,
      cohort,
      matchingPolicy: { routerPolicyDigest, learningEpoch },
      sampleState,
      baseline,
      current,
      drift: {
        proposalYield: comparable ? delta(current?.proposalYield ?? null, baseline?.proposalYield ?? null) : null,
        verificationRate: comparable ? delta(current?.verificationRate ?? null, baseline?.verificationRate ?? null) : null,
        protectedMergeRate: comparable
          ? delta(current?.protectedMergeRate ?? null, baseline?.protectedMergeRate ?? null)
          : null,
        adversePostMergeRate: comparable
          ? delta(current?.adversePostMergeRate ?? null, baseline?.adversePostMergeRate ?? null)
          : null,
        exclusionRate: comparable ? delta(current?.exclusionRate ?? null, baseline?.exclusionRate ?? null) : null,
        costToStableMergeUsd: comparable
          ? delta(current?.costToStableMergeUsd ?? null, baseline?.costToStableMergeUsd ?? null)
          : null,
        costToStableMergeRelative: comparable
          ? relativeDelta(current?.costToStableMergeUsd ?? null, baseline?.costToStableMergeUsd ?? null)
          : null,
      },
    });
  }
  comparisons.sort(comparisonRisk);
  const highestRiskCohort = comparisons[0] ?? null;
  const signals = comparisons.map(comparisonSignal);
  const comparable = comparisons.filter((row) => row.sampleState === 'observed');
  const verdict: OutcomeCohortVerdict = signals.includes('adverse')
    ? 'adverse-observed'
    : signals.includes('drift')
      ? 'drift-observed'
      : signals.includes('insufficient-alert')
        ? 'insufficient-sample'
        : comparable.length > 0
          ? 'stable'
          : 'insufficient-sample';
  const nextEvidenceAction = verdict === 'adverse-observed'
    ? `Inspect the ${highestRiskCohort?.dimension ?? 'highest-risk'} cohort's deterministic post-merge evidence.`
    : verdict === 'drift-observed'
      ? `Collect another matching-policy window for ${highestRiskCohort?.dimension ?? 'the highest-risk cohort'} before changing policy.`
      : verdict === 'insufficient-sample'
        ? `Collect matching-policy samples until each interpreted cohort reaches ${minimumSample} attempts per window.`
        : 'Continue collecting matching-policy post-merge outcomes without granting policy authority.';
  const reported = comparisons.slice(0, MAX_REPORTED_COHORTS);
  const withheldMatureMerges = input.observations.filter((row) => row.postMergeOutcome === 'withheld').length;

  return {
    schemaVersion: 1,
    authority: AUTHORITY,
    claim: {
      basis: 'descriptive-only',
      selectionPropensityAvailable: input.selectionPropensityAvailable === true,
      causalClaimEligible: false,
    },
    verdict,
    windows,
    maturity: maturity(input, withheldMatureMerges),
    thresholds: thresholds(input),
    denominatorQuality: {
      state: 'complete',
      observed: input.observations.length,
      eligible,
      excluded,
      expectedMemberships,
      actualMemberships,
      dimensions: DIMENSIONS.length,
      stopReasons: [],
    },
    cohortCount: comparisons.length,
    reportedCohorts: reported.length,
    comparisons: reported,
    highestRiskCohort,
    nextEvidenceAction,
    summary: verdict === 'stable'
      ? `${comparable.length} matching-policy cohort comparison(s) are descriptively stable.`
      : verdict === 'insufficient-sample'
        ? 'At least one cohort lacks matching-window evidence; no drift, adverse, disparity, or superiority claim is made.'
        : `${highestRiskCohort?.dimension ?? 'A cohort'} is the highest-risk descriptive outcome slice.`,
  };
}

/** Exported for callers that need an explicit zero-free withheld shape. */
export function withheldOutcomeCohortDrift(
  input: Omit<BuildOutcomeCohortDriftInput, 'observations'>,
  reason: string,
): OutcomeCohortDriftStatus {
  return withheld({ ...input, observations: [] }, safeStopReasons([reason]));
}
