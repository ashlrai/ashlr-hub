/**
 * routes/verse/shell/dock-catalog.ts — the chat dock's panes, layout rules
 * and persisted state (unit C0; SPEC-310C §3; 3.16 workbench).
 *
 * The dock is the chat's PANEL AREA: tabs and splits beside the chat (or,
 * by the operator's choice, under it). Its panes come from the pane
 * registry (routes/verse/panes/) — first-party ones listed below, others
 * registered by their own units — so the container never imports a pane's
 * code. This file is what they all agree on: the first-party panes, how big
 * the panel may be, when it becomes a sheet, and the shape it persists.
 *
 * Pure data and pure functions — no React. On the chat's first-paint path:
 * keep it small.
 */
import type { CommandId } from './command-catalog.js';
import { VIEWPORT_BREAKPOINTS } from './viewport.js';

/**
 * The FIRST-PARTY panes, in the order the dock's menus list them. This is
 * metadata only (no components): the pane REGISTRY (routes/verse/panes/)
 * turns each into a registered pane, and other units add or replace panes
 * there with `registerPane` — without touching this table or the dock.
 *
 * `slot` names the C0 slot a pane renders through when its body is another
 * unit's file; null = a component the workbench owns (panes/builtin-panes).
 */
export const DOCK_PANES = [
  { id: 'terminal', label: 'Terminal', owner: 'C4', commandId: 'dock.terminal', slot: 'terminal-pane' },
  { id: 'browser', label: 'Browser', owner: 'C4', commandId: 'dock.preview', slot: 'preview-pane' },
  { id: 'diff', label: 'Changes', owner: 'C5', commandId: 'dock.diff', slot: 'diff-pane' },
  { id: 'files', label: 'Files', owner: 'workbench', commandId: 'dock.files', slot: null },
  { id: 'sources', label: 'Sources', owner: 'workbench', commandId: 'dock.sources', slot: null },
  { id: 'reasoning', label: 'Reasoning', owner: 'workbench', commandId: 'dock.reasoning', slot: null },
  { id: 'tasks', label: 'Tasks', owner: 'C2', commandId: null, slot: null },
  { id: 'context', label: 'Context', owner: 'C2', commandId: null, slot: null },
] as const satisfies readonly {
  id: string;
  label: string;
  owner: string;
  /** The catalog command that opens (and focuses) this pane; null = opened from its own affordance. */
  commandId: CommandId | null;
  /** Rendered through this slot when the pane is another unit's; null = the workbench's own component. */
  slot: 'terminal-pane' | 'preview-pane' | 'diff-pane' | null;
}[];

/** A first-party pane's id. */
export type BuiltinPaneId = (typeof DOCK_PANES)[number]['id'];
export const DOCK_PANE_IDS: readonly BuiltinPaneId[] = DOCK_PANES.map((p) => p.id);

/**
 * Any pane's id — first-party or registered by another unit (panes/). Open
 * by design: persisted state may name a pane whose module registers after
 * the dock hydrates, so ids are validated by SHAPE here and by the registry
 * at render (an unregistered tab is simply not drawn, and comes back when
 * its pane does).
 */
export type DockPaneId = string;

/** Lower-case letters, numbers and dashes, starting with a letter; at most 40 characters. */
export const PANE_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Ids a pane used to have. A persisted layout written before the rename
 * still opens the same pane ("preview" became the Browser pane in 3.16).
 */
export const LEGACY_PANE_IDS: Readonly<Record<string, DockPaneId>> = Object.freeze({ preview: 'browser' });

/** A persisted or requested id, with its legacy name resolved; null when it cannot be a pane id. */
export function normalizePaneId(value: unknown): DockPaneId | null {
  if (typeof value !== 'string') return null;
  const id = Object.prototype.hasOwnProperty.call(LEGACY_PANE_IDS, value) ? LEGACY_PANE_IDS[value]! : value;
  return PANE_ID_RE.test(id) ? id : null;
}

export function isDockPaneId(value: unknown): value is DockPaneId {
  return typeof value === 'string' && PANE_ID_RE.test(value);
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
  /**
   * The BOTTOM panel (placement 'bottom', at 1024px and up): a row under
   * the transcript, like an editor's terminal panel. Heights in CSS px
   * against the chat column; the transcript keeps at least `minTranscript`.
   */
  minHeight: 160,
  defaultHeight: 300,
  maxHeightFraction: 0.7,
  minTranscript: 220,
  /** Chats whose panel layout is remembered (least recently opened forgotten first). */
  chatMemoryLimit: 40,
});

/** Where the operator wants the panel: beside the chat, or under it. */
export type DockPlacement = 'right' | 'bottom';

/**
 * How the dock is drawn. `column` and `bottom` are the two docked
 * placements (the operator's choice); below 1024px the window decides —
 * a sheet over the chat, and on a phone a bottom sheet.
 */
export type DockPresentation = 'column' | 'bottom' | 'sheet' | 'bottom-sheet';

/** How the dock is drawn at a given window width (and, when there is room, placement). */
export function dockPresentation(windowWidth: number, placement: DockPlacement = 'right'): DockPresentation {
  if (windowWidth < DOCK_LAYOUT.bottomSheetBelow) return 'bottom-sheet';
  if (windowWidth < DOCK_LAYOUT.sheetBelow) return 'sheet';
  return placement === 'bottom' ? 'bottom' : 'column';
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

/**
 * The bottom panel's height in a chat column `columnHeight` tall: at least
 * minHeight, at most 70% of the column, and never so tall that the
 * transcript drops under minTranscript. The floor wins on a column too short
 * for every rule; an unmeasured column (0) only applies the floor.
 */
export function clampDockHeight(height: unknown, columnHeight: number): number {
  const n = typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : DOCK_LAYOUT.defaultHeight;
  if (!(columnHeight > 0)) return Math.max(DOCK_LAYOUT.minHeight, n);
  const max = Math.max(
    DOCK_LAYOUT.minHeight,
    Math.min(Math.floor(columnHeight * DOCK_LAYOUT.maxHeightFraction), Math.floor(columnHeight - DOCK_LAYOUT.minTranscript)),
  );
  return Math.min(max, Math.max(DOCK_LAYOUT.minHeight, n));
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

/** What the panel shows — the part remembered PER CHAT. */
export interface DockLayout {
  open: boolean;
  /** Open panes, in tab order. */
  tabs: DockPaneId[];
  /** The pane shown (on top, when split); null only when there are no tabs. */
  active: DockPaneId | null;
  /** A second pane shown BELOW `active` ("Preview over Terminal"); never equal to it. */
  splitWith: DockPaneId | null;
}

export interface DockState extends DockLayout {
  /** Last dragged width; clamp with clampDockWidth at render (it depends on the window). */
  width: number;
  /** `active`'s share of the height when split. */
  splitRatio: number;
  /** Beside the chat or under it (1024px and up; a window-level preference, not per chat). */
  placement: DockPlacement;
  /** The bottom panel's last dragged height; clamp with clampDockHeight at render. */
  height: number;
  /**
   * Each chat's own layout, by session id, least recently left first — so a
   * terminal-heavy chat reopens with its terminal and a reading chat with
   * nothing. The OPEN chat's layout is the top-level fields; this holds the
   * others. Capped at DOCK_LAYOUT.chatMemoryLimit.
   */
  byChat: Readonly<Record<string, DockLayout>>;
}

export const DEFAULT_DOCK_STATE: Readonly<DockState> = Object.freeze({
  open: false,
  width: DOCK_LAYOUT.defaultWidth,
  tabs: [],
  active: null,
  splitWith: null,
  splitRatio: DOCK_LAYOUT.splitRatio.default,
  placement: 'right',
  height: DOCK_LAYOUT.defaultHeight,
  byChat: Object.freeze({}),
});

/** Session ids as the engine writes them (the same shape `open-session:<id>` accepts). */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** A layout read without trusting it (the per-chat part of sanitizeDockState). */
export function sanitizeDockLayout(value: unknown): DockLayout {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const tabs: DockPaneId[] = [];
  if (Array.isArray(raw['tabs'])) {
    for (const tab of raw['tabs']) {
      const id = normalizePaneId(tab);
      if (id !== null && !tabs.includes(id)) tabs.push(id);
    }
  }
  const wantActive = normalizePaneId(raw['active']);
  const active: DockPaneId | null = wantActive !== null && tabs.includes(wantActive) ? wantActive : (tabs[0] ?? null);
  const wantSplit = normalizePaneId(raw['splitWith']);
  const splitWith: DockPaneId | null = wantSplit !== null && tabs.includes(wantSplit) && wantSplit !== active ? wantSplit : null;
  return { open: raw['open'] === true && tabs.length > 0, tabs, active, splitWith };
}

/**
 * Read a persisted `dock` field without trusting it: ids that cannot be a
 * pane dropped (legacy names renamed), duplicates collapsed,
 * `active`/`splitWith` forced to open tabs, numbers clamped, the per-chat
 * memory capped. Anything unreadable falls back to the default, never throws
 * — a hand-edited or future-version blob must not take the chat down.
 */
export function sanitizeDockState(value: unknown): DockState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DOCK_STATE, tabs: [], byChat: {} };
  const raw = value as Record<string, unknown>;
  const layout = sanitizeDockLayout(raw);
  const width = typeof raw['width'] === 'number' && Number.isFinite(raw['width']) && raw['width'] >= DOCK_LAYOUT.minWidth
    ? Math.round(raw['width'])
    : DOCK_LAYOUT.defaultWidth;
  const height = typeof raw['height'] === 'number' && Number.isFinite(raw['height']) && raw['height'] >= DOCK_LAYOUT.minHeight
    ? Math.round(raw['height'])
    : DOCK_LAYOUT.defaultHeight;
  const ratio = typeof raw['splitRatio'] === 'number' && Number.isFinite(raw['splitRatio']) ? raw['splitRatio'] : DOCK_LAYOUT.splitRatio.default;
  const byChat: Record<string, DockLayout> = {};
  const rawByChat = raw['byChat'];
  if (rawByChat !== null && typeof rawByChat === 'object' && !Array.isArray(rawByChat)) {
    const entries = Object.entries(rawByChat as Record<string, unknown>).filter(([id]) => SESSION_ID_RE.test(id));
    for (const [id, saved] of entries.slice(-DOCK_LAYOUT.chatMemoryLimit)) byChat[id] = sanitizeDockLayout(saved);
  }
  return {
    ...layout,
    width,
    splitRatio: Math.min(DOCK_LAYOUT.splitRatio.max, Math.max(DOCK_LAYOUT.splitRatio.min, ratio)),
    placement: raw['placement'] === 'bottom' ? 'bottom' : 'right',
    height,
    byChat,
  };
}
