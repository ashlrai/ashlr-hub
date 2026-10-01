import type { ExecutionFeedbackOutcome } from './execution-feedback-types.js';

/** Browser-safe recorded evidence; no execution or authority inputs. */
export type ExecutionCaseStage = 'produced' | 'verified' | 'pr-opened' | 'merged' | 'post-merge' | 'reverted';
export interface ExecutionCaseTimelineEntry {
  stage: ExecutionCaseStage;
  at: string | null;
  result: 'recorded' | 'passed' | 'failed' | 'unbound' | 'host-merged' | 'local-merged' | 'green' | 'red' | 'reverted';
  basis: 'dispatch-final' | 'proposal-verification' | 'authority-ledger' | 'authenticated-host' | 'authenticated-local';
  /** Fixed local application route or canonical HTTPS GitHub PR link only. */
  href?: string;
  ci?: 'green' | 'red' | 'none' | 'unknown';
  suite?: 'pass' | 'fail' | 'not-run';
}
export interface ExecutionFeedbackCaseDetail {
  schemaVersion: 1;
  caseId: string;
  outcome: ExecutionFeedbackOutcome;
  endedAt: string;
  coverage: {
    dispatch: 'healthy' | 'degraded' | 'missing';
    proposals: 'healthy' | 'degraded' | 'missing';
    ledger: 'healthy' | 'missing' | 'broken' | 'unavailable';
    invalidRecords: number;
    conflictingRecords: number;
  };
  timeline: ExecutionCaseTimelineEntry[];
  /** Merge and post-merge checks never imply a release or deployment. */
  shipping: 'not-recorded';
  digest: string;
}
