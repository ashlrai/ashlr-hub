/**
 * components/charts/ChartParts.tsx — small shared pieces of the V3.10 charts:
 * the legend list and the tooltip. Identity is never colour alone: every
 * swatch sits beside its text label, and text always wears text tokens.
 */
import type { ReactNode } from 'react';
import plot from './plot.module.css';

export interface ChartLegendItem {
  label: string;
  color?: string;
  kind?: 'swatch' | 'line' | 'empty';
}

/** Renders nothing for fewer than `min` items (a lone series is named by the title). */
export function ChartLegend({ items, min = 2 }: { items: ChartLegendItem[]; min?: number }): ReactNode {
  if (items.length < min) return null;
  return (
    <ul className={plot.legend}>
      {items.map((item) => (
        <li key={item.label} className={plot.legendItem}>
          <span
            aria-hidden="true"
            className={item.kind === 'line' ? plot.swatchLine : item.kind === 'empty' ? plot.swatchEmpty : plot.swatch}
            style={item.kind === 'empty' ? undefined : { background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  key: string;
  label: string;
  value: string | null;
  color?: string;
}

/**
 * Positioned in the plot's own pixel space (the plot wrapper is
 * position:relative). `left` is clamped by the caller so it never overflows.
 */
export function ChartTooltip({ left, top, title, rows }: { left: number; top: number; title: string; rows: TooltipRow[] }) {
  return (
    <div className={plot.tooltip} style={{ left, top }} role="presentation">
      <div className={plot.tooltipTitle}>{title}</div>
      {rows.map((row) => (
        <div key={row.key} className={plot.tooltipRow}>
          {row.color ? <span className={plot.tooltipKey} style={{ background: row.color }} aria-hidden="true" /> : null}
          <span>{row.label}</span>
          {row.value === null ? (
            <span className={`${plot.tooltipValue} ${plot.tooltipMuted}`}>no data</span>
          ) : (
            <span className={plot.tooltipValue}>{row.value}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Keep a centred tooltip inside [margin, width - margin]. */
export function clampTooltipLeft(x: number, width: number, margin = 70): number {
  return Math.min(Math.max(x, Math.min(margin, width / 2)), Math.max(width - margin, width / 2));
}
