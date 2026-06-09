/**
 * `ashlr swarm` and `ashlr swarms` CLI commands.
 *
 * `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background]
 *   [--resume <id>] [--dry-run] [--allow-cloud] [--project <path>] [--json] [--no-capture]`
 *
 * Subcommands:
 *   `ashlr swarm show <id>`         — print a saved swarm in detail.
 *   `ashlr swarm verify <id>`       — verify all task output signatures (M17).
 *   `ashlr swarm approve <id>`      — explicit human resume of a needs-approval swarm (M17).
 *   `ashlr swarm rollback <id>`     — restore a project to its pre-swarm git state (M17).
 *
 * `ashlr swarms [--json]` — list persisted swarms.
 *
 * Exit codes:
 *   0  success
 *   1  swarm failed / aborted / not-found / verify-fail / rollback-refused
 *   2  bad usage
 *   3  recursion guard (ASHLR_IN_SWARM is set)
 */

import * as readline from 'node:readline';
import type {
  SwarmRun,
  SwarmOptions,
  SwarmTaskRun,
  OutputSignature,
  RollbackSnapshot,
} from '../core/types.js';
import { pad, makeColors, isTty, isStderrTty } from './ui.js';
import { parsePositiveInt } from './args.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());
const seCol = makeColors(isStderrTty());

// ---------------------------------------------------------------------------
// Lazy imports — core/swarm modules built by other M12/M17 agents
// ---------------------------------------------------------------------------

async function importConfig() {
  return import('../core/config.js') as Promise<{
    loadConfig: () => import('../core/types.js').AshlrConfig;
  }>;
}

type RunnerMod = {
  runSwarm: (
    input: { goal: string; specId?: string },
    cfg: import('../core/types.js').AshlrConfig,
    opts: SwarmOptions,
    sink: (e: import('../core/types.js').RunStreamEvent) => void,
  ) => Promise<SwarmRun>;
};

async function importRunner(): Promise<RunnerMod> {
  return import('../core/swarm/runner.js') as Promise<RunnerMod>;
}

type StoreMod = {
  loadSwarm: (id: string) => SwarmRun | null;
  listSwarms: () => SwarmRun[];
  saveSwarm: (s: SwarmRun) => void;
};

async function importStore(): Promise<StoreMod> {
  return import('../core/swarm/store.js') as Promise<StoreMod>;
}

type SpecStoreMod = {
  loadSpec: (id: string) => { meta: import('../core/types.js').SpecArtifact; body: string } | null;
};

async function importSpecStore(): Promise<SpecStoreMod> {
  return import('../core/spec/spec-store.js') as Promise<SpecStoreMod>;
}

type StreamingMod = {
  nullSink: () => (e: import('../core/types.js').RunStreamEvent) => void;
  makeCliSink: (opts: { json: boolean }) => (e: import('../core/types.js').RunStreamEvent) => void;
};

/**
 * Lazily import streaming.ts (M11). Falls back gracefully to stubs if not
 * present so the CLI can run without the streaming module.
 */
async function importStreaming(): Promise<StreamingMod> {
  try {
    return await import('../core/run/streaming.js') as StreamingMod;
  } catch {
    const noop = () => (_e: import('../core/types.js').RunStreamEvent) => { /* no-op */ };
    return { nullSink: noop, makeCliSink: noop };
  }
}

// M17: lazy sign module — gracefully absent when not yet built.
type SignMod = {
  verifyOutput: (content: string, sig: OutputSignature, cfg: import('../core/types.js').AshlrConfig) => boolean;
};

async function importSign(): Promise<SignMod | null> {
  try {
    return await import('../core/swarm/sign.js') as SignMod;
  } catch {
    return null;
  }
}

// M17: lazy rollback module — gracefully absent when not yet built.
type RollbackMod = {
  rollbackTo: (
    snap: RollbackSnapshot,
    opts: { force: boolean },
  ) => Promise<{ ok: boolean; detail: string }>;
};

async function importRollback(): Promise<RollbackMod | null> {
  try {
    return await import('../core/swarm/rollback.js') as RollbackMod;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedSwarmArgs {
  subcommand: 'run' | 'show' | 'verify' | 'approve' | 'rollback';
  /** Raw positional: either a quoted goal string or a specId. */
  goalOrSpecId?: string;
  showId?: string;
  /** Id for verify/approve/rollback subcommands. */
  subId?: string;
  budget?: number;
  parallel?: number;
  background: boolean;
  resumeId?: string;
  dryRun: boolean;
  allowCloud: boolean;
  project?: string;
  json: boolean;
  /** Skip auto-capture of this swarm to the genome (M16). */
  noCapture: boolean;
  /** --yes flag: skip interactive confirm prompt (rollback). */
  yes: boolean;
  /** --force flag: allow rollback over a dirty tree. */
  force: boolean;
  /** Bypass an over-cap spend-governance block (M19). Optional — defaults false. */
  overBudget?: boolean;
  usageError?: string;
}

function parseSwarmArgs(args: string[]): ParsedSwarmArgs {
  // Handle M17 subcommands: verify, approve, rollback
  if (args[0] === 'verify') {
    const subId = args[1];
    if (!subId) {
      return {
        subcommand: 'run',
        background: false,
        dryRun: false,
        allowCloud: false,
        json: false,
        noCapture: false,
        yes: false,
        force: false,
        usageError: 'Usage: ashlr swarm verify <id>',
      };
    }
    return {
      subcommand: 'verify',
      subId,
      background: false,
      dryRun: false,
      allowCloud: false,
      json: false,
      noCapture: false,
      yes: false,
      force: false,
    };
  }

  if (args[0] === 'approve') {
    const subId = args[1];
    if (!subId) {
      return {
        subcommand: 'run',
        background: false,
        dryRun: false,
        allowCloud: false,
        json: false,
        noCapture: false,
        yes: false,
        force: false,
        usageError: 'Usage: ashlr swarm approve <id>',
      };
    }
    return {
      subcommand: 'approve',
      subId,
      background: false,
      dryRun: false,
      allowCloud: false,
      json: false,
      noCapture: false,
      yes: false,
      force: false,
    };
  }

  if (args[0] === 'rollback') {
    const subId = args[1];
    if (!subId) {
      return {
        subcommand: 'run',
        background: false,
        dryRun: false,
        allowCloud: false,
        json: false,
        noCapture: false,
        yes: false,
        force: false,
        usageError: 'Usage: ashlr swarm rollback <id> [--yes] [--force]',
      };
    }
    const rest = args.slice(2);
    const yes   = rest.includes('--yes');
    const force = rest.includes('--force');
    const unknown = rest.find(a => a !== '--yes' && a !== '--force');
    if (unknown) {
      return {
        subcommand: 'run',
        background: false,
        dryRun: false,
        allowCloud: false,
        json: false,
        noCapture: false,
        yes: false,
        force: false,
        usageError: `unknown flag for rollback: ${unknown}`,
      };
    }
    return {
      subcommand: 'rollback',
      subId,
      background: false,
      dryRun: false,
      allowCloud: false,
      json: false,
      noCapture: false,
      yes,
      force,
    };
  }

  // Handle `swarm show <id>` subcommand
  if (args[0] === 'show') {
    const showId = args[1];
    if (!showId) {
      return {
        subcommand: 'run',
        background: false,
        dryRun: false,
        allowCloud: false,
        json: false,
        noCapture: false,
        yes: false,
        force: false,
        usageError: 'Usage: ashlr swarm show <id>',
      };
    }
    return {
      subcommand: 'show',
      showId,
      background: false,
      dryRun: false,
      allowCloud: false,
      json: false,
      noCapture: false,
      yes: false,
      force: false,
    };
  }

  const result: ParsedSwarmArgs = {
    subcommand: 'run',
    background: false,
    dryRun: false,
    allowCloud: false,
    json: false,
    noCapture: false,
    yes: false,
    force: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--background' || arg === '--bg') {
      result.background = true;
      i++;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
      i++;
    } else if (arg === '--allow-cloud') {
      result.allowCloud = true;
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--budget') {
      const parsed = parsePositiveInt('budget', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.budget = parsed.n;
      i++;
    } else if (arg === '--parallel') {
      const parsed = parsePositiveInt('parallel', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.parallel = parsed.n;
      i++;
    } else if (arg === '--resume') {
      const val = args[++i];
      if (!val) { result.usageError = '--resume requires a swarm id'; return result; }
      result.resumeId = val;
      i++;
    } else if (arg === '--no-capture') {
      result.noCapture = true;
      i++;
    } else if (arg === '--over-budget') {
      // M19 spend-governance escape hatch — proceed even when over the period cap.
      result.overBudget = true;
      i++;
    } else if (arg === '--project') {
      const val = args[++i];
      if (!val) { result.usageError = '--project requires a path'; return result; }
      result.project = val;
      i++;
    } else if (!arg.startsWith('--')) {
      // positional = goal or specId
      if (result.goalOrSpecId !== undefined) {
        result.usageError = `unexpected positional argument: ${arg}`;
        return result;
      }
      result.goalOrSpecId = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  // goal/specId is required unless --resume is set
  if (!result.goalOrSpecId && !result.resumeId) {
    result.usageError =
      'Usage: ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N]\n' +
      '              [--background] [--resume <id>] [--dry-run] [--allow-cloud]\n' +
      '              [--project <path>] [--json] [--no-capture]\n' +
      '       ashlr swarm show <id>\n' +
      '       ashlr swarm verify <id>\n' +
      '       ashlr swarm approve <id>\n' +
      '       ashlr swarm rollback <id> [--yes] [--force]';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s  / 60);
  const h  = Math.floor(m  / 60);
  const d  = Math.floor(h  / 24);
  if (d > 0)  return `${d}d ago`;
  if (h > 0)  return `${h}h ago`;
  if (m > 0)  return `${m}m ago`;
  return `${s}s ago`;
}

function swarmStatusColor(status: SwarmRun['status']): string {
  switch (status) {
    case 'done':            return green(status);
    case 'running':         return cyan(status);
    case 'planning':        return cyan(status);
    case 'aborted':         return yellow(status);
    case 'failed':          return red(status);
    case 'needs-approval':  return yellow('needs-approval');
    default:                return String(status);
  }
}

function taskStatusColor(status: SwarmTaskRun['status']): string {
  switch (status) {
    case 'done':      return green(status);
    case 'running':   return cyan(status);
    case 'failed':    return red(status);
    case 'pending':   return gray(status);
    case 'skipped':   return dim(status);
    default:          return String(status);
  }
}

function formatDuration(createdAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (ms < 1000)   return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// Swarm summary renderer
// ---------------------------------------------------------------------------

function printSwarmSummary(swarm: SwarmRun): void {
  const {
    id, goal, status, usage, budget, tasks, result,
    createdAt, updatedAt, parallel, specId, project,
    escalations, rollback,
  } = swarm;

  const duration     = formatDuration(createdAt, updatedAt);
  const totalTokens  = usage.tokensIn + usage.tokensOut;
  const doneTasks    = tasks.filter(t => t.status === 'done').length;
  const failedTasks  = tasks.filter(t => t.status === 'failed').length;
  const isLocal      = usage.estCostUsd === 0;

  console.log('');
  console.log(bold('  ashlr swarm') + gray(` — ${id}`));
  console.log('');
  console.log(`  ${bold('Goal:')}      ${goal}`);
  if (specId)   console.log(`  ${bold('Spec ID:')}   ${dim(specId)}`);
  if (project)  console.log(`  ${bold('Project:')}   ${dim(project)}`);
  console.log(
    `  ${bold('Status:')}    ${swarmStatusColor(status)}` +
    (status === 'aborted' ? yellow('  — budget/limit reached') : '') +
    (status === 'needs-approval'
      ? yellow('  — paused at escalation gate; run: ashlr swarm approve ' + id)
      : ''),
  );
  console.log(`  ${bold('Parallel:')}  ${parallel}  ${dim('tasks concurrently (BUILD phase)')}`);
  console.log(`  ${bold('Duration:')}  ${duration}`);
  console.log(`  ${bold('Progress:')}  ${doneTasks}/${tasks.length} tasks done` +
    (failedTasks > 0 ? `  ${red(`${failedTasks} failed`)}` : ''));
  console.log('');

  // ── Escalations (M17) ────────────────────────────────────────────────────
  if (escalations && escalations.length > 0) {
    console.log(`  ${bold(yellow('Escalations:'))}  ${escalations.length} gate trip(s)`);
    for (const esc of escalations) {
      const who = esc.taskId ? dim(`task ${esc.taskId}`) : dim('swarm-level');
      console.log(`    ${yellow('!')}  ${bold(esc.kind)}  ${who}  ${esc.detail}`);
      console.log(`       ${dim(esc.ts)}`);
    }
    console.log('');
  }

  // ── Rollback snapshot (M17) ──────────────────────────────────────────────
  if (rollback) {
    const snapLabel = rollback.isRepo
      ? `${dim(rollback.head ?? 'unknown')}${rollback.dirty
          ? yellow(' (dirty — stash: ' + (rollback.stashRef ?? 'none') + ')')
          : ''}`
      : dim('(not a git repo)');
    console.log(`  ${bold('Rollback:')}  ${snapLabel}`);
    if (rollback.isRepo) {
      console.log(`              ${dim('restore with: ashlr swarm rollback ' + id)}`);
    }
    console.log('');
  }

  // ── Plan / tasks table ───────────────────────────────────────────────────
  if (tasks.length > 0) {
    const phases = ['scaffold', 'build', 'integrate', 'verify', 'review'] as const;

    for (const phase of phases) {
      const phaseTasks = tasks.filter(t => t.phase === phase);
      if (phaseTasks.length === 0) continue;

      const idW     = Math.max(4, ...phaseTasks.map(t => t.id.length));
      const statusW = 8;
      const tokW    = 7;
      const sigW    = 4; // sig/----
      const goalW   = 40;

      console.log(`  ${bold(phase.toUpperCase())} ${dim(`(${phaseTasks.length} task${phaseTasks.length !== 1 ? 's' : ''})`)}`);
      console.log('');
      console.log(
        `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
        `${bold(pad('Tokens', tokW, 'right'))}  ${bold(pad('Sig', sigW))}  ${bold('Goal')}`,
      );
      console.log(
        `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(sigW)}  ${'─'.repeat(goalW)}`,
      );

      for (const t of phaseTasks) {
        const tok = t.usage ? String(t.usage.tokensIn + t.usage.tokensOut) : '—';
        // Find matching spec goal via plan
        const specTask = swarm.plan.tasks.find(s => s.id === t.id);
        const taskGoal = specTask?.goal ?? '';
        const goalTrunc = taskGoal.length > goalW ? taskGoal.slice(0, goalW - 1) + '…' : taskGoal;
        const errorNote = t.error ? red(` ✗ ${t.error.slice(0, 40)}`) : '';
        // Signature indicator
        const sigIndicator = t.signature ? dim('sig') : dim('----');
        console.log(
          `  ${pad(dim(t.id), idW)}  ${pad(taskStatusColor(t.status), statusW)}  ` +
          `${pad(tok, tokW, 'right')}  ${pad(sigIndicator, sigW)}  ${goalTrunc}${errorNote}`,
        );
      }
      console.log('');
    }
  }

  // ── Result ───────────────────────────────────────────────────────────────
  if (result) {
    console.log(`  ${bold('Result:')}`);
    for (const line of result.split('\n')) {
      console.log(`    ${line}`);
    }
    console.log('');
  }

  // ── Usage / cost summary ─────────────────────────────────────────────────
  const cloudNote = isLocal ? green('local — $0.00') : yellow('cloud provider');
  console.log(`  ${bold('Usage:')}`);
  console.log(`    Tokens in:   ${usage.tokensIn.toLocaleString()}`);
  console.log(`    Tokens out:  ${usage.tokensOut.toLocaleString()}`);
  console.log(`    Total:       ${totalTokens.toLocaleString()} / ${budget.maxTokens.toLocaleString()} max`);
  console.log(`    Steps:       ${usage.steps}`);
  console.log(
    `    Est. cost:   ${usage.estCostUsd > 0 ? '$' + usage.estCostUsd.toFixed(6) : '$0.00'}  ${dim('·')}  ${cloudNote}`,
  );
  console.log('');

  // ── Resume / approve hint ─────────────────────────────────────────────────
  if (status === 'aborted' || status === 'failed') {
    console.log(
      `  ${yellow('Tip:')} resume this swarm with ${bold(`ashlr swarm --resume ${id}`)}`,
    );
    console.log('');
  }
  if (status === 'needs-approval') {
    console.log(
      `  ${yellow('Action required:')} this swarm is paused at an escalation gate.`,
    );
    console.log(
      `  Review the escalations above, then run ${bold(`ashlr swarm approve ${id}`)} to resume.`,
    );
    console.log('');
  }

  // ── Show hint ────────────────────────────────────────────────────────────
  console.log(dim(`  Swarm ID: ${id}  |  ashlr swarm show ${id}`));
  console.log('');
}

// ---------------------------------------------------------------------------
// Dry-run plan printer
// ---------------------------------------------------------------------------

function printDryRunPlan(plan: SwarmRun['plan'], opts: { json: boolean }): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }

  const phases = ['scaffold', 'build', 'integrate', 'verify', 'review'] as const;
  const totalTasks = plan.tasks.length;

  console.log('');
  console.log(bold('  ashlr swarm') + gray(' — dry-run plan (no execution)'));
  console.log('');
  console.log(`  ${bold('Goal:')} ${plan.goal}`);
  if (plan.specId) console.log(`  ${bold('Spec:')} ${dim(plan.specId)}`);
  console.log(`  ${bold('Total tasks:')} ${totalTasks}`);
  console.log('');

  for (const phase of phases) {
    const phaseTasks = plan.tasks.filter(t => t.phase === phase);
    if (phaseTasks.length === 0) continue;

    console.log(`  ${bold(cyan(phase.toUpperCase()))} ${dim(`(${phaseTasks.length})`)}`);

    for (const t of phaseTasks) {
      const depStr = t.deps.length > 0 ? gray(` [deps: ${t.deps.join(', ')}]`) : '';
      const goalTrunc = t.goal.length > 70 ? t.goal.slice(0, 69) + '…' : t.goal;
      console.log(`    ${dim(t.id)}  ${goalTrunc}${depStr}`);
    }
    console.log('');
  }

  console.log(dim('  Run without --dry-run to execute this plan.'));
  console.log('');
}

// ---------------------------------------------------------------------------
// `swarm show <id>`
// ---------------------------------------------------------------------------

async function cmdSwarmShow(id: string, jsonMode: boolean): Promise<number> {
  let store: StoreMod;
  try {
    store = await importStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm store (M12 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const swarm = store.loadSwarm(id);

  if (!swarm) {
    const msg = `Swarm not found: ${id}`;
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    } else {
      process.stderr.write(red('error: ') + msg + '\n');
    }
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(swarm, null, 2) + '\n');
    return 0;
  }

  printSwarmSummary(swarm);
  return 0;
}

// ---------------------------------------------------------------------------
// M17: `swarm verify <id>`
// ---------------------------------------------------------------------------

/**
 * Verify all task output signatures in a swarm.
 *
 * For each task that has a signature, calls verifyOutput and prints a
 * per-task PASS/FAIL table.  Exit 0 if all signatures valid, 1 if any
 * fail or the swarm is not found.
 */
async function cmdSwarmVerify(id: string): Promise<number> {
  // Load store
  let store: StoreMod;
  try {
    store = await importStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm store: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const swarm = store.loadSwarm(id);
  if (!swarm) {
    process.stderr.write(red('error: ') + `Swarm not found: ${id}\n`);
    return 1;
  }

  // Load config (needed for verifyOutput key resolution)
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load sign module (M17 — may not yet be built)
  const signMod = await importSign();

  const signedTasks   = swarm.tasks.filter(t => t.signature);
  const unsignedTasks = swarm.tasks.filter(t => !t.signature && t.status === 'done');

  console.log('');
  console.log(bold('  ashlr swarm verify') + gray(` — ${id}`));
  console.log('');
  console.log(`  ${bold('Goal:')}    ${swarm.goal}`);
  console.log(`  ${bold('Status:')}  ${swarmStatusColor(swarm.status)}`);
  console.log(
    `  ${bold('Tasks:')}   ${swarm.tasks.length} total, ` +
    `${signedTasks.length} signed, ${unsignedTasks.length} done-but-unsigned`,
  );
  console.log('');

  if (swarm.tasks.length === 0) {
    console.log(`  ${dim('No tasks in this swarm.')}`);
    console.log('');
    return 0;
  }

  if (!signMod) {
    // M17 sign module not yet built — report all as unverifiable
    process.stderr.write(
      yellow('warn: ') +
      'sign module (core/swarm/sign.ts) not available — cannot verify signatures.\n' +
      '      All tasks are reported as UNSIGNED.\n',
    );
  }

  const idW     = Math.max(6, ...swarm.tasks.map(t => t.id.length));
  const statusW = 8;
  const verW    = 6; // PASS  /FAIL  /SKIP  /UNSIGN
  const algW    = 12;

  console.log(
    `  ${bold(pad('Task ID', idW))}  ${bold(pad('Status', statusW))}  ` +
    `${bold(pad('Verify', verW))}  ${bold(pad('Algorithm', algW))}  ${bold('Detail')}`,
  );
  console.log(
    `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(verW)}  ${'─'.repeat(algW)}  ${'─'.repeat(40)}`,
  );

  let anyFail = false;

  for (const task of swarm.tasks) {
    const taskStatus = taskStatusColor(task.status);

    if (!task.signature) {
      // No signature — not signed (pre-M17 swarm or non-done task)
      const verLabel = task.status === 'done' ? yellow('UNSIGN') : dim('  N/A ');
      console.log(
        `  ${pad(dim(task.id), idW)}  ${pad(taskStatus, statusW)}  ` +
        `${pad(verLabel, verW)}  ${pad(dim('—'), algW)}  ${dim('no signature recorded')}`,
      );
      continue;
    }

    const sig = task.signature;

    if (!signMod) {
      // Module unavailable — cannot verify
      console.log(
        `  ${pad(dim(task.id), idW)}  ${pad(taskStatus, statusW)}  ` +
        `${pad(yellow('SKIP  '), verW)}  ${pad(dim(sig.alg), algW)}  ${dim('sign module unavailable')}`,
      );
      continue;
    }

    // verifyOutput requires the result content
    const content = task.result ?? '';
    let valid = false;
    let detail = '';
    try {
      valid = signMod.verifyOutput(content, sig, cfg);
      detail = valid
        ? `signer: ${sig.signer}  ts: ${sig.ts}`
        : 'TAMPER DETECTED — signature mismatch';
    } catch {
      valid = false;
      detail = 'verification threw unexpectedly';
    }

    if (!valid) anyFail = true;

    const verLabel      = valid ? green('PASS  ') : red('FAIL  ');
    const detailColored = valid ? dim(detail) : red(detail);
    console.log(
      `  ${pad(dim(task.id), idW)}  ${pad(taskStatus, statusW)}  ` +
      `${pad(verLabel, verW)}  ${pad(dim(sig.alg), algW)}  ${detailColored}`,
    );
  }

  console.log('');

  if (anyFail) {
    console.log(`  ${red('Verification FAILED.')}  One or more task signatures do not match.`);
    console.log(`  ${red('This swarm may have been tampered with after completion.')}`);
    console.log('');
    return 1;
  }

  if (signedTasks.length === 0) {
    console.log(
      `  ${yellow('No signatures to verify.')}  This swarm was not signed (pre-M17 or unsigned).`,
    );
  } else {
    console.log(`  ${green('All signatures valid.')}  ${signedTasks.length} task(s) verified.`);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// M17: `swarm approve <id>`
// ---------------------------------------------------------------------------

/**
 * Explicit human approval to resume a needs-approval swarm.
 *
 * Only valid when status === 'needs-approval'.  Clears the gate and resumes
 * runSwarm via the existing --resume path.  No auto-approval exists anywhere.
 * Exit 0 on successful resume, 1 if not found or not awaiting approval.
 */
async function cmdSwarmApprove(id: string): Promise<number> {
  // Load store
  let store: StoreMod;
  try {
    store = await importStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm store: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const swarm = store.loadSwarm(id);
  if (!swarm) {
    process.stderr.write(red('error: ') + `Swarm not found: ${id}\n`);
    return 1;
  }

  if (swarm.status !== 'needs-approval') {
    // Nothing to approve
    const hint =
      swarm.status === 'done'     ? 'This swarm has already completed.' :
      swarm.status === 'aborted'  ? 'This swarm was aborted (budget). Use --resume to retry.' :
      swarm.status === 'failed'   ? 'This swarm failed. Use --resume to retry.' :
      swarm.status === 'running'  ? 'This swarm is currently running.' :
      swarm.status === 'planning' ? 'This swarm is still planning.' :
      `Swarm status: ${swarm.status}`;
    process.stderr.write(
      yellow('info: ') + `Nothing to approve for swarm ${id}.\n` +
      `  ${hint}\n`,
    );
    return 1;
  }

  // Print escalation context before resuming
  console.log('');
  console.log(bold('  ashlr swarm approve') + gray(` — ${id}`));
  console.log('');
  console.log(`  ${bold('Goal:')}    ${swarm.goal}`);
  if (swarm.project) console.log(`  ${bold('Project:')} ${dim(swarm.project)}`);
  console.log('');

  if (swarm.escalations && swarm.escalations.length > 0) {
    const last = swarm.escalations[swarm.escalations.length - 1]!;
    console.log(`  ${bold(yellow('Escalation that paused this swarm:'))}`);
    console.log(`    Kind:   ${bold(last.kind)}`);
    console.log(`    Detail: ${last.detail}`);
    if (last.taskId) console.log(`    Task:   ${dim(last.taskId)}`);
    console.log(`    Time:   ${dim(last.ts)}`);
    console.log('');
  }

  // Mark every task named by an escalation event as risk-acknowledged BEFORE
  // resuming. This is the load-bearing fix for the goal-risk approve loop: a
  // pre-execution goal-risk gate trips before the offending task runs (it stays
  // 'pending'), so without an explicit per-task approval signal the resumed run
  // would re-scan the identical static goal text and re-escalate instantly. By
  // flagging taskRun.approved=true here (and passing approved:true to runSwarm),
  // the runner SKIPS the goal/result risk re-scan for these specific tasks and
  // can advance past them. Only the human-approved tasks are exempted.
  if (swarm.escalations) {
    for (const ev of swarm.escalations) {
      if (ev.taskId) {
        const tr = swarm.tasks.find((t) => t.id === ev.taskId);
        if (tr) tr.approved = true;
      }
    }
  }

  // Leave status as 'needs-approval' on disk so the runner's needs-approval
  // block is entered (it is gated on existing.status === 'needs-approval'). The
  // runner clears the pause to 'running' itself only when opts.approved is set —
  // this keeps approval an explicit, threaded signal rather than a silent flip.
  swarm.updatedAt = new Date().toISOString();
  try {
    store.saveSwarm(swarm);
  } catch {
    // best-effort; runner will re-persist after first step
  }

  console.log(`  ${cyan('Resuming swarm…')}`);
  console.log('');

  // Load config
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load runner
  let runner: RunnerMod;
  try {
    runner = await importRunner();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm runner: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Build sink
  const streaming = await importStreaming();
  const sink = streaming.makeCliSink({ json: false });

  // Resume via existing --resume path
  const resumedSwarm = await runner.runSwarm(
    { goal: swarm.goal, specId: swarm.specId ?? undefined },
    cfg,
    { resumeId: id, approved: true },
    sink,
  );

  printSwarmSummary(resumedSwarm);

  if (resumedSwarm.status === 'done')             return 0;
  if (resumedSwarm.status === 'aborted')          return 1;
  if (resumedSwarm.status === 'failed')           return 1;
  // Still needs-approval (another gate tripped mid-resume)
  if (resumedSwarm.status === 'needs-approval')   return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// M17: `swarm rollback <id> [--yes] [--force]`
// ---------------------------------------------------------------------------

/**
 * Restore a project to its pre-swarm git snapshot.
 *
 * GUARDRAILS (top priority — this is the only potentially-destructive op):
 *  - ALWAYS prints exactly what will be restored before acting.
 *  - NEVER runs automatically; requires explicit `ashlr swarm rollback <id>`.
 *  - NEVER proceeds without `--yes` or an interactive "y" confirmation.
 *  - NEVER force-resets a dirty tree without `--force`.
 *  - NEVER runs `git push --force`, NEVER deletes branches.
 *  - Refuses clearly on non-repo, missing snapshot, or ambiguous state.
 *  - Exit 0 on success, 1 on refusal/failure/not-found.
 */
async function cmdSwarmRollback(id: string, yes: boolean, force: boolean): Promise<number> {
  // Load store
  let store: StoreMod;
  try {
    store = await importStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm store: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const swarm = store.loadSwarm(id);
  if (!swarm) {
    process.stderr.write(red('error: ') + `Swarm not found: ${id}\n`);
    return 1;
  }

  const snap = swarm.rollback;

  if (!snap) {
    process.stderr.write(
      red('error: ') +
      `Swarm ${id} has no rollback snapshot.\n` +
      `  This swarm was either created before M17, had no project dir, ` +
      `or the project was not a git repo.\n`,
    );
    return 1;
  }

  if (!snap.isRepo) {
    process.stderr.write(
      red('error: ') +
      `Cannot rollback: the project directory is not a git repository.\n` +
      `  Project: ${snap.project ?? '(none)'}\n` +
      `  Snapshot taken: ${snap.ts}\n`,
    );
    return 1;
  }

  if (!snap.head) {
    process.stderr.write(
      red('error: ') +
      `Cannot rollback: snapshot has no HEAD commit recorded (detached or empty repo).\n` +
      `  Snapshot taken: ${snap.ts}\n`,
    );
    return 1;
  }

  // ── Print EXACTLY what will be restored ──────────────────────────────────
  console.log('');
  console.log(bold('  ashlr swarm rollback') + gray(` — ${id}`));
  console.log('');
  console.log(`  ${bold('Swarm goal:')}       ${swarm.goal}`);
  console.log(`  ${bold('Project:')}          ${snap.project ?? dim('(none)')}`);
  console.log(`  ${bold('Snapshot taken:')}   ${snap.ts}`);
  console.log('');
  console.log(`  ${bold('Will restore to:')}  HEAD ${bold(snap.head)}`);
  if (snap.dirty && snap.stashRef) {
    console.log(
      `  ${bold('Dirty-tree stash:')} ${snap.stashRef}  ` +
      yellow('(working tree changes from snapshot time will be re-applied)'),
    );
  } else if (snap.dirty && !snap.stashRef) {
    console.log(
      `  ${yellow('Note:')} working tree was dirty at snapshot time but no stash ref was recorded.`,
    );
    console.log(
      `         ${dim('The working tree will be reset to HEAD; those changes cannot be restored.')}`,
    );
  } else {
    console.log(`  ${dim('Working tree was clean at snapshot time.')}`);
  }
  console.log('');
  console.log(
    `  ${red('WARNING:')} This will ${bold('reset')} the working tree in ` +
    `${snap.project ?? 'the project directory'}.`,
  );
  if (force) {
    console.log(
      `  ${red('WARNING:')} ${bold('--force')} uses ${bold('git reset --hard')}. In addition to ` +
      `discarding uncommitted changes, this ${bold('also discards any commits made AFTER the snapshot')} ` +
      `(${snap.head ? `commits ahead of ${dim(snap.head)}` : 'commits ahead of the snapshot'}).`,
    );
    console.log(
      `  ${dim('Such commits become unreferenced and are recoverable only via `git reflog` until garbage-collected.')}`,
    );
  }
  console.log(
    `  ${dim('It will NOT push to remote, will NOT delete branches, and will NOT run git push --force.')}`,
  );
  console.log('');

  // ── Confirm gate ─────────────────────────────────────────────────────────
  // If --yes was NOT passed, require interactive confirmation.
  if (!yes) {
    const confirmed = await promptConfirm('  Proceed with rollback? [y/N] ');
    if (!confirmed) {
      console.log(`  ${yellow('Rollback cancelled.')}`);
      console.log('');
      return 1;
    }
  } else {
    console.log(`  ${dim('--yes flag set; skipping confirmation prompt.')}`);
    console.log('');
  }

  // ── Load rollback module (M17) ────────────────────────────────────────────
  const rollbackMod = await importRollback();
  if (!rollbackMod) {
    process.stderr.write(
      red('error: ') +
      'rollback module (core/swarm/rollback.ts) is not available.\n' +
      '  It may not have been built yet (M17 agent not complete).\n',
    );
    return 1;
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  console.log(`  ${cyan('Restoring…')}`);
  let rollbackResult: { ok: boolean; detail: string };
  try {
    rollbackResult = await rollbackMod.rollbackTo(snap, { force });
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'rollbackTo threw unexpectedly: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  if (!rollbackResult.ok) {
    process.stderr.write(red('error: ') + `Rollback refused: ${rollbackResult.detail}\n`);
    // Provide guidance for the two most common refusals
    if (/dirty/i.test(rollbackResult.detail)) {
      process.stderr.write(
        `  ${yellow('Hint:')} the working tree has uncommitted changes.\n` +
        `  Pass ${bold('--force')} to discard them and restore the snapshot.\n` +
        `  Example: ashlr swarm rollback ${id} --yes --force\n`,
      );
    } else if (/not a (git )?repo/i.test(rollbackResult.detail)) {
      process.stderr.write(
        `  ${yellow('Hint:')} the project directory is not a git repository — cannot roll back.\n`,
      );
    }
    console.log('');
    return 1;
  }

  console.log(`  ${green('Rollback complete.')}  ${rollbackResult.detail}`);
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Interactive confirm helper (readline)
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a yes/no answer.  Returns true on "y" / "yes"
 * (case-insensitive), false on anything else (empty = default N).
 *
 * If stdin is not a TTY (piped/redirected), refuses by default and instructs
 * the caller to use --yes.  Never throws.
 */
async function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // Non-TTY stdin: refuse by default to prevent accidental pipeline triggers.
      if (!process.stdin.isTTY) {
        process.stderr.write(
          yellow('warn: ') +
          'stdin is not a TTY — defaulting to N (rollback refused).\n' +
          '  Pass --yes to skip the interactive prompt in non-TTY contexts.\n',
        );
        resolve(false);
        return;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      rl.question(question, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a === 'y' || a === 'yes');
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// `ashlr swarm` — main
// ---------------------------------------------------------------------------

/**
 * `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background]
 *   [--resume <id>] [--dry-run] [--allow-cloud] [--project <path>] [--json] [--no-capture]`
 *
 * Also handles:
 *   `ashlr swarm show <id>`
 *   `ashlr swarm verify <id>`
 *   `ashlr swarm approve <id>`
 *   `ashlr swarm rollback <id> [--yes] [--force]`
 *
 * GUARDRAILS:
 * - REFUSES to start when ASHLR_IN_SWARM env var is set (recursion guard).
 * - LOCAL-FIRST by default; --allow-cloud opts in to cloud providers.
 * - --dry-run plans only — no agent execution.
 * - --background spawns a detached worker and returns the swarm ID immediately.
 * - rollback is the ONLY potentially-destructive op; ALWAYS confirm-gated.
 */
export async function cmdSwarm(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printSwarmHelp();
    return 0;
  }

  // ── RECURSION GUARD ──────────────────────────────────────────────────────
  // A swarm task MUST NOT spawn `ashlr swarm`. If ASHLR_IN_SWARM is set, this
  // process is a swarm subtask — refuse with a clear message.
  if (process.env['ASHLR_IN_SWARM']) {
    process.stderr.write(
      red('error: ') +
      'Nested swarms are not permitted (ASHLR_IN_SWARM is set).\n' +
      '  ashlr swarm refuses to start inside another swarm task to prevent fork bombs.\n' +
      '  If this is intentional, unset ASHLR_IN_SWARM before proceeding.\n',
    );
    return 3;
  }

  const parsed = parseSwarmArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // ── M17 subcommands ───────────────────────────────────────────────────────
  // These are read-only (verify) or explicitly confirm-gated (rollback); the
  // recursion guard above covers all entry points uniformly.

  if (parsed.subcommand === 'verify' && parsed.subId) {
    return cmdSwarmVerify(parsed.subId);
  }

  if (parsed.subcommand === 'approve' && parsed.subId) {
    return cmdSwarmApprove(parsed.subId);
  }

  if (parsed.subcommand === 'rollback' && parsed.subId) {
    return cmdSwarmRollback(parsed.subId, parsed.yes, parsed.force);
  }

  // Subcommand: show
  if (parsed.subcommand === 'show' && parsed.showId) {
    return cmdSwarmShow(parsed.showId, parsed.json);
  }

  // Load config
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await importConfig();
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load config: ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Resolve goal and specId from the positional arg.
  // If goalOrSpecId looks like a spec id (no spaces, no quotes), try to load
  // it as a spec first; fall back to treating it as a goal string.
  let goal: string = parsed.goalOrSpecId ?? '';
  let specId: string | undefined;

  // If --resume is set without a goal, load the goal from the stored swarm.
  if (!goal && parsed.resumeId) {
    try {
      const store = await importStore();
      const prior = store.loadSwarm(parsed.resumeId);
      if (!prior) {
        process.stderr.write(
          red('error: ') + `Cannot resume: swarm not found: ${parsed.resumeId}\n`,
        );
        return 1;
      }
      goal  = prior.goal;
      specId = prior.specId ?? undefined;
    } catch (err) {
      process.stderr.write(
        red('error: ') + `Failed to load swarm ${parsed.resumeId}: ` +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }
  }

  // If the positional looks like a potential spec id (no whitespace), try spec store.
  if (goal && !/\s/.test(goal) && !parsed.resumeId) {
    try {
      const specStore = await importSpecStore();
      const spec = specStore.loadSpec(goal);
      if (spec) {
        specId = goal;
        // Use the spec's goal as the swarm goal
        goal = spec.meta.goal;
      }
    } catch {
      // spec-store not yet built or id not found — treat positional as a plain goal
    }
  }

  // Build SwarmOptions
  const swarmOpts: SwarmOptions = {
    allowCloud: parsed.allowCloud,
    parallel:   parsed.parallel,
    background: parsed.background,
    resumeId:   parsed.resumeId,
    dryRun:     parsed.dryRun,
    project:    parsed.project,
  };

  if (parsed.budget !== undefined || parsed.allowCloud !== undefined) {
    swarmOpts.budget = {};
    if (parsed.budget !== undefined)    swarmOpts.budget.maxTokens  = parsed.budget;
    if (parsed.allowCloud !== undefined) swarmOpts.budget.allowCloud = parsed.allowCloud;
  }

  // Pass --no-capture so captureFromSwarm skips genome auto-capture for this swarm.
  if (parsed.noCapture) {
    (swarmOpts as SwarmOptions & { noCapture?: boolean }).noCapture = true;
  }

  // Pass --over-budget so checkGovernanceSwarm lets an over-cap swarm proceed (M19).
  if (parsed.overBudget) {
    (swarmOpts as SwarmOptions & { overBudget?: boolean }).overBudget = true;
  }

  // Print launch banner (non-JSON)
  if (!parsed.json) {
    console.log('');
    console.log(bold('  ashlr swarm') + gray('  — launching'));
    console.log(`  ${dim('Goal:')}    ${goal}`);
    if (specId)          console.log(`  ${dim('Spec:')}    ${specId}`);
    if (parsed.resumeId) console.log(`  ${dim('Resuming:')} ${parsed.resumeId}`);
    if (parsed.dryRun)   console.log(`  ${dim('Mode:')}    dry-run (plan only, no execution)`);
    if (parsed.allowCloud) console.log(`  ${dim('Cloud:')}   allowed (--allow-cloud)`);
    if (parsed.background) console.log(`  ${dim('Mode:')}    background (detached worker)`);
    console.log('');
  } else {
    process.stderr.write(`[ashlr swarm] goal: ${goal}` +
      (parsed.resumeId ? ` (resuming ${parsed.resumeId})` : '') +
      (parsed.dryRun ? ' [dry-run]' : '') + '\n');
  }

  // Load runner
  let runner: RunnerMod;
  try {
    runner = await importRunner();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm runner (M12 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Build StreamSink
  type StreamSink = (e: import('../core/types.js').RunStreamEvent) => void;
  const streaming = await importStreaming();
  const sink: StreamSink = parsed.json
    ? streaming.makeCliSink({ json: true })
    : streaming.makeCliSink({ json: false });

  // Run the swarm
  let swarm: SwarmRun;
  try {
    swarm = await runner.runSwarm({ goal, specId }, cfg, swarmOpts, sink);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface cloud refusal clearly
    if (/local.first|cloud.provider|allow.cloud|no local/i.test(msg)) {
      const lines = [
        '',
        `  ${red('Local-first refusal:')} ${msg}`,
        '',
        `  ashlr swarm only uses LOCAL providers (Ollama / LM Studio) by default.`,
        `  To allow a cloud provider, pass ${bold('--allow-cloud')} and ensure the API key is set.`,
        '',
        `  Example: ashlr swarm "<goal>" --allow-cloud`,
        '',
      ].join('\n');
      if (parsed.json) {
        process.stderr.write(lines + '\n');
      } else {
        process.stdout.write(lines + '\n');
      }
      return 3;
    }
    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  // ── BACKGROUND launch: the runner persisted a skeleton, spawned a detached
  // worker (ashlr swarm --resume <id> --_worker with ASHLR_IN_SWARM cleared),
  // and returned immediately. Report the id; the worker drives the swarm. ─────
  if (parsed.background) {
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({ swarmId: swarm.id, background: true }) + '\n',
      );
    } else {
      console.log(`  ${green('Swarm started in background.')}  ID: ${bold(swarm.id)}`);
      console.log(`  ${dim('Watch progress with:')} ashlr swarm show ${swarm.id}`);
      console.log('');
    }
    return 0;
  }

  // ── DRY-RUN output: plan only ────────────────────────────────────────────
  if (parsed.dryRun) {
    printDryRunPlan(swarm.plan, { json: parsed.json });
    return 0;
  }

  // ── Normal output ────────────────────────────────────────────────────────
  if (parsed.json) {
    process.stdout.write(JSON.stringify(swarm, null, 2) + '\n');
  } else {
    printSwarmSummary(swarm);
  }

  // Exit codes
  if (swarm.status === 'done')             return 0;
  if (swarm.status === 'aborted')          return 1;
  if (swarm.status === 'failed')           return 1;
  // M17: needs-approval means the swarm paused at an escalation gate
  if (swarm.status === 'needs-approval')   return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// `ashlr swarms` — list persisted swarms
// ---------------------------------------------------------------------------

/**
 * `ashlr swarms [--json]` — list all persisted swarms (newest first).
 */
export async function cmdSwarms(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  let store: StoreMod;
  try {
    store = await importStore();
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load swarm store (M12 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // `swarms show <id>` is also routed here via index.ts dispatch
  if (args[0] === 'show') {
    const id = args[1];
    if (!id) {
      process.stderr.write(red('error: ') + 'Usage: ashlr swarms show <id>\n');
      return 2;
    }
    return cmdSwarmShow(id, jsonMode);
  }

  const swarms = store.listSwarms();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(swarms, null, 2) + '\n');
    return 0;
  }

  if (swarms.length === 0) {
    console.log('');
    console.log(`  ${dim('No swarms found.')} Start one with ${bold('ashlr swarm "<goal>"')}.`);
    console.log('');
    return 0;
  }

  const idW       = Math.max(4, ...swarms.map(s => s.id.length));
  const statusW   = 14; // wider to accommodate 'needs-approval'
  const progressW = 10;
  const tokW      = 8;
  const timeW     = 8;
  const goalW     = 46;

  console.log('');
  console.log(bold('  ashlr swarms') + gray(`  — ${swarms.length} swarm(s)`));
  console.log('');
  console.log(
    `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
    `${bold(pad('Progress', progressW))}  ${bold(pad('Tokens', tokW, 'right'))}  ` +
    `${bold(pad('When', timeW))}  ${bold('Goal')}`,
  );
  console.log(
    `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(progressW)}  ` +
    `${'─'.repeat(tokW)}  ${'─'.repeat(timeW)}  ${'─'.repeat(goalW)}`,
  );

  for (const s of swarms) {
    const totalTokens  = s.usage.tokensIn + s.usage.tokensOut;
    const doneTasks    = s.tasks.filter(t => t.status === 'done').length;
    const totalTasks   = s.tasks.length;
    const progressStr  = `${doneTasks}/${totalTasks}`;
    const goalTrunc    = s.goal.length > goalW ? s.goal.slice(0, goalW - 1) + '…' : s.goal;
    const when         = relativeTime(s.createdAt);

    const isLocal = s.usage.estCostUsd === 0;
    void isLocal; // used implicitly via cloudNote in summary; not shown in list

    console.log(
      `  ${pad(dim(s.id), idW)}  ${pad(swarmStatusColor(s.status), statusW)}  ` +
      `${pad(seCol.cyan(progressStr), progressW)}  ` +
      `${pad(totalTokens.toLocaleString(), tokW, 'right')}  ` +
      `${pad(seCol.gray(when), timeW)}  ` +
      goalTrunc,
    );
  }

  console.log('');
  console.log(dim(`  Use 'ashlr swarm show <id>' to see details.`));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printSwarmHelp(): void {
  console.log('');
  console.log(bold('  ashlr swarm') + dim(' — contracts-first multi-agent fleet runner'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr swarm ${cyan('"<goal>"')} [options]`);
  console.log(`    ashlr swarm ${cyan('<specId>')} [options]`);
  console.log(`    ashlr swarm show ${cyan('<id>')}`);
  console.log(`    ashlr swarm verify ${cyan('<id>')}              ${dim('# M17: verify task output signatures')}`);
  console.log(`    ashlr swarm approve ${cyan('<id>')}             ${dim('# M17: resume a paused (needs-approval) swarm')}`);
  console.log(`    ashlr swarm rollback ${cyan('<id>')} [--yes] [--force]  ${dim('# M17: restore pre-swarm git state')}`);
  console.log(`    ashlr swarms [--json]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['--budget N',       'Hard total token ceiling across ALL tasks (aborts cleanly when exceeded).'],
    ['--parallel N',     'Max tasks to execute concurrently in the BUILD phase (default: 3, max: 8).'],
    ['--background',     'Launch a detached worker; return the swarm ID immediately.'],
    ['--resume <id>',    'Resume a previously paused/aborted swarm.'],
    ['--dry-run',        'Plan only — print the phases/tasks without executing any agent.'],
    ['--allow-cloud',    'Allow cloud providers for tasks (default: local-first Ollama/LM Studio).'],
    ['--project <path>', 'Absolute path to the target project directory.'],
    ['--json',           'Emit SwarmRun JSON on stdout; progress goes to stderr.'],
    ['--no-capture',     'Skip auto-capture of this swarm to the genome (M16 playbook).'],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('M17 subcommand options:'));
  console.log('');

  const m17opts: [string, string][] = [
    ['rollback --yes',   'Skip the interactive confirmation prompt.'],
    ['rollback --force', 'Allow rollback even when the working tree is dirty (discards changes).'],
  ];
  const m17W = Math.max(...m17opts.map(([o]) => o.length));
  for (const [opt, desc] of m17opts) {
    console.log(`    ${cyan(pad(opt, m17W))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${gray('# Plan a swarm without executing (safe preview)')}`)
  console.log(`    ashlr swarm "Add end-to-end tests for the auth module" --dry-run`);
  console.log('');
  console.log(`    ${gray('# Run a swarm with a tight budget')}`)
  console.log(`    ashlr swarm "Refactor config parsing" --budget 40000 --parallel 2`);
  console.log('');
  console.log(`    ${gray('# Run from a spec artifact')}`)
  console.log(`    ashlr swarm my-spec-id --project ~/Desktop/github/my-project`);
  console.log('');
  console.log(`    ${gray('# Launch in background and watch later')}`)
  console.log(`    ashlr swarm "Implement feature X" --background --budget 80000`);
  console.log(`    ashlr swarm show <swarm-id>`);
  console.log('');
  console.log(`    ${gray('# List all past swarms')}`)
  console.log(`    ashlr swarms`);
  console.log('');
  console.log(`    ${gray('# M17: verify task signatures after a completed swarm')}`)
  console.log(`    ashlr swarm verify swarm-xyz789`);
  console.log('');
  console.log(`    ${gray('# M17: resume a swarm paused at an escalation gate')}`)
  console.log(`    ashlr swarm approve swarm-xyz789`);
  console.log('');
  console.log(`    ${gray('# M17: roll back a project to its pre-swarm git state')}`)
  console.log(`    ashlr swarm rollback swarm-xyz789`);
  console.log(`    ashlr swarm rollback swarm-xyz789 --yes --force   ${dim('# non-interactive + dirty-ok')}`);
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• LOCAL-FIRST: only Ollama / LM Studio by default.')}`);
  console.log(`    ${dim('• HARD total budget across the whole swarm — never runaway.')}`);
  console.log(`    ${dim('• Bounded parallelism: default 3, max 8 concurrent tasks.')}`);
  console.log(`    ${dim('• Nested swarms refused (ASHLR_IN_SWARM guard).')}`);
  console.log(`    ${dim('• No outward/destructive actions (push/deploy) by default.')}`);
  console.log(`    ${dim('• All state persists to ~/.ashlr/swarms/<id>.json (resumable).')}`);
  console.log(`    ${dim('• --no-capture disables genome auto-capture for this swarm.')}`);
  console.log(`    ${dim('• M17: task outputs signed; downstream tasks verify before consuming.')}`);
  console.log(`    ${dim('• M17: escalation gates PAUSE (needs-approval) — never auto-proceed.')}`);
  console.log(`    ${dim('• M17: rollback is confirm-gated, never automatic, never force-pushes.')}`);
  console.log('');
}
