/**
 * routes/verse/onboarding/OnboardingGate.tsx — whether the first-run tour is
 * on screen, and its chunk while it is.
 *
 * The shell mounts this lazily (VerseApp), so neither the tour's store nor
 * the tour itself is chat first-paint critical JS: the chip is a docked
 * corner affordance that asks for nothing, drawn a beat after the shell
 * (exactly as before, when the flow's own chunk already arrived after first
 * paint). Settings ▸ Replay reopens it through the same store, which this
 * gate is subscribed to for the life of the shell.
 */
import { lazy } from 'react';
import { useOnboarding } from './useOnboarding.js';

const OnboardingFlow = lazy(() => import('./OnboardingFlow.js').then((m) => ({ default: m.OnboardingFlow })));

export function OnboardingGate() {
  const onboarding = useOnboarding();
  return onboarding.open ? <OnboardingFlow /> : null;
}
