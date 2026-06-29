/**
 * resources.ts — M253 `ashlr resources` CLI command.
 *
 * Prints the god-view: per-backend resource state (availability, used%,
 * cap, resets-in, $/1M-out) from the ResourceMonitor.
 *
 * Usage:
 *   ashlr resources           — table view
 *   ashlr resources --json    — raw JSON (ResourceSnapshot)
 *   ashlr resources --watch   — refresh every 30s (Ctrl-C to stop)
 */

import { loadConfig } from '../core/config.js';
import { getResourceSnapshot, type BackendResourceState } from '../core/fabric/resource-monitor.js';

// ---------------------------------------------------------------------------
// ANSI color helpers (inline — avoids circular dep on cli/ui.ts)
// ---------------------------------------------------------------------------

const _isTTY = process.stdout.isTTY;

function color(code: string, s: string): string {
  return _isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const green  = (s: string) => color('32', s);
const yellow = (s: string) => color('33', s);
const red    = (s: string) => color('31', s);
const cyan   = (s: string) => color('36', s);
const gray   = (s: string) => color('90', s);
const bold   = (s: string) => color('1',  s);
const dim    = (s: string) => color('2',  s);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function availColor(avail: BackendResourceState['availability']): string {
  switch (avail) {
    case 'open':        return green(avail);
    case 'near':        return yellow(avail);
    case 'throttled':   return yellow(avail);
    case 'exhausted':   return red(avail);
    case 'unreachable': return red(avail);
    default:            return dim(avail);
  }
}

function formatUsedPct(state: BackendResourceState): string {
  if (state.usedPct === null) return dim('—');
  const pct = `${state.usedPct}%`;
  if (state.usedPct >= 90) return red(pct);
  if (state.usedPct >= 75) return yellow(pct);
  return green(pct);
}

function formatCap(state: BackendResourceState): string {
  if (state.cap === null) return dim('—');
  return `${state.cap}${state.capWindow ? `/${state.capWindow}` : ''}`;
}

function formatResetsIn(state: BackendResourceState): string {
  if (state.resetsAt === null) return dim('—');
  const diffMs = state.resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return dim('now');
  const diffSec = Math.floor(diffMs / 1000);
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatCost(state: BackendResourceState): string {
  if (state.costPerMTokenOut === 0) return dim('$0');
  return `$${state.costPerMTokenOut.toFixed(2)}`;
}

function formatLatency(state: BackendResourceState): string {
  if (state.p50LatencyMs === null) return dim('—');
  return `${state.p50LatencyMs}ms`;
}

function pad(s: string, n: number): string {
  // Strip ANSI codes for length calculation
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  const padLen = Math.max(0, n - stripped.length);
  return s + ' '.repeat(padLen);
}

// ---------------------------------------------------------------------------
// Table printer
// ---------------------------------------------------------------------------

function printSnapshot(snapshot: import('../core/fabric/resource-monitor.js').ResourceSnapshot): void {
  const ts = new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log('');
  console.log(bold('  Resource Snapshot') + gray(`  —  ${ts}`));
  console.log('');

  const COL = { engine: 14, avail: 14, used: 7, cap: 14, resets: 10, cost: 10, latency: 8 };
  const header =
    `  ${bold(pad('engine', COL.engine))}` +
    `  ${bold(pad('avail', COL.avail))}` +
    `  ${bold(pad('used%', COL.used))}` +
    `  ${bold(pad('cap', COL.cap))}` +
    `  ${bold(pad('resets-in', COL.resets))}` +
    `  ${bold(pad('$/1M-out', COL.cost))}` +
    `  ${bold('p50-ms')}`;
  const divider = `  ${'─'.repeat(COL.engine)}  ${'─'.repeat(COL.avail)}  ${'─'.repeat(COL.used)}  ${'─'.repeat(COL.cap)}  ${'─'.repeat(COL.resets)}  ${'─'.repeat(COL.cost)}  ${'─'.repeat(COL.latency)}`;

  console.log(header);
  console.log(gray(divider));

  for (const b of snapshot.backends) {
    const row =
      `  ${pad(cyan(b.backend), COL.engine)}` +
      `  ${pad(availColor(b.availability), COL.avail)}` +
      `  ${pad(formatUsedPct(b), COL.used)}` +
      `  ${pad(formatCap(b), COL.cap)}` +
      `  ${pad(formatResetsIn(b), COL.resets)}` +
      `  ${pad(formatCost(b), COL.cost)}` +
      `  ${formatLatency(b)}`;
    console.log(row);
  }

  console.log('');

  // Summary warnings
  const warnings: string[] = [];
  for (const b of snapshot.backends) {
    if (b.availability === 'throttled' || b.availability === 'near') {
      const pctStr = b.usedPct !== null ? `at ${b.usedPct}%` : '';
      warnings.push(`  ${yellow('!')}  ${b.backend} ${pctStr} — ${b.reason}`);
    } else if (b.availability === 'exhausted') {
      warnings.push(`  ${red('!')}  ${b.backend} exhausted — ${b.reason}`);
    } else if (b.availability === 'unreachable') {
      warnings.push(`  ${red('!')}  ${b.backend} unreachable — ${b.reason}`);
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.log(w);
    console.log('');
  }

  console.log(dim(`  Run ${cyan('ashlr resources --json')} for machine-readable snapshot.`));
  console.log('');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function cmdResources(args: string[]): Promise<number> {
  const jsonMode  = args.includes('--json');
  const watchMode = args.includes('--watch');

  let cfg: unknown;
  try {
    cfg = loadConfig();
  } catch {
    cfg = {};
  }

  async function tick(): Promise<void> {
    const snapshot = await getResourceSnapshot(cfg);
    if (jsonMode) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      printSnapshot(snapshot);
    }
  }

  if (watchMode) {
    await tick();
    const interval = setInterval(async () => {
      if (!jsonMode) {
        // Clear screen for watch mode
        process.stdout.write('\x1b[2J\x1b[0f');
      }
      await tick();
    }, 30_000);

    // Keep process alive; Ctrl-C exits
    await new Promise<never>(() => {
      process.on('SIGINT', () => {
        clearInterval(interval);
        process.exit(0);
      });
    });
  } else {
    await tick();
  }

  return 0;
}

/**
 * One-line resource summary for `ashlr status`.
 * Returns a string like: "Resources  claude:near(82%)  codex:ok(31%)  nim:ok  local:ok"
 * or null when all backends are open/unknown (no noise in status output).
 */
export async function resourceStatusLine(cfg: unknown): Promise<string | null> {
  try {
    const snapshot = await getResourceSnapshot(cfg);
    const parts: string[] = [];

    for (const b of snapshot.backends) {
      if (b.backend === 'builtin') continue; // builtin is always ok — skip for brevity

      const pctStr = b.usedPct !== null ? `(${b.usedPct}%)` : '';
      switch (b.availability) {
        case 'open':
          parts.push(`${b.backend}:ok`);
          break;
        case 'near':
          parts.push(`${yellow(b.backend + ':near' + pctStr)}`);
          break;
        case 'throttled':
          parts.push(`${yellow(b.backend + ':throttled' + pctStr)}`);
          break;
        case 'exhausted':
          parts.push(`${red(b.backend + ':exhausted' + pctStr)}`);
          break;
        case 'unreachable':
          parts.push(`${red(b.backend + ':unreachable')}`);
          break;
        default:
          // unknown — omit
          break;
      }
    }

    if (parts.length === 0) return null;

    // Only emit the line if there's at least one non-open state
    const hasAlert = snapshot.backends.some(b =>
      b.backend !== 'builtin' &&
      (b.availability === 'near' || b.availability === 'throttled' ||
       b.availability === 'exhausted' || b.availability === 'unreachable')
    );
    if (!hasAlert) return null;

    return `${bold('Resources')}  ${parts.join('  ')}`;
  } catch {
    return null;
  }
}
