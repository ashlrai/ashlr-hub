/**
 * CLI handler for `ashlr preflight` — a READ-ONLY first-activation readiness
 * check. See docs/contracts/CONTRACT-H7.md (BUILD ITEM 1).
 *
 * Prints `ready=true|false` plus a blockers[] / warnings[] list, computed from
 * the SHARED read-only readiness model (src/core/readiness.ts → buildReadiness).
 * Mutates NOTHING and makes NO new outward call (probeEndpoint is the same local
 * model GET `ashlr doctor` already performs). Exit code 0 when ready, 1 when
 * blocked.
 *
 * Flags:
 *   --json   Emit the ReadinessReport as JSON on stdout (no color).
 *   --help   Show usage.
 *
 * Wiring: BUILD/INTEGRATION adds the `case 'preflight'` dispatcher arm + a
 * `loadPreflightCmd` lazy loader in src/cli/index.ts (mirroring loadVerifySafetyCmd)
 * + a cmdHelp entry. This file does NOT touch the dispatcher.
 *
 * Exit codes: 0 ready, 1 blocked (a hard blocker present), 2 bad usage.
 */

import { loadConfig } from '../core/config.js';
import { buildReadiness } from '../core/readiness.js';
import type { ReadinessReport, ReadinessFinding } from '../core/readiness.js';
import { pad, makeColors, isTty } from './ui.js';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface ParsedPreflightArgs {
  json: boolean;
  help: boolean;
  error: string | undefined;
}

function parsePreflightArgs(args: string[]): ParsedPreflightArgs {
  let json = false;
  let help = false;
  let error: string | undefined;

  for (const a of args) {
    if (a === undefined) continue;
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else {
      error = `Unknown argument: ${a}`;
      break;
    }
  }

  return { json, help, error };
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const tty = isTty();
  const { bold, cyan, dim, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  out(bold('  ashlr preflight') + dim(' — read-only first-activation readiness check'));
  out('');
  out('  ' + bold('Usage:'));
  out(`    ${cyan('ashlr preflight')} [--json]`);
  out('');
  out('  ' + bold('Options:'));
  const opts: [string, string][] = [
    ['--json', 'Emit the ReadinessReport as JSON (no color) instead of human-readable output.'],
    ['--help', 'Show this help.'],
  ];
  const w = Math.max(...opts.map(([f]) => f.length));
  for (const [flag, desc] of opts) out(`    ${cyan(pad(flag, w))}  ${desc}`);
  out('');
  out('  ' + gray('READ-ONLY: reports model reachability, enrollment count, kill-switch state,'));
  out('  ' + gray('daemon health, ~/.ashlr writeability, sandbox health, git + phantom presence.'));
  out('  ' + gray('Mutates nothing. Exit 0 when ready, 1 when a hard blocker is present.'));
  out('');
}

// ─── Human-readable render ─────────────────────────────────────────────────────

/**
 * Human-readable render of a ReadinessReport: a `ready=true|false` headline,
 * then grouped blockers → warnings → info sections (colorized when on a TTY).
 */
function printReadiness(report: ReadinessReport): void {
  const tty = isTty();
  const { bold, dim, red, green, yellow, cyan, gray } = makeColors(tty);
  const out = (s = '') => process.stdout.write(s + '\n');

  out('');
  const headline = report.ready
    ? green(bold('  ready=true')) + dim('  — first activation is safe to proceed')
    : red(bold('  ready=false')) + dim('  — resolve the blocker(s) below first');
  out(headline);
  out('');

  const section = (
    title: string,
    findings: ReadinessFinding[],
    marker: string,
    color: (s: string) => string,
  ): void => {
    if (findings.length === 0) return;
    out('  ' + bold(title));
    for (const f of findings) {
      out(`    ${color(marker)} ${f.detail}`);
      if (f.fix) out(`        ${gray('→ ' + f.fix)}`);
    }
    out('');
  };

  section('Blockers', report.blockers, '✗', red);
  section('Warnings', report.warnings, '!', yellow);
  section('OK', report.info, '✓', green);

  out('  ' + gray('Review proposals with ') + cyan('ashlr inbox') + gray('; safely activate with ') + cyan('ashlr onboard') + gray('.'));
  out('');
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * `ashlr preflight [--json]` — READ-ONLY readiness check.
 *
 * Loads the config, builds the shared readiness report (which mutates nothing
 * besides a self-cleaning ~/.ashlr writeable sentinel), then prints either the
 * JSON report (--json) or a grouped human-readable summary. Returns 0 when
 * ready, 1 when a hard blocker is present, 2 on bad usage.
 */
export async function cmdPreflight(args: string[]): Promise<number> {
  const parsed = parsePreflightArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write('error: ' + parsed.error + '\n');
    process.stderr.write('Run `ashlr preflight --help` for usage.\n');
    return 2;
  }

  const cfg = loadConfig();
  const report = await buildReadiness(cfg);

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    printReadiness(report);
  }

  return report.ready ? 0 : 1;
}
