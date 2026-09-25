/**
 * The command catalog's invariants (unit C0; SPEC-310C §1 "a test checks for
 * duplicates and for clashes with native-menu accelerators"):
 *   - every key is unique across the scopes that can be live together;
 *   - no key collides with an accelerator the desktop menu owns (parsed from
 *     app_menu.rs itself) unless the command IS that menu item's command;
 *   - no key collides with a macOS system shortcut;
 *   - the palette, drawer, dock and desktop-command tables all point at real
 *     commands.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_ACTION_KEYS, WORKBENCH_SURFACES } from '../../../../core/verse/workbench-types.js';
import {
  chordAccelerator,
  chordId,
  chordMatches,
  COMMAND_SCOPES,
  DESKTOP_COMMAND_NAMES,
  DESKTOP_COMMANDS,
  eventKeyName,
  findCommand,
  formatChord,
  matchCommand,
  PALETTE_GROUPS,
  PALETTE_PREFIXES,
  PALETTE_RECENT_LIMIT,
  paletteCommands,
  parseDesktopCommand,
  SCOPE_LAYERS,
  SHORTCUT_SECTIONS,
  shortcutSections,
  SYSTEM_RESERVED_CHORDS,
  WORKBENCH_COMMAND_EVENT,
  WORKBENCH_COMMANDS,
  type KeyChord,
  type KeyEventLike,
  type WorkbenchCommand,
} from './command-catalog.js';
import { DOCK_PANES } from './dock-catalog.js';
import { WORKBENCH_COMMAND_EVENT as COMPOSER_WORKBENCH_COMMAND_EVENT } from '../composer/composer-keys.js';

const COMMANDS = WORKBENCH_COMMANDS as readonly WorkbenchCommand[];
const APP_MENU = readFileSync(resolve(process.cwd(), 'desktop/src-tauri/src/app_menu.rs'), 'utf8');
const SHELL_CONTRACT = readFileSync(resolve(process.cwd(), 'desktop/src-tauri/src/shell_contract.rs'), 'utf8');

/** Tauri accelerator string → canonical chordId. */
function acceleratorId(accelerator: string): string {
  const parts = accelerator.split('+').map((p) => p.trim());
  const keyPart = parts.pop()!;
  const chord: KeyChord = { key: '' };
  for (const part of parts) {
    const p = part.toLowerCase();
    if (['cmdorctrl', 'commandorcontrol', 'cmd', 'command', 'super', 'meta'].includes(p)) chord.mod = true;
    else if (['ctrl', 'control'].includes(p)) chord.ctrl = true;
    else if (p === 'shift') chord.shift = true;
    else if (['alt', 'option'].includes(p)) chord.alt = true;
    else throw new Error(`unknown modifier ${part} in ${accelerator}`);
  }
  const named: Record<string, string> = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', space: 'space', enter: 'enter', return: 'enter', esc: 'escape', escape: 'escape', tab: 'tab', plus: '=' };
  chord.key = named[keyPart.toLowerCase()] ?? keyPart.toLowerCase();
  return chordId(chord);
}

/**
 * What Tauri's predefined macOS menu items bind. A predefined item the source
 * uses that is missing here FAILS the test — add its accelerator (or null)
 * rather than letting a native key go unchecked.
 */
const PREDEFINED_ACCELERATORS: Record<string, string | null> = {
  about: null,
  separator: null,
  services: null,
  show_all: null,
  maximize: null,
  undo: 'CmdOrCtrl+Z',
  redo: 'Shift+CmdOrCtrl+Z',
  cut: 'CmdOrCtrl+X',
  copy: 'CmdOrCtrl+C',
  paste: 'CmdOrCtrl+V',
  select_all: 'CmdOrCtrl+A',
  hide: 'CmdOrCtrl+H',
  hide_others: 'Alt+CmdOrCtrl+H',
  quit: 'CmdOrCtrl+Q',
  minimize: 'CmdOrCtrl+M',
  close_window: 'CmdOrCtrl+W',
  fullscreen: 'Control+CmdOrCtrl+F',
};

/** Every accelerator the native menu owns, by chordId → where it came from. */
function nativeAccelerators(): Map<string, string> {
  // Only the production half: app_menu.rs keeps its tests in the same file,
  // and they quote the page's keys as strings the menu must NOT claim.
  const production = APP_MENU.split('#[cfg(test)]')[0]!;
  const out = new Map<string, string>();
  for (const m of production.matchAll(/\.accelerator\("([^"]+)"\)/g)) out.set(acceleratorId(m[1]!), m[1]!);
  for (const m of production.matchAll(/PredefinedMenuItem::([a-z_]+)\(/g)) {
    const name = m[1]!;
    expect(Object.prototype.hasOwnProperty.call(PREDEFINED_ACCELERATORS, name), `add PredefinedMenuItem::${name} to PREDEFINED_ACCELERATORS`).toBe(true);
    const accelerator = PREDEFINED_ACCELERATORS[name];
    if (accelerator) out.set(acceleratorId(accelerator), `PredefinedMenuItem::${name}`);
  }
  return out;
}

function ev(key: string, mods: Partial<Omit<KeyEventLike, 'key'>> = {}): KeyEventLike {
  return { key, code: mods.code ?? '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

describe('command catalog — table integrity', () => {
  it('gives every command a unique id, a title, a known scope and a known overlay section', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMMANDS) {
      expect(c.title.trim().length, c.id).toBeGreaterThan(0);
      expect(COMMAND_SCOPES, c.id).toContain(c.scope);
      expect(SHORTCUT_SECTIONS, c.id).toContain(c.section);
      expect(findCommand(c.id)).toBe(c);
    }
    expect(findCommand('nope')).toBeNull();
  });

  it('maps ⌘1–⌘5 to the five surfaces, in rail order', () => {
    WORKBENCH_SURFACES.forEach((surface, i) => {
      const command = findCommand(`surface.${surface}`)!;
      expect(command, surface).not.toBeNull();
      expect(command.keys).toEqual([{ key: String(i + 1), mod: true }]);
      expect(command.scope).toBe('global');
    });
  });

  it('keeps every guarded command confirm-first, token-second, and in the palette', () => {
    const guarded = COMMANDS.filter((c) => c.guard);
    expect(guarded.map((c) => c.id).sort()).toEqual(['chats.stop-all', 'fleet.stop']);
    for (const c of guarded) {
      expect(c.guard!.token, c.id).toBe(true);
      expect(c.guard!.confirm.destructive, c.id).toBe(true);
      expect(c.guard!.confirm.confirmLabel.length, c.id).toBeGreaterThan(0);
      expect(c.group, c.id).toBe('actions');
      // A guarded action is never one keystroke away.
      expect(c.keys, c.id).toEqual([]);
    }
  });

  it('offers Create / Merge pull request from the palette only — each opens BranchBar\'s own dialog, never a one-key merge', () => {
    for (const id of ['git.create-pr', 'git.merge-pr']) {
      const c = findCommand(id)!;
      expect(c, id).not.toBeNull();
      expect(c.group, id).toBe('actions');
      expect(c.scope, id).toBe('chat');
      expect(c.keys, id).toEqual([]);
      // Not a catalog guard: the dialog it opens carries the disclosure and the token gate.
      expect(c.guard, id).toBeUndefined();
    }
    expect(findCommand('git.create-pr')!.title).toBe('Create pull request…');
    expect(findCommand('git.merge-pr')!.title).toBe('Merge pull request…');
  });

  it('names the workbench window event once, and the composer re-exports the same one', () => {
    expect(WORKBENCH_COMMAND_EVENT).toBe('ashlr:command');
    expect(COMPOSER_WORKBENCH_COMMAND_EVENT).toBe(WORKBENCH_COMMAND_EVENT);
  });

  it('offers the Resources drawer as ⌘. from anywhere and as "Show resources" in the palette (3.11 C6)', () => {
    const c = findCommand('resources.toggle')!;
    expect(c).not.toBeNull();
    expect(c.title).toBe('Show resources');
    expect(c.scope).toBe('global');
    expect(c.group).toBe('actions');
    expect(c.keys).toEqual([{ key: '.', mod: true }]);
    expect(paletteCommands('actions').map((a) => a.id)).toContain('resources.toggle');
    expect(shortcutSections().find((s) => s.section === 'Navigation')!.commands.map((a) => a.id)).toContain('resources.toggle');
    // By physical key, so a layout or Shift that changes event.key still matches.
    expect(matchCommand(ev('.', { code: 'Period', metaKey: true }), ['global'], 'mac')?.id).toBe('resources.toggle');
    expect(matchCommand(ev('.', { code: 'Period', ctrlKey: true }), ['composer', 'chat', 'global'], 'other')?.id).toBe('resources.toggle');
    expect(formatChord(c.keys[0]!, 'mac')).toBe('⌘.');
  });

  it('lets Tab fill a seat for "New chat on…"', () => {
    expect(findCommand('chat.new-on')!.argument).toEqual({ kind: 'seat', prompt: 'Seat' });
  });

  it('orders the palette groups Needs you › Chats › Actions › Go to › Seats & Apps › Projects', () => {
    expect(PALETTE_GROUPS.map((g) => g.label)).toEqual(['Needs you', 'Chats', 'Actions', 'Go to', 'Seats & Apps', 'Projects']);
    expect(PALETTE_PREFIXES).toEqual({ '>': 'actions', '#': 'chats' });
    expect(PALETTE_RECENT_LIMIT).toBe(5);
    expect(paletteCommands('go-to').map((c) => c.id)).toEqual([
      'surface.command', 'surface.fleet', 'surface.growth', 'surface.mind', 'surface.chat', 'section.settings', 'section.apps', 'section.usage',
    ]);
    // ⌘K never lists itself.
    expect(COMMANDS.find((c) => c.id === 'palette.open')!.group).toBeNull();
  });

  it('binds the drawer keys A R V E to approve / reject / veto / done, as the Needs-you contract names them', () => {
    const key = (id: string) => findCommand(id)!.keys[0]!.key.toUpperCase();
    expect({ approve: key('drawer.approve'), reject: key('drawer.reject'), veto: key('drawer.veto'), done: key('drawer.done') }).toEqual(NEEDS_YOU_ACTION_KEYS);
  });

  it('opens every dock pane that has a command with a real, chat-scoped command', () => {
    for (const pane of DOCK_PANES) {
      if (pane.commandId === null) continue;
      const command = findCommand(pane.commandId);
      expect(command, pane.id).not.toBeNull();
      expect(command!.scope, pane.id).toBe('chat');
    }
  });

  it('lists in the shortcuts overlay exactly the commands that have keys, section by section', () => {
    const listed = shortcutSections().flatMap((s) => s.commands.map((c) => c.id));
    expect(listed.sort()).toEqual(COMMANDS.filter((c) => c.keys.length > 0).map((c) => c.id).sort());
    const order = shortcutSections().map((s) => SHORTCUT_SECTIONS.indexOf(s.section));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('command catalog — keys', () => {
  it('never binds one key twice among scopes that can be live together', () => {
    for (const scope of COMMAND_SCOPES) {
      const seen = new Map<string, string>();
      for (const c of COMMANDS.filter((cmd) => SCOPE_LAYERS[scope].includes(cmd.scope))) {
        for (const chord of c.keys) {
          const id = chordId(chord);
          expect(seen.has(id), `${id} is bound by both ${seen.get(id)} and ${c.id} (live together in "${scope}")`).toBe(false);
          seen.set(id, c.id);
        }
      }
    }
  });

  it('claims no key the native menu owns — unless the command IS that menu item', () => {
    const native = nativeAccelerators();
    expect(native.size).toBeGreaterThan(10); // guards the parser itself
    for (const c of COMMANDS) {
      for (const chord of c.keys) {
        const owner = native.get(chordId(chord));
        if (!owner) continue;
        expect(c.native?.kind, `${c.id} (${formatChord(chord, 'mac')}) collides with native ${owner}`).toBe('menu');
        expect(acceleratorId(c.native!.kind === 'menu' ? c.native!.accelerator : ''), c.id).toBe(chordId(chord));
      }
    }
  });

  it('declares a native menu binding only for an accelerator app_menu.rs really has, whose command shell_contract.rs really sends', () => {
    const native = nativeAccelerators();
    for (const c of COMMANDS) {
      if (c.native?.kind !== 'menu') continue;
      expect(native.has(acceleratorId(c.native.accelerator)), `${c.id}: app_menu.rs has no ${c.native.accelerator}`).toBe(true);
      expect(chordAccelerator(c.keys[0]!), c.id).toBe(c.native.accelerator);
      expect(SHELL_CONTRACT, c.id).toContain(`"${c.native.desktopCommand}"`);
    }
  });

  it('keeps the page-owned keys the Rust test reserves (⌘1–⌘5, ⌘K, ⌘N) bound on the page', () => {
    const reserved = [...APP_MENU.matchAll(/"CmdOrCtrl\+([0-9A-Z])",/g)].map((m) => chordId({ key: m[1]!.toLowerCase(), mod: true }));
    expect(reserved.length).toBe(7);
    const pageKeys = new Set(COMMANDS.filter((c) => c.scope === 'global').flatMap((c) => c.keys.map(chordId)));
    for (const id of reserved) expect(pageKeys.has(id), id).toBe(true);
  });

  it('claims no macOS system shortcut', () => {
    const system = new Set(SYSTEM_RESERVED_CHORDS.map(chordId));
    for (const c of COMMANDS) for (const chord of c.keys) expect(system.has(chordId(chord)), `${c.id} ${chordId(chord)}`).toBe(false);
  });

  it('never lets the page handle the system-wide hotkey itself', () => {
    const summon = findCommand('app.summon')!;
    expect(summon.native?.kind).toBe('global-hotkey');
    expect(matchCommand(ev(' ', { code: 'Space', ctrlKey: true, altKey: true }), ['global'], 'mac')).toBeNull();
  });
});

describe('command catalog — matching', () => {
  it('reads letters layout-aware and punctuation by physical key', () => {
    expect(eventKeyName({ key: 'K', code: 'KeyK' })).toBe('k');
    expect(eventKeyName({ key: '|', code: 'Backslash' })).toBe('\\');
    expect(eventKeyName({ key: '~', code: 'Backquote' })).toBe('`');
    expect(eventKeyName({ key: '!', code: 'Digit1' })).toBe('1');
    expect(eventKeyName({ key: '∆', code: 'KeyJ' })).toBe('j');
    expect(eventKeyName({ key: ' ', code: 'Space' })).toBe('space');
    expect(eventKeyName({ key: 'Escape', code: 'Escape' })).toBe('escape');
    expect(eventKeyName({ key: 'ArrowUp' })).toBe('arrowup');
    expect(eventKeyName({ key: 'Enter' })).toBe('enter');
  });

  it('requires the exact modifiers (⌘K is not ⇧⌘K) and maps ⌘ to Ctrl off macOS', () => {
    const cmdK: KeyChord = { key: 'k', mod: true };
    expect(chordMatches(ev('k', { metaKey: true }), cmdK, 'mac')).toBe(true);
    expect(chordMatches(ev('k', { metaKey: true, shiftKey: true }), cmdK, 'mac')).toBe(false);
    expect(chordMatches(ev('k', { ctrlKey: true }), cmdK, 'mac')).toBe(false);
    expect(chordMatches(ev('k', { ctrlKey: true }), cmdK, 'other')).toBe(true);
    expect(chordMatches(ev('k', { metaKey: true }), cmdK, 'other')).toBe(false);
    const ctrlTick: KeyChord = { key: '`', ctrl: true };
    expect(chordMatches(ev('`', { code: 'Backquote', ctrlKey: true }), ctrlTick, 'mac')).toBe(true);
    expect(chordMatches(ev('`', { code: 'Backquote', metaKey: true }), ctrlTick, 'mac')).toBe(false);
  });

  it('resolves the innermost live scope first, and nothing outside the live scopes', () => {
    const enter = ev('Enter');
    expect(matchCommand(enter, ['composer', 'chat', 'global'], 'mac')?.id).toBe('composer.send');
    expect(matchCommand(enter, ['drawer', 'global'], 'mac')?.id).toBe('drawer.open');
    expect(matchCommand(enter, ['global'], 'mac')).toBeNull();
    expect(matchCommand(ev('|', { code: 'Backslash', metaKey: true, shiftKey: true }), ['chat', 'global'], 'mac')?.id).toBe('rail.toggle-labels');
    expect(matchCommand(ev('\\', { code: 'Backslash', metaKey: true }), ['chat', 'global'], 'mac')?.id).toBe('dock.toggle');
    expect(matchCommand(ev('\\', { code: 'Backslash', metaKey: true }), ['global'], 'mac')).toBeNull();
    expect(matchCommand(ev('j', { code: 'KeyJ', metaKey: true }), ['global'], 'mac')?.id).toBe('needs-you.open');
    expect(matchCommand(ev('j', { code: 'KeyJ' }), ['drawer', 'global'], 'mac')?.id).toBe('drawer.next');
  });

  it('prints chords the platform way', () => {
    expect(formatChord({ key: 'b', mod: true, shift: true }, 'mac')).toBe('⇧⌘B');
    expect(formatChord({ key: '`', ctrl: true }, 'mac')).toBe('⌃`');
    expect(formatChord({ key: 'arrowup', alt: true }, 'mac')).toBe('⌥↑');
    expect(formatChord({ key: 'space', ctrl: true, alt: true }, 'mac')).toBe('⌃⌥Space');
    expect(formatChord({ key: 'enter', mod: true, shift: true }, 'mac')).toBe('⇧⌘↩');
    expect(formatChord({ key: 'b', mod: true, shift: true }, 'other')).toBe('Ctrl+Shift+B');
    expect(formatChord({ key: 'tab', ctrl: true, shift: true }, 'other')).toBe('Ctrl+Shift+Tab');
  });
});

describe('desktop commands (C8 → page)', () => {
  it('maps every desktop command to a real catalog command', () => {
    expect(Object.keys(DESKTOP_COMMANDS).sort()).toEqual([...DESKTOP_COMMAND_NAMES].sort());
    for (const [name, id] of Object.entries(DESKTOP_COMMANDS)) expect(findCommand(id), name).not.toBeNull();
  });

  it('parses known commands and open-session:<id>, and nothing else', () => {
    expect(parseDesktopCommand('open-settings')).toEqual({ kind: 'command', name: 'open-settings', commandId: 'section.settings' });
    expect(parseDesktopCommand('open-needs-you')).toEqual({ kind: 'command', name: 'open-needs-you', commandId: 'needs-you.open' });
    expect(parseDesktopCommand('open-session:vs_01J9-abc.def')).toEqual({ kind: 'open-session', sessionId: 'vs_01J9-abc.def' });
    for (const junk of ['', 'open-session:', 'open-session:../etc', 'open-session:a b', '__proto__', 'toString', 'OPEN-SETTINGS', 42, null]) {
      expect(parseDesktopCommand(junk), String(junk)).toBeNull();
    }
  });
});
