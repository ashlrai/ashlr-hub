/** Defensive projection: an older server is unavailable, never an enabled policy. */
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { ResetSpendingAccountStatus, ResetSpendingStatus } from '../../../../core/routing/reset-spending-types.js';

const MODES = ['legacy-priority', 'enabled', 'disabled'];
const STATES = ['disabled', 'legacy-priority', 'authority-paused', 'account-disabled', 'producer-not-granted',
  'signed-floor', 'unqualified', 'overage-unverified', 'execution-unbound', 'waiting-for-estimate', 'cannot-fit', 'held', 'ordinary', 'ready'];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

export function readResetSpendingStatus(view: BudgetView | null): ResetSpendingStatus | null {
  const value: unknown = view?.resetSpendingStatus;
  if (!object(value) || !MODES.includes(String(value.mode)) || typeof value.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.checkedAt)) || !['active', 'paused', 'unknown'].includes(String(value.authorityState)) ||
    !object(value.accounts)) return null;
  return value as unknown as ResetSpendingStatus;
}

export function readResetSpendingAccount(status: ResetSpendingStatus | null, seatId: string): ResetSpendingAccountStatus | null {
  const value: unknown = status?.accounts[seatId];
  if (!object(value) || !['inherit', 'enabled', 'disabled'].includes(String(value.mode)) ||
    typeof value.enabled !== 'boolean' || !percent(value.savedReservePercent) ||
    !(value.signedFloorPercent === null || percent(value.signedFloorPercent)) ||
    !(value.effectiveReservePercent === null || percent(value.effectiveReservePercent)) ||
    !STATES.includes(String(value.state)) || typeof value.reason !== 'string' ||
    !Array.isArray(value.constraints) || !value.constraints.every(item => typeof item === 'string') ||
    !['verified', 'unsupported', 'unknown'].includes(String(value.subscriptionOnly)) ||
    !(value.deadline === null || typeof value.deadline === 'string' && Number.isFinite(Date.parse(value.deadline)))) return null;
  if (value.forecastBasis !== null && (!object(value.forecastBasis) || typeof value.forecastBasis.taskId !== 'string' ||
    typeof value.forecastBasis.p75Ms !== 'number' || !Number.isFinite(value.forecastBasis.p75Ms) || value.forecastBasis.p75Ms <= 0 ||
    typeof value.forecastBasis.samples !== 'number' || !Number.isSafeInteger(value.forecastBasis.samples) || value.forecastBasis.samples < 1 ||
    typeof value.forecastBasis.pooled !== 'boolean' || typeof value.forecastBasis.engine !== 'string' || !value.forecastBasis.engine ||
    typeof value.forecastBasis.model !== 'string' || !value.forecastBasis.model ||
    typeof value.forecastBasis.taskKind !== 'string' || !value.forecastBasis.taskKind ||
    !(value.forecastBasis.seatId === null || value.forecastBasis.seatId === seatId))) return null;
  return value as unknown as ResetSpendingAccountStatus;
}

export function resetStatusFresh(status: ResetSpendingStatus, view: BudgetView | null, nowMs: number): boolean {
  const age = nowMs - Date.parse(status.checkedAt);
  const maxAge = view?.readingMaxAgeMs;
  return typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge > 0 && age >= 0 && age <= maxAge;
}

/** Config changes can share the same cached capacity timestamp. Prefer policy
 * revision time, then projection time; do not pin a local ON until quota moves. */
export function latestResetBudgetView(confirmed: BudgetView | null, incoming: BudgetView | null): BudgetView | null {
  if (!confirmed) return incoming;
  if (!incoming) return null;
  for (const [left, right] of [[confirmed.updatedAt, incoming.updatedAt],
    [confirmed.resetSpendingStatus?.checkedAt, incoming.resetSpendingStatus?.checkedAt],
    [confirmed.sampledAt, incoming.sampledAt]]) {
    const previous = typeof left === 'string' ? Date.parse(left) : NaN;
    const current = typeof right === 'string' ? Date.parse(right) : NaN;
    if (Number.isFinite(previous) && Number.isFinite(current) && previous !== current) return previous > current ? confirmed : incoming;
  }
  return incoming;
}

export const RESET_STATE_LABELS: Readonly<Record<ResetSpendingAccountStatus['state'], string>> = {
  disabled: 'Off', 'legacy-priority': 'Routing preference only', 'authority-paused': 'Authority paused',
  'account-disabled': 'Account disabled', 'producer-not-granted': 'Producer role not granted',
  'signed-floor': 'Reserve held by grant', unqualified: 'Reset unconfirmed',
  'overage-unverified': 'Credit protection unconfirmed', 'execution-unbound': 'Execution account unconfirmed', 'waiting-for-estimate': 'Waiting for task fit',
  'cannot-fit': 'Work exceeds remaining time', held: 'Usage constraint holds', ordinary: 'Saved reserve applies', ready: 'Task reserve released',
};
