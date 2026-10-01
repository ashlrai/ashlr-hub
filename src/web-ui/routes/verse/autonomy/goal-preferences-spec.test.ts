import { describe, expect, it, vi } from 'vitest';
import { GOAL_PREFERENCE_FIELDS, goalPreferenceDraft, goalPreferencePatch, readGoalFocus, readGoalPreferences, validateGoalPreference } from './goal-preferences-spec.js';

const values = { maxOpenGoals: 4, maxNewGoalsPerDay: 3, maxGoalProposalsPerMemo: 3, maxGoalsPerConductorCycle: 3 };
const ready = { ...values, sourceState: 'ready', defaulted: GOAL_PREFERENCE_FIELDS.map((field) => field.key) };

describe('goal preference projection and edits', () => {
  it('keeps older-server absence, unavailable data and invalid data distinct from explicit null', () => {
    expect(readGoalPreferences(undefined)).toEqual({ state: 'unsupported' });
    expect(readGoalPreferences({ sourceState: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(readGoalPreferences({ ...ready, sourceState: 'invalid' })).toEqual({ state: 'invalid' });
    expect(readGoalPreferences({ ...ready, maxOpenGoals: null })).toMatchObject({ state: 'ready', values: { maxOpenGoals: null } });
  });

  it.each(GOAL_PREFERENCE_FIELDS)('refuses missing, fractional or unsafe saved $key without showing no-limit', (field) => {
    for (const invalid of [undefined, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '4']) {
      expect(readGoalPreferences({ ...ready, [field.key]: invalid })).toEqual({ state: 'invalid' });
    }
    expect(readGoalPreferences({ ...ready, [field.key]: Number.MAX_SAFE_INTEGER }).state).toBe('ready');
  });

  it.each(['', ' ', '0', '-1', '17.5', '17junk', '1e3', 'Infinity', 'NaN', String(Number.MAX_SAFE_INTEGER + 1)])('refuses invalid staged numeric preference %s', (text) => {
    expect(validateGoalPreference(text, false).ok).toBe(false);
  });

  it('accepts representable positive integers and requires an explicit no-limit choice', () => {
    expect(validateGoalPreference('17', false)).toEqual({ ok: true, value: 17 });
    expect(validateGoalPreference(String(Number.MAX_SAFE_INTEGER), false)).toEqual({ ok: true, value: Number.MAX_SAFE_INTEGER });
    expect(validateGoalPreference('', true)).toEqual({ ok: true, value: null });
    expect(validateGoalPreference('', false).ok).toBe(false);
  });

  it('keeps an unsupported finishing preference distinct from explicitly off', () => {
    expect(readGoalFocus(undefined, undefined)).toBeNull();
    expect(readGoalFocus(false, 4)).toEqual({ mode: false, threshold: 4 });
    for (const threshold of [undefined, 0, -1, 2.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(readGoalFocus(true, threshold)).toBeNull();
  });

  it('omits every untouched field and sends only the changed explicit null', () => {
    const draft = goalPreferenceDraft(values);
    expect(goalPreferencePatch(draft, values)).toEqual({ patch: {}, errors: {} });
    draft.maxOpenGoals.unlimited = true;
    expect(goalPreferencePatch(draft, values)).toEqual({ patch: { maxOpenGoals: null }, errors: {} });
    const nullSaved = { ...values, maxOpenGoals: null };
    expect(goalPreferencePatch(goalPreferenceDraft(nullSaved), nullSaved)).toEqual({ patch: {}, errors: {} });
  });

  it('collects invalid edits without transforming another field into unlimited', () => {
    const draft = goalPreferenceDraft(values);
    draft.maxOpenGoals.text = '';
    draft.maxNewGoalsPerDay.text = '19';
    expect(goalPreferencePatch(draft, values)).toEqual({ patch: { maxNewGoalsPerDay: 19 }, errors: { maxOpenGoals: expect.any(String) } });
  });

  it('does not invoke getters or scan unbounded default metadata', () => {
    const getter = vi.fn(() => { throw new Error('private payload'); });
    expect(readGoalPreferences(Object.defineProperty({ ...ready }, 'maxOpenGoals', { get: getter }))).toEqual({ state: 'invalid' });
    expect(getter).not.toHaveBeenCalled();
    const defaults = new Array(1_000_000_000);
    Object.defineProperty(defaults, '0', { get: getter });
    expect(readGoalPreferences({ ...ready, defaulted: defaults })).toMatchObject({ state: 'ready', defaulted: [] });
    expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(readGoalPreferences(revoked.proxy)).toEqual({ state: 'invalid' });
  });
});
