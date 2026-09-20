/**
 * routes/verse/onboarding/useOnboarding.ts — the single React binding over
 * onboarding-store.ts, kept in its own file for the same reason
 * useVerseUi.ts is: the store stays framework-free and unit-testable
 * without a DOM.
 */
import { useSyncExternalStore } from 'react';
import { getOnboardingState, subscribeOnboarding, type OnboardingState } from './onboarding-store.js';

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(subscribeOnboarding, getOnboardingState, getOnboardingState);
}
