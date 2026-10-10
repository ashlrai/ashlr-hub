import { apiGet, METADATA_JSON_READ_TIMEOUT_MS } from './client.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  runQuery,
  ensureQuery,
  refetchQuery,
  getQuerySnapshot,
  subscribeQuery,
  invalidate,
  invalidateObserved,
  evict,
  evictAll,
  queryGateStats,
  QUERY_CONCURRENCY_LIMIT,
  REFETCH_JOIN_WINDOW_MS,
} from './cache.js';

/** A fetcher whose settlement this test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the microtask queue drain, including the gate's own hops. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('cache', () => {
  beforeEach(() => {
    evictAll();
  });

  it('de-dupes concurrent fetches for the same key', async () => {
    let calls = 0;
    const fetcher = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(1), 10);
      });

    const p1 = runQuery('k', fetcher);
    const p2 = runQuery('k', fetcher);
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(getQuerySnapshot('k').data).toBe(1);
    expect(getQuerySnapshot('k').status).toBe('success');
  });

  it('never clears stale data while refreshing — status is "refreshing", not "loading"', async () => {
    let n = 0;
    const fetcher = () => Promise.resolve(++n);

    await runQuery('k', fetcher);
    expect(getQuerySnapshot('k').data).toBe(1);

    const refreshPromise = runQuery('k', fetcher);
    // Synchronously right after kicking off the refetch, stale data must
    // still be present so a subscribed view never blanks.
    expect(getQuerySnapshot('k').data).toBe(1);
    expect(getQuerySnapshot('k').status).toBe('refreshing');

    await refreshPromise;
    expect(getQuerySnapshot('k').data).toBe(2);
    expect(getQuerySnapshot('k').status).toBe('success');
  });

  it('notifies subscribers on every state transition', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQuery('k', listener);
    await runQuery('k', () => Promise.resolve('x'));
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('captures the error and leaves status "error" on rejection', async () => {
    await runQuery('k', () => Promise.reject(new Error('boom')));
    const snap = getQuerySnapshot('k');
    expect(snap.status).toBe('error');
    expect(snap.error?.message).toBe('boom');
  });

  it('invalidate() re-runs the last registered fetcher for that key', async () => {
    let n = 0;
    await runQuery('k', () => Promise.resolve(++n));
    expect(getQuerySnapshot('k').data).toBe(1);
    invalidate('k');
    await Promise.resolve();
    await Promise.resolve();
    expect(getQuerySnapshot('k').data).toBe(2);
  });

  it('invalidate() on a key with no registered fetcher is a safe no-op', () => {
    expect(() => invalidate('never-fetched')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Freshness — the mount path
// ---------------------------------------------------------------------------

describe('cache — ensureQuery freshness', () => {
  beforeEach(() => {
    evictAll();
  });

  it('skips the request entirely when the cached value is younger than maxAgeMs', async () => {
    const fetcher = vi.fn(async () => 'v1');
    await ensureQuery('k', fetcher, 10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await ensureQuery('k', fetcher, 10_000);
    await ensureQuery('k', fetcher, 10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getQuerySnapshot('k').data).toBe('v1');
    expect(getQuerySnapshot('k').status).toBe('success');
  });

  it('re-reads once the value is older than maxAgeMs', async () => {
    const fetcher = vi.fn(async () => 'v');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await ensureQuery('k', fetcher, 5_000);
    now.mockReturnValue(1_000 + 5_001);
    await ensureQuery('k', fetcher, 5_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('never treats a failed read as fresh — an error always re-reads', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    await ensureQuery('k', fetcher, 60_000);
    await ensureQuery('k', fetcher, 60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getQuerySnapshot('k').status).toBe('error');
  });

  it('maxAgeMs of 0 always fetches', async () => {
    const fetcher = vi.fn(async () => 'v');
    await ensureQuery('k', fetcher, 0);
    await ensureQuery('k', fetcher, 0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Refresh — the defect this file existed to fix
// ---------------------------------------------------------------------------

describe('cache — refetchQuery', () => {
  it('forces only observed matching keys past a pre-write read and preserves the newer result', async () => {
    const key = 'verse-multimodel-context:?sessionId=one';
    const detach = subscribeQuery(key, vi.fn());
    const old = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('new turn');
    const hidden = vi.fn(async () => 'hidden');
    const provider = vi.fn(async () => 'provider');
    await runQuery('verse-multimodel-context:unmounted', hidden);
    const detachProvider = subscribeQuery('verse-usage-accounts', vi.fn());
    await runQuery('verse-usage-accounts', provider);
    const pending = runQuery(key, fetcher);
    await settle();
    invalidateObserved('verse-multimodel-context:', true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getQuerySnapshot(key).data).toBe('new turn');
    old.resolve('old turn');
    await pending;
    expect(getQuerySnapshot(key).data).toBe('new turn');
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
    detach(); detachProvider();
  });
  beforeEach(() => {
    evictAll();
  });

  it('forced: issues a NEW read even while one is in flight, instead of joining it', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn(() => (fetcher.mock.calls.length === 1 ? first.promise : second.promise));

    void runQuery('k', fetcher);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The click. The old cache joined `first` here and the press did nothing.
    const clicked = refetchQuery('k', fetcher, true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    second.resolve('after-the-click');
    await clicked;
    expect(getQuerySnapshot('k').data).toBe('after-the-click');
  });

  it('forced: a slower EARLIER read cannot overwrite the result of the newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn(() => (fetcher.mock.calls.length === 1 ? first.promise : second.promise));

    void runQuery('k', fetcher);
    await settle();
    void refetchQuery('k', fetcher, true);
    await settle();

    second.resolve('newest');
    await settle();
    expect(getQuerySnapshot('k').data).toBe('newest');

    // The stale read lands last and must be discarded, not rendered.
    first.resolve('stale');
    await settle();
    expect(getQuerySnapshot('k').data).toBe('newest');
  });

  it('unforced: still coalesces with a read issued moments ago (the poll case)', async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);

    void runQuery('k', fetcher);
    await settle();
    void refetchQuery('k', fetcher);
    void refetchQuery('k', fetcher);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    pending.resolve('v');
    await settle();
  });

  it('unforced: does NOT coalesce with a read that has been running longer than the join window', async () => {
    const pending = deferred<string>();
    const fresh = deferred<string>();
    const fetcher = vi.fn(() => (fetcher.mock.calls.length === 1 ? pending.promise : fresh.promise));
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(10_000);
    void runQuery('k', fetcher);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    now.mockReturnValue(10_000 + REFETCH_JOIN_WINDOW_MS + 1);
    void refetchQuery('k', fetcher);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    now.mockRestore();
    pending.resolve('slow');
    fresh.resolve('fresh');
    await settle();
  });

  it.each(['success', 'error'] as const)('a superseded %s cannot clear the latest pending refresh or alter its cached reading', async (result) => {
    await runQuery('k', async () => 'previous');
    const old = deferred<string>();
    const fresh = deferred<string>();
    const oldRead = refetchQuery('k', () => old.promise, true);
    const newRead = refetchQuery('k', () => fresh.promise, true);
    if (result === 'success') old.resolve('stale');
    else old.reject(new Error('Old failure'));
    await oldRead;
    expect(getQuerySnapshot('k')).toMatchObject({ data: 'previous', status: 'refreshing', error: undefined });
    // A normal joining read still belongs to the pending latest generation.
    const another = vi.fn(async () => 'unwanted');
    const joined = runQuery('k', another);
    expect(another).not.toHaveBeenCalled();
    fresh.resolve('fresh');
    await Promise.all([newRead, joined]);
    expect(getQuerySnapshot('k')).toMatchObject({ data: 'fresh', status: 'success' });
  });

  it('forced: ignores freshness, unlike the mount path', async () => {
    const fetcher = vi.fn(async () => 'v');
    await ensureQuery('k', fetcher, 60_000);
    await refetchQuery('k', fetcher, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// An unchanged body must not churn `data` identity
// ---------------------------------------------------------------------------

describe('cache — unchanged payloads', () => {
  beforeEach(() => {
    evictAll();
  });

  it('keeps the previous data reference when the refreshed body is deep-equal', async () => {
    const fetcher = vi.fn(async () => ({ accounts: [{ id: 'claude', used: 47 }], note: null }));
    await runQuery('k', fetcher);
    const first = getQuerySnapshot('k').data;

    await refetchQuery('k', fetcher, true);
    const second = getQuerySnapshot('k').data;

    // Same reference: every memo keyed on `data` downstream skips its work.
    expect(second).toBe(first);
    // The snapshot itself still changed, so subscribers still hear about it.
    expect(getQuerySnapshot('k').status).toBe('success');
  });

  it('swaps the reference the moment anything in the body differs', async () => {
    let used = 47;
    const fetcher = vi.fn(async () => ({ accounts: [{ id: 'claude', used }] }));
    await runQuery('k', fetcher);
    const first = getQuerySnapshot('k').data;

    used = 48;
    await refetchQuery('k', fetcher, true);
    expect(getQuerySnapshot('k').data).not.toBe(first);
    expect(getQuerySnapshot('k').data).toEqual({ accounts: [{ id: 'claude', used: 48 }] });
  });
});

// ---------------------------------------------------------------------------
// The concurrency gate — the burst fix
// ---------------------------------------------------------------------------

describe('cache — concurrency gate', () => {
  beforeEach(() => {
    evictAll();
  });

  it('never runs more than QUERY_CONCURRENCY_LIMIT fetches at once, and runs them all', async () => {
    let live = 0;
    let peak = 0;
    const done: (() => void)[] = [];
    const make = (key: string) =>
      runQuery(key, () => {
        live += 1;
        peak = Math.max(peak, live);
        return new Promise<string>((resolve) => {
          done.push(() => {
            live -= 1;
            resolve(key);
          });
        });
      });

    // The Usage section's seven reads.
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(make);
    await settle();
    expect(peak).toBe(QUERY_CONCURRENCY_LIMIT);
    expect(queryGateStats().queued).toBe(7 - QUERY_CONCURRENCY_LIMIT);

    // Draining the running ones admits the queued ones, until all seven ran.
    while (done.length > 0) {
      done.shift()!();
      await settle();
    }
    await Promise.all(all);
    expect(peak).toBe(QUERY_CONCURRENCY_LIMIT);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(getQuerySnapshot(key).data).toBe(key);
    }
  });

  it('a fetch that never settles cannot permanently consume a slot — evictAll frees it', async () => {
    for (const key of ['a', 'b', 'c', 'd']) void runQuery(key, () => new Promise<never>(() => {}));
    await settle();
    expect(queryGateStats().active).toBe(QUERY_CONCURRENCY_LIMIT);

    evictAll();
    expect(queryGateStats().active).toBe(0);

    const after = vi.fn(async () => 'ok');
    await runQuery('later', after);
    expect(after).toHaveBeenCalledTimes(1);
    expect(getQuerySnapshot('later').data).toBe('ok');
  });

  it('a fetcher that throws synchronously frees its slot', async () => {
    await runQuery('bad', () => {
      throw new Error('sync boom');
    }).catch(() => undefined);
    await settle();
    expect(queryGateStats().active).toBe(0);
    expect(getQuerySnapshot('bad').status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Evict must not orphan a mounted component's listener
// ---------------------------------------------------------------------------

describe('cache — evict keeps subscribers', () => {
  beforeEach(() => {
    evictAll();
  });

  it('evictAll() resets a subscribed key instead of dropping its listener set', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQuery('k', listener);
    await runQuery('k', async () => 'v1');
    expect(getQuerySnapshot('k').data).toBe('v1');

    listener.mockClear();
    evictAll();
    // The evict itself is an observable transition.
    expect(listener).toHaveBeenCalled();
    expect(getQuerySnapshot('k').status).toBe('idle');
    expect(getQuerySnapshot('k').data).toBeUndefined();

    // And the still-mounted component keeps hearing about later reads. Before
    // the fix this assertion failed: store.clear() orphaned the Set above.
    listener.mockClear();
    await runQuery('k', async () => 'v2');
    expect(listener).toHaveBeenCalled();
    expect(getQuerySnapshot('k').data).toBe('v2');
    unsubscribe();
  });

  it('evict(key) does the same for one key, and deletes an unobserved one', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQuery('watched', listener);
    await runQuery('watched', async () => 'v');
    await runQuery('unwatched', async () => 'v');

    evict('watched');
    evict('unwatched');

    listener.mockClear();
    await runQuery('watched', async () => 'v2');
    expect(listener).toHaveBeenCalled();
    expect(getQuerySnapshot('unwatched').status).toBe('idle');
    unsubscribe();
  });

  it('a read in flight when its key is evicted cannot repopulate it afterwards', async () => {
    const pending = deferred<string>();
    const unsubscribe = subscribeQuery('k', vi.fn());
    void runQuery('k', () => pending.promise);
    await settle();

    evictAll();
    pending.resolve('too late');
    await settle();

    expect(getQuerySnapshot('k').status).toBe('idle');
    expect(getQuerySnapshot('k').data).toBeUndefined();
    unsubscribe();
  });
});


describe('cache — finite HTTP metadata lifetime', () => {
  it('retains warm data on timeout and a detached sibling does not cancel the shared read', async () => {
    vi.useFakeTimers();
    evictAll();
    try {
      await runQuery('finite', async () => ({ pid: 123 }));
      let passed!: AbortSignal;
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => {
        passed = init.signal!;
        if (++attempt > 1) return Promise.resolve(Response.json({ pid: 456 }));
        return new Promise<Response>((_resolve, reject) => passed.addEventListener('abort', () => reject(passed.reason), { once: true }));
      }));
      const first = vi.fn(); const sibling = vi.fn();
      const detach = subscribeQuery('finite', first);
      const detachSibling = subscribeQuery('finite', sibling);
      const read = runQuery('finite', () => apiGet('/api/verse/control'));
      detach();
      expect(passed.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS);
      await read;
      expect(getQuerySnapshot('finite')).toMatchObject({ data: { pid: 123 }, status: 'error' });
      expect(getQuerySnapshot('finite').error).toMatchObject({ message: 'AbortError: The read timed out. Try again.' });
      expect(sibling).toHaveBeenCalled();
      await refetchQuery('finite', () => apiGet('/api/verse/control'), true);
      expect(getQuerySnapshot('finite')).toMatchObject({ data: { pid: 456 }, status: 'success', error: undefined });
      detachSibling();
    } finally { evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it('does not release a slot on a timeout until a noncooperating fetch actually settles', async () => {
    vi.useFakeTimers();
    evictAll();
    try {
      const finish: ((value: Response) => void)[] = [];
      vi.stubGlobal('fetch', vi.fn((path: string) => path === '/healthy'
        ? Promise.resolve(Response.json('fresh'))
        : new Promise<Response>(resolve => { finish.push(resolve); })));
      const pending = Array.from({ length: 4 }, (_, i) => runQuery(`stalled-${i}`, () => apiGet(`/stalled-${i}`)));
      const queued = runQuery('healthy', () => apiGet('/healthy'));
      await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS);
      expect(queryGateStats()).toMatchObject({ active: 4, queued: 1, peak: 4 });
      finish.shift()!(Response.json('late'));
      await queued;
      expect(getQuerySnapshot('stalled-0')).toMatchObject({ status: 'error', data: undefined });
      expect(getQuerySnapshot('stalled-0').error).toMatchObject({ message: 'AbortError: The read timed out. Try again.' });
      expect(getQuerySnapshot('healthy').data).toBe('fresh');
      expect(queryGateStats().peak).toBe(4);
      finish.forEach(resolve => resolve(Response.json('late')));
      await Promise.all(pending);
      expect(queryGateStats().active).toBe(0);
    } finally { evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
