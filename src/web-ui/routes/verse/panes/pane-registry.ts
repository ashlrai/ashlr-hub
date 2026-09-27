/**
 * routes/verse/panes/pane-registry.ts — THE PANE REGISTRY: how anything
 * becomes a tab in the chat's panel area (the dock), without touching the
 * layout. See ./README.md for the guide; this file is the contract.
 *
 *   registerPane({
 *     id: 'reasoning',
 *     title: 'Reasoning',
 *     icon: ReasoningGlyph,
 *     component: lazy(() => import('./ReasoningPane.js').then((m) => ({ default: m.ReasoningPane }))),
 *     shortcut: 'mod+shift+y',          // or `command:` for a catalog key
 *     when: ({ session }) => session !== null,
 *   });
 *
 * WHAT THE DOCK DOES WITH A PANE. It lists it in "+ Add a pane", the split
 * menu and (with `toggle`) the chat header; opens it on its key; renders its
 * component inside an error boundary and a Suspense boundary (so a lazy
 * component is its own chunk and a crash says so without taking the chat
 * down); keeps it MOUNTED while its tab is open (hidden, with
 * `visible: false`, when another tab is on top — stop timers then); and
 * remembers which panes each chat had open.
 *
 * REPLACING a pane. Registering an id that already exists REPLACES it (the
 * newest registration wins) and inherits what it did not say — its catalog
 * command, header toggle and order — so a unit swapping the stub Reasoning
 * pane for the real one writes only what changed. The returned function
 * unregisters that one registration, and the previous definition comes back.
 *
 * KEYS. A pane's chord is either a catalog command's (`command:`, for the
 * first-party panes — the palette and the shortcuts overlay list those) or
 * its own `shortcut:`. An own shortcut must use mod (Cmd/Ctrl) or ctrl, and is REFUSED
 * (with a console warning; the pane still registers, keyless) when it
 * collides with a catalog key live in the chat, a system chord, or another
 * pane's key. A pane can never steal a key.
 *
 * Framework-light: React only for types and the one subscription hook. This
 * module (and the panes it registers) load just after the chat's first
 * paint — never on it (VerseApp.first-paint.test.ts).
 */
import { createElement, lazy, useState, useSyncExternalStore, type ComponentType } from 'react';
import type { VerseEvent, VerseSession } from '../../../data/api-types.js';
import {
  COMMAND_KEYS,
  SCOPE_LAYERS,
  SYSTEM_RESERVED_CHORDS,
  chordId,
  chordMatches,
  detectKeyPlatform,
  formatChord,
  parseChord,
  type KeyChord,
  type KeyedCommandId,
  type KeyEventLike,
  type KeyPlatform,
} from '../shell/command-keys.js';
import { PANE_ID_RE, type DockPresentation } from '../shell/dock-catalog.js';
import type { DiffPaneRequest, PreviewOpenRequest, TerminalOpenRequest, TurnFileChange } from '../shell/slots.js';

// ===========================================================================
// The contract
// ===========================================================================

/** The one-shot requests other parts of the chat aim at panes ("Run in terminal", a ± count, a dev server). */
export interface PaneRequests {
  terminal: TerminalOpenRequest | null;
  preview: PreviewOpenRequest | null;
  diff: (DiffPaneRequest & { nonce: number }) | null;
}

/** What a pane may ask of the workbench. Every call is safe at any time (a no-op when it cannot apply). */
export interface PaneHost {
  /** Put `text` in the composer, as its own paragraph (Terminal's "Send selection to chat"). */
  sendToChat(text: string): void;
  /** Draft `text` into the composer ("Add to message": `path:line: note`). */
  addToMessage(text: string): void;
  /** Open (and show) another pane by id. */
  openPane(id: string): void;
  /** Close this or another pane's tab. */
  closePane(id: string): void;
  /** Open the Terminal pane with a request (a tab at a root; a command PASTED, never run). */
  openTerminal(request: Omit<TerminalOpenRequest, 'nonce'>): void;
  /** The same, with Terminal as the lower half of a split under the pane on top. */
  openTerminalBelow(request: Omit<TerminalOpenRequest, 'nonce'>): void;
  /** Open the Changes pane at a root and scope (optionally one file). */
  openDiff(request: DiffPaneRequest): void;
  /** Switch the chat surface to another chat. */
  openSession(sessionId: string): void;
}

/**
 * The props every pane component receives. Stable: fields are only ever
 * ADDED. A pane that needs the live transcript subscribes itself
 * (`useVerseTranscript(sessionId)`), so a streamed token re-renders that
 * pane, not the dock.
 */
export interface PaneProps {
  /** This pane's id (one component may serve several registrations). */
  paneId: string;
  /** The open chat. Never null for a pane with `needsSession` (the default): the dock shows the empty state instead. */
  sessionId: string | null;
  session: VerseSession | null;
  /** The chat's folders, primary first. */
  roots: readonly string[];
  /** The chat's raw event log (what the transcript is built from). */
  events: readonly VerseEvent[];
  /** Files the chat's latest turn touched. */
  turnFiles: readonly TurnFileChange[];
  /** False while another tab is on top (or the panel is closed with the tab kept): stop timers, skip work. */
  visible: boolean;
  /** How the panel is drawn right now — a pane may choose a denser layout in `bottom`. */
  presentation: DockPresentation;
  requests: PaneRequests;
  host: PaneHost;
}

/** What `when` sees — enough to decide whether a pane applies to the chat that is open. */
export interface PaneContext {
  sessionId: string | null;
  session: VerseSession | null;
  roots: readonly string[];
}

/** A 16px line glyph (currentColor), like dock/dock-icons.tsx. */
export type PaneIcon = ComponentType<{ size?: number }>;

export interface PaneDefinition {
  /** Stable id: lower-case letters, numbers and dashes (`browser`, `test-runner`). Persisted in layouts. */
  id: string;
  /** Tab label and menu name: one or two words. */
  title: string;
  icon: PaneIcon;
  /** Usually `lazy(() => import(…))`, so the pane's code is its own chunk and loads on first open. */
  component: ComponentType<PaneProps>;
  /** Your own chord, as the key table writes it: 'mod+shift+y', 'ctrl+alt+p'. Refused on any collision. */
  shortcut?: string;
  /** First-party: the catalog command whose key opens this pane (its chord then comes from the catalog). */
  command?: KeyedCommandId;
  /** Whether the pane applies right now (e.g. only for a chat with a web seat). False hides its tab and menu entry. */
  when?: (context: PaneContext) => boolean;
  /** Needs an open chat (default true): without one the dock shows "Open a chat to use …" instead. */
  needsSession?: boolean;
  /** Menu / header order, ascending (first-party panes use 10…80; default 100). */
  order?: number;
  /** One sentence: what the pane is for. The empty state and the "+" menu teach with it. */
  description?: string;
  /** Show a toggle for it in the chat header (keep it to the few everyone uses). */
  toggle?: boolean;
}

/** A pane as the registry holds it: defaults applied, the chord resolved and vetted. */
export interface RegisteredPane {
  readonly id: string;
  readonly title: string;
  readonly icon: PaneIcon;
  readonly component: ComponentType<PaneProps>;
  readonly command: KeyedCommandId | null;
  /** The pane's OWN chord (not a catalog command's), after the collision check; null = none or refused. */
  readonly shortcut: KeyChord | null;
  readonly when: ((context: PaneContext) => boolean) | null;
  readonly needsSession: boolean;
  readonly order: number;
  readonly description: string | null;
  readonly toggle: boolean;
}

// ===========================================================================
// Validation
// ===========================================================================

/** Every chord that is live while a pane's key would be (the composer layer: composer + chat + global). */
function catalogChords(): Map<string, string> {
  const live = SCOPE_LAYERS.composer;
  const out = new Map<string, string>();
  for (const [id, spec] of Object.entries(COMMAND_KEYS)) {
    if (!live.includes(spec.scope)) continue;
    for (const chord of spec.keys) out.set(chordId(chord), id);
  }
  return out;
}

const RESERVED = new Set(SYSTEM_RESERVED_CHORDS.map(chordId));

/**
 * Why `text` cannot be pane `paneId`'s own shortcut, or null when it can.
 * Exported for tests and for units that want to check a chord up front.
 */
export function shortcutProblem(text: string, paneId: string, panes: Iterable<RegisteredPane> = listPanes()): string | null {
  let chord: KeyChord;
  try {
    chord = parseChord(text.trim().toLowerCase());
  } catch {
    return `"${text}" is not a chord`;
  }
  const modifiers = text.toLowerCase().split('+').slice(0, -1);
  if (!chord.key || modifiers.some((m) => !['mod', 'ctrl', 'shift', 'alt'].includes(m))) return `"${text}" is not a chord`;
  if (!chord.mod && !chord.ctrl) return `"${text}" needs mod or ctrl — a bare key would eat typing`;
  const id = chordId(chord);
  if (RESERVED.has(id)) return `"${text}" belongs to the system`;
  const owner = catalogChords().get(id);
  if (owner) return `"${text}" is already ${owner}`;
  for (const pane of panes) {
    if (pane.id === paneId) continue;
    if (pane.shortcut && chordId(pane.shortcut) === id) return `"${text}" is already the ${pane.title} pane's`;
    const command = pane.command ? COMMAND_KEYS[pane.command]?.keys[0] : undefined;
    if (command && chordId(command) === id) return `"${text}" is already the ${pane.title} pane's`;
  }
  return null;
}

/** Problems that make a definition unregistrable (an empty list = fine). */
export function definitionProblems(def: PaneDefinition): string[] {
  const problems: string[] = [];
  if (typeof def !== 'object' || def === null) return ['a pane definition must be an object'];
  if (typeof def.id !== 'string' || !PANE_ID_RE.test(def.id)) problems.push(`id "${String(def.id)}" must be lower-case letters, numbers and dashes`);
  if (typeof def.title !== 'string' || def.title.trim() === '') problems.push('title is required');
  const isComponent = (c: unknown) => typeof c === 'function' || (typeof c === 'object' && c !== null);
  if (!isComponent(def.component)) problems.push('component must be a React component (lazy() is fine)');
  if (!isComponent(def.icon)) problems.push('icon must be a React component');
  if (def.command !== undefined && !COMMAND_KEYS[def.command]) problems.push(`command "${def.command}" has no key in shell/command-keys.ts`);
  return problems;
}

// ===========================================================================
// The registry
// ===========================================================================

/** Each id's registrations, oldest first; the LAST is the active one. */
/** One registration. `builtin` ones sit UNDER every other registration of their id, whatever the load order. */
interface Layer {
  def: PaneDefinition;
  builtin: boolean;
}

/** Each id's registrations, bottom first; the effective pane folds them upward. */
const stacks = new Map<string, Layer[]>();
/** Ids in first-registration order (the tie-break for equal `order`s). */
const firstSeen: string[] = [];
let effective = new Map<string, RegisteredPane>();
let snapshot: readonly RegisteredPane[] = [];
const listeners = new Set<() => void>();
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== 'undefined') console.warn(`[verse panes] ${message}`);
}

const normalizeChordText = (text: string) => text.trim().toLowerCase();

/**
 * Fold one id's layers: each registration inherits what it leaves unsaid
 * (command, toggle, order, needsSession, description) from the one below.
 * The own shortcut is vetted against the catalog and the panes resolved so
 * far — `resolved`, in first-registration order, so the older pane keeps a
 * contested key.
 */
function fold(layers: readonly Layer[], resolved: Iterable<RegisteredPane>): RegisteredPane {
  let below = null as RegisteredPane | null;
  for (const { def } of layers) {
    const command: KeyedCommandId | null = def.command ?? below?.command ?? null;
    let shortcut: KeyChord | null = below?.shortcut ?? null;
    if (def.shortcut !== undefined) {
      const commandChord = command ? COMMAND_KEYS[command]?.keys[0] : undefined;
      if (commandChord && chordId(parseChord(normalizeChordText(def.shortcut))) === chordId(commandChord)) {
        shortcut = null; // the catalog already serves this key for this pane
      } else if (command) {
        warn(`pane "${def.id}": shortcut "${def.shortcut}" ignored — it opens with ${command}'s key`);
        shortcut = null;
      } else {
        const problem = shortcutProblem(def.shortcut, def.id, resolved);
        if (problem) warn(`pane "${def.id}": shortcut refused — ${problem}`);
        shortcut = problem ? null : parseChord(normalizeChordText(def.shortcut));
      }
    }
    below = Object.freeze({
      id: def.id,
      title: def.title.trim(),
      icon: def.icon,
      component: def.component,
      command,
      shortcut,
      when: def.when ?? null,
      needsSession: def.needsSession ?? below?.needsSession ?? true,
      order: def.order ?? below?.order ?? 100,
      description: def.description ?? below?.description ?? null,
      toggle: def.toggle ?? below?.toggle ?? false,
    });
  }
  return below!;
}

function publish(): void {
  const next = new Map<string, RegisteredPane>();
  for (const id of firstSeen) {
    const layers = stacks.get(id);
    if (layers && layers.length > 0) next.set(id, fold(layers, next.values()));
  }
  effective = next;
  // Order, then first registration: a stable menu no matter which module loaded first.
  snapshot = Object.freeze([...next.values()].sort((a, b) => a.order - b.order || firstSeen.indexOf(a.id) - firstSeen.indexOf(b.id)));
  for (const listener of [...listeners]) listener();
}

function addLayer(def: PaneDefinition, builtin: boolean): () => void {
  const problems = definitionProblems(def);
  if (problems.length > 0) {
    warn(`pane "${String((def as Partial<PaneDefinition> | null)?.id)}" not registered: ${problems.join('; ')}`);
    return () => undefined;
  }
  const layer: Layer = { def, builtin };
  const stack = stacks.get(def.id) ?? [];
  if (builtin) {
    // Under every non-builtin registration: a unit's replacement wins even if its module evaluated first.
    const firstOther = stack.findIndex((l) => !l.builtin);
    stack.splice(firstOther === -1 ? stack.length : firstOther, 0, layer);
  } else {
    stack.push(layer);
  }
  stacks.set(def.id, stack);
  if (!firstSeen.includes(def.id)) firstSeen.push(def.id);
  publish();
  return () => {
    const current = stacks.get(def.id);
    const index = current?.indexOf(layer) ?? -1;
    if (!current || index === -1) return;
    current.splice(index, 1);
    if (current.length === 0) stacks.delete(def.id);
    publish();
  };
}

/**
 * Add a pane — or replace the one with the same id. Returns a function that
 * removes THIS registration (the previous one, if any, comes back).
 *
 * Never throws: a malformed definition is reported on the console and
 * ignored, so one unit's mistake cannot take the other panes down.
 */
export function registerPane(def: PaneDefinition): () => void {
  return addLayer(def, false);
}

/**
 * The workbench's own panes (builtin-panes.tsx). Always UNDER any other
 * registration of the same id, so a unit's `registerPane` replaces the
 * first-party stub no matter which module evaluated first.
 */
export function registerBuiltinPane(def: PaneDefinition): () => void {
  return addLayer(def, true);
}

/** Every registered pane, in menu order (applicability NOT checked — see panesFor). */
export function listPanes(): readonly RegisteredPane[] {
  return snapshot;
}

/** The effective registration for `id`, or null. */
export function getPane(id: string): RegisteredPane | null {
  return effective.get(id) ?? null;
}

/** Does `pane` apply in `context`? A `when` that throws counts as no (and says so once). */
export function paneApplies(pane: RegisteredPane, context: PaneContext): boolean {
  if (!pane.when) return true;
  try {
    return pane.when(context) === true;
  } catch (err) {
    warn(`pane "${pane.id}": when() threw — ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

/** The panes that apply in `context`, in menu order. */
export function panesFor(context: PaneContext): RegisteredPane[] {
  return snapshot.filter((pane) => paneApplies(pane, context));
}

/** Is `id` registered, and does it apply in `context`? */
export function isPaneAvailable(id: string, context: PaneContext): boolean {
  const pane = getPane(id);
  return pane !== null && paneApplies(pane, context);
}

/** The chord that opens `pane` — its catalog command's, else its own — or null. */
export function paneChord(pane: RegisteredPane): KeyChord | null {
  if (pane.command) return COMMAND_KEYS[pane.command]?.keys[0] ?? null;
  return pane.shortcut;
}

/** `paneChord`, printed for this platform ("⇧⌘Y" / "Ctrl+Shift+Y"). */
export function paneChordLabel(pane: RegisteredPane, platform: KeyPlatform = detectKeyPlatform()): string | null {
  const chord = paneChord(pane);
  return chord ? formatChord(chord, platform) : null;
}

/**
 * The pane whose OWN shortcut `event` presses, or null. Catalog-command
 * chords are not matched here — the catalog's key handling runs those.
 */
export function matchPaneShortcut(event: KeyEventLike, platform: KeyPlatform = detectKeyPlatform()): RegisteredPane | null {
  for (const pane of snapshot) {
    if (pane.shortcut && chordMatches(event, pane.shortcut, platform)) return pane;
  }
  return null;
}

export function subscribePanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every registered pane, re-rendering when one is added, replaced or removed. */
export function usePanes(): readonly RegisteredPane[] {
  return useSyncExternalStore(subscribePanes, listPanes, listPanes);
}

// ===========================================================================
// lazyPane — a pane component that is its own chunk, without the flash
// ===========================================================================

/** A pane component whose code loads on first use; `preload()` fetches it ahead of time. */
export type LazyPaneComponent = ComponentType<PaneProps> & { preload: () => Promise<unknown> };

/**
 * Like `React.lazy`, for panes — and preferred to it:
 *   - once the chunk is in, a NEW mount renders the pane in the same frame
 *     (React.lazy suspends every fresh wrapper once, which flashes the
 *     skeleton when a second tab of an already-loaded chunk opens);
 *   - the dock calls `preload()` when it opens, so a tab's first click
 *     usually finds its code already here;
 *   - a failed download is not cached: "Try again" really tries again.
 *
 *   component: lazyPane(() => import('./ReasoningPane.js').then((m) => m.ReasoningPane))
 */
export function lazyPane(load: () => Promise<ComponentType<PaneProps>>): LazyPaneComponent {
  let loaded: ComponentType<PaneProps> | null = null;
  let pending: Promise<ComponentType<PaneProps>> | null = null;
  const preload = (): Promise<ComponentType<PaneProps>> => {
    pending ??= load().then((c) => (loaded = c), (err: unknown) => { pending = null; throw err; });
    return pending;
  };
  function LazyPane(props: PaneProps) {
    // Chosen once per mount: swapping the component type later would remount the pane and drop its state.
    const [Ready] = useState<ComponentType<PaneProps> | null>(() => loaded);
    const [Deferred] = useState(() => lazy(() => preload().then((c) => ({ default: c }))));
    return createElement(Ready ?? Deferred, props);
  }
  return Object.assign(LazyPane, { preload });
}

/** Fetch the code of every registered pane that can be preloaded (the dock calls this when it opens). */
export function preloadPanes(panes: readonly RegisteredPane[] = snapshot): void {
  for (const pane of panes) {
    const preload = (pane.component as Partial<LazyPaneComponent>).preload;
    if (typeof preload === 'function') void preload().catch(() => undefined);
  }
}

/** `preloadPanes` for just these ids (the chat surface warms the tabs a chat is likely to open). */
export function preloadPaneIds(ids: readonly string[]): void {
  preloadPanes(ids.map((id) => getPane(id)).filter((p): p is RegisteredPane => p !== null));
}

/** Test seam: forget every registration (builtin-panes' `registerBuiltinPanes()` puts the first-party ones back). */
export function resetPaneRegistry(): void {
  stacks.clear();
  firstSeen.length = 0;
  warned.clear();
  publish();
}
