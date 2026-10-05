/** Pure native-boundary validation, independent of authority and budget storage. */
import { HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import type { SubscriptionOnlyBoundary } from './reset-spending-types.js';
const HASH = /^[a-f0-9]{64}$/;
/** Strict optional metadata: missing/falsy values never become an execution capability. */
export function validSubscriptionOnlyBoundary(value: unknown): value is SubscriptionOnlyBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 5 || !['source', 'accountHint', 'observedAt', 'expiresAt', 'creditsEnabled'].every(k =>
    Object.hasOwn(v, k) && 'value' in Object.getOwnPropertyDescriptor(v, k)!)) return false;
  return ['claude-native-extra-usage', 'codex-siwc-app-credit-control'].includes(String(v.source)) &&
    typeof v.accountHint === 'string' && HASH.test(v.accountHint) && v.creditsEnabled === false &&
    typeof v.observedAt === 'string' && typeof v.expiresAt === 'string' &&
    Number.isFinite(Date.parse(v.observedAt)) && new Date(v.observedAt).toISOString() === v.observedAt &&
    Number.isFinite(Date.parse(v.expiresAt)) && new Date(v.expiresAt).toISOString() === v.expiresAt &&
    Date.parse(v.expiresAt) > Date.parse(v.observedAt) &&
    Date.parse(v.expiresAt) - Date.parse(v.observedAt) <= HEADROOM_READING_MAX_AGE_MS;
}
export function subscriptionOnlyCurrent(seat: SeatCapacity, nowMs: number): boolean {
  const boundary = seat.subscriptionOnlyBoundary;
  return validSubscriptionOnlyBoundary(boundary) && typeof seat.accountHint === 'string' && HASH.test(seat.accountHint) &&
    boundary.accountHint === seat.accountHint && boundary.observedAt === seat.observedAt &&
    Date.parse(boundary.observedAt) <= nowMs && Date.parse(boundary.expiresAt) > nowMs &&
    (seat.engine === 'claude' && boundary.source === 'claude-native-extra-usage' ||
      seat.engine === 'codex' && boundary.source === 'codex-siwc-app-credit-control');
}
