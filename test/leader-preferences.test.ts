import { describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  leaderPreferencesReady, parseLeaderPreferences, resolveLeaderPreferences, unavailableLeaderPreferences,
} from '../src/core/vision/leader-preferences.js';
import {
  checkinWindowOpen, leaderCadenceReady, LEGACY_LEADER_CADENCE, nextCheckinAt, resolveLeaderCadence, retryDelayMs,
} from '../src/core/vision/leader-cadence.js';
import { leaderRunDue, leaderWakeDue, type LeaderRunState } from '../src/core/vision/leader.js';

const cfg = (leaderPreferences: unknown, checkinHours = 2) => ({ foundry: { leaderPreferences, leader: { checkinHours } } }) as unknown as AshlrConfig;

describe('operator Leader daily preferences', () => {
  it('preserves enabled/disabled cadence defaults, and only defaults omitted fields', () => {
    expect(resolveLeaderPreferences()).toEqual({ maxFullRunsPerDay: 3, maxTotalRunsPerDay: 8, maxGrokLanes: 4,
      defaulted: ['maxFullRunsPerDay', 'maxTotalRunsPerDay', 'maxGrokLanes'], sourceState: 'ready', errors: [] });
    expect(resolveLeaderPreferences(undefined, { checkinsEnabled: false }).maxTotalRunsPerDay).toBe(3);
    expect(resolveLeaderCadence(cfg({ maxFullRunsPerDay: null }, 0))).toMatchObject({ maxRunsPerDay: null, maxRunsPerDayTotal: 3 });
    expect(resolveLeaderCadence(cfg({ maxTotalRunsPerDay: null }, 0))).toMatchObject({ maxRunsPerDay: 3, maxRunsPerDayTotal: null });
    expect(resolveLeaderCadence(cfg({ maxFullRunsPerDay: 15, maxTotalRunsPerDay: 25 }))).toMatchObject({ maxRunsPerDay: 15, maxRunsPerDayTotal: 25 });
    expect(leaderCadenceReady(LEGACY_LEADER_CADENCE)).toBe(true);
  });

  it('accepts arbitrary positive safe integers and explicit null without cross-field artificial ceilings', () => {
    expect(parseLeaderPreferences({ maxFullRunsPerDay: Number.MAX_SAFE_INTEGER, maxTotalRunsPerDay: null })).toEqual({
      ok: true, preferences: { maxFullRunsPerDay: Number.MAX_SAFE_INTEGER, maxTotalRunsPerDay: null },
    });
    // Each comparison is independent; a stricter total may further constrain full runs.
    expect(leaderPreferencesReady(resolveLeaderPreferences(cfg({ maxFullRunsPerDay: 20, maxTotalRunsPerDay: 2 })))).toBe(true);
    expect(resolveLeaderPreferences(cfg({ maxGrokLanes: null }))).toMatchObject({ maxGrokLanes: null,
      defaulted: ['maxFullRunsPerDay', 'maxTotalRunsPerDay'] });
    expect(parseLeaderPreferences({ maxGrokLanes: Number.MAX_SAFE_INTEGER })).toEqual({ ok: true,
      preferences: { maxGrokLanes: Number.MAX_SAFE_INTEGER } });
  });

  it.each([0, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8', undefined, true])('rejects invalid explicit values %s without interpreting them as no limit', (value) => {
    expect(parseLeaderPreferences({ maxTotalRunsPerDay: value }).ok).toBe(false);
    expect(parseLeaderPreferences({ maxGrokLanes: value }).ok).toBe(false);
    const cadence = resolveLeaderCadence(cfg({ maxTotalRunsPerDay: value }));
    expect(cadence.preferences?.sourceState).toBe('invalid');
    expect(leaderCadenceReady(cadence)).toBe(false);
  });

  it('rejects malformed, hidden and accessor fields without invoking an accessor', () => {
    for (const foundry of [null, [], 1, 'wrong']) {
      expect(resolveLeaderPreferences({ foundry } as unknown as AshlrConfig).sourceState).toBe('invalid');
      expect(leaderCadenceReady(resolveLeaderCadence({ foundry } as unknown as AshlrConfig))).toBe(false);
    }
    for (const value of [null, [], {}, { typo: null }, Object.create({ maxFullRunsPerDay: null })]) {
      expect(parseLeaderPreferences(value).ok).toBe(false);
    }
    const accessor = Object.defineProperty({}, 'maxFullRunsPerDay', { enumerable: true, get: () => { throw new Error('must not run'); } });
    expect(parseLeaderPreferences(accessor).ok).toBe(false);
    expect(parseLeaderPreferences(Object.defineProperty({}, 'maxFullRunsPerDay', { value: null })).ok).toBe(false);
    expect(parseLeaderPreferences({ [Symbol('hidden')]: null }).ok).toBe(false);
    expect(parseLeaderPreferences({}, true)).toEqual({ ok: true, preferences: {} });
    const opaque = new Proxy({}, { ownKeys() { throw new Error('private payload'); } });
    expect(parseLeaderPreferences(opaque)).toEqual({ ok: false, errors: ['leaderPreferences could not be inspected'] });
  });

  it('keeps unavailable policy distinct from explicit null and rejects forged resolved values', () => {
    const unavailable = unavailableLeaderPreferences(false);
    expect(unavailable).toMatchObject({ sourceState: 'unavailable', maxTotalRunsPerDay: 3 });
    expect(leaderPreferencesReady(unavailable)).toBe(false);
    expect(leaderCadenceReady(resolveLeaderCadence(undefined, unavailable))).toBe(false);
    expect(leaderCadenceReady({ ...LEGACY_LEADER_CADENCE, maxRunsPerDay: 0 })).toBe(false);
    expect(leaderCadenceReady({ ...resolveLeaderCadence(undefined), maxRunsPerDay: null })).toBe(false);
    expect(leaderPreferencesReady({ ...resolveLeaderPreferences(), maxFullRunsPerDay: Infinity })).toBe(false);
  });
});

describe('daily preference removal preserves scheduling', () => {
  const now = new Date(2026, 9, 1, 15).getTime();
  const hour = 3_600_000;
  const quiet = { mergesSinceLastRun: 0, revertsSinceLastRun: 0, seatResetSinceLastRun: false, highInsightSinceLastRun: false };
  const state: LeaderRunState = {
    v: 1, lastRun: { at: new Date(now - hour).toISOString(), outcome: 'ok', reason: null, memoId: null, trigger: 'manual' },
    lastMemoAt: new Date(now - hour).toISOString(), runDays: { '2026-10-01': 100 }, checkinDays: {},
    lastEvidenceDigest: null, lastDeepRunAt: null, baselines: {}, outcomes: [],
  };

  it('permits an actual event above legacy3/8 under explicit null but does not make a quiet tick due', () => {
    const cadence = resolveLeaderCadence(cfg({ maxFullRunsPerDay: null, maxTotalRunsPerDay: null }));
    expect(leaderRunDue(now, state, { ...quiet, revertsSinceLastRun: 1 }, cadence)).toMatchObject({ due: true, trigger: 'revert' });
    expect(leaderRunDue(now, state, quiet, cadence).due).toBe(false);
    expect(leaderWakeDue(now, state, cadence).due).toBe(false);
  });

  it('still applies each independently finite preference', () => {
    for (const preferences of [
      { maxFullRunsPerDay: 3, maxTotalRunsPerDay: null },
      { maxFullRunsPerDay: null, maxTotalRunsPerDay: 100 },
    ]) {
      const cadence = resolveLeaderCadence(cfg(preferences));
      expect(leaderRunDue(now, state, { ...quiet, revertsSinceLastRun: 1 }, cadence).due).toBe(false);
      expect(leaderWakeDue(now, state, cadence).due).toBe(false);
    }
  });

  it('invalid or unavailable preferences cannot start a run or wake the poller', () => {
    for (const cadence of [resolveLeaderCadence(cfg({ maxFullRunsPerDay: -1 })),
      resolveLeaderCadence(undefined, unavailableLeaderPreferences())]) {
      expect(leaderRunDue(now, state, { ...quiet, revertsSinceLastRun: 1 }, cadence).due).toBe(false);
      expect(leaderWakeDue(now, state, cadence).due).toBe(false);
    }
  });

  it('no daily preference limit leaves the check-in interval, recheck delay and working hours intact', () => {
    const cadence = resolveLeaderCadence(cfg({ maxFullRunsPerDay: null, maxTotalRunsPerDay: null }));
    expect(nextCheckinAt(state, cadence)).toBe(now + hour);
    expect(checkinWindowOpen(now, state, cadence)).toBe(false);
    expect(checkinWindowOpen(now + hour, state, cadence)).toBe(true);
    expect(checkinWindowOpen(now + 9 * hour, state, cadence)).toBe(false);
    expect(nextCheckinAt({ ...state, lastCheckinEvalAt: new Date(now + hour).toISOString() }, cadence)).toBe(now + 1.5 * hour);
    expect(nextCheckinAt(state, resolveLeaderCadence(cfg({ maxFullRunsPerDay: null, maxTotalRunsPerDay: null }, 0)))).toBeNull();
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([15 * 60_000, 45 * 60_000, 120 * 60_000, null]);
  });
});
