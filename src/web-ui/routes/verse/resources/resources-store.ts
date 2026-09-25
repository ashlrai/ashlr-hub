/**
 * routes/verse/resources/resources-store.ts — is the Resources drawer open,
 * and is it pinned (unit 3.11 C6).
 *
 *   overlay  ~360px over the surface; Esc, an outside click or ⌘. closes it,
 *            focus is trapped inside and returned on close;
 *   pinned   a docked right column that shrinks the surface beside it.
 *
 * PERSISTED under its own key, one writer (this module), every access in a
 * try/catch: a private window without storage still runs the drawer. The
 * shell's `ashlr.verse.ui.v3` blob is not touched — its `resourcesOpen`
 * field belongs to an older panel and has one writer already.
 *
 * On load the drawer comes back open only when it was PINNED open: a docked
 * column is a layout preference, whereas an overlay restored on reload would
 * steal focus from whatever the operator came back to do.
 *
 * Kept tiny and framework-free apart from one hook: this file is imported by
 * the shell, so it is on the chat first-paint path.
 */
import { useSyncExternalStore } from 'react';
import type { ResourcesSummary } from './resources-model.js';

export const RESOURCES_STORAGE_KEY = 'ashlr.verse.resources.v1';

export interface ResourcesUiState {
  open: boolean;
  pinned: boolean;
  /**
   * The handle's dot, written by the lazily loaded summary probe
   * (resources-summary.tsx). NOT persisted; null until the probe has read.
   */
  summary: ResourcesSummary | null;
}

function load(): ResourcesUiState {
  try {
    const raw = JSON.parse(localStorage.getItem(RESOURCES_STORAGE_KEY) ?? 'null') as Partial<ResourcesUiState> | null;
    const pinned = raw?.pinned === true;
    return { pinned, open: pinned && raw?.open === true, summary: null };
  } catch {
    return { open: false, pinned: false, summary: null };
  }
}

let state: ResourcesUiState = load();
const listeners = new Set<() => void>();

function patch(delta: Partial<ResourcesUiState>): void {
  const next = { ...state, ...delta };
  if (next.open === state.open && next.pinned === state.pinned && next.summary === state.summary) return;
  const persist = next.open !== state.open || next.pinned !== state.pinned;
  state = next;
  if (persist) {
    try {
      localStorage.setItem(RESOURCES_STORAGE_KEY, JSON.stringify({ open: next.open, pinned: next.pinned }));
    } catch {
      /* best-effort */
    }
  }
  for (const l of [...listeners]) l();
}

export function getResourcesUi(): ResourcesUiState {
  return state;
}

export function openResources(): void {
  patch({ open: true });
}

export function closeResources(): void {
  patch({ open: false });
}

export function toggleResources(): void {
  patch({ open: !state.open });
}

export function setResourcesPinned(pinned: boolean): void {
  patch({ pinned });
}

export function setResourcesSummary(summary: ResourcesSummary | null): void {
  const same = summary !== null && state.summary !== null && summary.tone === state.summary.tone && summary.spoken === state.summary.spoken;
  if (!same) patch({ summary });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useResourcesUi(): ResourcesUiState {
  return useSyncExternalStore(subscribe, getResourcesUi, getResourcesUi);
}

/** Test hygiene: re-read storage as a fresh page load would. */
export function reloadResourcesUiForTest(): void {
  state = load();
  for (const l of [...listeners]) l();
}
