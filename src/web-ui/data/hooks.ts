/**
 * data/hooks.ts — React bindings over the framework-free stores in
 * cache.ts / auth-store.ts / sse.ts. This is the only file in the data
 * layer that imports React; every module underneath it stays plain
 * TypeScript so it's trivially unit-testable without a DOM.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getQuerySnapshot, runQuery, subscribeQuery, type QueryEntry } from './cache.js';
import type { QueryDef } from './queries.js';
import {
  getAuthSnapshot,
  subscribeAuth,
  type AuthPhase,
  hasMutationHold,
  getMutationToken,
  setMutationToken as storeSetMutationToken,
  touchMutationHold,
  clearMutationToken,
} from './auth-store.js';
import { onSseEvent, type SseEventName } from './sse.js';
import { subscribeTheme, getTheme, setTheme, cycleTheme, type ThemePreference } from './theme-store.js';

/**
 * Subscribe to a resource. Fetches on mount (and on `key` change), stays
 * subscribed to background refreshes triggered by sse.ts, and NEVER clears
 * `data` while refetching — `status === 'refreshing'` is the signal to show
 * a subtle indicator instead of a skeleton, `status === 'loading'` (no data
 * yet at all) is the only state that should render a skeleton.
 */
export function useQuery<T>(def: QueryDef<T>): QueryEntry<T> {
  const snapshot = useSyncExternalStore(
    useCallback((listener) => subscribeQuery(def.key, listener), [def.key]),
    () => getQuerySnapshot<T>(def.key),
    () => getQuerySnapshot<T>(def.key),
  );

  useEffect(() => {
    const controller = new AbortController();
    void runQuery(def.key, () => def.fetch(controller.signal));
    return () => controller.abort();
    // Re-fetch only when the resource identity changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- def.fetch is re-created per render on purpose; only def.key identifies the resource.
  }, [def.key]);

  return snapshot;
}

/** Manually trigger a re-fetch without waiting for SSE (e.g. a "Retry" button). */
export function useRefetch<T>(def: QueryDef<T>): () => void {
  return useCallback(() => {
    void runQuery(def.key, () => def.fetch());
  }, [def]);
}

export function useAuthPhase(): AuthPhase {
  return useSyncExternalStore(subscribeAuth, () => getAuthSnapshot().phase, () => getAuthSnapshot().phase);
}

export interface MutationHold {
  hasHold: boolean;
  token: string | null;
  heldUntil: number | null;
  setToken: (token: string) => void;
  touch: () => void;
  clear: () => void;
}

export function useMutationHold(): MutationHold {
  const heldUntil = useSyncExternalStore(
    subscribeAuth,
    () => getAuthSnapshot().mutationTokenHeldUntil,
    () => getAuthSnapshot().mutationTokenHeldUntil,
  );
  return {
    hasHold: hasMutationHold(),
    token: getMutationToken(),
    heldUntil,
    setToken: storeSetMutationToken,
    touch: touchMutationHold,
    clear: clearMutationToken,
  };
}

/** Subscribe to a raw named SSE event for the lifetime of the component. */
export function useSseEvent(name: SseEventName, onEvent: (payload: unknown) => void): void {
  useEffect(() => onSseEvent(name, onEvent), [name, onEvent]);
}

export interface ThemeControl {
  theme: ThemePreference;
  set: (next: ThemePreference) => void;
  cycle: () => void;
}

/** Shared with Topbar's theme button and the command palette's "Toggle
 * theme" action — both read/write data/theme-store.ts through this hook so
 * neither can drift out of sync with the other. */
export function useTheme(): ThemeControl {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return { theme, set: setTheme, cycle: cycleTheme };
}
