/**
 * terminal/xterm-view.ts — the Terminal panel's one seam to xterm.js (3.15).
 *
 * Builds on the dock's 3.10 view (terminal-view.ts: lazy chunk, theme from
 * design tokens) with what a Warp-grade terminal needs:
 *
 *   - WebGL rendering where the GPU allows it (falls back to xterm's DOM
 *     renderer on a lost context or no WebGL2), true colour, Unicode 11
 *     widths (emoji, CJK), and programming ligatures (ligatures.ts);
 *   - ⌘F search (@xterm/addon-search, loaded on first use);
 *   - links: URLs and `file:line` references, followed on ⌘-click (Ctrl off
 *     macOS) — a plain click still selects, as in every terminal;
 *   - the shell's OSC 133 marks as they are PARSED (so a block's marker
 *     lands on the exact line), line markers and decorations for blocks.
 *
 * LAZY. Everything here — xterm and every addon — loads in its own chunk
 * the first time a terminal is shown; nothing on the chat's first paint
 * imports this file (terminal-lazy.test.ts pins that). Tests inject a fake
 * view: jsdom has no canvas, WebGL or layout for xterm.
 */
import type { ITheme, Terminal as XtermTerminal, IDisposable, IMarker } from '@xterm/xterm';
import { resolveTerminalTheme, type TerminalTheme } from '../dock/terminal/terminal-view.js';
import { findFileLinks, type FileLink } from './file-links.js';
import { ligatureRanges } from './ligatures.js';

export interface ViewDisposable {
  dispose(): void;
}

/** A line in the terminal's buffer that moves with it as output scrolls. */
export interface LineMark {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface FindOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  backwards?: boolean;
}

export interface LinkHandlers {
  openUrl(url: string): void;
  /** `bufferLine`: the buffer row the link is on (to resolve it against the directory its command ran in). */
  openFile(link: FileLink, bufferLine: number): void;
}

export interface PanelView {
  readonly cols: number;
  readonly rows: number;
  readonly renderer: 'webgl' | 'dom';
  open(host: HTMLElement): Promise<void>;
  write(data: Uint8Array, done?: () => void): void;
  reset(): void;
  /** Clear the screen and scrollback (⌘K in other terminals). */
  clear(): void;
  focus(): void;
  fit(): { cols: number; rows: number } | null;
  /** Redraw every row (after being hidden: a renderer drawn at zero size shows nothing until told). */
  refresh(): void;
  onData(cb: (data: string) => void): ViewDisposable;
  onBinary(cb: (data: string) => void): ViewDisposable;
  onSelectionChange(cb: () => void): ViewDisposable;
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
  bracketedPaste(): boolean;
  setTheme(theme: TerminalTheme): void;
  setScreenReaderMode(on: boolean): void;
  setKeyFilter(filter: (event: KeyboardEvent) => boolean): void;
  setLigatures(on: boolean): void;
  setLinkHandlers(handlers: LinkHandlers): void;
  /** Payloads of OSC 133 (`A`, `C`, `D;0`…) in stream order, as they are parsed. */
  onShellMark(cb: (payload: string) => void): ViewDisposable;
  /** A mark on the cursor's line now; null in the alternate screen. */
  markCursorLine(): LineMark | null;
  decorate(mark: LineMark, opts: { overviewColor?: string; render: (el: HTMLElement) => void }): ViewDisposable | null;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
  /** The buffer line at the top of the viewport. */
  viewportY(): number;
  selectLines(start: number, end: number): void;
  find(term: string, opts?: FindOptions): Promise<boolean>;
  clearFind(): void;
  onFindResults(cb: (r: { index: number; count: number }) => void): ViewDisposable;
  /** 3.15: the alternate screen (vim, less, htop) came or went. Optional: older fakes omit it. */
  onBufferChange?(cb: (alternate: boolean) => void): ViewDisposable;
  isAlternateScreen?(): boolean;
  dispose(): void;
}

export interface PanelViewOptions {
  fontFamily: string;
  fontSize: number;
  theme: TerminalTheme;
  screenReaderMode: boolean;
  ligatures: boolean;
  /** false = never try WebGL (the DOM renderer). */
  gpu: boolean;
  /** Colours for search highlights (#RRGGBB — the addon requires that form). */
  findColors?: { match: string; active: string };
}

export type PanelViewFactory = (opts: PanelViewOptions) => Promise<PanelView>;

/** Scrollback lines the VIEW keeps (the server keeps its own 256 KB for reattach). */
export const PANEL_SCROLLBACK_LINES = 10_000;

type XtermModule = typeof import('@xterm/xterm');
type FitModule = typeof import('@xterm/addon-fit');
type Unicode11Module = typeof import('@xterm/addon-unicode11');
type WebLinksModule = typeof import('@xterm/addon-web-links');

let core: Promise<[XtermModule, FitModule, Unicode11Module, WebLinksModule]> | null = null;

function loadCore() {
  if (!core) {
    core = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-unicode11'),
      import('@xterm/addon-web-links'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit, unicode, links]) => [xterm, fit, unicode, links] as [XtermModule, FitModule, Unicode11Module, WebLinksModule]);
    // A failed chunk load must be retryable (the panel offers "Try again").
    core.catch(() => { core = null; });
  }
  return core;
}

/** ⌘ on macOS, Ctrl elsewhere: the modifier that follows a link. */
export function isLinkModifier(event: MouseEvent, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

function webglAvailable(): boolean {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined' || !('WebGL2RenderingContext' in window)) return false;
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** The real xterm.js view. */
export const createPanelXtermView: PanelViewFactory = async (opts) => {
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = await loadCore();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const term: XtermTerminal = new Terminal({
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: PANEL_SCROLLBACK_LINES,
    theme: opts.theme as ITheme,
    screenReaderMode: opts.screenReaderMode,
    macOptionIsMeta: true,
    minimumContrastRatio: 3,
    // Unicode 11 widths and decorations are "proposed" API in xterm 6.
    allowProposedApi: true,
    // Room for block markers and search hits beside the scrollbar.
    overviewRuler: { width: 8 },
    // Wide glyphs (emoji, CJK) drawn at their real width.
    rescaleOverlappingGlyphs: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  let renderer: 'webgl' | 'dom' = 'dom';
  let webgl: IDisposable | null = null;
  let joiner: number | null = null;
  let links: LinkHandlers | null = null;
  let search: import('@xterm/addon-search').SearchAddon | null = null;
  let searchLoading: Promise<import('@xterm/addon-search').SearchAddon> | null = null;
  const findListeners = new Set<(r: { index: number; count: number }) => void>();
  let opened = false;

  const setLigatures = (on: boolean) => {
    if (on && joiner === null) joiner = term.registerCharacterJoiner(ligatureRanges);
    else if (!on && joiner !== null) {
      term.deregisterCharacterJoiner(joiner);
      joiner = null;
    }
  };

  async function enableWebgl(): Promise<void> {
    if (!opts.gpu || !webglAvailable()) return;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      const addon = new WebglAddon();
      // A lost GPU context (sleep, driver reset, too many contexts) drops
      // back to the DOM renderer instead of a blank terminal.
      addon.onContextLoss(() => {
        addon.dispose();
        webgl = null;
        renderer = 'dom';
      });
      term.loadAddon(addon);
      webgl = addon;
      renderer = 'webgl';
    } catch {
      renderer = 'dom';
    }
  }

  async function ensureSearch() {
    if (search) return search;
    if (!searchLoading) {
      searchLoading = import('@xterm/addon-search').then(({ SearchAddon }) => {
        const addon = new SearchAddon();
        term.loadAddon(addon);
        addon.onDidChangeResults((r) => {
          for (const cb of findListeners) cb({ index: r.resultIndex, count: r.resultCount });
        });
        search = addon;
        return addon;
      });
      searchLoading.catch(() => { searchLoading = null; });
    }
    return searchLoading;
  }

  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    get renderer() { return renderer; },
    async open(host) {
      if (opened) return;
      opened = true;
      term.open(host);
      await enableWebgl();
      setLigatures(opts.ligatures);
      term.loadAddon(new WebLinksAddon((event, uri) => {
        if (links && isLinkModifier(event, mac)) links.openUrl(uri);
      }));
      term.registerLinkProvider({
        provideLinks(y, callback) {
          const line = term.buffer.active.getLine(y - 1);
          if (!line) return callback(undefined);
          const found = findFileLinks(line.translateToString(true));
          if (found.length === 0) return callback(undefined);
          callback(found.map((link) => ({
            range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
            text: line.translateToString(true).slice(link.start, link.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (event: MouseEvent) => {
              if (links && isLinkModifier(event, mac)) links.openFile(link, y - 1);
            },
          })));
        },
      });
    },
    write(data, done) { term.write(data, done); },
    reset() { term.reset(); },
    clear() { term.clear(); },
    focus() { term.focus(); },
    fit() {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return null;
      const changed = dims.cols !== term.cols || dims.rows !== term.rows;
      fit.fit();
      // A resized WebGL canvas is blank until the next write: draw it now.
      if (changed) term.refresh(0, term.rows - 1);
      return { cols: term.cols, rows: term.rows };
    },
    refresh() {
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    },
    onData: (cb) => term.onData(cb),
    onBinary: (cb) => term.onBinary(cb),
    onSelectionChange: (cb) => term.onSelectionChange(cb),
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    paste(text) { term.paste(text); },
    bracketedPaste: () => term.modes.bracketedPasteMode,
    setTheme(theme) { term.options.theme = theme as ITheme; },
    setScreenReaderMode(on) { term.options.screenReaderMode = on; },
    setKeyFilter(filter) { term.attachCustomKeyEventHandler(filter); },
    setLigatures,
    setLinkHandlers(handlers) { links = handlers; },
    onShellMark(cb) {
      return term.parser.registerOscHandler(133, (data) => {
        try { cb(data); } catch { /* a broken listener never breaks parsing */ }
        // Not "handled": xterm has no 133 handler of its own, and another may want it.
        return false;
      });
    },
    markCursorLine() {
      if (term.buffer.active.type !== 'normal') return null;
      const marker = term.registerMarker(0) as IMarker | undefined;
      return marker ?? null;
    },
    decorate(mark, o) {
      const deco = term.registerDecoration({
        marker: mark as IMarker,
        anchor: 'right',
        x: 0,
        width: 2,
        ...(o.overviewColor ? { overviewRulerOptions: { color: o.overviewColor, position: 'right' as const } } : {}),
      });
      if (!deco) return null;
      deco.onRender((el) => o.render(el));
      return deco;
    },
    scrollToLine(line) { term.scrollToLine(Math.max(0, line)); },
    scrollToBottom() { term.scrollToBottom(); },
    viewportY: () => term.buffer.active.viewportY,
    selectLines(start, end) { term.selectLines(start, end); },
    async find(text, o = {}) {
      const addon = await ensureSearch();
      const options = {
        caseSensitive: o.caseSensitive ?? false,
        regex: o.regex ?? false,
        wholeWord: o.wholeWord ?? false,
        ...(opts.findColors ? {
          decorations: {
            matchBackground: opts.findColors.match,
            activeMatchBackground: opts.findColors.active,
            matchOverviewRuler: opts.findColors.match,
            activeMatchColorOverviewRuler: opts.findColors.active,
          },
        } : {}),
      };
      return o.backwards ? addon.findPrevious(text, options) : addon.findNext(text, { ...options, incremental: true });
    },
    clearFind() {
      search?.clearDecorations();
      term.clearSelection();
    },
    onFindResults(cb) {
      findListeners.add(cb);
      return { dispose: () => { findListeners.delete(cb); } };
    },
    onBufferChange: (cb) => term.buffer.onBufferChange((buffer) => cb(buffer.type === 'alternate')),
    isAlternateScreen: () => term.buffer.active.type === 'alternate',
    dispose() {
      findListeners.clear();
      try { webgl?.dispose(); } catch { /* already gone */ }
      term.dispose();
    },
  };
};

// ---------------------------------------------------------------------------
// Colours from tokens
// ---------------------------------------------------------------------------

/** `rgb(…)` / `rgba(…)` → `#rrggbb` (the search addon's required form); null when unparseable. */
export function rgbToHex(value: string): string | null {
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(value.trim());
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
}

/** Concrete colours for the panel's non-palette needs, resolved from its `--term-*` properties. */
export function resolvePanelColors(host: HTMLElement): { ok: string; error: string; running: string; match: string | null; active: string | null } {
  const theme = resolveTerminalTheme(host);
  return {
    ok: theme.green ?? 'green',
    error: theme.red ?? 'red',
    running: theme.yellow ?? 'orange',
    match: theme.selectionBackground ? rgbToHex(theme.selectionBackground) : null,
    active: theme.yellow ? rgbToHex(theme.yellow) : null,
  };
}
