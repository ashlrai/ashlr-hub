/**
 * src/tui/render.ts
 *
 * PURE renderer for the interactive TUI dashboard.
 *
 * renderFrame(snap, state) → complete ANSI frame string sized to
 * state.cols × state.rows. No I/O, no side-effects, no timers.
 * Fully testable by snapshotting the returned string.
 *
 * Uses ONLY src/cli/ui.ts helpers (C, stripAnsi, pad, makeColors)
 * and Node built-ins. Zero new runtime deps.
 */

import type { DashboardSnapshot, TuiTab } from '../core/types.js';
import { C, stripAnsi, pad, makeColors } from '../cli/ui.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface RenderState {
  tab: TuiTab;
  selected: number;
  cols: number;
  rows: number;
}

export function renderFrame(snap: DashboardSnapshot, state: RenderState): string {
  const { tab, selected, cols, rows } = state;

  // Always render with color (we're building an ANSI string; callers decide
  // whether to write it to a TTY).
  const col = makeColors(true);

  const lines: string[] = [];

  // 1. Header (logo + tab bar + clock)
  lines.push(...buildHeader(snap, tab, cols, col));

  // 2. Body (tab-specific content)
  const headerRows = lines.length;
  const footerRows = 1;
  const bodyRows = Math.max(0, rows - headerRows - footerRows);
  lines.push(...buildBody(snap, tab, selected, cols, bodyRows, col));

  // 3. Footer (key hints)
  lines.push(buildFooter(cols, col));

  // Clip to rows (never overflow terminal height)
  const clipped = lines.slice(0, rows);

  // Pad to exactly `rows` lines so the alt-screen is fully painted
  while (clipped.length < rows) {
    clipped.push(fitLine('', cols));
  }

  return clipped.join('\n');
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const TABS: { id: TuiTab; label: string; key: string }[] = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'runs',     label: 'Runs',     key: '2' },
  { id: 'swarms',   label: 'Swarms',   key: '3' },
  { id: 'pulse',    label: 'Pulse',    key: '4' },
  { id: 'mcp',      label: 'MCP',      key: '5' },
  { id: 'inbox',    label: 'Inbox',    key: '6' },
];

function buildHeader(
  snap: DashboardSnapshot,
  activeTab: TuiTab,
  cols: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  // Row 1: Logo + clock
  const logo = col.bold(col.cyan(' ashlr hub'));
  const clock = col.dim(formatClock(snap.generatedAt));
  const logoLine = fitLine(
    logo + ' '.repeat(Math.max(1, cols - stripAnsi(logo).length - stripAnsi(clock).length)) + clock,
    cols,
  );

  // Row 2: Tab bar
  const tabParts = TABS.map(t => {
    const label = ` ${t.key}:${t.label} `;
    return t.id === activeTab
      ? col.bold(`\x1b[7m${label}${C.reset}`) // reverse-video for active tab
      : col.dim(label);
  });
  const tabLine = fitLine(tabParts.join(col.dim('│')), cols);

  // Row 3: separator
  const sep = col.dim('─'.repeat(cols));

  return [logoLine, tabLine, sep];
}

// ---------------------------------------------------------------------------
// Body dispatch
// ---------------------------------------------------------------------------

function buildBody(
  snap: DashboardSnapshot,
  tab: TuiTab,
  selected: number,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  switch (tab) {
    case 'overview': return bodyOverview(snap, cols, bodyRows, col);
    case 'runs':     return bodyRuns(snap, selected, cols, bodyRows, col);
    case 'swarms':   return bodySwarms(snap, selected, cols, bodyRows, col);
    case 'pulse':    return bodyPulse(snap, cols, bodyRows, col);
    case 'mcp':      return bodyMcp(snap, selected, cols, bodyRows, col);
    case 'inbox':    return bodyInbox(snap, cols, bodyRows, col);
  }
}

// ---------------------------------------------------------------------------
// Tab: Overview
// ---------------------------------------------------------------------------

function bodyOverview(
  snap: DashboardSnapshot,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(fitLine(s, cols));
  const blank = () => add('');

  blank();

  // ── Repos ─────────────────────────────────────────────────────────────────
  add(col.bold(col.blue(' ◆ Repos')));
  add(
    `   Total: ${col.cyan(String(snap.repos.total))}` +
    `   Dirty: ${snap.repos.dirty > 0 ? col.yellow(String(snap.repos.dirty)) : col.green('0')}` +
    `   Stale: ${snap.repos.stale > 0 ? col.dim(String(snap.repos.stale)) : col.green('0')}`,
  );
  blank();

  // ── Tools ─────────────────────────────────────────────────────────────────
  add(col.bold(col.blue(' ◆ Ecosystem Tools')));
  const toolBar = progressBar(snap.tools.installed, snap.tools.total, 20, col);
  add(`   ${toolBar}  ${col.cyan(String(snap.tools.installed))}/${snap.tools.total} installed`);
  blank();

  // ── Activity ──────────────────────────────────────────────────────────────
  add(col.bold(col.blue(' ◆ Activity (7d)')));
  add(
    `   Sessions: ${col.cyan(String(snap.activity.sessions))}` +
    `   Tokens: ${col.cyan(fmtNum(snap.activity.tokens))}` +
    `   Cost: ${col.yellow('$' + snap.activity.estCostUsd.toFixed(2))}` +
    `   Commits: ${col.cyan(String(snap.activity.commits))}`,
  );
  blank();

  // ── Genome ────────────────────────────────────────────────────────────────
  add(col.bold(col.blue(' ◆ Genome')));
  add(
    `   Entries: ${col.cyan(String(snap.genome.entries))}` +
    `   Projects: ${col.cyan(String(snap.genome.projects))}`,
  );
  blank();

  // ── Quick counts ──────────────────────────────────────────────────────────
  const runCount   = snap.runs.length;
  const swarmCount = snap.swarms.length;
  const mcpCount   = snap.mcp.filter(m => m.ok).length;
  const inboxPend  = snap.inbox?.pending ?? 0;
  add(col.dim(
    `   Runs: ${runCount}   Swarms: ${swarmCount}   MCP servers up: ${mcpCount}/${snap.mcp.length}`,
  ));
  if (inboxPend > 0) {
    blank();
    add(
      col.bold(col.yellow('  ⚠ Inbox: ')) +
      col.yellow(String(inboxPend)) +
      col.yellow(inboxPend === 1 ? ' proposal awaiting approval' : ' proposals awaiting approval') +
      col.dim('  (use `ashlr inbox approve <id>` to act)'),
    );
  }

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Tab: Runs
// ---------------------------------------------------------------------------

function bodyRuns(
  snap: DashboardSnapshot,
  selected: number,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];

  if (snap.runs.length === 0) {
    lines.push(fitLine(col.dim('  (no runs)'), cols));
    return padToRows(lines, bodyRows, cols);
  }

  // Column widths (fixed, then goal gets the rest)
  const idW     = 12;
  const statusW = 10;
  const tokW    = 10;
  const sep     = '  ';
  const goalW   = Math.max(8, cols - idW - statusW - tokW - sep.length * 3 - 1);

  // Header row
  lines.push(fitLine(
    col.bold(
      pad(' ID',       idW) + sep +
      pad('Goal',      goalW) + sep +
      pad('Status',    statusW) + sep +
      pad('Tokens', tokW, 'right'),
    ),
    cols,
  ));
  lines.push(fitLine(col.dim('─'.repeat(cols)), cols));

  snap.runs.forEach((r, i) => {
    const isSelected = i === selected;
    const statusColor = statusColorize(r.status, col);
    const id       = trunc(r.id, idW);
    const goal     = trunc(r.goal, goalW);
    const status   = trunc(r.status, statusW);
    const tokens   = fmtNum(r.tokens);

    const rowText =
      pad(id,     idW)     + sep +
      pad(goal,   goalW)   + sep +
      pad(statusColor(status), statusW) + sep +
      pad(tokens, tokW, 'right');

    lines.push(fitLine(
      isSelected ? `\x1b[7m${rowText}${C.reset}` : rowText,
      cols,
    ));
  });

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Tab: Swarms
// ---------------------------------------------------------------------------

function bodySwarms(
  snap: DashboardSnapshot,
  selected: number,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];

  if (snap.swarms.length === 0) {
    lines.push(fitLine(col.dim('  (no swarms)'), cols));
    return padToRows(lines, bodyRows, cols);
  }

  const idW     = 12;
  const statusW = 10;
  const phaseW  = 12;
  const barW    = 18;
  const sep     = '  ';
  const goalW   = Math.max(8, cols - idW - statusW - phaseW - barW - sep.length * 4 - 1);

  lines.push(fitLine(
    col.bold(
      pad(' ID',    idW)     + sep +
      pad('Goal',   goalW)   + sep +
      pad('Status', statusW) + sep +
      pad('Phase',  phaseW)  + sep +
      pad('Progress', barW),
    ),
    cols,
  ));
  lines.push(fitLine(col.dim('─'.repeat(cols)), cols));

  snap.swarms.forEach((s, i) => {
    const isSelected = i === selected;
    const statusColor = statusColorize(s.status, col);
    const bar = progressBar(s.tasksDone, s.tasksTotal, barW - 8, col);
    const prog = `${bar} ${s.tasksDone}/${s.tasksTotal}`;

    const id     = trunc(s.id,           idW);
    const goal   = trunc(s.goal,         goalW);
    const status = trunc(s.status,       statusW);
    const phase  = trunc(s.phase ?? '—', phaseW);

    const rowText =
      pad(id,                          idW)     + sep +
      pad(goal,                        goalW)   + sep +
      pad(statusColor(status),         statusW) + sep +
      pad(col.dim(phase),              phaseW)  + sep +
      prog;

    lines.push(fitLine(
      isSelected ? `\x1b[7m${rowText}${C.reset}` : rowText,
      cols,
    ));
  });

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Tab: Pulse
// ---------------------------------------------------------------------------

function bodyPulse(
  snap: DashboardSnapshot,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(fitLine(s, cols));
  const blank = () => add('');

  blank();
  add(col.bold(col.blue(' ◆ Activity — 7d Totals')));
  blank();

  const { sessions, tokens, estCostUsd, commits } = snap.activity;
  add(`   Sessions : ${col.cyan(String(sessions))}`);
  add(`   Tokens   : ${col.cyan(fmtNum(tokens))}`);
  add(`   Est. Cost: ${col.yellow('$' + estCostUsd.toFixed(4))}`);
  add(`   Commits  : ${col.cyan(String(commits))}`);
  blank();

  // Mini token bar (visual proportion relative to a reference scale).
  // Clamp to a non-negative floor (defense in depth — fullBar is the
  // load-bearing clamp, but this keeps BAR_W sane on narrow terminals).
  const BAR_W = Math.max(0, Math.min(40, cols - 16));
  if (tokens > 0) {
    add(col.bold(col.blue(' ◆ Token Usage Bar')));
    const bar = fullBar(tokens, BAR_W, col);
    add(`   ${bar}  ${fmtNum(tokens)} tok`);
    blank();
  }

  // Cost breakdown note
  add(col.dim('   Tip: use `ashlr pulse` for full per-project / per-day breakdown.'));

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Tab: MCP
// ---------------------------------------------------------------------------

function bodyMcp(
  snap: DashboardSnapshot,
  selected: number,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];

  if (snap.mcp.length === 0) {
    lines.push(fitLine(col.dim('  (no MCP servers discovered)'), cols));
    return padToRows(lines, bodyRows, cols);
  }

  const statusW = 6;
  const toolsW  = 7;
  const sep     = '  ';
  const nameW   = Math.max(10, cols - statusW - toolsW - sep.length * 2 - 1);

  lines.push(fitLine(
    col.bold(
      pad(' Name',   nameW)   + sep +
      pad('Status',  statusW) + sep +
      pad('Tools', toolsW, 'right'),
    ),
    cols,
  ));
  lines.push(fitLine(col.dim('─'.repeat(cols)), cols));

  snap.mcp.forEach((m, i) => {
    const isSelected = i === selected;
    const statusStr  = m.ok ? col.green('  ●') : col.red('  ●');
    const nameStr    = trunc(m.name, nameW);
    const toolsStr   = String(m.tools);

    const rowText =
      pad(nameStr,  nameW)   + sep +
      pad(statusStr, statusW) + sep +
      pad(toolsStr, toolsW, 'right');

    lines.push(fitLine(
      isSelected ? `\x1b[7m${rowText}${C.reset}` : rowText,
      cols,
    ));
  });

  // Summary
  const upCount = snap.mcp.filter(m => m.ok).length;
  lines.push('');
  lines.push(fitLine(
    col.dim(`  ${upCount}/${snap.mcp.length} servers online`),
    cols,
  ));

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Tab: Inbox (M23 — read-only; approve via `ashlr inbox approve <id>`)
// ---------------------------------------------------------------------------

function bodyInbox(
  snap: DashboardSnapshot,
  cols: number,
  bodyRows: number,
  col: ReturnType<typeof makeColors>,
): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(fitLine(s, cols));
  const blank = () => add('');

  blank();
  add(col.bold(col.blue(' ◆ Inbox — Pending Approvals')));
  blank();

  const pending = snap.inbox?.pending ?? 0;

  if (pending === 0) {
    add(col.dim('   No pending proposals. The inbox is clear.'));
    blank();
    add(col.dim('   Tip: use `ashlr inbox` to list all proposals.'));
    return padToRows(lines, bodyRows, cols);
  }

  // Pending count summary.
  add(
    `   ${col.yellow(String(pending))} ` +
    col.yellow(pending === 1 ? 'proposal' : 'proposals') +
    ' awaiting approval.',
  );
  blank();

  // Instructions — approval is CLI-only, not from the TUI.
  add(col.bold('   To act on a proposal:'));
  add(col.dim('   ashlr inbox              — list pending proposals'));
  add(col.dim('   ashlr inbox show <id>    — view full diff'));
  add(col.dim('   ashlr inbox approve <id> — approve and apply'));
  add(col.dim('   ashlr inbox reject <id>  — reject and discard'));
  blank();
  add(col.dim('   Approval is CLI-only. Nothing applies automatically.'));

  return padToRows(lines, bodyRows, cols);
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function buildFooter(cols: number, col: ReturnType<typeof makeColors>): string {
  const hints = [
    '1-6 tabs',
    'j/k move',
    'r refresh',
    'enter detail',
    'q quit',
  ].map(h => col.dim(h)).join(col.dim('  ·  '));

  return fitLine(' ' + hints, cols);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to `max` visible characters. */
function trunc(s: string, max: number): string {
  const vis = stripAnsi(s);
  if (vis.length <= max) return s;
  return vis.slice(0, Math.max(0, max - 1)) + '…';
}

/** Fit a line to exactly `cols` visible characters (truncate or right-pad). */
function fitLine(s: string, cols: number): string {
  const vis = stripAnsi(s).length;
  if (vis === cols) return s;
  if (vis > cols) {
    // Hard-truncate (strip ANSI first to avoid cutting in the middle of a code)
    return stripAnsi(s).slice(0, cols);
  }
  return s + ' '.repeat(cols - vis);
}

/** Pad body lines to exactly `rows` rows. */
function padToRows(lines: string[], rows: number, cols: number): string[] {
  const out = lines.slice(0, rows);
  while (out.length < rows) {
    out.push(' '.repeat(cols));
  }
  return out;
}

/** A simple ASCII progress bar. */
function progressBar(
  done: number,
  total: number,
  width: number,
  col: ReturnType<typeof makeColors>,
): string {
  const w = Math.max(4, width);
  if (total <= 0) return col.dim('[' + '─'.repeat(w) + ']');
  const fill = Math.round((done / total) * w);
  const filled = '█'.repeat(Math.min(fill, w));
  const empty  = '░'.repeat(Math.max(0, w - fill));
  return '[' + col.green(filled) + col.dim(empty) + ']';
}

/** A full-width decorative bar (for the pulse tab). */
function fullBar(value: number, width: number, col: ReturnType<typeof makeColors>): string {
  // Visual: filled relative to reference of 1M tokens.
  // Total-safe: clamp width to a non-negative floor and clamp fill into
  // [0, w] so '█'/'░'.repeat() can never receive a negative count and throw
  // a RangeError, no matter how narrow the terminal is. This is the
  // load-bearing fix: renderFrame must never throw from the SIGWINCH /
  // keypress / refresh paths (none of which are wrapped in try/catch).
  const REF = 1_000_000;
  const w = Math.max(0, width);
  const fill = w === 0 ? 0 : Math.max(0, Math.min(w, Math.round(Math.min(1, value / REF) * w)));
  return '[' + col.cyan('█'.repeat(fill)) + col.dim('░'.repeat(w - fill)) + ']';
}

/**
 * Color a status string based on known run/swarm lifecycle values.
 * Returns a function that applies the appropriate color.
 */
function statusColorize(
  status: string,
  col: ReturnType<typeof makeColors>,
): (s: string) => string {
  switch (status) {
    case 'done':     return col.green;
    case 'running':  return col.cyan;
    case 'planning': return col.blue;
    case 'failed':
    case 'aborted':  return col.red;
    default:         return col.dim;
  }
}

/** Format a large number with k/M suffixes. */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** Format an ISO timestamp as a short wall-clock string (HH:MM:SS). */
function formatClock(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '';
  }
}
