/**
 * routes/verse/leader/question-id.ts — from a Needs-you Leader question to
 * the thread's question. Pure and tiny: the Needs-you drawer imports it.
 *
 *   item id     `leader:leader-question:<memoId>:<index>`
 *   questionId  `<memoId>:<index>` — the item id minus its prefix, exactly
 *               (core/vision/leader-thread-types.ts LEADER_QUESTION_ITEM_PREFIX)
 *   title       `Leader question: <question>` (clipped); `detail` carries the
 *               whole question when the title had to be clipped
 */
import { LEADER_QUESTION_ITEM_PREFIX } from './thread-types.js';

/** The thread questionId a Needs-you row is about; null for any other row. */
export function questionIdOfNeedsYouItem(itemId: string): string | null {
  if (!itemId.startsWith(LEADER_QUESTION_ITEM_PREFIX)) return null;
  const questionId = itemId.slice(LEADER_QUESTION_ITEM_PREFIX.length);
  return /^.+:\d+$/.test(questionId) ? questionId : null;
}

/** The question's own words from a Needs-you row: the full detail when present, else the title without its prefix. */
export function needsYouQuestionText(item: { title: string; detail: string | null }): string {
  return (item.detail ?? item.title.replace(/^Leader question:\s*/, '')).trim();
}
