/**
 * components/charts/ChartParts.tsx — small shared pieces of the V3.10 charts:
 * the legend list, the tooltip, the unknown hatch, the engine tick, the area
 * gradient and the shaped loading skeleton.
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
  /** The key's shape: a short stroke for a line series, a square for a filled mark (default). */
  kind?: 'line' | 'swatch';
  /** A summary row (Total): set apart by a hairline above it. */
  total?: boolean;
}

/**
 * Positioned in the plot's own pixel space (the plot wrapper is
 * position:relative). `left` is clamped by the caller so it never overflows.
 * The title is the exact moment or category (local time on a time axis —
 * format.ts tooltipTimeFormatter); values are the exact figures, never the
 * axis's rounded tick. Presentation only: the same text reaches a screen
 * reader through each chart's live region, and the Table twin.
 */
export function ChartTooltip({
  left,
  top,
  title,
  rows,
  side,
}: {
  left: number;
  top: number;
  title: string;
  rows: TooltipRow[];
  /**
   * Beside the crosshair instead of centred above the mark: `right` / `left`
   * of `left`, top-aligned at `top` INSIDE the plot (tooltipSide picks one).
   * A time series uses this so the tooltip never covers the card's title or
   * the point being read, and is never clipped by a scrolling container.
   */
  side?: 'left' | 'right';
}) {
  const cls = side === 'right' ? `${plot.tooltip} ${plot.tooltipRight}` : side === 'left' ? `${plot.tooltip} ${plot.tooltipLeft}` : plot.tooltip;
  return (
    <div className={cls} style={{ left, top }} role="presentation" data-chart-tooltip={side ?? 'above'}>
      <div className={plot.tooltipTitle}>{title}</div>
      {rows.map((row) => (
        <div key={row.key} className={row.total ? `${plot.tooltipRow} ${plot.tooltipTotal}` : plot.tooltipRow}>
          {row.color ? (
            <span
              className={row.kind === 'line' ? plot.tooltipKeyLine : plot.tooltipKey}
              style={{ background: row.color }}
              aria-hidden="true"
            />
          ) : null}
          <span className={plot.tooltipLabel}>{row.label}</span>
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

/** Estimated width of a tooltip, for choosing its side (it grows with its rows' text). */
const TOOLTIP_EST_W = 172;
const TOOLTIP_GAP = 12;

/**
 * Which side of the crosshair at `x` a tooltip fits on in a `width`-wide plot:
 * right while it fits, else left, else undefined (centred above, clamped).
 */
export function tooltipSide(x: number, width: number, estimate = TOOLTIP_EST_W): 'left' | 'right' | undefined {
  if (x + TOOLTIP_GAP + estimate <= width) return 'right';
  if (x - TOOLTIP_GAP - estimate >= 0) return 'left';
  return undefined;
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

const ENGINE_LETTER: Readonly<Record<ChartEngine, string>> = { claude: 'C', codex: 'X', grok: 'G', local: 'L', devin: 'D' };

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

// ---------------------------------------------------------------------------
// Area gradient (verse-visual-quality)
// ---------------------------------------------------------------------------

/**
 * The wash under a line: the series' own ink fading from `from` opacity at
 * the top of the plot to nothing at the baseline. Replaces the flat 10%
 * wash: the line stays the strongest mark (it IS the data) while the fill
 * still says "area = volume", and it reads the same in both themes because
 * the stop colour is the series token itself. Render once per series inside
 * the chart's own <defs>, with an id from `gradientId(useId(), key)` —
 * document-global ids, same reason as the hatch.
 *
 * `userSpaceOnUse`, pinned to the plot's top and baseline rather than each
 * path's bounding box: two series then fade on ONE scale, so a small series
 * is not painted as darkly as a large one.
 */
export function AreaGradient({ id, color, top, bottom, from = 0.22 }: { id: string; color: string; top: number; bottom: number; from?: number }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={top} y2={bottom} data-area-gradient="">
      <stop offset="0%" style={{ stopColor: color, stopOpacity: from }} />
      <stop offset="65%" style={{ stopColor: color, stopOpacity: from * 0.3 }} />
      <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
    </linearGradient>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons (verse-visual-quality)
// ---------------------------------------------------------------------------

/** The outline a loading chart holds, so the card does not jump when data lands. */
export type ChartSkeletonShape = 'line' | 'bars' | 'lanes' | 'funnel' | 'heat' | 'gauge';

/* Deterministic placeholder "data" — never random, so a skeleton is the same
   on every render and in every test. */
const SKELETON_BARS = [0.42, 0.58, 0.35, 0.7, 0.52, 0.8, 0.46, 0.64, 0.55, 0.74, 0.5, 0.62];
const SKELETON_LINE = [0.55, 0.6, 0.48, 0.52, 0.4, 0.46, 0.36, 0.42, 0.3, 0.34, 0.28];
const SKELETON_W = 600;

function skeletonBody(shape: ChartSkeletonShape, H: number): ReactNode {
  const W = SKELETON_W;
  const grid = [0.25, 0.5, 0.75].map((f) => (
    <line key={`g${f}`} className={plot.skeletonGrid} x1={0} x2={W} y1={H * f} y2={H * f} />
  ));
  switch (shape) {
    case 'bars': {
      const slot = W / SKELETON_BARS.length;
      return (
        <>
          {grid}
          {SKELETON_BARS.map((f, i) => (
            <rect key={i} className={plot.skeletonMark} x={i * slot + slot * 0.25} width={slot * 0.5} y={H - H * f * 0.9} height={H * f * 0.9} rx={3} />
          ))}
        </>
      );
    }
    case 'lanes': {
      const rows = Math.max(2, Math.min(6, Math.floor(H / 32)));
      const rowH = H / rows;
      return Array.from({ length: rows }, (_, i) => (
        <g key={i}>
          <rect className={plot.skeletonMark} x={0} y={i * rowH + rowH * 0.3} width={90} height={rowH * 0.4} rx={3} />
          <rect className={plot.skeletonMark} x={130 + ((i * 97) % 180)} y={i * rowH + rowH * 0.25} width={120 + ((i * 53) % 200)} height={rowH * 0.5} rx={3} />
        </g>
      ));
    }
    case 'funnel': {
      const rows = 5;
      const rowH = H / rows;
      return Array.from({ length: rows }, (_, i) => (
        <g key={i}>
          <rect className={plot.skeletonTrack} x={140} y={i * rowH + rowH * 0.2} width={W - 240} height={rowH * 0.6} rx={4} />
          <rect className={plot.skeletonMark} x={140} y={i * rowH + rowH * 0.2} width={(W - 240) * (1 - i * 0.18)} height={rowH * 0.6} rx={4} />
        </g>
      ));
    }
    case 'heat': {
      const cols = 20;
      const rows = 7;
      const cw = W / cols;
      const ch = H / rows;
      return Array.from({ length: cols * rows }, (_, i) => (
        <rect
          key={i}
          className={(i * 7) % 5 === 0 ? plot.skeletonMark : plot.skeletonTrack}
          x={(i % cols) * cw + 1.5}
          y={Math.floor(i / cols) * ch + 1.5}
          width={cw - 3}
          height={ch - 3}
          rx={2}
        />
      ));
    }
    case 'gauge':
      return <circle className={plot.skeletonMark} cx={W / 2} cy={H / 2} r={H / 2} />;
    case 'line':
    default: {
      const step = W / (SKELETON_LINE.length - 1);
      const top = SKELETON_LINE.map((f, i) => `${i === 0 ? 'M' : 'L'}${i * step},${H * f}`).join(' ');
      return (
        <>
          {grid}
          <path className={plot.skeletonMark} d={`${top} L${W},${H} L0,${H} Z`} />
        </>
      );
    }
  }
}

/**
 * A placeholder in the final chart's shape and height — gridlines where the
 * gridlines will be, columns where columns will be, lanes where lanes will
 * be — in the neutral hover tint, with a slow pulse that stops under reduced
 * motion. Presentation only (aria-hidden): ChartFrame announces "Loading…".
 */
export function ChartSkeleton({ shape = 'line', height = 200 }: { shape?: ChartSkeletonShape; height?: number }) {
  const H = Math.max(48, height);
  return (
    <svg
      className={plot.skeleton}
      data-chart-skeleton={shape}
      width="100%"
      height={H}
      viewBox={`0 0 ${SKELETON_W} ${H}`}
      preserveAspectRatio={shape === 'gauge' ? 'xMidYMid meet' : 'none'}
      aria-hidden="true"
      focusable="false"
    >
      {skeletonBody(shape, H)}
    </svg>
  );
}
