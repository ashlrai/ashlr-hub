/**
 * routes/verse/leader/question-id.ts — reading a Needs-you Leader question
 * (core/verse/leader-api.ts buildLeaderNeedsYou) into what the conversation
 * needs to find it. Pure and tiny: the Needs-you drawer imports it.
 *
 *   id     `leader:leader-question:<memoId>:<index>`
 *   title  `Leader question: <question>` (clipped); `detail` carries the
 *          whole question when the title had to be clipped
 */

export interface NeedsYouQuestionRef {
  memoId: string;
  index: number;
}

/** The memo and question index a Needs-you row names; null for any other row. */
export function parseNeedsYouQuestion(itemId: string): NeedsYouQuestionRef | null {
  const m = /^leader:leader-question:(.+):(\d+)$/.exec(itemId);
  return m ? { memoId: m[1]!, index: Number(m[2]) } : null;
}

/** The question's own words from a Needs-you row: the full detail when present, else the title without its prefix. */
export function needsYouQuestionText(item: { title: string; detail: string | null }): string {
  return (item.detail ?? item.title.replace(/^Leader question:\s*/, '')).trim();
}
