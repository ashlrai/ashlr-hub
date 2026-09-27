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
  normalizePaneId,
  sanitizeDockState,
  type DockLayout,
  type DockPaneId,
  type DockPlacement,
  type DockState,
} from '../shell/dock-catalog.js';
import type { DiffPaneRequest, PreviewOpenRequest, TerminalOpenRequest } from '../shell/slots.js';

/**
 * A terminal request as the dock carries it. C0's TerminalOpenRequest now
 * names the Apps [Launch ▸] fields (`via`, `model`) itself, so this is a
 * plain alias — kept so TerminalPane and the Apps launcher keep one name for
 * "what the dock hands the Terminal pane". The server resolves the actual
 * command either way, never the page.
 */
export type TerminalRequest = TerminalOpenRequest;

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
  activeChat = undefined;
  pendingPane = null;
  for (const listener of [...listeners]) listener();
}

// ---------------------------------------------------------------------------
// Transitions (pure over DockState, exported for tests)
// ---------------------------------------------------------------------------

/** Open `pane` (adding its tab) and make it the visible one. A legacy id opens the pane it became. */
export function withPaneOpen(state: DockState, requested: DockPaneId): DockState {
  const pane = normalizePaneId(requested);
  if (pane === null) return state;
  const tabs = state.tabs.includes(pane) ? state.tabs : [...state.tabs, pane];
  // Opening the pane that is the split's lower half swaps it to the top.
  const splitWith = state.splitWith === pane ? (state.active !== pane ? state.active : null) : state.splitWith;
  return { ...state, open: true, tabs, active: pane, splitWith: splitWith === pane ? null : splitWith };
}

/** The pane's toggle: open & focus it, or — when it is already the visible pane — close the dock. */
export function withPaneToggled(state: DockState, requested: DockPaneId): DockState {
  const pane = normalizePaneId(requested);
  if (pane === null) return state;
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

export function withHeight(state: DockState, height: number): DockState {
  if (!Number.isFinite(height)) return state;
  return { ...state, height: Math.max(DOCK_LAYOUT.minHeight, Math.round(height)) };
}

export function withPlacement(state: DockState, placement: DockPlacement): DockState {
  return state.placement === placement ? state : { ...state, placement };
}

const layoutOf = (state: DockLayout): DockLayout => ({ open: state.open, tabs: state.tabs, active: state.active, splitWith: state.splitWith });

/**
 * Leaving chat `from` for chat `to`: `from`'s layout is remembered (as the
 * most recent), and `to`'s comes back — or, for a chat never opened with a
 * panel, the current layout carries over (a new chat starts the way you
 * were working). The open chat's layout always lives in the top-level
 * fields; `byChat` holds the others, capped at DOCK_LAYOUT.chatMemoryLimit.
 */
export function withChatSwitch(state: DockState, from: string | null, to: string | null): DockState {
  if (from === to) return state;
  const byChat: Record<string, DockLayout> = { ...state.byChat };
  if (from !== null) {
    delete byChat[from];
    byChat[from] = layoutOf(state);
  }
  let next = layoutOf(state);
  if (to !== null && byChat[to]) {
    next = byChat[to]!;
    delete byChat[to];
  }
  const ids = Object.keys(byChat);
  for (const id of ids.slice(0, Math.max(0, ids.length - DOCK_LAYOUT.chatMemoryLimit))) delete byChat[id];
  return { ...state, ...next, byChat };
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

export function setDockHeight(height: number): void {
  setState(withHeight(current().state, height));
}

export function setDockPlacement(placement: DockPlacement): void {
  setState(withPlacement(current().state, placement));
}

/** Beside the chat ⇄ under it. */
export function toggleDockPlacement(): void {
  const state = current().state;
  setState(withPlacement(state, state.placement === 'right' ? 'bottom' : 'right'));
}

/**
 * The chat whose layout the panel shows. undefined = not told yet: the FIRST
 * call (the chat surface mounting on the chat that was open at reload)
 * adopts the persisted layout as that chat's instead of swapping.
 */
let activeChat: string | null | undefined;

/**
 * A pane to open once chat `sessionId` is the open one (a deep link, a
 * notification): opening it BEFORE the switch would file it under the chat
 * being left, since the switch swaps layouts.
 */
let pendingPane: { sessionId: string; paneId: DockPaneId } | null = null;

/** The chat surface calls this whenever the open chat changes (and once on mount). */
export function activateDockChat(sessionId: string | null): void {
  if (activeChat !== undefined && activeChat !== sessionId) {
    const from = activeChat;
    activeChat = sessionId;
    setState(withChatSwitch(current().state, from, sessionId));
  } else {
    activeChat = sessionId;
  }
  if (pendingPane && pendingPane.sessionId === sessionId) {
    const { paneId } = pendingPane;
    pendingPane = null;
    openDockPane(paneId);
  }
}

/**
 * Open `paneId` in chat `sessionId` — now, when that chat is already open
 * (or none is named), else as soon as the chat surface switches to it.
 */
export function openPaneInChat(paneId: DockPaneId, sessionId: string | null = null): void {
  if (sessionId === null || sessionId === activeChat) {
    pendingPane = null;
    openDockPane(paneId);
    return;
  }
  pendingPane = { sessionId, paneId };
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
  emit({ state: withPaneOpen(snap.state, 'browser'), requests: { ...snap.requests, preview: { ...request, nonce } } });
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

/**
 * One primitive derived from the dock's state, re-rendering only when THAT
 * value changes — so the chat surface does not re-render while the split
 * boundary is dragged, or when a request is raised.
 */
export function useDockValue<T extends string | number | boolean | null>(select: (state: DockState) => T): T {
  const read = () => select(current().state);
  return useSyncExternalStore(subscribeDockState, read, read);
}
