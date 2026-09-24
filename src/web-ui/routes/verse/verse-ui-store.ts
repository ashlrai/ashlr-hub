/**
 * routes/verse/verse-ui-store.ts — the workbench shell's own state (unit C1):
 * which surface is on screen and which stay mounted behind it, the overlays
 * (⌘K palette, ⌘J Needs you, ⌘/ shortcuts), back/forward history, recent
 * chats, and the layout preferences the chat reads. Framework-free (one
 * `useSyncExternalStore` hook in useVerseUi.ts), same split as verse-store.ts.
 *
 * PERSISTED under `ashlr.verse.ui.v3` — ONE blob with ONE writer (this
 * module). The dock's state is its `dock` field, owned by C2's dock-store and
 * folded in here on every change (dock-catalog.ts: two writers must never
 * race for the key).
 *
 * v2 → v3 MIGRATION (SPEC-310C §0.1). 3.10 renumbered the rail: ⌘1 Command …
 * ⌘5 Chat, with Settings / Apps / Usage in the gear tray. A saved v2 section
 * migrates through workbench-types `migrateSectionId`: autonomy → fleet,
 * approvals → Command WITH the Needs-you drawer open, mcp → apps. The v2 key
 * is left in place (a downgrade still finds its own state) and is never read
 * again once v3 exists.
 *
 * LAUNCH RULE. The first launch each local day opens Command — the overnight
 * digest is the point of opening the app in the morning. Later launches
 * return to the last surface. A surface whose module has not landed yet is
 * never forced (the rule falls through to the saved section).
 *
 * NOT PERSISTED, on purpose: the overlays, `command` (a one-shot hand-off to
 * the chat), history, the keep-alive list and `activeSessionId` — all
 * evidence about this page's life, not preferences.
 *
 * NOT HERE: appearance (theme, accent, density — data/appearance-store.ts owns
 * <html>), the reasoning display (chat/reasoning-pref.ts, C2), chat panel
 * widths (chat-panel-sizing.ts, C2), and the desktop preferences (system-wide
 * hotkey, notifications) — the desktop app stores those itself
 * (desktop_prefs.rs) and reports what actually took effect (a chord another
 * app holds comes back unregistered), so a copy here could only disagree
 * with it. Settings ▸ Desktop reads app/desktop-shell.ts useDesktopState().
 */
import {
  migrateSectionId,
  NEEDS_YOU_CATEGORIES,
  type NeedsYouCategory,
  type WorkbenchSectionId,
} from '../../../core/verse/workbench-types.js';
import { getDockState, subscribeDockState } from './dock/dock-store.js';
import { VERSE_UI_STORAGE_KEY as V3_KEY, VERSE_UI_STORAGE_KEY_V2 as V2_KEY } from './shell/dock-catalog.js';
import {
  cycleRecent,
  pushNav,
  stepNav,
  touchRecent,
  RECENT_CHATS_LIMIT,
  type NavHistory,
  type RecentCycle,
} from './shell/nav-history.js';
import { sectionImporter } from './shell/section-modules.js';

// ===========================================================================
// Sections
// ===========================================================================

export type VerseSectionId = WorkbenchSectionId;

export interface VerseSectionEntry {
  id: VerseSectionId;
  label: string;
  /** The file `sections/<module>.tsx` the shell mounts (and first paint preloads). */
  module: string;
  /**
   * Modules to mount while `module` has not landed: Fleet shows the legacy
   * Autonomy panels until C7's FleetSection arrives. Never a guess at a
   * different surface. (Apps no longer falls back to MCP: C6's AppsSection
   * folds MCP in, and a stale MCP page under the "Apps & Accounts" name would
   * hide the seats and agents the operator went there for.)
   */
  fallbackModules?: readonly string[];
  /** Rail (⌘1–⌘5) or gear tray. */
  placement: 'rail' | 'tray';
  /** One line for the onboarding tour and the palette. */
  blurb: string;
}

/**
 * Rail order IS the ⌘1–⌘5 order (SPEC-310B §6); tray entries follow. A
 * section missing from this list is unreachable however complete it is.
 */
export const VERSE_SECTIONS: readonly VerseSectionEntry[] = [
  { id: 'command', label: 'Command', module: 'CommandSection', placement: 'rail', blurb: 'What the fleet did, what needs you, and the autonomy switch — the morning read.' },
  { id: 'fleet', label: 'Fleet', module: 'FleetSection', fallbackModules: ['AutonomySection'], placement: 'rail', blurb: 'Every lane live: what is building, what the gates refused, and why each seat was chosen.' },
  { id: 'growth', label: 'Growth', module: 'GrowthSection', placement: 'rail', blurb: 'Is the fleet getting better? Merges, cost per merge and the experiments behind them.' },
  { id: 'mind', label: 'Mind', module: 'MindSection', placement: 'rail', blurb: "The Leader's memos, what came of each move, and what the reasoning shows." },
  { id: 'chat', label: 'Chat', module: 'ChatSection', placement: 'rail', blurb: 'Talk to a seat. Chats are grouped by project and resume where they stopped.' },
  { id: 'settings', label: 'Settings', module: 'SettingsSection', placement: 'tray', blurb: 'Theme, chat, desktop and keyboard — and this tour again.' },
  { id: 'apps', label: 'Apps & Accounts', module: 'AppsSection', placement: 'tray', blurb: 'Seats, terminal agents, local models and MCP servers in one list.' },
  { id: 'usage', label: 'Usage', module: 'UsageSection', placement: 'tray', blurb: 'Which account you can actually use right now, and what it costs.' },
];

export const RAIL_SECTIONS: readonly VerseSectionEntry[] = VERSE_SECTIONS.filter((s) => s.placement === 'rail');
export const TRAY_SECTIONS: readonly VerseSectionEntry[] = VERSE_SECTIONS.filter((s) => s.placement === 'tray');

const SECTION_IDS = new Set<string>(VERSE_SECTIONS.map((s) => s.id));

export function sectionEntry(id: VerseSectionId): VerseSectionEntry {
  return VERSE_SECTIONS.find((s) => s.id === id)!;
}

/** The module that will actually mount for `id` (primary first, then fallbacks); null when none landed. */
export function landedModule(id: VerseSectionId, landed: (module: string) => boolean = (m) => sectionImporter(m) !== undefined): string | null {
  const entry = sectionEntry(id);
  for (const module of [entry.module, ...(entry.fallbackModules ?? [])]) if (landed(module)) return module;
  return null;
}

// ===========================================================================
// State
// ===========================================================================

/**
 * One-shot shell → chat requests. The chat surface is lazily mounted and takes
 * no props, so the shell raises a command here and the chat consumes it by
 * nonce, then clears it.
 *   new-chat        ⌘N / "New chat on…" — optional seat or project prefill
 *   quick-switcher  (pre-3.10; kept until C2 retires QuickSwitcher)
 *   open-session    the palette, the drawer, ⌘[ ⌘], ⌃Tab, a notification
 *   focus-composer  the system-wide hotkey (⌃⌥Space)
 */
export type VerseCommandName = 'new-chat' | 'quick-switcher' | 'open-session' | 'focus-composer';

export interface VerseCommand {
  name: VerseCommandName;
  /** Monotonic; a section reacts when it sees a nonce it has not handled. */
  nonce: number;
  sessionId?: string;
  seatId?: string;
  projectPath?: string;
}

export type VerseCommandArgs = Pick<VerseCommand, 'sessionId' | 'seatId' | 'projectPath'>;

export type VerseOverlay = 'palette' | 'needs-you' | 'shortcuts' | null;
export type NeedsYouSplit = 'all' | NeedsYouCategory;
export const NEEDS_YOU_SPLITS: readonly NeedsYouSplit[] = ['all', ...NEEDS_YOU_CATEGORIES];

export interface VerseUiState {
  section: VerseSectionId;
  /** Rail shows labels beside its icons (⌘⇧\). Defaults collapsed: the 56px rail is shipped muscle memory. */
  railExpanded: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  resourcesOpen: boolean;
  resourcesWidth: number;
  /** The last this-many palette actions run (empty query shows them). */
  recentActions: readonly string[];
  /** Most-recently-used chats, current first (⌃Tab). */
  recentChats: readonly string[];
  // ── not persisted ──
  /** Surfaces kept mounted (hidden + inert) behind the current one, most recent first. */
  mounted: readonly VerseSectionId[];
  overlay: VerseOverlay;
  needsYouSplit: NeedsYouSplit;
  /** An item the drawer should select when it opens (from the palette or a notification). */
  needsYouFocus: string | null;
  history: NavHistory;
  /** The chat open in the Chat surface, as reported by the chat (or by the shell when it opened one). */
  activeSessionId: string | null;
  command: VerseCommand | null;
  /** Set when a v2 blob was migrated this load: the shell announces "Chat moved to ⌘5" once. */
  announceChatMoved: boolean;
}

export const VERSE_SIDEBAR = { min: 240, max: 360, def: 264 } as const;
export const VERSE_RESOURCES = { min: 260, max: 480, def: 320 } as const;
/** Surfaces kept alive besides Chat (which, once visited, always stays). */
export const KEEP_ALIVE_SURFACES = 3;
export const RECENT_ACTIONS_LIMIT = 5;

export const VERSE_UI_STORAGE_KEY = V3_KEY;
export const VERSE_UI_STORAGE_KEY_V2 = V2_KEY;

const DEFAULTS: VerseUiState = {
  section: 'chat',
  railExpanded: false,
  sidebarWidth: VERSE_SIDEBAR.def,
  sidebarCollapsed: false,
  resourcesOpen: true,
  resourcesWidth: VERSE_RESOURCES.def,
  recentActions: [],
  recentChats: [],
  mounted: ['chat'],
  overlay: null,
  needsYouSplit: 'all',
  needsYouFocus: null,
  history: { entries: [{ section: 'chat', sessionId: null }], index: 0 },
  activeSessionId: null,
  command: null,
  announceChatMoved: false,
};

export function clampWidth(value: unknown, range: { min: number; max: number; def: number }): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return range.def;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

/** Local calendar day, `YYYY-MM-DD` — "first launch each day" is the operator's day, not UTC's. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface PersistedV3 {
  version: 3;
  section: VerseSectionId;
  railExpanded: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  resourcesOpen: boolean;
  resourcesWidth: number;
  recentActions: string[];
  recentChats: string[];
  lastLaunchDay: string | null;
  chatMovedAnnounced: boolean;
  dock: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, limit: number, re: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && re.test(v) && !out.includes(v)) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Bookkeeping that is persisted but is not UI state. */
let lastLaunchDay: string | null = null;
let chatMovedAnnounced = false;

export interface LoadOptions {
  now?: number;
  /** Has this module landed? (Injected by tests; the build's glob otherwise.) */
  landed?: (module: string) => boolean;
}

/**
 * Read v3, else migrate v2, else defaults — then apply the launch rule.
 * Total: a hand-edited or future blob falls back field by field.
 */
export function loadVerseUi(options: LoadOptions = {}): VerseUiState {
  const now = options.now ?? Date.now();
  const landed = options.landed ?? ((m: string) => sectionImporter(m) !== undefined);
  const v3 = readJson(V3_KEY);
  const v2 = v3 ? null : readJson(V2_KEY);
  const src = v3 ?? v2 ?? {};

  let section: VerseSectionId = DEFAULTS.section;
  let overlay: VerseOverlay = null;
  const migration = migrateSectionId(src['section']);
  if (migration && SECTION_IDS.has(migration.section)) {
    section = migration.section;
    if (migration.openNeedsYou && !v3) overlay = 'needs-you';
  }

  lastLaunchDay = v3 && typeof v3['lastLaunchDay'] === 'string' ? v3['lastLaunchDay'] : null;
  chatMovedAnnounced = v3 ? v3['chatMovedAnnounced'] === true : false;

  const today = localDay(now);
  // First launch of the day → Command, when Command exists in this build.
  if (lastLaunchDay !== today && landedModule('command', landed) !== null) section = 'command';
  lastLaunchDay = today;

  const state: VerseUiState = {
    ...DEFAULTS,
    section,
    railExpanded: src['railExpanded'] === true,
    sidebarWidth: clampWidth(src['sidebarWidth'], VERSE_SIDEBAR),
    sidebarCollapsed: src['sidebarCollapsed'] === true,
    resourcesOpen: src['resourcesOpen'] !== false,
    resourcesWidth: clampWidth(src['resourcesWidth'], VERSE_RESOURCES),
    recentActions: stringList(src['recentActions'], RECENT_ACTIONS_LIMIT, /^[a-z][a-z0-9.-]{0,63}$/),
    recentChats: stringList(src['recentChats'], RECENT_CHATS_LIMIT, /^[\w.-]{1,200}$/),
    mounted: [section],
    overlay,
    history: { entries: [{ section, sessionId: null }], index: 0 },
    // A v2 blob means this operator had ⌘1 = Chat in their hands yesterday.
    announceChatMoved: v2 !== null && !chatMovedAnnounced,
  };
  return state;
}

let state: VerseUiState = DEFAULTS;
let nonce = 0;
let recentCycle: RecentCycle | null = null;
const listeners = new Set<() => void>();

function persist(next: VerseUiState): void {
  const payload: PersistedV3 = {
    version: 3,
    section: next.section,
    railExpanded: next.railExpanded,
    sidebarWidth: next.sidebarWidth,
    sidebarCollapsed: next.sidebarCollapsed,
    resourcesOpen: next.resourcesOpen,
    resourcesWidth: next.resourcesWidth,
    recentActions: [...next.recentActions],
    recentChats: [...next.recentChats],
    lastLaunchDay,
    chatMovedAnnounced,
    dock: getDockState(),
  };
  try {
    localStorage.setItem(V3_KEY, JSON.stringify(payload));
  } catch {
    /* best-effort: a private window without storage still runs the app */
  }
}

const PERSISTED_FIELDS = [
  'section',
  'railExpanded',
  'sidebarWidth',
  'sidebarCollapsed',
  'resourcesOpen',
  'resourcesWidth',
  'recentActions',
  'recentChats',
] as const satisfies readonly (keyof VerseUiState)[];

/** Snapshot identity only changes when something actually changed. */
function patch(delta: Partial<VerseUiState>): void {
  const next = { ...state, ...delta };
  if ((Object.keys(delta) as (keyof VerseUiState)[]).every((k) => Object.is(state[k], next[k]))) return;
  const shouldPersist = PERSISTED_FIELDS.some((k) => !Object.is(state[k], next[k]));
  state = next;
  if (shouldPersist) persist(next);
  for (const l of [...listeners]) l();
}

function init(): void {
  state = loadVerseUi();
  // Write the migrated / launch-ruled state straight away, so the day's first
  // launch is recorded even if the operator closes the app without a click.
  persist(state);
}

init();

// C2's dock changes are folded into the blob as they happen.
let lastDockJson = '';
subscribeDockState(() => {
  let json = '';
  try { json = JSON.stringify(getDockState()); } catch { json = ''; }
  if (json === lastDockJson) return;
  lastDockJson = json;
  persist(state);
});

export function subscribeVerseUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVerseUiState(): VerseUiState {
  return state;
}

// ===========================================================================
// Navigation
// ===========================================================================

function withMounted(mounted: readonly VerseSectionId[], section: VerseSectionId): VerseSectionId[] {
  // The last KEEP_ALIVE_SURFACES surfaces other than Chat, most recent first…
  const chatVisited = section === 'chat' || mounted.includes('chat');
  const others = mounted.filter((id) => id !== 'chat' && id !== section);
  const nonChat = (section === 'chat' ? others : [section, ...others]).slice(0, KEEP_ALIVE_SURFACES);
  const alive: VerseSectionId[] = section === 'chat' ? ['chat', ...nonChat] : nonChat;
  // …and Chat, once visited, always: its streams, scroll and draft are the
  // most expensive state in the app to rebuild.
  if (chatVisited && !alive.includes('chat')) alive.push('chat');
  return alive;
}

function go(section: VerseSectionId, options: { history: boolean }): void {
  if (!SECTION_IDS.has(section)) return;
  const history = options.history
    ? pushNav(state.history, { section, sessionId: section === 'chat' ? state.activeSessionId : null })
    : state.history;
  patch({ section, mounted: withMounted(state.mounted, section), history });
}

/** The window event that asks the shell to reveal an anchor on a surface (shell/reveal-anchor.ts). */
export const VERSE_ANCHOR_EVENT = 'ashlr:verse-anchor';

export interface VerseAnchorRequest {
  section: VerseSectionId;
  /** A surface's own anchor key ("memo:m-7", "seat:claude-a"); the element carries `c7-anchor-<key>` or `data-verse-anchor`. */
  anchor: string;
}

/**
 * Switch surface; with `anchor`, also ask the shell to scroll that card or
 * row into view once the surface has painted. The anchor travels as a window
 * event rather than store state because it is a one-shot gesture about DOM
 * that may not exist yet (a lazy chunk), and every unit that owns a surface
 * can dispatch the same event without importing the shell.
 */
export function setVerseSection(section: VerseSectionId, anchor: string | null = null): void {
  go(section, { history: true });
  if (!anchor || typeof window === 'undefined') return;
  const detail: VerseAnchorRequest = { section, anchor };
  window.dispatchEvent(new CustomEvent(VERSE_ANCHOR_EVENT, { detail }));
}

/** ⌘[ / ⌘]. Returns false when there is nowhere to go. */
export function stepVerseHistory(delta: -1 | 1): boolean {
  const step = stepNav(state.history, delta);
  if (!step) return false;
  patch({ history: step.history });
  go(step.entry.section, { history: false });
  const target = step.entry.sessionId;
  if (step.entry.section === 'chat' && target && target !== state.activeSessionId) {
    raise('open-session', { sessionId: target }, false);
    // Set directly, NOT through setVerseActiveSession: that would push a new
    // history entry and drop the forward stack this step just walked.
    patch({ activeSessionId: target, recentChats: touchRecent(state.recentChats, target) });
  }
  return true;
}

/**
 * The chat reports which chat is open (C2: call on every selection). Feeds
 * back/forward, ⌃Tab's recent list, and the drawer's "you are looking at it".
 */
export function setVerseActiveSession(sessionId: string | null): void {
  if (sessionId === state.activeSessionId) return;
  const recentChats = sessionId ? touchRecent(state.recentChats, sessionId) : state.recentChats;
  const history = sessionId && state.section === 'chat' ? pushNav(state.history, { section: 'chat', sessionId }) : state.history;
  patch({ activeSessionId: sessionId, recentChats, history });
}

/** ⌃Tab / ⌃⇧Tab. Returns the chat opened, or null when there is no other recent chat. */
export function cycleVerseRecentChat(direction: 1 | -1, now: number = Date.now()): string | null {
  const recent = state.activeSessionId ? touchRecent(state.recentChats, state.activeSessionId) : [...state.recentChats];
  const step = cycleRecent(recent, recentCycle, direction, now);
  if (!step) return null;
  recentCycle = step.cycle;
  openVerseSession(step.sessionId);
  return step.sessionId;
}

// ===========================================================================
// Chat hand-off
// ===========================================================================

/** The chat's own selection key (ChatSection, C2) — see openVerseSession. */
const CHAT_SELECTED_KEY = 'ashlr.verse.selected.v1';

function raise(name: VerseCommandName, args: VerseCommandArgs, switchTo: boolean): void {
  nonce += 1;
  const command: VerseCommand = { name, nonce, ...args };
  if (switchTo && state.section !== 'chat') {
    go('chat', { history: true });
  }
  patch({ command });
}

/** ⌘N, "New chat on…", the palette's chat actions: switch to Chat and hand it a one-shot request. */
export function requestVerseCommand(name: VerseCommandName, args: VerseCommandArgs = {}): void {
  raise(name, args, true);
}

/**
 * Open a chat by id from anywhere (palette, drawer, a notification, ⌃Tab).
 * Raises `open-session` for a mounted chat surface; when Chat is not mounted
 * yet it also writes the chat's own selection key, so the surface opens on
 * that chat when it mounts (the command then confirms it).
 */
export function openVerseSession(sessionId: string): void {
  if (!/^[\w.-]{1,200}$/.test(sessionId)) return;
  if (!state.mounted.includes('chat')) {
    try { localStorage.setItem(CHAT_SELECTED_KEY, sessionId); } catch { /* the command still carries it */ }
  }
  raise('open-session', { sessionId }, true);
  setVerseActiveSession(sessionId);
}

export function clearVerseCommand(): void {
  patch({ command: null });
}

// ===========================================================================
// Overlays
// ===========================================================================

export function openVerseOverlay(overlay: Exclude<VerseOverlay, null>): void {
  patch({ overlay });
}

export function closeVerseOverlay(): void {
  patch({ overlay: null, needsYouFocus: null });
}

export function toggleVerseOverlay(overlay: Exclude<VerseOverlay, null>): void {
  patch({ overlay: state.overlay === overlay ? null : overlay, needsYouFocus: null });
}

/** ⌘J — optionally on a split, optionally selecting one item. */
export function openVerseNeedsYou(options: { split?: NeedsYouSplit; focusId?: string | null } = {}): void {
  patch({
    overlay: 'needs-you',
    needsYouSplit: options.split ?? state.needsYouSplit,
    needsYouFocus: options.focusId ?? null,
  });
}

export function setVerseNeedsYouSplit(split: NeedsYouSplit): void {
  if (NEEDS_YOU_SPLITS.includes(split)) patch({ needsYouSplit: split });
}

// ===========================================================================
// Preferences
// ===========================================================================

export function setVerseRailExpanded(expanded: boolean): void {
  patch({ railExpanded: expanded });
}

export function toggleVerseRail(): void {
  patch({ railExpanded: !state.railExpanded });
}

export function setVerseSidebarWidth(width: number): void {
  patch({ sidebarWidth: clampWidth(width, VERSE_SIDEBAR) });
}

export function setVerseSidebarCollapsed(collapsed: boolean): void {
  patch({ sidebarCollapsed: collapsed });
}

export function toggleVerseSidebar(): void {
  patch({ sidebarCollapsed: !state.sidebarCollapsed });
}

export function setVerseResourcesOpen(open: boolean): void {
  patch({ resourcesOpen: open });
}

export function setVerseResourcesWidth(width: number): void {
  patch({ resourcesWidth: clampWidth(width, VERSE_RESOURCES) });
}

/** The palette ran a catalog action: remember it for the empty-query list. */
export function recordVerseAction(commandId: string): void {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(commandId)) return;
  patch({ recentActions: [commandId, ...state.recentActions.filter((id) => id !== commandId)].slice(0, RECENT_ACTIONS_LIMIT) });
}

/** The "Chat moved to ⌘5" toast was shown: never again. */
export function acknowledgeChatMoved(): void {
  chatMovedAnnounced = true;
  if (state.announceChatMoved) patch({ announceChatMoved: false });
  persist(state);
}

// ===========================================================================
// Test hygiene
// ===========================================================================

/** Back to defaults, storage cleared. Does NOT re-run the launch rule. */
export function resetVerseUi(): void {
  state = DEFAULTS;
  nonce = 0;
  recentCycle = null;
  lastLaunchDay = null;
  chatMovedAnnounced = false;
  seatMemory = null;
  adviceDismissals.clear();
  try {
    localStorage.removeItem(V3_KEY);
    localStorage.removeItem(V2_KEY);
    localStorage.removeItem(SEAT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const l of [...listeners]) l();
}

/** Re-read storage as a fresh page load would (migration + launch rule). */
export function reloadVerseUiForTest(options: LoadOptions = {}): void {
  state = loadVerseUi(options);
  persist(state);
  for (const l of [...listeners]) l();
}

// ---------------------------------------------------------------------------
// Last-used seat, per project
// ---------------------------------------------------------------------------

/**
 * Which seat + model a project's last chat was started on.
 *
 * WHY THIS IS PERSISTED. A new chat is seat-bound at creation, and the two
 * ways to start one — the sidebar "+" and ⌘N — both carry the CURRENT
 * session's seat forward. That works right up until there is no current
 * session (first load, or after deleting the last chat), where both fall
 * through to `defaultSeatChoice()`, which walks ENGINE_ORDER and lands on
 * Claude: the scarcest and most expensive account, chosen by alphabet rather
 * than by intent. Remembering the last seat per project makes "New chat" mean
 * the same thing across a reload as it does within one.
 *
 * NOT part of `VerseUiState`: a per-project memory that grows with the
 * project list has no business in a snapshot compared by identity on every
 * render.
 */
export interface VerseSeatMemory {
  seatId: string;
  model: string;
}

const SEAT_STORAGE_KEY = 'ashlr.verse.seats.v1';
/** Bounded so a long-lived browser cannot accumulate an unbounded map. */
const SEAT_MEMORY_LIMIT = 50;

/** Lazily read, then held in memory; `null` means "not read yet". */
let seatMemory: Record<string, VerseSeatMemory> | null = null;

function readSeatMemory(): Record<string, VerseSeatMemory> {
  if (seatMemory) return seatMemory;
  const out: Record<string, VerseSeatMemory> = {};
  try {
    const raw = localStorage.getItem(SEAT_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const { seatId, model } = value as Record<string, unknown>;
        if (typeof seatId !== 'string' || seatId.length === 0) continue;
        if (typeof model !== 'string' || model.length === 0) continue;
        out[path] = { seatId, model };
      }
    }
  } catch {
    /* a private window without storage still runs the app */
  }
  seatMemory = out;
  return out;
}

/**
 * The seat a chat on `projectPath` was last started with, or the most recent
 * seat on any project when that project has no record yet — a brand-new
 * project inherits the operator's current working habit rather than resetting
 * to the default engine. Null only when nothing has ever been started.
 */
export function lastVerseSeat(projectPath?: string | null): VerseSeatMemory | null {
  const memory = readSeatMemory();
  if (projectPath) {
    const exact = memory[projectPath];
    if (exact) return exact;
  }
  // Insertion order is recency order: rememberVerseSeat re-inserts on write.
  const keys = Object.keys(memory);
  const newest = keys[keys.length - 1];
  return newest ? memory[newest] ?? null : null;
}

/** Record the seat a chat was just created with. Never throws. */
export function rememberVerseSeat(projectPath: string, seat: VerseSeatMemory): void {
  if (!projectPath || !seat.seatId || !seat.model) return;
  const memory = readSeatMemory();
  // Delete before re-inserting so key order stays newest-last.
  delete memory[projectPath];
  memory[projectPath] = { seatId: seat.seatId, model: seat.model };
  const keys = Object.keys(memory);
  for (const stale of keys.slice(0, Math.max(0, keys.length - SEAT_MEMORY_LIMIT))) {
    delete memory[stale];
  }
  try {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    /* best-effort */
  }
}

export const VERSE_SEAT_STORAGE_KEY = SEAT_STORAGE_KEY;

// ---------------------------------------------------------------------------
// Dismissed context advice, per session (NOT persisted)
// ---------------------------------------------------------------------------

/**
 * Which context-advice notes ("continue in a fresh chat", "expansive may
 * help") the operator waved off, per session.
 *
 * WHY IN MEMORY ONLY. Advice is evidence about the session as it is NOW: a
 * dismissal restored from storage after a reload would silence a note whose
 * evidence has since grown. Held here rather than in component state so that
 * switching surfaces and back does not bring back a note just dismissed.
 *
 * The key names the EVIDENCE (ContextAdvice composes it from the advice level
 * and the compaction count), so a note returns on its own when it escalates.
 */
const adviceDismissals = new Map<string, Set<string>>();
/** Bounded like the other per-session memories. */
const ADVICE_SESSION_LIMIT = 50;

export function dismissVerseAdvice(sessionId: string, key: string): void {
  if (!sessionId || !key) return;
  const set = adviceDismissals.get(sessionId) ?? new Set<string>();
  set.add(key);
  // Re-insert so Map order stays recency order, then trim the oldest.
  adviceDismissals.delete(sessionId);
  adviceDismissals.set(sessionId, set);
  for (const stale of [...adviceDismissals.keys()].slice(0, Math.max(0, adviceDismissals.size - ADVICE_SESSION_LIMIT))) {
    adviceDismissals.delete(stale);
  }
}

export function isVerseAdviceDismissed(sessionId: string, key: string): boolean {
  return adviceDismissals.get(sessionId)?.has(key) ?? false;
}
