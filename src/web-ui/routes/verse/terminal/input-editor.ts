/**
 * terminal/input-editor.ts — the seam between the input editor (the React
 * glue, CommandInput.tsx) and the text editor under it.
 *
 * The real one is CodeMirror 6 (command-editor.ts), loaded in its OWN chunk
 * the first time a shell reaches a prompt with the editor on: nothing on the
 * chat's first paint — nor the terminal's own first paint — pays for it
 * (terminal-lazy.test.ts pins that no file but command-editor.ts imports
 * @codemirror). Tests inject a fake editor: the seam is small on purpose.
 */

/** What a key in the editor asks the terminal to do. The editor handles plain editing itself. */
export type InputKeyIntent =
  /** ↩ — run it (or, for `#…`, turn it into a command). */
  | 'submit'
  /** ↑ on the first line / ↓ on the last. */
  | 'history-prev'
  | 'history-next'
  /** ⌃R — search history (again, from the palette: the shell's own ⌃R). */
  | 'history-search'
  /** ⌘I — describe a command in plain words. */
  | 'assist'
  /** ⌃C — clear the line; on an empty line, interrupt (sent to the shell). */
  | 'interrupt'
  /** ⌃D on an empty line — the shell's EOF. */
  | 'eof'
  /** ⌃L — the shell clears its screen. */
  | 'clear-screen'
  /** Esc — give the line to the shell's own editor (vi users: a second Esc is theirs). */
  | 'hand-off'
  /** ⇥ with no suggestion to accept — the shell's own completion gets the line and the Tab. */
  | 'tab';

export interface InputEditorOptions {
  host: HTMLElement;
  initial: string;
  placeholder: string;
  /** Every change of the text (typing, completion, setText). */
  onChange: (text: string) => void;
  /** A terminal key. Return true when it was handled (the editor then does nothing else with it). */
  onKey: (intent: InputKeyIntent) => boolean;
  onFocusChange?: (focused: boolean) => void;
  /** Path candidates for the word being typed (files from the composer's index); [] = none. */
  completePaths?: (text: string, cursor: number) => Promise<{ from: number; options: string[] } | null>;
  /** Accessible name. */
  label: string;
}

export interface InputEditor {
  getText(): string;
  /** Replace the text, cursor at the end. */
  setText(text: string): void;
  focus(): void;
  hasFocus(): boolean;
  /** The full command to suggest after what is typed (shown past the cursor), or null. */
  setGhost(suggestion: string | null): void;
  setPlaceholder(text: string): void;
  dispose(): void;
}

export type InputEditorFactory = (opts: InputEditorOptions) => Promise<InputEditor>;

let editorModule: Promise<typeof import('./command-editor.js')> | null = null;

/** CodeMirror, fetched on first use (and retried after a failed chunk load). */
export const createLazyInputEditor: InputEditorFactory = async (opts) => {
  if (!editorModule) {
    editorModule = import('./command-editor.js');
    editorModule.catch(() => { editorModule = null; });
  }
  const mod = await editorModule;
  return mod.createCommandEditor(opts);
};

/** Start fetching the editor's chunk without creating one (a shell that just came up). */
export function preloadInputEditor(): void {
  if (editorModule) return;
  editorModule = import('./command-editor.js');
  editorModule.catch(() => { editorModule = null; });
}
