/**
 * routes/verse/shell/dock-catalog.ts — the chat dock's panes, layout rules
 * and persisted state (unit C0; SPEC-310C §3).
 *
 * The dock is C2's container; its panes belong to four units (C2 Tasks and
 * Context, C4 Terminal and Preview, C5 Review). This file is what they agree
 * on: which panes exist, which command opens each, which render through a
 * slot (slots.tsx, so the container never imports another unit's code), how
 * wide the dock may be, when it becomes a sheet, and the shape it persists.
 *
 * Pure data and pure functions — no React.
 */
import type { CommandId } from './command-catalog.js';
import { VIEWPORT_BREAKPOINTS } from './viewport.js';

export const DOCK_PANES = [
  { id: 'terminal', label: 'Terminal', owner: 'C4', commandId: 'dock.terminal', slot: 'terminal-pane' },
  { id: 'preview', label: 'Preview', owner: 'C4', commandId: 'dock.preview', slot: 'preview-pane' },
  { id: 'diff', label: 'Review', owner: 'C5', commandId: 'dock.diff', slot: 'diff-pane' },
  { id: 'tasks', label: 'Tasks', owner: 'C2', commandId: null, slot: null },
  { id: 'context', label: 'Context', owner: 'C2', commandId: null, slot: null },
] as const satisfies readonly {
  id: string;
  label: string;
  owner: string;
  /** The catalog command that opens (and focuses) this pane; null = opened from its own affordance. */
  commandId: CommandId | null;
  /** Rendered through this slot when the pane is another unit's; null = C2's own component. */
  slot: 'terminal-pane' | 'preview-pane' | 'diff-pane' | null;
}[];

export type DockPaneId = (typeof DOCK_PANES)[number]['id'];
export const DOCK_PANE_IDS: readonly DockPaneId[] = DOCK_PANES.map((p) => p.id);

export function isDockPaneId(value: unknown): value is DockPaneId {
  return typeof value === 'string' && (DOCK_PANE_IDS as readonly string[]).includes(value);
}

/**
 * Layout rules. Widths in CSS px, measured against the WINDOW, not the chat
 * column: "resizable from 320px to 60% of the window".
 */
export const DOCK_LAYOUT = Object.freeze({
  minWidth: 320,
  maxWidthFraction: 0.6,
  /** A new dock opens this wide (the 440 of the SPEC-310C shell sketch). */
  defaultWidth: 440,
  /** Below this window width the dock is a sheet over the chat, not a column. */
  sheetBelow: VIEWPORT_BREAKPOINTS.wide,
  /** Below this window width it is a bottom sheet… */
  bottomSheetBelow: VIEWPORT_BREAKPOINTS.compact,
  /** …this tall, in vh. */
  bottomSheetHeightVh: 75,
  /** The top pane's share of the height in a vertical split. */
  splitRatio: Object.freeze({ min: 0.2, max: 0.8, default: 0.5 }),
});

export type DockPresentation = 'column' | 'sheet' | 'bottom-sheet';

/** How the dock is drawn at a given window width. */
export function dockPresentation(windowWidth: number): DockPresentation {
  if (windowWidth < DOCK_LAYOUT.bottomSheetBelow) return 'bottom-sheet';
  if (windowWidth < DOCK_LAYOUT.sheetBelow) return 'sheet';
  return 'column';
}

/**
 * A persisted or dragged width clamped for this window. The floor wins over
 * the 60% cap on a window too narrow to honour both (it is a sheet there
 * anyway), so the result is never below minWidth.
 */
export function clampDockWidth(width: unknown, windowWidth: number): number {
  const n = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : DOCK_LAYOUT.defaultWidth;
  const max = Math.max(DOCK_LAYOUT.minWidth, Math.floor(windowWidth * DOCK_LAYOUT.maxWidthFraction));
  return Math.min(max, Math.max(DOCK_LAYOUT.minWidth, n));
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/** The v2 key C1 migrates FROM (verse-ui-store.ts). */
export const VERSE_UI_STORAGE_KEY_V2 = 'ashlr.verse.ui.v2';
/**
 * The v3 key (SPEC-310C §3 "State persists in ashlr.verse.ui.v3"). ONE blob,
 * written by C1's verse-ui-store; the dock's state is its `dock` field, read
 * back through sanitizeDockState — so two writers never race for the key.
 */
export const VERSE_UI_STORAGE_KEY = 'ashlr.verse.ui.v3';

export interface DockState {
  open: boolean;
  /** Last dragged width; clamp with clampDockWidth at render (it depends on the window). */
  width: number;
  /** Open panes, in tab order. */
  tabs: DockPaneId[];
  /** The pane shown (on top, when split); null only when there are no tabs. */
  active: DockPaneId | null;
  /** A second pane shown BELOW `active` ("Preview over Terminal"); never equal to it. */
  splitWith: DockPaneId | null;
  /** `active`'s share of the height when split. */
  splitRatio: number;
}

export const DEFAULT_DOCK_STATE: Readonly<DockState> = Object.freeze({
  open: false,
  width: DOCK_LAYOUT.defaultWidth,
  tabs: [],
  active: null,
  splitWith: null,
  splitRatio: DOCK_LAYOUT.splitRatio.default,
});

/**
 * Read a persisted `dock` field without trusting it: unknown panes dropped,
 * duplicates collapsed, `active`/`splitWith` forced to open tabs, numbers
 * clamped. Anything unreadable falls back to the default, never throws — a
 * hand-edited or future-version blob must not take the chat down.
 */
export function sanitizeDockState(value: unknown): DockState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DOCK_STATE, tabs: [] };
  const raw = value as Record<string, unknown>;
  const tabs: DockPaneId[] = [];
  if (Array.isArray(raw['tabs'])) {
    for (const tab of raw['tabs']) if (isDockPaneId(tab) && !tabs.includes(tab)) tabs.push(tab);
  }
  const active: DockPaneId | null = isDockPaneId(raw['active']) && tabs.includes(raw['active']) ? raw['active'] : (tabs[0] ?? null);
  const splitWith: DockPaneId | null =
    isDockPaneId(raw['splitWith']) && tabs.includes(raw['splitWith']) && raw['splitWith'] !== active ? raw['splitWith'] : null;
  const width = typeof raw['width'] === 'number' && Number.isFinite(raw['width']) && raw['width'] >= DOCK_LAYOUT.minWidth
    ? Math.round(raw['width'])
    : DOCK_LAYOUT.defaultWidth;
  const ratio = typeof raw['splitRatio'] === 'number' && Number.isFinite(raw['splitRatio']) ? raw['splitRatio'] : DOCK_LAYOUT.splitRatio.default;
  return {
    open: raw['open'] === true && tabs.length > 0,
    width,
    tabs,
    active,
    splitWith,
    splitRatio: Math.min(DOCK_LAYOUT.splitRatio.max, Math.max(DOCK_LAYOUT.splitRatio.min, ratio)),
  };
}
