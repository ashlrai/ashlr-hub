/**
 * components/charts/Sparkline.tsx — the 12-ish-point inline trend for a
 * stat tile (marks-and-anatomy.md "Figures" stat-tile contract). No axes,
 * no legend, no tooltip — it is a glance, not a chart; the real numbers
 * live in the stat tile's value and in the full chart elsewhere on the
 * view. Gaps (`null`) break the line rather than reading as a dip to zero.
 */
import './chart-tokens.css';
import styles from './Sparkline.module.css';

export function Sparkline({
  points,
  width = 72,
  height = 24,
  ariaLabel,
}: {
  points: (number | null)[];
  width?: number;
  height?: number;
  ariaLabel: string;
}) {
  const known = points.filter((p): p is number => p !== null);
  if (known.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} />
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

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
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
