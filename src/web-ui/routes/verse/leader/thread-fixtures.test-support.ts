/**
 * routes/verse/leader/thread-fixtures.test-support.ts — a Leader thread in
 * the contract's shape, tied to command/fixtures.test-support.ts leaderState
 * ('live'): memo-0924 with actions a1 (A, applied), a2 (B, scheduled),
 * a3 (A, applied) and a4 (C, escalated), and its one question.
 */
import type { LeaderThreadMessage, OperatorDirective } from './thread-types.js';

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

export const QUESTION_TEXT = 'Should measurably stay at local enforcement, or move to propose-only until it has CI?';

export function msg(over: Partial<LeaderThreadMessage> & Pick<LeaderThreadMessage, 'id'>): LeaderThreadMessage {
  return { at: iso(Date.now()), from: 'leader', channel: 'verse', kind: 'message', text: 'Hello.', ...over };
}

/** The live thread, oldest first. */
export function threadMessages(now = Date.now()): LeaderThreadMessage[] {
  return [
    msg({ id: 't1', at: iso(now - 60 * MIN), from: 'mason', channel: 'telegram', text: 'What is slowing merges this week?' }),
    msg({ id: 't2', at: iso(now - 58 * MIN), from: 'leader', channel: 'telegram', text: 'The **judge queue** on grok-a. I will write a memo.' }),
    msg({ id: 't3', at: iso(now - 50 * MIN), kind: 'memo', memoId: 'memo-0924', actionIds: ['a1', 'a2', 'a3', 'a4'], text: 'Memo: raise Grok to 3 lanes.' }),
    msg({ id: 't4', at: iso(now - 49 * MIN), kind: 'question', memoId: 'memo-0924', questionId: 'q-memo-0924-0', text: QUESTION_TEXT }),
    msg({ id: 't5', at: iso(now - 30 * MIN), from: 'mason', kind: 'directive', text: 'No spend raises overnight.' }),
    msg({ id: 't6', at: iso(now - 29 * MIN), channel: 'system', kind: 'update', text: 'Telegram connected.' }),
    msg({ id: 't7', at: iso(now - 20 * MIN), from: 'mason', channel: 'cli', text: 'Status?', delivery: { telegram: 'sent' } }),
    msg({ id: 't8', at: iso(now - 19 * MIN), from: 'leader', channel: 'cli', kind: 'update', text: 'Grok lanes apply in 18 minutes unless you veto.' }),
  ];
}

export function directives(now = Date.now()): OperatorDirective[] {
  return [
    { id: 'd1', text: 'Ship binshield before new goals', at: iso(now - 2 * 86_400_000), channel: 'verse' },
    { id: 'd2', text: 'No spend raises overnight', at: iso(now - 30 * MIN), channel: 'telegram' },
  ];
}
