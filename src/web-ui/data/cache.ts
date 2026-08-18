/**
 * data/cache.ts — the resource cache every view reads through. This is what
 * makes tab switches instant instead of blanking to "Loading…": a resource
 * fetched once stays in the cache and renders immediately (possibly stale)
 * on the next mount, with a background refresh kicked off silently behind
 * it. No framework dependency — a plain keyed store consumed via
 * useSyncExternalStore (see hooks.ts), matching the pattern already used
 * for auth-store.ts.
 *
 * Design choices, spelled out because a future agent will extend this:
 *   - In-flight de-dupe: two components requesting the same key at once
 *     share one fetch, not two.
 *   - Never clears `data` on refetch. `status` distinguishes 'loading'
 *     (no data yet — show a skeleton) from 'refreshing' (stale data still
 *     shown — show a subtle indicator) from 'success'/'error'.
 *   - `invalidate(key)` is how the SSE layer (sse.ts) tells the cache "the
 *     server just told us this changed" without either module importing
 *     React.
 *   - useSyncExternalStore requires getSnapshot() to return a NEW object
 *     reference whenever the observable state actually changes (it detects
 *     updates via Object.is, not deep equality) — mutating one long-lived
 *     entry object in place and handing back the same reference would fire
 *     subscribers that never actually re-render. Every state transition
 *     below therefore replaces `bookkeeping.snapshot` wholesale instead of
 *     patching fields on it.
 */

export type QueryStatus = 'idle' | 'loading' | 'refreshing' | 'success' | 'error';

export interface QueryEntry<T> {
  data: T | undefined;
  error: Error | undefined;
  status: QueryStatus;
  updatedAt: number | null;
}

interface Bookkeeping<T = unknown> {
  snapshot: QueryEntry<T>;
  inFlight: Promise<void> | null;
  fetcher: (() => Promise<T>) | null;
  subscribers: Set<() => void>;
}

const IDLE_SNAPSHOT: QueryEntry<unknown> = { data: undefined, error: undefined, status: 'idle', updatedAt: null };

const store = new Map<string, Bookkeeping>();

function entryFor<T>(key: string): Bookkeeping<T> {
  let e = store.get(key) as Bookkeeping<T> | undefined;
  if (!e) {
    e = {
      snapshot: IDLE_SNAPSHOT as QueryEntry<T>,
      inFlight: null,
      fetcher: null,
      subscribers: new Set(),
    };
    store.set(key, e);
  }
  return e;
}

function setSnapshot<T>(e: Bookkeeping<T>, patch: Partial<QueryEntry<T>>): void {
  e.snapshot = { ...e.snapshot, ...patch };
}

function notify(key: string): void {
  const e = store.get(key);
  if (!e) return;
  for (const s of e.subscribers) s();
}

export function subscribeQuery(key: string, listener: () => void): () => void {
  const e = entryFor(key);
  e.subscribers.add(listener);
  return () => {
    e.subscribers.delete(listener);
  };
}

export function getQuerySnapshot<T>(key: string): QueryEntry<T> {
  return entryFor<T>(key).snapshot;
}

/**
 * Kick off (or join) a fetch for `key`. Safe to call redundantly — repeated
 * calls with an in-flight fetch are no-ops. Registers `fetcher` on the
 * entry so invalidate() can re-run it later without the caller re-supplying
 * it (e.g. from the SSE layer, which doesn't have per-view fetch closures).
 */
export function runQuery<T>(key: string, fetcher: () => Promise<T>): Promise<void> {
  const e = entryFor<T>(key);
  e.fetcher = fetcher;
  if (e.inFlight) return e.inFlight;

  setSnapshot(e, { status: e.snapshot.data !== undefined ? 'refreshing' : 'loading' });
  notify(key);

  e.inFlight = fetcher()
    .then((data) => {
      setSnapshot(e, { data, error: undefined, status: 'success', updatedAt: Date.now() });
    })
    .catch((err: unknown) => {
      setSnapshot(e, { error: err instanceof Error ? err : new Error(String(err)), status: 'error' });
    })
    .finally(() => {
      e.inFlight = null;
      notify(key);
    });

  return e.inFlight;
}

/** Re-run the last fetcher registered for `key`, if any (used by sse.ts). */
export function invalidate(key: string): void {
  const e = store.get(key);
  if (!e || !e.fetcher) return;
  void runQuery(key, e.fetcher);
}

/** Re-run the fetcher for every cached key starting with `prefix`. For
 * parameterized resources (per-filter inbox list queries, per-id inbox
 * detail queries) the exact live key isn't known ahead of time — used by
 * sse.ts and data/mutations.ts so those views live-update too. */
export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) invalidate(key);
  }
}

/** Drop a key entirely (rare — e.g. on logout, so stale data never leaks
 * into the next session's first paint). */
export function evict(key: string): void {
  store.delete(key);
}

export function evictAll(): void {
  store.clear();
}
