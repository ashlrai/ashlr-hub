/**
 * components/primitives/Select.tsx — a native <select> that does not look
 * native: the browser's own control is stripped and the chevron is our own
 * 16px glyph, so the field matches Input at every density.
 *
 * Deliberately NOT a custom listbox. A native select gets the platform's
 * keyboard handling, type-ahead, and mobile picker for free — a hand-rolled
 * popup would be a worse control with more code (DESIGN.md §3).
 */
import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { IconChevronDown } from './icons.js';
import styles from './Select.module.css';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'className'> {
  label?: ReactNode;
  hint?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  children: ReactNode;
}

export function Select({ label, hint, size = 'md', className, id, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;

  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      {label ? (
        <label className={styles.label} htmlFor={selectId}>
          {label}
        </label>
      ) : null}
      <div className={`${styles.shell} ${styles[size]}`}>
        <select
          {...rest}
          id={selectId}
          className={styles.select}
          aria-describedby={[rest['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        >
          {children}
        </select>
        <IconChevronDown className={styles.chevron} size={14} />
      </div>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
