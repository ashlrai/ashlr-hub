/**
 * terminal/layout-model.ts — tabs and splits (3.15).
 *
 * The SERVER owns shells (tabs, PTYs, scrollback); the PAGE owns how they are
 * laid out. A strip tab is a GROUP of one or two shells side by side (row) or
 * stacked (column). The layout is kept per chat in localStorage, so a reload
 * reattaches to the same shells in the same arrangement; shells the layout
 * does not know yet (opened elsewhere) get a group of their own, and groups
 * whose shells are gone disappear.
 *
 * WHY AT MOST TWO PANES. Every visible shell holds one streaming connection
 * (terminal-stream.ts), and a browser allows about six per origin to the
 * sidecar — Verse already holds two (app events, the open chat) and needs
 * one free for ordinary requests. Two visible shells is the ceiling that
 * keeps keystrokes snappy.
 */

export type SplitDirection = 'row' | 'column';
export type LeafMode = 'terminal' | 'blocks';

export interface TerminalGroup {
  id: string;
  /** Shell ids, 1 or 2. */
  panes: string[];
  direction: SplitDirection;
  /** The pane keystrokes go to. */
  focused: string;
}

export const AGENT_GROUP_ID = 'agent';
export const MAX_PANES_PER_GROUP = 2;

export interface TerminalLayout {
  groups: TerminalGroup[];
  /** A group id, AGENT_GROUP_ID, or null (nothing chosen yet). */
  active: string | null;
  /** Per shell: the raw terminal or its block list. */
  modes: Record<string, LeafMode>;
}

export const EMPTY_LAYOUT: TerminalLayout = { groups: [], active: null, modes: {} };

let groupCounter = 0;
export function newGroupId(): string {
  groupCounter += 1;
  return `g-${Date.now().toString(36)}-${groupCounter}`;
}

/**
 * Fit a (possibly stale, possibly hand-edited) layout to the shells that
 * exist: unknown shells pruned, empty groups dropped, duplicates removed,
 * new shells appended as their own groups, the active group kept valid.
 */
export function reconcileLayout(layout: TerminalLayout, liveTabIds: readonly string[]): TerminalLayout {
  const live = new Set(liveTabIds);
  const seen = new Set<string>();
  const groups: TerminalGroup[] = [];
  for (const g of layout.groups) {
    const panes = g.panes.filter((id) => live.has(id) && !seen.has(id)).slice(0, MAX_PANES_PER_GROUP);
    for (const id of panes) seen.add(id);
    if (panes.length === 0) continue;
    const focused = panes.includes(g.focused) ? g.focused : panes[0]!;
    const direction: SplitDirection = g.direction === 'column' ? 'column' : 'row';
    groups.push({ id: g.id, panes, direction, focused });
  }
  for (const id of liveTabIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push({ id: newGroupId(), panes: [id], direction: 'row', focused: id });
  }
  const modes: Record<string, LeafMode> = {};
  for (const [id, mode] of Object.entries(layout.modes)) {
    if (live.has(id) && (mode === 'terminal' || mode === 'blocks')) modes[id] = mode;
  }
  let active = layout.active;
  if (active !== AGENT_GROUP_ID && !groups.some((g) => g.id === active)) active = groups.at(-1)?.id ?? null;
  const unchanged = active === layout.active
    && groups.length === layout.groups.length
    && groups.every((g, i) => {
      const o = layout.groups[i]!;
      return o.id === g.id && o.focused === g.focused && o.direction === g.direction && o.panes.join() === g.panes.join();
    })
    && Object.keys(modes).length === Object.keys(layout.modes).length;
  return unchanged ? layout : { groups, active, modes };
}

/** A new shell in its own group, made active. */
export function addGroup(layout: TerminalLayout, tabId: string): TerminalLayout {
  const group: TerminalGroup = { id: newGroupId(), panes: [tabId], direction: 'row', focused: tabId };
  return { ...layout, groups: [...layout.groups.filter((g) => !g.panes.includes(tabId)), group], active: group.id };
}

/** Put `tabId` beside the group's focused pane. False when the group is full. */
export function splitGroup(layout: TerminalLayout, groupId: string, tabId: string, direction: SplitDirection): TerminalLayout | null {
  const group = layout.groups.find((g) => g.id === groupId);
  if (!group || group.panes.length >= MAX_PANES_PER_GROUP) return null;
  const at = group.panes.indexOf(group.focused);
  const panes = [...group.panes];
  panes.splice(at + 1, 0, tabId);
  const next: TerminalGroup = { ...group, panes, direction, focused: tabId };
  return {
    ...layout,
    groups: layout.groups.filter((g) => !g.panes.includes(tabId) || g.id === groupId).map((g) => (g.id === groupId ? next : g)),
    active: groupId,
  };
}

/** A shell closed: out of its group (the group goes when empty); focus moves to its neighbour. */
export function removePane(layout: TerminalLayout, tabId: string): TerminalLayout {
  const groups: TerminalGroup[] = [];
  let removedGroupIndex = -1;
  layout.groups.forEach((g, index) => {
    if (!g.panes.includes(tabId)) {
      groups.push(g);
      return;
    }
    const panes = g.panes.filter((id) => id !== tabId);
    if (panes.length === 0) {
      removedGroupIndex = index;
      return;
    }
    groups.push({ ...g, panes, focused: g.focused === tabId ? panes[0]! : g.focused });
  });
  const modes = { ...layout.modes };
  delete modes[tabId];
  let active = layout.active;
  if (removedGroupIndex >= 0 && layout.groups[removedGroupIndex]!.id === active) {
    active = (groups[removedGroupIndex] ?? groups[removedGroupIndex - 1] ?? null)?.id ?? null;
  }
  return { groups, active, modes };
}

export function focusPane(layout: TerminalLayout, groupId: string, tabId: string): TerminalLayout {
  const group = layout.groups.find((g) => g.id === groupId);
  if (!group || !group.panes.includes(tabId) || (group.focused === tabId && layout.active === groupId)) return layout;
  return { ...layout, active: groupId, groups: layout.groups.map((g) => (g.id === groupId ? { ...g, focused: tabId } : g)) };
}

export function setMode(layout: TerminalLayout, tabId: string, mode: LeafMode): TerminalLayout {
  if ((layout.modes[tabId] ?? 'terminal') === mode) return layout;
  return { ...layout, modes: { ...layout.modes, [tabId]: mode } };
}

// ---------------------------------------------------------------------------
// Persistence (per chat; storage failures are harmless)
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'ashlr.verse.terminal.layout.v1:';

export function layoutStorageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

function isGroup(value: unknown): value is TerminalGroup {
  const g = value as TerminalGroup | null;
  return !!g && typeof g.id === 'string' && Array.isArray(g.panes) && g.panes.every((p) => typeof p === 'string')
    && typeof g.focused === 'string' && (g.direction === 'row' || g.direction === 'column');
}

export function parseLayout(raw: string | null): TerminalLayout {
  if (!raw) return EMPTY_LAYOUT;
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalLayout> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_LAYOUT;
    const groups = Array.isArray(parsed.groups) ? parsed.groups.filter(isGroup).slice(0, 32) : [];
    const active = typeof parsed.active === 'string' ? parsed.active : null;
    const modes = parsed.modes && typeof parsed.modes === 'object' ? (parsed.modes as Record<string, LeafMode>) : {};
    return { groups, active, modes };
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function loadLayout(sessionId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): TerminalLayout {
  try {
    return parseLayout(storage?.getItem(layoutStorageKey(sessionId)) ?? null);
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function saveLayout(sessionId: string, layout: TerminalLayout, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (layout.groups.length === 0) storage?.removeItem(layoutStorageKey(sessionId));
    else storage?.setItem(layoutStorageKey(sessionId), JSON.stringify(layout));
  } catch {
    /* private mode / quota: the layout lasts for this page only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
