/**
 * Keep-alive visibility (unit C0; SPEC-310C §1): hidden surfaces and hidden
 * windows do not poll, polls never run faster than the 2 s budget, and a
 * surface that comes back refreshes on sight.
 */
import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_POLL_INTERVAL_MS,
  SectionVisibilityProvider,
  useDocumentVisible,
  usePollWhileVisible,
  useSectionVisible,
} from './section-visibility.js';

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  setDocumentVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setDocumentVisibility('visible');
});

function Poller({ tick, every, enabled }: { tick: () => void; every: number; enabled?: boolean }) {
  usePollWhileVisible(tick, every, enabled === undefined ? {} : { enabled });
  return null;
}

function Surface({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <SectionVisibilityProvider visible={visible}>{children}</SectionVisibilityProvider>;
}

describe('useSectionVisible', () => {
  it('is true outside any provider (legacy sections and tests behave as before)', () => {
    expect(renderHook(() => useSectionVisible()).result.current).toBe(true);
  });

  it('follows the provider, and a visible child of a hidden surface is hidden', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Surface visible={false}>
        <Surface visible>{children}</Surface>
      </Surface>
    );
    expect(renderHook(() => useSectionVisible(), { wrapper }).result.current).toBe(false);
  });
});

describe('useDocumentVisible', () => {
  it('tracks the window hiding and showing', () => {
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);
    act(() => setDocumentVisibility('hidden'));
    expect(result.current).toBe(false);
  });
});

describe('usePollWhileVisible', () => {
  it('ticks on its interval while visible', () => {
    const tick = vi.fn();
    render(<Poller tick={tick} every={5_000} />);
    act(() => vi.advanceTimersByTime(15_000));
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('never polls faster than the 2 s budget', () => {
    const tick = vi.fn();
    render(<Poller tick={tick} every={250} />);
    act(() => vi.advanceTimersByTime(MIN_POLL_INTERVAL_MS * 3));
    expect(tick).toHaveBeenCalledTimes(3);
    expect(MIN_POLL_INTERVAL_MS).toBe(2_000);
  });

  it('stops on a hidden surface, and refreshes once on sight when it comes back', () => {
    const tick = vi.fn();
    const { rerender } = render(
      <Surface visible>
        <Poller tick={tick} every={5_000} />
      </Surface>,
    );
    rerender(
      <Surface visible={false}>
        <Poller tick={tick} every={5_000} />
      </Surface>,
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(tick).not.toHaveBeenCalled();
    rerender(
      <Surface visible>
        <Poller tick={tick} every={5_000} />
      </Surface>,
    );
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stops while the window is hidden', () => {
    const tick = vi.fn();
    render(<Poller tick={tick} every={2_000} />);
    act(() => setDocumentVisibility('hidden'));
    act(() => vi.advanceTimersByTime(20_000));
    expect(tick).not.toHaveBeenCalled();
    act(() => setDocumentVisibility('visible'));
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled, and calls the LATEST tick without restarting the interval', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Poller tick={first} every={4_000} enabled={false} />);
    act(() => vi.advanceTimersByTime(12_000));
    expect(first).not.toHaveBeenCalled();
    rerender(<Poller tick={first} every={4_000} />);
    act(() => vi.advanceTimersByTime(3_000));
    rerender(<Poller tick={second} every={4_000} />);
    act(() => vi.advanceTimersByTime(1_000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
