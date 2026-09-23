/**
 * routes/verse/chat-panel-sizing.ts — how wide the two side panels of the
 * Chat section are, and what the viewport will actually let them be.
 *
 * WHY THIS IS NOT `ashlr.verse.ui.v2`. That key's shape is the shell contract
 * (docs/VERSE-CONTRACT-V2.md) and verse-ui-store.test pins it field for
 * field; the same precedent that put `resources-collapse.ts` under its own
 * key applies here. This module also needs something the shell store cannot
 * express: a width is not a single number but a PAIR — what the operator
 * asked for, and what the window is currently wide enough to give them.
 *
 * DESIRED vs EFFECTIVE. A sidebar dragged to 420px on a 1900px display must
 * not strand the transcript when the same window is later 1100px wide. So the
 * operator's choice (`desired`) is what persists, and `effective` is that
 * choice re-fitted to the container on every layout change. Shrinking the
 * window narrows the panel; widening it gives the width back, because the
 * transient value was never written down.
 *
 * Pure aside from the two localStorage functions, and framework-free — the
 * React glue lives in ChatResizer.tsx, the same split as
 * verse-ui-store.ts / useVerseUi.ts.
 */

export type ChatPanelSide = 'sidebar' | 'resources';

export interface ChatPanelRange {
  readonly min: number;
  readonly max: number;
  readonly def: number;
}

/**
 * Minimum and maximum are both load-bearing. The minimum is the width below
 * which the panel stops being a panel and becomes a sliver of truncated
 * text; the maximum keeps a wide display from turning the transcript into a
 * column. Defaults match what the shell has always opened at, so nothing
 * moves for an operator who never drags anything.
 */
export const CHAT_PANEL_RANGES: Readonly<Record<ChatPanelSide, ChatPanelRange>> = {
  sidebar: { min: 220, max: 420, def: 264 },
  resources: { min: 240, max: 520, def: 320 },
};

/**
 * The transcript's floor. Below `--measure-read` (720px) reading is already
 * compromised; 480px is where the composer's own controls start wrapping, and
 * it is the point past which a side panel must give width back instead of
 * taking more. The narrow-width media queries in ChatSection.module.css take
 * over below that — this number only decides who yields first.
 */
export const MIN_TRANSCRIPT_WIDTH = 480;

/** The 1px hairline track each visible resizer occupies. */
const HAIRLINE = 1;

/** Arrow-key step, and the coarse step Shift asks for. */
export const CHAT_PANEL_STEP = 16;
export const CHAT_PANEL_STEP_COARSE = 64;

export const CHAT_PANEL_SIZING_KEY = 'ashlr.verse.panels.v1';

/**
 * Read-only migration source. Panel widths lived in the shell store before
 * they were draggable; seeding from it once means an upgrade does not reset
 * a width the operator had already chosen. Never written to from here.
 */
const LEGACY_SHELL_KEY = 'ashlr.verse.ui.v2';

export interface ChatPanelWidths {
  readonly sidebar: number;
  readonly resources: number;
}

/** What the chat grid can currently afford. */
export interface ChatPanelFit {
  /**
   * Width in px of the chat grid itself (NOT the window): rail excluded,
   * because the rail is not the section's to spend. Zero or unknown — jsdom,
   * a hidden section, the first paint — disables viewport fitting entirely
   * rather than guessing, so a width is never clamped against a measurement
   * that does not exist.
   */
  readonly containerWidth: number;
  readonly sidebarVisible: boolean;
  readonly resourcesVisible: boolean;
}

export const UNKNOWN_FIT: ChatPanelFit = {
  containerWidth: 0,
  sidebarVisible: true,
  resourcesVisible: true,
};

export interface ChatPanelSizing {
  /** The operator's choice. This is what persists. */
  readonly desired: ChatPanelWidths;
  /** That choice, re-fitted to the current container. This is what renders. */
  readonly effective: ChatPanelWidths;
}

/**
 * Clamp one width into its own range. Nonsense — NaN, a string, a negative
 * number out of a hand-edited localStorage entry — resolves to the default
 * rather than to the minimum, so a corrupt value reads as "never chosen".
 */
export function clampPanelWidth(side: ChatPanelSide, value: unknown): number {
  const range = CHAT_PANEL_RANGES[side];
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return range.def;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

/**
 * Re-fit a chosen pair of widths to the container.
 *
 * The resources panel yields first: it is the optional one (it has a toggle,
 * the sidebar's collapse is an overlay at phone width), so on a narrowing
 * window the operator loses reference material before they lose navigation.
 * Neither panel is ever pushed below its own minimum — past that point the
 * media queries hide a panel outright, which is a better answer than a 40px
 * stub of clipped text.
 */
export function fitChatPanels(widths: ChatPanelWidths, fit: ChatPanelFit): ChatPanelWidths {
  let sidebar = clampPanelWidth('sidebar', widths.sidebar);
  let resources = clampPanelWidth('resources', widths.resources);
  if (!Number.isFinite(fit.containerWidth) || fit.containerWidth <= 0) return { sidebar, resources };

  const hairlines = (fit.sidebarVisible ? HAIRLINE : 0) + (fit.resourcesVisible ? HAIRLINE : 0);
  const budget = fit.containerWidth - MIN_TRANSCRIPT_WIDTH - hairlines;
  const spent = (fit.sidebarVisible ? sidebar : 0) + (fit.resourcesVisible ? resources : 0);
  let over = spent - budget;
  if (over <= 0) return { sidebar, resources };

  if (fit.resourcesVisible) {
    const give = Math.min(over, resources - CHAT_PANEL_RANGES.resources.min);
    resources -= give;
    over -= give;
  }
  if (over > 0 && fit.sidebarVisible) {
    const give = Math.min(over, sidebar - CHAT_PANEL_RANGES.sidebar.min);
    sidebar -= give;
  }
  return { sidebar, resources };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function defaultChatPanelWidths(): ChatPanelWidths {
  return { sidebar: CHAT_PANEL_RANGES.sidebar.def, resources: CHAT_PANEL_RANGES.resources.def };
}

/** Parse either this module's payload or the legacy shell payload. */
export function parseChatPanelWidths(raw: string | null): ChatPanelWidths | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // `sidebarWidth`/`resourcesWidth` is the legacy shell spelling.
  const sidebar = record.sidebar ?? record.sidebarWidth;
  const resources = record.resources ?? record.resourcesWidth;
  if (sidebar === undefined && resources === undefined) return null;
  return {
    sidebar: clampPanelWidth('sidebar', sidebar),
    resources: clampPanelWidth('resources', resources),
  };
}

export function readChatPanelWidths(): ChatPanelWidths {
  try {
    const own = parseChatPanelWidths(localStorage.getItem(CHAT_PANEL_SIZING_KEY));
    if (own) return own;
    // First run after the upgrade: inherit whatever the shell store had.
    return parseChatPanelWidths(localStorage.getItem(LEGACY_SHELL_KEY)) ?? defaultChatPanelWidths();
  } catch {
    return defaultChatPanelWidths();
  }
}

export function writeChatPanelWidths(widths: ChatPanelWidths): void {
  try {
    localStorage.setItem(CHAT_PANEL_SIZING_KEY, JSON.stringify({
      sidebar: widths.sidebar,
      resources: widths.resources,
    }));
  } catch {
    /* a private window without storage still runs the app */
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let desired: ChatPanelWidths = readChatPanelWidths();
let fit: ChatPanelFit = UNKNOWN_FIT;
let snapshot: ChatPanelSizing = { desired, effective: fitChatPanels(desired, fit) };
const listeners = new Set<() => void>();

function sameWidths(a: ChatPanelWidths, b: ChatPanelWidths): boolean {
  return a.sidebar === b.sidebar && a.resources === b.resources;
}

/** Snapshot identity changes only when a number actually changed. */
function publish(): void {
  const effective = fitChatPanels(desired, fit);
  if (sameWidths(snapshot.desired, desired) && sameWidths(snapshot.effective, effective)) return;
  snapshot = { desired, effective };
  for (const listener of listeners) listener();
}

export function subscribeChatPanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatPanelSizing(): ChatPanelSizing {
  return snapshot;
}

/**
 * Publish what the layout can afford. Called on mount, on window resize and
 * whenever a panel is shown or hidden. Deliberately does NOT persist: a
 * narrow window borrows width, it does not take it.
 */
export function setChatPanelFit(next: ChatPanelFit): void {
  if (
    fit.containerWidth === next.containerWidth
    && fit.sidebarVisible === next.sidebarVisible
    && fit.resourcesVisible === next.resourcesVisible
  ) return;
  fit = next;
  publish();
}

function commit(next: ChatPanelWidths): void {
  if (sameWidths(desired, next)) return;
  desired = next;
  writeChatPanelWidths(desired);
  publish();
}

/** A drag or a direct set. Range-clamped; the fit is applied on read. */
export function setChatPanelWidth(side: ChatPanelSide, value: number): void {
  commit({ ...desired, [side]: clampPanelWidth(side, value) });
}

/**
 * An arrow key. Steps from the EFFECTIVE width, so a keypress moves the
 * handle the operator can see rather than an off-screen remembered one.
 */
export function nudgeChatPanelWidth(side: ChatPanelSide, delta: number): void {
  setChatPanelWidth(side, snapshot.effective[side] + delta);
}

/** Double-click, and the Home/End extremes. */
export function resetChatPanelWidth(side: ChatPanelSide): void {
  setChatPanelWidth(side, CHAT_PANEL_RANGES[side].def);
}

/** Test hygiene — mirrors resetVerseUi(). */
export function resetChatPanelSizing(): void {
  desired = defaultChatPanelWidths();
  fit = UNKNOWN_FIT;
  snapshot = { desired, effective: fitChatPanels(desired, fit) };
  try {
    localStorage.removeItem(CHAT_PANEL_SIZING_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

/** Re-read storage into the store (a fresh tab, or a test that seeded a key). */
export function reloadChatPanelSizing(): void {
  desired = readChatPanelWidths();
  snapshot = { desired, effective: fitChatPanels(desired, fit) };
  for (const listener of listeners) listener();
}
