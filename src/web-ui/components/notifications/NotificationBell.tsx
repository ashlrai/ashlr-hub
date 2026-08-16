/**
 * components/notifications/NotificationBell.tsx — the persistent, global
 * entry point into the attention queue (mounted in Topbar so it's reachable
 * from every view, not just one page — "interject at any moment" per the
 * build brief). Purely presentational + store-toggling; the actual engine
 * runs inside <NotificationCenter/> regardless of open state.
 */
import { useNotifications } from './useNotifications.js';
import { togglePanel } from './notification-store.js';
import styles from './NotificationBell.module.css';

export function NotificationBell() {
  const { items } = useNotifications();
  const urgent = items.filter((n) => n.severity === 'critical' || n.severity === 'high').length;
  const total = items.length;

  return (
    <button
      type="button"
      className={styles.bell}
      onClick={togglePanel}
      aria-haspopup="dialog"
      aria-label={total === 0 ? 'Notifications, none open' : `Notifications, ${total} open, ${urgent} urgent`}
    >
      <span aria-hidden="true">🔔</span>
      {total > 0 ? (
        <span className={`${styles.badge} ${urgent > 0 ? styles.badgeUrgent : ''}`} aria-hidden="true">
          {total > 99 ? '99+' : total}
        </span>
      ) : null}
    </button>
  );
}
