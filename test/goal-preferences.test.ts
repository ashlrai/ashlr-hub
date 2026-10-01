import { describe, expect, it } from 'vitest';
import { parseGoalPreferences, resolveGoalPreferences } from '../src/core/goals/preferences.js';

describe('operator goal preferences', () => {
  it('keeps all legacy defaults only for absent fields, and distinguishes explicit null', () => {
    expect(resolveGoalPreferences()).toMatchObject({ maxOpenGoals: 4, maxNewGoalsPerDay: 3,
      maxGoalProposalsPerMemo: 3, maxGoalsPerConductorCycle: 3, sourceState: 'ready',
      defaulted: ['maxOpenGoals', 'maxNewGoalsPerDay', 'maxGoalProposalsPerMemo', 'maxGoalsPerConductorCycle'] });
    expect(resolveGoalPreferences({ foundry: { goalPreferences: { maxOpenGoals: null, maxNewGoalsPerDay: 900 } } }))
      .toMatchObject({ maxOpenGoals: null, maxNewGoalsPerDay: 900, maxGoalProposalsPerMemo: 3,
        defaulted: ['maxGoalProposalsPerMemo', 'maxGoalsPerConductorCycle'] });
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4', undefined, true])('refuses invalid value %s', (value) => {
    expect(parseGoalPreferences({ maxOpenGoals: value }).ok).toBe(false);
    expect(resolveGoalPreferences({ foundry: { goalPreferences: { maxOpenGoals: value } } }).sourceState).toBe('invalid');
  });
  it('accepts no arbitrary numeric ceiling and rejects malformed objects/keys without evaluating accessors', () => {
    expect(parseGoalPreferences({ maxOpenGoals: Number.MAX_SAFE_INTEGER })).toEqual({ ok: true, preferences: { maxOpenGoals: Number.MAX_SAFE_INTEGER } });
    for (const value of [null, [], {}, { typo: null }, Object.create({ maxOpenGoals: null })]) expect(parseGoalPreferences(value).ok).toBe(false);
    const accessor = Object.defineProperty({}, 'maxOpenGoals', { enumerable: true, get: () => { throw new Error('must not evaluate'); } });
    expect(parseGoalPreferences(accessor).ok).toBe(false);
    expect(parseGoalPreferences({ [Symbol('hidden')]: null }).ok).toBe(false);
    expect(parseGoalPreferences({ maxOpenGoals: null }).ok).toBe(true);
  });
});

it('returns invalid instead of throwing when programmatic preference introspection fails', () => {
  const raw = new Proxy({}, { getPrototypeOf() { throw new Error('uninspectable'); } });
  expect(() => parseGoalPreferences(raw)).not.toThrow();
  expect(parseGoalPreferences(raw)).toMatchObject({ ok: false });
  expect(resolveGoalPreferences({ foundry: { goalPreferences: raw } })).toMatchObject({ sourceState: 'invalid' });
});
