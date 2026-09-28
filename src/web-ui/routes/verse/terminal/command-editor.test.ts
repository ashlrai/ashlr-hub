/**
 * 3.15 — the input editor's real CodeMirror (command-editor.ts) under jsdom:
 * keys become the terminal's intents, the ghost shows only as a suffix at
 * the end of a matching line and → / ⇥ take it, ⇧↩ is a new line, and the
 * shell grammar highlights.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputEditor, InputKeyIntent } from './input-editor.js';
import { createCommandEditor } from './command-editor.js';

let editor: InputEditor | null = null;
let host: HTMLElement;

afterEach(() => {
  editor?.dispose();
  editor = null;
  host?.remove();
});

async function make(onKey: (i: InputKeyIntent) => boolean = () => true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const changes: string[] = [];
  editor = await createCommandEditor({ host, initial: '', placeholder: 'Type a command', label: 'Command', onChange: (t) => changes.push(t), onKey });
  const content = host.querySelector<HTMLElement>('.cm-content')!;
  const press = (key: string, mods: KeyboardEventInit = {}) => {
    content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
  };
  return { editor, changes, content, press };
}

describe('command-editor (CodeMirror)', () => {
  it('raises the terminal\'s intents for ↩, ⌃R, ⌃C, Esc and ↑ on the first line', async () => {
    const seen: InputKeyIntent[] = [];
    const { editor: e, press, content } = await make((i) => { seen.push(i); return true; });
    expect(content.getAttribute('aria-label')).toBe('Command');
    e.setText('ls');
    press('Enter');
    press('r', { ctrlKey: true });
    press('c', { ctrlKey: true });
    press('Escape');
    press('ArrowUp');
    expect(seen).toEqual(['submit', 'history-search', 'interrupt', 'hand-off', 'history-prev']);
  });

  it('⇧↩ inserts a new line instead of running', async () => {
    const onKey = vi.fn(() => true);
    const { editor: e, press } = await make(onKey);
    e.setText('echo a');
    press('Enter', { shiftKey: true });
    expect(e.getText()).toBe('echo a\n');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('ghost text: a dim suffix at the end of a matching line; → accepts it; ⇥ with none is the shell\'s', async () => {
    const seen: InputKeyIntent[] = [];
    const { editor: e, press, changes } = await make((i) => { seen.push(i); return true; });
    e.setText('git s');
    e.setGhost('git status');
    expect(host.querySelector('.cm-ghost')?.textContent).toBe('tatus');
    press('ArrowRight');
    expect(e.getText()).toBe('git status');
    expect(changes.at(-1)).toBe('git status');
    expect(host.querySelector('.cm-ghost')).toBeNull();
    // A ghost that does not continue the text is not shown.
    e.setGhost('npm test');
    expect(host.querySelector('.cm-ghost')).toBeNull();
    press('Tab');
    expect(seen).toEqual(['tab']);
  });

  it('highlights the shell grammar with classes the panel colours', async () => {
    const { editor: e } = await make();
    e.setText('echo "hi" # note');
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector('.cm-sh-string')?.textContent).toBe('"hi"');
    expect(host.querySelector('.cm-sh-comment')?.textContent).toBe('# note');
  });
});
