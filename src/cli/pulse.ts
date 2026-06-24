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

import type { ActivityRollup, BudgetAlert, CostForecast, GovernanceStatus } from '../core/types.js';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

import { C, pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray, magenta } = makeColors(isTty());

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

type BuildForecastFn = (window: '7d' | '30d', cfg: AshlrConfig) => CostForecast;

let _buildForecast: BuildForecastFn | null | undefined = undefined;

async function loadBuildForecast(): Promise<BuildForecastFn | null> {
  if (_buildForecast === undefined) {
    try {
      const mod = await import('../core/observability/forecast.js') as { buildForecast: BuildForecastFn };
      _buildForecast = mod.buildForecast;
    } catch {
      _buildForecast = null;
    }
  }
  return _buildForecast ?? null;
}

type EvalGovernanceFn = (cfg: AshlrConfig) => GovernanceStatus;

let _evalGovernance: EvalGovernanceFn | null | undefined = undefined;

async function loadEvalGovernance(): Promise<EvalGovernanceFn | null> {
  if (_evalGovernance === undefined) {
    try {
      const mod = await import('../core/observability/governance.js') as { evalGovernance: EvalGovernanceFn };
      _evalGovernance = mod.evalGovernance;
    } catch {
      _evalGovernance = null;
    }
  }
  return _evalGovernance ?? null;
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
  const ICON_BY_LEVEL = { over: '●', warn: '◐', ok: '○' } as const;
  const COLOR_BY_LEVEL = { over: red, warn: yellow, ok: green } as const;
  const icon = ICON_BY_LEVEL[budget.level];
  const colorFn = COLOR_BY_LEVEL[budget.level];

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

/** Render the M19 spend-governance status line. */
function renderGovernanceLine(gov: GovernanceStatus): string {
  const ICON = gov.level === 'over' ? '●' : gov.level === 'warn' ? '◐' : '○';
  const colorFn = gov.level === 'over' ? red : gov.level === 'warn' ? yellow : green;
  const levelStr = colorFn(`${ICON} ${gov.level.toUpperCase()}`);
  const detail = gov.capUsd !== null
    ? gray(`  ($${gov.spentUsd.toFixed(2)} / $${gov.capUsd.toFixed(2)} this ${gov.window})`)
    : dim('  (no cap configured)');
  return `${levelStr}${detail}`;
}

/** Render the M15 cost/savings/forecast line (estimates clearly labeled). */
function renderForecastLine(fc: CostForecast): string {
  const spent = `spent ${bold(fmtUsd(fc.spentUsd))} (${fc.window})`;
  const saved = fc.localSavingsUsd > 0
    ? `  ${green(`saved ~${fmtUsd(fc.localSavingsUsd)} vs cloud`)}`
    : `  ${dim('$0 cloud usage')}`;
  const proj = `  ${dim(`projected ~${fmtUsd(fc.projectedMonthlyUsd)}/mo`)}`;
  return `${spent}${saved}${proj}  ${dim('[estimates]')}`;
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

function renderDashboard(rollup: ActivityRollup, forecast?: CostForecast | null, governance?: GovernanceStatus | null): void {
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

  console.log(`  ${bold('Tokens')}   in ${cyan(fmtTokens(totals.tokensIn))}  ` +
    `out ${cyan(fmtTokens(totals.tokensOut))}  ` +
    `total ${bold(cyan(fmtTokens(totalTok)))}`);
  console.log(`  ${bold('Cost')}     ${bold(cyan(fmtUsd(totals.estCostUsd)))}`);
  if (forecast) {
    console.log(`  ${bold('Savings')}  ${renderForecastLine(forecast)}`);
  }
  console.log(`  ${bold('Sessions')} ${cyan(String(totals.sessions))}  ` +
    `${bold('Commits')} ${cyan(String(totals.commits))}`);
  console.log('');

  // ── Budget status ─────────────────────────────────────────────────────────
  console.log(`  ${bold('Budget')}   ${renderBudgetLine(budget)}`);
  if (governance) {
    console.log(`  ${bold('Governance')} ${renderGovernanceLine(governance)}`);
  }
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
  // M62: dispatch `connect` subcommand before dashboard flag parsing
  if (args[0] === 'connect') {
    return cmdPulseConnect(args.slice(1));
  }

  // M89: dispatch `export` subcommand
  if (args[0] === 'export') {
    return cmdPulseExport(args.slice(1));
  }

  // M91: dispatch `test` subcommand (also reachable via `ashlr pulse-test`)
  if (args[0] === 'test') {
    return cmdPulseTest();
  }

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

  // Load buildRollup (lazy; degrades if M5 core not yet built).
  // Load buildForecast lazily; degrades gracefully if M15 module not yet built.
  // Load evalGovernance lazily; degrades gracefully if M19 module not yet built.
  const [buildRollup, buildForecast, evalGovernance] = await Promise.all([
    loadBuildRollup(),
    loadBuildForecast(),
    loadEvalGovernance(),
  ]);

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

  // Build forecast (M15; degrades gracefully when module not yet present)
  const forecastWindow = parsed.window === '1d' ? '7d' : parsed.window;
  let forecast: CostForecast | null = null;
  if (buildForecast) {
    try {
      forecast = buildForecast(forecastWindow, cfg);
    } catch {
      // non-fatal — forecast is best-effort
      forecast = null;
    }
  }

  // Build governance verdict (M19; degrades gracefully when module not yet present)
  let governance: GovernanceStatus | null = null;
  if (evalGovernance) {
    try {
      governance = evalGovernance(cfg);
    } catch {
      // non-fatal — governance is best-effort
      governance = null;
    }
  }

  // Machine output.
  // BACKWARD-COMPAT (M15): emit the ActivityRollup at the TOP LEVEL (as shipped
  // through M14) and attach `forecast` as a purely additive field. Existing
  // consumers — notably the M13 Raycast Pulse extension, which destructures
  // { totals, byProject, byModel, budget } from the top level — keep working,
  // while new consumers read the additive `.forecast`.
  // M19: also attach `governance` as a purely additive field.
  if (parsed.json) {
    const out: ActivityRollup & { forecast: CostForecast | null; governance: GovernanceStatus | null } =
      { ...rollup, forecast, governance };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return rollup.budget.level === 'over' ? 1 : 0;
  }

  // Rich dashboard
  renderDashboard(rollup, forecast, governance);

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
  console.log('  ' + bold('Budget caps + spend governance (M19):'));
  console.log('');
  console.log(`    ${dim('Set in config: ashlr config set telemetry.budgetUsd 10.00')}`);
  console.log(`    ${dim('               ashlr config set telemetry.budgetWindow 7d')}`);
  console.log(`    ${dim('               ashlr config set telemetry.govAction warn   # or block')}`);
  console.log(`    ${dim('Governance: ok <80% cap, warn >=80%, over >cap.')}`);
  console.log(`    ${dim('Advisory by default; use --over-budget to proceed when govAction=block.')}`);
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

// ---------------------------------------------------------------------------
// M89: `ashlr pulse export` / `ashlr pulse-export` — fleet→pulse OTLP export
// ---------------------------------------------------------------------------

/**
 * `ashlr pulse export [--since <iso>] [--dry-run]`
 *
 * Reads fleet state (daemon ticks + inbox proposals) and exports them as
 * OTLP/JSON spans to ashlr-pulse. Requires:
 *   - cfg.pulse.enabled = true  (in ~/.ashlr/config.json)
 *   - ASHLR_PULSE_PAT env var   (PAT; never stored in config)
 *
 * --since <iso>   Only include events at or after this ISO timestamp.
 * --dry-run       Print the OTLP payload on stdout; do NOT POST.
 */
async function cmdPulseExport(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    printExportHelp();
    return 0;
  }

  let sinceTs: string | undefined;
  let dryRun = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--since') {
      const val = args[++i];
      if (!val) {
        process.stderr.write(`${C.red}error:${C.reset} --since requires an ISO timestamp\n`);
        return 2;
      }
      if (isNaN(Date.parse(val))) {
        process.stderr.write(`${C.red}error:${C.reset} --since value is not a valid ISO date: ${val}\n`);
        return 2;
      }
      sinceTs = val;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else {
      process.stderr.write(`${C.red}error:${C.reset} unknown flag: ${a}\n`);
      return 2;
    }
    i++;
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

  // Lazy-import exporter
  let buildFleetSpans: ((sinceTs?: string) => unknown) | null = null;
  let exportToPulse: ((cfg: AshlrConfig, opts?: { sinceTs?: string; dryRun?: boolean }) => Promise<boolean>) | null = null;
  try {
    const mod = await import('../core/fleet/pulse-export.js') as {
      buildFleetSpans: (sinceTs?: string) => unknown;
      exportToPulse: (cfg: AshlrConfig, opts?: { sinceTs?: string; dryRun?: boolean }) => Promise<boolean>;
    };
    buildFleetSpans = mod.buildFleetSpans;
    exportToPulse = mod.exportToPulse;
  } catch {
    process.stderr.write(`${C.red}error:${C.reset} pulse-export requires src/core/fleet/pulse-export.ts (M89 module not yet built).\n`);
    return 1;
  }

  if (dryRun) {
    // Dry-run: print payload without POSTing (no PAT, no cfg.pulse.enabled check)
    const payload = buildFleetSpans!(sinceTs);
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  if (!cfg.pulse?.enabled) {
    process.stderr.write(
      `${C.yellow}warning:${C.reset} cfg.pulse.enabled is not set — nothing exported.\n` +
      `  Add to ~/.ashlr/config.json: { "pulse": { "enabled": true, "endpoint": "https://pulse.ashlr.ai" } }\n`,
    );
    return 0;
  }

  const pat = process.env['ASHLR_PULSE_PAT'];
  if (!pat) {
    process.stderr.write(
      `${C.yellow}warning:${C.reset} ASHLR_PULSE_PAT is not set — nothing exported.\n` +
      `  export ASHLR_PULSE_PAT=<your-pat>\n`,
    );
    return 0;
  }

  console.log(`  Exporting fleet spans to ${C.dim}${cfg.pulse.endpoint ?? 'http://localhost:3000'}${C.reset} …`);
  await exportToPulse!(cfg, { sinceTs });
  console.log(`${C.green}ok${C.reset}  Fleet spans exported.`);
  return 0;
}

function printExportHelp(): void {
  console.log('');
  console.log(`${bold('  ashlr pulse export')}${dim(' — fleet→pulse OTLP exporter (M89)')}`);
  console.log('');
  console.log(`  ${bold('Usage:')}`);
  console.log('');
  console.log(`    ashlr pulse export [--since <iso>] [--dry-run]`);
  console.log(`    ashlr pulse-export [--since <iso>] [--dry-run]`);
  console.log('');
  console.log(`  ${bold('Options:')}`);
  console.log('');
  console.log(`    ${cyan('--since <iso>')}   Only include events at or after this ISO timestamp.`);
  console.log(`    ${cyan('--dry-run')}        Print OTLP payload on stdout; do NOT POST.`);
  console.log('');
  console.log(`  ${bold('Config (in ~/.ashlr/config.json):')}`);
  console.log('');
  console.log(`    ${dim('{ "pulse": { "enabled": true, "endpoint": "https://pulse.ashlr.ai" } }')}`);
  console.log('');
  console.log(`  ${bold('Auth:')}`);
  console.log('');
  console.log(`    ${dim('export ASHLR_PULSE_PAT=<your-personal-access-token>')}`);
  console.log('');
  console.log(`  ${bold('Examples:')}`);
  console.log('');
  console.log(`    ${cyan('ashlr pulse-export --dry-run')}                  ${dim('# preview payload')}`);
  console.log(`    ${cyan('ashlr pulse-export --since 2026-06-01T00:00:00Z')}  ${dim('# backfill')}`);
  console.log(`    ${cyan('ashlr pulse-export')}                            ${dim('# export all history')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// M91: `ashlr pulse-test` / `ashlr pulse test` — connectivity + auth check
// ---------------------------------------------------------------------------

/**
 * `ashlr pulse-test`
 *
 * POSTs a single probe span to cfg.pulse.endpoint with the PAT and reports:
 *   ✓ connected (HTTP 200)
 *   ✗ 401 — PAT rejected (check ASHLR_PULSE_PAT)
 *   ✗ endpoint unreachable (<url>)
 *   ⚠ not configured (set cfg.pulse.enabled + ASHLR_PULSE_PAT)
 *
 * Exit codes: 0=ok, 1=error, 2=unconfigured.
 */
export async function cmdPulseTest(): Promise<number> {
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

  let postProbeSpan: ((cfg: AshlrConfig) => Promise<{ ok: boolean; status: number | null; label: string; exitCode: number }>) | null = null;
  try {
    const mod = await import('../core/fleet/pulse-export.js') as {
      postProbeSpan: (cfg: AshlrConfig) => Promise<{ ok: boolean; status: number | null; label: string; exitCode: number }>;
    };
    postProbeSpan = mod.postProbeSpan;
  } catch {
    process.stderr.write(`${C.red}error:${C.reset} pulse-export module unavailable (M89/M91 not built).\n`);
    return 1;
  }

  const result = await postProbeSpan!(cfg);
  console.log(result.label);
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// M62: `ashlr pulse connect` — hub→pulse bridge configuration + test
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';

/** Secret name used by OtlpHttpSink (PHANTOM_PAT_KEY in telemetry-sink.ts). */
const CONNECT_PHANTOM_PAT_KEY = 'ASHLR_PULSE_TOKEN';
const PHANTOM_BIN = 'phantom';
const DEFAULT_PULSE_ENDPOINT = 'https://pulse.ashlr.ai/api/otlp/v1/traces';

/**
 * `ashlr pulse connect` — configure and test the hub→pulse OTLP bridge.
 *
 * Routes:
 *   connect [<endpoint>] [--token <pat>]   — set endpoint and/or store PAT
 *   connect --status                        — report config state
 *   connect --test                          — send one test span
 *   connect --disconnect                    — clear endpoint
 */
export async function cmdPulseConnect(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printConnectHelp();
    return 0;
  }

  // Route by first flag/arg
  if (args[0] === '--status') return connectStatus();
  if (args[0] === '--test')   return connectTest();
  if (args[0] === '--disconnect') return connectDisconnect();

  // connect [<endpoint>] [--token <pat>]
  return connectSet(args);
}

// ---------------------------------------------------------------------------
// connect <endpoint> [--token <pat>]
// ---------------------------------------------------------------------------

async function connectSet(args: string[]): Promise<number> {
  const { loadConfig, saveConfig } = await import('../core/config.js') as {
    loadConfig: () => import('../core/types.js').AshlrConfig;
    saveConfig: (c: import('../core/types.js').AshlrConfig) => void;
  };

  let endpoint: string | undefined;
  let token: string | undefined;

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--token') {
      const val = args[++i];
      if (!val) {
        process.stderr.write(`${C.red}error:${C.reset} --token requires a value\n`);
        return 2;
      }
      token = val;
    } else if (!a.startsWith('--')) {
      endpoint = a;
    } else {
      process.stderr.write(`${C.red}error:${C.reset} unknown flag: ${a}\n`);
      return 2;
    }
    i++;
  }

  if (!endpoint && !token) {
    process.stderr.write(`${C.red}error:${C.reset} provide an endpoint or --token\n`);
    printConnectHelp();
    return 2;
  }

  const cfg = loadConfig();

  // Write endpoint if provided
  if (endpoint) {
    cfg.telemetry = { ...cfg.telemetry, pulse: endpoint };
    saveConfig(cfg);
    console.log(`${C.green}✓${C.reset} Endpoint saved: ${endpoint}`);
  }

  // Store PAT if provided — via Phantom when available, otherwise instruct env var
  if (token) {
    const stored = storePatViaPhantom(cfg, token);
    if (stored) {
      console.log(`${C.green}✓${C.reset} PAT stored in Phantom vault (key: ${CONNECT_PHANTOM_PAT_KEY})`);
      console.log(`  ${C.dim}The token was passed directly to phantom and is not retained here.${C.reset}`);
    } else {
      // Phantom unavailable — instruct env var path
      console.log(`${C.yellow}!${C.reset} Phantom not available. Set the token as an environment variable:`);
      console.log(`  export ${CONNECT_PHANTOM_PAT_KEY}=<your-token>`);
      console.log(`  ${C.dim}Add to your shell profile (~/.zshrc / ~/.bashrc) for persistence.${C.reset}`);
    }
  }

  // Next steps
  console.log('');
  if (!endpoint) {
    console.log(`  ${C.dim}Tip: set an endpoint with:  ashlr pulse connect ${DEFAULT_PULSE_ENDPOINT}${C.reset}`);
  }
  if (!token) {
    console.log(`  ${C.dim}Tip: store your PAT with:   ashlr pulse connect --token <pat>${C.reset}`);
  }
  console.log(`  Run ${C.cyan}ashlr pulse connect --status${C.reset} to verify configuration.`);
  console.log(`  Run ${C.cyan}ashlr pulse connect --test${C.reset}   to send a test span.`);
  return 0;
}

/**
 * Store the PAT via `phantom add` — value flows through stdin/arg to phantom,
 * never through any log or printed string here. Returns true on success.
 *
 * NEVER prints, logs, stores, or returns the token value itself.
 */
function storePatViaPhantom(cfg: import('../core/types.js').AshlrConfig, _token: string): boolean {
  if (!cfg.phantom?.enabled) return false;

  // Quick binary probe
  const probe = spawnSync(PHANTOM_BIN, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
  });
  if (probe.error || probe.status !== 0) return false;

  // `phantom add KEY VALUE` — token is arg, never logged here
  const result = spawnSync(PHANTOM_BIN, ['add', CONNECT_PHANTOM_PAT_KEY, _token], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// connect --status
// ---------------------------------------------------------------------------

async function connectStatus(): Promise<number> {
  const { loadConfig } = await import('../core/config.js') as {
    loadConfig: () => import('../core/types.js').AshlrConfig;
  };
  const { patAvailable, getSink } = await import('../core/observability/telemetry-sink.js') as {
    patAvailable: (cfg: import('../core/types.js').AshlrConfig, allowPhantomProbe?: boolean) => boolean;
    getSink: (cfg: import('../core/types.js').AshlrConfig) => { emit: (spans: import('../core/types.js').GenAiSpan[]) => Promise<import('../core/types.js').TelemetryEmitResult> };
  };

  const cfg = loadConfig();
  const endpoint = cfg.telemetry?.pulse;
  const hasPat = patAvailable(cfg, true);
  const sink = getSink(cfg);
  // Determine active sink name without emitting
  const sinkName = endpoint && hasPat ? 'OtlpHttpSink' : 'LocalFileSink';

  console.log('');
  console.log(`${C.bold}  ashlr pulse — bridge status${C.reset}`);
  console.log('');
  console.log(`  Endpoint   ${endpoint ? `${C.green}configured${C.reset}  ${C.dim}${endpoint}${C.reset}` : `${C.yellow}not configured${C.reset}`}`);
  console.log(`  PAT        ${hasPat ? `${C.green}available${C.reset}` : `${C.yellow}not found${C.reset}  ${C.dim}(set ASHLR_PULSE_TOKEN or use --token)${C.reset}`}`);
  console.log(`  Active sink  ${C.cyan}${sinkName}${C.reset}`);
  console.log('');

  if (!endpoint) {
    console.log(`  ${C.dim}Run: ashlr pulse connect ${DEFAULT_PULSE_ENDPOINT}${C.reset}`);
  }
  if (!hasPat) {
    console.log(`  ${C.dim}Run: ashlr pulse connect --token <your-pulse-pat>${C.reset}`);
  }
  if (endpoint && hasPat) {
    console.log(`  ${C.green}Ready.${C.reset} Run ${C.cyan}ashlr pulse connect --test${C.reset} to verify end-to-end.`);
  }
  console.log('');

  // Suppress unused variable warning — sink is used for type inference only
  void sink;
  return 0;
}

// ---------------------------------------------------------------------------
// connect --test
// ---------------------------------------------------------------------------

async function connectTest(): Promise<number> {
  const { loadConfig } = await import('../core/config.js') as {
    loadConfig: () => import('../core/types.js').AshlrConfig;
  };
  const { getSink } = await import('../core/observability/telemetry-sink.js') as {
    getSink: (cfg: import('../core/types.js').AshlrConfig, allowPhantomProbe?: boolean) => { emit: (spans: import('../core/types.js').GenAiSpan[]) => Promise<import('../core/types.js').TelemetryEmitResult> };
  };

  const cfg = loadConfig();

  if (!cfg.telemetry?.pulse) {
    console.log(`${C.yellow}not configured${C.reset} — no OTLP endpoint set.`);
    console.log(`  Run: ${C.cyan}ashlr pulse connect ${DEFAULT_PULSE_ENDPOINT}${C.reset}`);
    return 1;
  }

  // Build a minimal test span (metadata only, no content)
  const now = new Date();
  const testSpan: import('../core/types.js').GenAiSpan = {
    name:        'm62-connect-test',
    runId:       `test-${now.getTime()}`,
    model:       'ashlr-hub',
    provider:    'ashlr',
    tier:        'local',
    tokensIn:    0,
    tokensOut:   0,
    estCostUsd:  0,
    status:      'done',
    startTs:     now.toISOString(),
    endTs:       now.toISOString(),
  };

  console.log(`  Sending test span to ${C.dim}${cfg.telemetry.pulse}${C.reset} …`);

  const sink = getSink(cfg, false); // allowPhantomProbe:false — async PAT resolution
  let result: import('../core/types.js').TelemetryEmitResult;
  try {
    result = await sink.emit([testSpan]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`${C.red}error${C.reset}  ${detail}`);
    return 1;
  }

  if (result.ok) {
    console.log(`${C.green}ok${C.reset}     sink=${result.sink}  detail=${result.detail}`);
    return 0;
  } else {
    console.log(`${C.red}fail${C.reset}   sink=${result.sink}  detail=${result.detail}`);
    if (result.detail === 'PAT unavailable') {
      console.log(`  ${C.dim}Store your PAT: ashlr pulse connect --token <pat>${C.reset}`);
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// connect --disconnect
// ---------------------------------------------------------------------------

async function connectDisconnect(): Promise<number> {
  const { loadConfig, saveConfig } = await import('../core/config.js') as {
    loadConfig: () => import('../core/types.js').AshlrConfig;
    saveConfig: (c: import('../core/types.js').AshlrConfig) => void;
  };

  const cfg = loadConfig();

  if (!cfg.telemetry?.pulse) {
    console.log(`${C.dim}Nothing to disconnect — no endpoint was configured.${C.reset}`);
    return 0;
  }

  const prev = cfg.telemetry.pulse;
  const { pulse: _removed, ...rest } = cfg.telemetry;
  cfg.telemetry = rest;
  saveConfig(cfg);

  console.log(`${C.green}✓${C.reset} Endpoint cleared (was: ${C.dim}${prev}${C.reset})`);
  console.log(`  Telemetry will now use LocalFileSink (~/.ashlr/telemetry/).`);
  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printConnectHelp(): void {
  console.log('');
  console.log(`${C.bold}  ashlr pulse connect${C.reset}${C.dim} — configure the hub→pulse OTLP bridge (M62)${C.reset}`);
  console.log('');
  console.log(`  ${C.bold}Usage:${C.reset}`);
  console.log('');
  console.log(`    ashlr pulse connect <endpoint>          Set OTLP endpoint`);
  console.log(`    ashlr pulse connect --token <pat>       Store PAT (Phantom or env)`);
  console.log(`    ashlr pulse connect --status            Show config + active sink`);
  console.log(`    ashlr pulse connect --test              Send one test span`);
  console.log(`    ashlr pulse connect --disconnect        Clear endpoint`);
  console.log('');
  console.log(`  ${C.bold}Default endpoint:${C.reset}`);
  console.log(`    ${DEFAULT_PULSE_ENDPOINT}`);
  console.log('');
  console.log(`  ${C.bold}PAT storage:${C.reset}`);
  console.log(`    Preferred: Phantom vault (key: ${CONNECT_PHANTOM_PAT_KEY})`);
  console.log(`    Fallback:  export ${CONNECT_PHANTOM_PAT_KEY}=<token>`);
  console.log(`    The token is NEVER printed, logged, or stored in config.json.`);
  console.log('');
  console.log(`  ${C.bold}Examples:${C.reset}`);
  console.log('');
  console.log(`    ${C.cyan}ashlr pulse connect${C.reset}                                        ${C.dim}# quick-start with default endpoint${C.reset}`);
  console.log(`    ${C.cyan}ashlr pulse connect https://pulse.ashlr.ai/api/otlp/v1/traces${C.reset}  ${C.dim}# explicit endpoint${C.reset}`);
  console.log(`    ${C.cyan}ashlr pulse connect --token <pat>${C.reset}                          ${C.dim}# store PAT only${C.reset}`);
  console.log(`    ${C.cyan}ashlr pulse connect --status${C.reset}                               ${C.dim}# verify config${C.reset}`);
  console.log(`    ${C.cyan}ashlr pulse connect --test${C.reset}                                 ${C.dim}# live end-to-end test${C.reset}`);
  console.log(`    ${C.cyan}ashlr pulse connect --disconnect${C.reset}                           ${C.dim}# revert to local file sink${C.reset}`);
  console.log('');
}
