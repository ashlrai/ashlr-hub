/**
 * components/primitives/Segmented.tsx — pick one of 2-4 options where the
 * choice applies instantly (theme, density, a status filter). It replaces
 * both a <select> (too heavy for three options) and a row of toggle buttons
 * (no single-selection semantics for a screen reader).
 *
 * Implemented as a radiogroup with ROVING TABINDEX: one Tab stop for the
 * group, arrows move between options and select as they go — the WAI-ARIA
 * radio-group pattern. Every option is reachable by keyboard and announced
 * as "N of M".
 */
import { useRef, type ReactNode } from 'react';
import styles from './Segmented.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Leading 16px glyph; the text label always stays visible. */
  icon?: ReactNode;
  /** Spoken name when `label` is a glyph or an abbreviation. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group — required when no visible label precedes it. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  size?: 'sm' | 'md';
  /** Stretch each option to an equal share of the width. */
  block?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  block = false,
  className,
  ...aria
}: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function move(delta: number): void {
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((o) => o.value === value);
    const next = enabled[(((current + delta) % enabled.length) + enabled.length) % enabled.length]!;
    onChange(next.value);
    // Keep DOM focus on the newly selected option (roving tabindex).
    requestAnimationFrame(() => {
      groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
    });
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      className={`${styles.group} ${styles[size]} ${block ? styles.block : ''} ${className ?? ''}`}
      {...aria}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            data-value={option.value}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            className={styles.option}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1);
              }
            }}
          >
            {option.icon ? <span className={styles.glyph}>{option.icon}</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
