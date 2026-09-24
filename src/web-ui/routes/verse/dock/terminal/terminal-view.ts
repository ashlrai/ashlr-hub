/**
 * dock/terminal/terminal-view.ts — the one seam between the Terminal pane and
 * xterm.js (unit C4).
 *
 * LAZY. `@xterm/xterm` (≈ 345 KB minified) and its stylesheet load only when
 * a terminal is first shown, as their own chunk — never on the chat's
 * critical path (SPEC-310C budget: chat critical JS ≤ 350 KB). The pane talks
 * to a small `TerminalView` interface, so tests inject a fake (jsdom has no
 * layout or canvas for xterm) and the pane never imports xterm itself.
 *
 * THEME FROM TOKENS. xterm wants concrete colours; the design system forbids
 * raw hex in new UI files and wants every colour to follow the theme. So the
 * palette is declared as CSS custom properties on the pane
 * (TerminalPane.module.css, mapped to design tokens for both themes) and
 * resolved here at runtime — a probe element turns `var(--x)` into a computed
 * colour, a 1×1 canvas normalises any colour syntax to rgb — and re-resolved
 * when the theme changes.
 */
import type { ITheme, Terminal as XtermTerminal } from '@xterm/xterm';

export interface TerminalViewDisposable {
  dispose(): void;
}

export interface TerminalView {
  readonly cols: number;
  readonly rows: number;
  open(host: HTMLElement): void;
  write(data: Uint8Array): void;
  reset(): void;
  focus(): void;
  /** Fit to the host; returns the new size (or null when the host has no size — hidden). */
  fit(): { cols: number; rows: number } | null;
  onData(cb: (data: string) => void): TerminalViewDisposable;
  onBinary(cb: (data: string) => void): TerminalViewDisposable;
  onSelectionChange(cb: () => void): TerminalViewDisposable;
  hasSelection(): boolean;
  getSelection(): string;
  /** Paste as if typed (bracketed when the program asked for it). Never adds Enter. */
  paste(text: string): void;
  /** True while the program in the terminal has bracketed paste on (shells at a prompt do). */
  bracketedPaste(): boolean;
  setTheme(theme: TerminalTheme): void;
  setScreenReaderMode(on: boolean): void;
  /** Return false from `filter` to let a key pass to the page (app shortcuts). */
  setKeyFilter(filter: (event: KeyboardEvent) => boolean): void;
  dispose(): void;
}

export type TerminalTheme = ITheme;

export interface TerminalViewOptions {
  fontFamily: string;
  fontSize: number;
  theme: TerminalTheme;
  screenReaderMode: boolean;
}

export type TerminalViewFactory = (opts: TerminalViewOptions) => Promise<TerminalView>;

/** Scrollback kept by the VIEW (lines). The server keeps its own 256 KB for reattach. */
const VIEW_SCROLLBACK_LINES = 5_000;

let xtermModules: Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]> | null = null;

function loadXtermModules() {
  if (!xtermModules) {
    xtermModules = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit]) => [xterm, fit] as [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]);
    // A failed chunk load must be retryable (the pane offers "Try again").
    xtermModules.catch(() => { xtermModules = null; });
  }
  return xtermModules;
}

/** The real xterm.js view. */
export const createXtermView: TerminalViewFactory = async (opts) => {
  const [{ Terminal }, { FitAddon }] = await loadXtermModules();
  const term: XtermTerminal = new Terminal({
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: VIEW_SCROLLBACK_LINES,
    theme: opts.theme,
    screenReaderMode: opts.screenReaderMode,
    // ⌥ as Meta: word motions (⌥←/⌥→ → ESC b / ESC f) work as in Terminal.app
    // with "Use Option as Meta key".
    macOptionIsMeta: true,
    // Keep dim ANSI text legible on our surfaces in both themes.
    minimumContrastRatio: 3,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;

  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    open(host) {
      if (opened) return;
      opened = true;
      term.open(host);
    },
    write(data) { term.write(data); },
    reset() { term.reset(); },
    focus() { term.focus(); },
    fit() {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return null;
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    onData: (cb) => term.onData(cb),
    onBinary: (cb) => term.onBinary(cb),
    onSelectionChange: (cb) => term.onSelectionChange(cb),
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    paste(text) { term.paste(text); },
    bracketedPaste: () => term.modes.bracketedPasteMode,
    setTheme(theme) { term.options.theme = theme; },
    setScreenReaderMode(on) { term.options.screenReaderMode = on; },
    setKeyFilter(filter) { term.attachCustomKeyEventHandler(filter); },
    dispose() { term.dispose(); },
  };
};

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

/** ITheme key → the custom property TerminalPane.module.css declares for it. */
export const TERMINAL_THEME_VARS: Readonly<Record<keyof Omit<ITheme, 'extendedAnsi'>, string>> = {
  foreground: '--term-fg',
  background: '--term-bg',
  cursor: '--term-cursor',
  cursorAccent: '--term-bg',
  selectionBackground: '--term-selection',
  selectionForeground: '--term-fg',
  selectionInactiveBackground: '--term-selection-inactive',
  scrollbarSliderBackground: '--term-scrollbar',
  scrollbarSliderHoverBackground: '--term-scrollbar-hover',
  scrollbarSliderActiveBackground: '--term-scrollbar-hover',
  overviewRulerBorder: '--term-bg',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white',
};

let canvasCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS colour → `rgb(r, g, b)` / `rgba(…)`, by painting one pixel. Canvas
 * accepts every syntax the browser does (hsl, color-mix, oklch) and the pixel
 * is plain sRGB, which is what xterm parses. Falls back to the input.
 */
export function normalizeCssColor(value: string): string {
  if (typeof document === 'undefined') return value;
  if (canvasCtx === undefined) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      canvasCtx = null;
    }
  }
  const ctx = canvasCtx;
  if (!ctx) return value;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === undefined) return value;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
  } catch {
    return value;
  }
}

/**
 * Read the pane's `--term-*` properties as concrete colours. A probe child
 * with `color: var(--x)` makes the browser resolve every var() and
 * color-mix() for us; unset properties are left out (xterm keeps its default).
 */
export function resolveTerminalTheme(host: HTMLElement): TerminalTheme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const theme: Record<string, string> = {};
  try {
    for (const [key, prop] of Object.entries(TERMINAL_THEME_VARS)) {
      const declared = getComputedStyle(host).getPropertyValue(prop).trim();
      if (!declared) continue;
      probe.style.color = '';
      probe.style.color = `var(${prop})`;
      const computed = getComputedStyle(probe).color;
      if (computed) theme[key] = normalizeCssColor(computed);
    }
  } finally {
    probe.remove();
  }
  return theme as TerminalTheme;
}

/** The host's computed monospace family and size (so the display-size setting reaches the terminal). */
export function resolveTerminalFont(host: HTMLElement): { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(host);
  const size = Number.parseFloat(style.fontSize);
  return {
    fontFamily: style.fontFamily || 'ui-monospace, Menlo, monospace',
    fontSize: Number.isFinite(size) && size >= 11 ? size : 13,
  };
}

/** Call `onChange` when the effective colour theme changes (explicit toggle or OS appearance). */
export function watchThemeChanges(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const root = document.documentElement;
  const observer = typeof MutationObserver === 'function'
    ? new MutationObserver(() => onChange())
    : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'class', 'style'] });
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onMedia = () => onChange();
  media?.addEventListener?.('change', onMedia);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.('change', onMedia);
  };
}
