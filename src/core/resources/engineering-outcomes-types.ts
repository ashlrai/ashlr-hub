/** Bounded observations, not production acceptance, causal credit or routing authority. */
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
