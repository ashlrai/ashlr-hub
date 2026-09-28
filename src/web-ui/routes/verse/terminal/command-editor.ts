/**
 * terminal/command-editor.ts — the input editor's CodeMirror 6 (3.15).
 *
 * THIS FILE IS A LAZY CHUNK: only input-editor.ts reaches it, through
 * import(). It is the one file under terminal/ that imports @codemirror
 * (terminal-lazy.test.ts). What it adds to a plain text box:
 *
 *   - bash highlighting (the legacy `shell` stream mode), multi-line (⇧↩),
 *     click-to-place, undo, soft wrap;
 *   - GHOST TEXT — the rest of the best history match, dim, after the
 *     cursor; → / End / ⌃E / ⇥ accept it;
 *   - PATH COMPLETION as a path-like word is typed (the composer's file
 *     index, asked by CommandInput), ⇥ / ↩ take the highlighted one;
 *   - the terminal's keys as INTENTS (input-editor.ts InputKeyIntent): ↩,
 *     ↑/↓ at the edges, ⌃R, ⌘I, ⌃C, ⌃D, ⌃L, Esc, and ⇥ with nothing to take.
 *
 * Colours are classes (`cm-sh-*`, `cm-ghost`) styled in the panel's CSS from
 * its `--term-*` palette, so the editor matches the terminal above it.
 */
import { acceptCompletion, autocompletion, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import type { InputEditor, InputEditorOptions } from './input-editor.js';

// ---------------------------------------------------------------------------
// Ghost text
// ---------------------------------------------------------------------------

const setGhost = StateEffect.define<string | null>();

const ghostField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value;
    return value;
  },
});

/** The part of the suggestion past the cursor, when the cursor is at the end of a matching line. */
export function ghostRemainder(state: EditorState): string | null {
  const ghost = state.field(ghostField, false) ?? null;
  if (!ghost) return null;
  const doc = state.doc.toString();
  const sel = state.selection.main;
  if (!sel.empty || sel.head !== doc.length || !ghost.startsWith(doc) || ghost.length <= doc.length) return null;
  return ghost.slice(doc.length);
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

const ghostDecorations = EditorView.decorations.compute([ghostField, 'doc', 'selection'], (state) => {
  const rest = ghostRemainder(state);
  if (!rest) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(rest), side: 1 }).range(state.doc.length)]);
});

function acceptGhost(view: EditorView): boolean {
  const rest = ghostRemainder(view.state);
  if (!rest) return false;
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert: rest }, selection: EditorSelection.cursor(end + rest.length), userEvent: 'input.complete' });
  return true;
}

// ---------------------------------------------------------------------------
// Highlighting: classes, coloured by the panel's CSS
// ---------------------------------------------------------------------------

const shellHighlight = HighlightStyle.define([
  { tag: t.keyword, class: 'cm-sh-keyword' },
  { tag: [t.string, t.special(t.string)], class: 'cm-sh-string' },
  { tag: t.comment, class: 'cm-sh-comment' },
  { tag: [t.variableName, t.special(t.variableName), t.definition(t.variableName)], class: 'cm-sh-variable' },
  { tag: [t.standard(t.variableName), t.function(t.variableName)], class: 'cm-sh-builtin' },
  { tag: [t.attributeName, t.atom], class: 'cm-sh-flag' },
  { tag: t.number, class: 'cm-sh-number' },
  { tag: t.operator, class: 'cm-sh-operator' },
]);

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/**
 * CodeMirror's code-editing chords that would shadow the app's or make no
 * sense for a command line (⌘/ comments, ⌘[ ⌘] indent — the app's back and
 * forward —, ⌘↩ blank line, ⌘I select syntax — ours is "describe it", ⇧⌘K
 * delete line — the Blocks view, ⌘U — attach). Everything else (motion,
 * selection, undo, the emacs keys on macOS) stays.
 */
const DROPPED_DEFAULT_KEYS = new Set(['Mod-Enter', 'Mod-[', 'Mod-]', 'Mod-/', 'Mod-i', 'Mod-u', 'Shift-Mod-k', 'Shift-Mod-\\', 'Mod-Alt-\\', 'Alt-A']);
const commandLineKeymap = defaultKeymap.filter((binding) => !binding.key || !DROPPED_DEFAULT_KEYS.has(binding.key));

export async function createCommandEditor(opts: InputEditorOptions): Promise<InputEditor> {
  const placeholderSlot = new Compartment();

  const onLine = (view: EditorView, which: 'first' | 'last'): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head).number;
    return which === 'first' ? line === 1 : line === view.state.doc.lines;
  };

  const intentKeys = Prec.high(keymap.of([
    { key: 'Enter', run: () => opts.onKey('submit') },
    { key: 'Shift-Enter', run: insertNewline },
    {
      key: 'Tab',
      run: (view) => acceptGhost(view) || (completionStatus(view.state) === 'active' && acceptCompletion(view)) || opts.onKey('tab'),
    },
    { key: 'ArrowRight', run: acceptGhost },
    { key: 'End', run: acceptGhost },
    { key: 'Ctrl-e', run: acceptGhost },
    { key: 'ArrowUp', run: (view) => onLine(view, 'first') && opts.onKey('history-prev') },
    { key: 'ArrowDown', run: (view) => onLine(view, 'last') && opts.onKey('history-next') },
    { key: 'Ctrl-r', run: () => opts.onKey('history-search') },
    { key: 'Mod-i', run: () => opts.onKey('assist') },
    // ⌃C with a selection is a copy (off macOS, Ctrl+C is the copy key).
    { key: 'Ctrl-c', run: (view) => view.state.selection.main.empty && opts.onKey('interrupt') },
    { key: 'Ctrl-d', run: (view) => view.state.doc.length === 0 && opts.onKey('eof') },
    { key: 'Ctrl-l', run: () => opts.onKey('clear-screen') },
    { key: 'Escape', run: () => opts.onKey('hand-off') },
  ]));

  const pathSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!opts.completePaths) return null;
    const found = await opts.completePaths(ctx.state.doc.toString(), ctx.pos).catch(() => null);
    if (!found || found.options.length === 0 || ctx.aborted) return null;
    const options: Completion[] = found.options.map((label) => ({
      label,
      type: label.endsWith('/') ? 'folder' : 'file',
      // A folder keeps going: its contents are offered next.
      ...(label.endsWith('/') ? {
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          view.dispatch({ changes: { from, to, insert: label }, selection: EditorSelection.cursor(from + label.length), userEvent: 'input.complete' });
          startCompletion(view);
        },
      } : {}),
    }));
    return { from: found.from, options, validFor: /^[^\s;|&<>()`'"]*$/ };
  };

  const extensions: Extension[] = [
    history(),
    StreamLanguage.define(shell),
    syntaxHighlighting(shellHighlight),
    EditorView.lineWrapping,
    ghostField,
    ghostDecorations,
    // Before our keys: while its list is open, ↩ / ↑ / ↓ / Esc are the list's.
    autocompletion({ override: [pathSource], activateOnTyping: true, icons: false, aboveCursor: true, closeOnBlur: true, maxRenderedOptions: 30 }),
    intentKeys,
    keymap.of([...historyKeymap, ...commandLineKeymap]),
    placeholderSlot.of(placeholderExt(opts.placeholder)),
    EditorView.contentAttributes.of({
      'aria-label': opts.label,
      'aria-multiline': 'true',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
      if (update.focusChanged) opts.onFocusChange?.(update.view.hasFocus);
    }),
  ];

  const view = new EditorView({
    parent: opts.host,
    state: EditorState.create({
      doc: opts.initial,
      selection: EditorSelection.cursor(opts.initial.length),
      extensions,
    }),
  });

  return {
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(text.length),
      });
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    setGhost(suggestion) {
      if ((view.state.field(ghostField, false) ?? null) === suggestion) return;
      view.dispatch({ effects: setGhost.of(suggestion) });
    },
    setPlaceholder(text) {
      view.dispatch({ effects: placeholderSlot.reconfigure(placeholderExt(text)) });
    },
    dispose: () => view.destroy(),
  };
}
