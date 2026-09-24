/**
 * components/charts/useTextScale.ts — the operator's Display size, as the
 * multiplier every type token carries: --ui-text-scale is 1 at Default,
 * 1.125 at Large and 1.25 at XLarge (clamped back to 1.125 for XLarge under
 * 1100 px — see the [data-ui-scale] blocks in design/tokens.css).
 *
 * Charts lay labels out from WIDTH ESTIMATES (chart-math layoutAxisLabels,
 * dodgeLabels, tickGutter) written for 12 px text. This is what they
 * multiply those estimates by, so the no-overlap guarantee holds at the size
 * the labels actually render instead of only at Default (V3.10.1 review:
 * at XLarge a weekly burn-down's start and reset labels overprinted).
 *
 * Read from <html>, where data/appearance-store.ts sets data-ui-scale and
 * tokens.css resolves --ui-text-scale. ONE shared subscription for every
 * chart on screen — a MutationObserver for the setting and a resize
 * listener for the narrow-window clamp (a media query) — not one per chart.
 */
import { useSyncExternalStore } from 'react';
import { validTextScale } from './chart-math.js';

/** --ui-text-scale as computed on `root` (default <html>); 1 when unset or unreadable. */
export function readTextScale(root: Element | null = typeof document === 'undefined' ? null : document.documentElement): number {
  if (!root || typeof getComputedStyle !== 'function') return 1;
  return validTextScale(Number.parseFloat(getComputedStyle(root).getPropertyValue('--ui-text-scale')));
}

const listeners = new Set<() => void>();
let current: number | null = null;
let stopWatching: (() => void) | null = null;

function refresh(): void {
  const next = readTextScale();
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function watch(): () => void {
  current = readTextScale();
  const root = document.documentElement;
  // `style` as well as the attribute: an inline --ui-text-scale is the same
  // setting, and the check is one computed-style read per mutation batch.
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refresh);
  observer?.observe(root, { attributes: true, attributeFilter: ['data-ui-scale', 'style'] });
  const raf = typeof requestAnimationFrame === 'function';
  let frame = 0;
  const onResize = (): void => {
    if (!raf) return refresh();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  };
  window.addEventListener('resize', onResize);
  return () => {
    observer?.disconnect();
    if (raf) cancelAnimationFrame(frame);
    window.removeEventListener('resize', onResize);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof document !== 'undefined') stopWatching = watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopWatching?.();
    stopWatching = null;
    current = null;
  };
}

function getSnapshot(): number {
  return current ?? readTextScale();
}

/** The display text multiplier; re-renders the caller when the operator changes Display size. */
export function useTextScale(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 1);
}
