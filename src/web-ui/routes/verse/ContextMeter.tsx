/**
 * routes/verse/ContextMeter.tsx — live context-window occupancy.
 *
 * DESIGN §4: not a labelled progress bar. The bar is a 2px full-width line
 * pinned to the bottom edge of the header strip (the component's own root
 * stays unpositioned so the header is its containing block); the numbers
 * ride alongside in the display font as `18k / 66k`, with the tooltip and
 * `aria-valuetext` carrying the long form.
 *
 * Amber from 70%, red from 90% (the V1 contract's thresholds); an unknown
 * window renders "n/a" rather than a guess.
 */
import { formatTokens } from './verse-store.js';
import styles from './Workspace.module.css';

export const CONTEXT_WARN_PERCENT = 70;
export const CONTEXT_DANGER_PERCENT = 90;

export interface ContextMeterProps {
  contextTokens: number | null | undefined;
  contextWindow: number | null | undefined;
  /** `inline` draws the track in flow (resources panel) instead of pinned. */
  variant?: 'header' | 'inline';
}

export function contextTone(percent: number | null): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (percent === null) return 'unknown';
  if (percent >= CONTEXT_DANGER_PERCENT) return 'danger';
  if (percent >= CONTEXT_WARN_PERCENT) return 'warn';
  return 'ok';
}

export function ContextMeter({ contextTokens, contextWindow, variant = 'header' }: ContextMeterProps) {
  const tokens = typeof contextTokens === 'number' && Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null;
  const percent = window ? Math.min(100, Math.round((tokens / window) * 100)) : null;
  const tone = contextTone(percent);
  const label = window ? `${formatTokens(tokens)} / ${formatTokens(window)}` : `${formatTokens(tokens)} / n/a`;
  const percentLabel = percent === null ? 'n/a' : `${percent}%`;
  return (
    <div
      className={`${styles.meter} ${styles[`meter-${tone}`] ?? ''} ${variant === 'inline' ? styles.meterInline : ''}`}
      role="meter" aria-label="Context window" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent ?? undefined} aria-valuetext={`${label} (${percentLabel})`}
      title={`Context window — ${label} (${percentLabel})`} data-tone={tone}
    >
      <div className={styles.meterTrack} aria-hidden="true">
        <div className={styles.meterFill} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className={styles.meterText}>
        <span className={styles.meterTokens}>{label}</span>
        <span className={styles.meterPercent}>{percentLabel}</span>
      </span>
    </div>
  );
}
