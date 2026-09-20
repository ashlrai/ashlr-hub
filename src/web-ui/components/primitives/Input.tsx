/**
 * components/primitives/Input.tsx — single-line text/number entry.
 *
 * Nothing here is a default browser control: hairline border, no inner card,
 * accent on focus. The accessible name comes from `label` when the field
 * stands alone, or from the caller's own `aria-label`/`aria-labelledby` when
 * it sits in a two-column settings row whose label lives on the other side.
 * An `error` is announced via role="alert" and wired with aria-describedby —
 * red text alone never carries the message (design doc §6).
 */
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className' | 'prefix'> {
  label?: ReactNode;
  /** Quiet helper text under the field. */
  hint?: ReactNode;
  /** Error message; also flips the field into its invalid styling. */
  error?: ReactNode;
  size?: 'sm' | 'md';
  /** Paths, ids, tokens counts — anything that should not be kerned. */
  mono?: boolean;
  /** Non-interactive leading text (e.g. "$", "http://"). Shadows the rarely
   *  used HTML `prefix` attribute on purpose — this is the useful meaning. */
  prefix?: ReactNode;
  className?: string;
}

export function Input({
  label,
  hint,
  error,
  size = 'md',
  mono = false,
  prefix,
  className,
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [rest['aria-describedby'], hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      {label ? (
        <label className={styles.label} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <div className={`${styles.shell} ${styles[size]} ${error ? styles.invalid : ''}`}>
        {prefix ? <span className={styles.prefix}>{prefix}</span> : null}
        <input
          {...rest}
          id={inputId}
          className={`${styles.input} ${mono ? styles.mono : ''}`}
          aria-invalid={error ? true : rest['aria-invalid']}
          aria-describedby={describedBy || undefined}
        />
      </div>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
