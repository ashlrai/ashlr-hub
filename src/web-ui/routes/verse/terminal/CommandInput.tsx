/**
 * terminal/CommandInput.tsx — the input editor docked under a shell (3.15).
 *
 * WHEN. Only at a shell prompt: after the integration's OSC 133 B and before
 * C, never in the alternate screen, never for a shell marked Raw, and not
 * again at a prompt where the operator typed into the terminal itself (that
 * prompt is theirs). TerminalLeaf decides (input-model.ts `inputVisible`);
 * this component keeps its editor mounted between prompts so a draft
 * survives a command that is still running.
 *
 * WHAT IT DOES
 *   ↩        runs the text: it is written to the PTY followed by CR, exactly
 *            what typing it would send (several lines go as ONE bracketed paste);
 *   #…  ⌘I   plain words → a command from the local model (terminal-assist),
 *            put back HERE for review. Nothing runs until the next ↩ — and a
 *            command flagged as destructive needs a second one;
 *   ghost    the best history match, dim, after the cursor (→ / ⇥ take it);
 *   ↑ ↓      history, most recent first (starting with what is typed);
 *   paths    completions from the composer's file index as a path is typed;
 *   Ctrl+R       the history palette (Ctrl+R again there: the shell's own Ctrl+R);
 *   Esc / ⇥  hand the line to the shell's own editor (vi mode, fzf-tab …);
 *   ⌃C ⌃D ⌃L as a shell would: clear/interrupt, EOF, clear screen.
 *
 * The operator's dotfiles are never touched: Raw simply turns this off.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { VerseTerminalAssistResponse } from '../../../data/api-types.js';
import { ApiError } from '../../../data/client.js';
import type { KeyPlatform } from '../shell/command-keys.js';
import type { InputEditor, InputEditorFactory, InputKeyIntent } from './input-editor.js';
import {
  assistRequest,
  fileIndexQuery,
  ghostFor,
  handOffBytes,
  HistoryWalker,
  pathCompletions,
  pathToken,
  submitBytes,
} from './input-model.js';
import type { PanelTerminalApi } from './panel-client.js';
import styles from './TerminalPanel.module.css';

export interface CommandInputHandle {
  focus(): void;
  getText(): string;
  /** Put a command in the editor (from the palette, a block's "paste") — never run. */
  insert(text: string): void;
  /** ⌘I / "Generate command…": turn the typed text (or a new request) into a command. */
  openAssist(): void;
}

export interface CommandInputProps {
  tabId: string;
  sessionId: string | null;
  cwd: string | null;
  /** At a prompt, and the editor is wanted there. */
  visible: boolean;
  /** Its pane has the keyboard: take focus when a prompt appears. */
  focusWanted: boolean;
  api: PanelTerminalApi;
  createEditor: InputEditorFactory;
  platform: KeyPlatform;
  /** Does the shell accept bracketed paste right now (it turns it on at its prompt)? */
  bracketedPaste: () => boolean;
  /** Bytes to the PTY, in order with everything else typed in this pane. */
  send: (text: string) => void;
  /** The line went to the shell's own editor: the terminal gets the keyboard until the next prompt. */
  onHandOff: () => void;
  /** Ctrl+R, with what was typed. */
  onHistorySearch: (draft: string) => void;
  onError: (text: string) => void;
  /** The panel's own keys (⌘D, ⌘F, ⌥⌘arrows, ⇧⌘Return …) reach it from the editor too; true = taken. */
  onPanelKey?: (event: KeyboardEvent) => boolean;
}

/** Recent history per cwd, shared by every pane: one request per prompt, not per keystroke. */
const historyCache = new Map<string, { at: number; ranked: string[]; recent: string[] }>();
const HISTORY_TTL_MS = 15_000;
const HISTORY_FETCH_LIMIT = 300;

/** Forget cached history (after a clear, or in tests). */
export function resetCommandInputHistoryCache(): void {
  historyCache.clear();
}

export const CommandInput = forwardRef<CommandInputHandle, CommandInputProps>(function CommandInput(props, ref) {
  const { visible, focusWanted, cwd } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InputEditor | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [assistMode, setAssistMode] = useState(false);
  const [assist, setAssist] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; result: VerseTerminalAssistResponse | null; error: string | null }>({ state: 'idle', result: null, error: null });
  /** A generated command flagged risky, not yet confirmed with a second ↩. */
  const riskyPending = useRef<string | null>(null);
  const [riskyWarn, setRiskyWarn] = useState(false);
  const history = useRef<{ ranked: string[]; recent: string[] }>({ ranked: [], recent: [] });
  const walker = useRef(new HistoryWalker(() => history.current.recent));
  const cwdKey = cwd ?? '';

  // -------------------------------------------------------------------------
  // History for this prompt
  // -------------------------------------------------------------------------

  const loadHistory = useCallback(async (force = false) => {
    const api = propsRef.current.api;
    if (!api.history) return;
    const hit = historyCache.get(cwdKey);
    if (hit && !force && Date.now() - hit.at < HISTORY_TTL_MS) {
      history.current = hit;
      return;
    }
    try {
      const res = await api.history({ cwd: cwdKey || null, limit: HISTORY_FETCH_LIMIT });
      const ranked = res.entries.map((e) => e.cmd);
      const recent = [...res.entries].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).map((e) => e.cmd);
      const next = { at: Date.now(), ranked, recent };
      historyCache.set(cwdKey, next);
      history.current = next;
    } catch {
      /* no history (locked, offline, off): the editor still works */
    }
  }, [cwdKey]);

  /** What was just run goes to the front at once (the server's copy lands when the command ends). */
  const remember = useCallback((cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    const front = (list: string[]) => [trimmed, ...list.filter((c) => c !== trimmed)];
    const next = { at: historyCache.get(cwdKey)?.at ?? 0, ranked: front(history.current.ranked), recent: front(history.current.recent) };
    history.current = next;
    // Stale on purpose: the next prompt refetches (exit codes, other panes).
    historyCache.set(cwdKey, { ...next, at: 0 });
  }, [cwdKey]);

  const updateGhost = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setGhost(assistRequest(text) !== null ? null : ghostFor(text, history.current.ranked));
  }, []);

  // -------------------------------------------------------------------------
  // Assist
  // -------------------------------------------------------------------------

  const runAssist = useCallback(async (request: string) => {
    const p = propsRef.current;
    if (!p.api.assist) {
      p.onError('This server cannot generate commands.');
      return;
    }
    setAssistMode(true);
    setAssist({ state: 'loading', result: null, error: null });
    try {
      const result = await p.api.assist({ request, tabId: p.tabId, ...(p.cwd ? { cwd: p.cwd } : {}) });
      setAssist({ state: 'done', result, error: null });
      riskyPending.current = result.risky ? result.command : null;
      setRiskyWarn(false);
      editorRef.current?.setText(result.command);
      editorRef.current?.focus();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 401
        ? 'Unlock actions with the mutation token to generate commands.'
        : err instanceof ApiError && err.detail ? err.detail : 'The command could not be generated.';
      setAssist({ state: 'error', result: null, error: text });
    }
  }, []);

  const resetAssist = useCallback(() => {
    setAssistMode(false);
    setAssist({ state: 'idle', result: null, error: null });
    riskyPending.current = null;
    setRiskyWarn(false);
  }, []);

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  const onKey = useCallback((intent: InputKeyIntent): boolean => {
    const editor = editorRef.current;
    const p = propsRef.current;
    if (!editor) return false;
    const text = editor.getText();
    switch (intent) {
      case 'submit': {
        const request = assistRequest(text);
        if (request !== null) {
          void runAssist(request);
          return true;
        }
        if (text.trim().length > 0 && riskyPending.current !== null && riskyPending.current === text) {
          // A generated command that changes or deletes things: one more ↩ to mean it.
          riskyPending.current = null;
          setRiskyWarn(true);
          return true;
        }
        p.send(submitBytes(text, p.bracketedPaste()));
        remember(text);
        walker.current.reset();
        editor.setText('');
        resetAssist();
        return true;
      }
      case 'history-prev': {
        const prev = walker.current.prev(text);
        if (prev !== null) editor.setText(prev);
        return true;
      }
      case 'history-next': {
        const next = walker.current.next();
        if (next === null) return false;
        editor.setText(next);
        return true;
      }
      case 'history-search':
        p.onHistorySearch(text);
        return true;
      case 'assist': {
        const request = assistRequest(text) ?? (text.trim() ? text.trim() : null);
        if (request) void runAssist(request);
        else {
          setAssistMode(true);
          editor.setText('# ');
        }
        return true;
      }
      case 'interrupt':
        if (text.length > 0) {
          editor.setText('');
          walker.current.reset();
          resetAssist();
        } else {
          p.send('\x03');
        }
        return true;
      case 'eof':
        p.send('\x04');
        return true;
      case 'clear-screen':
        p.send('\x0c');
        return true;
      case 'hand-off':
        if (assistMode && assist.state !== 'idle') {
          resetAssist();
          return true;
        }
        if (text.length > 0) p.send(handOffBytes(text, ''));
        editor.setText('');
        p.onHandOff();
        return true;
      case 'tab':
        p.send(handOffBytes(text, '\t'));
        editor.setText('');
        p.onHandOff();
        return true;
    }
  }, [assist.state, assistMode, remember, resetAssist, runAssist]);

  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  // -------------------------------------------------------------------------
  // The editor: created the first time a prompt shows it, kept afterwards
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!visible || editorRef.current || failed) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    propsRef.current.createEditor({
      host,
      initial: '',
      label: 'Command',
      placeholder: placeholderFor(propsRef.current.platform),
      onChange: (text) => {
        updateGhost(text);
        setAssistMode(assistRequest(text) !== null || text.trimStart().startsWith('#'));
        if (riskyPending.current !== null && text !== riskyPending.current) riskyPending.current = null;
        setRiskyWarn(false);
      },
      onKey: (intent) => onKeyRef.current(intent),
      completePaths: async (text, cursor) => {
        const p = propsRef.current;
        const tok = pathToken(text, cursor);
        if (!tok || !p.sessionId || !p.api.files) return null;
        const files = await p.api.files(p.sessionId, fileIndexQuery(tok.token));
        return { from: tok.from, options: pathCompletions(tok.token, p.cwd, files) };
      },
    }).then((editor) => {
      if (cancelled) {
        editor.dispose();
        return;
      }
      editorRef.current = editor;
      setReady(true);
    }, (err) => {
      console.error('[verse] the command editor failed to load', err);
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [visible, failed, updateGhost]);

  useEffect(() => () => {
    editorRef.current?.dispose();
    editorRef.current = null;
  }, []);

  // Each new prompt: fresh history for where the shell is now, and the keyboard.
  useEffect(() => {
    if (!visible || !ready) return;
    walker.current.reset();
    void loadHistory().then(() => updateGhost(editorRef.current?.getText() ?? ''));
    if (focusWanted) editorRef.current?.focus();
  }, [visible, ready, focusWanted, loadHistory, updateGhost]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getText: () => editorRef.current?.getText() ?? '',
    insert: (text) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setText(text.replace(/[\r\n]+$/, ''));
      editor.focus();
    },
    openAssist: () => { onKeyRef.current('assist'); },
  }), []);

  if (failed) return null;
  const hint = assist.state === 'loading' ? 'Asking the local model…'
    : assist.state === 'error' ? assist.error
      : riskyWarn ? 'This command changes or deletes things. Press Return again to run it.'
        : assist.state === 'done' && assist.result
          ? [assist.result.explanation, `Review, then Return to run · from ${assist.result.provider}`].filter(Boolean).join(' · ')
          : assistMode ? 'Describe what you want, then Return — the command comes back here to review. Nothing runs on its own.'
            : null;

  return (
    <div
      className={styles.inputDock}
      hidden={!visible}
      data-testid={`command-input-${props.tabId}`}
      data-assist={assistMode || undefined}
      // Capture: the panel's chords are taken before the editor sees them.
      onKeyDownCapture={(event) => { if (props.onPanelKey?.(event.nativeEvent)) event.stopPropagation(); }}
    >
      {hint ? (
        <div className={styles.inputHint} role={assist.state === 'error' || riskyWarn ? 'alert' : 'status'} data-tone={assist.state === 'error' || riskyWarn || (assist.result?.risky && assist.state === 'done') ? 'warn' : undefined}>
          {hint}
        </div>
      ) : null}
      <div className={styles.inputRow}>
        <span className={styles.inputPrompt} aria-hidden="true">{assistMode ? '#' : '$'}</span>
        <div ref={hostRef} className={styles.inputEditor} />
      </div>
    </div>
  );
});

function placeholderFor(platform: KeyPlatform): string {
  const assist = platform === 'mac' ? '⌘I' : 'Ctrl+Shift+Alt+I';
  return `Type a command · # or ${assist} to describe it in words · Ctrl+R history · Esc hands off to the shell`;
}
