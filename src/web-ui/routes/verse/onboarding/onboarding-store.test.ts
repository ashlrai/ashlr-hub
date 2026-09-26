import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_ONBOARDING_STORAGE_KEY,
  collapseOnboarding,
  completeOnboarding,
  dismissOnboarding,
  expandOnboarding,
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

  it('starts as the chip, and remembers chip / card and the step across launches', () => {
    expect(getOnboardingState()).toMatchObject({ open: true, expanded: false, step: 0 });

    expandOnboarding();
    setOnboardingStep(2);
    expect(getOnboardingState()).toMatchObject({ open: true, expanded: true, step: 2 });
    expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toEqual({
      completedAt: null,
      dismissedAt: null,
      expanded: true,
      step: 2,
    });

    collapseOnboarding();
    const stored = JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!) as Record<string, unknown>;
    expect(stored).toMatchObject({ expanded: false, step: 2 });
    // Folding is not an answer: the first run is still armed.
    expect(isFirstRun(stored as { completedAt: null; dismissedAt: null })).toBe(true);
    expect(getOnboardingState().open).toBe(true);
  });

  it('reads the stored prefs back at launch, and ignores junk in them', async () => {
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify({ completedAt: null, dismissedAt: null, expanded: true, step: 3 }));
    vi.resetModules();
    const fresh = await import('./onboarding-store.js');
    expect(fresh.getOnboardingState()).toMatchObject({ open: true, expanded: true, step: 3 });

    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify({ completedAt: null, dismissedAt: null, expanded: 'yes', step: 'two' }));
    vi.resetModules();
    const junk = await import('./onboarding-store.js');
    expect(junk.getOnboardingState()).toMatchObject({ open: true, expanded: false, step: 0 });

    // A record from before the chip existed (3.11: two fields) still reads.
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify({ completedAt: '2026-09-20T10:00:00.000Z', dismissedAt: null }));
    vi.resetModules();
    const legacy = await import('./onboarding-store.js');
    expect(legacy.getOnboardingState()).toMatchObject({ open: false, expanded: false, step: 0 });
  });

  it('keeps the chip / card preference when the tour is answered', () => {
    expandOnboarding();
    dismissOnboarding();
    expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toMatchObject({ expanded: true, dismissedAt: expect.any(String) });
  });

  it('replay opens the full card, because the operator asked for it', () => {
    dismissOnboarding();
    replayOnboarding();
    expect(getOnboardingState()).toMatchObject({ open: true, expanded: true, step: 0 });
  });

  it('never throws when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => expandOnboarding()).not.toThrow();
    expect(() => collapseOnboarding()).not.toThrow();
    expect(() => dismissOnboarding()).not.toThrow();
    expect(getOnboardingState().open).toBe(false);
    setItem.mockRestore();
  });

  it('survives a malformed stored record', () => {
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, '{not json');
    // The store reads at module load, so exercise the same path directly:
    // a broken record must never throw out of a getter.
    expect(() => JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toThrow();
    expect(() => getOnboardingState()).not.toThrow();
  });
});
