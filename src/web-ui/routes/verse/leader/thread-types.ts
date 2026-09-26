/**
 * routes/verse/leader/thread-types.ts — the web side of the Leader
 * conversation contract (Mason ⇄ Leader, in Verse, Telegram and the CLI).
 *
 *   GET    /api/verse/leader/thread?limit=&before=      → { messages }
 *   POST   /api/verse/leader/thread { text, replyTo? }  → { message, reply, directive? }
 *   POST   /api/verse/leader/questions/<id>/answer { text } → { message, reply }
 *   POST   /api/verse/leader/actions/<id>/approve       → { ok, result }
 *   GET    /api/verse/leader/directives                 → { directives }
 *   POST   /api/verse/leader/directives { text }        → { directive }
 *   DELETE /api/verse/leader/directives/<id>            → { ok }
 *
 * WHY A LOCAL MIRROR: the server half lands in parallel (another unit owns
 * src/core/**), so the page is written against this contract and narrows
 * every body it reads (thread-model.ts) rather than trusting a shape. When
 * the server's types land, these can become `import type` re-exports.
 *
 * Every `text` is untrusted: Leader text is model output, and Mason's own
 * text may have arrived over Telegram. It is rendered through the sanitising
 * MessageMarkdown renderer (Leader) or as plain text (Mason), never as HTML.
 *
 * BROWSER-SAFE: types and constants only.
 */

export const LEADER_THREAD_PATH = '/api/verse/leader/thread';
export const LEADER_QUESTIONS_PATH = '/api/verse/leader/questions';
export const LEADER_ACTIONS_PATH = '/api/verse/leader/actions';
export const LEADER_DIRECTIVES_PATH = '/api/verse/leader/directives';

export type LeaderThreadFrom = 'mason' | 'leader';
export type LeaderThreadChannel = 'verse' | 'telegram' | 'cli' | 'system';
export type LeaderThreadKind = 'message' | 'question' | 'answer' | 'memo' | 'directive' | 'update' | 'action';

export const LEADER_THREAD_CHANNELS: readonly LeaderThreadChannel[] = ['verse', 'telegram', 'cli', 'system'];
export const LEADER_THREAD_KINDS: readonly LeaderThreadKind[] = ['message', 'question', 'answer', 'memo', 'directive', 'update', 'action'];

export interface LeaderThreadMessage {
  id: string;
  /** ISO time. */
  at: string;
  from: LeaderThreadFrom;
  channel: LeaderThreadChannel;
  kind: LeaderThreadKind;
  text: string;
  /** The message this one answers. */
  replyTo?: string | null;
  /** A memo message's memo (LeaderMemo.id). */
  memoId?: string | null;
  /** A question (or an answer to one). */
  questionId?: string | null;
  /** The actions a memo or action message is about (LeaderAction.id). */
  actionIds?: string[] | null;
  /**
   * Where a message was delivered besides Verse, channel → state
   * ("sent" | "failed" | "pending"). Read loosely: an unknown shape is ignored.
   */
  delivery?: Record<string, string> | null;
}

/** A standing instruction from Mason that the Leader must follow until retired. */
export interface OperatorDirective {
  id: string;
  text: string;
  /** ISO time it was added (the server may call it `at` or `addedAt`). */
  at: string | null;
  /** Where it came from (Verse, Telegram, the CLI). */
  channel: LeaderThreadChannel | null;
}

export interface LeaderThreadPage {
  messages: LeaderThreadMessage[];
}

export interface LeaderSendResult {
  message: LeaderThreadMessage;
  /** The Leader's reply when it answered inline; null when it replies later. */
  reply: LeaderThreadMessage | null;
  /** Set when the message was read as a standing directive. */
  directive: OperatorDirective | null;
}
