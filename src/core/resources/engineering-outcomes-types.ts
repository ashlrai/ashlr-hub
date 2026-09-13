/** Bounded observations, not production acceptance, causal credit or routing authority. */
export interface ResourceEngineeringPhaseEvidence {
  schemaVersion: 1;
  scope: 'recorded-execution-phases';
  liveness: 'not-attested';
  sourceState: 'available' | 'unavailable';
  reason: null | 'phase-evidence-unavailable' | 'phase-evidence-changed' | 'phase-evidence-bounds-exceeded';
  seed: null | { state: 'unmeasured' | 'intent-recorded' | 'result-recorded'; startedAt: string | null; finishedAt: string | null };
  runs: Array<{ runId: string; generation: number; state: 'not-recorded' | 'running' | 'completed' | 'interrupted' | 'failed';
    workers: Array<{ variantId: string; taskId: string;
      state: 'not-recorded' | 'unverified' | 'reserved' | 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'uncertain';
      startedAt: string | null; finishedAt: string | null }>;
    evaluators: Array<{ trialId: string; variantId: string | null;
      state: 'intent-recorded' | 'not-started' | 'group-exit-confirmed'; startedAt: string; finishedAt: string | null }> }>;
}

export interface ResourceEngineeringOutcomeUsage {
  /** Recorded dispatches or unresolved reserved generation slots; not provider requests. */
  attempts: number;
  joinedAttempts: number;
  reportedAttempts: number;
  unknownAttempts: number;
  recordedInputTokens: number;
  recordedOutputTokens: number;
  totalTokens: number | null;
  complete: boolean;
}
export interface ResourceEngineeringOutcomeTiming {
  /** Sum of adapter invocation intervals including cleanup, not elapsed campaign time. */
  scope: 'summed-worker-execution';
  attempts: number;
  measuredAttempts: number;
  recordedDurationMs: number;
  totalDurationMs: number | null;
  complete: boolean;
}
export interface ResourceEngineeringOutcomeStages {
  trials: number;
  evaluated: number;
  passed: number;
  rejected: number;
  selected: number;
  strictImprovements: number;
  verifiedLocalDeliveries: number | null;
}
export interface ResourceEngineeringCampaignOutcome {
  campaignId: string;
  universeId: string | null;
  definitionDigest: string | null;
  comparatorDigest: string | null;
  state: string | null;
  sourceState: 'healthy' | 'unavailable';
  reasons: string[];
  /** Optional bounded observation; absence includes legacy responses and response-size limits. */
  phaseEvidence?: ResourceEngineeringPhaseEvidence;
  metric: { name: string; direction: 'maximize' | 'minimize'; minImprovement: number } | null;
  seed: { status: 'unmeasured' | 'pending' | 'measured' | 'unavailable'; score: number | null; passed: boolean | null };
  stages: ResourceEngineeringOutcomeStages;
  usage: ResourceEngineeringOutcomeUsage;
  timing: ResourceEngineeringOutcomeTiming;
  /** Final selected campaign occurrences only. No cross-comparator score aggregation. */
  niches: Array<{ niche: string; score: number; deltaFromSeed: number | null; artifactDigest: string;
    runId: string; trialId: string }>;
  /** Outcomes associated with exact generating receipts, not causal/model-quality credit. */
  workers: Array<{ workerId: string; provider: string; model: string;
    usage: ResourceEngineeringOutcomeUsage; timing: ResourceEngineeringOutcomeTiming; evaluated: number; passed: number; rejected: number }>;
}
export interface ResourceEngineeringOutcomes {
  schemaVersion: 1;
  enrollmentId: string;
  enrollmentDigest: string;
  sampledAt: string;
  sourceState: 'healthy' | 'degraded' | 'unavailable';
  scope: 'campaign-evaluations-and-recorded-worker-usage';
  authority: 'observation-only';
  acceptanceScope: 'fixed-evaluator-and-local-branch-only';
  attribution: 'campaign-cumulative-not-graph-invocation';
  productionAccepted: null;
  routingChanged: false;
  /** Completeness of observed evidence joins, not completion of campaign work. */
  complete: boolean;
  reasons: string[];
  usage: ResourceEngineeringOutcomeUsage;
  timing: ResourceEngineeringOutcomeTiming;
  campaigns: ResourceEngineeringCampaignOutcome[];
}
