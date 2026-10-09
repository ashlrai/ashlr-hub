/**
 * data/hooks.ts — React bindings over the framework-free stores in
 * cache.ts / auth-store.ts / sse.ts. This is the only file in the data
 * layer that imports React; every module underneath it stays plain
 * TypeScript so it's trivially unit-testable without a DOM.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ensureQuery, getQuerySnapshot, refetchQuery, subscribeQuery, type QueryEntry } from './cache.js';
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
import type { SseEventName } from './sse.js';
import { subscribeTheme, getTheme, setTheme, cycleTheme, type ThemePreference } from './theme-store.js';

/**
 * How long a cached value is accepted on MOUNT without re-reading it.
 *
 * A section that re-mounts inside this window (rail switch, a parent
 * re-keying, React 18's double-invoked effects in StrictMode) issues no
 * request at all. Ten seconds is short enough that any surface a human
 * revisits deliberately still re-reads, and long enough that the Usage
 * section's seven probe-spawning reads happen ONCE per visit rather than
 * once per mount.
 *
 * This does not make data stale: keys with an SSE event still refresh the
 * instant the server says they changed (sse.ts → invalidate, which is not
 * freshness-gated), and `useRefetch` always ignores it.
 */
export const DEFAULT_QUERY_FRESH_MS = 10_000;

const DISABLED_QUERY_SNAPSHOT: QueryEntry<never> = { data: undefined, error: undefined, status: 'idle', updatedAt: null };

export interface UseQueryOptions {
  /** Subscribe/fetch on mount. False stays idle; shared reads are never cancelled. Default true. */
  enabled?: boolean;
  /** Override `DEFAULT_QUERY_FRESH_MS` for this subscription. 0 = always fetch. */
  freshMs?: number;
}

/**
 * Subscribe to a resource. Fetches on mount (and on `key` change) unless the
 * cached value is still fresh, stays subscribed to background refreshes
 * triggered by sse.ts, and NEVER clears `data` while refetching —
 * `status === 'refreshing'` is the signal to show a subtle indicator instead
 * of a skeleton, `status === 'loading'` (no data yet at all) is the only
 * state that should render a skeleton.
 */
export function useQuery<T>(def: QueryDef<T>, options?: UseQueryOptions): QueryEntry<T> {
  const freshMs = options?.freshMs ?? DEFAULT_QUERY_FRESH_MS;
  const enabled = options?.enabled ?? true;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => enabled ? subscribeQuery(def.key, listener) : () => {}, [def.key, enabled]),
    () => enabled ? getQuerySnapshot<T>(def.key) : DISABLED_QUERY_SNAPSHOT,
    () => enabled ? getQuerySnapshot<T>(def.key) : DISABLED_QUERY_SNAPSHOT,
  );

  useEffect(() => {
    if (!enabled) return;
    // Cache refreshers outlive any one component. Binding the stored fetcher
    // to this component's AbortSignal poisons later SSE invalidations after
    // unmount, so the shared cache owns the request lifetime.
    void ensureQuery(def.key, () => def.fetch(), freshMs);
    // Re-fetch on identity, freshness or admission changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- def.fetch is re-created per render on purpose; only def.key identifies the resource.
  }, [def.key, freshMs, enabled]);

  return snapshot;
}

/**
 * Manually trigger a re-fetch without waiting for SSE — a "Retry" button, a
 * "Refresh" button, or a poll loop.
 *
 * Ignores freshness always, and joins an in-flight read only while that read
 * is younger than `REFETCH_JOIN_WINDOW_MS`. Both halves matter, because this
 * one hook backs two different callers:
 *
 *   - A poll (UniverseView ticks every 3–15s and again on visibilitychange)
 *     landing on a read that started milliseconds ago SHOULD coalesce with
 *     it; issuing a second request there is pure waste.
 *   - A person's click landing on a read that has been running for seconds
 *     SHOULD NOT. That was the old behavior: the click joined the running
 *     promise and returned data fetched before the click — a silent no-op,
 *     and with local-model probes taking seconds under load the window was
 *     wide enough to hit in ordinary use.
 *
 * For the strict guarantee — a request issued after the click, every time,
 * no matter what else is running — use `useRefresh`.
 */
export function useRefetch<T>(def: QueryDef<T>): () => void {
  return useCallback(() => {
    void refetchQuery(def.key, () => def.fetch());
  }, [def]);
}

/**
 * The explicit user-initiated refresh: ALWAYS issues a new request, never
 * joins one already running, and the read it issues is the one whose result
 * is kept even if an older read lands after it.
 *
 * Use this behind anything a person presses that promises them a fresh
 * reading — a Refresh button on a surface with no SSE invalidation, where
 * the whole reason the button exists is that nothing else will re-read.
 */
export function useRefresh<T>(def: QueryDef<T>): () => void {
  return useCallback(() => {
    void refetchQuery(def.key, () => def.fetch(), true);
  }, [def]);
}

const getAuthPhase = (): AuthPhase => getAuthSnapshot().phase;
const getMutationHeldUntil = (): number | null => getAuthSnapshot().mutationTokenHeldUntil;

export function useAuthPhase(): AuthPhase {
  return useSyncExternalStore(subscribeAuth, getAuthPhase, getAuthPhase);
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
    getMutationHeldUntil,
    getMutationHeldUntil,
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
  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    void import('./sse.js').then(({ onSseEvent }) => {
      if (active) unsubscribe = onSseEvent(name, onEvent);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [name, onEvent]);
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
