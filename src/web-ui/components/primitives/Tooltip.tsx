/**
 * components/primitives/Tooltip.tsx — the label for an icon-only control and
 * the numbers behind a 2px meter line.
 *
 * Rules it enforces so a tooltip never becomes the only way to read the UI:
 *   - it shows on HOVER *and* on keyboard FOCUS (a mouse-only tooltip is
 *     invisible to keyboard operators);
 *   - Escape dismisses it while the trigger keeps focus (WCAG 1.4.13);
 *   - the trigger is wired with aria-describedby, so the content is
 *     announced rather than merely drawn;
 *   - it carries description, never the accessible NAME — icon buttons still
 *     need their own aria-label.
 *
 * TWO SPELLINGS, ONE COMPONENT. `label` (plus an optional `shortcut`, drawn
 * as a keycap) is the contract the verse surfaces are written against;
 * `content` is the original free-ReactNode spelling and keeps working, so
 * nothing that already calls this has to move. `label` wins when both are
 * given.
 */
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The description. Preferred spelling — a short phrase, never a paragraph. */
  label?: string;
  /** Drawn as a keycap after the label, e.g. `⌘N`. */
  shortcut?: string;
  /** Free-form alternative to `label`, kept for the call sites that predate it. */
  content?: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: TooltipPlacement;
  /** Skip rendering entirely (e.g. content not known yet) without changing the tree. */
  disabled?: boolean;
  className?: string;
}

export function Tooltip({
  label,
  shortcut,
  content,
  children,
  placement = 'top',
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const body: ReactNode = label === undefined || label === '' ? content : label;
  if (disabled || body === null || body === undefined || body === '') return children;

  return (
    <span
      ref={wrapperRef}
      className={`${styles.wrapper} ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {/* The described-by wiring is the point of the wrapper: the trigger
          keeps its own accessible name and gains a description. */}
      <span className={styles.trigger} aria-describedby={open ? id : undefined}>
        {children}
      </span>
      <span role="tooltip" id={id} className={`${styles.bubble} ${styles[placement]}`} hidden={!open}>
        {body}
        {shortcut ? <kbd className={styles.shortcut}>{shortcut}</kbd> : null}
      </span>
    </span>
  );
}
