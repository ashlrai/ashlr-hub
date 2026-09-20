/**
 * components/primitives/Switch.tsx — a binary setting that takes effect
 * immediately (no form submit). role="switch" + aria-checked, so a screen
 * reader announces "on"/"off" rather than "checkbox, checked".
 *
 * State is never carried by color alone: the knob's POSITION is the primary
 * signal (design doc §6), the accent fill is reinforcement.
 */
import type { ReactNode } from 'react';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible label; when omitted, pass `aria-label`. */
  label?: ReactNode;
  'aria-label'?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className,
  ...aria
}: SwitchProps) {
  const control = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={styles.track}
      onClick={() => onChange(!checked)}
      {...aria}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );

  if (!label) return <span className={className}>{control}</span>;

  return (
    <label className={`${styles.wrapper} ${className ?? ''}`}>
      {control}
      <span className={styles.label}>{label}</span>
    </label>
  );
}
