/**
 * `ashlr ship` — pre-ship gate + optional deploy.
 *
 * Usage:
 *   ashlr ship [path] [--gate] [--deploy <target>] [--strict] [--confirm] [--json]
 *
 * Flags:
 *   [path]             Project directory to gate/deploy (default: cwd).
 *   --gate             Run gate only; skip deploy even if --deploy given.
 *   --deploy <target>  Deploy target: vercel | stack | morphkit | gh.
 *   --strict           Exit 1 when the gate has any fail; also blocks deploy.
 *   --confirm          Actually run the deploy (default is DRY-RUN).
 *   --json             Emit ShipResult JSON on stdout; human text goes to stderr.
 *
 * Exit codes:
 *   0  gate passed (or no fails when not --strict) and deploy dry-ran or succeeded
 *   1  gate has fails AND --strict, OR deploy failed
 *   2  bad usage
 *
 * SAFETY GUARDRAIL: deploy is DRY-RUN by default. Real actions only with --confirm.
 */

import type { ShipCheck, ShipGate, ShipResult } from '../core/types.js';

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

function colorize(code: string, s: string, tty = IS_TTY): string {
  if (!tty) return s;
  return `${code}${s}${C.reset}`;
}

function bold(s: string):    string { return colorize(C.bold,    s); }
function dim(s: string):     string { return colorize(C.dim,     s); }
function red(s: string):     string { return colorize(C.red,     s); }
function green(s: string):   string { return colorize(C.green,   s); }
function yellow(s: string):  string { return colorize(C.yellow,  s); }
function cyan(s: string):    string { return colorize(C.cyan,    s); }
function gray(s: string):    string { return colorize(C.gray,    s); }

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
// Lazy imports — lifecycle modules built by other M6 agents
// ---------------------------------------------------------------------------

async function importShip(): Promise<{
  runShipGate: (
    projectPath: string,
    opts: { strict: boolean },
  ) => Promise<ShipGate>;
  deploy: (
    projectPath: string,
    target: string,
    opts: { confirm: boolean },
  ) => Promise<{ ran: boolean; dryRun: boolean; detail: string }>;
}> {
  return import('../core/lifecycle/ship.js') as Promise<{
    runShipGate: (projectPath: string, opts: { strict: boolean }) => Promise<ShipGate>;
    deploy: (
      projectPath: string,
      target: string,
      opts: { confirm: boolean },
    ) => Promise<{ ran: boolean; dryRun: boolean; detail: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedShipArgs {
  projectPath: string;
  gateOnly: boolean;
  deployTarget: string | null;
  strict: boolean;
  confirm: boolean;
  json: boolean;
  usageError?: string;
}

function parseShipArgs(args: string[]): ParsedShipArgs {
  const result: ParsedShipArgs = {
    projectPath: process.cwd(),
    gateOnly: false,
    deployTarget: null,
    strict: false,
    confirm: false,
    json: false,
  };

  let pathSet = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--gate') {
      result.gateOnly = true;
      i++;
    } else if (arg === '--strict') {
      result.strict = true;
      i++;
    } else if (arg === '--confirm') {
      result.confirm = true;
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--deploy') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        result.usageError = `--deploy requires a target name (vercel | stack | morphkit | gh); got: ${val ?? '(missing)'}`;
        return result;
      }
      const VALID_TARGETS = ['vercel', 'stack', 'morphkit', 'gh'];
      if (!VALID_TARGETS.includes(val)) {
        result.usageError = `--deploy target must be one of: ${VALID_TARGETS.join(', ')}; got: ${val}`;
        return result;
      }
      result.deployTarget = val;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      // handled upstream; ignore here
      i++;
    } else if (!arg.startsWith('--')) {
      // Positional: project path. Track with an explicit boolean rather than
      // comparing against process.cwd() (which fails when the user passes the
      // literal cwd as the first positional).
      if (pathSet) {
        result.usageError = `unexpected extra argument: ${arg}`;
        return result;
      }
      result.projectPath = arg;
      pathSet = true;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Gate rendering
// ---------------------------------------------------------------------------

/** Glyph + color for each check status. */
function statusGlyph(status: ShipCheck['status']): string {
  switch (status) {
    case 'pass': return green('✓');
    case 'warn': return yellow('~');
    case 'fail': return red('✗');
    case 'skip': return gray('-');
    default:     return ' ';
  }
}

function statusLabel(status: ShipCheck['status']): string {
  switch (status) {
    case 'pass': return green('pass');
    case 'warn': return yellow('warn');
    case 'fail': return red('fail');
    case 'skip': return gray('skip');
    default:     return String(status);
  }
}

/**
 * Render the gate check table + summary to stdout (or stderr in json mode).
 * In json mode, human output goes to stderr so stdout remains clean JSON.
 */
function renderGate(gate: ShipGate, projectPath: string, jsonMode: boolean): void {
  const out = (line: string) => {
    if (jsonMode) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  };

  const idW     = Math.max(14, ...gate.checks.map(c => c.id.length));
  const labelW  = Math.max(12, ...gate.checks.map(c => c.label.length));
  const statusW = 6;

  out('');
  out(bold('  ashlr ship') + gray(`  —  ${projectPath}`));
  out('');

  if (gate.checks.length === 0) {
    out(`  ${dim('(no checks ran)')}`);
    out('');
  } else {
    // Header
    out(
      `  ${bold(pad('Check', idW))}  ` +
      `${bold(pad('Label', labelW))}  ` +
      `${bold(pad('Status', statusW))}  ` +
      `${bold('Detail')}`,
    );
    out(
      `  ${'─'.repeat(idW)}  ${'─'.repeat(labelW)}  ` +
      `${'─'.repeat(statusW)}  ${'─'.repeat(40)}`,
    );

    for (const check of gate.checks) {
      const glyph = statusGlyph(check.status);
      const statusStr = statusLabel(check.status);
      const detailTrunc = check.detail.length > 60
        ? check.detail.slice(0, 59) + '…'
        : check.detail;

      out(
        `  ${pad(dim(check.id), idW)}  ` +
        `${pad(check.label, labelW)}  ` +
        `${glyph} ${pad(statusStr, statusW - 2)}  ` +
        `${detailTrunc}`,
      );

      // Show fix hint for fail/warn checks (indented)
      if (check.fix && (check.status === 'fail' || check.status === 'warn')) {
        out(`  ${''.padStart(idW)}  ${''.padStart(labelW)}  ${''.padStart(statusW)}  ` +
          `  ${dim('fix: ')}${gray(check.fix)}`);
      }
    }

    out('');

    // Summary row
    const { pass, warn, fail, skip } = gate.summary;
    const parts: string[] = [];
    if (pass > 0)  parts.push(green(`${pass} passed`));
    if (warn > 0)  parts.push(yellow(`${warn} warned`));
    if (fail > 0)  parts.push(red(`${fail} failed`));
    if (skip > 0)  parts.push(gray(`${skip} skipped`));

    const overallIcon = gate.passed ? green('●') : red('●');
    const overallLabel = gate.passed
      ? green('GATE PASSED')
      : red('GATE FAILED');

    out(`  ${overallIcon}  ${overallLabel}  ${dim('—')}  ${parts.join(dim('  ·  '))}`);
  }

  out('');
}

// ---------------------------------------------------------------------------
// Deploy rendering
// ---------------------------------------------------------------------------

/**
 * Print deploy outcome — makes the dry-run vs real distinction unmistakable.
 */
function renderDeployResult(
  target: string,
  ran: boolean,
  dryRun: boolean,
  detail: string,
  jsonMode: boolean,
): void {
  const out = (line: string) => {
    if (jsonMode) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  };

  if (dryRun) {
    // DRY-RUN: make it unmistakably obvious
    out(
      `  ${yellow('DRY-RUN')}  ${bold('deploy → ' + target)}  ` +
      `${dim('(pass --confirm to actually run)')}`,
    );
    out(`  ${dim('would run:')}  ${gray(detail)}`);
    out('');
    out(`  ${dim('No deploy ran. No files pushed. No repos created. No outward action taken.')}`);
  } else if (ran) {
    out(`  ${green('✓ DEPLOYED')}  ${bold(target)}`);
    out(`  ${dim('ran:')}  ${gray(detail)}`);
  } else {
    // confirm was passed but ran=false → deploy function reported it did not run
    out(`  ${yellow('deploy skipped')}  ${bold(target)}`);
    out(`  ${dim('detail:')}  ${gray(detail)}`);
  }

  out('');
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printShipHelp(): void {
  console.log('');
  console.log(bold('  ashlr ship') + dim(' — pre-ship gate + optional deploy'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr ship ${cyan('[path]')} [options]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['[path]',             'Project path to gate/deploy (default: cwd).'],
    ['--gate',             'Run gate only; skip deploy.'],
    ['--deploy <target>',  'Deploy target: vercel | stack | morphkit | gh.'],
    ['--strict',           'Exit 1 when gate has any fail; block deploy on fail.'],
    ['--confirm',          'Actually run the deploy (default is DRY-RUN).'],
    ['--json',             'Emit ShipResult JSON on stdout; human text to stderr.'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Gate checks (in order):'));
  console.log('');
  console.log(`    ${dim('• supply-chain  binshield audit (if installed) or built-in dep sanity check')}`);
  console.log(`    ${dim('• test          npm test (if script exists)')}`);
  console.log(`    ${dim('• lint          npm run lint (if script exists)')}`);
  console.log(`    ${dim('• build         npm run build (if script exists)')}`);
  console.log('');
  console.log('  ' + bold('Deploy targets:'));
  console.log('');
  console.log(`    ${dim('• vercel    — delegates to the vercel CLI')}`);
  console.log(`    ${dim('• stack     — delegates to the stack CLI')}`);
  console.log(`    ${dim('• gh        — delegates to the gh CLI')}`);
  console.log(`    ${dim('• morphkit  — prints guidance (not installed by default)')}`);
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• Gate is READ-ONLY — it never modifies the project.')}`);
  console.log(`    ${dim('• Deploy is DRY-RUN by default. Requires --confirm to actually run.')}`);
  console.log(`    ${dim('• Without --confirm: prints exactly what WOULD run, then stops.')}`);
  console.log('');
  console.log('  ' + bold('Exit codes:'));
  console.log('');
  console.log(`    ${dim('0  gate passed (or no fails when not --strict); deploy dry-ran or succeeded')}`);
  console.log(`    ${dim('1  gate has fails AND --strict, OR deploy failed')}`);
  console.log(`    ${dim('2  bad usage / invalid flag')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr ship')}                              ${dim('# gate only, cwd')}`);
  console.log(`    ${cyan('ashlr ship --strict')}                     ${dim('# gate; exit 1 on any fail')}`);
  console.log(`    ${cyan('ashlr ship --deploy vercel')}              ${dim('# gate + dry-run vercel deploy')}`);
  console.log(`    ${cyan('ashlr ship --deploy vercel --confirm')}    ${dim('# gate + REAL vercel deploy')}`);
  console.log(`    ${cyan('ashlr ship ./my-app --gate')}              ${dim('# gate a specific dir, no deploy')}`);
  console.log(`    ${cyan('ashlr ship --deploy vercel --json')}       ${dim('# machine-readable ShipResult')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdShip — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr ship [path] [--gate] [--deploy <target>] [--strict] [--confirm] [--json]`
 *
 * Runs the pre-ship gate, renders a checks table, then optionally deploys.
 * Deploy is DRY-RUN by default — never actually deploys without --confirm.
 *
 * Exit codes:
 *   0  gate passed (or --strict not set and no deploy failure)
 *   1  gate failed with --strict, OR deploy ran and failed
 *   2  bad usage
 */
export async function cmdShip(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printShipHelp();
    return 0;
  }

  const parsed = parseShipArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load lifecycle/ship module (lazy — built by another M6 agent)
  let runShipGate: (projectPath: string, opts: { strict: boolean }) => Promise<ShipGate>;
  let deployFn: (
    projectPath: string,
    target: string,
    opts: { confirm: boolean },
  ) => Promise<{ ran: boolean; dryRun: boolean; detail: string }>;

  try {
    const mod = await importShip();
    runShipGate = mod.runShipGate;
    deployFn = mod.deploy;
  } catch (err) {
    process.stderr.write(
      red('error: ') +
      'Failed to load lifecycle/ship module (M6 core not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // ── Gate ──────────────────────────────────────────────────────────────────

  let gate: ShipGate;
  try {
    gate = await runShipGate(parsed.projectPath, { strict: parsed.strict });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Gate run failed: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Render gate (always — before JSON output so the human can see it)
  renderGate(gate, parsed.projectPath, parsed.json);

  // ── Strict-mode failure: refuse deploy and exit 1 ─────────────────────────

  const hasFails = gate.summary.fail > 0;

  if (parsed.strict && hasFails) {
    const msg =
      `  ${red('REFUSED')}  ${bold('--strict')} is set and the gate has ${red(String(gate.summary.fail) + ' failing check(s)')}.\n` +
      `  ${dim('Fix the issues above and re-run ashlr ship.')}\n`;

    if (parsed.json) {
      process.stderr.write(msg + '\n');
    } else {
      process.stdout.write(msg + '\n');
    }

    const result: ShipResult = {
      gate,
      deployTarget: parsed.deployTarget,
      deployDryRun: true,
      deployRan: false,
      deployDetail: 'refused: gate failed with --strict',
    };

    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }

    return 1;
  }

  // ── No deploy requested (or --gate flag) ─────────────────────────────────

  if (!parsed.deployTarget || parsed.gateOnly) {
    const result: ShipResult = {
      gate,
      deployTarget: null,
      deployDryRun: true,
      deployRan: false,
      deployDetail: parsed.gateOnly ? 'gate-only mode' : 'no deploy target specified',
    };

    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }

    return gate.passed || !parsed.strict ? 0 : 1;
  }

  // ── Gate failed but not --strict: warn before deploy ─────────────────────

  if (hasFails && !parsed.strict) {
    const warningMsg =
      `  ${yellow('WARNING')}  The gate has ${yellow(String(gate.summary.fail) + ' failing check(s)')} but --strict is not set.\n` +
      (parsed.confirm
        ? `  ${yellow('Proceeding with deploy because --confirm was explicitly passed.')}\n`
        : `  ${dim('Deploy will be a DRY-RUN (pass --confirm to actually deploy despite gate failures).')}\n`);

    if (parsed.json) {
      process.stderr.write(warningMsg + '\n');
    } else {
      process.stdout.write(warningMsg + '\n');
    }
  }

  // ── Deploy ────────────────────────────────────────────────────────────────

  let deployOutcome: { ran: boolean; dryRun: boolean; detail: string };

  try {
    deployOutcome = await deployFn(
      parsed.projectPath,
      parsed.deployTarget,
      { confirm: parsed.confirm },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      red('error: ') + `Deploy to ${parsed.deployTarget} failed: ${errMsg}\n`,
    );

    const result: ShipResult = {
      gate,
      deployTarget: parsed.deployTarget,
      deployDryRun: !parsed.confirm,
      deployRan: false,
      deployDetail: `error: ${errMsg}`,
    };

    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }

    return 1;
  }

  // Render deploy result
  renderDeployResult(
    parsed.deployTarget,
    deployOutcome.ran,
    deployOutcome.dryRun,
    deployOutcome.detail,
    parsed.json,
  );

  // ── JSON output ───────────────────────────────────────────────────────────

  const result: ShipResult = {
    gate,
    deployTarget: parsed.deployTarget,
    deployDryRun: deployOutcome.dryRun,
    deployRan: deployOutcome.ran,
    deployDetail: deployOutcome.detail,
  };

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  // ── Exit code ─────────────────────────────────────────────────────────────

  // deploy ran and returned ran=false after confirm → treat as failure
  if (parsed.confirm && !deployOutcome.dryRun && !deployOutcome.ran) {
    // deploy was attempted but did not succeed
    return 1;
  }

  // strict + fails already handled above (exits 1 before reaching here)
  return 0;
}
