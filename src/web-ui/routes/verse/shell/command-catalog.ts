/**
 * routes/verse/shell/command-catalog.ts — every workbench command and its
 * keys, in ONE table (unit C0; SPEC-310C §1).
 *
 * The ⌘K palette (C1), the shortcuts overlay (⌘/), the native menu bridge
 * (C8), the drawer and every surface's key handler read this table; the key
 * test reads it too, which is how "no two commands share a key" and "no key
 * the native menu already owns" stay true as units add commands. A key that
 * is not here does not exist.
 *
 * Pure data plus pure helpers — no React, no DOM beyond reading a
 * KeyboardEvent-shaped object — so the palette can import it without pulling
 * a surface into its chunk.
 *
 * Adding a command: one entry below (a change request to C0 when another
 * unit needs it). The handler lives with the unit that owns the behaviour and
 * dispatches on the command `id`.
 */

// ===========================================================================
// Scopes — where a key is live
// ===========================================================================

/**
 *   global    anywhere in the workbench (except inside the palette, which
 *             owns every key while open, and native text editing keys)
 *   chat      the Chat surface has focus (transcript, sidebar, dock)
 *   composer  the composer's text box has focus
 *   drawer    the Needs-you drawer list has focus (bare letters are safe
 *             there: nothing in it takes text)
 *   chart     a chart card has focus
 */
export const COMMAND_SCOPES = ['global', 'chat', 'composer', 'drawer', 'chart'] as const;
export type CommandScope = (typeof COMMAND_SCOPES)[number];

/**
 * The scopes live AT THE SAME TIME as each scope (itself included). A key
 * must be unique across every such set — the key test checks exactly this —
 * while two scopes that are never live together (the drawer's bare `Enter`
 * and the composer's) may reuse a key.
 */
export const SCOPE_LAYERS: Readonly<Record<CommandScope, readonly CommandScope[]>> = {
  global: ['global'],
  chat: ['chat', 'global'],
  composer: ['composer', 'chat', 'global'],
  drawer: ['drawer', 'global'],
  chart: ['chart', 'global'],
};

// ===========================================================================
// Keys
// ===========================================================================

/**
 * One key chord. `key` is the UNSHIFTED US-layout name: a lowercase letter or
 * digit, a punctuation character, or one of the named keys below. `mod` is ⌘
 * on macOS and Ctrl elsewhere ("CmdOrCtrl"); `ctrl` is the literal ⌃ key.
 */
export interface KeyChord {
  key: string;
  mod?: true;
  ctrl?: true;
  shift?: true;
  alt?: true;
}

export const NAMED_KEYS = ['enter', 'escape', 'tab', 'space', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace'] as const;

/**
 * Keys the page never binds, because macOS or the desktop shell answers them
 * first: the native menu's own accelerators live in app_menu.rs (the key test
 * parses that file), these are the system's.
 */
export const SYSTEM_RESERVED_CHORDS: readonly KeyChord[] = [
  { key: 'space', mod: true }, // Spotlight
  { key: 'space', ctrl: true }, // input sources
  { key: 'tab', mod: true }, // app switcher
  { key: 'tab', mod: true, shift: true },
  { key: '`', mod: true }, // cycle this app's windows
  { key: '3', mod: true, shift: true }, // screenshots
  { key: '4', mod: true, shift: true },
  { key: '5', mod: true, shift: true },
];

/**
 * How a key reaches the page when a native layer is involved.
 *   menu           the desktop menu owns the accelerator and forwards the
 *                  command (via `ashlr:desktop-command`); the page's own
 *                  handler only fires in a plain browser.
 *   global-hotkey  registered system-wide by the desktop app (C8); the page
 *                  never binds it — it is listed for the shortcuts overlay.
 */
export type NativeBinding =
  | { kind: 'menu'; desktopCommand: DesktopCommandName; accelerator: string }
  | { kind: 'global-hotkey'; accelerator: string };

// ===========================================================================
// The window event (units that are not on the command bus)
// ===========================================================================

/**
 * The window event the palette (C1) and the native menu bridge dispatch to
 * run a catalog command on a surface that listens for it instead of
 * registering on the command bus:
 *   window.dispatchEvent(new CustomEvent(WORKBENCH_COMMAND_EVENT, { detail: { id } }))
 * The composer (C3) answers the `composer.*` ids it implements.
 *
 * It lives HERE, beside the ids it carries, so the shell (run-command.ts)
 * does not have to import a composer module to name its own event —
 * composer/composer-keys.ts re-exports it for its existing importers.
 */
export const WORKBENCH_COMMAND_EVENT = 'ashlr:command';

// ===========================================================================
// Desktop commands (C8 → page)
// ===========================================================================

/**
 * What the desktop shell may send the page (`ashlr:desktop-command`), and the
 * catalog command each one runs. C8 dispatches these from the menu bar, the
 * tray, a clicked notification (focus regained within 60 s) and the global
 * hotkey; C1 runs them. `open-session:<id>` carries a session id.
 */
export const DESKTOP_COMMAND_NAMES = ['open-settings', 'toggle-theme', 'open-needs-you', 'new-chat', 'focus-composer'] as const;
// Its own literal list (not `keyof typeof DESKTOP_COMMANDS`): NativeBinding
// names it, WORKBENCH_COMMANDS uses NativeBinding, and DESKTOP_COMMANDS is
// typed by CommandId — deriving it from the map would make the types circular.
export type DesktopCommandName = (typeof DESKTOP_COMMAND_NAMES)[number];

export const DESKTOP_COMMANDS: Readonly<Record<DesktopCommandName, CommandId>> = {
  'open-settings': 'section.settings',
  'toggle-theme': 'appearance.toggle-theme',
  'open-needs-you': 'needs-you.open',
  'new-chat': 'chat.new',
  'focus-composer': 'app.summon',
};

/** `open-session:<id>` — the notification for a finished or failed chat. */
export const OPEN_SESSION_COMMAND_RE = /^open-session:([A-Za-z0-9._-]{1,128})$/;

export type ParsedDesktopCommand =
  | { kind: 'command'; name: DesktopCommandName; commandId: CommandId }
  | { kind: 'open-session'; sessionId: string };

/** Parse a raw desktop command string; null for anything unknown (never guessed). */
export function parseDesktopCommand(raw: unknown): ParsedDesktopCommand | null {
  if (typeof raw !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(DESKTOP_COMMANDS, raw)) {
    const name = raw as DesktopCommandName;
    return { kind: 'command', name, commandId: DESKTOP_COMMANDS[name] };
  }
  const session = OPEN_SESSION_COMMAND_RE.exec(raw);
  return session ? { kind: 'open-session', sessionId: session[1]! } : null;
}

// ===========================================================================
// The palette
// ===========================================================================

/** Result groups, in the order the palette shows them (SPEC-310C §1). */
export const PALETTE_GROUPS = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'chats', label: 'Chats' },
  { id: 'actions', label: 'Actions' },
  { id: 'go-to', label: 'Go to' },
  { id: 'seats-apps', label: 'Seats & Apps' },
  { id: 'projects', label: 'Projects' },
] as const;
export type PaletteGroupId = (typeof PALETTE_GROUPS)[number]['id'];

/** A leading `>` limits results to actions; `#` to chats. */
export const PALETTE_PREFIXES: Readonly<Record<'>' | '#', PaletteGroupId>> = { '>': 'actions', '#': 'chats' };

/** An empty query shows the last this-many actions run. */
export const PALETTE_RECENT_LIMIT = 5;

/** The palette opens in under this (it lives in the shell chunk). */
export const PALETTE_OPEN_BUDGET_MS = 50;

// ===========================================================================
// Commands
// ===========================================================================

export type CommandArgumentKind = 'seat' | 'project' | 'section' | 'session';

/**
 * A guarded command asks for confirmation FIRST, then the mutation token
 * (the palette must never be a shortcut around the confirm step its regular
 * UI requires).
 */
export interface CommandGuard {
  confirm: { title: string; body: string; confirmLabel: string; destructive: boolean };
  token: boolean;
}

/** Sections of the shortcuts overlay (⌘/), in display order. */
export const SHORTCUT_SECTIONS = ['Surfaces', 'Navigation', 'Chat', 'Dock', 'Composer', 'Needs you', 'Charts', 'App'] as const;
export type ShortcutSection = (typeof SHORTCUT_SECTIONS)[number];

export interface WorkbenchCommand {
  id: string;
  /** Palette / overlay text: a verb phrase, operator language. */
  title: string;
  scope: CommandScope;
  /** Empty = reachable from the palette (or a button) only. */
  keys: readonly KeyChord[];
  /** Where the palette lists it; null = not a palette entry (drawer and chart keys). */
  group: 'actions' | 'go-to' | null;
  section: ShortcutSection;
  keywords?: readonly string[];
  /** Tab fills this argument ("New chat on…" → a seat). */
  argument?: { kind: CommandArgumentKind; prompt: string };
  guard?: CommandGuard;
  native?: NativeBinding;
  /** A qualifier the overlay prints under the title. */
  note?: string;
  /**
   * The surface that serves it. The command's behaviour — and the dialogs it
   * may open (the Touch ID sheet, the token prompt) — live on that surface,
   * so the shell brings it forward and parks the command until the surface
   * registers its handler (run-command.ts). The palette says where it runs.
   */
  surface?: 'command';
}

const STOP_CHATS_GUARD: CommandGuard = {
  confirm: {
    title: 'Stop every running chat?',
    body: 'Each running turn is cancelled. Queued follow-ups are held, not sent.',
    confirmLabel: 'Stop chats',
    destructive: true,
  },
  token: true,
};

const STOP_FLEET_GUARD: CommandGuard = {
  confirm: {
    title: 'Stop the fleet?',
    body: 'Autonomous work halts within one tick and stays stopped until you resume it. Chats keep running.',
    confirmLabel: 'Stop fleet',
    destructive: true,
  },
  token: true,
};

/** Where the copy-setup command points: the one CLI step that turns autonomy on. */
export const AUTONOMY_SETUP_COMMAND = 'ashlr authority setup';

/**
 * A palette-only App action (no key) — shared shape of the autonomy, grant,
 * budget and setup entries below. The catalog is on the chat first-paint
 * path, so the repeated fields are written once.
 */
const appAction = (id: string, title: string, keywords: readonly string[], surface?: 'command'): WorkbenchCommand => ({
  id,
  title,
  scope: 'global',
  keys: [],
  group: 'actions',
  section: 'App',
  keywords,
  ...(surface ? { surface } : {}),
});

/**
 * The Command surface's autonomy switch, one palette entry per position.
 * Served by AutonomyBar with the switch's own rules: lowering is instant,
 * raising past the installed grant opens the Touch ID sheet instead.
 */
const autonomySwitch = (to: 'off' | 'propose' | 'autonomous', label: string, keywords: readonly string[]) =>
  appAction(`autonomy.${to}`, `Autonomy: ${label}`, ['autonomy', 'switch', ...keywords], 'command');

/** A9's budget mode, set from the palette — clamped to the grant's ceiling like the Budget pill. */
const budgetMode = (mode: 'all-in' | 'balanced' | 'reserve', label: string, keywords: readonly string[]) =>
  appAction(`budget.${mode}`, `Budget mode: ${label}`, ['budget', 'spend', ...keywords], 'command');

const surface = (n: 1 | 2 | 3 | 4 | 5, id: string, name: string): WorkbenchCommand => ({
  id: `surface.${id}`,
  title: `Go to ${name}`,
  scope: 'global',
  keys: [{ key: String(n), mod: true }],
  group: 'go-to',
  section: 'Surfaces',
  keywords: [name.toLowerCase()],
});

export const WORKBENCH_COMMANDS = [
  // ── Surfaces (⌘1 Command … ⌘5 Chat) and the gear tray ────────────────────
  surface(1, 'command', 'Command'),
  surface(2, 'fleet', 'Fleet'),
  surface(3, 'growth', 'Growth'),
  surface(4, 'mind', 'Mind'),
  surface(5, 'chat', 'Chat'),
  {
    id: 'section.settings',
    title: 'Open Settings',
    scope: 'global',
    keys: [{ key: ',', mod: true }],
    group: 'go-to',
    section: 'Surfaces',
    keywords: ['preferences', 'appearance'],
    native: { kind: 'menu', desktopCommand: 'open-settings', accelerator: 'CmdOrCtrl+,' },
  },
  { id: 'section.apps', title: 'Open Apps & Accounts', scope: 'global', keys: [], group: 'go-to', section: 'Surfaces', keywords: ['mcp', 'accounts', 'seats', 'integrations', 'ollama'] },
  { id: 'section.usage', title: 'Open Usage', scope: 'global', keys: [], group: 'go-to', section: 'Surfaces', keywords: ['capacity', 'spend', 'limits'] },

  // ── Navigation ───────────────────────────────────────────────────────────
  { id: 'palette.open', title: 'Command palette', scope: 'global', keys: [{ key: 'k', mod: true }], group: null, section: 'Navigation' },
  { id: 'needs-you.open', title: 'Open Needs you', scope: 'global', keys: [{ key: 'j', mod: true }], group: 'actions', section: 'Navigation', keywords: ['approvals', 'inbox', 'triage'] },
  { id: 'shortcuts.open', title: 'Keyboard shortcuts', scope: 'global', keys: [{ key: '/', mod: true }], group: 'actions', section: 'Navigation', keywords: ['keys', 'help'] },
  // The Resources drawer (3.11 C6): the key toggles it, the palette opens it.
  // ⌘. — not ⇧⌘R, which browsers keep for a hard reload.
  {
    id: 'resources.toggle',
    title: 'Open Resources',
    scope: 'global',
    keys: [{ key: '.', mod: true }],
    group: 'actions',
    section: 'Navigation',
    keywords: ['show resources', 'accounts', 'seats', 'capacity', 'credits', 'cloud', 'local models'],
  },
  {
    id: 'resources.bar.toggle',
    title: 'Show or hide the resource bar',
    scope: 'global',
    keys: [],
    group: 'actions',
    section: 'Navigation',
    keywords: ['battery', 'usage bars', 'accounts', 'capacity', 'rail', 'resources'],
  },
  { id: 'history.back', title: 'Back', scope: 'global', keys: [{ key: '[', mod: true }], group: null, section: 'Navigation', note: 'through surfaces and chats' },
  { id: 'history.forward', title: 'Forward', scope: 'global', keys: [{ key: ']', mod: true }], group: null, section: 'Navigation', note: 'through surfaces and chats' },
  { id: 'chat.recent-next', title: 'Next recent chat', scope: 'global', keys: [{ key: 'tab', ctrl: true }], group: null, section: 'Navigation' },
  { id: 'chat.recent-prev', title: 'Previous recent chat', scope: 'global', keys: [{ key: 'tab', ctrl: true, shift: true }], group: null, section: 'Navigation' },
  { id: 'rail.toggle-labels', title: 'Show or hide rail labels', scope: 'global', keys: [{ key: '\\', mod: true, shift: true }], group: 'actions', section: 'Navigation' },

  // ── Chats ────────────────────────────────────────────────────────────────
  { id: 'chat.new', title: 'New chat', scope: 'global', keys: [{ key: 'n', mod: true }], group: 'actions', section: 'Chat' },
  {
    id: 'chat.new-on',
    title: 'New chat on…',
    scope: 'global',
    keys: [],
    group: 'actions',
    section: 'Chat',
    argument: { kind: 'seat', prompt: 'Seat' },
    keywords: ['seat', 'account', 'engine'],
  },
  { id: 'chat.sidebar', title: 'Show or hide the chat list', scope: 'chat', keys: [{ key: 'b', mod: true }], group: 'actions', section: 'Chat' },
  { id: 'chat.find', title: 'Find in chat', scope: 'chat', keys: [{ key: 'f', mod: true }], group: 'actions', section: 'Chat', keywords: ['search'] },
  { id: 'chat.turn-prev', title: 'Previous turn', scope: 'chat', keys: [{ key: 'arrowup', alt: true }], group: null, section: 'Chat' },
  { id: 'chat.turn-next', title: 'Next turn', scope: 'chat', keys: [{ key: 'arrowdown', alt: true }], group: null, section: 'Chat' },
  { id: 'chats.stop-all', title: 'Stop running chats…', scope: 'global', keys: [], group: 'actions', section: 'Chat', guard: STOP_CHATS_GUARD, keywords: ['cancel', 'halt'] },
  // ── Git (C5's BranchBar serves these) ─────────────────────────────────────
  // Palette-only and unguarded ON PURPOSE: each OPENS BranchBar's own dialog
  // (CreatePrDialog / MergeDialog), which carries the before-click disclosure,
  // and every write inside it still goes through the mutation-token gate —
  // so the palette is never a shortcut around a confirm step. No key: a
  // merge is never one keystroke away. Chat-scoped because the bar lives
  // above the composer; from another surface the shell switches to Chat and
  // parks the command until BranchBar registers (command-bus).
  // ── Cloud (3.11 C3) ──────────────────────────────────────────────────────
  // Opens the composer's Chat settings sheet, where "Run in cloud" lives with
  // its own disabled reasons (no GitHub origin, seat not ready, budget gate,
  // empty box) and the token gate — the palette never launches by itself.
  { id: 'composer.cloud', title: 'Run in cloud…', scope: 'chat', keys: [], group: 'actions', section: 'Composer', keywords: ['cloud', 'remote', 'launch', 'draft pr'] },
  { id: 'git.create-pr', title: 'Create pull request…', scope: 'chat', keys: [], group: 'actions', section: 'Chat', keywords: ['pr', 'github', 'git', 'open pull request'] },
  { id: 'git.merge-pr', title: 'Merge pull request…', scope: 'chat', keys: [], group: 'actions', section: 'Chat', keywords: ['pr', 'github', 'git', 'land', 'ship'] },

  // ── Dock (C2 container; panes from dock-catalog.ts) ───────────────────────
  { id: 'dock.toggle', title: 'Show or hide the dock', scope: 'chat', keys: [{ key: '\\', mod: true }], group: 'actions', section: 'Dock' },
  { id: 'dock.terminal', title: 'Terminal', scope: 'chat', keys: [{ key: '`', ctrl: true }], group: 'actions', section: 'Dock', keywords: ['shell', 'console'] },
  { id: 'dock.terminal-new', title: 'New terminal tab', scope: 'chat', keys: [{ key: '`', ctrl: true, shift: true }], group: 'actions', section: 'Dock' },
  { id: 'dock.preview', title: 'Preview', scope: 'chat', keys: [{ key: 'b', mod: true, shift: true }], group: 'actions', section: 'Dock', keywords: ['browser', 'dev server'] },
  { id: 'dock.diff', title: 'Review changes', scope: 'chat', keys: [{ key: 'd', mod: true, shift: true }], group: 'actions', section: 'Dock', keywords: ['diff', 'git'] },

  // ── Composer ─────────────────────────────────────────────────────────────
  { id: 'composer.permission', title: 'Permission mode…', scope: 'chat', keys: [{ key: 'm', mod: true, shift: true }], group: 'actions', section: 'Composer', keywords: ['plan', 'bypass', 'auto'] },
  { id: 'composer.model', title: 'Model…', scope: 'chat', keys: [{ key: 'i', mod: true, shift: true }], group: 'actions', section: 'Composer' },
  { id: 'composer.effort', title: 'Effort…', scope: 'chat', keys: [{ key: 'e', mod: true, shift: true }], group: 'actions', section: 'Composer', keywords: ['reasoning', 'thinking'] },
  { id: 'composer.attach', title: 'Attach files…', scope: 'chat', keys: [{ key: 'u', mod: true }], group: 'actions', section: 'Composer', keywords: ['upload', 'image'] },
  { id: 'composer.send', title: 'Send', scope: 'composer', keys: [{ key: 'enter' }], group: null, section: 'Composer', note: 'queues while a turn runs (up to 3)' },
  { id: 'composer.stop-and-send', title: 'Stop and send', scope: 'composer', keys: [{ key: 'enter', mod: true, shift: true }], group: null, section: 'Composer' },
  { id: 'composer.stop', title: 'Stop the running turn', scope: 'composer', keys: [{ key: 'escape' }], group: null, section: 'Composer', note: 'only from an empty composer with no overlay open' },

  // ── Needs-you drawer ─────────────────────────────────────────────────────
  { id: 'drawer.next', title: 'Next item', scope: 'drawer', keys: [{ key: 'j' }], group: null, section: 'Needs you' },
  { id: 'drawer.prev', title: 'Previous item', scope: 'drawer', keys: [{ key: 'k' }], group: null, section: 'Needs you' },
  { id: 'drawer.open', title: 'Open item', scope: 'drawer', keys: [{ key: 'enter' }], group: null, section: 'Needs you' },
  { id: 'drawer.approve', title: 'Approve', scope: 'drawer', keys: [{ key: 'a' }], group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { id: 'drawer.reject', title: 'Reject', scope: 'drawer', keys: [{ key: 'r' }], group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { id: 'drawer.veto', title: 'Veto', scope: 'drawer', keys: [{ key: 'v' }], group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { id: 'drawer.done', title: 'Mark done', scope: 'drawer', keys: [{ key: 'e' }], group: null, section: 'Needs you' },
  { id: 'drawer.split-prev', title: 'Previous split', scope: 'drawer', keys: [{ key: 'h' }], group: null, section: 'Needs you' },
  { id: 'drawer.split-next', title: 'Next split', scope: 'drawer', keys: [{ key: 'l' }], group: null, section: 'Needs you' },

  // ── Charts ───────────────────────────────────────────────────────────────
  { id: 'chart.table', title: 'Show as a table', scope: 'chart', keys: [{ key: 't' }], group: null, section: 'Charts', note: 'when a chart card has focus' },

  // ── App ──────────────────────────────────────────────────────────────────
  {
    id: 'appearance.toggle-theme',
    title: 'Toggle light / dark',
    scope: 'global',
    keys: [{ key: 'l', mod: true, shift: true }],
    group: 'actions',
    section: 'App',
    keywords: ['theme', 'dark mode'],
    native: { kind: 'menu', desktopCommand: 'toggle-theme', accelerator: 'Shift+CmdOrCtrl+L' },
  },
  {
    id: 'app.summon',
    title: 'Show Verse and focus the composer',
    scope: 'global',
    keys: [{ key: 'space', ctrl: true, alt: true }],
    group: null,
    section: 'App',
    note: 'system-wide; turn on in Settings ▸ Desktop',
    native: { kind: 'global-hotkey', accelerator: 'Control+Alt+Space' },
  },
  { id: 'fleet.stop', title: 'Stop the fleet…', scope: 'global', keys: [], group: 'actions', section: 'App', guard: STOP_FLEET_GUARD, keywords: ['kill', 'halt', 'autonomy'] },

  // ── Autonomy (Command's AutonomyBar serves these) ────────────────────────
  // No keys on purpose: raising authority is never one keystroke away, and
  // each entry runs the bar's own path (Touch ID sheet, token, read-only).
  autonomySwitch('off', 'Off', ['disable', 'lower']),
  autonomySwitch('propose', 'Propose', ['proposals', 'review']),
  autonomySwitch('autonomous', 'Autonomous', ['auto', 'turn on', 'enable']),
  appAction('autonomy.grant', 'Approve grant…', ['touch id', 're-approve', 'renew', 'authority', 'autonomy'], 'command'),
  budgetMode('all-in', 'All-in', ['all in', 'max']),
  budgetMode('balanced', 'Balanced', ['default']),
  budgetMode('reserve', 'Reserve', ['save', 'conserve']),
  // Served by the shell (run-command.ts → copy-setup.ts), wherever you are.
  appAction('autonomy.copy-setup', 'Copy autonomy setup command', [AUTONOMY_SETUP_COMMAND, 'autonomy', 'turn on', 'clipboard']),
] as const satisfies readonly WorkbenchCommand[];

export type CommandId = (typeof WORKBENCH_COMMANDS)[number]['id'];

const BY_ID: ReadonlyMap<string, WorkbenchCommand> = new Map(WORKBENCH_COMMANDS.map((c) => [c.id, c as WorkbenchCommand]));

export function findCommand(id: string): WorkbenchCommand | null {
  return BY_ID.get(id) ?? null;
}

/** Palette entries of one group, in catalog order. */
export function paletteCommands(group: 'actions' | 'go-to'): WorkbenchCommand[] {
  return (WORKBENCH_COMMANDS as readonly WorkbenchCommand[]).filter((c) => c.group === group);
}

/** The shortcuts overlay: every command with keys, grouped by section, in display order. */
export function shortcutSections(): Array<{ section: ShortcutSection; commands: WorkbenchCommand[] }> {
  const withKeys = (WORKBENCH_COMMANDS as readonly WorkbenchCommand[]).filter((c) => c.keys.length > 0);
  return SHORTCUT_SECTIONS.map((section) => ({ section, commands: withKeys.filter((c) => c.section === section) })).filter(
    (s) => s.commands.length > 0,
  );
}

// ===========================================================================
// Matching and display
// ===========================================================================

export type KeyPlatform = 'mac' | 'other';

/** The platform the page runs on, for ⌘ vs Ctrl. */
export function detectKeyPlatform(): KeyPlatform {
  if (typeof navigator === 'undefined') return 'mac';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

/** The part of a KeyboardEvent matching needs (so tests can pass plain objects). */
export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const CODE_CHARS: Readonly<Record<string, string>> = {
  Backslash: '\\',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Space: 'space',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

/**
 * The event's key as a chord `key`. Letters come from `event.key` (so ⌘K is
 * ⌘K on any keyboard layout); digits and punctuation come from `event.code`
 * when it is known, because Shift and ⌥ change `event.key` (⇧\ reads "|",
 * ⌥J reads "∆") while the chord names the unshifted key.
 */
export function eventKeyName(event: Pick<KeyEventLike, 'key' | 'code'>): string {
  const key = event.key ?? '';
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  const code = event.code ?? '';
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (CODE_CHARS[code]) return CODE_CHARS[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Does `event` press `chord`? Modifiers must match EXACTLY (⌘K is not ⇧⌘K).
 * Off macOS, `mod` and `ctrl` are both the Ctrl key and ⌘/Win never matches.
 */
export function chordMatches(event: KeyEventLike, chord: KeyChord, platform: KeyPlatform = detectKeyPlatform()): boolean {
  if (platform === 'mac') {
    if (Boolean(chord.mod) !== event.metaKey) return false;
    if (Boolean(chord.ctrl) !== event.ctrlKey) return false;
  } else {
    if (event.metaKey) return false;
    if (Boolean(chord.mod || chord.ctrl) !== event.ctrlKey) return false;
  }
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  return eventKeyName(event) === chord.key;
}

/**
 * The command a key press runs, given the scopes live right now (innermost
 * first, e.g. ['composer', 'chat', 'global']). Null when nothing is bound —
 * the caller must then leave the event alone.
 */
export function matchCommand(event: KeyEventLike, liveScopes: readonly CommandScope[], platform: KeyPlatform = detectKeyPlatform()): WorkbenchCommand | null {
  for (const scope of liveScopes) {
    for (const command of WORKBENCH_COMMANDS as readonly WorkbenchCommand[]) {
      if (command.scope !== scope) continue;
      // The page never handles a system-wide hotkey itself.
      if (command.native?.kind === 'global-hotkey') continue;
      if (command.keys.some((chord) => chordMatches(event, chord, platform))) return command;
    }
  }
  return null;
}

/** Stable identity for a chord ("mod+shift+b"), for de-duplication and tests. */
export function chordId(chord: KeyChord): string {
  return [chord.ctrl ? 'ctrl' : '', chord.alt ? 'alt' : '', chord.shift ? 'shift' : '', chord.mod ? 'mod' : '', chord.key].filter(Boolean).join('+');
}

const MAC_KEY_GLYPHS: Readonly<Record<string, string>> = {
  enter: '↩',
  escape: 'Esc',
  tab: '⇥',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: '⌫',
};

const OTHER_KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: 'Backspace',
};

/**
 * How a chord is printed. macOS uses Apple's modifier order (⌃ ⌥ ⇧ ⌘) with
 * no separators ("⇧⌘B", "⌃`", "⌥↑"); elsewhere "Ctrl+Shift+B".
 */
export function formatChord(chord: KeyChord, platform: KeyPlatform = detectKeyPlatform()): string {
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : (platform === 'mac' ? MAC_KEY_GLYPHS : OTHER_KEY_NAMES)[chord.key] ?? chord.key;
  if (platform === 'mac') {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`;
  }
  const parts = [chord.mod || chord.ctrl ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', key].filter(Boolean);
  return parts.join('+');
}

/**
 * Tauri's accelerator string for a chord ("Shift+CmdOrCtrl+L") — what C8
 * writes in app_menu.rs, and what the key test compares against.
 */
export function chordAccelerator(chord: KeyChord): string {
  const TAURI_KEYS: Readonly<Record<string, string>> = {
    enter: 'Enter',
    escape: 'Escape',
    tab: 'Tab',
    space: 'Space',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    backspace: 'Backspace',
  };
  const key = TAURI_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return [chord.shift ? 'Shift' : '', chord.ctrl ? 'Control' : '', chord.alt ? 'Alt' : '', chord.mod ? 'CmdOrCtrl' : '', key].filter(Boolean).join('+');
}
