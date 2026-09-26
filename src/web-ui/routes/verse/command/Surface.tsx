/**
 * routes/verse/command/Surface.tsx — the layout every 3.10 surface shares
 * (Command, Fleet, Growth, Mind; SPEC-310C §5 + DESIGN.md §13.4).
 *
 *   - a 48px strip with the surface title (Grotesk 20/28) and its actions;
 *   - one scroll region;
 *   - a 12-column grid (`--surface-columns`) with 16px gaps. Cards that
 *     share a row are one height (a plain Card fills its cell); a chart frame
 *     keeps its natural height, never stretched to a taller neighbour (the
 *     3.9 harness showed half-empty chart cards);
 *   - spans come from the viewport class, never a hard-coded breakpoint:
 *     wide uses the span as written; medium keeps each wide ROW whole —
 *     a pair that fills 12 columns (5 | 7, 8 | 4) becomes 6 | 6 instead of
 *     half + full with a blank half-row between (audit 15), and any other
 *     cell folds ≤ 6 to half width and wider to full; compact (375) is one
 *     column in DOM order — which is why every surface writes its cards in
 *     the order the phone should show them.
 */
import { Children, cloneElement, isValidElement, useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useViewport, type ViewportClass } from '../shell/viewport.js';
import styles from './surface.module.css';

const clampSpan = (span: number): number => Math.max(1, Math.min(12, Math.round(Number.isFinite(span) ? span : 12)));

/** The grid span ONE card gets at a viewport class, on its own (no row context). Pure (tested). */
export function spanFor(viewport: ViewportClass, span: number): number {
  const s = clampSpan(span);
  if (viewport === 'compact') return 12;
  if (viewport === 'medium') return s <= 6 ? 6 : 12;
  return s;
}

/**
 * The spans a run of cells gets at a viewport class, in DOM order. Pure (tested).
 *
 * At medium the cells are grouped into the rows the wide grid would draw
 * (auto-placement: a cell that does not fit starts the next row). A row that
 * exactly fills 12 columns with two or more cells is treated as a unit: every
 * cell goes to half width, and an odd one out (a 4 | 4 | 4 trio's third)
 * takes the full row — so no row is left with a blank half. A row that does
 * not fill 12 (the surface's own layout left room) folds cell by cell.
 */
export function layoutSpans(viewport: ViewportClass, spans: readonly number[]): number[] {
  const wide = spans.map(clampSpan);
  const out = wide.map((s) => spanFor(viewport, s));
  if (viewport !== 'medium') return out;
  let start = 0;
  let sum = 0;
  for (let i = 0; i < wide.length; i += 1) {
    if (sum + wide[i]! > 12) {
      start = i;
      sum = 0;
    }
    sum += wide[i]!;
    if (sum === 12) {
      const count = i - start + 1;
      if (count >= 2) {
        for (let j = start; j <= i; j += 1) out[j] = 6;
        if (count % 2 === 1) out[i] = 12;
      }
      start = i + 1;
      sum = 0;
    }
  }
  return out;
}

interface CellProps {
  span: number;
  children: ReactNode;
  className?: string;
  id?: string;
  /** Set by Surface from the whole grid's rows (layoutSpans); a Cell outside a Surface falls back to spanFor. */
  layoutSpan?: number;
}

function isCell(node: ReactNode): node is ReactElement<CellProps> {
  return isValidElement(node) && node.type === Cell;
}

/**
 * Hands each direct Cell child its span for this viewport, computed across the
 * whole run so rows stay whole. Only direct children (and arrays) are seen —
 * a Cell nested in a fragment keeps its own `spanFor` fallback.
 */
function laidOut(children: ReactNode, viewport: ViewportClass): ReactNode[] {
  const items = Children.toArray(children);
  const spans = layoutSpans(viewport, items.filter(isCell).map((c) => c.props.span));
  let k = 0;
  return items.map((child) => (isCell(child) ? cloneElement(child, { layoutSpan: spans[k++] }) : child));
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
          <div className={styles.grid}>{laidOut(children, viewport)}</div>
        </div>
      </div>
    </section>
  );
}

/** One grid cell. `span` is the 1440 layout's column count (SPEC-310C §5 table). */
export function Cell({ span, children, className, id, layoutSpan }: CellProps) {
  const { viewport } = useViewport();
  const style: CSSProperties = { gridColumn: `span ${layoutSpan ?? spanFor(viewport, span)}` };
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
