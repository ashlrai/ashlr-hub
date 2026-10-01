import { describe, expect, it } from 'vitest';
import { leaderPreferenceDraft, leaderPreferencePatch, readLeaderPreferences, type LeaderPreferences } from './leader-preferences-spec.js';

const saved: LeaderPreferences = { maxFullRunsPerDay: 3, maxTotalRunsPerDay: 8, maxGrokLanes: 4,
  sourceState: 'ready', errors: [], defaulted: ['maxFullRunsPerDay', 'maxTotalRunsPerDay', 'maxGrokLanes'] };
describe('Leader preference projection and edits', () => {
  it('distinguishes unsupported, unavailable, invalid and explicit no limit', () => {
    expect(readLeaderPreferences(undefined)).toEqual({ state: 'unsupported' });
    expect(readLeaderPreferences({ ...saved, sourceState: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(readLeaderPreferences({ ...saved, sourceState: 'invalid', maxFullRunsPerDay: null })).toEqual({ state: 'invalid' });
    expect(readLeaderPreferences({ ...saved, maxFullRunsPerDay: null })).toMatchObject({ state: 'ready', values: { maxFullRunsPerDay: null } });
    expect(readLeaderPreferences({ ...saved, maxTotalRunsPerDay: 3 })).toMatchObject({ state: 'ready', values: { maxTotalRunsPerDay: 3 } });
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '4', undefined])('refuses invalid saved numeric %s', (value) => {
    expect(readLeaderPreferences({ ...saved, maxGrokLanes: value })).toEqual({ state: 'invalid' });
  });
  it('does not guess a check-in default when returning from an explicit no-limit choice', () => {
    const values = { maxFullRunsPerDay: 3, maxTotalRunsPerDay: null, maxGrokLanes: 4 };
    const draft = leaderPreferenceDraft(values);
    expect(draft.maxTotalRunsPerDay).toEqual({ text: '', unlimited: true });
    expect(leaderPreferencePatch(draft, values)).toEqual({ patch: {}, errors: {} });
    draft.maxTotalRunsPerDay.unlimited = false;
    expect(leaderPreferencePatch(draft, values).errors.maxTotalRunsPerDay).toBeTruthy();
  });
  it('emits independent dirty-only fields, preserving high safe integers and explicit null', () => {
    const draft = leaderPreferenceDraft(saved);
    draft.maxFullRunsPerDay = { text: String(Number.MAX_SAFE_INTEGER), unlimited: false };
    draft.maxGrokLanes.unlimited = true;
    expect(leaderPreferencePatch(draft, saved)).toEqual({ patch: { maxFullRunsPerDay: Number.MAX_SAFE_INTEGER, maxGrokLanes: null }, errors: {} });
  });
  it('does not invoke getters or scan huge malformed default metadata', () => {
    const hostile = { ...saved };
    Object.defineProperty(hostile, 'maxFullRunsPerDay', { get() { throw new Error('private'); } });
    expect(readLeaderPreferences(hostile)).toEqual({ state: 'invalid' });
    const sparse = new Array(1_000_000_000);
    expect(readLeaderPreferences({ ...saved, defaulted: sparse })).toMatchObject({ state: 'ready', defaulted: [] });
  });
});
