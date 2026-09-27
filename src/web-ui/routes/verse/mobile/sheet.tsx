/**
 * routes/verse/mobile/sheet.tsx — the bottom sheet: grabber, title, a
 * scrolling body and a pinned footer, with the console's focus trap (Escape
 * and the backdrop close it unless it is busy). Off the first paint.
 */
import { useCallback, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import styles from './parts.module.css';

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** While busy the backdrop and Escape do not close it. */
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
}

export function BottomSheet({ open, onClose, title, children, footer, busy = false, role = 'dialog' }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useFocusTrap({ open, containerRef: panel, onClose: close });
  if (!open) return null;
  return createPortal(
    <div className={styles.sheetBackdrop} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={panel} className={styles.sheet} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <span className={styles.grabber} aria-hidden="true" />
        <h2 id={titleId} className={styles.sheetTitle}>{title}</h2>
        <div className={styles.sheetBody}>{children}</div>
        {footer ? <div className={styles.sheetFooter}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
