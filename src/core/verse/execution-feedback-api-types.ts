import type { ExecutionFeedbackView } from '../fleet/execution-feedback-types.js';

/** Recorded outcomes only. Reading this surface cannot launch or repair work. */
export interface ExecutionFeedbackRead {
  v: 1;
  state: 'warming' | 'current' | 'stale' | 'unavailable';
  refreshedAt: string | null;
  feedback: ExecutionFeedbackView | null;
}

export const EXECUTION_FEEDBACK_PATH = '/api/verse/fleet/live/feedback';
