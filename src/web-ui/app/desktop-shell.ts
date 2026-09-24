/**
 * app/desktop-shell.ts — the web half of the desktop shell contract.
 *
 * The native side (`desktop/src-tauri/src/shell_contract.{rs,js}`, documented
 * in `desktop/README.md` → "Desktop shell contract") injects markers, CSS
 * variables, a drag-region mirror, a command event (menu bar, tray, clicked
 * notifications, the global hotkey), the desktop state behind Settings ▸
 * Desktop, and two page→native calls (theme, preferences). This module is the
 * ONLY place the web UI touches any of it, so the console keeps exactly one
 * seam to the desktop app and never references Tauri.
 *
 * Everything here is inert in a browser: the markers are absent, the global
 * is undefined, and the event is never dispatched. No caller needs a
 * conditional build or a feature flag.
 */
import { useSyncExternalStore } from 'react';
import type { ThemePreference } from '../data/theme-store.js';
import { parseDesktopCommand, type ParsedDesktopCommand } from '../routes/verse/shell/command-catalog.js';

/**
 * The two commands the native MENU BAR sends (the 3.9 contract).
 * `subscribeDesktopCommands` keeps delivering exactly these; everything the
 * 3.10 shell sends (tray, notifications, hotkey) arrives through
 * `subscribeShellCommands`, parsed by the command catalog.
 */
export type DesktopCommand = 'open-settings' | 'toggle-theme';

const DESKTOP_COMMAND_EVENT = 'ashlr:desktop-command';
const COMMANDS: readonly DesktopCommand[] = ['open-settings', 'toggle-theme'];

/**
 * True only inside the Tauri window, where `shell_contract.js` has stamped
 * `data-app-shell="desktop"` on `<html>`. Layout does NOT branch on this —
 * the CSS reads `--app-titlebar-height` / `--app-traffic-light-inset` with a
 * `0px` fallback instead, so there is one layout, not two.
 */
export function isDesktopShell(): boolean {
  try {
    return document.documentElement.getAttribute('data-app-shell') === 'desktop';
  } catch {
    return false;
  }
}

/**
 * Resolve a three-state preference down to what is actually painted, which is
 * what the native side needs: it stores the value and paints the window
 * background with the matching canvas colour on the NEXT launch, before the
 * webview has painted. 'system' therefore has to become a concrete answer
 * here, not be passed through.
 */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    // jsdom and old webviews without matchMedia: light is the token default.
    return 'light';
  }
}

interface DesktopBridge {
  reportTheme?: (theme: 'light' | 'dark') => void;
  getState?: () => unknown;
  setPreference?: (name: DesktopPreference, value: boolean) => boolean;
}

function bridge(): DesktopBridge | undefined {
  return (window as unknown as { __ASHLR_DESKTOP__?: DesktopBridge }).__ASHLR_DESKTOP__;
}

/**
 * Tell the native window which theme is painted, so the next cold launch does
 * not flash white. Optional by contract, best-effort by implementation: a
 * browser has no bridge, and a throwing bridge must never break a render.
 * Repeat calls with the same value are dropped on the native side.
 */
export function reportThemeToShell(preference: ThemePreference): void {
  try {
    bridge()?.reportTheme?.(resolveTheme(preference));
  } catch {
    /* the shell is an enhancement; never let it fail the page */
  }
}

function isDesktopCommand(value: unknown): value is DesktopCommand {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

/**
 * Listen for menu commands. Returns an unsubscribe function, so a component
 * can register it from an effect.
 *
 * Unknown commands are ignored rather than forwarded: the native menu can
 * grow ahead of the web UI, and an unhandled command is specified to be inert
 * rather than an error.
 */
export function subscribeDesktopCommands(handler: (command: DesktopCommand) => void): () => void {
  function onCommand(event: Event): void {
    const detail = (event as CustomEvent<{ command?: unknown }>).detail;
    const command = detail?.command;
    if (isDesktopCommand(command)) handler(command);
  }
  window.addEventListener(DESKTOP_COMMAND_EVENT, onCommand);
  return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, onCommand);
}

/**
 * Every desktop command — menu bar, tray, a clicked notification, the global
 * hotkey — parsed by the command catalog (`parseDesktopCommand`): a catalog
 * command (`open-needs-you`, `new-chat`, `focus-composer`, …) or
 * `open-session:<id>`. Unknown strings are dropped, never guessed. This is
 * what the workbench shell (C1) listens to; `subscribeDesktopCommands` stays
 * for the 3.9 menu-only contract.
 */
export function subscribeShellCommands(handler: (command: ParsedDesktopCommand) => void): () => void {
  function onCommand(event: Event): void {
    const parsed = parseDesktopCommand((event as CustomEvent<{ command?: unknown }>).detail?.command);
    if (parsed) handler(parsed);
  }
  window.addEventListener(DESKTOP_COMMAND_EVENT, onCommand);
  return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, onCommand);
}

// ===========================================================================
// Desktop state — Settings ▸ Desktop (V3.10, C8)
// ===========================================================================

/** Preferences Settings ▸ Desktop may change (desktop_prefs.rs `PrefsPatch`). */
export type DesktopPreference = 'globalHotkey' | 'notifications';

/**
 * What the desktop app reports (desktop_prefs.rs `DesktopStateView`). Every
 * string is the shell's own copy — nothing from the server.
 */
export interface DesktopState {
  hotkey: {
    /** The operator's choice. */
    enabled: boolean;
    /** Whether macOS actually gave Ashlr the chord. */
    registered: boolean;
    /** Display form, e.g. "⌃⌥Space". */
    accelerator: string;
    /** Why `registered` is false while `enabled` is true; null otherwise. */
    error: string | null;
  };
  notifications: {
    enabled: boolean;
    /**
     * `native` — a signed build, banners come from Ashlr.
     * `script` — an unsigned build, banners come through osascript and show
     * as Script Editor (say so beside the toggle).
     */
    delivery: 'native' | 'script';
  };
}

const DESKTOP_STATE_EVENT = 'ashlr:desktop-state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Boundary check: the value crossed from another runtime. */
export function isDesktopState(value: unknown): value is DesktopState {
  if (!isRecord(value) || !isRecord(value['hotkey']) || !isRecord(value['notifications'])) return false;
  const h = value['hotkey'];
  const n = value['notifications'];
  return (
    typeof h['enabled'] === 'boolean' &&
    typeof h['registered'] === 'boolean' &&
    typeof h['accelerator'] === 'string' &&
    h['accelerator'].length > 0 &&
    h['accelerator'].length <= 32 &&
    (h['error'] === null || (typeof h['error'] === 'string' && h['error'].length <= 300)) &&
    typeof n['enabled'] === 'boolean' &&
    (n['delivery'] === 'native' || n['delivery'] === 'script')
  );
}

// One module-level listener feeds a cached snapshot, so readers (and
// useSyncExternalStore, which needs a STABLE snapshot) never see a stale or
// freshly-copied object.
let cachedState: DesktopState | null | undefined;
let listening = false;
const stateListeners = new Set<(state: DesktopState) => void>();

function readBridgeState(): DesktopState | null {
  try {
    const raw = bridge()?.getState?.();
    return isDesktopState(raw) ? raw : null;
  } catch {
    return null;
  }
}

function onDesktopState(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isDesktopState(detail)) return;
  cachedState = detail;
  for (const listener of [...stateListeners]) listener(detail);
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener(DESKTOP_STATE_EVENT, onDesktopState);
}

/** The latest desktop state, or null in a browser (and before native answered). */
export function getDesktopState(): DesktopState | null {
  ensureListening();
  if (cachedState === undefined || cachedState === null) cachedState = readBridgeState();
  return cachedState;
}

/** Called with every new state native sends. Returns an unsubscribe function. */
export function subscribeDesktopState(handler: (state: DesktopState) => void): () => void {
  ensureListening();
  stateListeners.add(handler);
  return () => {
    stateListeners.delete(handler);
  };
}

/**
 * Ask the desktop app to change a preference. True when the request was sent
 * (a desktop bridge exists), false in a browser. The answer arrives as a new
 * state — e.g. a hotkey another app holds comes back
 * `{ enabled: true, registered: false, error }` — so render from state, never
 * from the value you asked for.
 */
export function setDesktopPreference(name: DesktopPreference, value: boolean): boolean {
  if (name !== 'globalHotkey' && name !== 'notifications') return false;
  if (typeof value !== 'boolean') return false;
  try {
    return bridge()?.setPreference?.(name, value) === true;
  } catch {
    return false;
  }
}

function subscribeStore(onChange: () => void): () => void {
  return subscribeDesktopState(() => onChange());
}

/**
 * React: the live desktop state, or null in a browser. Settings ▸ Desktop
 * renders its hotkey and notification rows from this and hides them (or says
 * "available in the desktop app") when it is null.
 */
export function useDesktopState(): DesktopState | null {
  return useSyncExternalStore(subscribeStore, getDesktopState, () => null);
}

/** Tests only: forget the cached state and the module listener. */
export function resetDesktopStateForTests(): void {
  if (listening) window.removeEventListener(DESKTOP_STATE_EVENT, onDesktopState);
  listening = false;
  cachedState = undefined;
  stateListeners.clear();
}
