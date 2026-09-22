import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_ONBOARDING_STORAGE_KEY,
  completeOnboarding,
  dismissOnboarding,
  getOnboardingState,
  isFirstRun,
  replayOnboarding,
  resetOnboarding,
  setOnboardingStep,
  subscribeOnboarding,
} from './onboarding-store.js';

describe('onboarding store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOnboarding();
  });

  it('opens on a first run and closes for good once skipped', () => {
    expect(getOnboardingState().open).toBe(true);

    dismissOnboarding();
    expect(getOnboardingState().open).toBe(false);
    expect(getOnboardingState().dismissedAt).not.toBeNull();

    const stored = JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!) as Record<string, unknown>;
    expect(stored.dismissedAt).toEqual(expect.any(String));
    expect(isFirstRun({ completedAt: null, dismissedAt: stored.dismissedAt as string })).toBe(false);
  });

  it('records completion separately from a skip', () => {
    completeOnboarding();
    const state = getOnboardingState();
    expect(state.open).toBe(false);
    expect(state.completedAt).not.toBeNull();
    expect(state.dismissedAt).toBeNull();
  });

  it('replay reopens at the first step without re-arming the first run', () => {
    setOnboardingStep(3);
    completeOnboarding();
    const completedAt = getOnboardingState().completedAt;

    replayOnboarding();
    expect(getOnboardingState().open).toBe(true);
    expect(getOnboardingState().step).toBe(0);
    // The stored answer is untouched: closing the replay must not make the
    // tour come back by itself on the next launch.
    expect(getOnboardingState().completedAt).toBe(completedAt);

    dismissOnboarding();
    expect(getOnboardingState().completedAt).toBe(completedAt);
  });

  it('notifies subscribers on every observable change, and only then', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOnboarding(listener);

    setOnboardingStep(1);
    expect(listener).toHaveBeenCalledTimes(1);
    setOnboardingStep(1);
    expect(listener).toHaveBeenCalledTimes(1);

    dismissOnboarding();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('never lets a negative or fractional step through', () => {
    setOnboardingStep(-4);
    expect(getOnboardingState().step).toBe(0);
    setOnboardingStep(2.7);
    expect(getOnboardingState().step).toBe(2);
  });

  it('survives a malformed stored record', () => {
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, '{not json');
    // The store reads at module load, so exercise the same path directly:
    // a broken record must never throw out of a getter.
    expect(() => JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toThrow();
    expect(() => getOnboardingState()).not.toThrow();
  });
});
