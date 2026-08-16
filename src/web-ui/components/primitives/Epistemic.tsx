/**
 * components/primitives/Epistemic.tsx — the one thing the old UI got right,
 * promoted to a first-class primitive (foundation brief, item 7).
 *
 * When a piece of data's `sourceQuality.sourceState` is 'degraded' or
 * 'unknown'/'missing', this component displays "unknown" (never a stale or
 * guessed value dressed up as current) AND withholds any control built on
 * top of it (`renderControl` simply never runs). Every future view should
 * wrap sourceQuality-bearing fields in this rather than reinventing the
 * check — that is the whole point of making it a primitive instead of a
 * convention someone has to remember.
 *
 * Reference (old, correct behavior this replaces): app.js:311-314, :336-347.
 */
import type { ReactNode } from 'react';
import type { SourceQuality } from '../../data/api-types.js';
import styles from './Epistemic.module.css';

export function isKnown(quality: SourceQuality | undefined): boolean {
  if (!quality) return true; // absent quality metadata => field predates the pattern; trust it.
  return quality.sourceState === 'healthy' && quality.complete !== false;
}

export interface EpistemicProps {
  quality: SourceQuality | undefined;
  /** Rendered when the value is known-good. */
  children: ReactNode;
  /**
   * A control (button, toggle, link) whose action depends on this data
   * being trustworthy — e.g. "restart daemon" next to daemon.running.
   * Omitted entirely (not disabled — omitted) when the source is degraded,
   * so an operator never sees an actionable-looking control wired to a
   * guess.
   */
  renderControl?: () => ReactNode;
  /** Optional label used in the "unknown" state, e.g. "daemon status". */
  label?: string;
}

export function Epistemic({ quality, children, renderControl, label }: EpistemicProps): ReactNode {
  if (isKnown(quality)) {
    return (
      <>
        {children}
        {renderControl?.()}
      </>
    );
  }

  const reason = quality?.reason;
  return (
    <span className={styles.unknown} title={reason ? `Unavailable: ${reason}` : 'Source data unavailable'}>
      <span className={styles.dot} aria-hidden="true" />
      unknown
      {label ? <span className="visually-hidden"> ({label})</span> : null}
    </span>
  );
}

/** Small inline badge form, for table cells / dense rows. */
export function EpistemicBadge({ quality, label }: { quality: SourceQuality | undefined; label?: string }): ReactNode {
  if (isKnown(quality)) return null;
  return (
    <span className={styles.badge} title={quality?.reason ?? 'Source data unavailable'}>
      {label ? `${label}: ` : ''}unknown
    </span>
  );
}
