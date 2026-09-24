/**
 * components/charts/ChartFrame.tsx — the shell every V3.10 chart renders in:
 * title + description, an honest caveat, a Chart | Table toggle (the table is
 * the WCAG-clean twin, reachable without hovering anything), and the designed
 * non-ready states. A chart never draws empty axes: it says what the
 * emptiness means.
 *
 *   loading  — the previous render is held when there is one (no skeleton
 *              flash on refetch); otherwise a quiet placeholder.
 *   empty    — "No runs in this window." A genuine, known zero.
 *   dark     — "Fleet dark since Sep 1": nothing has happened since a date.
 *   unknown  — the source could not be read. Never drawn as zeros.
 */
import { useId, useState, type ReactNode } from 'react';
import { Segmented } from '../primitives/Segmented.js';
import { formatDayLabel } from './format.js';
import './chart-tokens.css';
import styles from './ChartFrame.module.css';

export type ChartStatus =
  | { kind: 'ready' }
  | { kind: 'loading' }
  | { kind: 'empty'; message?: string }
  | { kind: 'dark'; since: string; subject?: string; detail?: string }
  | { kind: 'unknown'; reason?: string };

export type ChartView = 'chart' | 'table';

export interface ChartFrameProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  /** Start on the table (e.g. a screen-reader-first surface). */
  defaultView?: ChartView;
  /** Hide the Chart | Table toggle (only for a chart that already IS its numbers). */
  hideToggle?: boolean;
  /** The plot. Receives the id of the frame's title for aria-labelledby. */
  children: ReactNode;
  table: ReactNode;
  /** Rendered under the plot in chart view (legends, notes). */
  footer?: ReactNode;
}

/** "Sep 1" from an ISO timestamp or YYYY-MM-DD (UTC day, like the axis labels). */
export function sinceLabel(since: string): string {
  return formatDayLabel(since.slice(0, 10));
}

function StatusMessage({ status }: { status: Exclude<ChartStatus, { kind: 'ready' }> }): ReactNode {
  switch (status.kind) {
    case 'loading':
      return <p className={styles.state} aria-busy="true">Loading…</p>;
    case 'empty':
      return <p className={styles.state}>{status.message ?? 'Nothing happened in this window.'}</p>;
    case 'dark':
      return (
        <div className={`${styles.state} ${styles.dark}`}>
          <p className={styles.darkTitle}>
            {status.subject ?? 'Fleet'} dark since {sinceLabel(status.since)}
          </p>
          <p className={styles.darkBody}>{status.detail ?? 'No runs or proposals have been recorded since then.'}</p>
        </div>
      );
    case 'unknown':
      return (
        <p className={`${styles.state} ${styles.unknown}`} role="note">
          Unknown — {status.reason ?? 'the data source could not be read.'} Nothing is shown rather than a guess.
        </p>
      );
  }
}

export function ChartFrame({
  title,
  description,
  caveat,
  status = { kind: 'ready' },
  defaultView = 'chart',
  hideToggle = false,
  children,
  table,
  footer,
}: ChartFrameProps) {
  const [view, setView] = useState<ChartView>(defaultView);
  const titleId = useId();
  const ready = status.kind === 'ready';
  return (
    <figure className={styles.frame} aria-labelledby={titleId}>
      <figcaption className={styles.header}>
        <span className={styles.heading}>
          <span id={titleId} className={styles.title}>{title}</span>
          {description ? <span className={styles.description}>{description}</span> : null}
        </span>
        {ready && !hideToggle ? (
          <Segmented<ChartView>
            size="sm"
            aria-label={`${title}: view as`}
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
          />
        ) : null}
      </figcaption>
      {caveat ? (
        <p className={styles.caveat} role="note">
          {caveat}
        </p>
      ) : null}
      {!ready ? (
        <StatusMessage status={status} />
      ) : view === 'table' ? (
        <div className={styles.table}>{table}</div>
      ) : (
        <>
          <div className={styles.plot}>{children}</div>
          {footer}
        </>
      )}
    </figure>
  );
}
