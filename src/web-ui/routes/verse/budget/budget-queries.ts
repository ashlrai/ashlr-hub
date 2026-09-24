/**
 * routes/verse/budget/budget-queries.ts — the reads and the one write behind
 * the Budget panel (core/routing/budget-api.ts).
 *
 *   GET  /api/verse/budget          → BudgetView (policy + live headroom)
 *   GET  /api/verse/budget/preview  → SeatDecision for "the next medium
 *                                      autonomous code task"
 *   POST /api/verse/budget          → BudgetView after ONE change
 *
 * Nothing here spends: every route is a file read / pure computation on the
 * server. Writes pull the held mutation token (like verse-queries.ts), touch
 * the hold on success, and invalidate both keys so the headroom bars and the
 * "next task goes to…" line move together.
 */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { BudgetUpdateRequest, SeatDecision } from '../../../../core/routing/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const BUDGET_KEY = 'verse-budget';
export const BUDGET_PREVIEW_KEY = 'verse-budget-preview';
export const BUDGET_PATH = '/api/verse/budget';
export const BUDGET_PREVIEW_PATH = '/api/verse/budget/preview?task=code&difficulty=medium&autonomous=true';

export const budgetQuery: QueryDef<BudgetView> = {
  key: BUDGET_KEY,
  fetch: (signal) => apiGet<BudgetView>(BUDGET_PATH, signal),
};

export const budgetPreviewQuery: QueryDef<SeatDecision> = {
  key: BUDGET_PREVIEW_KEY,
  fetch: (signal) => apiGet<SeatDecision>(BUDGET_PREVIEW_PATH, signal),
};

/**
 * The per-seat patch as it goes on the wire. `null` clears an optional field
 * (the server's parser accepts it; the frozen contract's Partial<> cannot say
 * "remove" because JSON has no `undefined`).
 */
export interface BudgetSeatPatchWire {
  enabled?: boolean;
  reservePercent?: number;
  maxSessionWindowPercent?: number | null;
  dailyUsdCap?: number | null;
}

/** `BudgetUpdateRequest`, widened only by the `null`-clears rule above. */
export type BudgetUpdateWire = Extract<BudgetUpdateRequest, { mode: unknown }>
  | { seatId: string; policy: BudgetSeatPatchWire };

export async function updateBudget(update: BudgetUpdateWire): Promise<BudgetView> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const view = await apiPost<BudgetView>(BUDGET_PATH, update, token);
  touchMutationHold();
  invalidate(BUDGET_KEY);
  invalidate(BUDGET_PREVIEW_KEY);
  return view;
}
