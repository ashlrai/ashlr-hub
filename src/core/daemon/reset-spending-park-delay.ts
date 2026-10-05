/**
 * Shorten an existing abortable resident park to its next qualified boundary.
 * The caller owns current policy/authority checks and re-evaluates work on wake;
 * this helper neither schedules work nor changes the ordinary sleep cadence.
 */
export function resetSpendingParkDelay(
  requestedMs: number,
  nextWakeAtMs: number | null,
  nowMs: number,
  enabled: boolean,
): number {
  if (!Number.isFinite(requestedMs) || requestedMs < 0) {
    throw new RangeError('Resident park duration must be finite and nonnegative');
  }
  if (enabled !== true || nextWakeAtMs === null || !Number.isSafeInteger(nextWakeAtMs)
    || !Number.isSafeInteger(nowMs) || nextWakeAtMs <= nowMs) return requestedMs;
  // A consumed/expired boundary must not turn the ordinary park into a spin.
  return Math.min(requestedMs, nextWakeAtMs - nowMs);
}
