/**
 * components/primitives/focus-trap.ts — the modal focus contract, extracted
 * from Dialog.tsx so Sheet.tsx (the slide-over overlay) gets exactly the same
 * behavior instead of a second, subtly different implementation:
 *
 *   - focus moves into the overlay (or `initialFocusRef`) on open
 *   - focus is trapped inside while open (Tab/Shift+Tab wrap)
 *   - focus returns to the element that opened it on close
 *   - Escape closes
 *
 * Dialog.tsx is unchanged in behavior — it now calls this instead of
 * inlining it. Any future overlay MUST use this rather than hand-rolling a
 * trap (DESIGN.md §3, "primitives own their accessibility").
 */
import { useEffect, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable descendants that are actually rendered (offsetParent is null for hidden nodes). */
export function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
}

export interface FocusTrapOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useFocusTrap({ open, containerRef, onClose, initialFocusRef }: FocusTrapOptions): void {
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current ?? containerRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      previouslyFocused?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are refs (stable identity is not the point); only `open` should re-run this.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = containerRef.current;
      if (!node) return;
      const focusable = focusableWithin(node);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef is a ref; re-binding on every render would drop in-flight key handling.
  }, [open, onClose]);
}
