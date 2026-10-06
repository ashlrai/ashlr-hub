/** Typed question responses, loaded only when a question form is opened. */
import { LEADER_QUESTION_REVISION_RE, LEADER_THREAD_CHANNELS, type LeaderThreadChannel,
  type LeaderQuestionProjection, type LeaderQuestionSubmission, type SubmitLeaderQuestionResult } from './thread-types.js';
import { parseLeaderQuestionSubmission } from '../../../../core/vision/leader-question-submission.js';
import { narrowMessage, narrowQuestionForm } from './thread-model.js';
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function narrowQuestionProjection(raw: unknown): LeaderQuestionProjection | null {
  if (!isRecord(raw) || typeof raw['questionId'] !== 'string' || !raw['questionId'] || typeof raw['text'] !== 'string' ||
    typeof raw['askedAt'] !== 'string' || !Number.isFinite(Date.parse(raw['askedAt'])) ||
    (raw['messageId'] !== null && typeof raw['messageId'] !== 'string') || typeof raw['answered'] !== 'boolean') return null;
  const form = narrowQuestionForm(raw['questionForm']);
  // Thread metadata is a hint; an exact authoritative GET with a malformed form is held.
  if (raw['questionForm'] !== undefined && !form) return null;
  let answer: LeaderQuestionProjection['answer'] = null;
  const value = raw['answer'];
  if (value !== null) {
    if (!isRecord(value) || typeof value['text'] !== 'string' || typeof value['at'] !== 'string' ||
      !Number.isFinite(Date.parse(value['at'])) || !LEADER_THREAD_CHANNELS.includes(value['channel'] as LeaderThreadChannel) ||
      (value['messageId'] !== null && typeof value['messageId'] !== 'string')) return null;
    answer = { text: value['text'], at: value['at'], channel: value['channel'] as LeaderThreadChannel,
      messageId: value['messageId'] as string | null };
    const accepted = value['typedAcceptance'];
    if (isRecord(accepted) && accepted['schemaVersion'] === 1 && typeof accepted['formRevision'] === 'string' &&
      LEADER_QUESTION_REVISION_RE.test(accepted['formRevision']) && accepted['text'] === answer.text && accepted['at'] === answer.at &&
      accepted['messageId'] === answer.messageId) {
      const shape = accepted['kind'] === 'options'
        ? { schemaVersion: 1, formRevision: accepted['formRevision'], kind: 'options', optionIndices: accepted['optionIndices'] }
        : { schemaVersion: 1, formRevision: accepted['formRevision'], kind: accepted['kind'], text: accepted['text'] };
      const submission = parseLeaderQuestionSubmission(shape);
      const bound = submission && form && submission.formRevision === form.revision &&
        (submission.kind === 'text' ? form.mode === 'short-answer' : form.options && form.mode !== 'short-answer' &&
          (form.mode !== 'single' || submission.optionIndices.length === 1) &&
          submission.optionIndices.every((index, position) => index < form.options!.length &&
            (position === 0 || index > submission.optionIndices[position - 1]!)) &&
          submission.optionIndices.map(index => form.options![index]).join('; ') === answer.text);
      if (submission && bound) answer.typedAcceptance = { schemaVersion: 1, formRevision: submission.formRevision,
        kind: submission.kind, ...(submission.kind === 'options' ? { optionIndices: submission.optionIndices } : {}),
        text: answer.text, at: answer.at, messageId: answer.messageId };
    }
  }
  if (raw['answered'] !== (answer !== null)) return null;
  return { questionId: raw['questionId'], text: raw['text'], askedAt: raw['askedAt'],
    messageId: raw['messageId'] as string | null, answered: raw['answered'], answer, ...(form ? { questionForm: form } : {}) };
}

export function narrowQuestionSubmitResult(raw: unknown): SubmitLeaderQuestionResult | null {
  if (!isRecord(raw) || !['recorded', 'already-answered', 'stale', 'held'].includes(String(raw['outcome']))) return null;
  const question = raw['question'] === null ? null : narrowQuestionProjection(raw['question']);
  if (raw['question'] !== null && !question) return null;
  return { outcome: raw['outcome'] as SubmitLeaderQuestionResult['outcome'], question,
    message: narrowMessage(raw['message']), reply: narrowMessage(raw['reply']),
    ...(typeof raw['reason'] === 'string' ? { reason: raw['reason'] } : {}) };
}

/** answered=true alone never proves that this tab's uncertain request was accepted. */
export function matchesQuestionAcceptance(question: LeaderQuestionProjection, submitted: LeaderQuestionSubmission): boolean {
  const accepted = question.answer?.typedAcceptance;
  return !!accepted && accepted.formRevision === submitted.formRevision && accepted.kind === submitted.kind &&
    (submitted.kind === 'text' ? accepted.text === submitted.text.trim() :
      JSON.stringify(accepted.optionIndices) === JSON.stringify([...submitted.optionIndices].sort((a, b) => a - b)));
}
