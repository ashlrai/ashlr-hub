/**
 * routes/verse/shell/command-keys.ts — every workbench KEY: which command a
 * chord runs, in which scope, and how a native layer delivers it — plus the
 * pure helpers that match and print chords (unit C0; SPEC-310C §1).
 *
 * This is the half of the command catalog a key press needs, and the only
 * half on the chat first-paint path: the shell's and the chat's key
 * handlers, the rail's shortcut hints, the composer's keys and the desktop
 * menu bridge read it. Titles, palette groups, keywords, guards and the
 * keyless palette actions are command-catalog.ts, which loads with the ⌘K
 * palette (warmed after first paint) and binds its keyed rows from the
 * table below by id — so a key is still written exactly once, here. A key
 * that is not here does not exist.
 *
 * Pure data plus pure helpers — no React, no DOM beyond reading a
 * KeyboardEvent-shaped object.
 *
 * Adding a key: an entry in COMMAND_KEYS, and `...bind('<id>')` in the
 * command's catalog row. command-catalog.test.ts checks the two agree.
 */
import type { WorkbenchCommand } from './command-catalog.js';

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

/** One command's keys: where they are live, the chords, and any native binding. */
export interface KeySpec {
  scope: CommandScope;
  /** Non-empty: a command without a key has no entry here. */
  keys: readonly KeyChord[];
  native?: NativeBinding;
}

/**
 * A chord as the table writes it: its modifiers and its key, `+`-joined —
 * 'mod+k', 'ctrl+shift+`', 'alt+arrowup', 'enter'. Text rather than KeyChord
 * objects because this table is on the chat first-paint path and the text
 * is a third of the bytes; parseChord() turns it into the KeyChord every
 * helper below takes.
 */
type ChordText = string;

/**
 * Every key: by scope, then command id. The ids are the catalog's
 * (command-catalog.ts WORKBENCH_COMMANDS); each row there with keys takes
 * them from here with `bind(id)`.
 */
const KEYS = {
  global: {
    // Surfaces (⌘1 Command … ⌘5 Chat) and the gear tray
    'surface.command': 'mod+1',
    'surface.fleet': 'mod+2',
    'surface.growth': 'mod+3',
    'surface.mind': 'mod+4',
    'surface.chat': 'mod+5',
    'section.settings': 'mod+,',
    // Navigation
    'palette.open': 'mod+k',
    'needs-you.open': 'mod+j',
    'shortcuts.open': 'mod+/',
    // ⌘. — not ⇧⌘R, which browsers keep for a hard reload.
    'resources.toggle': 'mod+.',
    'history.back': 'mod+[',
    'history.forward': 'mod+]',
    'chat.recent-next': 'ctrl+tab',
    'chat.recent-prev': 'ctrl+shift+tab',
    'rail.toggle-labels': 'mod+shift+\\',
    // Chats
    'chat.new': 'mod+n',
    // App
    'appearance.toggle-theme': 'mod+shift+l',
    'app.summon': 'ctrl+alt+space',
  },
  chat: {
    'chat.sidebar': 'mod+b',
    'chat.find': 'mod+f',
    'chat.turn-prev': 'alt+arrowup',
    'chat.turn-next': 'alt+arrowdown',
    // Dock
    'dock.toggle': 'mod+\\',
    'dock.terminal': 'ctrl+`',
    'dock.terminal-new': 'ctrl+shift+`',
    'dock.preview': 'mod+shift+b',
    'dock.diff': 'mod+shift+d',
    // Composer menus (open from anywhere in the chat)
    'composer.permission': 'mod+shift+m',
    'composer.model': 'mod+shift+i',
    'composer.effort': 'mod+shift+e',
    'composer.attach': 'mod+u',
  },
  composer: {
    'composer.send': 'enter',
    'composer.stop-and-send': 'mod+shift+enter',
    'composer.stop': 'escape',
  },
  drawer: {
    'drawer.next': 'j',
    'drawer.prev': 'k',
    'drawer.open': 'enter',
    'drawer.approve': 'a',
    'drawer.reject': 'r',
    'drawer.veto': 'v',
    'drawer.done': 'e',
    'drawer.split-prev': 'h',
    'drawer.split-next': 'l',
  },
  chart: {
    'chart.table': 't',
  },
} as const satisfies Record<CommandScope, Record<string, ChordText>>;

type KeyTable = typeof KEYS;
export type KeyedCommandId = { [S in keyof KeyTable]: keyof KeyTable[S] }[keyof KeyTable];

/** The keys a native layer delivers or owns (C8). */
const NATIVE: Readonly<Partial<Record<KeyedCommandId, NativeBinding>>> = {
  'section.settings': { kind: 'menu', desktopCommand: 'open-settings', accelerator: 'CmdOrCtrl+,' },
  'appearance.toggle-theme': { kind: 'menu', desktopCommand: 'toggle-theme', accelerator: 'Shift+CmdOrCtrl+L' },
  'app.summon': { kind: 'global-hotkey', accelerator: 'Control+Alt+Space' },
};

/** 'mod+shift+b' → { key: 'b', mod: true, shift: true }. */
export function parseChord(text: ChordText): KeyChord {
  const parts = text.split('+');
  const chord: KeyChord = { key: parts.pop()! };
  for (const modifier of parts) chord[modifier as 'mod' | 'ctrl' | 'shift' | 'alt'] = true;
  return chord;
}

/** A command's keys, with its id. */
export interface KeyBinding extends KeySpec {
  id: KeyedCommandId;
}

const BINDINGS: readonly KeyBinding[] = (Object.entries(KEYS) as Array<[CommandScope, Record<string, ChordText>]>).flatMap(([scope, byId]) =>
  Object.entries(byId).map(([id, text]) => {
    const native = NATIVE[id as KeyedCommandId];
    return { id: id as KeyedCommandId, scope, keys: [parseChord(text)], ...(native ? { native } : {}) };
  }),
);

/** Every command's keys, by id (the catalog's bind() reads it). */
export const COMMAND_KEYS = Object.fromEntries(BINDINGS.map((b) => [b.id, b])) as unknown as Readonly<Record<KeyedCommandId, KeySpec>>;

const BINDING_BY_ID: ReadonlyMap<string, KeyBinding> = new Map(BINDINGS.map((b) => [b.id, b]));

/** The keys of command `id`; null for a command with none (or no such command). */
export function keyBinding(id: string): KeyBinding | null {
  return BINDING_BY_ID.get(id) ?? null;
}

/** The chord a hint prints for `id` (its first); undefined when it has no key. */
export function commandChord(id: string): KeyChord | undefined {
  return BINDING_BY_ID.get(id)?.keys[0];
}

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
// names it, COMMAND_KEYS uses NativeBinding, and DESKTOP_COMMANDS is typed by
// KeyedCommandId — deriving it from the map would make the types circular.
export type DesktopCommandName = (typeof DESKTOP_COMMAND_NAMES)[number];

/** Each runs a command with a key (the menu shows it), so the ids are keyed ones. */
export const DESKTOP_COMMANDS: Readonly<Record<DesktopCommandName, KeyedCommandId>> = {
  'open-settings': 'section.settings',
  'toggle-theme': 'appearance.toggle-theme',
  'open-needs-you': 'needs-you.open',
  'new-chat': 'chat.new',
  'focus-composer': 'app.summon',
};

/** `open-session:<id>` — the notification for a finished or failed chat. */
export const OPEN_SESSION_COMMAND_RE = /^open-session:([A-Za-z0-9._-]{1,128})$/;

export type ParsedDesktopCommand =
  | { kind: 'command'; name: DesktopCommandName; commandId: KeyedCommandId }
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
// The whole catalog, once it has loaded
// ===========================================================================

let catalogLookup: ((id: string) => WorkbenchCommand | null) | null = null;

/**
 * command-catalog.ts registers its lookup here when its chunk evaluates.
 * Everything that can name a keyless command — the palette, onboarding's
 * "Approve grant…" — imports the catalog, so by the time such an id reaches
 * run-command.ts the lookup is in; the warm-up fetches it after first paint
 * regardless.
 */
export function registerCommandCatalog(lookup: (id: string) => WorkbenchCommand | null): void {
  catalogLookup = lookup;
}

/**
 * The full catalog entry for `id` — null before the catalog has loaded (a
 * key's id then still resolves through keyBinding()) or for an id the
 * catalog does not have.
 */
export function loadedCommand(id: string): WorkbenchCommand | null {
  return catalogLookup ? catalogLookup(id) : null;
}

/** Has the catalog registered its lookup yet? */
export function commandCatalogLoaded(): boolean {
  return catalogLookup !== null;
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
 * The key binding a key press runs, given the scopes live right now
 * (innermost first, e.g. ['composer', 'chat', 'global']). Null when nothing
 * is bound — the caller must then leave the event alone.
 * (command-catalog.ts matchCommand returns the full catalog entry.)
 */
export function matchKey(event: KeyEventLike, liveScopes: readonly CommandScope[], platform: KeyPlatform = detectKeyPlatform()): KeyBinding | null {
  for (const scope of liveScopes) {
    for (const binding of BINDINGS) {
      if (binding.scope !== scope) continue;
      // The page never handles a system-wide hotkey itself.
      if (binding.native?.kind === 'global-hotkey') continue;
      if (binding.keys.some((chord) => chordMatches(event, chord, platform))) return binding;
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
