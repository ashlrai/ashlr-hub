import type { BudgetView } from '../../../../core/routing/policy.js';
import { apiGet } from '../../../data/client.js';
import { BUDGET_PATH, updateBudget } from './budget-queries.js';
import { readResetSpendingAccount, readResetSpendingStatus } from './reset-spending-model.js';
import { getAuthSnapshot, getMutationToken, subscribeAuth } from '../../../data/auth-store.js';

/** A successful POST is a write acknowledgement; confirm the exact intent from a fresh GET. */
export async function updateResetSpending(update: { resetSpending: { enabled: boolean } }
  | { seatId: string; policy: { resetSpending: boolean | null } }, isCurrent: () => boolean = () => true): Promise<BudgetView> {
  const token = getMutationToken();
  const phase = getAuthSnapshot().phase;
  let lost = false;
  const unsubscribe = subscribeAuth(() => { if (getMutationToken() !== token || getAuthSnapshot().phase !== phase) lost = true; });
  const check = () => {
    if (lost || !isCurrent()) throw new Error('Confirmation interrupted. Refresh and review the saved setting before trying again.');
  };
  try {
    check();
    await updateBudget(update);
    check();
    let view: BudgetView;
    try { view = await apiGet<BudgetView>(BUDGET_PATH); }
    catch { throw new Error('Change sent; saved state could not be confirmed. Refresh before trying again.'); }
    check();
    const status = readResetSpendingStatus(view);
    const account = 'seatId' in update ? readResetSpendingAccount(status, update.seatId) : null;
    const confirmed = 'seatId' in update
      ? update.policy.resetSpending === null
        ? view.seats?.[update.seatId]?.resetSpending === undefined && account?.mode === 'inherit'
        : view.seats?.[update.seatId]?.resetSpending === update.policy.resetSpending && account?.mode === (update.policy.resetSpending ? 'enabled' : 'disabled')
      : view.resetSpending?.enabled === update.resetSpending.enabled && status?.mode === (update.resetSpending.enabled ? 'enabled' : 'disabled');
    if (!confirmed) throw new Error('Change sent; the fresh reading does not confirm it. Refresh and review the saved setting.');
    return view;
  } finally { unsubscribe(); }
}
