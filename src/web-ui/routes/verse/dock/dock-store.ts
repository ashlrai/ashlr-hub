/**
 * routes/verse/dock/dock-store.ts — the chat dock's state and the one-shot
 * requests aimed at its panes (unit C2; contract: shell/dock-catalog.ts).
 *
 * PERSISTENCE. The dock's state belongs in `ashlr.verse.ui.v3`'s `dock`
 * field, and that blob has ONE writer — C1's verse-ui-store — so two stores
 * never race for the key (dock-catalog.ts). This store therefore never
 * writes the key. It:
 *   - hydrates itself, read-only, from the v3 blob's `dock` field on first
 *     read (through sanitizeDockState — a hand-edited blob cannot break the
 *     chat);
 *   - exposes getDockState / subscribeDockState, which C1's store folds into
 *     the blob it writes (`dock: getDockState()`, re-written on change);
 *   - accepts hydrateDockState(raw) when C1 prefers to push the field in.
 *
 * REQUESTS. "Run in terminal", a ± count opening the branch diff, Preview's
 * dev-server Start: each is a one-shot request with a nonce (slots.tsx
 * contracts) — the same request twice is two opens. They live here, not in
 * React state, because they are raised from deep inside the transcript
 * (CommandOutput) and consumed by a pane in another subtree.
 *
 * Framework-free; the React glue is useDock() at the bottom.
 */
import { useSyncExternalStore } from 'react';
import {
  DOCK_LAYOUT,
  VERSE_UI_STORAGE_KEY,
  sanitizeDockState,
  type DockPaneId,
  type DockState,
} from '../shell/dock-catalog.js';
import type { VerseTerminalLaunchVia } from '../../../../core/verse/workbench-types.js';
import type { DiffPaneRequest, PreviewOpenRequest, TerminalOpenRequest } from '../shell/slots.js';

/**
 * A terminal request as the dock carries it: C0's TerminalOpenRequest plus
 * HOW an Apps [Launch ▸] runs its app (`via`, `model` — the contract fields
 * on VerseTerminalCreateRequest). The slot's prop type does not name them
 * yet, so they ride as a subtype and TerminalPane reads them through this
 * type; the server resolves the actual command either way, never the page.
 */
export type TerminalRequest = TerminalOpenRequest & { via?: VerseTerminalLaunchVia; model?: string };

export interface DockRequests {
  terminal: TerminalRequest | null;
  preview: PreviewOpenRequest | null;
  diff: (DiffPaneRequest & { nonce: number }) | null;
}

export interface DockSnapshot {
  state: DockState;
  requests: DockRequests;
}

const NO_REQUESTS: DockRequests = { terminal: null, preview: null, diff: null };

let snapshot: DockSnapshot | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function readPersisted(): DockState {
  try {
    const raw = localStorage.getItem(VERSE_UI_STORAGE_KEY);
    if (!raw) return sanitizeDockState(null);
    const parsed = JSON.parse(raw) as { dock?: unknown } | null;
    return sanitizeDockState(parsed && typeof parsed === 'object' ? parsed.dock : null);
  } catch {
    return sanitizeDockState(null);
  }
}

function current(): DockSnapshot {
  if (snapshot === null) snapshot = { state: readPersisted(), requests: NO_REQUESTS };
  return snapshot;
}

function emit(next: DockSnapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function setState(next: DockState): void {
  emit({ ...current(), state: next });
}

export function subscribeDockState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDockSnapshot(): DockSnapshot {
  return current();
}

/** The persistable part — what C1's store writes as the v3 blob's `dock` field. */
export function getDockState(): DockState {
  return current().state;
}

/** C1 may push the persisted field in (on load, or when another tab wrote it). */
export function hydrateDockState(raw: unknown): void {
  setState(sanitizeDockState(raw));
}

/** Test seam: back to defaults with no requests; next read re-hydrates from storage. */
export function resetDockStore(): void {
  snapshot = null;
  nonce = 0;
  for (const listener of [...listeners]) listener();
}

// ---------------------------------------------------------------------------
// Transitions (pure over DockState, exported for tests)
// ---------------------------------------------------------------------------

/** Open `pane` (adding its tab) and make it the visible one. */
export function withPaneOpen(state: DockState, pane: DockPaneId): DockState {
  const tabs = state.tabs.includes(pane) ? state.tabs : [...state.tabs, pane];
  // Opening the pane that is the split's lower half swaps it to the top.
  const splitWith = state.splitWith === pane ? (state.active !== pane ? state.active : null) : state.splitWith;
  return { ...state, open: true, tabs, active: pane, splitWith: splitWith === pane ? null : splitWith };
}

/** The pane's toggle: open & focus it, or — when it is already the visible pane — close the dock. */
export function withPaneToggled(state: DockState, pane: DockPaneId): DockState {
  if (state.open && (state.active === pane || state.splitWith === pane)) return { ...state, open: false };
  return withPaneOpen(state, pane);
}

export function withTabClosed(state: DockState, pane: DockPaneId): DockState {
  const tabs = state.tabs.filter((t) => t !== pane);
  const splitWith = state.splitWith === pane ? null : state.splitWith;
  let active = state.active;
  if (active === pane) {
    // The split's lower pane moves up; otherwise the neighbour tab takes over.
    const index = state.tabs.indexOf(pane);
    active = splitWith ?? tabs[Math.min(index, tabs.length - 1)] ?? null;
  }
  return {
    ...state,
    tabs,
    active,
    splitWith: splitWith === active ? null : splitWith,
    open: tabs.length > 0 && state.open,
  };
}

/** Split `pane` BELOW the active one ("Preview over Terminal"); null un-splits. */
export function withSplit(state: DockState, pane: DockPaneId | null): DockState {
  if (pane === null) return { ...state, splitWith: null };
  if (state.active === null || pane === state.active) return state;
  const tabs = state.tabs.includes(pane) ? state.tabs : [...state.tabs, pane];
  return { ...state, open: true, tabs, splitWith: pane };
}

export function withWidth(state: DockState, width: number): DockState {
  if (!Number.isFinite(width)) return state;
  return { ...state, width: Math.max(DOCK_LAYOUT.minWidth, Math.round(width)) };
}

export function withSplitRatio(state: DockState, ratio: number): DockState {
  if (!Number.isFinite(ratio)) return state;
  const { min, max } = DOCK_LAYOUT.splitRatio;
  return { ...state, splitRatio: Math.min(max, Math.max(min, ratio)) };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function openDockPane(pane: DockPaneId): void {
  setState(withPaneOpen(current().state, pane));
}

export function toggleDockPane(pane: DockPaneId): void {
  setState(withPaneToggled(current().state, pane));
}

/** ⌘\ — show or hide the dock as it was; an empty dock opens on Tasks. */
export function toggleDock(): void {
  const state = current().state;
  if (state.open) setState({ ...state, open: false });
  else if (state.tabs.length === 0) setState(withPaneOpen(state, 'tasks'));
  else setState({ ...state, open: true, active: state.active ?? state.tabs[0]! });
}

export function closeDock(): void {
  const state = current().state;
  if (state.open) setState({ ...state, open: false });
}

export function closeDockTab(pane: DockPaneId): void {
  setState(withTabClosed(current().state, pane));
}

export function splitDock(pane: DockPaneId | null): void {
  setState(withSplit(current().state, pane));
}

export function setDockWidth(width: number): void {
  setState(withWidth(current().state, width));
}

export function setDockSplitRatio(ratio: number): void {
  setState(withSplitRatio(current().state, ratio));
}

/** Open the Terminal pane with a request (a tab at a root, a pasted command, an app launch). */
export function requestTerminal(request: Omit<TerminalRequest, 'nonce'>): void {
  nonce += 1;
  const snap = current();
  emit({ state: withPaneOpen(snap.state, 'terminal'), requests: { ...snap.requests, terminal: { ...request, nonce } } });
}

/**
 * The same request, but with Terminal as the LOWER half of a split under the
 * pane that is showing (Preview's dev-server Start: the page stays on top and
 * appears when its port answers, the server's output runs underneath — the
 * "Preview over Terminal" layout). With nothing showing, or when Terminal is
 * the pane on top, it is a plain open. In the bottom sheet the split's lower
 * pane is mounted but hidden, so the request still runs.
 */
export function requestTerminalBelow(request: Omit<TerminalRequest, 'nonce'>): void {
  const snap = current();
  const top = snap.state.open ? snap.state.active : null;
  if (top === null || top === 'terminal') {
    requestTerminal(request);
    return;
  }
  nonce += 1;
  emit({ state: withSplit(snap.state, 'terminal'), requests: { ...snap.requests, terminal: { ...request, nonce } } });
}

export function requestPreview(request: Omit<PreviewOpenRequest, 'nonce'>): void {
  nonce += 1;
  const snap = current();
  emit({ state: withPaneOpen(snap.state, 'preview'), requests: { ...snap.requests, preview: { ...request, nonce } } });
}

export function requestDiff(request: DiffPaneRequest): void {
  nonce += 1;
  const snap = current();
  emit({ state: withPaneOpen(snap.state, 'diff'), requests: { ...snap.requests, diff: { ...request, nonce } } });
}

/**
 * Requests are per chat: switching chats must not replay the last chat's
 * terminal paste. Callers clear on a SWITCH only — never on the Chat
 * section's first mount, which is exactly when an Apps [Launch ▸] (raised on
 * another surface, then `setVerseSection('chat')`) is waiting to be served.
 */
export function clearDockRequests(): void {
  const snap = current();
  if (snap.requests === NO_REQUESTS) return;
  emit({ ...snap, requests: NO_REQUESTS });
}

export function useDock(): DockSnapshot {
  return useSyncExternalStore(subscribeDockState, getDockSnapshot, getDockSnapshot);
}
