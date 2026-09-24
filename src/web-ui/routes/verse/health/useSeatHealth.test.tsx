import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { evictAll, getQuerySnapshot, invalidate } from '../../../data/cache.js';
import { oneShotFetcher, VERSE_HEALTH_KEY } from './health-queries.js';
import { HEALTH_POLL_MS, useSeatHealth } from './useSeatHealth.js';

function Probe({ active = true }: { active?: boolean }) {
  useSeatHealth(active);
  return null;
}

function healthCalls(): number {
  const mock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
  return mock.mock.calls.filter(([input]) => String(input).includes('/api/verse/health')).length;
}

beforeEach(() => {
  evictAll();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ checkedAt: 'x', seats: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => { vi.useRealTimers(); });

describe('useSeatHealth', () => {
  it('reads on mount, polls every 30 s while visible, and never while hidden', async () => {
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(healthCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS); });
    expect(healthCalls()).toBe(2);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS * 4); });
    expect(healthCalls()).toBe(2);
    expect(getQuerySnapshot(VERSE_HEALTH_KEY).data).toEqual({ checkedAt: 'x', seats: [] });
  });

  it('is at least as slow as the 2 s polling floor', () => {
    expect(HEALTH_POLL_MS).toBeGreaterThanOrEqual(2_000);
  });
});

describe('oneShotFetcher', () => {
  it('answers once with the value in hand, then with the real read — so invalidation still refreshes', async () => {
    const real = vi.fn(async () => 'real');
    const fetcher = oneShotFetcher(async () => 'first', real);
    expect(await fetcher()).toBe('first');
    expect(await fetcher()).toBe('real');
    expect(real).toHaveBeenCalledTimes(1);
    invalidate('nothing-registered'); // no-op, never throws
  });
});
