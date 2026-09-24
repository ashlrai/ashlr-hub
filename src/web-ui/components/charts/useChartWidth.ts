/**
 * components/charts/useChartWidth.ts — the measured pixel width of a chart's
 * container, so the V3.10 charts draw at their REAL size (text stays 12 px at
 * 375 px wide) instead of scaling a fixed viewBox down until labels are
 * unreadable. Falls back to `fallback` until measured (jsdom, SSR, first paint).
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/** Narrowest width any chart lays itself out for (a 375 px phone minus padding). */
export const MIN_CHART_WIDTH = 280;

export function useChartWidth(ref: RefObject<HTMLElement | null>, fixed: number | undefined, fallback = 640): number {
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (fixed !== undefined) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const read = (): void => {
      const w = Math.floor(el.getBoundingClientRect().width);
      // 0 means "not laid out yet" (hidden tab, jsdom) — keep the fallback.
      if (w > 0) setMeasured((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // rAF-coalesced: a drag-resize fires many entries per frame.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref, fixed]);
  return Math.max(MIN_CHART_WIDTH, fixed ?? measured ?? fallback);
}
