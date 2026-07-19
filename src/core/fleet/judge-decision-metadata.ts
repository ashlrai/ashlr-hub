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
): JudgeDecisionReasonCode {
  if (verdict === 'ship') {
    return wouldMerge ? 'judge-ship-would-merge' : 'judge-ship-review-required';
  }
  if (verdict === 'review') return 'judge-review';
  if (verdict === 'noise') return 'judge-noise';
  if (verdict === 'harmful') return 'judge-harmful';
  return 'judge-verdict-unrecognized';
}
