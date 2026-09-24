/**
 * routes/verse/shell/viewport.ts — the workbench's width classes (unit C0).
 *
 * ONE set of breakpoints for every 3.10 surface, so the dock, the drawer, the
 * surfaces and the composer footer all change shape at the same widths
 * (SPEC-310C §1–§5):
 *
 *   compact  < 480   the phone layout the 375 screenshots show: one column,
 *                    bottom sheets (dock at 75vh), the composer footer folds
 *                    its pickers into a sheet, charts render at width 375.
 *   medium   480–1023  the dock and the Needs-you drawer become sheets over
 *                    the chat instead of columns beside it.
 *   wide     ≥ 1024  the full workbench: rail, sidebar, transcript, dock.
 *
 * Read through matchMedia — the browser's own answer, which is also what the
 * test support mocks — never by polling window size.
 */
import { useMemo, useSyncExternalStore } from 'react';

export const VIEWPORT_BREAKPOINTS = Object.freeze({
  /** Below this width: the compact (phone) layout. */
  compact: 480,
  /** At or above this width: the wide workbench (dock as a column). */
  wide: 1024,
});

export type ViewportClass = 'compact' | 'medium' | 'wide';

/**
 * The two queries every class derives from. `max-width` uses .98 so the
 * compact and medium ranges meet without overlapping at fractional widths
 * (the same convention Bootstrap and Tailwind use for zoomed displays).
 */
export const VIEWPORT_QUERIES = Object.freeze({
  compact: `(max-width: ${VIEWPORT_BREAKPOINTS.compact - 0.02}px)`,
  wide: `(min-width: ${VIEWPORT_BREAKPOINTS.wide}px)`,
});

/** The class a width falls in (pure; for layout math and tests). */
export function viewportClassFor(width: number): ViewportClass {
  if (width < VIEWPORT_BREAKPOINTS.compact) return 'compact';
  if (width < VIEWPORT_BREAKPOINTS.wide) return 'medium';
  return 'wide';
}

function currentClass(): ViewportClass {
  if (typeof window === 'undefined') return 'wide';
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia(VIEWPORT_QUERIES.compact).matches) return 'compact';
    return window.matchMedia(VIEWPORT_QUERIES.wide).matches ? 'wide' : 'medium';
  }
  // jsdom without a mock, and old webviews: the window's own width.
  return viewportClassFor(window.innerWidth || VIEWPORT_BREAKPOINTS.wide);
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.matchMedia !== 'function') {
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }
  const lists = [window.matchMedia(VIEWPORT_QUERIES.compact), window.matchMedia(VIEWPORT_QUERIES.wide)];
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

export interface ViewportState {
  viewport: ViewportClass;
  /** < 480: phone layout. */
  compact: boolean;
  /** ≥ 1024: the full workbench. */
  wide: boolean;
}

/** The current width class; re-renders only when the CLASS changes, not on every resize. */
export function useViewport(): ViewportState {
  const viewport = useSyncExternalStore(subscribe, currentClass, () => 'wide' as const);
  return useMemo(() => ({ viewport, compact: viewport === 'compact', wide: viewport === 'wide' }), [viewport]);
}

/** Non-hook read, for event handlers and effects. */
export function readViewport(): ViewportClass {
  return currentClass();
}
