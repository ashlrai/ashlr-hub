/**
 * `ashlr daemon` — the M24 autonomous operator CLI surface.
 *
 * The daemon pulls the highest-value backlog items for ENROLLED repos and
 * dispatches SANDBOXED swarms whose output becomes PENDING PROPOSALS in the
 * Approval Inbox. It is SAFE BY CONSTRUCTION: it can ONLY propose; it has NO
 * path to apply / push / PR / deploy / mutate.
 *
 * Subcommands:
 *   daemon start [--once] [--dry-run] [--drain diagnostic-reslices] [--limit <n>]
 *                [--budget <usd>] [--interval <ms>] [--parallel <n>]
 *       Load cfg, merge flags over cfg.daemon defaults into a DaemonConfig,
 *       call runDaemon. --dry-run => plan only (which items WOULD be worked;
 *       NO swarm/proposal). REFUSES (nonzero, clear message) when
 *       ASHLR_IN_DAEMON / ASHLR_IN_SWARM is set (no fork bomb).
 *   daemon stop
 *       Set the kill switch and request an orderly resident shutdown. Idempotent.
 *   daemon status
 *       Print running?, last tick, today's spend vs cap, items processed,
 *       pending proposals (M23 pendingCount). READ-ONLY.
 *
 * This file has NO outward-action path: it never applies, pushes, opens a PR,
 * or deploys. Its only inbox interaction is the READ-ONLY pendingCount() (for
 * status); all proposal creation happens inside the sandboxed swarm.
 */

import { makeColors } from './ui.js';
import { DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT } from '../core/types.js';
import type { AshlrConfig, DaemonConfig, DaemonDrainMode, DaemonState } from '../core/types.js';
import type { ServiceInstallOptions, ServiceStatusResult } from '../core/daemon/service.js';
import type { PolicyMutationResult } from '../core/sandbox/policy.js';

type DaemonSubcommand = 'start' | 'stop' | 'status' | 'install' | 'uninstall' | 'service-status';

const DAEMON_SUBCOMMANDS = new Set<DaemonSubcommand>([
  'start',
  'stop',
  'status',
  'install',
  'uninstall',
  'service-status',
]);

const NO_FLAGS = new Set<string>();
const JSON_FLAG = new Set(['--json']);
const INSTALL_FLAGS = new Set(['--no-autostart']);

const DAEMON_USAGE: Record<DaemonSubcommand, string> = {
  start:
    'Usage: ashlr daemon start [--once] [--dry-run] [--drain diagnostic-reslices] [--limit <n>] [--budget <usd>] [--interval <ms>] [--parallel <n>]',
  stop: 'Usage: ashlr daemon stop',
  status: 'Usage: ashlr daemon status [--json]',
  install: 'Usage: ashlr daemon install [--no-autostart]',
  uninstall: 'Usage: ashlr daemon uninstall',
  'service-status': 'Usage: ashlr daemon service-status [--json]',
};

const DAEMON_TOP_LEVEL_USAGE = `Usage: ashlr daemon [subcommand] [flags]

Subcommands:
  start           Run the proposal-only daemon
  stop            Request an orderly daemon shutdown
  status          Show daemon state [--json]
  install         Install the OS service [--no-autostart]
  uninstall       Remove the OS service
  service-status  Show OS service state [--json]

Run \`ashlr daemon <subcommand> --help\` for subcommand usage.`;

// ---------------------------------------------------------------------------
// Lazy loaders — degrade gracefully if a core module is not yet built.
// ---------------------------------------------------------------------------

type RunDaemonFn = (
  cfg: AshlrConfig,
  opts: { once: boolean; dryRun: boolean; drain?: DaemonDrainMode; drainLimit?: number },
) => Promise<DaemonState>;
type StopDaemonFn = () => PolicyMutationResult | void;
type LoadDaemonStateFn = () => DaemonState;
type PendingCountFn = () => number;
type LoadConfigFn = () => AshlrConfig;
type GuardHealthDiagnosis = import('../core/daemon/guard-health.js').GuardHealthDiagnosis;
type DiagnoseGuardHealthFn = () => GuardHealthDiagnosis;

async function importLoop(): Promise<{
  runDaemon: RunDaemonFn;
  stopDaemon: StopDaemonFn;
} | null> {
  try {
    const mod = (await import('../core/daemon/loop.js')) as {
      runDaemon: RunDaemonFn;
      stopDaemon: StopDaemonFn;
    };
    return { runDaemon: mod.runDaemon, stopDaemon: mod.stopDaemon };
  } catch {
    return null;
  }
}

async function importState(): Promise<{ loadDaemonState: LoadDaemonStateFn } | null> {
  try {
    const mod = (await import('../core/daemon/state.js')) as {
      loadDaemonState: LoadDaemonStateFn;
    };
    return { loadDaemonState: mod.loadDaemonState };
  } catch {
    return null;
  }
}

async function importPendingCount(): Promise<PendingCountFn | null> {
  try {
    const mod = (await import('../core/inbox/store.js')) as {
      pendingCount: PendingCountFn;
    };
    return mod.pendingCount;
  } catch {
    return null;
  }
}

async function importConfig(): Promise<LoadConfigFn | null> {
  try {
    const mod = (await import('../core/config.js')) as { loadConfig: LoadConfigFn };
    return mod.loadConfig;
  } catch {
    return null;
  }
}

async function importGuardHealth(): Promise<DiagnoseGuardHealthFn | null> {
  try {
    const mod = (await import('../core/daemon/guard-health.js')) as {
      diagnoseGuardHealth: DiagnoseGuardHealthFn;
    };
    return mod.diagnoseGuardHealth;
  } catch {
    return null;
  }
}

async function importServiceConfig(): Promise<
  ((cfg: AshlrConfig | null, overrides?: { autostart?: boolean }) => ServiceInstallOptions) | null
> {
  try {
    const mod = await import('../core/daemon/service-config.js');
    return mod.daemonServiceInstallOptions;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

function isDaemonSubcommand(value: string): value is DaemonSubcommand {
  return DAEMON_SUBCOMMANDS.has(value as DaemonSubcommand);
}

function printDaemonUsage(subcommand?: DaemonSubcommand): void {
  console.log(subcommand ? DAEMON_USAGE[subcommand] : DAEMON_TOP_LEVEL_USAGE);
}

function validateExactFlags(args: string[], allowed: ReadonlySet<string>): string | undefined {
  for (const arg of args) {
    if (allowed.has(arg)) continue;
    return arg.startsWith('-') ? `Unknown flag: ${arg}` : `Unexpected argument: ${arg}`;
  }
  return undefined;
}

function printDaemonUsageError(message: string, subcommand?: DaemonSubcommand): number {
  const col = makeColors(process.stdout.isTTY === true);
  console.error(col.red('error: ') + message);
  console.error(col.dim(subcommand ? DAEMON_USAGE[subcommand] : DAEMON_TOP_LEVEL_USAGE));
  return 2;
}

interface StartFlags {
  once: boolean;
  dryRun: boolean;
  drain?: DaemonDrainMode;
  limit?: number;
  budgetUsd?: number;
  intervalMs?: number;
  parallel?: number;
}

/** Parse a numeric flag value; returns undefined when missing/invalid. */
function parseNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseStartFlags(args: string[]): { flags: StartFlags; err?: string } {
  const flags: StartFlags = { once: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--once':
        flags.once = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--drain': {
        const v = args[++i];
        if (v !== 'diagnostic-reslices') {
          return { flags, err: '--drain requires one of: diagnostic-reslices' };
        }
        flags.drain = v;
        break;
      }
      case '--limit': {
        const v = parseNum(args[++i]);
        if (v === undefined) return { flags, err: '--limit requires a positive integer' };
        flags.limit = Math.floor(v);
        break;
      }
      case '--budget': {
        const v = parseNum(args[++i]);
        if (v === undefined) return { flags, err: '--budget requires a positive number (USD)' };
        flags.budgetUsd = v;
        break;
      }
      case '--interval': {
        const v = parseNum(args[++i]);
        if (v === undefined) return { flags, err: '--interval requires a positive number (ms)' };
        flags.intervalMs = v;
        break;
      }
      case '--parallel': {
        const v = parseNum(args[++i]);
        if (v === undefined) return { flags, err: '--parallel requires a positive integer' };
        flags.parallel = Math.floor(v);
        break;
      }
      default:
        if (a?.startsWith('-')) return { flags, err: `Unknown flag: ${a}` };
        return { flags, err: `Unexpected argument: ${a}` };
    }
  }
  if (flags.limit !== undefined && flags.drain === undefined) {
    return { flags, err: '--limit requires --drain' };
  }
  return { flags };
}

/**
 * Merge CLI flags over cfg.daemon into the config passed to runDaemon.
 * cfg.daemon grants NO authority — it only tunes the caps (budget/interval/
 * parallel). The daemon remains proposal-only by construction regardless.
 */
function mergeDaemonConfig(cfg: AshlrConfig, flags: StartFlags): AshlrConfig {
  const existing: Partial<DaemonConfig> = cfg.daemon ?? {};
  const merged: Partial<DaemonConfig> = { ...existing };
  if (flags.budgetUsd !== undefined) merged.dailyBudgetUsd = flags.budgetUsd;
  if (flags.intervalMs !== undefined) merged.intervalMs = flags.intervalMs;
  if (flags.parallel !== undefined) merged.parallel = flags.parallel;
  return { ...cfg, daemon: merged };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Relative age string from an ISO timestamp. */
function relAge(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: start
// ---------------------------------------------------------------------------

async function cmdDaemonStart(flags: StartFlags): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  // ── Re-entrancy guard (clear, nonzero refusal) ──────────────────────────
  // runDaemon ALSO refuses internally; we surface a friendly message here so
  // the user gets a non-silent explanation and a nonzero exit code.
  if (process.env['ASHLR_IN_DAEMON'] || process.env['ASHLR_IN_SWARM']) {
    const which = process.env['ASHLR_IN_DAEMON'] ? 'ASHLR_IN_DAEMON' : 'ASHLR_IN_SWARM';
    console.error(
      col.red('error: ') +
        `daemon start refused: ${which} is set — no daemon-inside-daemon / daemon-inside-swarm.`,
    );
    return 1;
  }

  const loadConfig = await importConfig();
  if (!loadConfig) {
    console.error(col.red('error: ') + 'daemon requires src/core/config.ts.');
    return 1;
  }

  const loop = await importLoop();
  if (!loop) {
    console.error(
      col.red('error: ') + 'daemon requires src/core/daemon/loop.ts (M24 module not yet built).',
    );
    return 1;
  }

  let cfg: AshlrConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(col.red('error: ') + 'Failed to load config: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const merged = mergeDaemonConfig(cfg, flags);

  console.log('');
  console.log(
    col.bold('  ashlr daemon') +
      col.dim(
        ` — ${flags.dryRun ? 'dry-run plan' : 'operator'}${flags.once ? ' · single tick' : ' · loop'}`,
      ),
  );
  if (flags.budgetUsd !== undefined) {
    console.log(col.dim(`  daily budget cap: $${flags.budgetUsd}`));
  }
  if (flags.drain !== undefined) {
    console.log(col.dim(`  targeted drain: ${flags.drain}`));
    console.log(col.dim(`  drain limit: ${flags.limit ?? DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT}`));
  }
  console.log(col.dim('  proposal-only · sandboxed · enrollment-only'));
  console.log('');

  // runDaemon never throws by contract; it REFUSES on re-entrancy (handled
  // above) and stops on kill switch / budget exhaustion. It ONLY produces
  // PENDING inbox proposals — never applies/pushes/PRs/deploys/mutates.
  const finalState = await loop.runDaemon(merged, {
    once: flags.once,
    dryRun: flags.dryRun,
    ...(flags.drain ? { drain: flags.drain } : {}),
    ...(flags.limit ? { drainLimit: flags.limit } : {}),
  });

  // Summarize the most-recent tick (if any) for human feedback.
  const lastTick = finalState.ticks[finalState.ticks.length - 1];
  if (lastTick) {
    const reasonColor =
      lastTick.reason === 'ok'
        ? col.green
        : lastTick.reason === 'dry-run'
          ? col.cyan
          : col.yellow;
    console.log(
      '  ' +
        col.bold('last tick: ') +
        reasonColor(lastTick.reason) +
        col.dim(
          `  ·  considered ${lastTick.itemsConsidered}  ·  proposals ${lastTick.proposalsCreated}  ·  $${lastTick.spentUsd.toFixed(4)}`,
        ),
    );
  } else {
    console.log('  ' + col.dim('no tick recorded.'));
  }
  console.log('  ' + col.dim(`today's spend: $${finalState.todaySpentUsd.toFixed(4)}`));
  console.log('  ' + col.dim('Use `ashlr inbox` to review PENDING proposals (never auto-applied).'));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: stop
// ---------------------------------------------------------------------------

async function cmdDaemonStop(): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const loop = await importLoop();
  if (!loop) {
    console.error(
      col.red('error: ') + 'daemon requires src/core/daemon/loop.ts (M24 module not yet built).',
    );
    return 1;
  }

  const stopped = loop.stopDaemon();
  if (stopped !== undefined && (!stopped.ok || !stopped.quiesced)) {
    console.error(
      col.red('error: ') +
      `daemon stop could not confirm quiescence (${stopped.reason}); inspect kill state and reconcile active work before retrying.`,
    );
    return 1;
  }

  console.log('');
  console.log(
    col.green('  ✓ daemon stop requested') +
      col.dim(' — kill switch set; resident state clears after current work settles.'),
  );
  console.log(col.dim('  The resident loop aborts current work and clears state after it settles.'));
  console.log(col.dim('  Re-enable with `ashlr sandbox kill --off` before starting again.'));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: status (READ-ONLY)
// ---------------------------------------------------------------------------

async function cmdDaemonStatus(jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const stateMod = await importState();
  if (!stateMod) {
    console.error(
      col.red('error: ') + 'daemon requires src/core/daemon/state.ts (M24 module not yet built).',
    );
    return 1;
  }

  const state = stateMod.loadDaemonState();

  // pendingCount is READ-ONLY; degrade to 0 if the inbox store is absent.
  const pendingCount = await importPendingCount();
  let pending = 0;
  try {
    if (pendingCount) pending = pendingCount();
  } catch {
    pending = 0;
  }

  // Resolve the configured daily cap for display (best-effort).
  let dailyCap: number | undefined;
  const loadConfig = await importConfig();
  if (loadConfig) {
    try {
      dailyCap = loadConfig().daemon?.dailyBudgetUsd;
    } catch {
      dailyCap = undefined;
    }
  }

  let guardHealth: GuardHealthDiagnosis = {
    generatedAt: new Date().toISOString(),
    blocked: false,
    blocks: [],
  };
  const diagnoseGuardHealth = await importGuardHealth();
  if (diagnoseGuardHealth) {
    try {
      guardHealth = diagnoseGuardHealth();
    } catch {
      guardHealth = { generatedAt: new Date().toISOString(), blocked: false, blocks: [] };
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          running: state.running,
          pid: state.pid,
          startedAt: state.startedAt,
          lastTickAt: state.lastTickAt,
          todayDate: state.todayDate,
          todaySpentUsd: state.todaySpentUsd,
          dailyBudgetUsd: dailyCap ?? null,
          itemsProcessed: state.itemsProcessed,
          pendingProposals: pending,
          guardHealth,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log('');
  console.log(col.bold('  ashlr daemon status'));
  console.log('');
  console.log(
    '  ' +
      col.bold('running:        ') +
      (state.running ? col.green('yes') + col.dim(` (pid ${state.pid ?? '?'})`) : col.dim('no (idle)')),
  );
  console.log('  ' + col.bold('started:        ') + col.dim(relAge(state.startedAt)));
  console.log('  ' + col.bold('last tick:      ') + col.dim(relAge(state.lastTickAt)));
  const capStr = dailyCap !== undefined ? ` / $${dailyCap}` : '';
  console.log(
    '  ' + col.bold("today's spend:  ") + col.dim(`$${state.todaySpentUsd.toFixed(4)}${capStr}`),
  );
  console.log('  ' + col.bold('items processed:') + ' ' + col.dim(String(state.itemsProcessed)));
  console.log(
    '  ' +
      col.bold('pending props:  ') +
      (pending > 0 ? col.yellow(String(pending)) : col.dim('0')),
  );
  console.log(
    '  ' +
      col.bold('guard health:   ') +
      (guardHealth.blocked ? col.yellow(`${guardHealth.blocks.length} block(s)`) : col.green('ok')),
  );
  if (guardHealth.blocked) {
    for (const block of guardHealth.blocks) {
      console.log('    ' + col.yellow(block.id) + col.dim(` - ${block.detail}`));
      if (block.path) console.log('    ' + col.dim(`path: ${block.path}`));
      if (block.repairCommands.length > 0) {
        console.log('    ' + col.dim(`repair: ${block.repairCommands.join(' && ')}`));
      }
    }
  }
  console.log('');
  if (pending > 0) {
    console.log(col.dim('  Review with `ashlr inbox` — proposals are NEVER auto-applied.'));
    console.log('');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lazy loader — service manager (M93)
// ---------------------------------------------------------------------------

async function importServiceManager(): Promise<{
  install: (opts: ServiceInstallOptions) => Promise<void>;
  uninstall: (opts: ServiceInstallOptions) => Promise<void>;
  ensureRunning: (opts: ServiceInstallOptions) => Promise<ServiceStatusResult>;
  serviceStatus: (opts: ServiceInstallOptions) => ServiceStatusResult;
} | null> {
  try {
    const mod = await import('../core/daemon/service.js');
    return {
      install: mod.install,
      uninstall: mod.uninstall,
      ensureRunning: mod.ensureRunning,
      serviceStatus: mod.serviceStatus,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: install
// ---------------------------------------------------------------------------

async function cmdDaemonInstall(autostart: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const svcMod = await importServiceManager();
  if (!svcMod) {
    console.error(col.red('error: ') + 'daemon service manager not available (M93 module not built).');
    return 1;
  }

  const daemonServiceInstallOptions = await importServiceConfig();
  if (!daemonServiceInstallOptions) {
    console.error(col.red('error: ') + 'daemon service config not available (M93 module not built).');
    return 1;
  }

  // Pull budget/interval/parallel from config for the service args.
  const loadConfig = await importConfig();
  let cfg: AshlrConfig | null = null;
  if (loadConfig) {
    try {
      cfg = loadConfig();
    } catch {
      // proceed with defaults
    }
  }
  const opts: ServiceInstallOptions = daemonServiceInstallOptions(cfg, { autostart });

  try {
    await svcMod.install(opts);
  } catch (e) {
    console.error(col.red('error: ') + 'Service installation failed: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const status = autostart ? await svcMod.ensureRunning(opts) : svcMod.serviceStatus(opts);
  console.log('');
  console.log(col.green('  ✓ daemon service installed') + col.dim(` [${status.platformSpec}]`));
  if (status.serviceFilePath) {
    console.log(col.dim(`  service file: ${status.serviceFilePath}`));
  }
  if (autostart) {
    console.log(col.dim('  auto-start on login: enabled'));
    console.log(col.dim(`  service state: ${status.running ? 'running' : 'installed but stopped'}`));
  }
  console.log(col.dim('  Use `ashlr daemon service-status` to verify the OS service state.'));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: uninstall
// ---------------------------------------------------------------------------

async function cmdDaemonUninstall(): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const svcMod = await importServiceManager();
  if (!svcMod) {
    console.error(col.red('error: ') + 'daemon service manager not available (M93 module not built).');
    return 1;
  }

  try {
    await svcMod.uninstall({});
  } catch (e) {
    console.error(col.red('error: ') + 'Service uninstall failed: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  console.log('');
  console.log(col.green('  ✓ daemon service uninstalled') + col.dim(' — service file removed and unregistered.'));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: service-status
// ---------------------------------------------------------------------------

async function cmdDaemonServiceStatus(jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const svcMod = await importServiceManager();
  if (!svcMod) {
    console.error(col.red('error: ') + 'daemon service manager not available (M93 module not built).');
    return 1;
  }

  const status = svcMod.serviceStatus({});

  if (jsonMode) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  console.log('');
  console.log(col.bold('  ashlr daemon service-status'));
  console.log('');
  console.log('  ' + col.bold('platform:   ') + col.dim(status.platformSpec));
  console.log('  ' + col.bold('installed:  ') + (status.installed ? col.green('yes') : col.dim('no')));
  console.log('  ' + col.bold('running:    ') + (status.running ? col.green('yes') : col.dim('no')));
  if (status.serviceFilePath) {
    console.log('  ' + col.bold('file:       ') + col.dim(status.serviceFilePath));
  }
  if (status.errorLog) {
    console.log('  ' + col.bold('error:      ') + col.red(status.errorLog));
  }
  console.log('');
  if (!status.installed) {
    console.log(col.dim('  Run `ashlr daemon install` to register as an OS service.'));
    console.log('');
  }
  return 0;
}

/**
 * `ashlr daemon [start|stop|status|install|uninstall|service-status] [flags]`
 *
 * Returns a process exit code (0 = success, non-zero = error/usage).
 */
export async function cmdDaemon(args: string[]): Promise<number> {
  const requestedSub = args[0];
  if (requestedSub !== undefined && isHelpFlag(requestedSub)) {
    printDaemonUsage();
    return 0;
  }
  if (requestedSub !== undefined && !isDaemonSubcommand(requestedSub)) {
    const message = requestedSub.startsWith('-')
      ? `Unknown flag: ${requestedSub}`
      : `Unknown daemon subcommand: ${requestedSub}`;
    return printDaemonUsageError(message);
  }

  const sub: DaemonSubcommand = requestedSub ?? 'status';
  const rest = args.slice(1);
  if (rest.some(isHelpFlag)) {
    printDaemonUsage(sub);
    return 0;
  }

  let startFlags: StartFlags | undefined;
  let validationError: string | undefined;
  if (sub === 'start') {
    const parsed = parseStartFlags(rest);
    startFlags = parsed.flags;
    validationError = parsed.err;
  } else {
    const allowed = sub === 'install'
      ? INSTALL_FLAGS
      : sub === 'status' || sub === 'service-status'
        ? JSON_FLAG
        : NO_FLAGS;
    validationError = validateExactFlags(rest, allowed);
  }
  if (validationError) return printDaemonUsageError(validationError, sub);

  switch (sub) {
    case 'start':
      return cmdDaemonStart(startFlags!);
    case 'stop':
      return cmdDaemonStop();
    case 'status':
      return cmdDaemonStatus(rest.includes('--json'));
    case 'install':
      return cmdDaemonInstall(!rest.includes('--no-autostart'));
    case 'uninstall':
      return cmdDaemonUninstall();
    case 'service-status':
      return cmdDaemonServiceStatus(rest.includes('--json'));
  }
}
