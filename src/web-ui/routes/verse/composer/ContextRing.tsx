/**
 * routes/verse/composer/ContextRing.tsx — "Context ◔" in the composer footer
 * (unit C3): how full this chat's context window is, measured against the
 * SAME budget the header meter draws (verse-model `sessionContextBudget`),
 * so the two never disagree.
 *
 * The ring is quantity (the fixed azure ramp); it takes the warning colour
 * only as the chat nears the point where the CLI auto-compacts, and says the
 * number in words to screen readers and in its tooltip. Unknown occupancy is
 * an empty ring and "—", never a zero.
 */
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { formatTokens } from '../verse-store.js';
import styles from './composer.module.css';

export interface ContextRingProps {
  contextTokens: number | null;
  contextWindow: number | null;
  autoCompactAt: number | null;
  exact: boolean;
}

export function contextTone(tokens: number | null, window: number | null, compactAt: number | null): 'unknown' | 'ok' | 'warn' | 'danger' {
  if (tokens === null || window === null || window <= 0) return 'unknown';
  const limit = compactAt ?? window;
  if (tokens >= limit) return 'danger';
  if (tokens >= limit * 0.8) return 'warn';
  return 'ok';
}

export function ContextRing({ contextTokens, contextWindow, autoCompactAt, exact }: ContextRingProps) {
  const known = contextTokens !== null && contextWindow !== null && contextWindow > 0;
  const pct = known ? Math.min(100, Math.max(0, (contextTokens / contextWindow) * 100)) : null;
  const tone = contextTone(contextTokens, contextWindow, autoCompactAt);
  const size = 16;
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const text = known
    ? `Context ${exact ? '' : 'up to '}${Math.round(pct!)}% — ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens${autoCompactAt !== null ? `; the CLI compacts at ${formatTokens(autoCompactAt)}` : ''}`
    : 'Context — not measured yet';
  return (
    <Tooltip label={text} placement="top">
      <span className={styles.contextRing} role="img" aria-label={text} tabIndex={0} data-tone={tone}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle className={styles.ringTrack} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2" />
          {pct === null ? null : (
            <circle className={styles.contextFill} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2"
              strokeDasharray={`${(pct / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="round" />
          )}
        </svg>
        <span className={styles.contextText} aria-hidden="true">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
      </span>
    </Tooltip>
  );
}
