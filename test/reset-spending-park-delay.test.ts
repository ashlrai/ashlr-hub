import { describe, expect, it } from 'vitest';
import { resetSpendingParkDelay } from '../src/core/daemon/reset-spending-park-delay.js';
import { nextResetSpendingWake } from '../src/core/routing/reset-spending.js';
import type { ResetSpendingAccountStatus, ResetSpendingStatus } from '../src/core/routing/reset-spending-types.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ORDINARY = 300_000;
function account(overrides: Partial<ResetSpendingAccountStatus> = {}): ResetSpendingAccountStatus {
  return {
    mode: 'enabled', enabled: true, savedReservePercent: 40, signedFloorPercent: 10,
    effectiveReservePercent: 20, state: 'ready', reason: 'Synthetic qualified subscription fixture',
    constraints: [], deadline: new Date(NOW + 360_000).toISOString(), subscriptionOnly: 'verified',
    forecastBasis: { taskId: 'sample-task', engine: 'codex', model: 'sample-model', taskKind: 'test',
      seatId: 'sample-seat', p75Ms: 120_000, samples: 5, pooled: false }, ...overrides,
  };
}
function status(row: ResetSpendingAccountStatus): ResetSpendingStatus {
  return { mode: 'enabled', checkedAt: new Date(NOW).toISOString(), authorityState: 'active', accounts: { 'sample-seat': row } };
}

describe('existing resident park at a qualified reset boundary', () => {
  it('wakes at the first work-derived boundary, then advances without a zero-delay loop', () => {
    const view = status(account());
    const first = nextResetSpendingWake(view, NOW);
    expect(first).toBe(NOW + 120_000);
    expect(resetSpendingParkDelay(ORDINARY, first, NOW, true)).toBe(120_000);
    const second = nextResetSpendingWake(view, first!);
    expect(second).toBe(NOW + 240_000);
    expect(resetSpendingParkDelay(ORDINARY, second, first!, true)).toBe(120_000);
    const deadline = nextResetSpendingWake(view, second!);
    expect(deadline).toBe(NOW + 360_000);
    expect(resetSpendingParkDelay(ORDINARY, deadline, second!, true)).toBe(120_000);
    expect(nextResetSpendingWake(view, deadline!)).toBeNull();
    expect(resetSpendingParkDelay(ORDINARY, null, deadline!, true)).toBe(ORDINARY);
  });
  it('does not delay an earlier ordinary continuous idle park', () => {
    expect(resetSpendingParkDelay(5_000, NOW + 120_000, NOW, true)).toBe(5_000);
  });
  it('keeps the ordinary delay when current policy is off, even with prior advice', () => {
    expect(resetSpendingParkDelay(ORDINARY, NOW + 1_000, NOW, false)).toBe(ORDINARY);
  });
  it.each([
    ['disabled account', { enabled: false }],
    ['unknown subscription-only boundary', { subscriptionOnly: 'unknown' }],
    ['missing task estimate', { forecastBasis: null }],
    ['missing provider deadline', { deadline: null }],
    ['unqualified account', { state: 'unqualified' }],
    ['paused authority', { state: 'authority-paused' }],
  ] as const)('does not create a wake for %s', (_label, patch) => {
    const next = nextResetSpendingWake(status(account(patch)), NOW);
    expect(next).toBeNull();
    expect(resetSpendingParkDelay(ORDINARY, next, NOW, true)).toBe(ORDINARY);
  });
  it.each([null, NOW - 1, NOW, Number.NaN, Number.POSITIVE_INFINITY, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'does not spin on an absent, expired or malformed boundary %s', (boundary) => {
      expect(resetSpendingParkDelay(ORDINARY, boundary, NOW, true)).toBe(ORDINARY);
    },
  );
  it.each([Number.NaN, Number.POSITIVE_INFINITY, NOW + 0.5])('does not infer time from an invalid clock %s', (now) => {
    expect(resetSpendingParkDelay(ORDINARY, NOW + 120_000, now, true)).toBe(ORDINARY);
  });
  it('retains exact short and zero ordinary durations without a new minimum or ceiling', () => {
    expect(resetSpendingParkDelay(0.25, NOW + 1, NOW, true)).toBe(0.25);
    expect(resetSpendingParkDelay(0, NOW + 1, NOW, true)).toBe(0);
    expect(resetSpendingParkDelay(Number.MAX_SAFE_INTEGER, NOW + 60_000, NOW, true)).toBe(60_000);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid ordinary duration %s rather than inventing cadence', (duration) => {
    expect(() => resetSpendingParkDelay(duration, NOW + 1_000, NOW, true)).toThrow(RangeError);
  });
});
