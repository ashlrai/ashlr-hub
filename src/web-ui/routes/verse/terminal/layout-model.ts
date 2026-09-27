/**
 * terminal/layout-model.ts — tabs and splits (3.15).
 *
 * The SERVER owns shells (tabs, PTYs, scrollback); the PAGE owns how they are
 * laid out. A strip tab is a GROUP of up to six shells: side by side (row),
 * stacked (column), or tiled (grid — ⌈√n⌉ columns). One pane can be ZOOMED
 * to fill the group for a moment. The layout is kept per chat in
 * localStorage, so a reload reattaches to the same shells in the same
 * arrangement; shells the layout does not know yet (opened elsewhere) get a
 * group of their own, and groups whose shells are gone disappear.
 *
 * WHY SIX NOW. Until 3.15 every visible shell held its own streaming
 * connection and a browser allows ~6 per origin, so a group stopped at two.
 * The panel now reads every visible shell over ONE multiplexed connection
 * (panel-stream.ts `createTerminalStreamMux`), so a group's size is a
 * question of screen space, not connections.
 */

/** Where a split puts the new pane, relative to the focused one. */
export type SplitDirection = 'row' | 'column';
/** How a group lays its panes out. */
export type GroupArrangement = 'row' | 'column' | 'grid';
export type LeafMode = 'terminal' | 'blocks';
export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export interface TerminalGroup {
  id: string;
  /** Shell ids, 1 to MAX_PANES_PER_GROUP. */
  panes: string[];
  direction: GroupArrangement;
  /** The pane keystrokes go to. */
  focused: string;
  /** A pane shown alone, filling the group; absent = every pane. */
  zoomed?: string | null;
}

export const AGENT_GROUP_ID = 'agent';
export const MAX_PANES_PER_GROUP = 6;
const ARRANGEMENTS: readonly GroupArrangement[] = ['row', 'column', 'grid'];

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
    const direction: GroupArrangement = ARRANGEMENTS.includes(g.direction) ? g.direction : 'row';
    const zoomed = g.zoomed && panes.length > 1 && panes.includes(g.zoomed) ? g.zoomed : null;
    groups.push({ id: g.id, panes, direction, focused, ...(zoomed ? { zoomed } : {}) });
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
      return o.id === g.id && o.focused === g.focused && o.direction === g.direction && o.panes.join() === g.panes.join()
        && (o.zoomed ?? null) === (g.zoomed ?? null);
    })
    && Object.keys(modes).length === Object.keys(layout.modes).length;
  return unchanged ? layout : { groups, active, modes };
}

/** A new shell in its own group, made active. */
export function addGroup(layout: TerminalLayout, tabId: string): TerminalLayout {
  const group: TerminalGroup = { id: newGroupId(), panes: [tabId], direction: 'row', focused: tabId };
  return { ...layout, groups: [...layout.groups.filter((g) => !g.panes.includes(tabId)), group], active: group.id };
}

/**
 * The arrangement after a split: the first split picks it; splitting again
 * the same way keeps it; splitting the OTHER way (a row split down) tiles.
 */
export function arrangementAfterSplit(current: GroupArrangement, panes: number, direction: SplitDirection): GroupArrangement {
  if (panes <= 1) return direction;
  if (current === 'grid' || current === direction) return current;
  return 'grid';
}

/** Put `tabId` beside the group's focused pane (un-zooming it). Null when the group is full. */
export function splitGroup(layout: TerminalLayout, groupId: string, tabId: string, direction: SplitDirection): TerminalLayout | null {
  const group = layout.groups.find((g) => g.id === groupId);
  if (!group || group.panes.length >= MAX_PANES_PER_GROUP) return null;
  const at = group.panes.indexOf(group.focused);
  const panes = [...group.panes];
  panes.splice(at + 1, 0, tabId);
  const next: TerminalGroup = { id: group.id, panes, direction: arrangementAfterSplit(group.direction, group.panes.length, direction), focused: tabId };
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
    const { zoomed, ...rest } = g;
    const keepZoom = zoomed && zoomed !== tabId && panes.length > 1;
    groups.push({ ...rest, panes, focused: g.focused === tabId ? panes[0]! : g.focused, ...(keepZoom ? { zoomed } : {}) });
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

/** Lay a group out as a row, a column or a grid. */
export function setArrangement(layout: TerminalLayout, groupId: string, direction: GroupArrangement): TerminalLayout {
  const group = layout.groups.find((g) => g.id === groupId);
  if (!group || group.direction === direction) return layout;
  return { ...layout, groups: layout.groups.map((g) => (g.id === groupId ? { ...g, direction } : g)) };
}

/** Row → column → grid → row. */
export function nextArrangement(direction: GroupArrangement): GroupArrangement {
  return ARRANGEMENTS[(ARRANGEMENTS.indexOf(direction) + 1) % ARRANGEMENTS.length]!;
}

/** Zoom the focused pane to fill its group, or put it back. A single pane never zooms. */
export function toggleZoom(layout: TerminalLayout, groupId: string): TerminalLayout {
  const group = layout.groups.find((g) => g.id === groupId);
  if (!group) return layout;
  const zoomed = group.zoomed ? null : group.panes.length > 1 ? group.focused : null;
  if ((group.zoomed ?? null) === zoomed) return layout;
  return {
    ...layout,
    groups: layout.groups.map((g) => {
      if (g.id !== groupId) return g;
      const { zoomed: _previous, ...rest } = g;
      return zoomed ? { ...rest, zoomed } : rest;
    }),
  };
}

/** Columns × rows of a grid of `n` panes: ⌈√n⌉ columns (2 → 2×1, 3–4 → 2×2, 5–6 → 3×2). */
export function gridShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Each pane's cell: its row and column, and how many columns it spans (a short last row's final pane stretches). */
export function paneCells(group: Pick<TerminalGroup, 'panes' | 'direction'>): Array<{ id: string; row: number; col: number; span: number }> {
  const n = group.panes.length;
  if (group.direction === 'row') return group.panes.map((id, i) => ({ id, row: 0, col: i, span: 1 }));
  if (group.direction === 'column') return group.panes.map((id, i) => ({ id, row: i, col: 0, span: 1 }));
  const { cols } = gridShape(n);
  return group.panes.map((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Three panes: two on top, the third full-width below — no hole in the grid.
    const span = i === n - 1 ? cols - col : 1;
    return { id, row, col, span };
  });
}

/**
 * The pane beside `from` in a direction (⌥⌘←→↑↓), or null at the edge. Up and
 * down pick the nearest row, then the pane most in line with this one.
 */
export function neighborPane(group: Pick<TerminalGroup, 'panes' | 'direction'>, from: string, direction: PaneDirection): string | null {
  const cells = paneCells(group);
  const here = cells.find((c) => c.id === from);
  if (!here) return null;
  const center = (c: { col: number; span: number }) => c.col + c.span / 2;
  let best: { id: string; primary: number; secondary: number } | null = null;
  for (const c of cells) {
    if (c.id === from) continue;
    let primary: number;
    let secondary = 0;
    if (direction === 'left' || direction === 'right') {
      if (c.row !== here.row) continue;
      primary = direction === 'left' ? here.col - c.col : c.col - here.col;
    } else {
      primary = direction === 'up' ? here.row - c.row : c.row - here.row;
      secondary = Math.abs(center(c) - center(here));
    }
    if (primary <= 0) continue;
    if (!best || primary < best.primary || (primary === best.primary && secondary < best.secondary)) best = { id: c.id, primary, secondary };
  }
  return best?.id ?? null;
}

/** The next / previous pane in order, wrapping. */
export function cyclePane(group: Pick<TerminalGroup, 'panes'>, from: string, delta: 1 | -1): string {
  const i = group.panes.indexOf(from);
  if (i < 0) return group.panes[0] ?? from;
  return group.panes[(i + delta + group.panes.length) % group.panes.length]!;
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
    && typeof g.focused === 'string' && ARRANGEMENTS.includes(g.direction)
    && (g.zoomed === undefined || g.zoomed === null || typeof g.zoomed === 'string');
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
