/**
 * components/primitives/RefreshIndicator.tsx — the "stale data, quietly
 * refreshing" signal (foundation brief item 4: never blank the screen on
 * refresh). Pair with a QueryEntry's `status`:
 *
 *   loading    -> render a Skeleton instead of the view
 *   refreshing -> render the view with data, plus <RefreshIndicator />
 *   success    -> render the view with data, no indicator
 *   error      -> render the view's error state
 */
import styles from './RefreshIndicator.module.css';

export function RefreshIndicator({ label = 'Refreshing' }: { label?: string }) {
  return (
    <span className={styles.root} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
