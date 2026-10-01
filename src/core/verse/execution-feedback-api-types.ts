import type { ExecutionFeedbackCaseDetail } from '../fleet/execution-feedback-case-types.js';
import type { ExecutionFeedbackView } from '../fleet/execution-feedback-types.js';

/** Recorded outcomes only. Reading this surface cannot launch or repair work. */
export interface ExecutionFeedbackRead {
  v: 1;
  state: 'warming' | 'current' | 'stale' | 'unavailable';
  refreshedAt: string | null;
  feedback: ExecutionFeedbackView | null;
}

export const EXECUTION_FEEDBACK_PATH = '/api/verse/fleet/live/feedback';

/** Detail stays lazy and independently qualified from aggregate totals. */
export interface ExecutionFeedbackCaseRead {
  v: 1;
  state: 'warming' | 'current' | 'stale' | 'unavailable';
  refreshedAt: string | null;
  detail: ExecutionFeedbackCaseDetail | null;
}
export const EXECUTION_FEEDBACK_CASE_PATH = `${EXECUTION_FEEDBACK_PATH}/cases/`;
