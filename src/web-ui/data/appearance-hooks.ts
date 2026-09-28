/** Settings-only React binding for the full appearance store. */
import { useSyncExternalStore } from 'react';
import { getAppearance, resetAppearance, setAppearance, subscribeAppearance, type Appearance } from './appearance-store.js';

export interface AppearanceControl {
  appearance: Appearance;
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
}

export function useAppearance(): AppearanceControl {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  return { appearance, set: setAppearance, reset: resetAppearance };
}
