/**
 * routes/verse/useVerseUi.ts — the React glue over verse-ui-store.ts (same
 * split as useVerseSession.ts over verse-store.ts: the store stays
 * framework-free, this file is the only place that knows about React).
 */
import { useSyncExternalStore } from 'react';
import { getVerseUiState, subscribeVerseUi, type VerseUiState } from './verse-ui-store.js';

export function useVerseUi(): VerseUiState {
  return useSyncExternalStore(subscribeVerseUi, getVerseUiState, getVerseUiState);
}
