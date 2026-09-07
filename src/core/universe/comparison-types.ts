import type { UniverseDeliveryReport } from './delivery.js';
import type { UniverseCampaignSummary, UniverseManifest, UniverseSummary } from './types.js';

/** Detached, strictly replayed inputs supplied by the targeted read-only reader. */
export interface UniverseComparisonArmSource {
  campaignId: string;
  sourceState: 'missing' | 'healthy' | 'degraded';
  campaign: UniverseCampaignSummary | null;
  universe: UniverseSummary | null;
  seedDigest: string | null;
  deliveryReport: UniverseDeliveryReport | null;
  reasons: string[];
}

export interface UniverseComparisonArm {
  campaignId: string;
  universeId: string | null;
  definitionDigest: string | null;
  manifestDigest: string | null;
  comparatorDigest: string | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  campaignState: UniverseCampaignSummary['state'] | null;
  reasons: string[];
  completed: boolean;
  fresh: boolean;
  fullyAttributed: boolean;
  nonempty: boolean;
  metric: UniverseManifest['metric'] | null;
  feedback: {
    configured: boolean | null;
    observed: 'disabled' | 'legacy-v1' | 'search-v2' | 'mixed' | 'unobserved';
    runs: { disabled: number; legacyV1: number; searchV2: number };
    receipts: { modelTrials: number; legacyFeedback: number; searchContext: number };
  };
  counts: {
    attempts: number;
    completedRuns: number;
    interruptedRuns: number;
    failedRuns: number;
    passedTrials: number;
    admissions: number;
    improvements: number;
    /** Recorded selected content identities, excluding the pinned seed; not accepted changes. */
    distinctSelectedArtifacts: number;
    modelRequestsStarted: number;
    reportedModelRequests: number;
    reservedModelRequests: number;
    /** Null when independent delivery evidence is unavailable or degraded. */
    verifiedDeliveryBranches: number | null;
    distinctDeliveredArtifacts: number | null;
  };
  usage: { reportedTokens: number | null; recordedTokens: number; complete: boolean };
  timing: { recordedRunDurationMs: number | null; wallSpanMs: number | null };
  rates: {
    scope: 'campaign-recorded-run-time-and-reported-model-tokens';
    improvementsPerMillionTokens: number | null;
    distinctSelectedArtifactsPerMillionTokens: number | null;
    improvementsPerHour: number | null;
    distinctSelectedArtifactsPerHour: number | null;
    reasons: string[];
  };
  /** Final selected occurrences within this campaign, never the later global archive. */
  niches: Array<{ niche: string; score: number; runId: string; trialId: string; artifactDigest: string }>;
  acceptedChanges: null;
}

export interface UniverseCampaignComparison {
  schemaVersion: 1;
  sampledAt: string;
  measurementScope: 'local-experiment';
  authority: 'observation-only';
  sourceState: 'missing' | 'healthy' | 'degraded';
  reasons: string[];
  baseline: UniverseComparisonArm;
  challenger: UniverseComparisonArm;
  matching: {
    comparator: boolean;
    /** Feedback is described separately, not included in this control comparison. */
    configuration: boolean;
    workload: boolean;
    comparable: boolean;
    reasons: string[];
  };
  differences: string[];
  feedbackContrast: 'feedback-bundle-v2' | 'same-feedback-condition' | 'other-or-mixed' | 'unobserved';
  scoreDeltas: Array<{ niche: string; baselineScore: number | null; challengerScore: number | null; directionAdjustedDelta: number | null }>;
  acceptedChanges: null;
}
