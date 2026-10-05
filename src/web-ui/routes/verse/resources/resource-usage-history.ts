import { normalizeCodexCredits } from '../../../../core/resources/codex-credits.js';
import type { ResourceLastKnownUsage } from '../../../../core/resources/reading-cache-types.js';
import type { VerseSeat } from '../../../data/api-types.js';

function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Historical windows are a separate display value, never an input to live capacity. */
export function resourceUsageHistory(seat: VerseSeat, now: number): ResourceLastKnownUsage | null {
  const history = seat.lastKnownUsage;
  if (!history || history.source !== 'native-account-checked-history' ||
    !['native-account-checked', 'native-account-checked-local-epoch', 'native-account-checked-display-identity'].includes(history.identitySource) ||
    !instant(history.observedAt) || !instant(history.expiresAt) || Date.parse(history.observedAt) > now ||
    Date.parse(history.expiresAt) <= Date.parse(history.observedAt) ||
    Date.parse(history.expiresAt) - Date.parse(history.observedAt) > 60_000 || !Array.isArray(history.windows) ||
    !history.windows.length || !history.windows.every(window => !!window && typeof window === 'object' && !Array.isArray(window) &&
      typeof window.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(window.id) &&
      (window.usedPercent === null || typeof window.usedPercent === 'number' &&
      Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100) &&
      (window.resetsAt === null || instant(window.resetsAt)) &&
      (window.limitReached === undefined || window.limitReached === true && window.usedPercent === 100))) return null;
  return history;
}
/** A gray historical meter compares the recorded window readings, not current availability. */
export function historicalLeftPercent(history: ResourceLastKnownUsage): number | null {
  const values = history.windows.flatMap(window => window.limitReached ? [100] : window.usedPercent === null ? [] : [window.usedPercent]);
  return values.length ? 100 - Math.max(...values) : null;
}

/** Credit history remains independent of current quota windows and live availability. */
export function resourceCreditHistory(seat: VerseSeat, now: number) {
  const history = seat.engine === 'codex' ? seat.lastKnownUsage : null;
  const credit = history?.creditHistory;
  if (!history || history.source !== 'native-account-checked-history' ||
    !['native-account-checked', 'native-account-checked-local-epoch'].includes(history.identitySource) ||
    !credit || !instant(credit.observedAt) || !instant(credit.expiresAt) || Date.parse(credit.observedAt) > now ||
    Date.parse(credit.expiresAt) <= Date.parse(credit.observedAt) || Date.parse(credit.expiresAt) - Date.parse(credit.observedAt) > 60_000 ||
    !(credit.planType === null || typeof credit.planType === 'string' && credit.planType.length <= 128)) return null;
  const reading = normalizeCodexCredits(credit.reading);
  return reading === null ? null : { ...credit, reading };
}
