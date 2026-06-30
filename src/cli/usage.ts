/**
 * `ashlr usage` CLI command — M194: frontier-usage table.
 *
 * Usage:
 *   ashlr usage [--json]
 *
 * Prints a glanceable per-engine usage table:
 *   engine  calls/today  tokens/today  cost/today  window-state  used%  remaining  resets-in
 *
 * Data sources (all read-only, all local, never throws):
 *   - ~/.ashlr/fleet/quota.json        (dispatch ledger)
 *   - codex session files              (subscription rate limits)
 *   - ~/.claude/projects + .ashlr/runs (observability rollup for tokens/cost)
 *
 * With --json: prints the raw FrontierUsage JSON object.
 */

import { makeColors, isTty } from './ui.js';

const { bold, dim, cyan, green, yellow, red } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === 0) return dim('—');
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtCost(n: number | undefined): string {
  if (n === undefined || n === 0) return dim('—');
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function fmtResetIn(resetsAt: number | undefined): string {
  if (!resetsAt) return dim('—');
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return dim('now');
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtState(
  state: 'active' | 'near' | 'exhausted' | 'unknown',
  usedPct: number,
): string {
  const pct = `${usedPct}%`;
  switch (state) {
    case 'active':    return green(pct);
    case 'near':      return yellow(pct);
    case 'exhausted': return red(pct);
    case 'unknown':   return dim('—');
  }
}

function usageBar(usedPct: number, width = 12): string {
  const filled = Math.round((Math.min(usedPct, 100) / 100) * width);
  const empty  = width - filled;
  const bar    = '█'.repeat(filled) + '░'.repeat(empty);
  if (usedPct >= 90) return red(bar);
  if (usedPct >= 80) return yellow(bar);
  return green(bar);
}

function pad(s: string, len: number): string {
  // Strip ANSI escape codes for width calculation.
  // eslint-disable-next-line no-control-regex -- ESC (\x1b) is the ANSI CSI introducer
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, len - plain.length));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderTable(usage: import('../core/usage/frontier-usage.js').FrontierUsage): void {
  console.log('');
  console.log(bold('  Frontier Usage') + dim(' — ' + new Date(usage.generatedAt).toLocaleTimeString()));
  console.log('');

  const COL_ENGINE  = 10;
  const COL_CALLS   = 8;
  const COL_TOKENS  = 10;
  const COL_COST    = 9;
  const COL_BAR     = 14;
  const COL_PCT     = 7;
  const COL_REMAIN  = 10;
  const COL_RESET   = 9;

  // Header
  const header = [
    pad(dim('engine'),  COL_ENGINE),
    pad(dim('calls'),   COL_CALLS),
    pad(dim('tokens'),  COL_TOKENS),
    pad(dim('cost'),    COL_COST),
    pad(dim('window'),  COL_BAR),
    pad(dim('used%'),   COL_PCT),
    pad(dim('remain'),  COL_REMAIN),
    pad(dim('resets'),  COL_RESET),
  ].join('  ');
  console.log('  ' + header);
  console.log('  ' + dim('─'.repeat(80)));

  if (usage.engines.length === 0) {
    console.log('  ' + dim('No frontier engines configured.'));
    console.log('');
    return;
  }

  for (const e of usage.engines) {
    const sw = e.subscriptionWindow;
    const bar = sw.state !== 'unknown' ? usageBar(sw.usedPct) : dim('░'.repeat(12));
    const row = [
      pad(cyan(String(e.engine)), COL_ENGINE),
      pad(String(e.callsToday),   COL_CALLS),
      pad(fmtTokens(e.tokensToday), COL_TOKENS),
      pad(fmtCost(e.costToday),   COL_COST),
      pad(bar,                    COL_BAR),
      pad(fmtState(sw.state, sw.usedPct), COL_PCT),
      pad(e.remainingEstimate !== undefined
            ? String(e.remainingEstimate) + (e.limit ? dim(`/${e.limit}`) : '')
            : dim('unlimited'),
          COL_REMAIN),
      pad(fmtResetIn(sw.resetsAt), COL_RESET),
    ].join('  ');
    console.log('  ' + row);
  }

  console.log('');

  // Legend / notes
  const notes: string[] = [];
  for (const e of usage.engines) {
    const sw = e.subscriptionWindow;
    if (sw.state === 'near' || sw.state === 'exhausted') {
      const wl = sw.windowLabel ? ` (${sw.windowLabel} window)` : '';
      notes.push(
        `  ${yellow('⚠')}  ${bold(String(e.engine))} subscription ${sw.usedPct}% used${wl}` +
        (sw.resetsAt ? ` — resets in ${fmtResetIn(sw.resetsAt)}` : ''),
      );
    }
    if (e.tokensToday === undefined && e.costToday === undefined) {
      notes.push(
        `  ${dim(`${e.engine}: no token/cost data (run \`ashlr serve\` to see Pulse for full history)`)}`,
      );
    }
  }
  for (const note of notes) {
    console.log(note);
  }
  if (notes.length > 0) console.log('');

  // Footnote for estimates
  const hasLimitedEngine = usage.engines.some((e) => e.limit !== undefined);
  if (hasLimitedEngine) {
    console.log(
      '  ' + dim('Calls are from the local quota ledger (dispatches). ') +
      dim('"remain" is an estimate (limit − calls in window).'),
    );
    console.log('');
  }

  console.log(
    '  ' + dim('Run `ashlr serve --open` to see the live dashboard with Frontier Usage panel.'),
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdUsage
// ---------------------------------------------------------------------------

export async function cmdUsage(args: string[]): Promise<number> {
  let jsonMode = false;

  for (const arg of args) {
    if (arg === '--json') {
      jsonMode = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(red('error: ') + `Unknown flag: ${arg}`);
      console.error(dim('Run `ashlr usage --help` for usage.'));
      return 2;
    }
  }

  // Load config + getFrontierUsage
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await import('../core/config.js') as {
      loadConfig: () => import('../core/types.js').AshlrConfig;
    };
    cfg = loadConfig();
  } catch {
    // Degrade to minimal empty config
    cfg = {} as import('../core/types.js').AshlrConfig;
  }

  let usage: import('../core/usage/frontier-usage.js').FrontierUsage;
  try {
    const { getFrontierUsage } = await import('../core/usage/frontier-usage.js') as {
      getFrontierUsage: (cfg: import('../core/types.js').AshlrConfig) => Promise<import('../core/usage/frontier-usage.js').FrontierUsage>;
    };
    usage = await getFrontierUsage(cfg);
  } catch (err) {
    console.error(red('error: ') + 'Failed to get frontier usage: ' + String(err));
    return 1;
  }

  if (jsonMode) {
    console.log(JSON.stringify(usage, null, 2));
  } else {
    renderTable(usage);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  const { bold: b, dim: d, cyan: c } = makeColors(isTty());
  console.log('');
  console.log(b('  ashlr usage') + d(' [--json]'));
  console.log('');
  console.log('  Show per-engine frontier usage: calls, tokens, cost, and window state.');
  console.log('');
  console.log('  ' + b('Options:'));
  console.log(`    ${c('--json')}   Print raw JSON instead of the table`);
  console.log('');
  console.log('  ' + b('Sources (all local, read-only):'));
  console.log(`    ${d('• ~/.ashlr/fleet/quota.json         dispatch ledger (calls per engine)')}`);
  console.log(`    ${d('• codex session files               real subscription rate-limit %')}`);
  console.log(`    ${d('• ~/.claude/projects + .ashlr/runs  token/cost rollup (last 1d)')}`);
  console.log('');
  console.log('  ' + b('Examples:'));
  console.log(`    ${c('ashlr usage')}           # table view`);
  console.log(`    ${c('ashlr usage --json')}    # machine-readable JSON`);
  console.log('');
}
