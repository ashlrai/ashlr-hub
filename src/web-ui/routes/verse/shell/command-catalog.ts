/**
 * routes/verse/shell/command-catalog.ts — every workbench command, in ONE
 * table (unit C0; SPEC-310C §1).
 *
 * The ⌘K palette (C1), the shortcuts overlay (⌘/), the drawer and every
 * surface's buttons read this table; the key test reads it too, which is how
 * "no two commands share a key" and "no key the native menu already owns"
 * stay true as units add commands.
 *
 * KEYS are written in ./command-keys.ts, the half of the catalog the chat
 * first paint needs (a key press, a shortcut hint, the desktop menu bridge);
 * a row with keys takes them from there with `bind(id)`, so each key is
 * still written once. This module — titles, palette groups, keywords,
 * guards, the keyless palette actions — loads with the palette's chunk, not
 * with first paint, and re-exports ./command-keys.ts so its importers keep
 * one import site.
 *
 * Pure data plus pure helpers — no React, no DOM — so the palette can import
 * it without pulling a surface into its chunk.
 *
 * Adding a command: one entry below (a change request to C0 when another
 * unit needs it), plus its keys in command-keys.ts if it has any. The
 * handler lives with the unit that owns the behaviour and dispatches on the
 * command `id`.
 */
import {
  COMMAND_KEYS,
  matchKey,
  detectKeyPlatform,
  registerCommandCatalog,
  type CommandScope,
  type KeyChord,
  type KeyedCommandId,
  type KeyEventLike,
  type KeyPlatform,
  type NativeBinding,
} from './command-keys.js';

export * from './command-keys.js';

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
  surface?: 'command' | 'mind';
}

/** A keyed row's id, scope, keys and native binding — from command-keys.ts, never re-declared here. */
function bind<I extends KeyedCommandId>(id: I): { id: I; scope: CommandScope; keys: readonly KeyChord[]; native?: NativeBinding } {
  const spec: { scope: CommandScope; keys: readonly KeyChord[]; native?: NativeBinding } = COMMAND_KEYS[id];
  return spec.native ? { id, scope: spec.scope, keys: spec.keys, native: spec.native } : { id, scope: spec.scope, keys: spec.keys };
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
 * budget and setup entries below.
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

const surface = <I extends KeyedCommandId>(id: I, name: string) => ({
  ...bind(id),
  title: `Go to ${name}`,
  group: 'go-to',
  section: 'Surfaces',
  keywords: [name.toLowerCase()],
} as const);

export const WORKBENCH_COMMANDS = [
  // ── Surfaces (⌘1 Command … ⌘5 Chat) and the gear tray ────────────────────
  surface('surface.command', 'Command'),
  surface('surface.fleet', 'Fleet'),
  surface('surface.growth', 'Growth'),
  surface('surface.mind', 'Mind'),
  surface('surface.chat', 'Chat'),
  { ...bind('section.settings'), title: 'Open Settings', group: 'go-to', section: 'Surfaces', keywords: ['preferences', 'appearance'] },
  { id: 'section.apps', title: 'Open Apps & Accounts', scope: 'global', keys: [], group: 'go-to', section: 'Surfaces', keywords: ['mcp', 'accounts', 'seats', 'integrations', 'ollama'] },
  { id: 'section.usage', title: 'Open Usage', scope: 'global', keys: [], group: 'go-to', section: 'Surfaces', keywords: ['capacity', 'spend', 'limits'] },

  // ── Navigation ───────────────────────────────────────────────────────────
  { ...bind('palette.open'), title: 'Command palette', group: null, section: 'Navigation' },
  { ...bind('needs-you.open'), title: 'Open Needs you', group: 'actions', section: 'Navigation', keywords: ['approvals', 'inbox', 'triage'] },
  { ...bind('shortcuts.open'), title: 'Keyboard shortcuts', group: 'actions', section: 'Navigation', keywords: ['keys', 'help'] },
  // The Resources drawer (3.11 C6): the key toggles it, the palette opens it.
  {
    ...bind('resources.toggle'),
    title: 'Open Resources',
    group: 'actions',
    section: 'Navigation',
    // The composer claims ⌘. to stop a running turn (Composer.tsx) — say so
    // where the key is listed, so the same chord is never a surprise.
    note: 'stops the running turn instead while one runs',
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
  { ...bind('history.back'), title: 'Back', group: null, section: 'Navigation', note: 'through surfaces and chats' },
  { ...bind('history.forward'), title: 'Forward', group: null, section: 'Navigation', note: 'through surfaces and chats' },
  { ...bind('chat.recent-next'), title: 'Next recent chat', group: null, section: 'Navigation' },
  { ...bind('chat.recent-prev'), title: 'Previous recent chat', group: null, section: 'Navigation' },
  { ...bind('rail.toggle-labels'), title: 'Show or hide rail labels', group: 'actions', section: 'Navigation' },

  // ── Chats ────────────────────────────────────────────────────────────────
  { ...bind('chat.new'), title: 'New chat', group: 'actions', section: 'Chat' },
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
  { ...bind('chat.sidebar'), title: 'Show or hide the chat list', group: 'actions', section: 'Chat' },
  { ...bind('chat.find'), title: 'Find in chat', group: 'actions', section: 'Chat', keywords: ['search'] },
  { ...bind('chat.turn-prev'), title: 'Previous turn', group: null, section: 'Chat' },
  { ...bind('chat.turn-next'), title: 'Next turn', group: null, section: 'Chat' },
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
  { ...bind('dock.toggle'), title: 'Show or hide the dock', group: 'actions', section: 'Dock' },
  { ...bind('dock.terminal'), title: 'Terminal', group: 'actions', section: 'Dock', keywords: ['shell', 'console'] },
  { ...bind('dock.terminal-new'), title: 'New terminal tab', group: 'actions', section: 'Dock' },
  { ...bind('dock.preview'), title: 'Preview', group: 'actions', section: 'Dock', keywords: ['browser', 'dev server'] },
  { ...bind('dock.diff'), title: 'Review changes', group: 'actions', section: 'Dock', keywords: ['diff', 'git'] },

  // ── Composer ─────────────────────────────────────────────────────────────
  { ...bind('composer.permission'), title: 'Permission mode…', group: 'actions', section: 'Composer', keywords: ['plan', 'bypass', 'auto'] },
  { ...bind('composer.model'), title: 'Model…', group: 'actions', section: 'Composer' },
  { ...bind('composer.effort'), title: 'Effort…', group: 'actions', section: 'Composer', keywords: ['reasoning', 'thinking'] },
  { ...bind('composer.attach'), title: 'Attach files…', group: 'actions', section: 'Composer', keywords: ['upload', 'image'] },
  { ...bind('composer.send'), title: 'Send', group: null, section: 'Composer', note: 'queues while a turn runs (up to 3)' },
  { ...bind('composer.stop-and-send'), title: 'Stop and send', group: null, section: 'Composer' },
  { ...bind('composer.stop'), title: 'Stop the running turn', group: null, section: 'Composer', note: 'only from an empty composer with no overlay open' },

  // ── Needs-you drawer ─────────────────────────────────────────────────────
  { ...bind('drawer.next'), title: 'Next item', group: null, section: 'Needs you' },
  { ...bind('drawer.prev'), title: 'Previous item', group: null, section: 'Needs you' },
  { ...bind('drawer.open'), title: 'Open item', group: null, section: 'Needs you' },
  { ...bind('drawer.approve'), title: 'Approve', group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { ...bind('drawer.reject'), title: 'Reject', group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { ...bind('drawer.veto'), title: 'Veto', group: null, section: 'Needs you', note: 'confirms, then asks for the token' },
  { ...bind('drawer.done'), title: 'Mark done', group: null, section: 'Needs you' },
  { ...bind('drawer.select'), title: 'Select item', group: null, section: 'Needs you', note: 'A / R / E then act on every selected item' },
  { ...bind('drawer.split-prev'), title: 'Previous split', group: null, section: 'Needs you' },
  { ...bind('drawer.split-next'), title: 'Next split', group: null, section: 'Needs you' },

  // ── Charts ───────────────────────────────────────────────────────────────
  { ...bind('chart.table'), title: 'Show as a table', group: null, section: 'Charts', note: 'when a chart card has focus' },

  // ── App ──────────────────────────────────────────────────────────────────
  { ...bind('appearance.toggle-theme'), title: 'Toggle light / dark', group: 'actions', section: 'App', keywords: ['theme', 'dark mode'] },
  { ...bind('app.summon'), title: 'Show Verse and focus the composer', group: null, section: 'App', note: 'system-wide; turn on in Settings ▸ Desktop' },
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
  // ── The Leader (Mind's conversation) ────────────────────────────────────
  // Served by the shell (run-command.ts → leader/leader-focus.ts): it goes to
  // Mind and the conversation panel takes the ask once its chunk mounts.
  { id: 'leader.message', title: 'Message the Leader…', scope: 'global', keys: [], group: 'actions', section: 'App', surface: 'mind', keywords: ['leader', 'ask', 'chat', 'strategy', 'memo', 'talk', 'telegram'] },
  { id: 'leader.directive', title: 'Add Leader directive…', scope: 'global', keys: [], group: 'actions', section: 'App', surface: 'mind', keywords: ['leader', 'directive', 'instruction', 'rule', 'standing order'] },
  // Served by the shell (run-command.ts → copy-setup.ts), wherever you are.
  appAction('autonomy.copy-setup', 'Copy autonomy setup command', [AUTONOMY_SETUP_COMMAND, 'autonomy', 'turn on', 'clipboard']),
] as const satisfies readonly WorkbenchCommand[];

export type CommandId = (typeof WORKBENCH_COMMANDS)[number]['id'];

const BY_ID: ReadonlyMap<string, WorkbenchCommand> = new Map(WORKBENCH_COMMANDS.map((c) => [c.id, c as WorkbenchCommand]));

export function findCommand(id: string): WorkbenchCommand | null {
  return BY_ID.get(id) ?? null;
}

// run-command.ts resolves keyless ids (palette actions, guards, surfaces) through this.
registerCommandCatalog(findCommand);

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

/**
 * The command a key press runs, given the scopes live right now (innermost
 * first, e.g. ['composer', 'chat', 'global']). Null when nothing is bound —
 * the caller must then leave the event alone. The full catalog entry; first
 * paint matches with command-keys.ts matchKey().
 */
export function matchCommand(event: KeyEventLike, liveScopes: readonly CommandScope[], platform: KeyPlatform = detectKeyPlatform()): WorkbenchCommand | null {
  const binding = matchKey(event, liveScopes, platform);
  return binding ? findCommand(binding.id) : null;
}
