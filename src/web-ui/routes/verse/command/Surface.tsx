/**
 * routes/verse/command/Surface.tsx — the layout every 3.10 surface shares
 * (Command, Fleet, Growth, Mind; SPEC-310C §5 + DESIGN.md §13.4).
 *
 *   - a 48px strip with the surface title (Grotesk 20/28) and its actions;
 *   - one scroll region;
 *   - a 12-column grid (`--surface-columns`) with 16px gaps and
 *     `align-items: start` — a card is never stretched to the tallest card
 *     in its row (the 3.9 harness showed half-empty chart cards);
 *   - spans come from the viewport class, never a hard-coded breakpoint:
 *     wide uses the span as written, medium folds a span ≤ 6 to half width
 *     and anything wider to full width, compact (375) is one column in DOM
 *     order — which is why every surface writes its cards in the order the
 *     phone should show them.
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import { useViewport, type ViewportClass } from '../shell/viewport.js';
import styles from './surface.module.css';

/** The grid span a card gets at a viewport class. Pure (tested). */
export function spanFor(viewport: ViewportClass, span: number): number {
  const s = Math.max(1, Math.min(12, Math.round(span)));
  if (viewport === 'compact') return 12;
  if (viewport === 'medium') return s <= 6 ? 6 : 12;
  return s;
}

export interface SurfaceProps {
  /** Accessible name and visible title ("Command"). */
  title: string;
  /** Right side of the strip (refresh indicator, etc.). */
  actions?: ReactNode;
  /** Rendered above the grid, full width (the Command top bar, the verdict). */
  lead?: ReactNode;
  children: ReactNode;
}

export function Surface({ title, actions, lead, children }: SurfaceProps) {
  const titleId = useId();
  const { viewport } = useViewport();
  return (
    <section className={styles.surface} aria-labelledby={titleId} data-viewport={viewport}>
      <header className={styles.strip} data-app-region="drag">
        <h2 id={titleId} className={styles.title}>{title}</h2>
        {actions ? <div className={styles.stripActions}>{actions}</div> : null}
      </header>
      <div className={styles.scroll}>
        <div className={styles.body}>
          {lead}
          <div className={styles.grid}>{children}</div>
        </div>
      </div>
    </section>
  );
}

/** One grid cell. `span` is the 1440 layout's column count (SPEC-310C §5 table). */
export function Cell({ span, children, className, id }: { span: number; children: ReactNode; className?: string; id?: string }) {
  const { viewport } = useViewport();
  const style: CSSProperties = { gridColumn: `span ${spanFor(viewport, span)}` };
  return (
    <div id={id} className={`${styles.cell} ${className ?? ''}`} style={style} data-span={span}>
      {children}
    </div>
  );
}

/**
 * A non-chart card with the same frame as ChartFrame: title (13/18 600),
 * one caption line, then the body. Charts bring their own frame.
 */
export function Card({
  title,
  caption,
  actions,
  children,
  tone,
  labelledBy,
}: {
  title: ReactNode;
  caption?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** A quiet emphasis for the one card that needs the operator (Needs you). */
  tone?: 'attention';
  labelledBy?: string;
}) {
  const ownId = useId();
  const titleId = labelledBy ?? ownId;
  return (
    <section className={styles.card} aria-labelledby={titleId} data-tone={tone}>
      <header className={styles.cardHead}>
        <span className={styles.cardHeading}>
          <h3 id={titleId} className={styles.cardTitle}>{title}</h3>
          {caption ? <span className={styles.cardCaption}>{caption}</span> : null}
        </span>
        {actions ? <span className={styles.cardActions}>{actions}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** A designed not-available / unknown line inside a card. */
export function CardNote({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'unknown' | 'danger' }) {
  return (
    <p className={styles.note} data-tone={tone} role={tone === 'danger' ? 'alert' : 'note'}>
      {children}
    </p>
  );
}

/** The micro-label (11/14 uppercase) used for group headings inside cards. */
export function MicroLabel({ children }: { children: ReactNode }) {
  return <span className={styles.micro}>{children}</span>;
}
