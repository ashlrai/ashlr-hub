/**
 * Width classes and the viewport test support every 375 test uses (unit C0).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readViewport, useViewport, VIEWPORT_QUERIES, viewportClassFor } from './viewport.js';
import { evaluateMediaQuery, mockCompactViewport, mockViewport, mockWideViewport, type ViewportMock } from './viewport.test-support.js';

let mock: ViewportMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

describe('viewport classes', () => {
  it('splits at 480 and 1024', () => {
    expect(viewportClassFor(375)).toBe('compact');
    expect(viewportClassFor(479)).toBe('compact');
    expect(viewportClassFor(480)).toBe('medium');
    expect(viewportClassFor(1023)).toBe('medium');
    expect(viewportClassFor(1024)).toBe('wide');
    expect(viewportClassFor(1440)).toBe('wide');
    expect(VIEWPORT_QUERIES).toEqual({ compact: '(max-width: 479.98px)', wide: '(min-width: 1024px)' });
  });
});

describe('useViewport', () => {
  it('is compact at 375 and re-renders when the class changes', () => {
    mock = mockCompactViewport();
    const { result } = renderHook(() => useViewport());
    expect(result.current).toEqual({ viewport: 'compact', compact: true, wide: false });
    act(() => mock!.setWidth(800));
    expect(result.current.viewport).toBe('medium');
    act(() => mock!.setWidth(1440));
    expect(result.current).toEqual({ viewport: 'wide', compact: false, wide: true });
  });

  it('keeps the same object while the class is unchanged', () => {
    mock = mockWideViewport();
    const { result } = renderHook(() => useViewport());
    const first = result.current;
    act(() => mock!.setWidth(1300));
    expect(result.current).toBe(first);
  });

  it('falls back to the window width where matchMedia does not exist', () => {
    const saved = window.matchMedia;
    delete (window as { matchMedia?: unknown }).matchMedia;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 600 });
      expect(readViewport()).toBe('medium');
    } finally {
      if (saved) window.matchMedia = saved;
    }
  });
});

describe('viewport test support', () => {
  it('answers width queries, joined with `and`, and the preference queries it is told about', () => {
    expect(evaluateMediaQuery('(max-width: 760px)', 375)).toBe(true);
    expect(evaluateMediaQuery('(min-width: 480px) and (max-width: 1023.98px)', 768)).toBe(true);
    expect(evaluateMediaQuery('(min-width: 480px) and (max-width: 1023.98px)', 1440)).toBe(false);
    expect(evaluateMediaQuery('(prefers-color-scheme: dark)', 375, { dark: true })).toBe(true);
    expect(evaluateMediaQuery('(prefers-reduced-motion: reduce)', 375)).toBe(false);
    expect(evaluateMediaQuery('(orientation: portrait)', 375)).toBe(false);
  });

  it('restores the previous matchMedia', () => {
    const before = window.matchMedia;
    const m = mockViewport(375);
    expect(window.matchMedia).not.toBe(before);
    m.restore();
    expect(window.matchMedia).toBe(before);
  });
});
