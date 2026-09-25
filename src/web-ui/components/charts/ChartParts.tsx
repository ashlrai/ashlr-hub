/**
 * components/charts/ChartParts.tsx — small shared pieces of the V3.10 charts:
 * the legend list, the tooltip, the unknown hatch and the engine tick.
 * Identity is never colour alone: every swatch sits beside its text label,
 * and text always wears text tokens.
 */
import type { ReactNode } from 'react';
import { UNKNOWN_HATCH, engineColor, type ChartEngine } from './colors.js';
import plot from './plot.module.css';
import { ProviderLogo } from '../primitives/ProviderLogo.js';

export interface ChartLegendItem {
  label: string;
  color?: string;
  /** `hatch` = the unknown texture (not measured), never a colour. */
  kind?: 'swatch' | 'line' | 'empty' | 'hatch';
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
            className={
              item.kind === 'line' ? plot.swatchLine : item.kind === 'empty' ? plot.swatchEmpty : item.kind === 'hatch' ? plot.swatchHatch : plot.swatch
            }
            style={item.kind === 'empty' || item.kind === 'hatch' ? undefined : { background: item.color }}
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

// ---------------------------------------------------------------------------
// Unknown hatch (V3.10) — one <pattern> per chart instance
// ---------------------------------------------------------------------------

/**
 * The 45° unknown hatch as an SVG <pattern>. Render it inside the chart's own
 * <svg><defs> with an id from `hatchPatternId(useId())` (colors.ts) — ids are
 * document-global, so a shared literal id would let one chart's unmount blank
 * another's hatch — then fill unknown marks with `url(#id)` and outline them
 * with CHART_UNKNOWN. Texture, not hue, is what separates "not measured" from
 * a low value, so it survives colour-blindness and greyscale print.
 */
export function HatchPattern({ id }: { id: string }) {
  const { size, angle, strokeWidth, stroke } = UNKNOWN_HATCH;
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform={`rotate(${angle})`}>
      <line x1={0} y1={0} x2={0} y2={size} stroke={stroke} strokeWidth={strokeWidth} />
    </pattern>
  );
}

// ---------------------------------------------------------------------------
// Engine identity (V3.10) — a 2px tick plus a one-letter monogram
// ---------------------------------------------------------------------------

const ENGINE_LETTER: Readonly<Record<ChartEngine, string>> = { claude: 'C', codex: 'X', grok: 'G', local: 'L' };

/** The monogram letter for an engine (mirrors workbench-types ENGINE_MONOGRAM; charts stay core-free). */
export function engineLetter(engine: ChartEngine): string {
  return ENGINE_LETTER[engine];
}

/**
 * SVG engine mark for a lane label: the 2px identity tick and the provider's
 * mark (3.11.1, ProviderLogo). The engine's NAME still travels in the lane's
 * spoken summary and the table — the mark is a glance aid only.
 */
export function EngineTick({ engine, x, y, height }: { engine: ChartEngine; x: number; y: number; height: number }) {
  return (
    <g data-engine={engine} aria-hidden="true">
      <rect x={x} y={y} width={2} height={height} rx={1} fill={engineColor(engine)} />
      <ProviderLogo engine={engine} x={x + 5} y={y + height / 2 - 6} size={12} className={plot.monogram} />
    </g>
  );
}

/** A quiet ⋯ glyph (three dots), currentColor, 16px. */
export function MoreGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx={3.5} cy={8} r={1.4} fill="currentColor" />
      <circle cx={8} cy={8} r={1.4} fill="currentColor" />
      <circle cx={12.5} cy={8} r={1.4} fill="currentColor" />
    </svg>
  );
}
