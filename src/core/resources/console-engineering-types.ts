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
  allowPendingContinuation?: true;
  acceptanceScope: 'fixed-evaluator-and-local-branch-only';
}

export interface ResourceConsoleEngineeringLaunch {
  enrollmentId: string;
  expectedEnrollmentDigest: string;
}

export type ResourceConsoleEngineeringReadinessReason =
  | 'already-running' | 'already-completed' | 'graph-terminal'
  | 'owner-unavailable' | 'owner-capacity' | 'queue-paused' | 'project-unavailable'
  | 'global-kill-active' | 'global-kill-unavailable' | 'graph-kill-active' | 'graph-kill-unavailable'
  | 'graph-ownership-unavailable'
  | 'provenance-unavailable' | 'runtime-pin-changed' | 'enrollment-pin-changed'
  | 'graph-evidence-unavailable' | 'launch-cancelled' | 'launch-unresolved' | 'deadline-exhausted'
  | 'controller-already-enrolled' | 'campaign-not-startable';

export interface ResourceConsoleEngineeringReadiness {
  schemaVersion: 1;
  enrollmentId: string;
  enrollmentDigest: string;
  sampledAt: string;
  status: 'ready' | 'blocked' | 'not-applicable';
  action: 'launch' | 'reconcile' | 'continue' | 'none';
  reasons: ResourceConsoleEngineeringReadinessReason[];
  scope: 'local-admission-check-only';
  effectsExecuted: false;
  providerContacted: false;
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
