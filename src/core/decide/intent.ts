/**
 * decide/intent.ts — what does Mason's message MEAN?
 *
 *   classifyOperatorIntent(text, context) →
 *     status-request | directive | answer | approval | veto | task-request | chit-chat
 *
 * For the Leader / Telegram path: route an inbound operator message to the
 * right handler without a brittle regex ladder.
 *
 * SAFETY. This is ROUTING, not AUTHORIZATION. An `approval` label must never
 * by itself authorize anything — approvals are still the signed button taps
 * and numbered answers handled in comms. On top of that, `approval` is the one
 * label Jev can never introduce: it is accepted only when the deterministic
 * reading already says `approval` (escalate-only toward caution). Jev may
 * freely turn an apparent approval into a veto, a question, or chit-chat.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { OPERATOR_INTENTS } from './registry.js';
import type { DecideOptions, Decision } from './types.js';

export type OperatorIntent = (typeof OPERATOR_INTENTS)[number];

export interface OperatorIntentContext {
  /** Text of an outstanding question Mason may be answering. */
  readonly pendingQuestion?: string | null;
  /** True when something is waiting on Mason's approve/veto right now. */
  readonly pendingApproval?: boolean;
  /** The last thing the bot/Leader said to Mason (short). */
  readonly lastBotMessage?: string | null;
  /** True when the message is a reply to a specific bot message. */
  readonly isReply?: boolean;
  readonly channel?: 'telegram' | 'verse' | 'cli';
}

export type ClassifyOperatorIntentOptions = Omit<DecideOptions<OperatorIntent>, 'fallback' | 'interpret' | 'escalateOnly'>;

// ---------------------------------------------------------------------------
// Deterministic reading
// ---------------------------------------------------------------------------

const EXPLICIT_DIRECTIVE = /^\s*(directive|focus|stop|priority)\s*:\s*\S/i;
const DIRECTIVE_WORDS = /\b(focus on|stop (?:working|doing)|quit|don'?t|do not|never|always|priorit\w*|deprioriti\w*|from now on|going forward|double down|no more|only work|pause work)\b/i;
const VETO = /^\s*(no\b|nope\b|veto\b|stop\b|cancel\b|abort\b|don'?t\b|do not\b|reject\b|revert\b|kill it\b|nah\b|👎)/i;
const APPROVAL = /^\s*(yes|yep|yeah|approve[ds]?|approved|lgtm|ship it|go ahead|go for it|do it|ok(?:ay)?|sure|sounds good|👍|✅)\b[\s.!]*$/i;
const APPROVAL_LEAD = /^\s*(yes|yep|approve[ds]?|lgtm|ship it|go ahead|do it)\b/i;
const NUMERIC_ANSWER = /^\s*\d{1,3}\s*[.)]?\s*$/;
const STATUS = /\b(status|what'?s (?:up|happening|going on|new)|how(?:'s| is| are) (?:it|things|the fleet|we) ?(?:going|doing)?|progress|any (?:news|updates?)|update me|where are we|what did (?:you|the fleet) (?:do|ship|merge))\b/i;
const TASK = /^\s*(?:please\s+|pls\s+|can you\s+|could you\s+|would you\s+)?(fix|add|implement|build|create|write|make|refactor|investigate|look into|open a pr|ship|migrate|upgrade|remove|delete|rename|test|debug)\b/i;
const CHIT = /^\s*(thanks|thank you|thx|ty|hi|hey|hello|gm|good (?:morning|night)|lol|haha|nice|cool|great|awesome)\b/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Pure, offline, never throws. The answer whenever Jev is not used. */
export function classifyOperatorIntentHeuristic(text: unknown, context: OperatorIntentContext = {}): OperatorIntent {
  if (typeof text !== 'string' || text.trim() === '') return 'chit-chat';
  const t = text.trim();
  const short = wordCount(t) <= 6;

  if (EXPLICIT_DIRECTIVE.test(t)) return 'directive';
  if (context.pendingQuestion && NUMERIC_ANSWER.test(t)) return 'answer';
  if ((context.pendingApproval || context.isReply) && short && VETO.test(t)) return 'veto';
  if (context.pendingApproval && (APPROVAL.test(t) || (short && APPROVAL_LEAD.test(t)))) return 'approval';
  if (context.pendingQuestion && short) return 'answer';
  if (/^\s*\/(status|snapshot)\b/i.test(t) || STATUS.test(t)) return 'status-request';
  if (TASK.test(t)) return 'task-request';
  if (!t.endsWith('?') && DIRECTIVE_WORDS.test(t)) return 'directive';
  if (context.pendingQuestion) return 'answer';
  if (CHIT.test(t) && short) return 'chit-chat';
  if (t.endsWith('?')) return 'status-request';
  return short ? 'chit-chat' : 'task-request';
}

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

const CRITERIA: Readonly<Record<OperatorIntent, string>> = {
  'status-request': 'Asks what is happening: fleet status, progress, what shipped, how something is going. Wants information, not action.',
  directive: 'Sets standing guidance or priorities for the autonomous system: focus on X, stop doing Y, always/never Z, from now on.',
  answer: 'Replies to the pending question the assistant asked (a choice, a number, a short factual reply).',
  approval: 'Explicitly approves the specific pending action that is waiting on the operator (yes / approve / go ahead / ship it).',
  veto: 'Rejects, cancels, or blocks the pending or most recent action (no / stop that / veto / revert it).',
  'task-request': 'Asks for a concrete new piece of engineering work to be done (fix, build, add, investigate something specific).',
  'chit-chat': 'Social or acknowledgement text with no request: thanks, greetings, reactions.',
};

function buildState(text: string, context: OperatorIntentContext): string {
  const lines = [`Operator message: ${text.trim()}`];
  if (context.pendingApproval) lines.push('Context: an action is currently waiting for the operator to approve or veto.');
  if (context.pendingQuestion) lines.push(`Context: the assistant's pending question: ${context.pendingQuestion.slice(0, 400)}`);
  if (context.lastBotMessage) lines.push(`Context: the assistant last said: ${context.lastBotMessage.slice(0, 400)}`);
  if (context.isReply) lines.push('Context: the message is a direct reply to an assistant message.');
  return lines.join('\n');
}

/** Rank: `approval` is the least cautious reading; everything else is at least as cautious. */
function cautionRank(intent: OperatorIntent): number {
  return intent === 'approval' ? 0 : 1;
}

/**
 * Classify one operator message. NEVER THROWS; returns the deterministic
 * reading with `path: 'fallback'` whenever Jev is unkeyed, off, slow, or unsure.
 *
 * STABLE API — the Leader / Telegram agent calls this.
 */
export async function classifyOperatorIntent(
  text: string,
  context: OperatorIntentContext = {},
  opts: ClassifyOperatorIntentOptions = {},
): Promise<Decision<OperatorIntent>> {
  const safeText = typeof text === 'string' ? text.slice(0, 2_000) : '';
  const question: TypeSafeChoiceQuestion = {
    type: 'choice',
    instructions:
      'Classify the intent of the operator message sent to an autonomous engineering system. '
      + 'Use the context lines only to understand what the message refers to. An approval requires an explicit yes to a pending action.',
    criteria: CRITERIA,
  };
  const state = safeText.trim() === '' ? '' : buildState(safeText, context);
  return decide<OperatorIntent>('operator-intent', state, { intent: question }, {
    ...opts,
    fallback: () => classifyOperatorIntentHeuristic(safeText, context),
    escalateOnly: cautionRank,
  });
}

