/**
 * components/charts/ChartContainer.tsx — the figure every chart mounts
 * inside: title/description, the plot itself, an optional caveat banner
 * (epistemic-honesty-adjacent: for a chart built on data with a known,
 * disclosed limitation — see ProductionView's judge-verdict caveat), an
 * optional table-view twin (the WCAG-clean accessibility equivalent every
 * chart should ship per the dataviz skill), and an empty state that never
 * lies about missing data.
 */
import type { ReactNode } from 'react';
import './chart-tokens.css';
import styles from './ChartContainer.module.css';

export interface ChartContainerProps {
  title: string;
  description?: string;
  /** A short, honest note about a known limitation of the data behind this
   * chart (e.g. "counts may include X, not yet separable"). Never omit a
   * caveat to make a chart look cleaner than the data actually is. */
  caveat?: string;
  /** The chart itself (SVG + legend). */
  children: ReactNode;
  /** The accessibility twin — same data as a real HTML table. Omit only
   * when the chart already IS a table. */
  table?: ReactNode;
  /** When true, renders the empty state instead of `children`. */
  empty?: boolean;
  emptyMessage?: string;
}

export function ChartContainer({
  title,
  description,
  caveat,
  children,
  table,
  empty,
  emptyMessage = 'No data for this window.',
}: ChartContainerProps) {
  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.title}>{title}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </figcaption>
      {caveat ? (
        <p className={styles.caveat} role="note">
          {caveat}
        </p>
      ) : null}
      {empty ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        <div className={styles.plot}>{children}</div>
      )}
      {table ? (
        <details className={styles.tableDisclosure}>
          <summary>View as table</summary>
          <div className={styles.tableBody}>{table}</div>
        </details>
      ) : null}
    </figure>
  );
}
