/**
 * app/desktop-shell.ts — the web half of the desktop shell contract.
 *
 * The native side (`desktop/src-tauri/src/shell_contract.{rs,js}`, documented
 * in `desktop/README.md` → "Desktop shell contract") injects markers, CSS
 * variables, a drag-region mirror, a menu-command event, and one optional
 * page→native call. This module is the ONLY place the web UI touches any of
 * it, so the console keeps exactly one seam to the desktop app and never
 * references Tauri.
 *
 * Everything here is inert in a browser: the markers are absent, the global
 * is undefined, and the event is never dispatched. No caller needs a
 * conditional build or a feature flag.
 */
import type { ThemePreference } from '../data/theme-store.js';

/** Commands the native menu bar can send the page. */
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
