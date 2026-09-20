/**
 * components/primitives/Sheet.tsx — a side overlay for detail that would
 * bury the main column: a proposal's diff, an audit entry, a seat's full
 * usage. Same focus contract as Dialog (shared ./focus-trap.ts), different
 * geometry: it enters from an edge and keeps the underlying view visible.
 *
 * Below 900px the shell collapses its panels (design doc §6); a sheet is the
 * right target for that overflow, which is why the width is capped in `vw`
 * as well as px.
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './focus-trap.js';
import { IconButton } from './Button.js';
import { IconX } from './icons.js';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: ReactNode;
  /** One quiet line under the title. */
  description?: ReactNode;
  /** Pinned to the bottom edge — actions, never scrolled out of reach. */
  footer?: ReactNode;
  side?: 'right' | 'left';
  width?: number;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Sheet({
  open,
  onClose,
  titleId,
  title,
  description,
  footer,
  side = 'right',
  width = 460,
  initialFocusRef,
  children,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ open, containerRef: panelRef, onClose, initialFocusRef });

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${styles.panel} ${styles[side]}`}
        style={{ width: `min(${width}px, calc(100vw - var(--space-8)))` }}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          <IconButton variant="ghost" size="sm" icon={<IconX />} aria-label="Close" onClick={onClose} />
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
