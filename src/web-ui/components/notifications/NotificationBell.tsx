/**
 * components/notifications/NotificationBell.tsx — the persistent, global
 * entry point into the attention queue (mounted in Topbar so it's reachable
 * from every view, not just one page — "interject at any moment" per the
 * build brief). Purely presentational + store-toggling; the actual engine
 * runs inside <NotificationCenter/> regardless of open state.
 */
import { useEffect, useRef, useState } from 'react';
import { useNotifications } from './useNotifications.js';
import { togglePanel } from './notification-store.js';
import styles from './NotificationBell.module.css';

export function NotificationBell() {
  const { items } = useNotifications();
  const urgent = items.filter((n) => n.severity === 'critical' || n.severity === 'high').length;
  const total = items.length;

  // The badge count updates live in the background (the engine runs
  // regardless of panel-open state) but the badge itself is aria-hidden and
  // the button's accessible name only reflects the *current* count, not the
  // fact that it changed — a screen-reader user had no way to learn a new
  // urgent item arrived without re-focusing the bell. This announces the
  // delta, once, only on an increase (never on read/mute-driven decreases,
  // which aren't "you should look now" events).
  const prevUrgentRef = useRef(urgent);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (urgent > prevUrgentRef.current) {
      const delta = urgent - prevUrgentRef.current;
      setAnnouncement(`${delta} new urgent notification${delta === 1 ? '' : 's'}, ${urgent} urgent total.`);
    }
    prevUrgentRef.current = urgent;
  }, [urgent]);

  return (
    <>
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
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>
    </>
  );
}
