/** Typed question HTTP transport, loaded only when the question controls open. */
import { apiGet } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import { refreshActivity } from '../shell/useActivity.js';
import { LEADER_THREAD_KEYS, pathSegment, postLeaderRequest } from './thread-data.js';
import { LEADER_QUESTIONS_PATH, type LeaderQuestionProjection, type LeaderQuestionSubmission,
  type SubmitLeaderQuestionResult } from './thread-types.js';

/** Only an explicit capability response establishes an older unsupported server. */
export async function fetchLeaderQuestion(questionId: string, signal?: AbortSignal): Promise<
  { supported: false } | { supported: true; question: LeaderQuestionProjection }
> {
  const { narrowQuestionProjection } = await import('./question-model.js');
  const raw = await apiGet<unknown>(`${LEADER_QUESTIONS_PATH}/${pathSegment(questionId)}`, signal);
  if (raw !== null && typeof raw === 'object' && 'typedQuestionsSupported' in raw) {
    const body = raw as Record<string, unknown>;
    if (body['typedQuestionsSupported'] === false) return { supported: false };
    const question = narrowQuestionProjection(body['question']);
    if (body['typedQuestionsSupported'] === true && question?.questionId === questionId) return { supported: true, question };
  }
  throw new Error('The question response could not be verified. Your draft is kept.');
}

export async function submitLeaderQuestion(questionId: string, submission: LeaderQuestionSubmission): Promise<SubmitLeaderQuestionResult> {
  const { narrowQuestionSubmitResult } = await import('./question-model.js');
  const result = narrowQuestionSubmitResult(await postLeaderRequest(`${LEADER_QUESTIONS_PATH}/${pathSegment(questionId)}/answer`, { submission }));
  if (!result || result.question && result.question.questionId !== questionId) {
    throw new Error('The answer response could not be verified. Check the saved answer before trying again.');
  }
  if (result.outcome === 'recorded') {
    invalidate(LEADER_THREAD_KEYS.thread);
    void refreshActivity();
  }
  return result;
}
