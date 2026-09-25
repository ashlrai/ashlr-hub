/**
 * components/primitives/Dialog.tsx — focus-managed modal base. Used by
 * MutationTokenDialog, CommandPalette and the Verse confirm flows so all of
 * them get the same accessible behavior instead of each hand-rolling it:
 *
 *   - focus moves to the dialog (or `initialFocusRef`) on open
 *   - focus is trapped inside while open (Tab/Shift+Tab wrap)
 *   - focus returns to the trigger element on close
 *   - Escape closes
 *   - a click on the backdrop closes
 *   - a `description` is the dialog's accessible description
 *     (aria-describedby), so it is announced with the title on open — focus
 *     usually lands on a button, and a plain <p> beside it was never read
 *
 * The trap itself lives in ./focus-trap.ts, shared with Sheet.tsx — the
 * behavior here is unchanged, it just stopped being copy-pasteable.
 */
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './focus-trap.js';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: ReactNode;
  children: ReactNode;
  /**
   * Optional one-line description under the title — also the dialog's
   * aria-describedby, so put the consequence a confirm is asking about here.
   */
  description?: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  widthClassName?: string;
}

export function Dialog({
  open,
  onClose,
  titleId,
  title,
  description,
  children,
  initialFocusRef,
  widthClassName,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  // Same test that decides whether the <p> renders, so the id never dangles.
  const described = Boolean(description);

  useFocusTrap({ open, containerRef: dialogRef, onClose, initialFocusRef });

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${widthClassName ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={described ? descriptionId : undefined}
        tabIndex={-1}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {described ? <p id={descriptionId} className={styles.description}>{description}</p> : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
