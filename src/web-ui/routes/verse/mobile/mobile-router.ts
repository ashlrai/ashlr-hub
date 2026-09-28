/**
 * routes/verse/mobile/mobile-router.ts — where the phone app is, as a hash.
 *
 * The path is fixed (`/verse/m/`, the service worker's scope), so every screen
 * lives in the hash: `#/agents/<id>/changes`. A hash change is a history
 * entry, which is what makes the iOS edge-swipe and Android's back button go
 * back a screen instead of leaving the app. Nothing secret ever goes in it —
 * only screen names and chat ids the read session can list anyway.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type MobileTab = 'home' | 'agents' | 'needs' | 'leader' | 'more';

export type AgentPane = 'transcript' | 'changes';

export type MobileRoute =
  | { screen: 'home' }
  | { screen: 'agents' }
  | { screen: 'agent'; id: string; pane: AgentPane }
  | { screen: 'new' }
  | { screen: 'needs' }
  | { screen: 'leader' }
  | { screen: 'more' }
  | { screen: 'fleet' };

const SIMPLE = new Set(['agents', 'new', 'needs', 'leader', 'more', 'fleet']);

/** `#/agents/abc/changes` → the route. Anything unrecognised is Home, never an error. */
export function parseMobileHash(hash: string): MobileRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [head, id, pane] = parts;
  if (!head) return { screen: 'home' };
  if (head === 'agents' && id) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      return { screen: 'agents' };
    }
    return { screen: 'agent', id: decoded, pane: pane === 'changes' ? 'changes' : 'transcript' };
  }
  if (SIMPLE.has(head)) return { screen: head as Exclude<MobileRoute['screen'], 'home' | 'agent'> } as MobileRoute;
  return { screen: 'home' };
}

export function formatMobileHash(route: MobileRoute): string {
  switch (route.screen) {
    case 'home':
      return '#/';
    case 'agent':
      return `#/agents/${encodeURIComponent(route.id)}${route.pane === 'changes' ? '/changes' : ''}`;
    default:
      return `#/${route.screen}`;
  }
}

/** Which bottom tab a screen belongs to. */
export function tabOf(route: MobileRoute): MobileTab {
  switch (route.screen) {
    case 'home':
      return 'home';
    case 'agents':
    case 'agent':
    case 'new':
      return 'agents';
    case 'needs':
      return 'needs';
    case 'leader':
      return 'leader';
    case 'more':
    case 'fleet':
      return 'more';
  }
}

/** The tab's root screen (tapping the active tab again pops back to it). */
export function tabRoot(tab: MobileTab): MobileRoute {
  return { screen: tab } as MobileRoute;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function currentHash(): string {
  return window.location.hash;
}

export interface NavigateOptions {
  /** Replace the current entry (a redirect, a tab re-tap) instead of pushing one. */
  replace?: boolean;
}

export function navigateMobile(route: MobileRoute, options: NavigateOptions = {}): void {
  const hash = formatMobileHash(route);
  if (hash === window.location.hash || (hash === '#/' && window.location.hash === '')) return;
  if (options.replace) window.location.replace(hash);
  else window.location.hash = hash;
}

/** The current route; re-renders on every hash change. */
export function useMobileRoute(): [MobileRoute, (route: MobileRoute, options?: NavigateOptions) => void] {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  const navigate = useCallback((route: MobileRoute, options?: NavigateOptions) => navigateMobile(route, options), []);
  return [parseMobileHash(hash), navigate];
}
