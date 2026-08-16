/**
 * components/primitives/StatusBadge.tsx — the ONE status-color mapping for
 * the whole app. See DESIGN.md "Status-color semantics" for the reasoning;
 * the short version: `running` is amber (motion, unresolved — matches
 * Vercel/GitHub Actions "in progress"), `done` is green (resolved,
 * successful). Neither reuses the accent color, so "this is clickable"
 * (accent) never visually collides with "this succeeded" (green).
 *
 * Every view should route run/swarm/proposal/daemon status strings through
 * `statusToTone()` rather than switching on raw strings itself, so adding a
 * new backend status value only ever needs one edit, here.
 */
import type { ReactNode } from 'react';
import styles from './StatusBadge.module.css';

export type Tone = 'neutral' | 'info' | 'running' | 'success' | 'warning' | 'danger' | 'unknown';

const STATUS_TONE: Record<string, Tone> = {
  // Run / swarm / proposal lifecycle.
  pending: 'neutral',
  queued: 'neutral',
  waiting: 'neutral',
  running: 'running',
  active: 'running',
  in_progress: 'running',
  building: 'running',
  applying: 'running',
  done: 'success',
  success: 'success',
  succeeded: 'success',
  applied: 'success',
  merged: 'success',
  ready: 'success',
  approved: 'success',
  ship: 'success',
  review: 'warning',
  degraded: 'warning',
  paused: 'warning',
  noise: 'neutral',
  failed: 'danger',
  error: 'danger',
  errored: 'danger',
  rejected: 'danger',
  harmful: 'danger',
  cancelled: 'neutral',
  canceled: 'neutral',
  unknown: 'unknown',
};

export function statusToTone(status: string | undefined | null): Tone {
  if (!status) return 'unknown';
  return STATUS_TONE[status.toLowerCase()] ?? 'neutral';
}

export interface StatusBadgeProps {
  status: string;
  /** Override the derived tone (rare — prefer letting statusToTone decide). */
  tone?: Tone;
  children?: ReactNode;
}

export function StatusBadge({ status, tone, children }: StatusBadgeProps): ReactNode {
  const resolved = tone ?? statusToTone(status);
  return (
    <span className={`${styles.badge} ${styles[resolved]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children ?? status}
    </span>
  );
}

/** A named DAG/milestone phase — categorical color, unrelated to health. */
export function PhaseDot({ index }: { index: number }): ReactNode {
  const n = ((index % 6) + 6) % 6; // wrap safely for any index, including negatives
  return <span className={styles.phaseDot} style={{ background: `var(--phase-${n + 1})` }} aria-hidden="true" />;
}
