/**
 * panes/pane-registry.test.tsx — the pane registry's contract (README.md):
 * register / replace / unregister, first-party panes always under a unit's
 * replacement, defaults and inheritance, `when`, and KEYS — a pane can never
 * take a key the catalog, the system or another pane already has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_KEYS, SCOPE_LAYERS, chordId, parseChord } from '../shell/command-keys.js';
import { DOCK_PANES } from '../shell/dock-catalog.js';
import {
  DISCOVERED_PANE_MODULES,
  definitionProblems,
  getPane,
  isPaneAvailable,
  listPanes,
  matchPaneShortcut,
  paneChord,
  paneChordLabel,
  panesFor,
  registerBuiltinPanes,
  registerPane,
  resetPaneRegistry,
  shortcutProblem,
  type PaneDefinition,
  type PaneProps,
} from './index.js';

const Icon = () => null;
const Body = (_: PaneProps) => null;
const NO_CHAT = { sessionId: null, session: null, roots: [] };
const pane = (over: Partial<PaneDefinition> = {}): PaneDefinition => ({ id: 'test-pane', title: 'Test', icon: Icon, component: Body, ...over });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetPaneRegistry();
  registerBuiltinPanes();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  resetPaneRegistry();
  registerBuiltinPanes();
});

describe('first-party panes', () => {
  it('registers Terminal, Browser, Changes, Files, Sources, Reasoning, Tasks and Context, in that order', () => {
    expect(listPanes().map((p) => p.id)).toEqual(DOCK_PANES.map((p) => p.id));
    expect(listPanes().map((p) => p.title)).toEqual(['Terminal', 'Browser', 'Changes', 'Files', 'Sources', 'Reasoning', 'Tasks', 'Context']);
    // The three everyone uses get a header toggle; the rest live in "+", the palette and their keys.
    expect(listPanes().filter((p) => p.toggle).map((p) => p.id)).toEqual(['terminal', 'browser', 'diff']);
    for (const p of listPanes()) expect(p.description, p.id).toBeTruthy();
  });

  it('opens each keyed first-party pane with a chat-scope catalog command', () => {
    for (const meta of DOCK_PANES) {
      const registered = getPane(meta.id)!;
      if (meta.commandId === null) {
        expect(paneChord(registered), meta.id).toBeNull();
        continue;
      }
      expect(registered.command).toBe(meta.commandId);
      expect(COMMAND_KEYS[registered.command!].scope, meta.id).toBe('chat');
      expect(paneChord(registered)).toEqual(COMMAND_KEYS[registered.command!].keys[0]);
    }
    expect(paneChordLabel(getPane('reasoning')!, 'mac')).toBe('⇧⌘Y');
    expect(paneChordLabel(getPane('files')!, 'other')).toBe('Ctrl+Shift+O');
  });

  it('never gives two panes one key, and never a key the chat already uses', () => {
    const catalog = new Map<string, string>();
    for (const [id, spec] of Object.entries(COMMAND_KEYS)) {
      if (!SCOPE_LAYERS.composer.includes(spec.scope)) continue;
      for (const chord of spec.keys) catalog.set(chordId(chord), id);
    }
    const seen = new Map<string, string>();
    for (const p of listPanes()) {
      const chord = paneChord(p);
      if (!chord) continue;
      const id = chordId(chord);
      expect(seen.get(id), `${id} opens both ${seen.get(id)} and ${p.id}`).toBeUndefined();
      seen.set(id, p.id);
      // A first-party pane's key IS its catalog command's — no other command has it.
      expect(catalog.get(id), `${id} of ${p.id}`).toBe(p.command);
    }
    // Not ⇧⌘E (composer effort) nor ⇧⌘R (a browser's hard reload).
    expect(seen.has(chordId(parseChord('mod+shift+e')))).toBe(false);
    expect(seen.has(chordId(parseChord('mod+shift+r')))).toBe(false);
  });

  it('discovers other units\' `*.pane.tsx` files (a map of whatever has landed)', () => {
    expect(typeof DISCOVERED_PANE_MODULES).toBe('object');
    for (const path of Object.keys(DISCOVERED_PANE_MODULES)) expect(path).toMatch(/\.pane\.tsx?$/);
  });
});

describe('registerPane', () => {
  it('adds a pane with defaults: needs a chat, ordered last, no toggle, no key', () => {
    const dispose = registerPane(pane());
    const p = getPane('test-pane')!;
    expect(p).toMatchObject({ title: 'Test', needsSession: true, order: 100, toggle: false, command: null, shortcut: null, description: null });
    expect(listPanes().at(-1)!.id).toBe('test-pane');
    dispose();
    expect(getPane('test-pane')).toBeNull();
  });

  it('REPLACES a pane with the same id, inheriting what it leaves unsaid; unregistering brings the old one back', () => {
    const before = getPane('reasoning')!;
    const Real = (_: PaneProps) => null;
    const dispose = registerPane({ id: 'reasoning', title: 'Reasoning', icon: Icon, component: Real });
    const now = getPane('reasoning')!;
    expect(now.component).toBe(Real);
    expect(now).toMatchObject({ command: 'dock.reasoning', order: before.order, description: before.description });
    expect(listPanes().filter((p) => p.id === 'reasoning')).toHaveLength(1);
    dispose();
    expect(getPane('reasoning')!.component).toBe(before.component);
  });

  it('keeps a unit\'s replacement on top even when the first-party stub registers after it', () => {
    resetPaneRegistry();
    const Real = (_: PaneProps) => null;
    registerPane({ id: 'sources', title: 'Sources', icon: Icon, component: Real });
    registerBuiltinPanes();
    expect(getPane('sources')!.component).toBe(Real);
    // …and still inherits the stub's key and place.
    expect(getPane('sources')!.command).toBe('dock.sources');
    expect(listPanes().map((p) => p.id).indexOf('sources')).toBe(DOCK_PANES.findIndex((p) => p.id === 'sources'));
  });

  it('ignores a malformed definition with a console warning instead of throwing', () => {
    expect(definitionProblems(pane({ id: 'Bad Id' }))).toHaveLength(1);
    expect(definitionProblems(pane({ title: ' ' }))).toEqual(['title is required']);
    expect(definitionProblems(pane({ command: 'nope' as never }))[0]).toMatch(/has no key/);
    const dispose = registerPane(pane({ id: 'Bad Id' }));
    expect(getPane('Bad Id')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    expect(() => dispose()).not.toThrow();
  });

  it('applies `when` per chat, and counts a throwing `when` as no', () => {
    registerPane(pane({ id: 'web-only', when: ({ session }) => session?.engine === 'claude' }));
    registerPane(pane({ id: 'broken', when: () => { throw new Error('nope'); } }));
    expect(isPaneAvailable('web-only', NO_CHAT)).toBe(false);
    const session = { id: 's1', engine: 'claude' } as never;
    expect(isPaneAvailable('web-only', { sessionId: 's1', session, roots: [] })).toBe(true);
    expect(panesFor(NO_CHAT).some((p) => p.id === 'broken')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('when() threw'));
  });
});

describe('a pane\'s own shortcut', () => {
  const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
    key, code: `Key${key.toUpperCase()}`, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
  });

  it('works when it is free, and is matched from a key press', () => {
    registerPane(pane({ id: 'tests', title: 'Tests', shortcut: 'mod+alt+t' }));
    expect(getPane('tests')!.shortcut).toEqual({ key: 't', mod: true, alt: true });
    expect(matchPaneShortcut(press('t', { meta: true, alt: true }), 'mac')?.id).toBe('tests');
    expect(matchPaneShortcut(press('t', { meta: true }), 'mac')).toBeNull();
  });

  it('is refused — the pane still registers, keyless — on any collision', () => {
    expect(shortcutProblem('mod+k', 'x')).toMatch(/already palette\.open/);
    expect(shortcutProblem('mod+shift+e', 'x')).toMatch(/already composer\.effort/);
    expect(shortcutProblem('mod+shift+y', 'x')).toMatch(/already dock\.reasoning/);
    expect(shortcutProblem('mod+space', 'x')).toMatch(/system/);
    expect(shortcutProblem('t', 'x')).toMatch(/bare key/);
    expect(shortcutProblem('shift+t', 'x')).toMatch(/bare key/);
    expect(shortcutProblem('hyper+t', 'x')).toMatch(/not a chord/);
    registerPane(pane({ id: 'first', title: 'First', shortcut: 'mod+alt+u' }));
    registerPane(pane({ id: 'second', title: 'Second', shortcut: 'mod+alt+u' }));
    expect(getPane('first')!.shortcut).not.toBeNull();
    expect(getPane('second')!.shortcut).toBeNull();
    expect(getPane('second')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shortcut refused'));
  });

  it('is dropped when the pane already opens with a catalog command (the catalog serves that key)', () => {
    registerPane({ id: 'browser', title: 'Browser', icon: Icon, component: Body, shortcut: 'mod+shift+b' });
    expect(getPane('browser')!.shortcut).toBeNull();
    expect(getPane('browser')!.command).toBe('dock.preview');
    expect(matchPaneShortcut(press('b', { meta: true, shift: true }), 'mac')).toBeNull();
  });
});
