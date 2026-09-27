/**
 * routes/verse/leader/thread-types.ts — the Leader conversation contract, as
 * the web UI uses it. The contract itself is the server's
 * (core/vision/leader-thread-types.ts — browser-safe: types and constants,
 * no node: modules); this module re-exports it under the names the panel
 * uses and adds the two shapes that exist only on this side:
 *
 *   LeaderThreadPage   what a GET narrows to (thread-model narrowThreadPage)
 *   LeaderSendResult   a send / answer result after narrowing (a directive
 *                      the page cannot read is null, never guessed)
 *   DirectiveChip      the fields a directive chip draws
 *
 * Every `text` is untrusted: Leader text is model output, and Mason's own
 * text may have arrived over Telegram. It is rendered through the sanitising
 * MessageMarkdown renderer (Leader) or as plain text (Mason), never as HTML.
 */
import type { LeaderThreadChannel, LeaderThreadMessage, OperatorDirective } from '../../../../core/vision/leader-thread-types.js';

export type {
  AnswerLeaderQuestionResult,
  AppendMasonMessageResult,
  ApproveLeaderActionResult,
  LeaderApprovalOutcome,
  LeaderThreadChannel,
  LeaderThreadKind,
  LeaderThreadMessage,
  OperatorDirective,
} from '../../../../core/vision/leader-thread-types.js';
export {
  LEADER_QUESTION_ITEM_PREFIX,
  LEADER_THREAD_CHANNELS,
  LEADER_THREAD_KINDS,
  OPERATOR_DIRECTIVE_MAX,
  VERSE_LEADER_ACTIONS_PATH as LEADER_ACTIONS_PATH,
  VERSE_LEADER_DIRECTIVES_PATH as LEADER_DIRECTIVES_PATH,
  VERSE_LEADER_QUESTIONS_PATH as LEADER_QUESTIONS_PATH,
  VERSE_LEADER_THREAD_PATH as LEADER_THREAD_PATH,
} from '../../../../core/vision/leader-thread-types.js';

export interface LeaderThreadPage {
  messages: LeaderThreadMessage[];
}

/** A directive as a chip draws it (the server's record carries more). */
export type DirectiveChip = Pick<OperatorDirective, 'id' | 'text'> & {
  createdAt: string | null;
  channel: LeaderThreadChannel | null;
};

export interface LeaderSendResult {
  message: LeaderThreadMessage;
  /** The Leader's reply when it answered inline; null when it replies later. */
  reply: LeaderThreadMessage | null;
  /** Set when the message was read as a standing directive. */
  directive: DirectiveChip | null;
}
