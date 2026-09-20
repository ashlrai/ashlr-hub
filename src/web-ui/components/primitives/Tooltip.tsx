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
 */
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: TooltipPlacement;
  /** Skip rendering entirely (e.g. content not known yet) without changing the tree. */
  disabled?: boolean;
  className?: string;
}

export function Tooltip({ content, children, placement = 'top', disabled = false, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

  if (disabled || content === null || content === undefined || content === '') return children;

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
        {content}
      </span>
    </span>
  );
}
