/**
 * components/notifications/notification-store.ts — the framework-free store
 * behind the notification centre, following the same
 * plain-module-plus-useSyncExternalStore split as data/cache.ts and
 * data/auth-store.ts (no React import here; only the hook file bridges it).
 *
 * Responsibilities beyond just holding a list:
 *   - Dedupe: `reconcile()` is keyed by `AppNotification.id`. Re-deriving
 *     the same active issue updates it in place; an id that stops appearing
 *     means the underlying issue resolved, and it's dropped silently — no
 *     "resolved!" spam.
 *   - Mute: per-category, persisted to localStorage (a UI preference, not a
 *     secret — same class of persistence as the theme toggle).
 *   - Throttle for the OS Notification API: a real desktop notification only
 *     fires for an id the store has never seen before, at critical/high
 *     severity, in an unmuted category, while permission is granted — never
 *     once per poll for a still-active issue.
 */
import type { AppNotification, NotificationCategory } from './types.js';
import { sortNotifications } from './deriveNotifications.js';

const MUTE_STORAGE_KEY = 'ashlr.notifications.mutedCategories.v1';
const DESKTOP_PREF_STORAGE_KEY = 'ashlr.notifications.desktopEnabled.v1';

export type DesktopPermission = 'unsupported' | 'default' | 'granted' | 'denied';

interface NotificationStoreState {
  items: AppNotification[];
  panelOpen: boolean;
  mutedCategories: NotificationCategory[];
  desktopEnabled: boolean;
  desktopPermission: DesktopPermission;
}

function loadMuted(): Set<NotificationCategory> {
  try {
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed as NotificationCategory[]);
  } catch {
    /* best-effort */
  }
  return new Set();
}

function saveMuted(muted: Set<NotificationCategory>): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify([...muted]));
  } catch {
    /* best-effort */
  }
}

function loadDesktopPref(): boolean {
  try {
    return localStorage.getItem(DESKTOP_PREF_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function currentDesktopPermission(): DesktopPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as DesktopPermission;
}

const mutedCategories = loadMuted();
let allItems: AppNotification[] = [];
let panelOpen = false;
let desktopEnabled = loadDesktopPref();
const everSeenIds = new Set<string>();

let state: NotificationStoreState = {
  items: [],
  panelOpen: false,
  mutedCategories: [...mutedCategories],
  desktopEnabled,
  desktopPermission: currentDesktopPermission(),
};

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function recompute(): void {
  const visible = sortNotifications(allItems.filter((n) => !mutedCategories.has(n.category)));
  state = {
    items: visible,
    panelOpen,
    mutedCategories: [...mutedCategories],
    desktopEnabled,
    desktopPermission: currentDesktopPermission(),
  };
  emit();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationSnapshot(): NotificationStoreState {
  return state;
}

/**
 * Replace the full derived set for this poll cycle. Fires a throttled
 * desktop notification for any id that is BOTH new (never seen before in
 * this tab) and unmuted critical/high — never for an id already active.
 */
export function reconcileNotifications(derived: AppNotification[]): void {
  const previousIds = new Set(allItems.map((n) => n.id));
  allItems = derived;

  if (desktopEnabled && currentDesktopPermission() === 'granted') {
    for (const n of derived) {
      if (mutedCategories.has(n.category)) continue;
      if (n.severity !== 'critical' && n.severity !== 'high') continue;
      if (previousIds.has(n.id) || everSeenIds.has(n.id)) continue;
      everSeenIds.add(n.id);
      try {
        void new Notification(n.title, { body: n.detail, tag: n.id });
      } catch {
        /* best-effort — some browsers throw outside a user gesture context */
      }
    }
  }
  for (const n of derived) everSeenIds.add(n.id);

  recompute();
}

export function openPanel(): void {
  panelOpen = true;
  recompute();
}

export function closePanel(): void {
  panelOpen = false;
  recompute();
}

export function togglePanel(): void {
  panelOpen = !panelOpen;
  recompute();
}

export function isMuted(category: NotificationCategory): boolean {
  return mutedCategories.has(category);
}

export function setMuted(category: NotificationCategory, muted: boolean): void {
  if (muted) mutedCategories.add(category);
  else mutedCategories.delete(category);
  saveMuted(mutedCategories);
  recompute();
}

export async function enableDesktopNotifications(): Promise<DesktopPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  let permission = Notification.permission as DesktopPermission;
  if (permission === 'default') {
    permission = (await Notification.requestPermission()) as DesktopPermission;
  }
  desktopEnabled = permission === 'granted';
  try {
    localStorage.setItem(DESKTOP_PREF_STORAGE_KEY, desktopEnabled ? '1' : '0');
  } catch {
    /* best-effort */
  }
  recompute();
  return permission;
}

export function disableDesktopNotifications(): void {
  desktopEnabled = false;
  try {
    localStorage.setItem(DESKTOP_PREF_STORAGE_KEY, '0');
  } catch {
    /* best-effort */
  }
  recompute();
}

/** Test-only: reset all module-level state between test files. */
export function __resetNotificationStoreForTests(): void {
  allItems = [];
  panelOpen = false;
  desktopEnabled = false;
  mutedCategories.clear();
  everSeenIds.clear();
  recompute();
}
