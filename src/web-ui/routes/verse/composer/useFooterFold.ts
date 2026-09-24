/**
 * routes/verse/composer/useFooterFold.ts — how far the composer footer folds
 * to fit its one row WITHOUT truncating a label.
 *
 *   0  every control in words
 *   1  "Effort:" becomes an icon ("ıl High")
 *   2  the seat chip drops to its monogram (+ capacity ring)
 *   3  the permission mode drops to its icon
 *   4  the pickers move into the ⋯ sheet (the phone footer)
 *
 * Measured, not a breakpoint: the labels vary too much ("Local" vs "Personal
 * Codex", "Opus 5" vs "Qwen3.8 27b-ctx64k"), so any fixed width either folds
 * a footer that fit or lets one overflow. Every folded control keeps its full
 * words as its accessible name and title.
 *
 * It re-measures only when the footer's WIDTH or its LABELS change (the
 * caller's `labels` key) — never on a keystroke — so nothing moves under the
 * caret while typing. Each step runs in a layout effect, before paint.
 * Without ResizeObserver (jsdom) it never folds.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The fold at which the pickers leave the row for the ⋯ sheet. */
export const FOOTER_FOLD_SHEET = 4;

export function useFooterFold(footer: RefObject<HTMLElement | null>, labels: string): number {
  const [fold, setFold] = useState(0);
  const [width, setWidth] = useState(0);
  const measuredFor = useRef('');

  useEffect(() => {
    const node = footer.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [footer]);

  useLayoutEffect(() => {
    const node = footer.current;
    if (!node || width === 0) return;
    const key = `${width}|${labels}`;
    if (measuredFor.current !== key) {
      // New room or new words: start again from every label in words.
      measuredFor.current = key;
      if (fold !== 0) {
        setFold(0);
        return;
      }
    }
    // Strict: scrollWidth rounds, so even a sub-pixel overflow folds — one step early beats a clipped Send.
    if (fold < FOOTER_FOLD_SHEET && node.scrollWidth > node.clientWidth) setFold(fold + 1);
  }, [footer, width, labels, fold]);

  return fold;
}
