/**
 * terminal/panel-keys.ts — the Terminal panel's own keys (3.15), and which
 * keys leave the terminal for the page.
 *
 * While a terminal has focus it owns the keyboard (⌃C, ⌃R, Esc, ⌥-word
 * motion are the shell's). Three groups of keys are taken out of it:
 *
 *   1. the panel's own — ⌘F find, ⌘D split right, ⌥⌘D split down,
 *      ⌥⌘←→↑↓ focus the pane that way, ⇧⌘↩ zoom the pane (and back),
 *      ⌘↑ / ⌘↓ previous / next command block, ⇧⌘K blocks view,
 *      ⌘I describe a command in plain words;
 *   2. the app's catalog chords that use ⌘ (⌘K, ⌘J, ⌘1–5 …) or ⌃` / ⌃Tab
 *      (keyPassesToPage, as the 3.10 pane);
 *   3. nothing else.
 *
 * Off macOS, `mod` is Ctrl — and Ctrl+F / Ctrl+D belong to the shell there
 * (forward-char, EOF), so the panel's keys need Ctrl+SHIFT on those
 * platforms (pane focus: Ctrl+Shift+Alt+arrows, which no shell binds). The
 * page-level listeners skip default-prevented events, so a key the panel
 * takes is prevented and runs nothing else.
 */
import { eventKeyName, matchKey, type KeyPlatform } from '../shell/command-keys.js';

/**
 * Keys the PAGE handles even while a terminal has focus: an app chord that
 * uses ⌘ (macOS), or ⌃` / ⌃Tab; off macOS only Ctrl+Shift chords and
 * ⌃` / ⌃Tab (Ctrl+K must still kill a line). Same rule as the 3.10 pane.
 */
export function keyPassesToPage(event: KeyboardEvent, platform: KeyPlatform): boolean {
  if (event.type !== 'keydown') return false;
  if (!matchKey(event, ['chat', 'global'], platform)) return false;
  const key = eventKeyName(event);
  const shellChord = event.ctrlKey && (key === '`' || key === 'tab');
  if (platform === 'mac') return event.metaKey || shellChord;
  return shellChord || (event.ctrlKey && event.shiftKey);
}

export type PanelKeyAction =
  | 'find'
  | 'split-right'
  | 'split-down'
  | 'prev-block'
  | 'next-block'
  | 'toggle-blocks'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'zoom-pane'
  | 'assist';

const FOCUS_BY_ARROW: Readonly<Record<string, PanelKeyAction>> = {
  arrowleft: 'focus-left',
  arrowright: 'focus-right',
  arrowup: 'focus-up',
  arrowdown: 'focus-down',
};

export function panelKeyAction(event: KeyboardEvent, platform: KeyPlatform): PanelKeyAction | null {
  if (event.type !== 'keydown') return null;
  const key = eventKeyName(event);
  if (platform === 'mac') {
    if (!event.metaKey || event.ctrlKey) return null;
    if (event.altKey && !event.shiftKey && FOCUS_BY_ARROW[key]) return FOCUS_BY_ARROW[key]!;
    if (key === 'f' && !event.shiftKey && !event.altKey) return 'find';
    if (key === 'd' && !event.shiftKey) return event.altKey ? 'split-down' : 'split-right';
    if (key === 'arrowup' && !event.shiftKey && !event.altKey) return 'prev-block';
    if (key === 'arrowdown' && !event.shiftKey && !event.altKey) return 'next-block';
    if (key === 'k' && event.shiftKey && !event.altKey) return 'toggle-blocks';
    if (key === 'enter' && event.shiftKey && !event.altKey) return 'zoom-pane';
    if (key === 'i' && !event.shiftKey && !event.altKey) return 'assist';
    return null;
  }
  if (!event.ctrlKey || !event.shiftKey || event.metaKey) return null;
  if (event.altKey && FOCUS_BY_ARROW[key]) return FOCUS_BY_ARROW[key]!;
  if (key === 'f' && !event.altKey) return 'find';
  // Ctrl+Shift+D is the dock's Review here: splits are the toolbar's off macOS.
  if (key === 'arrowup' && !event.altKey) return 'prev-block';
  if (key === 'arrowdown' && !event.altKey) return 'next-block';
  if (key === 'k' && event.altKey) return 'toggle-blocks';
  if (key === 'enter' && !event.altKey) return 'zoom-pane';
  if (key === 'i' && event.altKey) return 'assist';
  return null;
}

/** How the panel's keys read in tooltips. */
export function panelKeyLabel(action: PanelKeyAction, platform: KeyPlatform): string {
  const mac = platform === 'mac';
  switch (action) {
    case 'find': return mac ? '⌘F' : 'Ctrl+Shift+F';
    case 'split-right': return mac ? '⌘D' : '';
    case 'split-down': return mac ? '⌥⌘D' : '';
    case 'prev-block': return mac ? '⌘↑' : 'Ctrl+Shift+↑';
    case 'next-block': return mac ? '⌘↓' : 'Ctrl+Shift+↓';
    case 'toggle-blocks': return mac ? '⇧⌘K' : 'Ctrl+Shift+Alt+K';
    case 'focus-left': return mac ? '⌥⌘←' : 'Ctrl+Shift+Alt+←';
    case 'focus-right': return mac ? '⌥⌘→' : 'Ctrl+Shift+Alt+→';
    case 'focus-up': return mac ? '⌥⌘↑' : 'Ctrl+Shift+Alt+↑';
    case 'focus-down': return mac ? '⌥⌘↓' : 'Ctrl+Shift+Alt+↓';
    case 'zoom-pane': return mac ? '⇧⌘↩' : 'Ctrl+Shift+Enter';
    case 'assist': return mac ? '⌘I' : 'Ctrl+Shift+Alt+I';
  }
}
