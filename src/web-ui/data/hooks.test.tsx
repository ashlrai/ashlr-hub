import { StrictMode, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot, invalidateObserved, refetchQuery, runQuery } from './cache.js';
import { useQuery } from './hooks.js';

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
const idle = { data: undefined, error: undefined, status: 'idle', updatedAt: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); });

describe('useQuery optional admission', () => {
  it('keeps a disabled StrictMode consumer stably idle without observing warm data', async () => {
    const fetch = vi.fn(async () => 'new');
    const query = { key: 'optional', fetch };
    await runQuery(query.key, async () => 'old');
    const hook = renderHook(() => useQuery(query, { enabled: false }), { wrapper: strict });
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
    expect(first).toEqual(idle);
    await act(async () => { invalidateObserved(query.key); });
    expect(fetch).not.toHaveBeenCalled();
    expect(getQuerySnapshot(query.key).data).toBe('old');
  });

  it('starts once when enabled, detaches when disabled and reuses fresh data on re-enable', async () => {
    const query = { key: 'optional', fetch: vi.fn(async () => 'reading') };
    const hook = renderHook(({ enabled }) => useQuery(query, { enabled }), { initialProps: { enabled: false }, wrapper: strict });
    expect(query.fetch).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.data).toBe('reading'));
    expect(query.fetch).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: false });
    expect(hook.result.current).toEqual(idle);
    await act(async () => { invalidateObserved(query.key); });
    expect(query.fetch).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: true });
    expect(hook.result.current.data).toBe('reading');
    await settle();
    expect(query.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a shared read when its enabled consumer leaves', async () => {
    const pending = deferred<string>();
    const query = { key: 'optional', fetch: vi.fn(() => pending.promise) };
    const disabled = renderHook(({ enabled }) => useQuery(query, { enabled }), { initialProps: { enabled: false } });
    const enabled = renderHook(({ active }) => useQuery(query, { enabled: active }), { initialProps: { active: true } });
    const sibling = renderHook(() => useQuery(query));
    expect(query.fetch).toHaveBeenCalledTimes(1);
    enabled.rerender({ active: false });
    await act(async () => { pending.resolve('shared'); });
    expect(sibling.result.current.data).toBe('shared');
    expect(enabled.result.current).toEqual(idle);
    sibling.unmount();
    expect(getQuerySnapshot(query.key).data).toBe('shared');
    expect(disabled.result.current).toEqual(idle);
    await act(async () => { invalidateObserved(query.key); });
    expect(query.fetch).toHaveBeenCalledTimes(1);
    disabled.rerender({ enabled: true });
    expect(disabled.result.current.data).toBe('shared');
  });

  it('preserves default/true deduplication, forced errors with warm data and observed refresh', async () => {
    const query = { key: 'optional', fetch: vi.fn(async () => 'first') };
    const first = renderHook(() => useQuery(query));
    const second = renderHook(() => useQuery(query, { enabled: true }));
    await waitFor(() => expect(first.result.current.data).toBe('first'));
    expect(second.result.current.data).toBe('first');
    expect(query.fetch).toHaveBeenCalledTimes(1);
    const failure = new Error('Read unavailable');
    await act(async () => { await refetchQuery(query.key, async () => { throw failure; }, true); });
    expect(first.result.current).toMatchObject({ status: 'error', error: failure, data: 'first' });
    // Restore the real query fetcher, just as a subsequent mount would do.
    const third = renderHook(() => useQuery(query));
    await waitFor(() => expect(third.result.current.status).toBe('success'));
    query.fetch.mockResolvedValue('new');
    await act(async () => { invalidateObserved(query.key); });
    await waitFor(() => expect(second.result.current.data).toBe('new'));
    expect(first.result.current.data).toBe('new');
  });

  it('does not republish an evicted account reading while disabled', async () => {
    const pending = deferred<string>();
    const query = { key: 'optional', fetch: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue('new-account') };
    const hook = renderHook(({ enabled }) => useQuery(query, { enabled }), { initialProps: { enabled: true } });
    hook.rerender({ enabled: false });
    evictAll();
    await act(async () => { pending.resolve('old-account'); });
    expect(hook.result.current).toEqual(idle);
    expect(getQuerySnapshot(query.key).data).toBeUndefined();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.data).toBe('new-account'));
    expect(query.fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores key changes and cache updates while disabled, then reads only its enabled key', async () => {
    const first = { key: 'first', fetch: vi.fn(async () => 'first-value') };
    const second = { key: 'second', fetch: vi.fn(async () => 'second-value') };
    let renders = 0;
    const hook = renderHook(({ query, enabled }) => {
      renders += 1;
      return useQuery(query, { enabled });
    }, { initialProps: { query: first, enabled: false } });
    const initial = hook.result.current;
    hook.rerender({ query: second, enabled: false });
    expect(hook.result.current).toBe(initial);
    const before = renders;
    await act(async () => { await runQuery(second.key, async () => 'other-reader'); });
    expect(renders).toBe(before);
    expect(first.fetch).not.toHaveBeenCalled();
    expect(second.fetch).not.toHaveBeenCalled();
    // Invalidate the stored value so admission must issue a real read for the new key.
    evictAll();
    hook.rerender({ query: second, enabled: true });
    await waitFor(() => expect(hook.result.current.data).toBe('second-value'));
    expect(second.fetch).toHaveBeenCalledTimes(1);
    expect(first.fetch).not.toHaveBeenCalled();
  });

  it('uses the same idle server snapshot without reading or exposing a warm key', async () => {
    const query = { key: 'optional', fetch: vi.fn(async () => 'new') };
    await runQuery(query.key, async () => 'private-warm');
    function ServerProbe() {
      const reading = useQuery(query, { enabled: false });
      return <span>{reading.status}:{String(reading.data)}</span>;
    }
    const rendered = document.createElement('div');
    rendered.innerHTML = renderToString(<ServerProbe />);
    expect(rendered.textContent).toBe('idle:undefined');
    expect(query.fetch).not.toHaveBeenCalled();
  });
});
