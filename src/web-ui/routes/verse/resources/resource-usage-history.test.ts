import { describe, expect, it } from 'vitest';
import type { ResourceLastKnownUsage } from '../../../../core/resources/reading-cache-types.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { accountStatus, buildCapacityRows } from '../usage/capacity-strip-model.js';
import { barRows } from './ResourcesBar.js';
import { historicalLeftPercent, resourceCreditHistory, resourceUsageHistory } from './resource-usage-history.js';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
function history(patch: Partial<ResourceLastKnownUsage> = {}): ResourceLastKnownUsage {
  return { observedAt: '2026-09-30T12:00:00.000Z', expiresAt: '2026-09-30T12:00:05.000Z',
    windows: [{ id: 'seven_day', usedPercent: 72, resetsAt: '2026-10-02T12:00:00.000Z' }],
    source: 'native-account-checked-history', identitySource: 'native-account-checked-local-epoch', ...patch };
}
function seat() { return nativeSeat(capacity({ usability: 'unknown', windows: [], binding: null }), { lastKnownUsage: history() }); }
describe('Historical startup usage display', () => {
  it('shows the original gray reading without changing live windows, status, credits or reset availability', () => {
    const withHistory = buildCapacityRows([seat()], { now: NOW })[0]!;
    const without = buildCapacityRows([{ ...seat(), lastKnownUsage: undefined }], { now: NOW })[0]!;
    expect(withHistory.windows).toEqual([]);
    expect(withHistory.credits).toBeNull(); expect(withHistory.resetAt).toEqual(without.resetAt);
    expect(accountStatus(withHistory, { now: NOW, healthRead: false })).toEqual(accountStatus(without, { now: NOW, healthRead: false }));
    const display = barRows([withHistory], { now: NOW, healthRead: false })[0]!;
    expect(display.level).toBe('unknown'); expect(display.leftPercent).toBe(28); expect(display.value).toBe('28% last');
    expect(display.detail.join(' ')).toContain('Historical reading'); expect(display.summary).toContain('current usage unconfirmed');
    expect(withHistory.historicalUsage?.observedAt).toBe('2026-09-30T12:00:00.000Z');
  });
  it('shows dated Codex credits independently of fresh subscription usage without promoting capacity', () => {
    const w = seatWindow({ id: 'weekly', usedPercent: 22 });
    const creditHistory = { reading: { hasCredits: true, unlimited: false, balance: '24999.50' },
      observedAt: '2026-09-30T12:00:00.000Z', expiresAt: '2026-09-30T12:01:00.000Z', planType: 'pro' };
    const s = nativeSeat(capacity({ windows: [w], binding: w, credits: null }),
      { engine: 'codex', lastKnownUsage: history({ creditHistory }) });
    const projected = buildCapacityRows([s], { now: NOW })[0]!;
    expect(projected.historicalUsage).toBeNull(); expect(projected.credits).toBeNull();
    expect(projected.creditState).toBe('unknown'); expect(projected.windows[0]?.usedPercent).toBe(22);
    const display = barRows([projected], { now: NOW, healthRead: false })[0]!;
    expect(display.value).toBe('22% used'); expect(display.creditLabel).toBe('Credits ≈$999.98 · last');
    expect(display.detail.join(' ')).toContain('current balance and availability are unconfirmed');
    const zero = buildCapacityRows([{ ...s, capacity: capacity({ windows: [w], binding: w,
      credits: { hasCredits: false, unlimited: false, balance: '0' }, creditsExpiresAt: new Date(NOW + 1).toISOString() }) }], { now: NOW })[0]!;
    expect(barRows([zero], { now: NOW, healthRead: false })[0]?.creditLabel).toBe('No credits reported');
    expect(barRows([{ ...projected, signedOut: true }], { now: NOW, healthRead: false })[0]?.creditLabel).toBe('Credits unconfirmed');
    expect(resourceCreditHistory({ ...s, lastKnownUsage: history({ creditHistory: { ...creditHistory, observedAt: '2026-10-02T12:00:00.000Z' } }) }, NOW)).toBeNull();
    expect(resourceCreditHistory({ ...s, engine: 'claude' }, NOW)).toBeNull();
    const unknownPlan = buildCapacityRows([{ ...s, lastKnownUsage: history({ creditHistory: { ...creditHistory, planType: null } }) }], { now: NOW })[0]!;
    expect(barRows([unknownPlan], { now: NOW, healthRead: false })[0]?.creditLabel).toBe('Credits 24999.50 units · last');
  });
  it('roundtrips display-only Claude identity history without promoting current usage or credits', () => {
    const recorded = history({ identitySource: 'native-account-checked-display-identity' });
    const s = { ...seat(), lastKnownUsage: JSON.parse(JSON.stringify(recorded)) };
    expect(resourceUsageHistory(s, NOW)).toEqual(recorded);
    const row = buildCapacityRows([s], { now: NOW })[0]!;
    expect(row.windows).toEqual([]); expect(row.credits).toBeNull();
    expect(barRows([row], { now: NOW, healthRead: false })[0]?.value).toBe('28% last');
    expect(barRows([row], { now: NOW, healthRead: false })[0]?.level).toBe('unknown');
    expect(row.historicalUsage?.identitySource).toBe('native-account-checked-display-identity');
  });
  it('lets live measurements replace history immediately, and never shows cached signed-out usage', () => {
    const w = seatWindow({ id: 'seven_day', usedPercent: 22 });
    const s = seat(); s.capacity = capacity({ windows: [w], binding: w });
    const current = buildCapacityRows([s], { now: NOW })[0]!;
    expect(current.historicalUsage).toBeNull(); expect(barRows([current], { now: NOW, healthRead: false })[0]!.value).toBe('78% left');
    const signedOut = buildCapacityRows([nativeSeat(capacity({ usability: 'signed-out', windows: [], binding: null }), { lastKnownUsage: history() })], { now: NOW })[0]!;
    expect(barRows([signedOut], { now: NOW, healthRead: false })[0]!.value).not.toContain('last');
  });
  it('holds future, invalid and contradictory history, and treats unavailable percentages as unknown', () => {
    for (const value of [null, 1, 'invalid']) {
      expect(resourceUsageHistory({ ...seat(), lastKnownUsage: { ...history(), windows: [value] } } as unknown as ReturnType<typeof seat>, NOW)).toBeNull();
    }
    for (const h of [history({ observedAt: '2026-10-02T12:00:00.000Z' }), history({ expiresAt: '2026-09-30T12:00:00.000Z' }),
      history({ expiresAt: '2026-09-30T12:02:00.000Z' }), history({ windows: [{ id: 'weekly', usedPercent: NaN, resetsAt: null }] })])
      expect(resourceUsageHistory({ ...seat(), lastKnownUsage: h }, NOW)).toBeNull();
    expect(historicalLeftPercent(history({ windows: [{ id: 'weekly', usedPercent: null, resetsAt: null }] }))).toBeNull();
    expect(historicalLeftPercent(history({ windows: [{ id: 'weekly', usedPercent: 100, resetsAt: null, limitReached: true }] }))).toBe(0);
  });
});
