/**
 * components/primitives/Dialog.tsx — focus-managed modal base. Used by
 * MutationTokenDialog and CommandPalette so both get the same accessible
 * behavior instead of each hand-rolling it:
 *
 *   - focus moves to the dialog (or `initialFocusRef`) on open
 *   - focus is trapped inside while open (Tab/Shift+Tab wrap)
 *   - focus returns to the trigger element on close
 *   - Escape closes
 *   - a click on the backdrop closes
 *   - background content is aria-hidden via inert-equivalent (portal + the
 *     dialog being the only focusable subtree)
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: ReactNode;
  children: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  widthClassName?: string;
}

export function Dialog({ open, onClose, titleId, title, children, initialFocusRef, widthClassName }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current ?? dialogRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      previouslyFocused.current?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialFocusRef is a ref (stable identity is not the point); only `open` should re-run this.
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
      const node = dialogRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
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
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${widthClassName ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
