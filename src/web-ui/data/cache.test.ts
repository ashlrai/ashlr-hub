import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runQuery, getQuerySnapshot, subscribeQuery, invalidate, evictAll } from './cache.js';

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
