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
 */
import './chart-tokens.css';
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

export function Sparkline({
  points,
  width = 72,
  height = 24,
  ariaLabel,
  area = false,
  describe,
}: {
  points: (number | null)[];
  width?: number;
  height?: number;
  ariaLabel: string;
  /** Soft 10% wash under the line. */
  area?: boolean;
  /** When given, a spoken summary is appended to `ariaLabel`. */
  describe?: (v: number) => string;
}) {
  const label = describe ? `${ariaLabel}: ${sparklineSummary(points, describe)}` : ariaLabel;
  const known = points.filter((p): p is number => p !== null);
  if (known.length < 2) {
    return (
      <svg className={styles.sparkline} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <line className={styles.flat} x1={1} x2={width - 1} y1={height - 1.5} y2={height - 1.5} />
      </svg>
    );
  }
  const min = Math.min(...known, 0);
  const max = Math.max(...known, 0);
  const range = max - min || 1;
  const stepX = width / Math.max(1, points.length - 1);
  const yOf = (v: number) => height - ((v - min) / range) * (height - 2) - 1;

  // Split into contiguous runs so a null renders as a real gap, not a dip.
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  points.forEach((v, i) => {
    if (v === null) {
      if (current.length) runs.push(current);
      current = [];
      return;
    }
    current.push({ x: i * stepX, y: yOf(v) });
  });
  if (current.length) runs.push(current);

  const lastKnownIndex = points.map((v) => v !== null).lastIndexOf(true);
  const lastPoint =
    lastKnownIndex >= 0 ? { x: lastKnownIndex * stepX, y: yOf(points[lastKnownIndex] as number) } : null;
  const baseY = yOf(Math.max(min, 0));

  return (
    <svg className={styles.sparkline} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {area
        ? runs.map((run, i) =>
            run.length > 1 ? (
              <path
                key={`a${i}`}
                className={styles.area}
                d={`${run.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${run[run.length - 1]!.x.toFixed(1)},${baseY.toFixed(1)} L${run[0]!.x.toFixed(1)},${baseY.toFixed(1)} Z`}
              />
            ) : null,
          )
        : null}
      {runs.map((run, i) => (
        <path
          key={i}
          className={styles.line}
          d={run.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
        />
      ))}
      {lastPoint ? <circle className={styles.dot} cx={lastPoint.x} cy={lastPoint.y} r={2} /> : null}
    </svg>
  );
}
