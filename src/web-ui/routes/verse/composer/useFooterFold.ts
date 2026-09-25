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
 * words as its accessible name and tooltip.
 *
 * WHEN IT MEASURES (3.10.1 review):
 *   - On mount, synchronously, in a layout effect — never waiting for the
 *     first ResizeObserver delivery, which lands after the browser has
 *     painted. Composer is keyed by chat, so this runs on every chat switch;
 *     waiting would flash the unfolded row on each one.
 *   - When the WORDS change (the caller's `labels` key, or a web font
 *     landing): the widths measured for the old words say nothing about the
 *     new ones, so it starts again from fold 0 and climbs, one step per
 *     synchronous layout effect, all before paint.
 *   - When only the ROOM changes (ResizeObserver): no reset. Narrower → keep
 *     climbing from the current fold. Wider → step down, in one render, onto
 *     the folds already measured too wide for the old room but no wider than
 *     the new one. A width that changes the fold by nothing (every frame of a
 *     sidebar drag) renders nothing at all.
 *   - Never while `hold` is set (the ⋯ sheet or a picker's menu is open): a
 *     re-measure can unmount the very control the overlay belongs to and
 *     strand focus. Whatever changed is measured once it closes.
 *
 * Typing never re-measures (it is not in the key), so nothing moves under the
 * caret. Without layout (jsdom, a hidden panel) the width is 0 and it never
 * folds until the footer gets a size.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** The fold at which the pickers leave the row for the ⋯ sheet. */
export const FOOTER_FOLD_SHEET = 4;

export interface FooterFoldOptions {
  /** An overlay on the footer is open: measure nothing until it closes. */
  hold?: boolean;
  /**
   * Called from the layout effect each time the fold comes to rest, with the
   * element that had focus inside the footer when this move began (null when
   * focus was elsewhere or nothing moved). A fold can unmount that control
   * (the pickers leave for ⋯, ⋯ leaves for the pickers, or the re-measure
   * after new words briefly passes through fold 0) — the owner puts focus on
   * its replacement.
   */
  onSettle?: (fold: number, focusBefore: Element | null) => void;
}

interface FoldMemo {
  /** The words the cached widths belong to; null until the first measurement. */
  key: string | null;
  /** The words on screen now — ahead of `key` while the footer had no size to measure them at. */
  latest: string;
  /** scrollWidth of every fold that overflowed under `key` — its true content width. */
  widths: Array<number | undefined>;
  /** The footer width (clientWidth) the current fold was chosen for. */
  width: number;
  /** The committed fold, for the ResizeObserver callback. */
  fold: number;
  hold: boolean;
  /** A move is under way; `focusBefore` is what had focus in the footer when it began. */
  moving: boolean;
  focusBefore: Element | null;
}

/** Remember what had focus in the footer when a move starts (once per move). */
function beginMove(s: FoldMemo, node: HTMLElement): void {
  if (s.moving) return;
  s.moving = true;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  s.focusBefore = active && node.contains(active) ? active : null;
}

/** The lowest fold at or below `fold` whose measured width fits `width` — walking down only across measured folds. */
function unfoldTo(widths: FoldMemo['widths'], fold: number, width: number): number {
  let next = fold;
  while (next > 0) {
    const below = widths[next - 1];
    if (below === undefined || below > width) break;
    next -= 1;
  }
  return next;
}

export function useFooterFold(footer: RefObject<HTMLElement | null>, labels: string, options: FooterFoldOptions = {}): number {
  const { hold = false, onSettle } = options;
  const [fold, setFold] = useState(0);
  // Bumped to take a first look at a footer that mounted with no size.
  const [look, setLook] = useState(0);
  const [fontEpoch, setFontEpoch] = useState(0);
  const memo = useRef<FoldMemo>({ key: null, latest: '', widths: [], width: 0, fold: 0, hold: false, moving: false, focusBefore: null });
  const settle = useRef(onSettle);
  settle.current = onSettle;
  const key = `${fontEpoch}|${labels}`;

  useLayoutEffect(() => {
    const s = memo.current;
    s.fold = fold;
    s.hold = hold;
    s.latest = key;
    const node = footer.current;
    const width = node?.clientWidth ?? 0;
    if (node && !hold && width > 0) {
      if (s.key !== key) {
        // New words: start again from every label in words.
        s.key = key;
        s.widths = [];
        s.width = width;
        if (fold !== 0) {
          beginMove(s, node);
          setFold(0);
          return;
        }
      } else if (width !== s.width) {
        // Only the room changed while held (or before the first look): no reset.
        s.width = width;
        const lower = unfoldTo(s.widths, fold, width);
        if (lower !== fold) {
          beginMove(s, node);
          setFold(lower);
          return;
        }
      }
      // Strict: scrollWidth rounds, so even a sub-pixel overflow folds — one step early beats a clipped Send.
      const content = node.scrollWidth;
      if (content > width) {
        s.widths[fold] = content;
        if (fold < FOOTER_FOLD_SHEET) {
          beginMove(s, node);
          setFold(fold + 1);
          return;
        }
      }
    }
    const focusBefore = s.focusBefore;
    s.moving = false;
    s.focusBefore = null;
    settle.current?.(fold, focusBefore);
  }, [footer, key, hold, fold, look]);

  useEffect(() => {
    const node = footer.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const s = memo.current;
      const width = node.clientWidth;
      // Held: the layout effect measures the new room when the overlay closes.
      if (s.hold || width === 0) return;
      // flushSync: this callback runs after layout and before paint, so the
      // new fold is drawn in the same frame instead of one frame late.
      if (s.key !== s.latest) {
        // Never measured, or the words changed while the footer had no size
        // (a hidden panel): the layout effect takes a full look now.
        flushSync(() => setLook((n) => n + 1));
        return;
      }
      if (width === s.width) return;
      s.width = width;
      let next = unfoldTo(s.widths, s.fold, width);
      if (next === s.fold && node.scrollWidth > width) {
        s.widths[s.fold] = node.scrollWidth;
        next = Math.min(s.fold + 1, FOOTER_FOLD_SHEET);
      }
      if (next === s.fold) return;
      beginMove(s, node);
      flushSync(() => setFold(next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [footer]);

  // A web font landing changes every label's width without changing a word.
  useEffect(() => {
    const fonts = typeof document === 'undefined' ? undefined : (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts || typeof fonts.addEventListener !== 'function') return undefined;
    const onLoaded = () => setFontEpoch((n) => n + 1);
    fonts.addEventListener('loadingdone', onLoaded);
    return () => fonts.removeEventListener('loadingdone', onLoaded);
  }, []);

  return fold;
}
