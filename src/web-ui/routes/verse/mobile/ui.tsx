/**
 * routes/verse/mobile/ui.tsx — the phone app's first-paint building blocks:
 * a screen (top bar, large title, pull-to-refresh), buttons and loading
 * skeletons. Lists, badges, meters, banners and empty / error states are in
 * ui-parts.tsx, the bottom sheet in sheet.tsx — both off the first paint.
 *
 * Every screen composes these, so a state reads the same everywhere:
 * loading is a skeleton in the shape of what is coming, an empty list says
 * what would appear there, and an error says why in the server's own words
 * with a way to retry. Styling is ui.module.css.
 */
import {
  useCallback,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { BackGlyph } from './mobile-icons.js';
import styles from './ui.module.css';

export { styles as ui };

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** How far a pull must travel before letting go refreshes. */
export const PULL_THRESHOLD_PX = 64;
const PULL_MAX_PX = 96;

export interface ScreenProps {
  /** Shown in the top bar (and as the large title on a tab's root screen). */
  title: string;
  /** Tab root: a large title in the content. Nested screens show only the bar. */
  large?: boolean;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  trailing?: ReactNode;
  /** Pull-to-refresh. Resolve when the data is back; the spinner stays until then. */
  onRefresh?: () => Promise<unknown> | void;
  /** Rendered under the top bar, above the scroller (a banner, a segmented control). */
  header?: ReactNode;
  /** Rendered under the scroller (a composer). */
  footer?: ReactNode;
  children: ReactNode;
  /** Test/landmark label for the scroll region. */
  label?: string;
}

export function Screen({ title, large = false, subtitle, onBack, backLabel = 'Back', trailing, onRefresh, header, footer, children, label }: ScreenProps) {
  const headingId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = useCallback((e: ReactTouchEvent) => {
    if (!onRefresh || refreshing) return;
    start.current = (scroller.current?.scrollTop ?? 0) <= 0 ? e.touches[0]?.clientY ?? null : null;
  }, [onRefresh, refreshing]);

  const onTouchMove = useCallback((e: ReactTouchEvent) => {
    if (start.current === null) return;
    const dy = (e.touches[0]?.clientY ?? start.current) - start.current;
    // Resistance: the indicator moves at half the finger's speed, capped.
    setPull(dy > 0 ? Math.min(PULL_MAX_PX, dy / 2) : 0);
  }, []);

  const finish = useCallback(() => {
    const armed = pull >= PULL_THRESHOLD_PX / 2 + 8;
    start.current = null;
    setPull(0);
    if (!armed || !onRefresh) return;
    setRefreshing(true);
    void Promise.resolve()
      .then(() => onRefresh())
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [pull, onRefresh]);

  const armed = pull >= PULL_THRESHOLD_PX / 2 + 8;
  return (
    <section className={cx(styles.screen, styles.enter)} aria-labelledby={headingId}>
      <header className={styles.topbar}>
        <div className={styles.topbarLead}>
          {onBack ? (
            <button type="button" className={cx(styles.btn, styles.plain)} onClick={onBack}>
              <BackGlyph size={18} />
              <span>{backLabel}</span>
            </button>
          ) : null}
        </div>
        {large ? <span className={styles.topbarTitle} aria-hidden="true">{title}</span> : <h1 id={headingId} className={styles.topbarTitle}>{title}</h1>}
        <div className={styles.topbarTrail}>{trailing}</div>
      </header>
      {header}
      <div
        ref={scroller}
        className={styles.scroller}
        aria-label={label}
        onTouchStart={onRefresh ? onTouchStart : undefined}
        onTouchMove={onRefresh ? onTouchMove : undefined}
        onTouchEnd={onRefresh ? finish : undefined}
        onTouchCancel={onRefresh ? finish : undefined}
      >
        {onRefresh ? (
          <div className={cx(styles.pull, armed && styles.pullArmed)} style={{ height: refreshing ? '2.5rem' : `${pull}px` }} aria-hidden={!refreshing}>
            {refreshing ? <span className={styles.spinner} role="progressbar" aria-label="Refreshing" /> : pull > 8 ? (armed ? 'Release to refresh' : 'Pull to refresh') : null}
          </div>
        ) : null}
        {large ? <h1 id={headingId} className={styles.largeTitle}>{title}</h1> : null}
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        {children}
      </div>
      {footer}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'destructive' | 'destructiveTinted' | 'plain';

export interface MobileButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  icon?: boolean;
}

export function Button({ variant = 'secondary', block = false, icon = false, className, type = 'button', ...rest }: MobileButtonProps) {
  return <button type={type} className={cx(styles.btn, styles[variant], block && styles.block, icon && styles.iconBtn, className)} {...rest} />;
}

/** A loading list in the shape of the rows that will replace it. */
export function SkeletonList({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className={styles.group} role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <span className={cx('skeleton', styles.skeletonLine)} style={{ width: `${70 - i * 12}%` }} />
          <span className={cx('skeleton', styles.skeletonLine)} style={{ width: `${45 - i * 6}%` }} />
        </div>
      ))}
    </div>
  );
}
