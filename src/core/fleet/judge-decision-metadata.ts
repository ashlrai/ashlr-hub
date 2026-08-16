import type { JudgeDecisionReasonCode } from '../types.js';

export type JudgeDecisionVerdict = 'ship' | 'review' | 'noise' | 'harmful' | 'unrecognized';

const JUDGE_VERDICTS = new Set<JudgeDecisionVerdict>([
  'ship',
  'review',
  'noise',
  'harmful',
  'unrecognized',
]);

const JUDGE_REASON_CODES = new Set<JudgeDecisionReasonCode>([
  'judge-ship-would-merge',
  'judge-ship-review-required',
  'judge-review',
  'judge-noise',
  'judge-harmful',
  'judge-verdict-unrecognized',
  'judge-parse-failure',
  'judge-network-failure',
]);

export function isJudgeDecisionReasonCode(value: unknown): value is JudgeDecisionReasonCode {
  return typeof value === 'string' && JUDGE_REASON_CODES.has(value as JudgeDecisionReasonCode);
}

export function isJudgeDecisionVerdict(value: unknown): value is JudgeDecisionVerdict {
  return typeof value === 'string' && JUDGE_VERDICTS.has(value as JudgeDecisionVerdict);
}

export function normalizeJudgeDecisionVerdict(value: unknown): JudgeDecisionVerdict {
  return isJudgeDecisionVerdict(value) && value !== 'unrecognized' ? value : 'unrecognized';
}

export function judgeDecisionReasonCode(
  verdict: unknown,
  wouldMerge: boolean,
  /**
   * Set when the underlying ManagerVerdict was a synthetic fallback (never a
   * real judgment) rather than an actual verdict from the model. Takes
   * priority over `verdict` so a parse/network failure can never be recorded
   * with the same reason code as a genuine 'review' judgment.
   */
  failureKind?: 'parse' | 'network',
): JudgeDecisionReasonCode {
  if (failureKind === 'parse') return 'judge-parse-failure';
  if (failureKind === 'network') return 'judge-network-failure';
  if (verdict === 'ship') {
    return wouldMerge ? 'judge-ship-would-merge' : 'judge-ship-review-required';
  }
  if (verdict === 'review') return 'judge-review';
  if (verdict === 'noise') return 'judge-noise';
  if (verdict === 'harmful') return 'judge-harmful';
  return 'judge-verdict-unrecognized';
}
