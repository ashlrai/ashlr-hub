/**
 * terminal/TerminalLeaf.tsx — one shell on screen (3.15): its xterm view, its
 * live stream, its keystrokes, its command blocks and their markers, find.
 *
 * STREAM. Only a leaf that is on screen streams (one fetch() connection; see
 * layout-model.ts for why that matters); a hidden one catches up from its
 * last seq when shown. A reload replays the server's scrollback and then its
 * blocks (terminal.ts subscribe), so markers and blocks come back too.
 *
 * MARKERS. xterm parses the shell's OSC 133 marks as it writes; on each `A`
 * (a prompt) the leaf marks that line, and on each `C` (a command started)
 * it files the prompt's mark under (frame seq, ordinal) — exactly the key the
 * server gives the block. When the block's frame arrives it finds its line:
 * a status dot beside it (click for its actions), a tick in the scrollbar's
 * overview ruler, ⌘↑/⌘↓ to walk them, and "Show in terminal" from the list.
 *
 * INPUT EDITOR (3.15). The same marks say where the shell is (input-model.ts
 * PromptPhase): at a prompt — after B, before C, not in the alternate screen
 * — the leaf docks CommandInput under the terminal and gives it the keyboard.
 * Typing into the terminal itself at that prompt hands the prompt to the
 * shell's own line editor until the next one; a Raw shell never shows it.
 * 3.15 MANY AGENTS. Over the terminal view: the RUNNING command's sticky
 * header (once its prompt line has scrolled away), a bar offering to open a
 * loopback URL the command printed in the Browser pane, and — after a command
 * fails — the local model's fix chips. Selection of several blocks lives
 * here (its blocks are here); what to do with them is the panel's.

 */
import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { VerseTerminalBlock, VerseTerminalFixResponse, VerseTerminalStreamFrame, VerseTerminalTab } from '../../../data/api-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { IconChevronDown, IconChevronUp, IconX } from '../../../components/primitives/icons.js';
import type { KeyPlatform } from '../shell/command-keys.js';
import { createInputQueue, type InputQueue } from '../dock/terminal/input-queue.js';
import { base64ToBytes } from '../dock/terminal/terminal-client.js';
import type { PanelStreamOpener, TerminalStreamState } from './panel-stream.js';
import { resolveTerminalFont, resolveTerminalTheme, watchThemeChanges } from '../dock/terminal/terminal-view.js';
import { BlockList, type BlockAction, type BlockActionExtra, type BlockListExtras } from './BlockList.js';
import { blockStatus, markerKey, terminalBlockView, upsertBlock, type BlockView } from './blocks-model.js';
import { elapsedLabel, EMPTY_SELECTION, pruneSelection, selectBlock, urlLabel, type BlockSelection } from './block-tools.js';
import { BrowserGlyph } from './extra-glyphs.js';
import { FixChips, type AskTarget } from './FixChips.js';
import extra from './TerminalExtras.module.css';
import type { FileLink } from './file-links.js';
import type { LeafMode } from './layout-model.js';
import type { PanelTerminalApi } from './panel-client.js';
import { keyPassesToPage, panelKeyAction, panelKeyLabel, type PanelKeyAction } from './panel-keys.js';
import { resolvePanelColors, type LineMark, type PanelView, type PanelViewFactory, type ViewDisposable } from './xterm-view.js';
import { CommandInput, type CommandInputHandle } from './CommandInput.js';
import type { VerseTerminalAssistMode } from '../../../data/api-types.js';
import type { InputEditorFactory } from './input-editor.js';
import { inputVisible, isOperatorKeystroke, nextPromptPhase, type PromptPhase } from './input-model.js';
import styles from './TerminalPanel.module.css';

// Dictation (voice/): lazy. The terminal is the `verbatim` surface — the
// words go in exactly as heard, and are NEVER followed by Enter.
const VoiceInput = lazy(() => import('../voice/VoiceInput.js'));

export interface LeafDeps {
  api: PanelTerminalApi;
  createView: PanelViewFactory;
  openStream: PanelStreamOpener;
  platform: KeyPlatform;
  writeClipboard: (text: string) => Promise<void>;
  openUrl: (url: string) => void;
  /** 3.15: the input editor (CodeMirror, lazily). Absent = no input editor (raw terminal only). */
  createInputEditor?: InputEditorFactory;
  /** Start fetching the editor's chunk (a shell whose integration just came up). */
  preloadInputEditor?: () => void;
}

export interface LeafPrefs {
  screenReader: boolean;
  ligatures: boolean;
  gpu: boolean;
  /** 3.15: the input editor at shell prompts (default on; Raw per shell overrides). */
  inputEditor: boolean;
}

export type LeafNotice = { tone: 'error' | 'info'; text: string };

/** 3.15: what the panel lends every leaf for the many-agents block actions. */
export interface LeafExtras {
  /** This tab's bookmarked block ids. */
  bookmarks: ReadonlySet<string>;
  /** Null = fix suggestions are off. */
  loadFix: ((tabId: string, block: BlockView) => Promise<VerseTerminalFixResponse>) | null;
  askTargets: readonly AskTarget[];
  onOpenUrl: (url: string) => void;
  /** Several selected blocks: copy / send / ask about them together. */
  onSelectionAction: (tabId: string, action: 'copy-output' | 'send' | 'ask', blocks: BlockView[], anchor?: HTMLElement) => void;
}

/** What the panel can ask of a leaf. */
export interface LeafHandle {
  focus(): void;
  getSelection(): string;
  clear(): void;
  openFind(): void;
  jumpTo(blockId: string): void;
  size(): { cols: number; rows: number } | null;
  paste(text: string): void;
  /** The shell has printed something (its prompt): a paste will land at a prompt. */
  hasOutput(): boolean;
  /** 3.15: the input editor is showing (at a prompt). */
  inputActive(): boolean;
  /** Put a command where the operator will type next: the input editor, else pasted at the prompt. Never run. */
  insertCommand(text: string): void;
  /** ⌘I: plain words → a command, in the input editor. False when the editor is not showing. */
  openAssist(): boolean;
  /** Write bytes to the shell as if typed (in order with the rest), e.g. a ⌃R handed to the shell. */
  sendText(text: string): void;
  /** 3.15: this tab's blocks as the list shows them (for a link or a request naming one). */
  blocks(): BlockView[];

}

export interface TerminalLeafProps {
  tab: VerseTerminalTab;
  deps: LeafDeps;
  /** On screen (its group is active and the panel is visible). */
  shown: boolean;
  /** The pane keystrokes go to, in its group. */
  focused: boolean;
  mode: LeafMode;
  prefs: LeafPrefs;
  assistMode: VerseTerminalAssistMode;
  onFocus: () => void;
  /** Title, exit, cwd, integration: the panel keeps the tab list. */
  onMeta: (tabId: string, frame: Exclude<VerseTerminalStreamFrame, { type: 'output' } | { type: 'block' }>) => void;
  onBlockAction: (tabId: string, action: BlockAction, block: BlockView, extra?: BlockActionExtra) => void;
  /** A block's dot in the terminal was clicked: its actions, anchored there. */
  onBlockMenu: (tabId: string, block: BlockView, anchor: HTMLElement) => void;
  onKeyAction: (tabId: string, action: PanelKeyAction) => void;
  onSelection: (tabId: string, has: boolean, text: string) => void;
  onNotice: (notice: LeafNotice) => void;
  onStreamState: (tabId: string, state: TerminalStreamState | null) => void;
  onRestart: (tab: VerseTerminalTab) => void;
  onClose: (tab: VerseTerminalTab) => void;
  onError: (err: unknown, fallback: string) => string;
  /** 3.15: this shell uses its own line editor only (no input editor). */
  raw?: boolean;
  /** 3.15: another pane of its group is zoomed: this one is kept (and its view) but not shown. */
  concealed?: boolean;
  /** 3.15: in a grid, how many columns this pane spans (a short last row stretches). */
  gridSpan?: number;
  /** 3.15: ⌃R in the input editor — the panel opens the history palette. */
  onHistorySearch?: (tabId: string, draft: string) => void;
  /** 3.15: the many-agents block actions; absent = the 3.15.0 list. */
  extras?: LeafExtras;

}

interface MarkRecord {
  mark: LineMark;
  deco: ViewDisposable | null;
  tone: string | null;
}

export const TerminalLeaf = forwardRef<LeafHandle, TerminalLeafProps>(function TerminalLeaf(props, ref) {
  const { tab, deps, shown, focused, mode, prefs } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PanelView | null>(null);
  const queueRef = useRef<InputQueue | null>(null);
  const lastSeq = useRef(0);
  const disposers = useRef<ViewDisposable[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blocks, setBlocks] = useState<readonly VerseTerminalBlock[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  /** The server's replay has started arriving (it always opens with the title): "no commands" is true now. */
  const [replayed, setReplayed] = useState(false);
  const [find, setFind] = useState<{ open: boolean; term: string; caseSensitive: boolean; regex: boolean; index: number; count: number }>({
    open: false, term: '', caseSensitive: false, regex: false, index: -1, count: 0,
  });
  const findInput = useRef<HTMLInputElement>(null);
  const findOpenRef = useRef(false);
  findOpenRef.current = find.open;
  const exitedRef = useRef(tab.exited !== null);
  exitedRef.current = tab.exited !== null;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [selection, setSelection] = useState<BlockSelection>(EMPTY_SELECTION);
  /** Fix chips / URL bar dismissed for these blocks (terminal view). */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [clock, setClock] = useState(() => Date.now());

  // Where the shell is (its OSC 133 marks), for the input editor.
  const [phase, setPhase] = useState<PromptPhase>('unknown');
  const [alternate, setAlternate] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const inputRef = useRef<CommandInputHandle>(null);
  const showInput = Boolean(deps.createInputEditor) && prefs.inputEditor && inputVisible({
    phase,
    integration: tab.shellIntegration === 'active',
    alternateScreen: alternate,
    exited: tab.exited !== null,
    raw: props.raw === true,
    handedOff,
    terminalMode: mode === 'terminal',
  });
  const showInputRef = useRef(showInput);
  showInputRef.current = showInput;

  // Seq bookkeeping for markers: frames queued into xterm, C marks seen per frame.
  const writing = useRef<number[]>([]);
  const ordinals = useRef(new Map<number, number>());
  const promptMark = useRef<LineMark | null>(null);
  /** The newest frame xterm has finished parsing. */
  const writtenSeq = useRef(0);
  /** Blocks whose C mark is in a frame not parsed yet. */
  const pendingDecorations = useRef(new Map<string, VerseTerminalBlock>());
  const marks = useRef(new Map<string, MarkRecord>());
  const blocksRef = useRef<readonly VerseTerminalBlock[]>([]);
  blocksRef.current = blocks;

  // -------------------------------------------------------------------------
  // Markers and decorations
  // -------------------------------------------------------------------------

  const decorate = useCallback((block: VerseTerminalBlock) => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (!view || !host) return;
    const rec = marks.current.get(markerKey(block.startSeq, block.ordinal));
    if (!rec || rec.mark.isDisposed) return;
    const status = blockStatus(terminalBlockView(block));
    if (rec.tone === status.tone) return;
    rec.deco?.dispose();
    const colors = resolvePanelColors(host);
    const overviewColor = status.tone === 'ok' ? colors.ok : status.tone === 'error' ? colors.error : status.tone === 'running' ? colors.running : undefined;
    rec.tone = status.tone;
    rec.deco = view.decorate(rec.mark, {
      ...(overviewColor ? { overviewColor } : {}),
      render: (el) => {
        // Added, not assigned: xterm positions the element through its own class.
        el.classList.add(styles.blockDot!);
        // At the line's right end, clear of the prompt (xterm leaves `right` unset for x = 0).
        el.style.left = 'auto';
        el.style.right = '0px';
        el.dataset['tone'] = status.tone;
        el.title = `${block.command || 'command'} — ${status.label}`;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Command block: ${block.command || 'command'}, ${status.label}`);
        el.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const current = blocksRef.current.find((b) => b.id === block.id) ?? block;
          propsRef.current.onBlockMenu(tab.id, terminalBlockView(current), el);
        };
        el.oncontextmenu = el.onclick;
      },
    });
  }, [tab.id]);

  const disposeMarks = useCallback(() => {
    for (const rec of marks.current.values()) {
      rec.deco?.dispose();
      rec.mark.dispose();
    }
    marks.current.clear();
    promptMark.current?.dispose();
    promptMark.current = null;
    ordinals.current.clear();
    pendingDecorations.current.clear();
    writing.current = [];
  }, []);

  /** ⌘↑ / ⌘↓: scroll to the previous / next command's prompt line. */
  const walkRef = useRef((direction: -1 | 1) => {
    const view = viewRef.current;
    if (!view) return;
    const lines = [...marks.current.values()].filter((r) => !r.mark.isDisposed).map((r) => r.mark.line).sort((a, b) => a - b);
    const top = view.viewportY();
    const target = direction < 0 ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
    if (target !== undefined) view.scrollToLine(target);
    else if (direction > 0) view.scrollToBottom();
  });

  /**
   * The panel's own keys, from the terminal or from its input editor. From
   * the editor, ⌘I stays the editor's ("describe it" in place).
   */
  const panelKeyRef = useRef((event: KeyboardEvent, fromTerminal: boolean): boolean => {
    const action = panelKeyAction(event, propsRef.current.deps.platform);
    if (!action || (!fromTerminal && action === 'assist')) return false;
    event.preventDefault();
    if (action === 'prev-block' || action === 'next-block') walkRef.current(action === 'prev-block' ? -1 : 1);
    else propsRef.current.onKeyAction(propsRef.current.tab.id, action);
    return true;
  });

  // -------------------------------------------------------------------------
  // The view
  // -------------------------------------------------------------------------

  const attach = useCallback(async () => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    try {
      const colors = resolvePanelColors(host);
      const view = await deps.createView({
        ...resolveTerminalFont(host),
        theme: resolveTerminalTheme(host),
        screenReaderMode: prefs.screenReader,
        ligatures: prefs.ligatures,
        gpu: prefs.gpu,
        ...(colors.match && colors.active ? { findColors: { match: colors.match, active: colors.active } } : {}),
      });
      if (!hostRef.current) {
        view.dispose();
        return;
      }
      await view.open(host);
      viewRef.current = view;
      const queue = createInputQueue((b64) => deps.api.input(tab.id, b64), {
        onError: (err) => propsRef.current.onNotice({ tone: 'error', text: propsRef.current.onError(err, 'That input did not reach the shell.') }),
      });
      queueRef.current = queue;
      const d = disposers.current;
      d.push(view.onData((data) => {
        if (exitedRef.current) return;
        // Typed into the terminal itself at a prompt the editor was showing: this prompt is the shell's.
        if (showInputRef.current && isOperatorKeystroke(data)) setHandedOff(true);
        queue.pushText(data);
      }));
      if (view.onBufferChange) d.push(view.onBufferChange((alt) => setAlternate(alt)));
      d.push(view.onBinary((data) => { if (!exitedRef.current) queue.pushBinary(data); }));
      d.push(view.onSelectionChange(() => {
        const has = view.hasSelection();
        // A find match selects its text: that is not the operator copying, so no copy-on-select.
        propsRef.current.onSelection(tab.id, has, has && !findOpenRef.current ? view.getSelection() : '');
      }));
      d.push(view.onShellMark((payload) => {
        const seq = writing.current[0];
        const code = payload.split(';', 1)[0];
        setPhase((prev) => nextPromptPhase(prev, payload));
        // A new prompt: whoever had the last one, the editor is offered again.
        if (code === 'A') setHandedOff(false);
        if (code === 'A') {
          promptMark.current?.dispose();
          promptMark.current = view.markCursorLine();
        } else if (code === 'C' && seq !== undefined) {
          const ordinal = ordinals.current.get(seq) ?? 0;
          ordinals.current.set(seq, ordinal + 1);
          const mark = promptMark.current && !promptMark.current.isDisposed ? promptMark.current : view.markCursorLine();
          promptMark.current = null;
          if (!mark) return;
          const key = markerKey(seq, ordinal);
          marks.current.get(key)?.mark.dispose();
          marks.current.set(key, { mark, deco: null, tone: null });
          // The block may already be known (a replay sends blocks after output).
          const block = blocksRef.current.find((b) => b.startSeq === seq && b.ordinal === ordinal);
          if (block) decorate(block);
        }
      }));
      d.push(view.onFindResults((r) => setFind((f) => ({ ...f, index: r.index, count: r.count }))));
      view.setLinkHandlers({
        openUrl: (url) => deps.openUrl(url),
        openFile: (link: FileLink, bufferLine: number) => {
          // A relative path is relative to where the command that PRINTED it
          // ran — the block whose prompt line is the last one above the link —
          // not to wherever the shell has since `cd`-ed.
          let cwd = propsRef.current.tab.cwd ?? null;
          let best = -1;
          for (const block of blocksRef.current) {
            const rec = marks.current.get(markerKey(block.startSeq, block.ordinal));
            if (!rec || rec.mark.isDisposed || rec.mark.line > bufferLine || rec.mark.line < best) continue;
            best = rec.mark.line;
            cwd = block.cwd ?? cwd;
          }
          deps.api.openFile(tab.id, {
            path: link.path,
            ...(link.line !== null ? { line: link.line } : {}),
            ...(link.column !== null ? { column: link.column } : {}),
            ...(cwd ? { cwd } : {}),
          }).catch((err) => propsRef.current.onNotice({ tone: 'error', text: propsRef.current.onError(err, 'That file could not be opened.') }));
        },
      });
      view.setKeyFilter((event) => {
        if (panelKeyRef.current(event, true)) return false;
        return !keyPassesToPage(event, deps.platform);
      });
      setFailed(false);
      setReady(true);
    } catch (err) {
      console.error('[verse] terminal view failed to load', err);
      setFailed(true);
    }
  }, [deps, prefs.gpu, prefs.ligatures, prefs.screenReader, tab.id, decorate]);

  // Mount: the view is created once per leaf; the SERVER keeps the shell when it unmounts.
  useEffect(() => {
    void attach();
    return () => {
      queueRef.current?.dispose();
      queueRef.current = null;
      for (const d of disposers.current) {
        try { d.dispose(); } catch { /* already gone */ }
      }
      disposers.current = [];
      disposeMarks();
      try { viewRef.current?.dispose(); } catch { /* already gone */ }
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per leaf
  }, []);

  useEffect(() => { viewRef.current?.setScreenReaderMode(prefs.screenReader); }, [prefs.screenReader]);
  useEffect(() => { viewRef.current?.setLigatures(prefs.ligatures); }, [prefs.ligatures]);

  // Theme follows the app.
  useEffect(() => watchThemeChanges(() => {
    const host = hostRef.current;
    if (!host) return;
    viewRef.current?.setTheme(resolveTerminalTheme(host));
    for (const rec of marks.current.values()) rec.tone = null;
    for (const block of blocksRef.current) decorate(block);
  }), [decorate]);

  // -------------------------------------------------------------------------
  // Fit + resize
  // -------------------------------------------------------------------------

  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitNow = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const before = { cols: view.cols, rows: view.rows };
    const size = view.fit();
    if (!size) return;
    if (size.cols === before.cols && size.rows === before.rows && size.cols === tab.cols && size.rows === tab.rows) return;
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      deps.api.resize(tab.id, size.cols, size.rows).catch(() => { /* the next fit retries */ });
    }, 80);
  }, [deps.api, tab.id, tab.cols, tab.rows]);

  useEffect(() => {
    if (!shown || !ready || mode !== 'terminal') return undefined;
    fitNow();
    // Shown again (another tab, the Blocks view): a renderer that last drew
    // while hidden has nothing on screen until it redraws.
    viewRef.current?.refresh();
    const host = hostRef.current?.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(host);
    // Web fonts change the cell size once they load.
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    void fonts?.ready?.then(() => requestAnimationFrame(fitNow));
    // A move to another display changes the pixel ratio (and the cell size).
    const dpr = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : null;
    const onDpr = () => requestAnimationFrame(fitNow);
    dpr?.addEventListener?.('change', onDpr);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dpr?.removeEventListener?.('change', onDpr);
    };
  }, [shown, ready, mode, fitNow]);

  useEffect(() => () => { if (resizeTimer.current) clearTimeout(resizeTimer.current); }, []);

  // -------------------------------------------------------------------------
  // The live stream (on screen only)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!shown || !ready) {
      propsRef.current.onStreamState(tab.id, null);
      return undefined;
    }
    const view = viewRef.current;
    if (!view) return undefined;
    const tabId = tab.id;
    const onFrame = (frame: VerseTerminalStreamFrame) => {
      if (frame.type !== 'output') setReplayed(true);
      switch (frame.type) {
        case 'output': {
          if (frame.seq <= lastSeq.current) return;
          // A gap: the server's ring dropped frames this view never got —
          // start over from what it still has rather than draw a torn screen.
          if (lastSeq.current > 0 && frame.seq > lastSeq.current + 1) {
            view.reset();
            disposeMarks();
          }
          const seq = frame.seq;
          writing.current.push(seq);
          view.write(base64ToBytes(frame.dataBase64), () => {
            if (writing.current[0] === seq) writing.current.shift();
            ordinals.current.delete(seq);
            writtenSeq.current = Math.max(writtenSeq.current, seq);
            for (const [id, block] of pendingDecorations.current) {
              if (block.startSeq > writtenSeq.current) continue;
              pendingDecorations.current.delete(id);
              decorate(block);
            }
          });
          lastSeq.current = seq;
          return;
        }
        case 'block': {
          // The ref too: a decoration's click reads the latest record before React re-renders.
          blocksRef.current = upsertBlock(blocksRef.current, frame.block);
          setBlocks(blocksRef.current);
          // Only once xterm has PARSED the frame holding its C mark (writes are async).
          if (frame.block.startSeq <= writtenSeq.current) decorate(frame.block);
          else pendingDecorations.current.set(frame.block.id, frame.block);
          return;
        }
        default:
          propsRef.current.onMeta(tabId, frame);
      }
    };
    const stream = deps.openStream(tabId, () => lastSeq.current, {
      onFrame,
      onState: (state) => propsRef.current.onStreamState(tabId, state),
    });
    return () => stream.close();
  }, [shown, ready, tab.id, deps, decorate, disposeMarks]);

  // Focus follows the pane that should have the keyboard: its input editor at a prompt, else the terminal.
  useEffect(() => {
    if (!(shown && focused && ready && mode === 'terminal')) return;
    if (showInput) inputRef.current?.focus();
    else viewRef.current?.focus();
  }, [shown, focused, ready, mode, showInput]);

  // Fetch the editor's chunk once a shell's integration is up (it will be needed at its first prompt).
  useEffect(() => {
    if (tab.shellIntegration === 'active' && prefs.inputEditor && !props.raw) deps.preloadInputEditor?.();
  }, [tab.shellIntegration, prefs.inputEditor, props.raw, deps]);

  // -------------------------------------------------------------------------
  // Find
  // -------------------------------------------------------------------------

  const runFind = useCallback((term: string, opts: { backwards?: boolean; caseSensitive: boolean; regex: boolean }) => {
    const view = viewRef.current;
    if (!view) return;
    if (!term) {
      view.clearFind();
      setFind((f) => ({ ...f, index: -1, count: 0 }));
      return;
    }
    void view.find(term, { caseSensitive: opts.caseSensitive, regex: opts.regex, ...(opts.backwards ? { backwards: true } : {}) }).catch(() => {
      /* an invalid regex while typing */
    });
  }, []);

  const closeFind = useCallback(() => {
    viewRef.current?.clearFind();
    setFind((f) => ({ ...f, open: false, index: -1, count: 0 }));
    viewRef.current?.focus();
  }, []);

  // -------------------------------------------------------------------------
  // Blocks: jump, walk
  // -------------------------------------------------------------------------

  const jumpTo = useCallback((blockId: string) => {
    const block = blocksRef.current.find((b) => b.id === blockId);
    const view = viewRef.current;
    if (!block || !view) return;
    const rec = marks.current.get(markerKey(block.startSeq, block.ordinal));
    if (rec && !rec.mark.isDisposed) {
      view.scrollToLine(Math.max(0, rec.mark.line - 1));
      view.selectLines(rec.mark.line, rec.mark.line);
    }
    setHighlight(blockId);
  }, []);

  const sendText = useCallback((text: string) => {
    if (exitedRef.current) return;
    queueRef.current?.pushText(text);
  }, []);

  /** Insert text at the shell's own prompt — never a trailing newline, so nothing runs. */
  const pasteAtPrompt = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const clean = text.replace(/[\r\n]+$/, '');
    if (clean.includes('\n') && !view.bracketedPaste()) {
      // Without bracketed paste a shell would RUN each line as it arrives.
      deps.writeClipboard(clean).then(
        () => propsRef.current.onNotice({ tone: 'info', text: 'That command has several lines, so it was copied instead: paste it with ⌘V.' }),
        () => propsRef.current.onNotice({ tone: 'error', text: 'That command has several lines and could not be pasted safely.' }),
      );
    } else {
      view.paste(clean);
    }
    view.focus();
  }, [deps]);

  /**
   * Text for where the operator types next — the input editor at a prompt,
   * else the shell's own prompt. Never run: no Enter is added.
   */
  const pasteText = useCallback((text: string) => {
    if (showInputRef.current && inputRef.current) inputRef.current.insert(text);
    else pasteAtPrompt(text);
  }, [pasteAtPrompt]);
  // Dictated words: one line, verbatim, where the operator types next (no Enter).
  const insertDictated = useCallback((text: string) => pasteText(text.replace(/\s*[\r\n]+\s*/g, ' ').trim()), [pasteText]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (showInputRef.current) inputRef.current?.focus();
      else viewRef.current?.focus();
    },
    getSelection: () => viewRef.current?.getSelection() ?? '',
    clear: () => {
      viewRef.current?.clear();
    },
    openFind: () => {
      setFind((f) => ({ ...f, open: true }));
      setTimeout(() => findInput.current?.select(), 0);
    },
    jumpTo,
    size: () => (viewRef.current && viewRef.current.cols > 1 ? { cols: viewRef.current.cols, rows: viewRef.current.rows } : null),
    hasOutput: () => writtenSeq.current > 0,
    blocks: () => blocksRef.current.map(terminalBlockView),
    // At a prompt with the editor showing, a paste lands in the editor (still not run).

    paste: pasteText,
    inputActive: () => showInputRef.current,
    insertCommand: pasteText,
    openAssist: () => {
      if (!showInputRef.current || !inputRef.current) return false;
      inputRef.current.openAssist();
      return true;
    },
    sendText,
  }), [jumpTo, pasteText, sendText]);

  const blockViews = useMemo(() => blocks.map(terminalBlockView), [blocks]);
  const loadOutput = useCallback(async (block: BlockView) =>
    (await deps.api.blockOutput(tab.id, block.id, 'ansi')).output, [deps.api, tab.id]);
  const onListAction = useCallback((action: BlockAction, block: BlockView, more?: BlockActionExtra) => {
    propsRef.current.onBlockAction(tab.id, action, block, more);
  }, [tab.id]);

  // -------------------------------------------------------------------------
  // 3.15: selection, sticky header, URL bar, fix chips
  // -------------------------------------------------------------------------

  const order = useMemo(() => blockViews.map((b) => b.id), [blockViews]);
  useEffect(() => { setSelection((sel) => pruneSelection(sel, order)); }, [order]);
  const extrasProp = props.extras;
  const listExtras = useMemo<BlockListExtras | undefined>(() => {
    if (!extrasProp) return undefined;
    const loadFix = extrasProp.loadFix;
    return {
      selection,
      onSelect: (id, gesture) => setSelection((sel) => selectBlock(sel, order, id, gesture) ?? sel),
      onClearSelection: () => setSelection(EMPTY_SELECTION),
      onSelectionAction: (action, anchor) => {
        const picked = blockViews.filter((b) => selection.ids.has(b.id));
        if (picked.length > 0) extrasProp.onSelectionAction(tab.id, action, picked, anchor);
      },
      bookmarks: extrasProp.bookmarks,
      loadFix: loadFix ? (block) => loadFix(tab.id, block) : null,
      askTargets: extrasProp.askTargets,
      canRerun: !tab.exited && !tab.agent && !blockViews.some((b) => b.running),
    };
  }, [extrasProp, selection, order, blockViews, tab.id, tab.exited, tab.agent]);

  const latest = blockViews.at(-1) ?? null;
  const running = latest && latest.running && !latest.fullscreen && !tab.agent ? latest : null;
  // The sticky header and its clock tick only while a command runs on screen.
  useEffect(() => {
    if (!running || !shown || mode !== 'terminal') return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, shown, mode]);
  let stickyVisible = false;
  if (running && ready) {
    const block = blocksRef.current.find((b) => b.id === running.id);
    const rec = block ? marks.current.get(markerKey(block.startSeq, block.ordinal)) : undefined;
    const view = viewRef.current;
    // Shown once the command's own prompt line has scrolled out of view (clock re-evaluates it).
    stickyVisible = Boolean(rec && !rec.mark.isDisposed && view && rec.mark.line < view.viewportY());
  }
  const urlBlock = extrasProp && latest && (latest.localUrls?.length ?? 0) > 0 && !dismissed.has(`url:${latest.id}`) ? latest : null;
  const fixBlock = extrasProp && latest && !latest.running && latest.exitCode !== null && latest.exitCode !== 0 && !tab.agent && !dismissed.has(`fix:${latest.id}`) ? latest : null;
  const fixLoadFn = extrasProp?.loadFix ?? null;
  // Keyed on the block's id: a later frame for another block must not ask the model again.
  const fixBlockRef = useRef(fixBlock);
  fixBlockRef.current = fixBlock;
  const fixBlockId = fixBlock?.id ?? null;
  const fixLoad = useMemo(
    () => (fixLoadFn && fixBlockId ? () => fixLoadFn(tab.id, fixBlockRef.current!) : null),
    [fixLoadFn, fixBlockId, tab.id],
  );
  const dismiss = (key: string) => setDismissed((prev) => new Set(prev).add(key));

  const findKey = panelKeyLabel('find', deps.platform);
  const exited = tab.exited;

  return (
    <div
      ref={leafRef}
      className={styles.leaf}
      hidden={props.concealed || undefined}
      data-span={props.gridSpan && props.gridSpan > 1 ? props.gridSpan : undefined}
      data-focused={focused || undefined}
      data-testid={`terminal-leaf-${tab.id}`}
      onMouseDown={() => { if (!focused) props.onFocus(); }}
      onFocusCapture={() => { if (!focused) props.onFocus(); }}
    >
      {find.open ? (
        <div className={styles.find} role="search" aria-label="Find in terminal">
          <input
            ref={findInput}
            className={styles.findInput}
            aria-label="Find"
            placeholder="Find"
            value={find.term}
            autoFocus
            onChange={(e) => {
              const term = e.target.value;
              setFind((f) => ({ ...f, term }));
              runFind(term, { caseSensitive: find.caseSensitive, regex: find.regex });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
              if (e.key === 'Enter') { e.preventDefault(); runFind(find.term, { caseSensitive: find.caseSensitive, regex: find.regex, backwards: e.shiftKey }); }
            }}
          />
          <span className={styles.findCount} aria-live="polite">
            {find.term ? (find.count === 0 ? 'No results' : find.index >= 0 ? `${find.index + 1} of ${find.count}` : `${find.count}+`) : ''}
          </span>
          <button type="button" className={styles.toggle} aria-pressed={find.caseSensitive} title="Match case" aria-label="Match case"
            onClick={() => { const next = !find.caseSensitive; setFind((f) => ({ ...f, caseSensitive: next })); runFind(find.term, { caseSensitive: next, regex: find.regex }); }}>Aa</button>
          <button type="button" className={styles.toggle} aria-pressed={find.regex} title="Regular expression" aria-label="Regular expression"
            onClick={() => { const next = !find.regex; setFind((f) => ({ ...f, regex: next })); runFind(find.term, { caseSensitive: find.caseSensitive, regex: next }); }}>.*</button>
          <button type="button" className={styles.iconBtn} aria-label="Previous match" title="Previous match (⇧Enter)"
            onClick={() => runFind(find.term, { caseSensitive: find.caseSensitive, regex: find.regex, backwards: true })}><IconChevronUp size={14} /></button>
          <button type="button" className={styles.iconBtn} aria-label="Next match" title="Next match (Enter)"
            onClick={() => runFind(find.term, { caseSensitive: find.caseSensitive, regex: find.regex })}><IconChevronDown size={14} /></button>
          <button type="button" className={styles.iconBtn} aria-label="Close find" title={`Close (Esc) — open with ${findKey}`} onClick={closeFind}><IconX size={12} /></button>
        </div>
      ) : null}

      <div
        className={styles.viewport}
        hidden={mode !== 'terminal'}
        onMouseUp={(event) => {
          // A click in the terminal at a prompt (not a selection, not a control like the mic) keeps typing in the editor, as in Warp.
          if ((event.target as HTMLElement | null)?.closest?.('button, a, input, [role="button"]')) return;
          if (showInputRef.current && !viewRef.current?.hasSelection()) setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {running && stickyVisible ? (
          <div className={extra.stickyRun} role="status" aria-label={`Running: ${running.command || 'command'}`}>
            <span className={styles.prompt} aria-hidden="true">$</span>
            <span className={extra.stickyCommand}>{running.command || 'command'}</span>
            <span className={extra.stickyMeta}>{elapsedLabel(clock - Date.parse(running.startedAt))}</span>
            <button type="button" className={styles.iconBtn} aria-label="Jump to the running command" title="Jump to where it started"
              onClick={() => jumpTo(running.id)}>↑</button>
          </div>
        ) : null}

        <div className={styles.host} ref={hostRef} data-testid={`terminal-host-${tab.id}`} />
        {ready && !exited ? (
          <span className={styles.voiceSlot}>
            <Suspense fallback={null}>
              <VoiceInput surface="terminal" mode="verbatim" targetRef={leafRef} onInsert={insertDictated} />
            </Suspense>
          </span>
        ) : null}
        {!ready && !failed ? <div className={styles.viewLoading} aria-hidden="true"><SkeletonLine width="30%" /></div> : null}
        {failed ? (
          <div className={styles.viewLoading} role="alert">
            <p>The terminal could not load. The rest of the chat still works.</p>
            <Button size="sm" variant="subtle" onClick={() => { setFailed(false); void attach(); }}>Try again</Button>
          </div>
        ) : null}
      </div>

      {deps.createInputEditor && prefs.inputEditor && !props.raw && tab.shellIntegration === 'active' ? (
        <CommandInput
          ref={inputRef}
          tabId={tab.id}
          sessionId={tab.sessionId}
          cwd={tab.cwd ?? tab.root}
          visible={showInput}
          focusWanted={shown && focused}
          api={deps.api}
          assistMode={props.assistMode}
          createEditor={deps.createInputEditor}
          platform={deps.platform}
          bracketedPaste={() => viewRef.current?.bracketedPaste() ?? false}
          send={sendText}
          onHandOff={() => {
            setHandedOff(true);
            viewRef.current?.focus();
          }}
          onHistorySearch={(draft) => propsRef.current.onHistorySearch?.(tab.id, draft)}
          onError={(text) => propsRef.current.onNotice({ tone: 'error', text })}
          onPanelKey={(event) => panelKeyRef.current(event, false)}
        />
      ) : null}
      {mode === 'terminal' && urlBlock ? (
        <div className={extra.bar} role="group" aria-label="A local server is up">
          <span className={extra.barLabel}>Serving</span>
          {(urlBlock.localUrls ?? []).map((url) => (
            <button key={url} type="button" className={extra.chip} onClick={() => extrasProp!.onOpenUrl(url)} title={`Open ${url} in the Browser pane`}>
              <BrowserGlyph size={12} /><span className={extra.chipCode}>{urlLabel(url)}</span><span className={extra.chipVerb}>Open in Browser</span>
            </button>
          ))}
          <span className={extra.barSpacer} />
          <button type="button" className={extra.chip} aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(`url:${urlBlock.id}`)}>
            <IconX size={10} />
          </button>
        </div>
      ) : null}
      {mode === 'terminal' && fixBlock ? (
        <FixChips
          key={fixBlock.id}
          variant="bar"
          load={fixLoad}
          askTargets={extrasProp!.askTargets}
          onPaste={(text) => props.onBlockAction(tab.id, 'paste-text', fixBlock, { text })}
          onAsk={(seatId) => props.onBlockAction(tab.id, 'ask-seat', fixBlock, { seatId })}
          onAskMore={(anchor) => props.onBlockAction(tab.id, 'ask', fixBlock, { anchor })}
          onDismiss={() => dismiss(`fix:${fixBlock.id}`)}

        />
      ) : null}

      {mode === 'blocks' && !replayed && blockViews.length === 0 ? (
        <div className={styles.loading} role="status" aria-label="Loading commands"><SkeletonLine width="60%" /><SkeletonLine width="40%" /></div>
      ) : mode === 'blocks' ? (
        <BlockList
          blocks={blockViews}
          loadOutput={loadOutput}
          onAction={onListAction}
          actions={extrasProp
            ? ['copy-output', 'send', 'ask', 'explain', 'rerun', 'bookmark', 'copy-link', 'jump', 'paste']
            : ['copy-output', 'send', 'explain', 'jump', 'paste']}
          {...(listExtras ? { extras: listExtras } : {})}
          highlightId={highlight}
          label={`Commands in ${tab.title}`}
          emptyTitle={tab.shellIntegration === 'off' ? 'No command blocks for this shell' : 'No commands yet'}
          emptyBody={tab.shellIntegration === 'off'
            ? 'Blocks need zsh, bash or fish. This shell still works as a plain terminal.'
            : 'Each command you run here appears as a block: its output, how long it took and how it ended.'}
        />
      ) : null}

      {exited ? (
        <div className={styles.exitBar} role="status">
          <span>
            {exited.signal && exited.code === null
              ? `Shell ended (${exited.signal}).`
              : `Shell exited${exited.code === null ? '' : ` with code ${exited.code}`}.`}
          </span>
          <Button size="sm" variant="subtle" onClick={() => props.onRestart(tab)}>Restart</Button>
          <Button size="sm" variant="ghost" onClick={() => props.onClose(tab)}>Close</Button>
        </div>
      ) : null}
    </div>
  );
});
