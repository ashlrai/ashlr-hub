/**
 * useSeatsRefresh.test.tsx — the other half of "usage is not showing".
 *
 * `/api/verse/bootstrap` carries the seats and has no SSE invalidation, so it
 * is re-read only on mount and after a write. The account collector needs
 * roughly a cycle and a half — about 75 seconds measured — before its first
 * readings exist. Open the app cold and the one read that ever happens lands
 * BEFORE any reading exists, so every seat reads "unknown" for the rest of
 * the session no matter how correctly the panel renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { SEATS_POLL_MS, useSeatsRefresh } from './useSeatsRefresh.js';

function Probe({ active = true }: { active?: boolean }) {
  useSeatsRefresh(active);
  return null;
}

function bootstrapCalls(): number {
  const mock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
  return mock.mock.calls.filter(([input]) => String(input).includes('/api/verse/bootstrap')).length;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  evictAll();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSeatsRefresh', () => {
  it('re-reads the roster on the collector’s own cadence', async () => {
    render(<Probe />);
    expect(bootstrapCalls()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(bootstrapCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(bootstrapCalls()).toBe(2);
  });

  it('asks for nothing while the window is hidden, and catches up the moment it is looked at', async () => {
    render(<Probe />);
    await act(async () => { setVisibility('hidden'); });
    const afterHide = bootstrapCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 3); });
    // A backgrounded app spawns nothing.
    expect(bootstrapCalls()).toBe(afterHide);

    await act(async () => { setVisibility('visible'); });
    expect(bootstrapCalls()).toBe(afterHide + 1);
  });

  it('stops polling when it is turned off, and after unmount', async () => {
    const view = render(<Probe active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(bootstrapCalls()).toBe(0);

    view.rerender(<Probe active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(bootstrapCalls()).toBe(1);

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(bootstrapCalls()).toBe(1);
  });
});
