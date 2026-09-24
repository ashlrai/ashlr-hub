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
  // WHY track the node: a chart whose frame starts in a non-ready state
  // (loading / empty / dark) mounts its plot — and so this ref — LATER than
  // the hook. An effect keyed only on the ref object never re-ran, so every
  // chart that first rendered "Loading…" stayed at the 640 px fallback and
  // was scaled down by CSS (V3.10 fix, found in the 1440 harness).
  const [node, setNode] = useState<HTMLElement | null>(null);
  // Runs after every render on purpose (ref.current is not a dependency React
  // can see); the equality guard makes it settle in one pass, never a loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  useLayoutEffect(() => {
    if (fixed !== undefined) return undefined;
    const el = node;
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
  }, [node, fixed]);
  return Math.max(MIN_CHART_WIDTH, fixed ?? measured ?? fallback);
}
