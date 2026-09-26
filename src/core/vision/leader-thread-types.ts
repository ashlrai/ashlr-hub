/**
 * The Leader thread contract (3.14): types and route constants for the one
 * conversation between Mason and the Leader. The server core lives in
 * leader-thread.ts / leader-operator.ts. The Verse UI and the Telegram
 * transport import THIS module, which is why it holds nothing else.
 *
 *   GET    /api/verse/leader/thread?limit=&before=           → { messages } (oldest first;
 *                                                               before = a message id, or an ISO time)
 *   POST   /api/verse/leader/thread { text, replyTo? }        → AppendMasonMessageResult
 *   POST   /api/verse/leader/questions/<questionId>/answer { text } → AnswerLeaderQuestionResult
 *   POST   /api/verse/leader/actions/<actionId>/approve {}    → ApproveLeaderActionResult
 *   GET    /api/verse/leader/directives                       → { directives, retired }
 *   POST   /api/verse/leader/directives { text, kind? }       → { directive, duplicate }
 *   DELETE /api/verse/leader/directives/<id>                  → { directive } (now retired)
 *
 * questionId = `<memoId>:<index>` — the tail of the Needs-you item id
 * `leader:leader-question:<memoId>:<index>`, so the two match exactly.
 *
 * BROWSER-SAFE: type-only imports and plain constants, no node: modules.
 */
import type { LeaderAction } from './leader-types.js';

export const VERSE_LEADER_THREAD_PATH = '/api/verse/leader/thread';
export const VERSE_LEADER_QUESTIONS_PATH = '/api/verse/leader/questions';
export const VERSE_LEADER_ACTIONS_PATH = '/api/verse/leader/actions';
export const VERSE_LEADER_DIRECTIVES_PATH = '/api/verse/leader/directives';
/** Needs-you item id prefix for a Leader question; the rest of the id IS the questionId. */
export const LEADER_QUESTION_ITEM_PREFIX = 'leader:leader-question:';

export type LeaderThreadChannel = 'verse' | 'telegram' | 'cli' | 'system';
export type LeaderThreadKind = 'message' | 'question' | 'answer' | 'memo' | 'directive' | 'update' | 'action';

export const LEADER_THREAD_CHANNELS: readonly LeaderThreadChannel[] = ['verse', 'telegram', 'cli', 'system'];
export const LEADER_THREAD_KINDS: readonly LeaderThreadKind[] = ['message', 'question', 'answer', 'memo', 'directive', 'update', 'action'];

export type LeaderThreadMessage = {
  /** `lt-<yyyymmddhhmmss>-<6 hex>` */
  id: string;
  at: string;
  from: 'mason' | 'leader';
  channel: LeaderThreadChannel;
  kind: LeaderThreadKind;
  /** Scrubbed plain text — untrusted (model output, or text that came over Telegram). */
  text: string;
  replyTo?: string;
  memoId?: string;
  /** `<memoId>:<index>` */
  questionId?: string;
  actionIds?: string[];
  delivery?: { telegram?: 'pending' | 'sent' | 'failed'; sentAt?: string };
};

export type OperatorDirectiveKind = 'focus' | 'stop' | 'priority' | 'guidance';
export type OperatorChannel = LeaderThreadChannel;

/** A standing instruction from Mason that every memo run honours until retired. */
export interface OperatorDirective {
  v: 1;
  /** `od-<yyyymmddhhmmss>-<6 hex>` */
  id: string;
  kind: OperatorDirectiveKind;
  /** Mason's words (scrubbed). */
  text: string;
  /**
   * explicit  — a `directive:` / `focus:` / `stop:` / `priority:` prefix in a message;
   * extracted — recognised in Mason's message by a call that saw ONLY that message;
   * direct    — added through the directives route / CLI.
   */
  source: 'explicit' | 'extracted' | 'direct';
  channel: OperatorChannel;
  /** The thread message it came from; null when added directly. */
  messageId: string | null;
  createdAt: string;
  /** null = in force. */
  retiredAt: string | null;
  retiredVia: OperatorChannel | null;
}

export interface AppendMasonMessageResult {
  message: LeaderThreadMessage;
  reply: LeaderThreadMessage | null;
  directive?: OperatorDirective;
}

export interface AnswerLeaderQuestionResult {
  message: LeaderThreadMessage;
  reply: LeaderThreadMessage | null;
}

/**
 * - `applied`                — a class-B action applied now (still vetoable);
 * - `recorded-dry-run`       — dry run: approval recorded, nothing applied;
 * - `recorded-outside-grant` — class C: approval recorded, nothing applied;
 * - `refused`                — the authority checks said no now; it stays scheduled;
 * - `not-pending`            — already applied / vetoed / refused, or mid-apply.
 */
export type LeaderApprovalOutcome = 'applied' | 'recorded-dry-run' | 'recorded-outside-grant' | 'refused' | 'not-pending';

export interface ApproveLeaderActionResult {
  ok: boolean;
  /** Also the HTTP status: 200, 404 unknown action, 409 nothing to approve / refused now. */
  code: 200 | 404 | 409;
  outcome: LeaderApprovalOutcome | null;
  message: string;
  action: LeaderAction | null;
  /** Mason's approval and the Leader's acknowledgement, as thread messages (null for an unknown action). */
  thread: { message: LeaderThreadMessage; reply: LeaderThreadMessage } | null;
}
