/**
 * routes/verse/composer/ControlsSheet.tsx — the 375px composer's "⋯": the
 * Permission, Model and Effort pickers in one bottom sheet (SPEC-310C §2 "At
 * 375px"; unit C3).
 *
 * A phone footer holds [+] [mic], the seat, ⋯ and Send. A popover per picker
 * would open over the keyboard and off the screen edge, so the three become
 * radio lists in a sheet that rises from the bottom. It traps focus while
 * open, Esc and the backdrop close it, and focus returns to ⋯.
 */
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import styles from './composer.module.css';

export interface ControlsSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ControlsSheet({ open, onClose, children }: ControlsSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useFocusTrap({ open, containerRef: panel, onClose, initialFocusRef: close });
  if (!open) return null;
  return createPortal(
    <div className={styles.sheetBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.sheetHeader}>
          <h2 id={titleId} className={styles.sheetTitle}>Chat settings</h2>
          <button ref={close} type="button" className={styles.sheetClose} onClick={onClose}>Done</button>
        </div>
        <p className={styles.sheetNote}>Changes apply from the next turn.</p>
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
