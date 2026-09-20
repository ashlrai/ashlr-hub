/**
 * components/primitives/EmptyState.tsx — the designed state for "there is
 * genuinely nothing here" (design doc §1.6: honest states).
 *
 * It takes a TITLE and a BODY because an empty surface has to say what it
 * means — "No enrolled repositories" is a fact, "the daemon will do nothing
 * until you enroll one" is the consequence the operator needs. `tone="error"`
 * and `tone="unauthorized"` cover the other two dead ends so no view has to
 * invent its own.
 */
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  title: ReactNode;
  /** What it means / what to do about it. */
  body?: ReactNode;
  /** 16px glyph from ./icons.tsx. */
  icon?: ReactNode;
  /** A single action — usually the thing that resolves the emptiness. */
  action?: ReactNode;
  tone?: 'neutral' | 'error' | 'unauthorized';
  /** Tighter padding for a panel rather than a whole view. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  title,
  body,
  icon,
  action,
  tone = 'neutral',
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`${styles.empty} ${styles[tone]} ${compact ? styles.compact : ''} ${className ?? ''}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <p className={styles.title}>{title}</p>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
