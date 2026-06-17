/**
 * `ashlr stack` — M73: surface the ecosystem `stack` tool from the hub.
 *
 * Subcommands:
 *
 *   READ-ONLY / ADVISORY (never provision anything):
 *     ashlr stack [status] [--json]   Print stack status via stackStatus().
 *     ashlr stack list   [...]        Passthrough: `stack list`.
 *     ashlr stack providers [...]     Passthrough: `stack providers`.
 *     ashlr stack recommend [...]     Passthrough: `stack recommend`.
 *     ashlr stack scan  [...]         Passthrough: `stack scan`.
 *     ashlr stack doctor [...]        Passthrough: `stack doctor`.
 *
 *   MUTATING — confirm-gated (require explicit y/N in TTY, or --yes):
 *     ashlr stack add <service> [--yes]    Provision a service via `stack add`.
 *     ashlr stack apply [recipe] [--yes]   Apply a recipe via `stack apply`.
 *
 *   Non-TTY without --yes → REFUSED (never silent-provision, ever).
 *
 * Safety rules:
 *  - When `stack` is not installed: prints a clear install message, exits 1.
 *  - Mutating paths NEVER run unless the operator explicitly confirms.
 *  - Never throws. Never auto-provisions.
 *
 * Style: mirrors fleet.ts (makeColors / isTty / print pattern, --json, printHelp).
 */

import {
  stackInstalled,
  stackStatus,
  stackRun,
} from '../core/integrations/stack.js';
import { makeColors, isTty } from './ui.js';
import { promptConfirm } from './onboard.js';

const { bold, dim, green, red, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Test seam: cmdStack calls confirm through this indirection so unit tests can
// inject a mock without a live TTY (mirrors onboard.ts _internals pattern).
// ---------------------------------------------------------------------------

export const _stackInternals: { confirm: (q: string) => Promise<boolean> } = {
  confirm: promptConfirm,
};

// ---------------------------------------------------------------------------
// Read-only: status
// ---------------------------------------------------------------------------

function cmdStackStatus(jsonMode: boolean): number {
  if (!stackInstalled()) {
    return printNotInstalled();
  }

  const status = stackStatus();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return status.ok ? 0 : 1;
  }

  console.log('');
  console.log(bold('  ashlr stack') + dim(' — service control plane (M73)'));
  console.log('');

  if (!status.ok) {
    console.log('  ' + red('✗') + ' ' + dim(`stack status: ${status.detail}`));
    console.log('');
    return 1;
  }

  const svcs = status.services ?? [];
  if (svcs.length === 0) {
    console.log('  ' + dim('no services wired yet'));
    console.log('    ' + cyan('→') + ' ' + dim('run') + ' ' + cyan('ashlr stack recommend') + ' ' + dim('to see what fits this repo'));
    console.log('    ' + cyan('→') + ' ' + dim('or') + ' ' + cyan('ashlr stack add <service>') + ' ' + dim('to provision one directly'));
  } else {
    console.log('  ' + green(String(svcs.length)) + ' service(s) wired:');
    for (const svc of svcs) {
      console.log('    ' + cyan('•') + ' ' + svc);
    }
    console.log('    ' + dim('secrets auto-wire via phantom — no manual copy/paste'));
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Read-only: passthrough to stack CLI
// ---------------------------------------------------------------------------

function cmdStackPassthrough(sub: string, rest: string[]): number {
  if (!stackInstalled()) {
    return printNotInstalled();
  }

  const result = stackRun([sub, ...rest]);
  if (result.stdout) {
    process.stdout.write(result.stdout + '\n');
  }
  return result.ok ? 0 : (result.code ?? 1);
}

// ---------------------------------------------------------------------------
// Mutating: add / apply — confirm-gated
// ---------------------------------------------------------------------------

async function cmdStackMutate(action: 'add' | 'apply', positional: string[], yes: boolean): Promise<number> {
  if (!stackInstalled()) {
    return printNotInstalled();
  }

  const tty = process.stdout.isTTY === true;

  // Guard: non-TTY without --yes refuses — never silent-provision.
  if (!tty && !yes) {
    const msg =
      `non-TTY: ashlr stack ${action} requires --yes to prevent silent provisioning`;
    process.stderr.write(red('error: ') + msg + '\n');
    process.stderr.write(dim(`  Use \`ashlr stack ${action}${positional.length ? ' ' + positional.join(' ') : ''} --yes\` in non-interactive environments.`) + '\n');
    return 2;
  }

  // Build the label for the confirm prompt.
  const target = positional.length ? positional.join(' ') : '';
  const label = action === 'add'
    ? `provision service ${cyan(target || '<service>')}`
    : `apply recipe ${cyan(target || '(default)')}`;

  // Gate: interactive confirm (TTY) or --yes bypass.
  let confirmed: boolean;
  if (yes) {
    confirmed = true;
  } else {
    console.log('');
    console.log(yellow('  !') + ' ' + bold(`stack ${action}`) + dim(' — this will provision real services and wire secrets via phantom.'));
    console.log('');
    confirmed = await _stackInternals.confirm(`  Confirm: ${label}?`);
  }

  if (!confirmed) {
    console.log('');
    console.log(dim('  Aborted — nothing was provisioned.'));
    console.log('');
    return 0;
  }

  console.log('');
  console.log(dim(`  Running: stack ${action}${target ? ' ' + target : ''} ...`));
  console.log('');

  const args: string[] = [action, ...positional];
  const result = stackRun(args);

  if (result.stdout) {
    process.stdout.write(result.stdout + '\n');
  }

  if (result.ok) {
    console.log('');
    console.log(green('  ✓') + ' ' + `stack ${action} completed.`);
    console.log('');
    return 0;
  } else {
    process.stderr.write(red('error: ') + `stack ${action} exited ${result.code ?? 'error'}\n`);
    return result.code ?? 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printNotInstalled(): number {
  console.log('');
  console.log(bold('  ashlr stack') + dim(' — service control plane (M73)'));
  console.log('');
  console.log('  ' + red('✗') + ' ' + bold('stack is not installed'));
  console.log('');
  console.log(dim('  Install it to provision services (OAuth → provider → secrets, Phantom-wired):'));
  console.log('    ' + cyan('npm install -g @evero/stack') + dim('  # or your package manager'));
  console.log('    ' + cyan('https://docs.evero.io/stack') + dim('  # docs'));
  console.log('');
  return 1;
}

function printStackHelp(): void {
  console.log('');
  console.log(bold('  ashlr stack') + dim(' — service control plane (M73)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr stack [status] [--json]   ${cyan('# read-only — stack status + wired services')}`);
  console.log(`    ashlr stack list                ${cyan('# read-only — list available services')}`);
  console.log(`    ashlr stack providers           ${cyan('# read-only — list configured providers')}`);
  console.log(`    ashlr stack recommend           ${cyan('# read-only — recommend services for this repo')}`);
  console.log(`    ashlr stack scan                ${cyan('# read-only — scan repo for service needs')}`);
  console.log(`    ashlr stack doctor              ${cyan('# read-only — diagnose stack configuration')}`);
  console.log('');
  console.log(`    ashlr stack add <service> [--yes]    ${yellow('# MUTATING')} ${dim('— provision a service (confirm-gated)')}`);
  console.log(`    ashlr stack apply [recipe] [--yes]   ${yellow('# MUTATING')} ${dim('— apply a recipe (confirm-gated)')}`);
  console.log('');
  console.log('  ' + dim('Mutating actions require explicit confirmation (y/N) in a TTY, or --yes.'));
  console.log('  ' + dim('Non-TTY without --yes: REFUSED — never silent-provision.'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * M73 `ashlr stack` dispatcher. Export name MUST be `cmdStack` — the main
 * thread wires it as `m.cmdStack`.
 */
export async function cmdStack(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printStackHelp();
    return 0;
  }

  // No subcommand → status
  if (sub === undefined || sub === 'status') {
    const jsonMode = args.includes('--json');
    return cmdStackStatus(jsonMode);
  }

  // Read-only passthroughs
  const readOnly = ['list', 'providers', 'recommend', 'scan', 'doctor'];
  if (readOnly.includes(sub)) {
    return cmdStackPassthrough(sub, rest);
  }

  // Mutating: add
  if (sub === 'add') {
    const yes = rest.includes('--yes');
    const positional = rest.filter((a) => !a.startsWith('--'));
    if (positional.length === 0) {
      process.stderr.write(red('error: ') + 'Usage: ashlr stack add <service> [--yes]\n');
      return 2;
    }
    return cmdStackMutate('add', positional, yes);
  }

  // Mutating: apply
  if (sub === 'apply') {
    const yes = rest.includes('--yes');
    const positional = rest.filter((a) => !a.startsWith('--'));
    return cmdStackMutate('apply', positional, yes);
  }

  process.stderr.write(red('error: ') + `unknown stack subcommand: ${sub}\n`);
  printStackHelp();
  return 2;
}
