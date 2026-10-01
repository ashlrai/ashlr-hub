/** Browser-safe recorded execution evidence. No dispatch or authority lives here. */
export type ExecutionFeedbackOutcome = 'producer-succeeded' | 'failed' | 'cancelled' | 'refused' | 'empty-diff' | 'disabled' | 'unknown';
export type ExecutionFailureKind = 'engine' | 'sandbox' | 'capture';
export type ExecutionOutcomeCounts = Record<ExecutionFeedbackOutcome, number>;

export interface ExecutionFeedbackCase {
  /** Opaque stable attempt hash; resolve only through the authorized internal lookup. */
  caseId: string;
  endedAt: string;
  outcome: ExecutionFeedbackOutcome;
  failureKind: ExecutionFailureKind | null;
  /** Recorded proposal or exact run+trajectory join, never a title/repo heuristic. */
  proposalRecorded: boolean;
}

export interface ExecutionFeedbackView {
  schemaVersion: 1;
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  window: { since: string; through: string };
  observedThrough: string | null;
  /** Exact totals only when the bounded detailed source is complete. */
  counts: ExecutionOutcomeCounts | null;
  /** Lower bounds when coverage is partial; missing is not a measured zero. */
  observedCounts: ExecutionOutcomeCounts;
  cases: ExecutionFeedbackCase[];
  coverage: {
    legacyRows: number;
    invalidAttempts: number;
    conflictingAttempts: number;
    duplicateRows: number;
    invalidTimestamps: number;
    proposalSource: 'missing' | 'healthy' | 'degraded' | 'unavailable';
  };
  /** Content digest excludes assembly time and private dispatch payloads. */
  digest: string;
}

/** Stable finite metadata only; no run, account, repo, prompt, or error content. */
export type LeaderExecutionFeedback = Pick<ExecutionFeedbackView,
  'sourceState' | 'complete' | 'observedThrough' | 'counts' | 'observedCounts' | 'coverage' | 'digest'>;
