/**
 * src/tui/app.ts — M13 interactive TUI driver.
 *
 * Wires the pure renderer (src/tui/render.ts) to the data aggregator
 * (src/core/dashboard.ts buildSnapshot) and the terminal. Handles all the
 * impure concerns the renderer deliberately avoids:
 *
 *   - Alt-screen buffer enter/leave, cursor hide/show, raw-mode toggling.
 *   - Raw keypress decoding (tab/shift-tab, 1-5, j/k, r, enter, q, Ctrl-C).
 *   - Auto-refresh tick (~2s) that re-reads data sources without blocking.
 *   - Resize awareness (re-render on SIGWINCH).
 *   - GUARANTEED terminal restoration on quit / signal / throw.
 *
 * `runTui(cfg, { once })`:
 *   - once === true  OR  stdout is not a TTY  →  render exactly one frame to
 *     stdout and resolve 0. NEVER enters raw mode or the alt-screen. This is
 *     the headless / scripting / test path (and the safe degraded path for
 *     piped output).
 *   - otherwise → enter the interactive loop and resolve when the user quits.
 *
 * Zero new runtime deps: Node built-ins + cli/ui.ts helpers only.
 */

import { buildSnapshot } from '../core/dashboard.js';
import { renderFrame, type RenderState } from './render.js';
import type { AshlrConfig, DashboardSnapshot, TuiTab } from '../core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered tab list — used for tab/shift-tab cycling and 1-5 selection. */
const TAB_ORDER: TuiTab[] = ['overview', 'runs', 'swarms', 'pulse', 'mcp'];

/** Auto-refresh cadence (ms). */
const REFRESH_MS = 2000;

/** Fallback terminal dimensions when stdout reports none. */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

// Terminal control sequences (kept local so the renderer stays pure).
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_LEAVE = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** An all-zero snapshot used when buildSnapshot fails — keeps the TUI alive. */
function emptySnapshot(): DashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    repos: { total: 0, dirty: 0, stale: 0 },
    tools: { installed: 0, total: 0 },
    activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 0, projects: 0 },
  };
}

/** Build a snapshot, degrading to an empty one on any failure. Never throws. */
async function safeSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot> {
  try {
    return await buildSnapshot(cfg);
  } catch {
    return emptySnapshot();
  }
}

/** Current terminal dimensions, with sane fallbacks. */
function terminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : FALLBACK_COLS;
  const rows = process.stdout.rows && process.stdout.rows > 0
    ? process.stdout.rows
    : FALLBACK_ROWS;
  return { cols, rows };
}

/** Number of selectable rows on the given tab (for j/k bounds). */
function selectableCount(snap: DashboardSnapshot, tab: TuiTab): number {
  switch (tab) {
    case 'runs':   return snap.runs.length;
    case 'swarms': return snap.swarms.length;
    case 'mcp':    return snap.mcp.length;
    default:       return 0; // overview / pulse have no row selection
  }
}

// ---------------------------------------------------------------------------
// runTui — public entry point
// ---------------------------------------------------------------------------

/**
 * Drive the TUI.
 *
 * @param cfg   Loaded hub config (passed straight through to buildSnapshot).
 * @param opts  { once } — render a single frame and exit when true.
 * @returns     Process exit code (0 on success). Never rejects.
 */
export async function runTui(
  cfg: AshlrConfig,
  opts: { once: boolean },
): Promise<number> {
  const interactive = !opts.once && process.stdout.isTTY === true && process.stdin.isTTY === true;

  // Headless / --once / non-TTY → one frame to stdout, no raw mode, no alt-screen.
  if (!interactive) {
    return renderOnce(cfg);
  }

  return runInteractive(cfg);
}

// ---------------------------------------------------------------------------
// --once / non-TTY path
// ---------------------------------------------------------------------------

/** Render exactly one frame to stdout and resolve 0. Never throws. */
async function renderOnce(cfg: AshlrConfig): Promise<number> {
  try {
    const snap = await safeSnapshot(cfg);
    const { cols, rows } = terminalSize();
    const state: RenderState = { tab: 'overview', selected: 0, cols, rows };
    const frame = renderFrame(snap, state);
    process.stdout.write(frame + '\n');
    return 0;
  } catch {
    // Absolute last-resort guard — should be unreachable given safeSnapshot.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Interactive path
// ---------------------------------------------------------------------------

async function runInteractive(cfg: AshlrConfig): Promise<number> {
  const out = process.stdout;
  const input = process.stdin;

  let tab: TuiTab = 'overview';
  let selected = 0;
  let snap = await safeSnapshot(cfg);
  let lastFrame = '';
  let timer: NodeJS.Timeout | null = null;
  let refreshing = false;
  let restored = false;
  let resolveLoop: ((code: number) => void) | null = null;

  // ── Terminal lifecycle ──────────────────────────────────────────────────
  function enterTerminal(): void {
    out.write(ALT_SCREEN_ENTER + CURSOR_HIDE + CLEAR_SCREEN + CURSOR_HOME);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
  }

  /** Restore the terminal to a sane state. Idempotent — safe to call twice. */
  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      if (typeof input.setRawMode === 'function' && input.isTTY) input.setRawMode(false);
    } catch {
      /* ignore */
    }
    input.pause();
    input.removeListener('data', onKey);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGWINCH', onResize);
    // Drop the last-resort backstops so they don't leak across a normal quit.
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    // Show cursor + leave alt-screen LAST so the prior terminal contents return.
    out.write(CURSOR_SHOW + ALT_SCREEN_LEAVE);
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  function clampSelection(): void {
    const max = selectableCount(snap, tab);
    if (max <= 0) {
      selected = 0;
    } else if (selected >= max) {
      selected = max - 1;
    } else if (selected < 0) {
      selected = 0;
    }
  }

  function paint(): void {
    clampSelection();
    const { cols, rows } = terminalSize();
    const state: RenderState = { tab, selected, cols, rows };
    const frame = renderFrame(snap, state);
    if (frame === lastFrame) return; // skip redundant repaints
    lastFrame = frame;
    out.write(CURSOR_HOME + frame);
  }

  // ── Data refresh (bounded, never blocks the loop) ───────────────────────
  async function refresh(): Promise<void> {
    if (refreshing || restored) return;
    refreshing = true;
    try {
      snap = await safeSnapshot(cfg);
      if (!restored) paint();
    } finally {
      refreshing = false;
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────────
  function finish(code: number): void {
    restoreTerminal();
    if (resolveLoop) {
      const r = resolveLoop;
      resolveLoop = null;
      r(code);
    }
  }

  function onSignal(): void {
    finish(0);
  }

  /**
   * Last-resort backstop: if anything in the event-handler / refresh-tick
   * chain throws (e.g. a renderer regression), restore the terminal before
   * the process dies so we never leave alt-screen + hidden cursor + raw mode.
   */
  function onFatal(err: unknown): void {
    restoreTerminal();
    if (resolveLoop) {
      const r = resolveLoop;
      resolveLoop = null;
      r(1);
    }
    // Surface the original error after the terminal is sane.
    console.error(err);
  }

  function onResize(): void {
    if (restored) return;
    try {
      // Force a full clear so a shrunk terminal doesn't leave stale rows.
      lastFrame = '';
      out.write(CLEAR_SCREEN);
      paint();
    } catch {
      // Never let a resize repaint corrupt the terminal.
      finish(1);
    }
  }

  function cycleTab(dir: 1 | -1): void {
    const idx = TAB_ORDER.indexOf(tab);
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
    tab = TAB_ORDER[next]!;
    selected = 0;
    paint();
  }

  function moveSelection(delta: 1 | -1): void {
    const max = selectableCount(snap, tab);
    if (max <= 0) return;
    selected = Math.min(max - 1, Math.max(0, selected + delta));
    paint();
  }

  function onKeyRaw(key: string): void {
    if (restored) return;

    // Ctrl-C / q → quit.
    if (key === '' || key === 'q' || key === 'Q') {
      finish(0);
      return;
    }

    // Numeric tab selection (1-5).
    if (key >= '1' && key <= '5') {
      const idx = Number(key) - 1;
      if (idx < TAB_ORDER.length) {
        tab = TAB_ORDER[idx]!;
        selected = 0;
        paint();
      }
      return;
    }

    switch (key) {
      case '\t': // Tab → next tab
        cycleTab(1);
        return;
      case '\x1b[Z': // Shift-Tab → previous tab
        cycleTab(-1);
        return;
      case 'j':
      case '\x1b[B': // Down arrow
        moveSelection(1);
        return;
      case 'k':
      case '\x1b[A': // Up arrow
        moveSelection(-1);
        return;
      case 'r':
      case 'R':
        void refresh();
        return;
      case '\r':
      case '\n':
        // Enter → "open detail". The renderer already highlights the selected
        // row; a dedicated detail pane is out of scope for M13, so Enter
        // triggers an immediate refresh of the focused tab (cheap, useful,
        // and never leaves the alt-screen). Reads only — no outward action.
        void refresh();
        return;
      default:
        return;
    }
  }

  /** Keypress entry point — guarded so a renderer throw can never corrupt
   *  the terminal (restoreTerminal runs before the process dies). */
  function onKey(key: string): void {
    try {
      onKeyRaw(key);
    } catch (err) {
      onFatal(err);
    }
  }

  // ── Wire up + run ───────────────────────────────────────────────────────
  return new Promise<number>((resolve) => {
    resolveLoop = resolve;
    try {
      enterTerminal();
      paint();

      input.on('data', onKey);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('SIGWINCH', onResize);
      // Process-level backstops: guarantee terminal restoration even if a
      // throw escapes a sync event listener or the refresh tick. Removed in
      // restoreTerminal() so they don't leak across a normal quit.
      process.once('uncaughtException', onFatal);
      process.once('unhandledRejection', onFatal);

      timer = setInterval(() => void refresh(), REFRESH_MS);
      // Don't let the refresh timer keep the event loop alive on its own.
      if (typeof timer.unref === 'function') timer.unref();
    } catch {
      // Any failure setting up the interactive loop must restore the terminal
      // and resolve cleanly rather than leaving it corrupted.
      finish(0);
    }
  });
}
