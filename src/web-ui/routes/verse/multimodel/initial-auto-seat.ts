/** Initial chats use the same classifier/adviser as an existing Auto composer. */
import type { VerseSeat } from '../../../data/api-types.js';
import type { BudgetPolicy } from '../../../../core/routing/types.js';
import { adviseSeat } from '../../../../core/verse/multimodel/advisor.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import type { PromptLabelRequest, PromptLabelResponse, SeatAdviceOption } from '../../../../core/verse/multimodel/types.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { multimodelContextQuery } from './multimodel-queries.js';
import { toAdvisorSeats } from './useAutoSeat.js';

export async function initialAutoSeat(input: {
  text: string;
  roots: readonly string[];
  seats: readonly VerseSeat[];
  signal: AbortSignal;
  label(request: PromptLabelRequest): Promise<PromptLabelResponse | null>;
}): Promise<SeatAdviceOption | null> {
  if (input.roots.length === 0) throw new Error('Choose a project first.');
  // No session exists yet. Check every root in parallel, including extras and
  // saved workspaces, before any prompt can reach Jev or a hosted agent.
  const [contexts, budget] = await Promise.all([
    Promise.all(input.roots.map((projectPath) => multimodelContextQuery({ projectPath }).fetch(input.signal))),
    budgetQuery.fetch(input.signal).catch(() => null),
  ]);
  input.signal.throwIfAborted();
  const localOnly = contexts.find((context) => context.localOnly.on)?.localOnly ?? { on: false, reason: null };
  let classification = classifyPrompt(input.text, { contextTokens: 0 });
  if (!localOnly.on) {
    try {
      const labelled = await input.label({ text: input.text, projectPath: input.roots[0], contextTokens: 0 });
      if (labelled === null) return null; // Unlock dismissed: do not start a chat.
      classification = labelled.classification;
    } catch {
      // Jev is an adviser. Offline labelling still uses the same deterministic rules.
    }
  }
  input.signal.throwIfAborted();
  const policy: BudgetPolicy = budget
    ? { mode: budget.mode, seats: budget.seats, updatedAt: budget.updatedAt }
    : { mode: 'balanced', seats: {}, updatedAt: new Date(0).toISOString() };
  const primary = contexts[0]!;
  const advice = adviseSeat({
    classification, seats: toAdvisorSeats(input.seats, primary.local), policy,
    mode: 'auto', nowMs: Date.now(), currentSeatId: null, turnCount: 0, contextTokens: 0,
    localOnly, learned: primary.learned, roi: primary.roi, pinnedSeatId: null,
  });
  if (!advice.choice) throw new Error(advice.why || 'No connected resource can run this message.');
  return advice.choice;
}
