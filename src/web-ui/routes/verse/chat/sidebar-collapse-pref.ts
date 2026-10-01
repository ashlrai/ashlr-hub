/** Per-device display choices only: never chat selection, drafts or server state. */
import { useSyncExternalStore } from 'react';

export const SIDEBAR_COLLAPSE_KEY = 'ashlr.verse.sidebar-collapse.v1';
export const SAVED_PROJECTS_GROUP = 'saved-projects';
const STORAGE_BYTES = 64 * 1024;
let current: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function validKey(key: unknown): key is string {
  return typeof key === 'string' && (key === SAVED_PROJECTS_GROUP || key.startsWith('project:'));
}

export function getSidebarCollapse(): ReadonlySet<string> {
  if (current !== null) return current;
  current = new Set();
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (raw && raw.length <= STORAGE_BYTES && new TextEncoder().encode(raw).length <= STORAGE_BYTES) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(validKey)) current = new Set(parsed);
    }
  } catch { /* Blocked or malformed storage leaves groups open. */ }
  return current;
}

export function setSidebarGroupCollapsed(key: string, collapsed: boolean): void {
  if (!validKey(key) || getSidebarCollapse().has(key) === collapsed) return;
  const next = new Set(getSidebarCollapse());
  if (collapsed) next.add(key);
  else next.delete(key);
  current = next;
  try {
    const raw = JSON.stringify([...next]);
    // A storage byte bound, not a project count limit. Oversized choices still
    // hold for this page; do not leave an older persisted choice behind.
    if (new TextEncoder().encode(raw).length <= STORAGE_BYTES) localStorage.setItem(SIDEBAR_COLLAPSE_KEY, raw);
    else localStorage.removeItem(SIDEBAR_COLLAPSE_KEY);
  } catch { /* The choice still holds for this page. */ }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetSidebarCollapse(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

export function useSidebarCollapse(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSidebarCollapse, getSidebarCollapse);
}
