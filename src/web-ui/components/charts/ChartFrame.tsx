/**
 * components/charts/ChartFrame.tsx — the shell every V3.10 chart renders in:
 * title + description, an honest caveat, the Table twin (the WCAG-clean view,
 * reachable without hovering anything), and the designed non-ready states. A
 * chart never draws empty axes: it says what the emptiness means.
 *
 *   loading  — the previous render is held when there is one (no skeleton
 *              flash on refetch); otherwise a quiet placeholder.
 *   empty    — "No runs in this window." A genuine, known zero.
 *   dark     — "Fleet dark since Sep 1": nothing has happened since a date.
 *   unknown  — the source could not be read. Never drawn as zeros.
 *
 * V3.10 (SPEC-310C §6 "Table toggle: moves into ⋯"): the Chart | Table
 * segmented control used to sit beside every title — noise on a KPI-sized
 * card, and it wrapped against long titles ("Memo hit rate"). It is now a
 * quiet ⋯ menu button (still a real, labelled button: the table stays one
 * Tab + Enter away) plus the `T` key anywhere inside the card, which is the
 * `chart.table` command in routes/verse/shell/command-catalog.ts. The key is
 * matched here directly rather than through the catalog so this shared kit
 * (also used by the legacy console) never imports a route module; the chart
 * tests assert the two stay the same key.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreGlyph } from './ChartParts.js';
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

/** The key that flips a focused chart card between plot and table (catalog `chart.table`). */
export const CHART_TABLE_KEY = 't';

export interface ChartFrameProps {
  title: string;
  description?: string;
  caveat?: string;
  status?: ChartStatus;
  /** Start on the table (e.g. a screen-reader-first surface, or a matrix at 375 px). */
  defaultView?: ChartView;
  /** Hide the view menu (only for a chart that already IS its numbers). */
  hideToggle?: boolean;
  /** Extra header controls (a facet picker), rendered before the ⋯ menu. */
  actions?: ReactNode;
  /** The plot. */
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

/** True when a key press is typing into a field — never steal it for the T shortcut. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

const VIEW_ITEMS: ReadonlyArray<{ view: ChartView; label: string; hint: string | null }> = [
  { view: 'chart', label: 'Show as chart', hint: null },
  { view: 'table', label: 'Show as table', hint: 'T' },
];

/**
 * The ⋯ menu: a menu button (WAI-ARIA menu-button pattern) with two
 * menuitemradio entries. Arrow keys move, Enter / Space pick, Escape and Tab
 * close; focus returns to the button on every close so the keyboard user is
 * never dropped at the top of the document.
 */
function ViewMenu({ title, view, onPick }: { title: string; view: ChartView; onPick: (view: ChartView) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[active]?.focus();
  }, [open, active]);

  function openAt(index: number): void {
    setActive(index);
    setOpen(true);
  }

  function onButtonKey(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(e.key === 'ArrowUp' ? VIEW_ITEMS.length - 1 : 0);
    }
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % VIEW_ITEMS.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + VIEW_ITEMS.length) % VIEW_ITEMS.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(VIEW_ITEMS.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  }

  return (
    <span className={styles.menuWrap}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.more}
        aria-label={`${title}: view options`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="View options (T toggles the table)"
        onClick={() => (open ? close(false) : openAt(Math.max(0, VIEW_ITEMS.findIndex((i) => i.view === view))))}
        onKeyDown={onButtonKey}
      >
        <MoreGlyph />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label={`${title} view`} className={styles.menu} onKeyDown={onMenuKey}>
          {VIEW_ITEMS.map((item, i) => (
            <button
              key={item.view}
              type="button"
              role="menuitemradio"
              aria-checked={view === item.view}
              tabIndex={i === active ? 0 : -1}
              className={styles.menuItem}
              onClick={() => {
                onPick(item.view);
                close(true);
              }}
            >
              <span className={styles.check} aria-hidden="true">{view === item.view ? '✓' : ''}</span>
              <span>{item.label}</span>
              {item.hint ? <kbd className={styles.hint}>{item.hint}</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

export function ChartFrame({
  title,
  description,
  caveat,
  status = { kind: 'ready' },
  defaultView = 'chart',
  hideToggle = false,
  actions,
  children,
  table,
  footer,
}: ChartFrameProps) {
  const [view, setView] = useState<ChartView>(defaultView);
  const titleId = useId();
  const ready = status.kind === 'ready';
  const canToggle = ready && !hideToggle;

  function onKeyDown(e: KeyboardEvent<HTMLElement>): void {
    if (!canToggle || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== CHART_TABLE_KEY || isEditableTarget(e.target)) return;
    e.preventDefault();
    setView((v) => (v === 'chart' ? 'table' : 'chart'));
  }

  return (
    <figure className={styles.frame} aria-labelledby={titleId} data-chart-card="" data-view={view} onKeyDown={onKeyDown}>
      <figcaption className={styles.header}>
        <span className={styles.heading}>
          <span id={titleId} className={styles.title}>{title}</span>
          {description ? <span className={styles.description}>{description}</span> : null}
        </span>
        {actions || canToggle ? (
          <span className={styles.actions}>
            {actions}
            {canToggle ? <ViewMenu title={title} view={view} onPick={setView} /> : null}
          </span>
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
