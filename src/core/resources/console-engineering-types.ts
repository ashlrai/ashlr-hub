/** Browser-safe enrollment/evidence projections. No host paths or candidate/task text. */
export interface ResourceConsoleEngineeringEnrollment {
  id: string;
  projectId: string;
  graphId: string;
  enrollmentDigest: string;
  objective: string;
  campaigns: Array<{ id: string; dependsOn: string[]; objective: string; branch: string;
    campaignBudget: { maxGenerations: number; maxDurationMs: number; maxModelRequests: number;
      maxStagnantGenerations: number; maxReportedTokens: number | null };
    budget: { maxTrials: number; maxDurationMs: number; trialTimeoutMs: number; maxParallel: number } }>;
  budget: { maxParallel: number; maxDurationMs: number };
  acceptanceScope: 'fixed-evaluator-and-local-branch-only';
}

export interface ResourceConsoleEngineeringLaunch {
  enrollmentId: string;
  expectedEnrollmentDigest: string;
}

export interface ResourceConsoleEngineeringJob {
  enrollmentId: string;
  projectId: string;
  graphId: string;
  enrollmentDigest: string;
  state: 'ready' | 'running' | 'completed' | 'incomplete' | 'stopped' | 'unavailable';
  sourceState: 'missing' | 'healthy' | 'degraded';
  cancellable: boolean;
  launched: boolean;
  cancelled: boolean;
  definitionDigest: string | null;
  deadlineAt: string | null;
  nodes: Array<{ id: string; kind: string; state: 'pending' | 'unresolved' | 'completed' | 'rejected';
    artifactDigest: string | null }>;
  reasons: string[];
  acceptanceScope: 'fixed-evaluator-and-local-branch-only';
}
