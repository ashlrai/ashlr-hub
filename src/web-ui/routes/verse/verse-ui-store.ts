/**
 * routes/verse/verse-ui-store.ts — the shell's own state: which of the
 * rail sections is mounted, the chat sidebar's width / collapsed flag, and
 * the resources panel. Framework-free (one `useSyncExternalStore` hook at
 * the bottom), same split as verse-store.ts + useVerseSession.ts.
 *
 * Persisted under `ashlr.verse.ui.v2` (VERSE-CONTRACT-V2 "Shell contract").
 * Two fields are deliberately NOT persisted:
 *
 *   - `pendingApprovals` — evidence, not preference. The Approvals rail item
 *     shows its dot from whatever the Approvals/Autonomy section last
 *     published via `setVersePendingApprovals`; a stale count restored from
 *     localStorage would claim work is waiting when it is not.
 *   - `command` — the ⌘N / ⌘K hand-off. The rail owns the global shortcuts,
 *     but the section that can act on them is lazily mounted and takes no
 *     props (contract), so the shell raises a one-shot command here and the
 *     section consumes it by nonce.
 */

/*
 * NOT HERE: the APPEARANCE preferences — theme, accent, display size,
 * density, radius, motion. This store holds the shell's LAYOUT state (which
 * section is mounted, how wide the panes are); design-system preferences
 * belong to data/appearance-store.ts, which is the single owner of the
 * attributes and custom properties on <html>. Adding the display size here
 * would have meant two stores writing the root element, which is the exact
 * race the appearance store's header exists to warn about.
 */

export type VerseSectionId = 'chat' | 'autonomy' | 'approvals' | 'usage' | 'settings' | 'mcp';

/**
 * Rail order is the ⌘1–⌘n order, and `module` is the file the shell's
 * `import.meta.glob('./sections/*Section.tsx')` must find. Both halves matter:
 * a section missing from this list is unreachable however complete it is, and
 * a `module` that does not resolve renders `MissingSection` instead. MCP sat
 * outside both for a whole release — see VerseApp.test.tsx, which mounts every
 * entry here and fails if any of them falls back to the missing state.
 *
 * MCP is APPENDED rather than slotted in before Settings on purpose: the first
 * five bindings are shipped muscle memory (⌘5 has meant Settings since v2), so
 * the new section extends the scheme at ⌘6 instead of renumbering it.
 */
export const VERSE_SECTIONS: readonly { id: VerseSectionId; label: string; module: string }[] = [
  { id: 'chat', label: 'Chat', module: 'ChatSection' },
  { id: 'autonomy', label: 'Autonomy', module: 'AutonomySection' },
  { id: 'approvals', label: 'Approvals', module: 'ApprovalsSection' },
  { id: 'usage', label: 'Usage', module: 'UsageSection' },
  { id: 'settings', label: 'Settings', module: 'SettingsSection' },
  { id: 'mcp', label: 'MCP', module: 'McpSection' },
];

const SECTION_IDS = new Set<string>(VERSE_SECTIONS.map((s) => s.id));

/** One-shot shell → section requests. */
export type VerseCommandName = 'new-chat' | 'quick-switcher';

export interface VerseCommand {
  name: VerseCommandName;
  /** Monotonic; a section reacts when it sees a nonce it has not handled. */
  nonce: number;
}

export interface VerseUiState {
  section: VerseSectionId;
  /**
   * The rail shows labels beside its icons rather than icons alone.
   *
   * Persisted with the other layout preferences, and DEFAULTS TO COLLAPSED: a
   * returning operator keeps the 56px rail they already have muscle memory
   * for, and only a deliberate toggle widens it. Collapsed is also the state
   * the desktop traffic-light maths was written against — see the
   * `--rail-width` override in VerseApp.module.css for how the widened rail
   * keeps every dependent `calc()` honest.
   */
  railExpanded: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  resourcesOpen: boolean;
  resourcesWidth: number;
  pendingApprovals: number;
  command: VerseCommand | null;
}

export const VERSE_SIDEBAR = { min: 240, max: 360, def: 264 } as const;
export const VERSE_RESOURCES = { min: 260, max: 480, def: 320 } as const;

const STORAGE_KEY = 'ashlr.verse.ui.v2';

const DEFAULTS: VerseUiState = {
  section: 'chat',
  railExpanded: false,
  sidebarWidth: VERSE_SIDEBAR.def,
  sidebarCollapsed: false,
  resourcesOpen: true,
  resourcesWidth: VERSE_RESOURCES.def,
  pendingApprovals: 0,
  command: null,
};

export function clampWidth(value: unknown, range: { min: number; max: number; def: number }): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return range.def;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

/** Persisted subset. `pendingApprovals`/`command` never round-trip. */
type Persisted = Pick<
  VerseUiState,
  'section' | 'railExpanded' | 'sidebarWidth' | 'sidebarCollapsed' | 'resourcesOpen' | 'resourcesWidth'
>;

function read(): VerseUiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      ...DEFAULTS,
      section: typeof parsed.section === 'string' && SECTION_IDS.has(parsed.section) ? (parsed.section as VerseSectionId) : DEFAULTS.section,
      railExpanded: parsed.railExpanded === true,
      sidebarWidth: clampWidth(parsed.sidebarWidth, VERSE_SIDEBAR),
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      resourcesOpen: parsed.resourcesOpen !== false,
      resourcesWidth: clampWidth(parsed.resourcesWidth, VERSE_RESOURCES),
    };
  } catch {
    return DEFAULTS;
  }
}

let state: VerseUiState = read();
let nonce = 0;
const listeners = new Set<() => void>();

function persist(next: VerseUiState): void {
  const payload: Persisted = {
    section: next.section,
    railExpanded: next.railExpanded,
    sidebarWidth: next.sidebarWidth,
    sidebarCollapsed: next.sidebarCollapsed,
    resourcesOpen: next.resourcesOpen,
    resourcesWidth: next.resourcesWidth,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* best-effort: a private window without storage still runs the app */
  }
}

/** Snapshot identity only changes when something actually changed. */
function patch(delta: Partial<VerseUiState>): void {
  const next = { ...state, ...delta };
  if ((Object.keys(delta) as (keyof VerseUiState)[]).every((k) => Object.is(state[k], next[k]))) return;
  const shouldPersist = (['section', 'railExpanded', 'sidebarWidth', 'sidebarCollapsed', 'resourcesOpen', 'resourcesWidth'] as const)
    .some((k) => !Object.is(state[k], next[k]));
  state = next;
  if (shouldPersist) persist(next);
  for (const l of listeners) l();
}

export function subscribeVerseUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVerseUiState(): VerseUiState {
  return state;
}

export function setVerseSection(section: VerseSectionId): void {
  patch({ section });
}

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

/**
 * Published by whichever section knows the real number (Approvals reads
 * `GET /api/inbox`, Autonomy reads `VerseControlSnapshot.pendingCount`).
 * Unknown stays 0 — the rail shows no dot rather than inventing one.
 */
export function setVersePendingApprovals(count: number): void {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  patch({ pendingApprovals: n });
}

/** ⌘N / ⌘K: switch to Chat and hand the section a one-shot request. */
export function requestVerseCommand(name: VerseCommandName): void {
  nonce += 1;
  patch({ section: 'chat', command: { name, nonce } });
}

export function clearVerseCommand(): void {
  patch({ command: null });
}

/** Test hygiene. */
export function resetVerseUi(): void {
  state = DEFAULTS;
  nonce = 0;
  seatMemory = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SEAT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export const VERSE_UI_STORAGE_KEY = STORAGE_KEY;

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
 * NOT part of `VerseUiState`. This is a per-project memory, not shell state:
 * nothing re-renders when it changes, `VERSE-CONTRACT-V2` pins the shape
 * stored under `ashlr.verse.ui.v2`, and a map that grows with the project list
 * has no business in a snapshot compared by identity on every render.
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
