/**
 * components/notifications/useNotifications.ts — the only file in this
 * subtree that imports React, bridging notification-store.ts's plain
 * external store the same way data/hooks.ts bridges cache.ts/auth-store.ts.
 */
import { useSyncExternalStore } from 'react';
import { getNotificationSnapshot, subscribeNotifications } from './notification-store.js';

export function useNotifications() {
  return useSyncExternalStore(subscribeNotifications, getNotificationSnapshot, getNotificationSnapshot);
}
