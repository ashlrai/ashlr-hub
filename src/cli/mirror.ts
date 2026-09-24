/**
 * `ashlr mirror …` — the fleet's own mirror clones. V3.10 Track B unit U6
 * (SPEC-310B §2 "Mirrors"); the logic lives in src/core/fleet/mirrors.ts.
 *
 * Commands:
 *   mirror [list] [--json]                 Every mirror: path, base, HEAD, last sync.
 *   mirror add <owner/name> [--base <b>]   Clone (or reset) the fleet's mirror. Does NOT enroll it.
 *   mirror sync <owner/name>… | --all      Fetch and hard-reset to origin/<base>.
 *   mirror path <owner/name>               Print the mirror path.
 *   mirror remove <owner/name> [--force]   Unenroll + drain, then delete the clone.
 *   mirror reconcile [--apply]             Make the enrolled MIRRORS exactly the standing grant's repos.
 *   mirror release [--apply]               Unenroll every fleet mirror (undo reconcile); nothing else.
 *
 * WHY `add` never enrolls: enrollment is autonomy scope, and under a standing
 * policy it is derived from the signed grant (`reconcile`). A mirror existing
 * is harmless — it is a clean clone nobody dispatches on until enrolled.
 *
 * Mason's own checkouts are never read or written by any of these commands,
 * and never unenrolled: `reconcile` and `release` only add or remove FLEET
 * MIRROR paths in the enrollment registry (3.10 R3f). The standing daemon
 * keeps off his checkouts through a read-only lane lens instead
 * (fleet/mirrors.ts "WHY ENROLLMENT IS A LANE"), so his enrolled repos keep
 * working in Verse, the MCP tools and the CLI while a grant runs.
 *
 * Frozen contract (SPEC-310B §7): `runMirrorCli(args) => Promise<exitCode>`,
 * registered by B-U1 in src/cli/index.ts.
 */
import { isTty, makeColors, pad } from './ui.js';
import type {
  AutonomousEnrollmentResult,
  AutonomousReleaseResult,
  MirrorStatus,
  MirrorSyncResult,
} from '../core/fleet/mirrors.js';

const { bold, dim, red, green, yellow } = makeColors(isTty());

const USAGE = [
  'Usage: ashlr mirror [list] [--json]',
  '       ashlr mirror add <owner/name> [--base <branch>] [--json]',
  '       ashlr mirror sync <owner/name>... | --all [--json]',
  '       ashlr mirror path <owner/name>',
  '       ashlr mirror remove <owner/name> [--force] [--json]',
  '       ashlr mirror reconcile [--apply] [--json]',
  '       ashlr mirror release [--apply] [--json]',
].join('\n');

interface ParsedArgs {
  positional: string[];
  json: boolean;
  all: boolean;
  force: boolean;
  apply: boolean;
  base: string | null;
  error: string | null;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positional: [],
    json: false,
    all: false,
    force: false,
    apply: false,
    base: null,
    error: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') parsed.json = true;
    else if (arg === '--all') parsed.all = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--apply') parsed.apply = true;
    else if (arg === '--base') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) parsed.error = '--base needs a branch name';
      else parsed.base = value;
      i++;
    } else if (arg.startsWith('--base=')) parsed.base = arg.slice('--base='.length) || null;
    else if (arg.startsWith('--')) parsed.error = `unknown option ${arg}`;
    else parsed.positional.push(arg);
  }
  return parsed;
}

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): number {
  process.stderr.write(`${red('error')}: ${message}\n${dim(USAGE)}\n`);
  return 2;
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : '—';
}

function renderList(rows: readonly MirrorStatus[]): void {
  if (rows.length === 0) {
    print(dim('No fleet mirrors yet. They are created automatically under a standing grant, or with `ashlr mirror add <owner/name>`.'));
    return;
  }
  print(bold(`${pad('REPO', 32)} ${pad('BASE', 14)} ${pad('HEAD', 13)} ${pad('LAST SYNC', 25)} STATUS`));
  for (const row of rows) {
    const state = row.state;
    const status = !row.present
      ? row.problem ? red(`invalid: ${row.problem}`) : yellow('missing')
      : state?.lastSyncOk === false
        ? red(`sync failed: ${state.lastError ?? 'unknown'}`)
        : green('ok');
    print(`${pad(row.nameWithOwner, 32)} ${pad(state?.base ?? '—', 14)} ${pad(shortSha(state?.headSha), 13)} ${pad(state?.lastSyncAt ?? 'never', 25)} ${status}`);
  }
}

function renderSync(result: MirrorSyncResult): void {
  const mark = result.ok ? green('ok') : red('failed');
  print(`${mark} ${bold(result.nameWithOwner)} ${dim(result.path)}`);
  print(`   ${result.reason}${result.auth ? dim(` (${result.auth})`) : ''}`);
  if (result.quarantinedTo) print(yellow(`   an invalid directory at the mirror path was moved to ${result.quarantinedTo}`));
}

function renderReconcile(result: AutonomousEnrollmentResult): void {
  const { plan } = result;
  print(bold(result.applied ? 'Autonomous enrollment reconciled' : 'Autonomous enrollment plan (dry run — add --apply)'));
  print(`  desired mirrors: ${plan.desired.length}`);
  for (const path of plan.enroll) print(`  ${green('+ enroll')}   ${path}`);
  for (const path of plan.unenroll) print(`  ${yellow('- unenroll')} ${path} ${dim('(mirror left the grant; registry only, the clone stays)')}`);
  for (const path of plan.pendingMirrors) print(`  ${dim('… pending')}  ${path} ${dim('(enrolled after its first sync)')}`);
  if (plan.enroll.length + plan.unenroll.length === 0) print(dim('  nothing to change'));
  for (const path of plan.untouched) print(`  ${dim('= kept')}     ${path} ${dim('(your checkout: stays enrolled; the fleet never works in it)')}`);
  for (const error of result.errors) print(`  ${red('error')} ${error.path}: ${error.reason}`);
}

function renderRelease(result: AutonomousReleaseResult): void {
  const { plan } = result;
  print(bold(result.applied ? 'Fleet mirrors unenrolled' : 'Release plan (dry run — add --apply)'));
  for (const path of plan.unenroll) {
    const done = !result.applied || result.unenrolled.includes(path);
    if (done) print(`  ${yellow('- unenroll')} ${path} ${dim('(registry only; the clone stays)')}`);
  }
  if (plan.unenroll.length === 0) print(dim('  no fleet mirror is enrolled'));
  for (const path of plan.untouched) print(`  ${dim('= kept')}     ${path}`);
  for (const error of result.errors) print(`  ${red('error')} ${error.path}: ${error.reason}`);
}

/** `ashlr mirror …` entry point. Never throws for expected failures; returns the exit code. */
export async function runMirrorCli(args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args;
  const parsed = parseArgs(rest);
  if (parsed.error) return fail(parsed.error);
  const mirrors = await import('../core/fleet/mirrors.js');

  switch (sub) {
    case 'list':
    case 'ls': {
      const rows = mirrors.listMirrors();
      if (parsed.json) printJson(rows);
      else renderList(rows);
      return 0;
    }

    case 'path': {
      const [name] = parsed.positional;
      const identity = mirrors.parseNameWithOwner(name);
      if (!identity) return fail('mirror path needs <owner/name>');
      print(mirrors.mirrorPathFor(identity.nameWithOwner));
      return 0;
    }

    case 'add': {
      const [name, extra] = parsed.positional;
      if (!name || extra) return fail('mirror add needs exactly one <owner/name>');
      if (!mirrors.parseNameWithOwner(name)) return fail(`not a GitHub owner/name: ${name}`);
      const result = await mirrors.ensureMirror({ nameWithOwner: name, base: parsed.base });
      if (parsed.json) printJson(result);
      else renderSync(result);
      return result.ok ? 0 : 1;
    }

    case 'sync': {
      if (parsed.all && parsed.positional.length > 0) return fail('use either --all or repo names, not both');
      const names = parsed.all
        ? mirrors.listMirrors().map((row) => row.nameWithOwner)
        : parsed.positional;
      if (names.length === 0) return fail(parsed.all ? 'no mirrors to sync' : 'mirror sync needs <owner/name>... or --all');
      const invalid = names.find((name) => !mirrors.parseNameWithOwner(name));
      if (invalid) return fail(`not a GitHub owner/name: ${invalid}`);
      const results: MirrorSyncResult[] = [];
      // Sequential on purpose: a manual sync is not latency-critical, and it
      // keeps the output in the order Mason asked for.
      for (const name of names) results.push(await mirrors.ensureMirror({ nameWithOwner: name }));
      if (parsed.json) printJson(results);
      else results.forEach(renderSync);
      return results.every((result) => result.ok) ? 0 : 1;
    }

    case 'remove':
    case 'rm': {
      const [name, extra] = parsed.positional;
      if (!name || extra) return fail('mirror remove needs exactly one <owner/name>');
      if (!mirrors.parseNameWithOwner(name)) return fail(`not a GitHub owner/name: ${name}`);
      const result = await mirrors.removeMirror(name, { force: parsed.force });
      if (parsed.json) printJson(result);
      else print(`${result.ok ? green('removed') : red('refused')} ${name}: ${result.reason}`);
      return result.ok ? 0 : 1;
    }

    case 'reconcile': {
      const { currentStandingPolicy } = await import('../core/authority/effective-config.js');
      const policy = currentStandingPolicy();
      if (!policy) {
        const message = 'no standing policy is in force, so there is no grant repo list to reconcile against — ' +
          'outside a standing grant the enrollment registry is yours (`ashlr enroll …`)';
        if (parsed.json) printJson({ ok: false, reason: message });
        else print(yellow(message));
        return 1;
      }
      const result = await mirrors.reconcileAutonomousEnrollment(policy, { apply: parsed.apply });
      if (parsed.json) printJson(result);
      else renderReconcile(result);
      return result.errors.length === 0 ? 0 : 1;
    }

    case 'release': {
      // No policy check on purpose: release is the way back out, and it only
      // ever removes fleet mirror paths. A standing daemon that is still
      // running re-enrolls its grant's mirrors on its next tick.
      const result = await mirrors.releaseAutonomousEnrollment({ apply: parsed.apply });
      if (parsed.json) printJson(result);
      else renderRelease(result);
      return result.errors.length === 0 ? 0 : 1;
    }

    case 'help':
    case '--help':
    case '-h':
      print(USAGE);
      return 0;

    default:
      return fail(`unknown mirror command: ${sub}`);
  }
}
