/**
 * cmdWorker — M112
 *
 * `ashlr worker setup --user "<name>" [--repos <a,b,c>] [--queue <shared-dir>] [--yes]`
 * `ashlr worker status`
 *
 * Turns a spare Mac into an unattended autonomous worker in one command.
 * Orchestrates:
 *   1. setupWizard (identity via M110 stepUser)
 *   2. repo enrollment (sandbox/policy.js)
 *   3. daemon service install with keepAwake: true (launchd + caffeinate)
 *   4. optional shared-queue registration (cfg.fleet.sharedQueue)
 */

import { loadConfig, saveConfig } from '../core/config.js';
import { setupWizard } from '../core/onboard.js';
import { enroll, listEnrolled } from '../core/sandbox/policy.js';
import { install as installService, serviceStatus } from '../core/daemon/service.js';

// ─── colour helpers (TTY-aware, same as setup.ts) ────────────────────────────

function isTty(): boolean {
  return process.stdout.isTTY === true;
}

function makeColors(enabled: boolean) {
  const c =
    (code: number) =>
    (s: string) =>
      enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    bold:   c(1),
    green:  c(32),
    yellow: c(33),
    cyan:   c(36),
    dim:    c(2),
    red:    c(31),
  };
}

// ─── Worker setup ─────────────────────────────────────────────────────────────

async function cmdWorkerSetup(args: string[]): Promise<number> {
  const colors = makeColors(isTty());
  const { bold, green, cyan, yellow, dim } = colors;

  const yesMode = args.includes('--yes') || !process.stdin.isTTY;

  // --user "<name>"
  const userFlagIdx = args.findIndex((a) => a === '--user');
  const userName = userFlagIdx !== -1 ? args[userFlagIdx + 1] : undefined;

  // --repos a,b,c
  const reposFlagIdx = args.findIndex((a) => a === '--repos');
  const reposRaw = reposFlagIdx !== -1 ? args[reposFlagIdx + 1] : undefined;
  const repos: string[] = reposRaw
    ? reposRaw.split(',').map((r) => r.trim()).filter(Boolean)
    : [];

  // --queue <shared-dir>
  const queueFlagIdx = args.findIndex((a) => a === '--queue');
  const queuePath = queueFlagIdx !== -1 ? args[queueFlagIdx + 1] : undefined;

  // ── 1. Load config + run full setupWizard (identity + engines + daemon + enroll) ──
  let cfg = loadConfig();

  // Pre-seed roots so stepEnroll inside setupWizard can pick them up
  if (repos.length > 0) {
    cfg = { ...cfg, roots: [...new Set([...(cfg.roots ?? []), ...repos])] };
  }

  console.log(bold('\nashlr worker setup\n'));

  const result = await setupWizard(cfg, { wire: false, yes: yesMode, userName });
  cfg = loadConfig(); // reload — setupWizard may have persisted mutations

  // ── 2. Explicitly enroll any repos specified via --repos ──────────────────
  if (repos.length > 0) {
    for (const repo of repos) {
      try {
        enroll(repo);
      } catch (err) {
        console.warn(yellow(`  warn: could not enroll ${repo}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  // ── 3. Register shared queue path ────────────────────────────────────────
  if (queuePath) {
    const cfgAny = cfg as unknown as Record<string, unknown>;
    const fleet = (cfgAny.fleet as Record<string, unknown> | undefined) ?? {};
    const updated = {
      ...cfg,
      fleet: {
        ...fleet,
        sharedQueue: { path: queuePath },
      },
    };
    saveConfig(updated as typeof cfg);
    cfg = loadConfig();
  }

  // ── 4. (Re-)install daemon with keepAwake: true ────────────────────────────
  // setupWizard already called stepDaemonService, but we reinstall explicitly
  // to ensure keepAwake is set. Idempotent: backs up existing plist.
  try {
    await installService({ keepAwake: true });
  } catch (err) {
    console.warn(yellow(`  warn: daemon reinstall with keepAwake failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // ── 5. Print worker summary ───────────────────────────────────────────────
  const workerName = cfg.user?.name ?? userName ?? 'unnamed';
  const enrolled   = listEnrolled();
  const fleet      = ((cfg as unknown as Record<string, unknown>).fleet) as Record<string, unknown> | undefined;
  const sharedQ    = (fleet?.sharedQueue as { path?: string } | undefined)?.path;

  console.log('\n' + green('  this Mac is now worker') + ' ' + bold(cyan(workerName)) + '\n');

  console.log('  repos   : ' + (enrolled.length ? enrolled.map((r) => dim(r)).join(', ') : dim('(none enrolled)')));
  console.log('  queue   : ' + (sharedQ ? dim(sharedQ) : dim('standalone (repo-partition)')));
  console.log('  keepAwake: ' + green('on') + dim('  (caffeinate -i -s — daemon ticks while plugged in)'));
  console.log('');

  // Engine + pulse reminders from setupWizard
  if (result.nextSteps && result.nextSteps.length > 0) {
    console.log(bold('  next steps:'));
    for (const step of result.nextSteps) {
      console.log('    ' + dim('•') + ' ' + step);
    }
    console.log('');
  }

  // 8GB-friendly reminder
  console.log(dim('  tip: on 8 GB Macs use subscription engines (no large local models):'));
  console.log(dim('       ashlr config set engines.providerChain claude,openai'));
  console.log('');
  console.log(dim('  power note: keep the Mac plugged in for uninterrupted lid-closed operation.'));
  console.log(dim('              caffeinate -i prevents idle sleep; -s prevents system sleep'));
  console.log(dim('              while on AC power.  On battery, macOS may still sleep.'));
  console.log('');

  return 0;
}

// ─── Worker status ────────────────────────────────────────────────────────────

async function cmdWorkerStatus(_args: string[]): Promise<number> {
  const colors = makeColors(isTty());
  const { bold, green, red, dim, cyan } = colors;

  const cfg    = loadConfig();
  const name   = cfg.user?.name ?? dim('(not set)');
  const userId = cfg.user?.id   ?? dim('(not set)');
  const enrolled = listEnrolled();
  const fleet  = ((cfg as unknown as Record<string, unknown>).fleet) as Record<string, unknown> | undefined;
  const sharedQ = (fleet?.sharedQueue as { path?: string } | undefined)?.path;

  const svc = serviceStatus();

  const runningLabel = svc.running
    ? green('running')
    : svc.installed
    ? red('installed but not running')
    : red('not installed');

  console.log('\n' + bold('ashlr worker status') + '\n');
  console.log('  identity   : ' + bold(cyan(String(name))) + '  ' + dim(String(userId)));
  console.log('  repos      : ' + (enrolled.length ? enrolled.map((r) => dim(r)).join(', ') : dim('(none)')));
  console.log('  queue      : ' + (sharedQ ? dim(sharedQ) : dim('standalone (repo-partition)')));
  console.log('  daemon     : ' + runningLabel + dim('  [' + svc.platformSpec + ']'));
  if (svc.serviceFilePath) {
    console.log('  svc file   : ' + dim(svc.serviceFilePath));
  }
  console.log('');

  return 0;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function cmdWorker(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'setup':
      return cmdWorkerSetup(rest);

    case 'status':
      return cmdWorkerStatus(rest);

    default: {
      const colors = makeColors(isTty());
      console.error(colors.red('error: ') + `unknown worker subcommand: ${sub ?? '(none)'}`);
      console.error('');
      console.error('usage:');
      console.error('  ashlr worker setup --user "<name>" [--repos <a,b,c>] [--queue <dir>] [--yes]');
      console.error('  ashlr worker status');
      console.error('');
      return 1;
    }
  }
}
