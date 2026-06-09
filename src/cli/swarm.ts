/**
 * `ashlr swarm` and `ashlr swarms` CLI commands.
 *
 * `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background]
 *   [--resume <id>] [--dry-run] [--allow-cloud] [--project <path>] [--json] [--no-capture]`
 *
 * Subcommand `ashlr swarm show <id>` prints a saved swarm.
 *
 * `ashlr swarms [--json]` — list persisted swarms.
 *
 * Exit codes:
 *   0  success
 *   1  swarm failed / aborted / not-found
 *   2  bad usage
 *   3  recursion guard (ASHLR_IN_SWARM is set)
 */

import type { SwarmRun, SwarmOptions, SwarmTaskRun } from '../core/types.js';
import { pad, makeColors, isTty, isStderrTty } from './ui.js';
import { parsePositiveInt } from './args.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());
const seCol = makeColors(isStderrTty());

// ---------------------------------------------------------------------------
// Lazy imports — core/swarm modules built by other M12 agents
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

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedSwarmArgs {
  subcommand: 'run' | 'show';
  /** Raw positional: either a quoted goal string or a specId. */
  goalOrSpecId?: string;
  showId?: string;
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
  usageError?: string;
}

function parseSwarmArgs(args: string[]): ParsedSwarmArgs {
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
    };
  }

  const result: ParsedSwarmArgs = {
    subcommand: 'run',
    background: false,
    dryRun: false,
    allowCloud: false,
    json: false,
    noCapture: false,
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
      '       ashlr swarm show <id>';
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
    case 'done':      return green(status);
    case 'running':   return cyan(status);
    case 'planning':  return cyan(status);
    case 'aborted':   return yellow(status);
    case 'failed':    return red(status);
    default:          return String(status);
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
  const { id, goal, status, usage, budget, tasks, result, createdAt, updatedAt, parallel, specId, project } = swarm;

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
    (status === 'aborted' ? yellow('  — budget/limit reached') : ''),
  );
  console.log(`  ${bold('Parallel:')}  ${parallel}  ${dim('tasks concurrently (BUILD phase)')}`);
  console.log(`  ${bold('Duration:')}  ${duration}`);
  console.log(`  ${bold('Progress:')}  ${doneTasks}/${tasks.length} tasks done` +
    (failedTasks > 0 ? `  ${red(`${failedTasks} failed`)}` : ''));
  console.log('');

  // ── Plan / tasks table ───────────────────────────────────────────────────
  if (tasks.length > 0) {
    const phases = ['scaffold', 'build', 'integrate', 'verify', 'review'] as const;

    for (const phase of phases) {
      const phaseTasks = tasks.filter(t => t.phase === phase);
      if (phaseTasks.length === 0) continue;

      const idW     = Math.max(4, ...phaseTasks.map(t => t.id.length));
      const statusW = 8;
      const tokW    = 7;
      const goalW   = 44;

      console.log(`  ${bold(phase.toUpperCase())} ${dim(`(${phaseTasks.length} task${phaseTasks.length !== 1 ? 's' : ''})`)}`);
      console.log('');
      console.log(
        `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
        `${bold(pad('Tokens', tokW, 'right'))}  ${bold('Goal')}`,
      );
      console.log(
        `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(goalW)}`,
      );

      for (const t of phaseTasks) {
        const tok = t.usage ? String(t.usage.tokensIn + t.usage.tokensOut) : '—';
        // Find matching spec goal via plan
        const specTask = swarm.plan.tasks.find(s => s.id === t.id);
        const taskGoal = specTask?.goal ?? '';
        const goalTrunc = taskGoal.length > goalW ? taskGoal.slice(0, goalW - 1) + '…' : taskGoal;
        const errorNote = t.error ? red(` ✗ ${t.error.slice(0, 40)}`) : '';
        console.log(
          `  ${pad(dim(t.id), idW)}  ${pad(taskStatusColor(t.status), statusW)}  ` +
          `${pad(tok, tokW, 'right')}  ${goalTrunc}${errorNote}`,
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

  // ── Resume hint ──────────────────────────────────────────────────────────
  if (status === 'aborted' || status === 'failed') {
    console.log(
      `  ${yellow('Tip:')} resume this swarm with ${bold(`ashlr swarm --resume ${id}`)}`,
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
// `ashlr swarm` — main
// ---------------------------------------------------------------------------

/**
 * `ashlr swarm "<goal>" | <specId> [--budget N] [--parallel N] [--background]
 *   [--resume <id>] [--dry-run] [--allow-cloud] [--project <path>] [--json] [--no-capture]`
 *
 * Also handles `ashlr swarm show <id>`.
 *
 * GUARDRAILS:
 * - REFUSES to start when ASHLR_IN_SWARM env var is set (recursion guard).
 * - LOCAL-FIRST by default; --allow-cloud opts in to cloud providers.
 * - --dry-run plans only — no agent execution.
 * - --background spawns a detached worker and returns the swarm ID immediately.
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
  if (swarm.status === 'done')    return 0;
  if (swarm.status === 'aborted') return 1;
  if (swarm.status === 'failed')  return 1;
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

  const idW      = Math.max(4, ...swarms.map(s => s.id.length));
  const statusW  = 9;
  const progressW = 10;
  const tokW     = 8;
  const timeW    = 8;
  const goalW    = 46;

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

    // Dim the id and colorize status/progress
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
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• LOCAL-FIRST: only Ollama / LM Studio by default.')}`);
  console.log(`    ${dim('• HARD total budget across the whole swarm — never runaway.')}`);
  console.log(`    ${dim('• Bounded parallelism: default 3, max 8 concurrent tasks.')}`);
  console.log(`    ${dim('• Nested swarms refused (ASHLR_IN_SWARM guard).')}`);
  console.log(`    ${dim('• No outward/destructive actions (push/deploy) by default.')}`);
  console.log(`    ${dim('• All state persists to ~/.ashlr/swarms/<id>.json (resumable).')}`);
  console.log(`    ${dim('• --no-capture disables genome auto-capture for this swarm.')}`);
  console.log('');
}
