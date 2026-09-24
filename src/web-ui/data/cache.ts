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
 *
 * ---------------------------------------------------------------------------
 * V2.1 — the request burst, and the three defects that lived in this file
 * ---------------------------------------------------------------------------
 *
 * Mounting the Usage section fires SEVEN reads at once (accounts, control,
 * bootstrap, usage-series, local-models, /api/control, /api/usage), several
 * of which spawn short-lived probe processes server-side. That burst starved
 * the 2s local-runtime probe timeout and made a healthy Ollama report as
 * unreachable roughly one burst in ten. The probe timeouts were hardened
 * server-side; the burst itself was still this file's problem. Three changes:
 *
 *   1. CONCURRENCY GATE. Every fetch this cache issues passes through a
 *      process-wide gate capped at QUERY_CONCURRENCY_LIMIT. The same seven
 *      reads still happen, but at most four are outstanding at once, so the
 *      server is never asked to run seven probe-spawning handlers in
 *      parallel. Nothing is dropped, nothing is delayed by a timer — a
 *      queued task starts the microtask a slot frees. The gate is what makes
 *      the probe timeout survivable, and it costs the caller nothing: the
 *      browser already caps at ~6 sockets per origin, so this is a cap the
 *      requests were going to hit anyway, applied where we can order it.
 *
 *   2. FRESHNESS. `ensureQuery(key, fetcher, maxAgeMs)` is the MOUNT path: it
 *      skips the request entirely when the cached value is younger than
 *      `maxAgeMs`. Re-entering a section you were just in is now zero
 *      requests instead of seven. `runQuery` keeps its old always-fetch
 *      semantics because the SSE layer and the prefetchers depend on it.
 *
 *   3. REFRESH THAT ACTUALLY RE-READS. `runQuery`'s in-flight de-dupe is
 *      right for two components mounting at once and WRONG for a person
 *      pressing Refresh: a click landing while a read is in flight joined
 *      the running promise and returned data fetched before the click — a
 *      silent no-op, and with local-models taking seconds under load the
 *      window was real. `refetchQuery` fixes it in two steps, because the
 *      same hook backs both a person's button and a 3s poll loop:
 *        - by default it joins an in-flight read ONLY while that read is
 *          younger than REFETCH_JOIN_WINDOW_MS. A poll tick landing on a
 *          read that started milliseconds ago still coalesces (which is the
 *          documented contract UniverseView's poll relies on); a click
 *          landing on a read that started seconds ago issues a new request.
 *        - with `force` it never joins at all. That is the strict guarantee
 *          for an explicit user-initiated refresh (hooks.ts `useRefresh`).
 *      Either way a newer request SUPERSEDES an older one by sequence
 *      number, so the last read ISSUED is the one whose result is kept even
 *      if an earlier one lands later.
 *
 * And the latent one: `evictAll()` used to call `store.clear()`, which
 * dropped the Bookkeeping objects that mounted components had registered
 * their `useSyncExternalStore` listeners on. Those components stayed
 * subscribed to an orphan Set that nothing would ever notify again — they
 * would never re-render for the rest of their life. Evict now RESETS an
 * entry that still has subscribers (and deletes only the unobserved ones),
 * so a subscriber always survives an evict.
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
  /** Sequence number of the newest request ISSUED for this key. */
  issued: number;
  /** `Date.now()` when that newest request was issued. */
  issuedAt: number;
  /** Highest sequence number whose result has been written to `snapshot`. */
  applied: number;
}

const IDLE_SNAPSHOT: QueryEntry<unknown> = { data: undefined, error: undefined, status: 'idle', updatedAt: null };

const store = new Map<string, Bookkeeping>();

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

/**
 * How many cache-issued fetches may be outstanding at once, process-wide.
 *
 * Four, not one: the point is to stop a seven-way burst from spawning seven
 * concurrent server-side probes, not to serialize the app. Four keeps a
 * section's first paint fast while leaving the server two of its six sockets
 * for the SSE stream and any non-cache request.
 */
export const QUERY_CONCURRENCY_LIMIT = 4;

let activeFetches = 0;
const gateQueue: (() => void)[] = [];
/** Peak concurrency observed since the gate was last reset. */
let peakConcurrency = 0;
/**
 * Bumped by `resetQueryGate`. A fetch issued under an older generation no
 * longer owns a slot, so its eventual settlement must not decrement the new
 * generation's count — otherwise a request that never settles (a hung
 * socket, or a test stubbing fetch with a promise that never resolves) would
 * permanently consume capacity and starve every later read.
 */
let gateGeneration = 0;

function releaseSlot(): void {
  activeFetches -= 1;
  const next = gateQueue.shift();
  if (next) next();
}

/**
 * Run `task` when a slot is free. Purely promise-driven — no timers, so this
 * is safe under fake timers and adds no latency beyond one microtask.
 */
function schedule<T>(task: () => Promise<T>): Promise<T> {
  const start = (): Promise<T> => {
    const generation = gateGeneration;
    activeFetches += 1;
    if (activeFetches > peakConcurrency) peakConcurrency = activeFetches;
    const done = (): void => {
      if (generation === gateGeneration) releaseSlot();
    };
    let running: Promise<T>;
    try {
      running = task();
    } catch (err) {
      // A fetcher that throws synchronously must still free its slot.
      done();
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return running.then(
      (value) => {
        done();
        return value;
      },
      (err: unknown) => {
        done();
        throw err;
      },
    );
  };

  if (activeFetches < QUERY_CONCURRENCY_LIMIT) return start();
  return new Promise<T>((resolve, reject) => {
    gateQueue.push(() => {
      start().then(resolve, reject);
    });
  });
}

/**
 * Abandon the gate's accounting: forget how many fetches are outstanding and
 * let everything queued run now. Called from `evictAll()`, which is both the
 * logout path and every test's `beforeEach` — a read that outlives the state
 * it was issued for has no claim on the next one's capacity.
 *
 * Nothing is cancelled. Requests already in flight still settle and still
 * write their result unless the key was evicted underneath them.
 */
export function resetQueryGate(): void {
  gateGeneration += 1;
  activeFetches = 0;
  peakConcurrency = 0;
  for (const start of gateQueue.splice(0)) start();
}

/**
 * What the gate is doing right now. The tests read it, and so does the shell's
 * idle warm-up (routes/verse/shell/warmup.ts): it starts nothing while any
 * read is running or queued here.
 */
export function queryGateStats(): { active: number; queued: number; peak: number } {
  return { active: activeFetches, queued: gateQueue.length, peak: peakConcurrency };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function entryFor<T>(key: string): Bookkeeping<T> {
  let e = store.get(key) as Bookkeeping<T> | undefined;
  if (!e) {
    e = {
      snapshot: IDLE_SNAPSHOT as QueryEntry<T>,
      inFlight: null,
      fetcher: null,
      subscribers: new Set(),
      issued: 0,
      issuedAt: 0,
      applied: 0,
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

/**
 * Structural equality for API payloads, used to decide whether a refresh
 * actually changed anything.
 *
 * A Refresh that re-reads seven routes and finds six of them byte-identical
 * should re-render nothing for those six. Keeping the PREVIOUS `data`
 * reference when the new body is deep-equal does exactly that: the snapshot
 * object still changes (status and updatedAt did), so useSyncExternalStore
 * still fires, but every `useMemo`/`memo` keyed on `data` downstream skips —
 * and the Usage section's models are all keyed on `data`.
 *
 * Deliberately structural rather than JSON.stringify: key order is not
 * significant in these payloads, and stringify would also throw on the
 * (never-seen, but cheap to survive) cyclic body.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameData(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((k) => Object.prototype.hasOwnProperty.call(right, k) && sameData(left[k], right[k]));
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
 * How long an in-flight read is accepted as already satisfying a refetch.
 *
 * A poll tick (UniverseView refreshes every 3–15s and again on
 * visibilitychange) that lands on a read issued milliseconds ago should
 * coalesce with it — that is the behavior its own comment and tests pin
 * down. A person's Refresh landing on a read that has been running for
 * seconds should not: they are asking about the world as of the click.
 */
export const REFETCH_JOIN_WINDOW_MS = 250;

export interface QueryRunOptions {
  /**
   * Skip the request when the cached value is younger than this many ms.
   * Undefined (the default) always fetches.
   */
  maxAgeMs?: number;
  /**
   * Join an in-flight read only while it is younger than this. Undefined
   * joins any in-flight read (the original de-dupe).
   */
  joinWindowMs?: number;
  /**
   * User-initiated. Never joins an in-flight read and never honours
   * `maxAgeMs` — pressing Refresh must produce a request that was issued
   * after the click.
   */
  force?: boolean;
}

function isFresh(e: Bookkeeping, maxAgeMs: number): boolean {
  if (e.snapshot.updatedAt === null) return false;
  if (e.snapshot.status === 'error') return false;
  return Date.now() - e.snapshot.updatedAt < maxAgeMs;
}

function mayJoin(e: Bookkeeping, options: QueryRunOptions): boolean {
  if (e.inFlight === null) return false;
  if (options.joinWindowMs === undefined) return true;
  return Date.now() - e.issuedAt < options.joinWindowMs;
}

function execute<T>(key: string, fetcher: () => Promise<T>, options: QueryRunOptions): Promise<void> {
  const e = entryFor<T>(key);
  e.fetcher = fetcher;

  if (!options.force) {
    // Two components mounting at once share one request.
    if (mayJoin(e, options)) return e.inFlight!;
    // Already fresh enough for this caller: no request at all.
    if (options.maxAgeMs !== undefined && isFresh(e, options.maxAgeMs)) return Promise.resolve();
  }

  const seq = (e.issued += 1);
  e.issuedAt = Date.now();
  setSnapshot(e, { status: e.snapshot.data !== undefined ? 'refreshing' : 'loading' });
  notify(key);

  const run = schedule(fetcher)
    .then((data) => {
      // A superseded request (a forced refresh was issued after this one, or
      // the key was evicted) must never overwrite a newer answer.
      if (seq < e.applied) return;
      e.applied = seq;
      const unchanged = e.snapshot.data !== undefined && sameData(e.snapshot.data, data);
      setSnapshot(e, {
        data: unchanged ? e.snapshot.data : data,
        error: undefined,
        status: 'success',
        updatedAt: Date.now(),
      });
    })
    .catch((err: unknown) => {
      if (seq < e.applied) return;
      e.applied = seq;
      setSnapshot(e, { error: err instanceof Error ? err : new Error(String(err)), status: 'error' });
    })
    .finally(() => {
      // Only the newest request owns `inFlight`; an older, superseded one
      // finishing must not clear the newer one's slot.
      if (e.issued === seq) e.inFlight = null;
      notify(key);
    });

  e.inFlight = run;
  return run;
}

/**
 * Kick off (or join) a fetch for `key`. Safe to call redundantly — repeated
 * calls with an in-flight fetch are no-ops. Registers `fetcher` on the
 * entry so invalidate() can re-run it later without the caller re-supplying
 * it (e.g. from the SSE layer, which doesn't have per-view fetch closures).
 */
export function runQuery<T>(key: string, fetcher: () => Promise<T>): Promise<void> {
  return execute(key, fetcher, {});
}

/**
 * The MOUNT path (hooks.ts `useQuery`). Identical to `runQuery` except that a
 * value fetched less than `maxAgeMs` ago is accepted as-is and no request is
 * made. This is what turns "switch to Usage and back" from fourteen requests
 * into seven.
 */
export function ensureQuery<T>(key: string, fetcher: () => Promise<T>, maxAgeMs: number): Promise<void> {
  return execute(key, fetcher, { maxAgeMs });
}

/**
 * The REFRESH path (hooks.ts `useRefetch` / `useRefresh`).
 *
 * Default (`force: false`): joins an in-flight read only while that read is
 * younger than REFETCH_JOIN_WINDOW_MS, so a burst of poll ticks still
 * collapses into one request while a click on a long-running read gets a
 * real re-read.
 *
 * `force: true`: never joins. Always issues a request made after the call,
 * and wins the race against anything already running regardless of which
 * lands first. This is the guarantee an explicit user-initiated refresh
 * needs.
 */
export function refetchQuery<T>(key: string, fetcher: () => Promise<T>, force = false): Promise<void> {
  return execute(key, fetcher, force ? { force: true } : { joinWindowMs: REFETCH_JOIN_WINDOW_MS });
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

/**
 * `invalidatePrefix`, but only for keys a mounted component is SUBSCRIBED to.
 *
 * The read-session renewal sweep (auth-store.ts) uses it. An entry nobody is
 * reading — a surface the shell's idle warm-up fetched but the operator never
 * opened, or one they left — is left exactly as it is: whoever mounts it next
 * goes through `ensureQuery`, which re-reads it if it is older than that
 * caller accepts or if it failed (a read that 401ed is 'error', never fresh).
 * Re-running those fetchers on every 15-minute renewal was pure background
 * traffic through the same gate as the chat reads waiting on their retry.
 */
export function invalidateObserved(prefix: string): void {
  for (const [key, e] of store) {
    if (e.subscribers.size > 0 && key.startsWith(prefix)) invalidate(key);
  }
}

/**
 * Reset one entry to idle WITHOUT dropping its subscriber set, and supersede
 * anything still in flight for it so a late result cannot repopulate the key
 * after it was deliberately cleared.
 */
function resetEntry(key: string, e: Bookkeeping): void {
  e.snapshot = IDLE_SNAPSHOT as QueryEntry<unknown>;
  e.fetcher = null;
  e.inFlight = null;
  e.issued += 1;
  e.applied = e.issued;
  notify(key);
}

/** Drop a key entirely (rare — e.g. on logout, so stale data never leaks
 * into the next session's first paint). An entry that still has mounted
 * subscribers is RESET rather than deleted: deleting it would orphan the
 * listener set those components registered on, leaving them subscribed to
 * something nothing can notify. */
export function evict(key: string): void {
  const e = store.get(key);
  if (!e) return;
  if (e.subscribers.size === 0) {
    store.delete(key);
    return;
  }
  resetEntry(key, e);
}

export function evictAll(): void {
  resetQueryGate();
  for (const [key, e] of [...store]) {
    if (e.subscribers.size === 0) {
      store.delete(key);
      continue;
    }
    resetEntry(key, e);
  }
}
