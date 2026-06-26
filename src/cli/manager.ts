/**
 * `ashlr manager` — M120 fleet CEO / oversight agent.
 *
 * Judges pending proposals with a frontier model, produces a quality scorecard,
 * and (optionally) rejects noise/harmful proposals. SHADOW MODE by default:
 * records judgements + writes a report but NEVER merges anything.
 *
 * Usage:
 *   ashlr manager [--window 7d|30d|all] [--limit N] [--apply-rejects] [--json]
 *
 * Flags:
 *   --window 7d|30d|all   Quality metrics window (default: 7d)
 *   --limit N             Max proposals to judge (default: 20, max: 100)
 *   --apply-rejects       Reject noise/harmful proposals in the inbox (default: false)
 *   --json                Emit the full ManagerReport as JSON
 */

import type { AshlrConfig } from '../core/types.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, green, red, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Config loader (lazy, graceful — mirrors fleet.ts)
// ---------------------------------------------------------------------------

async function loadCfg(): Promise<AshlrConfig | null> {
  try {
    const { loadConfig } = await import('../core/config.js');
    return loadConfig();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Human-readable scorecard renderer
// ---------------------------------------------------------------------------

function verdictColor(v: string): string {
  switch (v) {
    case 'ship':    return green(v);
    case 'review':  return yellow(v);
    case 'noise':   return dim(v);
    case 'harmful': return red(v);
    default:        return v;
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function renderReport(
  report: import('../core/fleet/manager.js').ManagerReport,
): Promise<void> {
  const { metrics, verdicts, wins, concerns, recommendations, narrative, judgeEngine, window: win } = report;

  console.log('');
  console.log(bold('  ashlr manager') + dim(` — fleet oversight scorecard (M120, window: ${win})`));
  console.log(dim(`  judge: ${judgeEngine}  ·  generated: ${report.generatedAt}`));
  console.log('');

  // Metrics summary
  console.log('  ' + bold('Fleet metrics'));
  console.log(`    proposals created:  ${metrics.proposalsCreated}`);
  console.log(`    merged:             ${metrics.merged}`);
  console.log(`    rejected:           ${metrics.rejected}`);
  console.log(`    pending:            ${metrics.pending}`);
  const arColor = metrics.acceptRate >= 0.5 ? green : metrics.acceptRate >= 0.25 ? yellow : red;
  console.log(`    accept rate:        ${arColor(pct(metrics.acceptRate))}`);
  console.log(`    trivial ratio:      ${pct(metrics.trivialRatio)}`);
  console.log(`    empty-diff rate:    ${pct(metrics.emptyRate)}`);
  console.log('');

  // Verdicts table
  if (verdicts.length === 0) {
    console.log('  ' + dim('No proposals to judge.'));
  } else {
    console.log('  ' + bold(`Verdicts (${verdicts.length} proposal(s) judged)`));
    console.log('');

    const idW = Math.max(12, ...verdicts.map((v) => v.proposalId.length));
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    console.log(
      '  ' +
        dim(pad('proposal-id', idW)) +
        '  ' + dim(pad('verdict', 8)) +
        '  ' + dim('val') +
        ' ' + dim('cor') +
        ' ' + dim('scp') +
        ' ' + dim('ali') +
        '  ' + dim('rationale'),
    );
    console.log('  ' + dim('-'.repeat(idW + 50)));

    for (const v of verdicts) {
      console.log(
        '  ' +
          pad(v.proposalId, idW) +
          '  ' + pad(verdictColor(v.verdict), 8 + (verdictColor(v.verdict).length - v.verdict.length)) +
          '  ' + v.value +
          '/' + v.correctness +
          '/' + v.scope +
          '/' + v.alignment +
          '  ' + dim(v.rationale.slice(0, 60)),
      );
      if (v.wouldMerge) {
        console.log('  ' + ' '.repeat(idW) + '  ' + green('  ↳ advisory: would-merge (ship + low risk + small scope)'));
      }
    }
    console.log('');
  }

  // Wins
  if (wins.length > 0) {
    console.log('  ' + bold('Wins'));
    for (const w of wins) {
      console.log('    ' + green('✓') + ' ' + w);
    }
    console.log('');
  }

  // Concerns
  if (concerns.length > 0) {
    console.log('  ' + bold('Concerns'));
    for (const c of concerns) {
      console.log('    ' + yellow('⚠') + ' ' + c);
    }
    console.log('');
  }

  // Recommendations
  console.log('  ' + bold('Recommendations'));
  for (const r of recommendations) {
    console.log('    ' + cyan('→') + ' ' + r);
  }
  console.log('');

  // Narrative
  console.log('  ' + bold('Summary'));
  console.log('    ' + dim(narrative));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main CLI entry point
// ---------------------------------------------------------------------------

export async function cmdManager(args: string[]): Promise<number> {
  // --help
  if (args.includes('--help') || args.includes('-h')) {
    printManagerHelp();
    return 0;
  }

  const jsonMode     = args.includes('--json');
  const applyRejects = args.includes('--apply-rejects');

  // --window
  let window: '7d' | '30d' | 'all' = '7d';
  const wIdx = args.indexOf('--window');
  if (wIdx !== -1 && args[wIdx + 1]) {
    const wVal = args[wIdx + 1];
    if (wVal === '7d' || wVal === '30d' || wVal === 'all') {
      window = wVal;
    } else {
      process.stderr.write(
        red('error: ') + `--window must be 7d, 30d, or all (got ${wVal})\n`,
      );
      return 1;
    }
  }

  // --limit
  let limit = 20;
  const lIdx = args.indexOf('--limit');
  if (lIdx !== -1 && args[lIdx + 1]) {
    const lVal = parseInt(args[lIdx + 1]!, 10);
    if (isNaN(lVal) || lVal < 1) {
      process.stderr.write(red('error: ') + `--limit must be a positive integer (got ${args[lIdx + 1]})\n`);
      return 1;
    }
    limit = lVal;
  }

  const cfg = await loadCfg();
  if (!cfg) {
    process.stderr.write(red('error: ') + 'failed to load config.\n');
    return 1;
  }

  let report: import('../core/fleet/manager.js').ManagerReport;
  try {
    const { runManager } = await import('../core/fleet/manager.js');
    report = await runManager(cfg, { window, limit, applyRejects });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'manager failed: ' +
        (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  await renderReport(report);

  if (applyRejects) {
    const rejected = report.verdicts.filter((v) => v.verdict === 'noise' || v.verdict === 'harmful');
    if (rejected.length > 0) {
      console.log(yellow(`  ${rejected.length} noise/harmful proposal(s) rejected in the inbox.`));
      console.log('');
    }
  }

  return 0;
}

function printManagerHelp(): void {
  console.log('');
  console.log(bold('  ashlr manager') + dim(' — fleet CEO / oversight agent (M120)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr manager [--window 7d|30d|all] [--limit N] [--apply-rejects] [--json]`);
  console.log('');
  console.log('  ' + bold('Flags:'));
  console.log('');
  console.log(`    --window 7d|30d|all   ${cyan('# quality metrics window (default: 7d)')}`);
  console.log(`    --limit N             ${cyan('# max proposals to judge (default: 20, max: 100)')}`);
  console.log(`    --apply-rejects       ${cyan('# reject noise/harmful proposals in the inbox')}`);
  console.log(`    --json                ${cyan('# emit full ManagerReport as JSON')}`);
  console.log('');
  console.log('  ' + bold('Shadow mode (default):'));
  console.log('    Records judgements in the decisions ledger and writes a report to');
  console.log('    ~/.ashlr/manager/<ts>.json but does NOT merge or reject anything.');
  console.log('    Pass --apply-rejects to reject noise/harmful proposals only.');
  console.log('    NEVER auto-merges regardless of verdict.');
  console.log('');
}
