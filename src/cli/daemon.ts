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
import { serviceActivity } from '../core/daemon/service-activity.js';
import { assertResidentServiceInstallAuthorized } from '../core/daemon/service-install-authority.js';
import type { PolicyMutationResult } from '../core/sandbox/policy.js';

type DaemonSubcommand =
  | 'start'
  | 'stop'
  | 'status'
  | 'activation-preflight'
  | 'activate'
  | 'recover-state'
  | 'resolve-state'
  | 'install'
  | 'uninstall'
  | 'service-status';

const DAEMON_SUBCOMMANDS = new Set<DaemonSubcommand>([
  'start',
  'stop',
  'status',
  'activation-preflight',
  'activate',
  'recover-state',
  'resolve-state',
  'install',
  'uninstall',
  'service-status',
]);

const NO_FLAGS = new Set<string>();
const JSON_FLAG = new Set(['--json']);
const INSTALL_FLAGS = new Set(['--no-autostart']);
const RESOLVE_STATE_VALUE_FLAGS = new Set([
  '--quarantine-plan-id',
  '--quarantine-receipt-sha256',
  '--plan-id',
  '--plan-sha256',
  '--authorize',
  '--confirm',
]);

const DAEMON_USAGE: Record<DaemonSubcommand, string> = {
  start:
    'Usage: ashlr daemon start [--once] [--dry-run] [--drain diagnostic-reslices] [--limit <n>] [--budget <usd>] [--interval <ms>] [--parallel <n>]',
  stop: 'Usage: ashlr daemon stop',
  status: 'Usage: ashlr daemon status [--json]',
  'activation-preflight':
    'Usage: ashlr daemon activation-preflight --request <absolute-canonical-plan-path> [--json]',
  activate:
    'Usage: ashlr daemon activate --request <absolute-canonical-plan-path> --authorize <admission-sha256> --confirm <admission-sha256> [--json]',
  'recover-state':
    'Usage: ashlr daemon recover-state --dry-run --expected-sha256 <sha256> [--json]\n' +
    '   or: ashlr daemon recover-state --execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256> [--json]',
  'resolve-state':
    'Usage: ashlr daemon resolve-state --dry-run --quarantine-plan-id <uuid> --quarantine-receipt-sha256 <sha256> [--json]\n' +
    '   or: ashlr daemon resolve-state --execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256> --confirm <plan-sha256> [--json]',
  install: 'Usage: ashlr daemon install [--no-autostart] (temporarily unavailable)',
  uninstall: 'Usage: ashlr daemon uninstall',
  'service-status': 'Usage: ashlr daemon service-status [--json]',
};

const DAEMON_TOP_LEVEL_USAGE = `Usage: ashlr daemon [subcommand] [flags]

Subcommands:
  start           Run the proposal-only daemon
  stop            Request an orderly daemon shutdown
  status          Show daemon state [--json]
  activation-preflight  Verify operator-custodied signed release and rollback evidence (read-only)
  activate        Validate one exact signed macOS plan; resident mutation remains unavailable
  recover-state   Preview or explicitly execute one exact state quarantine
  resolve-state   Preview or explicitly resolve one exact quarantine
  install         Temporarily unavailable (resident service mutation restricted)
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
type LoadDaemonStateStrictFn =
  typeof import('../core/daemon/state.js')['loadDaemonStateStrict'];
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

async function importState(): Promise<{
  loadDaemonState: LoadDaemonStateFn;
  loadDaemonStateStrict: LoadDaemonStateStrictFn;
} | null> {
  try {
    const mod = (await import('../core/daemon/state.js')) as {
      loadDaemonState: LoadDaemonStateFn;
      loadDaemonStateStrict: LoadDaemonStateStrictFn;
    };
    return {
      loadDaemonState: mod.loadDaemonState,
      loadDaemonStateStrict: mod.loadDaemonStateStrict,
    };
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

async function importConfig(readOnly = false, strict = false): Promise<LoadConfigFn | null> {
  try {
    const mod = (await import('../core/config.js')) as {
      loadConfig: LoadConfigFn;
      loadConfigReadOnly: LoadConfigFn;
      loadConfigReadOnlyStrict: LoadConfigFn;
    };
    return strict ? mod.loadConfigReadOnlyStrict : readOnly ? mod.loadConfigReadOnly : mod.loadConfig;
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

interface RecoverStateFlags {
  mode?: 'dry-run' | 'execute';
  expectedSha256?: string;
  planId?: string;
  planSha256?: string;
  authorization?: string;
  json: boolean;
}

interface ResolveStateFlags {
  mode?: 'dry-run' | 'execute';
  quarantinePlanId?: string;
  quarantineReceiptSha256?: string;
  planId?: string;
  planSha256?: string;
  authorization?: string;
  confirmation?: string;
  json: boolean;
}

interface ActivationPreflightFlags {
  requestPath?: string;
  json: boolean;
}

interface ActivationFlags extends ActivationPreflightFlags {
  authorize?: string;
  confirm?: string;
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

function parseRecoverStateFlags(args: string[]): { flags: RecoverStateFlags; err?: string } {
  const flags: RecoverStateFlags = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--execute') {
      const mode = arg === '--dry-run' ? 'dry-run' : 'execute';
      if (flags.mode && flags.mode !== mode) return { flags, err: '--dry-run and --execute are mutually exclusive' };
      flags.mode = mode;
      continue;
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    const value = args[i + 1];
    if (arg === '--expected-sha256' || arg === '--plan-id' || arg === '--plan-sha256' || arg === '--authorize') {
      if (!value || value.startsWith('-')) return { flags, err: `${arg} requires a value` };
      i += 1;
      if (arg === '--expected-sha256') flags.expectedSha256 = value;
      if (arg === '--plan-id') flags.planId = value;
      if (arg === '--plan-sha256') flags.planSha256 = value;
      if (arg === '--authorize') flags.authorization = value;
      continue;
    }
    return { flags, err: arg?.startsWith('-') ? `Unknown flag: ${arg}` : `Unexpected argument: ${arg}` };
  }
  if (!flags.mode) return { flags, err: 'recover-state requires exactly one of --dry-run or --execute' };
  if (flags.mode === 'dry-run') {
    if (!flags.expectedSha256) return { flags, err: '--dry-run requires --expected-sha256' };
    if (flags.planId || flags.planSha256 || flags.authorization) {
      return { flags, err: '--dry-run does not accept execution authority flags' };
    }
  } else {
    if (!flags.planId || !flags.planSha256 || !flags.authorization) {
      return { flags, err: '--execute requires --plan-id, --plan-sha256, and --authorize' };
    }
    if (flags.expectedSha256) return { flags, err: '--execute is bound by the persisted plan and does not accept --expected-sha256' };
  }
  return { flags };
}

function parseResolveStateFlags(args: string[]): { flags: ResolveStateFlags; err?: string } {
  const flags: ResolveStateFlags = { json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--execute') {
      const mode = arg === '--dry-run' ? 'dry-run' : 'execute';
      if (flags.mode) return { flags, err: '--dry-run and --execute must appear exactly once' };
      flags.mode = mode;
      continue;
    }
    if (arg === '--json') {
      if (seen.has(arg)) return { flags, err: '--json must appear at most once' };
      seen.add(arg);
      flags.json = true;
      continue;
    }
    if (!arg || !RESOLVE_STATE_VALUE_FLAGS.has(arg)) {
      return { flags, err: arg?.startsWith('-') ? `Unknown flag: ${arg}` : `Unexpected argument: ${arg}` };
    }
    if (seen.has(arg)) return { flags, err: `${arg} must appear exactly once` };
    seen.add(arg);
    const value = args[i + 1];
    if (!value || value.startsWith('-')) return { flags, err: `${arg} requires a value` };
    i += 1;
    if (arg === '--quarantine-plan-id') flags.quarantinePlanId = value;
    if (arg === '--quarantine-receipt-sha256') flags.quarantineReceiptSha256 = value;
    if (arg === '--plan-id') flags.planId = value;
    if (arg === '--plan-sha256') flags.planSha256 = value;
    if (arg === '--authorize') flags.authorization = value;
    if (arg === '--confirm') flags.confirmation = value;
  }
  if (!flags.mode) return { flags, err: 'resolve-state requires exactly one of --dry-run or --execute' };
  if (flags.mode === 'dry-run') {
    if (!flags.quarantinePlanId || !flags.quarantineReceiptSha256) {
      return {
        flags,
        err: '--dry-run requires --quarantine-plan-id and --quarantine-receipt-sha256',
      };
    }
    if (flags.planId || flags.planSha256 || flags.authorization || flags.confirmation) {
      return { flags, err: '--dry-run does not accept execution authority flags' };
    }
  } else {
    if (!flags.planId || !flags.planSha256 || !flags.authorization || !flags.confirmation) {
      return {
        flags,
        err: '--execute requires --plan-id, --plan-sha256, --authorize, and --confirm',
      };
    }
    if (flags.quarantinePlanId || flags.quarantineReceiptSha256) {
      return { flags, err: '--execute is bound by the persisted plan and does not accept quarantine receipt flags' };
    }
  }
  return { flags };
}

function parseActivationPreflightFlags(
  args: string[],
): { flags: ActivationPreflightFlags; err?: string } {
  const flags: ActivationPreflightFlags = { json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      if (seen.has(arg)) return { flags, err: '--json must appear at most once' };
      seen.add(arg);
      flags.json = true;
      continue;
    }
    if (arg === '--request') {
      if (seen.has(arg)) return { flags, err: '--request must appear exactly once' };
      seen.add(arg);
      const value = args[i + 1];
      if (!value || value.startsWith('-')) return { flags, err: '--request requires a value' };
      flags.requestPath = value;
      i += 1;
      continue;
    }
    return {
      flags,
      err: arg?.startsWith('-') ? `Unknown flag: ${arg}` : `Unexpected argument: ${arg}`,
    };
  }
  if (!flags.requestPath) return { flags, err: 'activation-preflight requires --request' };
  return { flags };
}

function parseActivationFlags(args: string[]): { flags: ActivationFlags; err?: string } {
  const flags: ActivationFlags = { json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      if (seen.has(arg)) return { flags, err: '--json must appear at most once' };
      seen.add(arg);
      flags.json = true;
      continue;
    }
    if (arg === '--request' || arg === '--authorize' || arg === '--confirm') {
      if (seen.has(arg)) return { flags, err: `${arg} must appear exactly once` };
      seen.add(arg);
      const value = args[i + 1];
      if (!value || value.startsWith('-')) return { flags, err: `${arg} requires a value` };
      if (arg === '--request') flags.requestPath = value;
      else if (arg === '--authorize') flags.authorize = value;
      else flags.confirm = value;
      i += 1;
      continue;
    }
    return { flags, err: arg?.startsWith('-') ? `Unknown flag: ${arg}` : `Unexpected argument: ${arg}` };
  }
  if (!flags.requestPath || !flags.authorize || !flags.confirm) {
    return { flags, err: 'activate requires --request, --authorize, and --confirm exactly once' };
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

  const loadConfig = await importConfig(true, true);
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

  if (finalState.startRefusal) {
    console.error(col.red('error: ') + `daemon start refused: ${finalState.startRefusal}`);
    return 1;
  }
  if (finalState.terminalFailure) {
    console.error(col.red('error: ') + `daemon stopped after terminal failure: ${finalState.terminalFailure}`);
    return 1;
  }

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

  const strictState = stateMod.loadDaemonStateStrict();
  const state = strictState.ok ? strictState.state : stateMod.loadDaemonState();
  const stateSource = strictState.ok
    ? {
        sourceState: 'healthy' as const,
        complete: true,
        reason: strictState.fresh ? 'missing' as const : 'healthy' as const,
      }
    : {
        sourceState: 'degraded' as const,
        complete: false,
        reason: strictState.reason,
        diagnostic: strictState.diagnostic,
      };
  const stateKnown = stateSource.sourceState === 'healthy';

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
    blocked: true,
    blocks: [],
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reasons: ['guard-health-unavailable'],
    },
  };
  const diagnoseGuardHealth = await importGuardHealth();
  if (diagnoseGuardHealth) {
    try {
      guardHealth = diagnoseGuardHealth();
    } catch {
      guardHealth = {
        generatedAt: new Date().toISOString(),
        blocked: true,
        blocks: [],
        sourceQuality: {
          sourceState: 'degraded',
          complete: false,
          reasons: ['guard-health-diagnosis-failed'],
        },
      };
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          running: stateKnown ? state.running : null,
          pid: stateKnown ? state.pid : null,
          startedAt: stateKnown ? state.startedAt : null,
          lastTickAt: stateKnown ? state.lastTickAt : null,
          todayDate: stateKnown ? state.todayDate : null,
          todaySpentUsd: stateKnown ? state.todaySpentUsd : null,
          dailyBudgetUsd: dailyCap ?? null,
          itemsProcessed: stateKnown ? state.itemsProcessed : null,
          pendingProposals: pending,
          stateSource,
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
      (!stateKnown
        ? col.yellow('unknown')
        : state.running
          ? col.green('yes') + col.dim(` (pid ${state.pid ?? '?'})`)
          : col.dim('no (idle)')),
  );
  console.log('  ' + col.bold('state source:   ') +
    (stateKnown ? col.dim(stateSource.reason) : col.yellow(stateSource.reason)));
  if (!strictState.ok) {
    console.log('  ' + col.bold('state issues:   ') +
      col.yellow(strictState.diagnostic.issueCodes.join(', ')));
    console.log('  ' + col.bold('state recovery: ') +
      col.dim(`${strictState.diagnostic.disposition}; automatic repair withheld`));
  }
  console.log('  ' + col.bold('started:        ') + col.dim(stateKnown ? relAge(state.startedAt) : 'unknown'));
  console.log('  ' + col.bold('last tick:      ') + col.dim(stateKnown ? relAge(state.lastTickAt) : 'unknown'));
  const capStr = dailyCap !== undefined ? ` / $${dailyCap}` : '';
  console.log(
    '  ' + col.bold("today's spend:  ") +
      col.dim(stateKnown ? `$${state.todaySpentUsd.toFixed(4)}${capStr}` : 'unknown'),
  );
  console.log('  ' + col.bold('items processed:') + ' ' +
    col.dim(stateKnown ? String(state.itemsProcessed) : 'unknown'));
  console.log(
    '  ' +
      col.bold('pending props:  ') +
      (pending > 0 ? col.yellow(String(pending)) : col.dim('0')),
  );
  console.log(
    '  ' +
      col.bold('guard health:   ') +
      (guardHealth.sourceQuality?.sourceState === 'degraded'
        ? col.yellow('unknown (source degraded)')
        : guardHealth.blocked
          ? col.yellow(`${guardHealth.blocks.length} block(s)`)
          : col.green('ok')),
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
// Subcommand: activation-preflight (strictly read-only artifact authority)
// ---------------------------------------------------------------------------

async function cmdDaemonActivationPreflight(
  flags: ActivationPreflightFlags,
): Promise<number> {
  const col = makeColors(process.stdout.isTTY === true);
  let authority: typeof import('../core/daemon/runtime-activation-authority.js');
  try {
    authority = await import('../core/daemon/runtime-activation-authority.js');
  } catch {
    console.error(col.red('error: ') + 'runtime activation authority preflight is unavailable. No state was changed.');
    return 1;
  }
  const result = authority.preflightRuntimeActivationAuthority({
    requestPath: flags.requestPath!,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log(col.bold('  runtime activation authority preflight'));
    console.log('  ' + col.bold('evidence:      ') +
      (result.preflightPassed ? col.green('passed (no authority)') : col.red('blocked')));
    console.log('  ' + col.bold('activation:    ') + col.yellow('withheld'));
    console.log('  ' + col.bold('plan id:       ') + col.dim(result.plan.planId ?? 'unavailable'));
    console.log('  ' + col.bold('plan SHA-256:  ') + col.dim(result.plan.planDigest ?? 'unavailable'));
    console.log('  ' + col.bold('admission SHA: ') + col.dim(result.plan.admissionDigest ?? 'unavailable'));
    console.log('  ' + col.bold('policy epoch:  ') + col.dim(result.plan.policyEpoch === null
      ? 'unavailable'
      : String(result.plan.policyEpoch)));
    console.log('  ' + col.bold('candidate:     ') + col.dim(
      result.releases.candidate.signedDeclarations.expectedRevision ?? 'unavailable',
    ));
    console.log('  ' + col.bold('rollback:      ') + col.dim(
      result.releases.rollback.signedDeclarations.expectedRevision ?? 'unavailable',
    ));
    for (const blocker of result.blockers) {
      console.log('  ' + col.red(blocker.code) + col.dim(` - ${blocker.detail}`));
    }
    console.log('');
    console.log(col.yellow('  No install, launch, start, deploy, rollback, or daemon-state mutation was performed.'));
    console.log(col.dim(`  Remaining authority: ${result.authorityBlockers.join(', ')}`));
    console.log('');
  }
  return result.preflightPassed ? 0 : 1;
}

async function cmdDaemonActivate(flags: ActivationFlags): Promise<number> {
  const col = makeColors(process.stdout.isTTY === true);
  let transaction: typeof import('../core/daemon/runtime-activation-transaction.js');
  try {
    transaction = await import('../core/daemon/runtime-activation-transaction.js');
  } catch {
    console.error(col.red('error: ') + 'runtime activation admission is unavailable. No state was changed.');
    return 1;
  }
  const result = await transaction.activateRuntimeRelease({
    authorize: flags.authorize!,
    confirm: flags.confirm!,
    requestPath: flags.requestPath!,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log(col.bold('  runtime activation admission (read-only)'));
    console.log('  ' + col.bold('result:       ') + (result.activated ? col.green('activated') : col.red(result.phase)));
    console.log('  ' + col.bold('activation:   ') + col.dim(result.activationId ?? 'unavailable'));
    console.log('  ' + col.bold('candidate:    ') + col.dim(result.candidateRevision ?? 'unavailable'));
    console.log('  ' + col.bold('plan SHA-256: ') + col.dim(result.planDigest ?? 'unavailable'));
    console.log('  ' + col.bold('admission SHA:') + ' ' + col.dim(result.admissionDigest ?? 'unavailable'));
    console.log('  ' + col.bold('request SHA:  ') + col.dim(result.canonicalRequestSha256 ?? 'unavailable'));
    console.log('  ' + col.bold('trust SHA:    ') + col.dim(result.trustRootCanonicalSha256 ?? 'unavailable'));
    console.log('  ' + col.bold('mutation:     ') + col.dim('not performed'));
    console.log('  ' + col.dim(result.reason));
    console.log('');
  }
  return result.activated ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: recover-state (dry-run plan or explicitly authorized quarantine)
// ---------------------------------------------------------------------------

async function cmdDaemonRecoverState(flags: RecoverStateFlags): Promise<number> {
  const col = makeColors(process.stdout.isTTY === true);
  const svcMod = await importServiceManager();
  if (!svcMod) {
    console.error(col.red('error: ') + 'daemon service observation is unavailable. No state was changed.');
    return 1;
  }
  let recovery: typeof import('../core/daemon/state-recovery.js');
  try {
    recovery = await import('../core/daemon/state-recovery.js');
  } catch {
    console.error(col.red('error: ') + 'daemon state recovery module is unavailable. No state was changed.');
    return 1;
  }
  const runtime = {
    serviceStatus: () => svcMod.serviceStatus({}),
    prepareAtomicQuarantineEvidence: recovery.prepareDaemonStateAtomicQuarantineEvidence,
  };
  const result = flags.mode === 'dry-run'
    ? recovery.previewDaemonStateQuarantine(flags.expectedSha256!, runtime)
    : recovery.executeDaemonStateQuarantine({
        planId: flags.planId!,
        planDigest: flags.planSha256!,
        operatorAuthorization: flags.authorization!,
      }, runtime);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(col.red('error: ') + `daemon state recovery refused (${result.reason}): ${result.detail}`);
    console.error(col.dim('No daemon service start, restart, install, or automatic repair was attempted.'));
  } else if ('plan' in result) {
    console.log('');
    console.log(col.bold('  daemon state quarantine preview'));
    console.log('  ' + col.bold('plan id:       ') + col.dim(result.plan.planId));
    console.log('  ' + col.bold('plan SHA-256:  ') + col.dim(result.plan.planDigest));
    console.log('  ' + col.bold('expires:       ') + col.dim(result.plan.expiresAt));
    console.log('  ' + col.bold('signing key:   ') + col.dim(result.plan.signingKeyId));
    console.log('  ' + col.bold('source SHA-256:') + ' ' + col.dim(result.plan.expectedSourceSha256));
    console.log('  ' + col.bold('issues:        ') + col.yellow(result.plan.issueCodes.join(', ')));
    console.log('');
    console.log(col.dim('  Dry-run only: daemon.json was not changed. The persisted plan grants no authority.'));
    console.log(col.dim('  Execution requires --execute plus the exact plan id and digest repeated via --authorize.'));
    console.log('');
  } else {
    console.log('');
    console.log(col.green('  daemon state quarantined with exact evidence preservation'));
    console.log('  ' + col.bold('receipt SHA-256:') + ' ' + col.dim(result.receipt.receiptDigest));
    console.log('  ' + col.bold('source SHA-256: ') + col.dim(result.receipt.sourceSha256));
    console.log('  ' + col.bold('evidence file:  ') + col.dim(result.quarantinePath));
    console.log('');
    console.log(col.yellow('  Daemon startup remains blocked pending a separately authorized migration or resolution.'));
    console.log(col.dim('  No service start, restart, install, or repair was attempted.'));
    console.log('');
  }
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: resolve-state (dry-run plan or explicitly authorized publication)
// ---------------------------------------------------------------------------

async function cmdDaemonResolveState(flags: ResolveStateFlags): Promise<number> {
  const col = makeColors(process.stdout.isTTY === true);
  const svcMod = await importServiceManager();
  if (!svcMod) {
    console.error(col.red('error: ') + 'daemon service observation is unavailable. No state was changed.');
    return 1;
  }
  let recovery: typeof import('../core/daemon/state-recovery.js');
  try {
    recovery = await import('../core/daemon/state-recovery.js');
  } catch {
    console.error(col.red('error: ') + 'daemon state resolution module is unavailable. No state was changed.');
    return 1;
  }
  const loadConfig = await importConfig(true, true);
  if (!loadConfig) {
    console.error(col.red('error: ') + 'strict daemon budget configuration is unavailable. No state was changed.');
    return 1;
  }
  const configuredDailyBudgetUsd = (): number => {
    const configured = loadConfig().daemon?.dailyBudgetUsd;
    if (configured !== undefined &&
      (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0)) {
      throw new Error('daemon.dailyBudgetUsd must be a finite positive number');
    }
    return configured ?? 1;
  };
  const runtime = {
    serviceStatus: () => svcMod.serviceStatus({}),
    dailyBudgetUsd: configuredDailyBudgetUsd,
  };
  const result = flags.mode === 'dry-run'
    ? recovery.previewDaemonStateResolution({
        quarantinePlanId: flags.quarantinePlanId!,
        quarantineReceiptDigest: flags.quarantineReceiptSha256!,
      }, runtime)
    : recovery.executeDaemonStateResolution({
        planId: flags.planId!,
        planDigest: flags.planSha256!,
        operatorAuthorization: flags.authorization!,
        operatorConfirmation: flags.confirmation!,
      }, runtime);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(col.red('error: ') + `daemon state resolution refused (${result.reason}): ${result.detail}`);
    console.error(col.dim('No daemon service start, restart, install, or automatic repair was attempted.'));
  } else if ('plan' in result) {
    console.log('');
    console.log(col.bold('  daemon state resolution preview'));
    console.log('  ' + col.bold('plan id:        ') + col.dim(result.plan.planId));
    console.log('  ' + col.bold('plan SHA-256:   ') + col.dim(result.plan.planDigest));
    console.log('  ' + col.bold('expires:        ') + col.dim(result.plan.expiresAt));
    console.log('  ' + col.bold('signing key:    ') + col.dim(result.plan.signingKeyId));
    console.log('  ' + col.bold('quarantine rcpt:') + ' ' + col.dim(result.plan.quarantineReceiptDigest));
    console.log('  ' + col.bold('fresh state:    ') + col.dim(result.plan.freshStateSha256));
    console.log('');
    console.log(col.dim('  Dry-run only: daemon.json and the active recovery marker were not changed.'));
    console.log(col.dim('  Execution requires the exact plan digest via --plan-sha256, --authorize, and --confirm.'));
    console.log('');
  } else {
    console.log('');
    console.log(col.green('  daemon state resolved with preserved quarantine evidence'));
    console.log('  ' + col.bold('receipt SHA-256:') + ' ' + col.dim(result.receipt.receiptDigest));
    console.log('  ' + col.bold('fresh state:    ') + col.dim(result.receipt.freshStateSha256));
    console.log('  ' + col.bold('evidence file:  ') + col.dim(result.quarantinePath));
    console.log('  ' + col.bold('retired marker: ') + col.dim(result.retiredMarkerPath));
    console.log('');
    console.log(col.yellow('  Daemon remains stopped. Start or install it only through a separate authorized operation.'));
    console.log(col.dim('  No service start, restart, install, or repair was attempted.'));
    console.log('');
  }
  return result.ok ? 0 : 1;
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

  try {
    assertResidentServiceInstallAuthorized();
  } catch (error) {
    console.error(
      col.red('error: ')
      + 'daemon service installation is temporarily unavailable: '
      + (error instanceof Error ? error.message : String(error))
      + '. No config or service state was inspected or changed. '
      + 'Existing services support status and uninstall only.',
    );
    return 1;
  }

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
    const activity = serviceActivity(status);
    console.log(col.dim('  auto-start on login: enabled'));
    console.log(col.dim(
      `  service state: ${
        activity === 'running'
          ? 'running'
          : activity === 'scheduler-active-unverified'
            ? 'scheduler active; daemon liveness unverified'
            : activity === 'unknown'
              ? 'runtime unknown'
              : 'installed but stopped'
      }`,
    ));
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
  const activity = serviceActivity(status);

  if (jsonMode) {
    console.log(JSON.stringify({ ...status, activity }, null, 2));
    return 0;
  }

  console.log('');
  console.log(col.bold('  ashlr daemon service-status'));
  console.log('');
  console.log('  ' + col.bold('platform:   ') + col.dim(status.platformSpec));
  console.log('  ' + col.bold('registration:') + ' ' + (
    status.registrationState === 'present'
      ? col.green('present')
      : status.registrationState === 'absent'
        ? col.dim('absent')
        : col.yellow('unknown (not proven absent)')
  ));
  console.log('  ' + col.bold('installed:  ') + (status.installed ? col.green('yes') : col.dim('no')));
  console.log(
    '  ' + col.bold('running:    ') +
      (activity === 'unknown'
        ? col.yellow('unknown')
        : activity === 'running'
          ? col.green('yes')
          : activity === 'scheduler-active-unverified'
            ? col.yellow(`unverified (scheduler ${status.runtimeState})`)
            : col.dim('no')),
  );
  if (status.serviceFilePath) {
    console.log('  ' + col.bold('file:       ') + col.dim(status.serviceFilePath));
  }
  if (status.errorLog) {
    console.log('  ' + col.bold('error:      ') + col.red(status.errorLog));
  }
  console.log('');
  if (!status.installed) {
    console.log(col.dim('  Resident service installation is temporarily unavailable.'));
    console.log(col.dim('  One-shot admitted workflows remain available.'));
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
  let activationPreflightFlags: ActivationPreflightFlags | undefined;
  let activationFlags: ActivationFlags | undefined;
  let recoverStateFlags: RecoverStateFlags | undefined;
  let resolveStateFlags: ResolveStateFlags | undefined;
  let validationError: string | undefined;
  if (sub === 'start') {
    const parsed = parseStartFlags(rest);
    startFlags = parsed.flags;
    validationError = parsed.err;
  } else if (sub === 'activation-preflight') {
    const parsed = parseActivationPreflightFlags(rest);
    activationPreflightFlags = parsed.flags;
    validationError = parsed.err;
  } else if (sub === 'activate') {
    const parsed = parseActivationFlags(rest);
    activationFlags = parsed.flags;
    validationError = parsed.err;
  } else if (sub === 'recover-state') {
    const parsed = parseRecoverStateFlags(rest);
    recoverStateFlags = parsed.flags;
    validationError = parsed.err;
  } else if (sub === 'resolve-state') {
    const parsed = parseResolveStateFlags(rest);
    resolveStateFlags = parsed.flags;
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
    case 'activation-preflight':
      return cmdDaemonActivationPreflight(activationPreflightFlags!);
    case 'activate':
      return cmdDaemonActivate(activationFlags!);
    case 'recover-state':
      return cmdDaemonRecoverState(recoverStateFlags!);
    case 'resolve-state':
      return cmdDaemonResolveState(resolveStateFlags!);
    case 'install':
      return cmdDaemonInstall(!rest.includes('--no-autostart'));
    case 'uninstall':
      return cmdDaemonUninstall();
    case 'service-status':
      return cmdDaemonServiceStatus(rest.includes('--json'));
  }
}
