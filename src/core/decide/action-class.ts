/**
 * decide/action-class.ts — a SANITY CHECK on the Leader's A/B/C action class.
 *
 *   suggestActionClass(action, deterministicClass) → Decision<'A' | 'B' | 'C'>
 *
 * The authority class is and stays deterministic: `classifyLeaderAction` in
 * vision/leader-apply.ts decides A (apply), B (veto window) or C (escalate to
 * Mason), and nothing here changes what the Leader is allowed to do.
 *
 * What Jev adds is a second opinion that can only point toward MORE caution:
 * the suggestion is escalate-only (A < B < C), so Jev can flag "this A looks
 * like it deserves a veto window" but can never suggest loosening a B or C.
 * A caller that wants to act on a stricter suggestion may tighten — never
 * loosen — and must record that it did.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { ACTION_CLASSES } from './registry.js';
import type { DecideOptions, Decision } from './types.js';

export type ActionClass = (typeof ACTION_CLASSES)[number];

export interface ActionForReview {
  /** e.g. 'work.dispatch', 'budget.mode', 'pr.close'. */
  readonly kind: string;
  readonly summary: string;
  readonly detail?: string | null;
  readonly repo?: string | null;
}

export interface ActionClassAdvice {
  readonly deterministic: ActionClass;
  readonly suggested: ActionClass;
  /** Jev confidently thinks this deserves a stricter class. */
  readonly stricter: boolean;
  readonly decision: Decision<ActionClass>;
}

export type SuggestActionClassOptions = Omit<DecideOptions<ActionClass>, 'fallback' | 'interpret' | 'escalateOnly'>;

const RANK: Readonly<Record<ActionClass, number>> = { A: 0, B: 1, C: 2 };

export function isActionClass(value: unknown): value is ActionClass {
  return value === 'A' || value === 'B' || value === 'C';
}

const QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions:
    'An autonomous engineering "Leader" proposes this action. How much operator oversight does it deserve? '
    + 'Judge reversibility, blast radius and spend, not how useful it is.',
  criteria: {
    A: 'Routine and easily reversible, low blast radius, no new spend: safe to apply automatically.',
    B: 'Meaningful but reversible: raises spend, changes what work runs, or affects shared state; the operator should get a window to veto.',
    C: 'High-stakes, hard to reverse, outside normal authority, or ambiguous: must be escalated for an explicit operator decision.',
  },
};

/**
 * Second opinion on one Leader action. NEVER THROWS. With no key, or a
 * less-strict answer, `value === deterministicClass` and `path === 'fallback'`.
 *
 * STABLE API — the Leader calls this through vision/leader-advice.ts, after
 * its actions were enacted (advisory only: a memo label, never a gate).
 */
export async function suggestActionClass(
  action: ActionForReview,
  deterministicClass: ActionClass,
  opts: SuggestActionClassOptions = {},
): Promise<ActionClassAdvice> {
  const lines = [`Action kind: ${action.kind}`, `Summary: ${action.summary}`];
  if (action.repo) lines.push(`Repository: ${action.repo}`);
  if (action.detail) lines.push(`Detail: ${action.detail.slice(0, 2_000)}`);
  // Already the strictest class: no stricter suggestion exists, so no call.
  const state = deterministicClass === 'C' ? '' : lines.join('\n');
  const decision = await decide<ActionClass>('action-class', state, { action_class: QUESTION }, {
    ...opts,
    fallback: deterministicClass,
    escalateOnly: (v) => RANK[v],
  });
  const suggested = isActionClass(decision.value) ? decision.value : deterministicClass;
  return {
    deterministic: deterministicClass,
    suggested,
    stricter: decision.path === 'jev' && RANK[suggested] > RANK[deterministicClass],
    decision,
  };
}
