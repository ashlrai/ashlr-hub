/**
 * routes/verse/mobile/connectivity.ts — "can this phone reach the Mac right
 * now?", from signals the app already has.
 *
 *   offline      the phone itself has no network (navigator.onLine false)
 *   unreachable  the phone is online but the Mac did not answer the last
 *                activity poll (asleep, off the relay, tunnel down). The last
 *                good data stays on screen, dated — never replaced by zeros
 *   live         the last poll answered
 *   connecting   nothing has answered yet
 *
 * The shell's one activity loop (shell/useActivity.ts, 5 s visible / 30 s
 * hidden) is the heartbeat, so this costs no request of its own. Whether the
 * page itself loads offline is the service worker's job (public/verse-m/sw.js).
 */
import { useSyncExternalStore } from 'react';
import type { ActivityState } from '../shell/useActivity.js';

export type Reachability = 'live' | 'connecting' | 'offline' | 'unreachable';

export function reachabilityOf(online: boolean, activity: Pick<ActivityState, 'status' | 'data' | 'error'>): Reachability {
  if (!online) return 'offline';
  switch (activity.status) {
    case 'ready':
      return 'live';
    case 'stale':
      return 'unreachable';
    // A 404 (route not in this build) is 'unavailable' with no error: the Mac
    // answered. With an error and no data, it never answered.
    case 'unavailable':
      return activity.error ? 'unreachable' : 'live';
    default:
      return 'connecting';
  }
}

/** "Updated 2 min ago" — for the banner under a stale screen. */
export function sinceText(updatedAt: number | null, now: number = Date.now()): string {
  if (updatedAt === null) return 'No update yet';
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 45) return 'Updated just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `Updated ${h} h ago` : `Updated ${Math.round(h / 24)} d ago`;
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

function readOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, readOnline, () => true);
}
