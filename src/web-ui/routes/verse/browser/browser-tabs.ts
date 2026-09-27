/**
 * routes/verse/browser/browser-tabs.ts — the Browser pane's tab model. Pure
 * (a reducer plus its storage codec), so the panel stays a view.
 *
 * A tab is a page address plus a history of the addresses opened IN THIS
 * PANE. In the desktop app the native webview keeps its own real history
 * (back/forward go to it, and its `nav` events update `url`); in the iframe
 * fallback a cross-origin frame's history is unreadable, so back/forward
 * walk this list instead — the same compromise as the Preview pane.
 *
 * Tab ids are `t<n>`: they name native windows (`browser-<id>`), whose label
 * rule is `^[a-z0-9]{1,16}$`.
 */

export const MAX_BROWSER_TABS = 8;
const MAX_HISTORY = 50;

export interface BrowserTab {
  id: string;
  /** null = the launcher (dev servers to open). */
  url: string | null;
  title: string | null;
  loading: boolean;
  history: string[];
  index: number;
  /** Bumped by Reload in the iframe fallback (a new frame element). */
  reloadKey: number;
}

export interface BrowserTabsState {
  tabs: BrowserTab[];
  activeId: string;
  nextId: number;
}

export type BrowserTabsAction =
  | { type: 'new-tab'; url?: string | null }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  /** The operator (or an agent) opened `url` in tab `id`. */
  | { type: 'navigate'; id: string; url: string }
  /** The native webview reports where it actually is (redirects, in-page links). */
  | { type: 'native-nav'; id: string; url: string; loading: boolean }
  | { type: 'title'; id: string; title: string }
  | { type: 'step'; id: string; delta: -1 | 1 }
  | { type: 'reload'; id: string }
  | { type: 'loaded'; id: string };

function blankTab(id: string, url: string | null = null): BrowserTab {
  return { id, url, title: null, loading: url !== null, history: url ? [url] : [], index: url ? 0 : -1, reloadKey: 0 };
}

export function initialTabsState(): BrowserTabsState {
  return { tabs: [blankTab('t1')], activeId: 't1', nextId: 2 };
}

function mapTab(state: BrowserTabsState, id: string, fn: (tab: BrowserTab) => BrowserTab): BrowserTabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const next = fn(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

function pushHistory(tab: BrowserTab, url: string): BrowserTab {
  const kept = tab.history.slice(0, tab.index + 1);
  const history = [...kept, url].slice(-MAX_HISTORY);
  return { ...tab, url, loading: true, history, index: history.length - 1, title: tab.url === url ? tab.title : null };
}

export function browserTabsReducer(state: BrowserTabsState, action: BrowserTabsAction): BrowserTabsState {
  switch (action.type) {
    case 'new-tab': {
      if (state.tabs.length >= MAX_BROWSER_TABS) return state;
      const id = `t${state.nextId}`;
      return { tabs: [...state.tabs, blankTab(id, action.url ?? null)], activeId: id, nextId: state.nextId + 1 };
    }
    case 'close': {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (tabs.length === 0) {
        const id = `t${state.nextId}`;
        return { tabs: [blankTab(id)], activeId: id, nextId: state.nextId + 1 };
      }
      const activeId = state.activeId === action.id ? tabs[Math.min(index, tabs.length - 1)]!.id : state.activeId;
      return { ...state, tabs, activeId };
    }
    case 'activate':
      return state.tabs.some((t) => t.id === action.id) && state.activeId !== action.id ? { ...state, activeId: action.id } : state;
    case 'navigate':
      return mapTab(state, action.id, (tab) => pushHistory(tab, action.url));
    case 'native-nav':
      return mapTab(state, action.id, (tab) => {
        if (tab.url === action.url) return tab.loading === action.loading ? tab : { ...tab, loading: action.loading };
        // A redirect or an in-page link: record it where the operator is.
        const moved = pushHistory(tab, action.url);
        return { ...moved, loading: action.loading };
      });
    case 'title':
      return mapTab(state, action.id, (tab) => (tab.title === action.title ? tab : { ...tab, title: action.title }));
    case 'step':
      return mapTab(state, action.id, (tab) => {
        const index = tab.index + action.delta;
        if (index < 0 || index >= tab.history.length) return tab;
        return { ...tab, index, url: tab.history[index]!, loading: true, title: null };
      });
    case 'reload':
      return mapTab(state, action.id, (tab) => (tab.url ? { ...tab, loading: true, reloadKey: tab.reloadKey + 1 } : tab));
    case 'loaded':
      return mapTab(state, action.id, (tab) => (tab.loading ? { ...tab, loading: false } : tab));
    default:
      return state;
  }
}

export function activeTab(state: BrowserTabsState): BrowserTab {
  return state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]!;
}

// ---------------------------------------------------------------------------
// Storage (per viewer, per browser profile — a convenience, never required)
// ---------------------------------------------------------------------------

export const BROWSER_TABS_STORAGE_KEY = 'ashlr.verse.browser.v1';

export function serializeTabs(state: BrowserTabsState): string {
  return JSON.stringify({ tabs: state.tabs.map((t) => ({ id: t.id, url: t.url })), activeId: state.activeId });
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Restore saved tabs; anything malformed falls back to one empty tab. */
export function restoreTabs(raw: string | null): BrowserTabsState {
  if (!raw) return initialTabsState();
  try {
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(parsed.tabs)) return initialTabsState();
    const tabs: BrowserTab[] = [];
    let max = 0;
    for (const row of parsed.tabs.slice(0, MAX_BROWSER_TABS)) {
      if (typeof row !== 'object' || row === null) continue;
      const { id, url } = row as { id?: unknown; url?: unknown };
      if (typeof id !== 'string' || !/^t\d{1,6}$/.test(id) || tabs.some((t) => t.id === id)) continue;
      tabs.push({ ...blankTab(id, isHttpUrl(url) ? url : null), loading: false });
      max = Math.max(max, Number(id.slice(1)));
    }
    if (tabs.length === 0) return initialTabsState();
    const activeId = typeof parsed.activeId === 'string' && tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : tabs[0]!.id;
    return { tabs, activeId, nextId: max + 1 };
  } catch {
    return initialTabsState();
  }
}
