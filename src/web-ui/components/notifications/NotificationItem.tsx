/**
 * components/notifications/NotificationItem.tsx — one row in the attention
 * queue: severity, what it's about, why, and a direct action — plus a
 * mute-this-category control so an operator drowning in one noisy category
 * can quiet it without losing the rest (non-negotiable: never nag).
 */
import { Epistemic } from '../primitives/Epistemic.js';
import { StatusBadge } from '../primitives/StatusBadge.js';
import { severityToTone, NOTIFICATION_CATEGORY_LABEL, type AppNotification } from './types.js';
import { isMuted, setMuted } from './notification-store.js';
import styles from './NotificationItem.module.css';

function formatRelative(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationItem({ item }: { item: AppNotification }) {
  const muted = isMuted(item.category);
  return (
    <article className={styles.item} data-focus-key={`notification-${item.id}`}>
      <div className={styles.top}>
        <StatusBadge status={item.severity} tone={severityToTone(item.severity)}>
          {item.severity.toUpperCase()}
        </StatusBadge>
        <span className={styles.category}>{NOTIFICATION_CATEGORY_LABEL[item.category]}</span>
        <span className={styles.time} title={new Date(item.ts).toLocaleString()}>
          {formatRelative(item.ts)}
        </span>
      </div>
      <h3 className={styles.title}>{item.title}</h3>
      <p className={styles.detail}>
        {item.sourceQuality ? (
          <Epistemic quality={item.sourceQuality} label={item.title}>
            {item.detail}
          </Epistemic>
        ) : (
          item.detail
        )}
      </p>
      <div className={styles.actions}>
        {item.actionHref ? (
          <a className={styles.actionLink} href={`#${item.actionHref}`} data-focus-key={`notification-${item.id}-action`}>
            {item.actionLabel ?? 'Open'}
          </a>
        ) : null}
        <button
          type="button"
          className={styles.muteBtn}
          onClick={() => setMuted(item.category, !muted)}
          aria-pressed={muted}
        >
          {muted ? `Unmute ${NOTIFICATION_CATEGORY_LABEL[item.category]}` : `Mute ${NOTIFICATION_CATEGORY_LABEL[item.category]}`}
        </button>
      </div>
    </article>
  );
}
