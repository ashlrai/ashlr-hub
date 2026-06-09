/**
 * `ashlr pulse` — rich local observability dashboard.
 *
 * Flags:
 *   --json                  machine-readable ActivityRollup
 *   --window 1d|7d|30d      window (default 7d)
 *   --project <name>        restrict to a single project
 *
 * Renders: window summary (totals + cost), by-project table, top models,
 * budget status (warn/over highlighted). Honors privacy guardrails — prints
 * only aggregate metadata, never content. Returns process exit code.
 *
 * Uses lazy imports so the command degrades gracefully before M5 core modules
 * are built, matching the M3/M4 lazy-import pattern.
 */

import type { ActivityRollup, BudgetAlert } from '../core/types.js';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const IS_TTY = process.stdout.isTTY === true;

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
} as const;

function c(code: string, s: string): string {
  if (!IS_TTY) return s;
  return `${code}${s}${C.reset}`;
}

function bold(s: string):    string { return c(C.bold, s); }
function dim(s: string):     string { return c(C.dim, s); }
function red(s: string):     string { return c(C.red, s); }
function green(s: string):   string { return c(C.green, s); }
function yellow(s: string):  string { return c(C.yellow, s); }
function cyan(s: string):    string { return c(C.cyan, s); }
function gray(s: string):    string { return c(C.gray, s); }
function magenta(s: string): string { return c(C.magenta, s); }

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const vis = stripAnsi(s).length;
  const spaces = Math.max(0, width - vis);
  return align === 'left' ? s + ' '.repeat(spaces) : ' '.repeat(spaces) + s;
}

// ---------------------------------------------------------------------------
// Lazy imports
// ---------------------------------------------------------------------------

type BuildRollupFn = (
  window: '1d' | '7d' | '30d',
  cfg: AshlrConfig,
  opts?: { project?: string },
) => ActivityRollup;

let _buildRollup: BuildRollupFn | null | undefined = undefined;

async function loadBuildRollup(): Promise<BuildRollupFn | null> {
  if (_buildRollup === undefined) {
    try {
      const mod = await import('../core/observability/rollup.js') as { buildRollup: BuildRollupFn };
      _buildRollup = mod.buildRollup;
    } catch {
      _buildRollup = null;
    }
  }
  return _buildRollup ?? null;
}

async function loadConfig(): Promise<AshlrConfig> {
  const mod = await import('../core/config.js') as { loadConfig: () => AshlrConfig };
  return mod.loadConfig();
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedPulseArgs {
  window: '1d' | '7d' | '30d';
  project: string | undefined;
  json: boolean;
  usageError?: string;
}

function parsePulseArgs(args: string[]): ParsedPulseArgs {
  const result: ParsedPulseArgs = {
    window: '7d',
    project: undefined,
    json: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--window') {
      const val = args[++i];
      if (!val || !['1d', '7d', '30d'].includes(val)) {
        result.usageError = `--window requires one of: 1d, 7d, 30d; got: ${val ?? '(missing)'}`;
        return result;
      }
      result.window = val as '1d' | '7d' | '30d';
      i++;
    } else if (arg === '--project') {
      const val = args[++i];
      if (!val) {
        result.usageError = `--project requires a project name`;
        return result;
      }
      result.project = val;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      // handled upstream
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format token count as compact string (e.g. 1.2M, 340K, 512). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Format USD cost. */
function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1)    return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a project path for display — show basename or last 2 segments. */
function fmtProject(p: string): string {
  const parts = p.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return p;
  if (parts.length === 1) return parts[0]!;
  // Show last 2 path segments joined by /
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Format a window label as a human-readable span. */
function fmtWindow(w: string): string {
  switch (w) {
    case '1d':  return 'last 24 hours';
    case '7d':  return 'last 7 days';
    case '30d': return 'last 30 days';
    default:    return w;
  }
}

/** Format an ISO timestamp as a short local date+time. */
function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** Render a budget alert line with appropriate color. */
function renderBudgetLine(budget: BudgetAlert): string {
  const icon = budget.level === 'over' ? '●' : budget.level === 'warn' ? '◐' : '○';
  const colorFn = budget.level === 'over' ? red : budget.level === 'warn' ? yellow : green;

  const parts: string[] = [colorFn(`${icon} ${budget.message}`)];

  if (budget.capUsd !== null) {
    const pct = budget.capUsd > 0 ? Math.round((budget.spentUsd / budget.capUsd) * 100) : 0;
    parts.push(gray(`(${fmtUsd(budget.spentUsd)} / ${fmtUsd(budget.capUsd)} USD  ${pct}%)`));
  }
  if (budget.capTokens !== null) {
    const pct = budget.capTokens > 0 ? Math.round((budget.spentTokens / budget.capTokens) * 100) : 0;
    parts.push(gray(`(${fmtTokens(budget.spentTokens)} / ${fmtTokens(budget.capTokens)} tok  ${pct}%)`));
  }

  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// Sparkline / bar chart for daily usage
// ---------------------------------------------------------------------------

/** Render a compact horizontal bar chart for by-day token totals. */
function renderDayBars(rollup: ActivityRollup): void {
  const days = rollup.byDay;
  if (days.length === 0) {
    console.log(`  ${dim('(no daily data)')}`);
    return;
  }

  const maxTokens = Math.max(...days.map(d => d.tokensIn + d.tokensOut), 1);
  const BAR_WIDTH = 20;

  // Show at most 14 days to keep output tight
  const visible = days.slice(-14);

  for (const day of visible) {
    const total = day.tokensIn + day.tokensOut;
    const barLen = Math.round((total / maxTokens) * BAR_WIDTH);
    const bar = '█'.repeat(barLen) + '░'.repeat(BAR_WIDTH - barLen);

    const dayLabel = day.day.slice(5); // MM-DD
    const tokenStr = pad(fmtTokens(total), 6, 'right');
    const costStr  = fmtUsd(day.estCostUsd);
    const sessStr  = day.sessions > 0 ? gray(`${day.sessions}s`) : gray(' ');

    console.log(
      `  ${gray(dayLabel)}  ${cyan(bar)}  ${pad(tokenStr, 6, 'right')} tok  ` +
      `${pad(costStr, 7, 'right')}  ${sessStr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rich dashboard renderer
// ---------------------------------------------------------------------------

function renderDashboard(rollup: ActivityRollup): void {
  const { window: win, since, totals, byProject, byModel, budget } = rollup;

  // ── Header ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(
    bold('  ashlr pulse') +
    gray(`  —  ${fmtWindow(win)}`) +
    dim(`  (since ${fmtDate(since)})`),
  );
  console.log('');

  // ── Totals summary ────────────────────────────────────────────────────────
  const totalTok = totals.tokensIn + totals.tokensOut;
  const cacheRatio = totals.tokensIn > 0
    ? ''   // cache breakdown not in totals; skip
    : '';

  console.log(`  ${bold('Tokens')}   in ${cyan(fmtTokens(totals.tokensIn))}  ` +
    `out ${cyan(fmtTokens(totals.tokensOut))}  ` +
    `total ${bold(cyan(fmtTokens(totalTok)))}${cacheRatio}`);
  console.log(`  ${bold('Cost')}     ${bold(cyan(fmtUsd(totals.estCostUsd)))}`);
  console.log(`  ${bold('Sessions')} ${cyan(String(totals.sessions))}  ` +
    `${bold('Commits')} ${cyan(String(totals.commits))}`);
  console.log('');

  // ── Budget status ─────────────────────────────────────────────────────────
  console.log(`  ${bold('Budget')}   ${renderBudgetLine(budget)}`);
  console.log('');

  // ── By-project table ─────────────────────────────────────────────────────
  if (byProject.length > 0) {
    const projW    = Math.min(40, Math.max(10, ...byProject.map(p => fmtProject(p.project).length)));
    const sessW    = 5;
    const commitW  = 7;
    const tokW     = 8;
    const costW    = 8;

    console.log(`  ${bold('By Project')}`);
    console.log('');
    console.log(
      `  ${bold(pad('Project', projW))}  ` +
      `${bold(pad('Sess', sessW, 'right'))}  ` +
      `${bold(pad('Commits', commitW, 'right'))}  ` +
      `${bold(pad('Tokens', tokW, 'right'))}  ` +
      `${bold(pad('Cost', costW, 'right'))}`,
    );
    console.log(
      `  ${'─'.repeat(projW)}  ${'─'.repeat(sessW)}  ` +
      `${'─'.repeat(commitW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(costW)}`,
    );

    // Show top 15 projects
    for (const p of byProject.slice(0, 15)) {
      const tokTotal = p.tokensIn + p.tokensOut;
      const nameStr  = fmtProject(p.project);

      console.log(
        `  ${pad(cyan(nameStr), projW)}  ` +
        `${pad(String(p.sessions), sessW, 'right')}  ` +
        `${pad(String(p.commits), commitW, 'right')}  ` +
        `${pad(fmtTokens(tokTotal), tokW, 'right')}  ` +
        `${pad(fmtUsd(p.estCostUsd), costW, 'right')}`,
      );
    }

    if (byProject.length > 15) {
      console.log(`  ${dim(`  … and ${byProject.length - 15} more project(s)`)}`);
    }

    console.log('');
  } else {
    console.log(`  ${dim('No project activity in this window.')}`);
    console.log('');
  }

  // ── Top models ────────────────────────────────────────────────────────────
  if (byModel.length > 0) {
    const modelW = Math.min(44, Math.max(10, ...byModel.slice(0, 8).map(m => m.model.length)));
    const callsW = 6;
    const tokW2  = 8;
    const costW2 = 8;

    console.log(`  ${bold('Top Models')}`);
    console.log('');
    console.log(
      `  ${bold(pad('Model', modelW))}  ` +
      `${bold(pad('Calls', callsW, 'right'))}  ` +
      `${bold(pad('Tokens', tokW2, 'right'))}  ` +
      `${bold(pad('Cost', costW2, 'right'))}`,
    );
    console.log(
      `  ${'─'.repeat(modelW)}  ${'─'.repeat(callsW)}  ` +
      `${'─'.repeat(tokW2)}  ${'─'.repeat(costW2)}`,
    );

    for (const m of byModel.slice(0, 8)) {
      const tokTotal = m.tokensIn + m.tokensOut;
      // Truncate long model ids
      const modelStr = m.model.length > modelW ? m.model.slice(0, modelW - 1) + '…' : m.model;

      // Color model name: local (ollama/lmstudio) = green, cloud = magenta
      const isLocal = /ollama|lmstudio/i.test(m.model);
      const modelColored = isLocal ? green(modelStr) : magenta(modelStr);

      console.log(
        `  ${pad(modelColored, modelW)}  ` +
        `${pad(String(m.calls), callsW, 'right')}  ` +
        `${pad(fmtTokens(tokTotal), tokW2, 'right')}  ` +
        `${pad(fmtUsd(m.estCostUsd), costW2, 'right')}`,
      );
    }

    console.log('');
  }

  // ── Daily activity chart ──────────────────────────────────────────────────
  if (rollup.byDay.length > 0) {
    console.log(`  ${bold('Daily Activity')}  ${dim('(tokens/day)')}`);
    console.log('');
    renderDayBars(rollup);
    console.log('');
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  console.log(dim('  All numbers computed locally from ~/.claude/projects and ~/.ashlr/runs.'));
  if (budget.level !== 'ok') {
    const tip = budget.level === 'over'
      ? `Budget exceeded — check ${bold('ashlr doctor')} for details.`
      : `Approaching budget cap — ${fmtUsd(budget.spentUsd)} spent.`;
    console.log(`  ${yellow('Tip:')} ${tip}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdPulse — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr pulse` — rich local observability dashboard.
 *
 * Flags:
 *   --json                  machine-readable ActivityRollup
 *   --window 1d|7d|30d      window (default 7d)
 *   --project <name>        restrict to a single project
 *
 * Returns process exit code: 0 = ok/warn, 1 = budget over.
 */
export async function cmdPulse(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printPulseHelp();
    return 0;
  }

  const parsed = parsePulseArgs(args);

  if (parsed.usageError) {
    process.stderr.write(
      `${C.red}error:${C.reset} ${parsed.usageError}\n`,
    );
    return 2;
  }

  // Load buildRollup (lazy; degrades if M5 core not yet built)
  const buildRollup = await loadBuildRollup();

  if (!buildRollup) {
    process.stderr.write(
      `${C.red}error:${C.reset} pulse requires src/core/observability/rollup.ts (M5 module not yet built).\n`,
    );
    return 1;
  }

  // Load config
  let cfg: AshlrConfig;
  try {
    cfg = await loadConfig();
  } catch (err) {
    process.stderr.write(
      `${C.red}error:${C.reset} failed to load config: ` +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Build rollup
  let rollup: ActivityRollup;
  try {
    rollup = buildRollup(parsed.window, cfg, { project: parsed.project });
  } catch (err) {
    process.stderr.write(
      `${C.red}error:${C.reset} failed to build rollup: ` +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Machine output
  if (parsed.json) {
    process.stdout.write(JSON.stringify(rollup, null, 2) + '\n');
    return rollup.budget.level === 'over' ? 1 : 0;
  }

  // Rich dashboard
  renderDashboard(rollup);

  return rollup.budget.level === 'over' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printPulseHelp(): void {
  console.log('');
  console.log(bold('  ashlr pulse') + dim(' — local-first observability dashboard'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr pulse [options]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['--window 1d|7d|30d',  'Time window for the rollup (default: 7d).'],
    ['--project <name>',    'Filter to a single project (path basename or full path).'],
    ['--json',              'Emit ActivityRollup JSON on stdout; no ANSI rendering.'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Data sources (local, read-only):'));
  console.log('');
  console.log(`    ${dim('• ~/.claude/projects/**/*.jsonl   — Claude Code session transcripts')}`);
  console.log(`    ${dim('• ~/.ashlr/runs/*.json           — ashlr run records')}`);
  console.log(`    ${dim('• git log per indexed repo       — commit counts')}`);
  console.log('');
  console.log('  ' + bold('Privacy:'));
  console.log('');
  console.log(`    ${dim('• Only usage metadata is read (tokens, model, timestamp, project path).')}`);
  console.log(`    ${dim('• Message content is never read, stored, or printed.')}`);
  console.log('');
  console.log('  ' + bold('Budget caps:'));
  console.log('');
  console.log(`    ${dim('Set in config: ashlr config set telemetry.budgetUsd 10.00')}`);
  console.log(`    ${dim('               ashlr config set telemetry.budgetWindow 7d')}`);
  console.log('');
  console.log('  ' + bold('Exit codes:'));
  console.log('');
  console.log(`    ${dim('0  ok or warn (under/near cap)')}`);
  console.log(`    ${dim('1  budget exceeded (over cap)')}`);
  console.log(`    ${dim('2  bad usage / invalid flag')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr pulse')}                         ${dim('# 7-day dashboard')}`);
  console.log(`    ${cyan('ashlr pulse --window 1d')}             ${dim('# today')}`);
  console.log(`    ${cyan('ashlr pulse --project ashlr-hub')}     ${dim('# single project')}`);
  console.log(`    ${cyan('ashlr pulse --json | jq .totals')}     ${dim('# machine-readable')}`);
  console.log('');
}
