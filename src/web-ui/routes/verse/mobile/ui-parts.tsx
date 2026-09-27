/**
 * routes/verse/mobile/ui-parts.tsx — inset-grouped lists, badges, meters,
 * banners and the empty / error states every phone screen shares (styling:
 * ui.module.css). Off the first paint: the Home frame needs none of them.
 */
import { useId, type ReactNode } from 'react';
import { ChevronGlyph } from './mobile-icons.js';
import partStyles from './parts.module.css';
import { Button, cx, ui as coreStyles } from './ui.js';

/** Every phone class: the frame's (ui.module.css) and the parts' (parts.module.css). */
export const ui: Readonly<Record<string, string>> = { ...coreStyles, ...partStyles };
const styles = ui;

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function Section({ title, trailing, footer, children, flat = false }: { title?: ReactNode; trailing?: ReactNode; footer?: ReactNode; children: ReactNode; flat?: boolean }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={title ? id : undefined}>
      {title ? (
        <div className={styles.sectionHeader}>
          <h2 id={id} style={{ margin: 0, font: 'inherit' }}>{title}</h2>
          {trailing}
        </div>
      ) : null}
      {flat ? children : <div className={styles.group}>{children}</div>}
      {footer ? <p className={styles.sectionFooter}>{footer}</p> : null}
    </section>
  );
}

export interface RowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  /** Accessible name when the visible title is not enough. */
  label?: string;
}

export function Row({ title, subtitle, leading, trailing, onClick, chevron = Boolean(onClick), label }: RowProps) {
  const body = (
    <>
      {leading ? <span className={styles.rowLead}>{leading}</span> : null}
      <span className={styles.rowBody}>
        <span className={styles.rowTitle}>{title}</span>
        {subtitle ? <span className={styles.rowSub}>{subtitle}</span> : null}
      </span>
      {trailing || chevron ? (
        <span className={styles.rowTrail}>
          {trailing}
          {chevron ? <ChevronGlyph size={14} className={styles.chevron} /> : null}
        </span>
      ) : null}
    </>
  );
  if (!onClick) return <div className={styles.row}>{body}</div>;
  return (
    <button type="button" className={styles.row} onClick={onClick} aria-label={label}>
      {body}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = 'running' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', dot = false, pulse = false, children }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={cx(styles.badge, styles[`tone-${tone}`])}>
      {dot ? <span className={cx(styles.dot, pulse && styles.pulse)} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export interface MeterProps {
  label: ReactNode;
  /** 0–100; null = unknown (an empty track and "unknown", never 0%). */
  percent: number | null;
  /** Right-hand text; defaults to the percent. */
  valueText?: string;
  note?: ReactNode;
}

export function meterTone(percent: number | null): 'ok' | 'warning' | 'danger' | 'unknown' {
  if (percent === null) return 'unknown';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'ok';
}

export function Meter({ label, percent, valueText, note }: MeterProps) {
  const clamped = percent === null ? null : Math.max(0, Math.min(100, percent));
  const text = valueText ?? (clamped === null ? 'unknown' : `${Math.round(clamped)}% used`);
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel}>{label}</span>
        <span className={styles.meterValue}>{text}</span>
      </div>
      <div
        className={styles.meterTrack}
        role="meter"
        aria-label={typeof label === 'string' ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped ?? undefined}
        aria-valuetext={text}
      >
        <div className={styles.meterFill} data-tone={meterTone(clamped)} style={{ width: `${clamped ?? 0}%` }} />
      </div>
      {note ? <span className={styles.meterNote}>{note}</span> : null}
    </div>
  );
}

export function Banner({ tone = 'warning', children }: { tone?: 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {body ? <p className={styles.emptyBody}>{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title, reason, onRetry }: { title: string; reason: string | null; onRetry?: () => void }) {
  return (
    <div className={styles.empty} role="alert">
      <p className={styles.emptyTitle}>{title}</p>
      {reason ? <p className={styles.emptyBody}>{reason}</p> : null}
      {onRetry ? <Button variant="tinted" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}
