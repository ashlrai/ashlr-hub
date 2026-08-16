/**
 * components/charts/TableView.tsx — the WCAG-clean accessibility twin every
 * chart should ship (dataviz skill: "no table view / color-only encoding on
 * a continuous scale" is an anti-pattern). Every value a chart's tooltip or
 * direct label shows must also be reachable here without hovering anything.
 */
import type { ReactNode } from 'react';
import styles from './TableView.module.css';

export interface TableColumn<T> {
  key: string;
  label: string;
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

export function TableView<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
}) {
  return (
    <table className={styles.table}>
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.numeric ? styles.numeric : undefined}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)}>
            {columns.map((c) => (
              <td key={c.key} className={c.numeric ? styles.numeric : undefined}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
