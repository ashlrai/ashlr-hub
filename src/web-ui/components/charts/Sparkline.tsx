/**
 * components/charts/Sparkline.tsx — the 12-ish-point inline trend for a
 * stat tile (marks-and-anatomy.md "Figures" stat-tile contract). No axes,
 * no legend, no tooltip — it is a glance, not a chart; the real numbers
 * live in the stat tile's value and in the full chart elsewhere on the
 * view. Gaps (`null`) break the line rather than reading as a dip to zero.
 *
 * V3.10: optional `area` wash, an optional `describe` formatter that appends a
 * spoken summary (first → latest, min–max) to the aria-label so the glance is
 * not image-only for a screen reader, and a designed flat/unknown state (a
 * dashed baseline) instead of an empty box when fewer than two points are known.
 *
 * Polish (verse-visual-quality): the line is the quantity ink (azure, not a
 * gray that read as "disabled"), drawn as a monotone curve through every
 * point (chart-math — it never overshoots, so no invented peak), the wash is
 * a gradient of that ink, the latest point is a ringed dot, `width="fill"`
 * spans the tile instead of a fixed 112 px stub, and the line draws itself in
 * once on mount unless reduced motion is asked for (motion.ts).
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AreaGradient } from './ChartParts.js';
import { CHART_SEQUENTIAL, gradientId } from './colors.js';
import { smoothAreaPath, smoothPath, type XY } from './chart-math.js';
import { useChartMotion } from './motion.js';
import './chart-tokens.css';
import plot from './plot.module.css';
import styles from './Sparkline.module.css';

export function sparklineSummary(points: (number | null)[], format: (v: number) => string): string {
  const known = points.filter((p): p is number => p !== null && Number.isFinite(p));
  if (known.length === 0) return 'no data';
  const first = known[0]!;
  const latest = known[known.length - 1]!;
  const gaps = points.length - known.length;
  return `from ${format(first)} to ${format(latest)}, range ${format(Math.min(...known))} to ${format(Math.max(...known))}` +
    (gaps > 0 ? `, ${gaps} point${gaps === 1 ? '' : 's'} without data` : '');
}

/** Width a `fill` sparkline draws at before its box is measured (jsdom, first paint). */
const FILL_FALLBACK_W = 112;

/** The measured width of a `fill` sparkline's box (no chart minimum: a tile can be narrow). */
function useFillWidth(enabled: boolean): [RefObject<HTMLSpanElement | null>, number] {
  const ref = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState<number>(FILL_FALLBACK_W);
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const read = (): void => {
      const next = Math.floor(el.getBoundingClientRect().width);
      if (next > 0) setW((prev) => (prev === next ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled]);
  return [ref, w];
}

export function Sparkline({
  points,
  width = 72,
  height = 24,
  ariaLabel,
  area = false,
  describe,
  color = CHART_SEQUENTIAL,
}: {
  points: (number | null)[];
  /** Pixels, or `fill` to span the containing box (StatTile). */
  width?: number | 'fill';
  height?: number;
  ariaLabel: string;
  /** Soft gradient wash under the line. */
  area?: boolean;
  /** When given, a spoken summary is appended to `ariaLabel`. */
  describe?: (v: number) => string;
  /** The line's ink (default: the quantity azure). */
  color?: string;
}) {
  const fill = width === 'fill';
  const [boxRef, measured] = useFillWidth(fill);
  const w = fill ? measured : width;
  const motion = useChartMotion();
  const gradKey = useId();
  const label = describe ? `${ariaLabel}: ${sparklineSummary(points, describe)}` : ariaLabel;
  const known = points.filter((p): p is number => p !== null);

  // Pad by the end dot's radius + ring so it is never cropped at the edge.
  const PAD = 3.5;
  let body: ReactNode;
  if (known.length < 2) {
    body = <line className={styles.flat} x1={1} x2={w - 1} y1={height - 1.5} y2={height - 1.5} />;
  } else {
    const min = Math.min(...known, 0);
    const max = Math.max(...known, 0);
    const range = max - min || 1;
    const stepX = (w - PAD * 2) / Math.max(1, points.length - 1);
    const yOf = (v: number) => PAD + (1 - (v - min) / range) * (height - PAD * 2);

    // Split into contiguous runs so a null renders as a real gap, not a dip.
    const runs: XY[][] = [];
    let current: XY[] = [];
    points.forEach((v, i) => {
      if (v === null) {
        if (current.length) runs.push(current);
        current = [];
        return;
      }
      current.push({ x: PAD + i * stepX, y: yOf(v) });
    });
    if (current.length) runs.push(current);

    const lastKnownIndex = points.map((v) => v !== null).lastIndexOf(true);
    const lastPoint = lastKnownIndex >= 0 ? { x: PAD + lastKnownIndex * stepX, y: yOf(points[lastKnownIndex] as number) } : null;
    const baseY = yOf(Math.max(min, 0));
    const gid = gradientId(gradKey, 'spark');

    body = (
      <>
        {area ? (
          <defs>
            <AreaGradient id={gid} color={color} top={PAD} bottom={baseY} from={0.28} />
          </defs>
        ) : null}
        {area
          ? runs.map((run, i) =>
              run.length > 1 ? (
                <path
                  key={`a${i}`}
                  className={`${styles.area} ${plot.fadeIn}`}
                  fill={`url(#${gid})`}
                  d={smoothAreaPath(run, run.map((p) => ({ x: p.x, y: baseY })))}
                />
              ) : null,
            )
          : null}
        {runs.map((run, i) => (
          <path key={i} className={`${styles.line} ${plot.draw}`} pathLength={1} stroke={color} d={smoothPath(run)} />
        ))}
        {lastPoint ? <circle className={`${styles.dot} ${plot.fadeIn}`} cx={lastPoint.x} cy={lastPoint.y} r={2.5} fill={color} /> : null}
      </>
    );
  }

  const svg = (
    <svg className={styles.sparkline} width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
      {body}
    </svg>
  );
  return (
    <span ref={boxRef} className={fill ? styles.fillBox : styles.box} data-motion={motion}>
      {svg}
    </span>
  );
}
