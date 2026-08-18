/**
 * components/charts/Legend.tsx — the dependable identity channel. A legend
 * is always present for two or more series (never rely on color-matching
 * alone); a single series needs no legend box because the chart's own title
 * already names it (see marks-and-anatomy.md "Labels & legend").
 */
import styles from './Legend.module.css';

export interface LegendItem {
  label: string;
  color: string;
  /** 'line' for line charts (a short stroke key), 'swatch' for bar/area. */
  kind?: 'line' | 'swatch';
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className={styles.legend}>
      {items.map((it) => (
        <li key={it.label} className={styles.item}>
          <span
            className={it.kind === 'line' ? styles.swatchLine : styles.swatch}
            style={{ background: it.color }}
            aria-hidden="true"
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
