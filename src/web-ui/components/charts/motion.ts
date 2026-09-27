/**
 * components/charts/motion.ts — whether a chart may play its entrance (a line
 * drawing itself in, columns rising, a wash fading up).
 *
 * The same two triggers as the duration tokens (design/tokens.css) and the
 * skeleton shimmer (design/global.css), resolved once at mount:
 *
 *   - `data-motion="reduce"` on <html> (Settings → Reduce motion) → static;
 *   - `data-motion="full"` (Settings explicitly asked for motion) → animate,
 *     whatever the OS says;
 *   - otherwise the OS `prefers-reduced-motion: reduce` → static.
 *
 * The chart writes the answer to its plot wrapper as `data-motion="enter" |
 * "static"`, and plot.module.css keys every entrance animation off
 * `[data-motion='enter']` — so a reduced-motion reader gets a plot that is
 * simply THERE, and the DOM says which one they got (charts/motion.test.tsx).
 * The durations also read var(--duration-*), which collapse to 1 ms under
 * reduced motion — a second, CSS-only guard if the attribute were ever lost.
 *
 * Entrance only: a hover, a refetch or a 7d → 30d switch never replays it
 * (the SVG elements persist; only their geometry changes).
 */
import { useState } from 'react';

export type ChartMotion = 'enter' | 'static';

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined') {
    const pref = document.documentElement.getAttribute('data-motion');
    if (pref === 'reduce') return true;
    if (pref === 'full') return false;
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Resolved once per chart mount — an entrance is a one-time event, not a subscription. */
export function useChartMotion(): ChartMotion {
  const [motion] = useState<ChartMotion>(() => (prefersReducedMotion() ? 'static' : 'enter'));
  return motion;
}
