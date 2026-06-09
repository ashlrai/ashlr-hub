/**
 * `ashlr run` and `ashlr runs` CLI commands.
 *
 * `ashlr run "<goal>" [--budget N] [--max-steps N] [--parallel N]
 *   [--engine builtin|ashlrcode|aw|claude] [--allow-cloud] [--no-tools]
 *   [--resume <id>] [--json] [--no-memory] [--stream|--no-stream] [--no-capture]`
 *
 * Subcommand `ashlr run show <id>` prints a saved run.
 *
 * `ashlr runs [--json]` — list past runs.
 *
 * Exit codes:
 *   0  success
 *   1  run failed / aborted / not-found
 *   2  bad usage
 *   3  local-first cloud refusal
 */

import type { RunOptions, RunState, RunTask, RunStep } from '../core/types.js';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_STEPS,
  DEFAULT_PARALLEL,
} from '../core/run/orchestrator.js';

// ---------------------------------------------------------------------------
// Lazy imports — core/run modules are built by other M4/M11 agents
// ---------------------------------------------------------------------------

async function importOrchestrator() {
  return import('../core/run/orchestrator.js') as Promise<{
    runGoal: (goal: string, cfg: import('../core/types.js').AshlrConfig, opts: RunOptions) => Promise<RunState>;
    loadRun: (id: string) => RunState | null;
    listRuns: () => RunState[];
  }>;
}

async function importConfig() {
  return import('../core/config.js') as Promise<{
    loadConfig: () => import('../core/types.js').AshlrConfig;
  }>;
}

type StreamingMod = {
  nullSink: () => (e: import('../core/types.js').RunStreamEvent) => void;
  makeCliSink: (opts: { json: boolean }) => (e: import('../core/types.js').RunStreamEvent) => void;
};

/**
 * Lazily import streaming.ts (M11 — written by streaming agent).
 * Falls back gracefully: if the module isn't present yet, returns stubs
 * so the CLI can still run without the streaming module landing first.
 */
async function importStreaming(): Promise<StreamingMod> {
  try {
    return await import('../core/run/streaming.js') as StreamingMod;
  } catch {
    // streaming.ts not yet present (other agent hasn't landed it); return stubs
    const noop = () => (_e: import('../core/types.js').RunStreamEvent) => { /* no-op */ };
    return { nullSink: noop, makeCliSink: noop };
  }
}

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

import { pad, makeColors, isTty, isStderrTty } from './ui.js';
import { parsePositiveInt } from './args.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// Stderr equivalents (respect stderr TTY)
const seColors = makeColors(isStderrTty());
const seDim    = seColors.dim;
const seCyan   = seColors.cyan;
const seGreen  = seColors.green;
const seYellow = seColors.yellow;
const seGray   = seColors.gray;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedRunArgs {
  subcommand: 'run' | 'show';
  goal?: string;
  showId?: string;
  budget?: number;
  maxSteps?: number;
  parallel?: number;
  engine?: string;
  allowCloud: boolean;
  noTools: boolean;
  noMemory: boolean;
  resumeId?: string;
  json: boolean;
  /** Whether to stream live progress. Defaults to true when stderr is a TTY. */
  stream: boolean;
  /** Enable the optional cheap model verification check after each task (M11). */
  verifyModel: boolean;
  /** Skip auto-capture of this run to the genome (M16). */
  noCapture: boolean;
  usageError?: string;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  // Handle `run show <id>` subcommand
  if (args[0] === 'show') {
    const showId = args[1];
    if (!showId) {
      return {
        subcommand: 'run',
        allowCloud: false,
        noTools: false,
        noMemory: false,
        json: false,
        stream: false,
        verifyModel: false,
        noCapture: false,
        usageError: 'Usage: ashlr run show <id>',
      };
    }
    return { subcommand: 'show', showId, allowCloud: false, noTools: false, noMemory: false, json: false, stream: false, verifyModel: false, noCapture: false };
  }

  const result: ParsedRunArgs = {
    subcommand: 'run',
    allowCloud: false,
    noTools: false,
    noMemory: false,
    json: false,
    // Default: stream ON when stderr is a TTY (overridden by --stream/--no-stream)
    stream: Boolean(process.stderr.isTTY),
    // Default: heuristic-only verification (no extra model calls). --verify-model enables it.
    verifyModel: false,
    // Default: genome auto-capture is ON; --no-capture disables it for this run.
    noCapture: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--stream') {
      result.stream = true;
      i++;
    } else if (arg === '--no-stream') {
      result.stream = false;
      i++;
    } else if (arg === '--allow-cloud') {
      result.allowCloud = true;
      i++;
    } else if (arg === '--no-tools') {
      result.noTools = true;
      i++;
    } else if (arg === '--no-memory') {
      result.noMemory = true;
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--verify-model') {
      result.verifyModel = true;
      i++;
    } else if (arg === '--budget') {
      const parsed = parsePositiveInt('budget', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.budget = parsed.n;
      i++;
    } else if (arg === '--max-steps') {
      const parsed = parsePositiveInt('max-steps', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.maxSteps = parsed.n;
      i++;
    } else if (arg === '--parallel') {
      const parsed = parsePositiveInt('parallel', args[++i]);
      if ('error' in parsed) { result.usageError = parsed.error; return result; }
      result.parallel = parsed.n;
      i++;
    } else if (arg === '--engine') {
      const val = args[++i];
      if (!val || !['builtin', 'ashlrcode', 'aw', 'claude'].includes(val)) {
        result.usageError = `--engine requires one of: builtin, ashlrcode, aw, claude; got: ${val ?? '(missing)'}`;
        return result;
      }
      result.engine = val;
      i++;
    } else if (arg === '--model') {
      const val = args[++i];
      if (!val) {
        result.usageError = `--model requires a model name (e.g. llama3.2:3b)`;
        return result;
      }
      // Consumed by provider-client.pickModel(); also honors the ASHLR_MODEL env var.
      process.env.ASHLR_MODEL = val;
      i++;
    } else if (arg === '--no-capture') {
      result.noCapture = true;
      i++;
    } else if (arg === '--resume') {
      const val = args[++i];
      if (!val) {
        result.usageError = `--resume requires a run id`;
        return result;
      }
      result.resumeId = val;
      i++;
    } else if (!arg.startsWith('--')) {
      // positional = goal
      if (result.goal !== undefined) {
        result.usageError = `unexpected positional argument: ${arg}`;
        return result;
      }
      result.goal = arg;
      i++;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  // goal is required unless --resume is set (resume re-uses stored goal)
  if (!result.goal && !result.resumeId) {
    result.usageError =
      'Usage: ashlr run "<goal>" [--budget N] [--max-steps N] [--parallel N]\n' +
      '              [--engine builtin|ashlrcode|aw|claude] [--allow-cloud] [--no-tools]\n' +
      '              [--resume <id>] [--json] [--no-memory] [--stream|--no-stream] [--verify-model] [--no-capture]\n' +
      '       ashlr run show <id>';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step progress printer (goes to stderr when --json so stdout stays clean)
// ---------------------------------------------------------------------------

/**
 * Emit a step event line.  When jsonMode is true we write to stderr so stdout
 * remains a single JSON object at the end.
 */
function printStep(step: RunStep, taskGoal: string, jsonMode: boolean): void {
  const ts = new Date(step.ts).toLocaleTimeString('en-US', { hour12: false });
  const kindEmoji: Record<string, string> = {
    plan:       '📋',
    model:      '🤖',
    tool:       '🔧',
    synthesize: '✨',
  };
  const icon = kindEmoji[step.kind] ?? '·';
  const usageStr = step.usage
    ? seDim(` [${step.usage.tokensIn + step.usage.tokensOut} tok]`)
    : '';
  const line =
    `  ${seGray(ts)} ${icon} ${seCyan(`[${step.taskId}]`)} ${step.summary}${usageStr}` +
    (taskGoal ? ` ${seGray(`— ${taskGoal.slice(0, 60)}${taskGoal.length > 60 ? '…' : ''}`)}` : '');

  if (jsonMode) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// ---------------------------------------------------------------------------
// Human summary renderer
// ---------------------------------------------------------------------------

function formatDuration(createdAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function statusColor(status: RunState['status'] | RunTask['status']): string {
  switch (status) {
    case 'done':    return green(status);
    case 'running': return cyan(status);
    case 'aborted': return yellow(status);
    case 'failed':  return red(status);
    case 'pending': return gray(status);
    case 'skipped': return dim(status);
    default:        return String(status);
  }
}

function printRunSummary(state: RunState): void {
  const { id, goal, engine, provider, status, usage, budget, tasks, result, createdAt, updatedAt } = state;

  const duration = formatDuration(createdAt, updatedAt);
  const totalTokens = usage.tokensIn + usage.tokensOut;

  console.log('');
  console.log(bold('  ashlr run') + gray(` — ${id}`));
  console.log('');
  console.log(`  ${bold('Goal:')}    ${goal}`);
  console.log(
    `  ${bold('Status:')}  ${statusColor(status)}` +
    (status === 'aborted' ? yellow('  ⚠ budget/step limit reached') : ''),
  );
  console.log(`  ${bold('Engine:')}  ${engine}  ${dim('·')}  ${bold('Provider:')} ${cyan(provider)}`);
  console.log(`  ${bold('Duration:')} ${duration}`);
  console.log('');

  // ── Tasks table ──────────────────────────────────────────────────────────
  if (tasks.length > 0) {
    const idW     = Math.max(4, ...tasks.map(t => t.id.length));
    const statusW = 8;
    const tokW    = 7;
    const goalW   = 44;

    console.log(`  ${bold(pad('Tasks', 0))}`);
    console.log('');
    console.log(
      `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
      `${bold(pad('Tokens', tokW, 'right'))}  ${bold('Goal')}`,
    );
    console.log(
      `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(goalW)}`,
    );

    for (const t of tasks) {
      const tok = t.usage ? String(t.usage.tokensIn + t.usage.tokensOut) : '—';
      const goalTrunc = t.goal.length > goalW ? t.goal.slice(0, goalW - 1) + '…' : t.goal;
      const errorNote = t.error ? red(` ✗ ${t.error.slice(0, 40)}`) : '';
      console.log(
        `  ${pad(dim(t.id), idW)}  ${pad(statusColor(t.status), statusW)}  ` +
        `${pad(tok, tokW, 'right')}  ${goalTrunc}${errorNote}`,
      );
    }
    console.log('');
  }

  // ── Result ───────────────────────────────────────────────────────────────
  if (result) {
    console.log(`  ${bold('Result:')}`);
    // Indent result lines for readability
    const lines = result.split('\n');
    for (const line of lines) {
      console.log(`    ${line}`);
    }
    console.log('');
  }

  // ── Usage / cost summary ─────────────────────────────────────────────────
  const localProvider = /ollama|lmstudio/i.test(provider);
  const cloudNote = localProvider ? green('local — $0.00') : yellow('cloud provider');

  console.log(`  ${bold('Usage:')}`);
  console.log(`    Tokens in:   ${usage.tokensIn.toLocaleString()}`);
  console.log(`    Tokens out:  ${usage.tokensOut.toLocaleString()}`);
  console.log(`    Total:       ${totalTokens.toLocaleString()} / ${budget.maxTokens.toLocaleString()} max`);
  console.log(`    Steps:       ${usage.steps} / ${budget.maxSteps} max`);
  console.log(
    `    Est. cost:   ${usage.estCostUsd > 0 ? '$' + usage.estCostUsd.toFixed(6) : '$0.00'}  ${dim('·')}  ${cloudNote}`,
  );
  console.log(`    Provider:    ${cyan(provider)}`);
  console.log('');

  // ── Resume hint ──────────────────────────────────────────────────────────
  if (status === 'aborted' || status === 'failed') {
    console.log(
      `  ${yellow('Tip:')} resume this run with ${bold(`ashlr run --resume ${id}`)}`,
    );
    console.log('');
  }

  // ── Show hint ────────────────────────────────────────────────────────────
  console.log(dim(`  Run ID: ${id}  |  ashlr run show ${id}`));
  console.log('');
}

// ---------------------------------------------------------------------------
// Cloud refusal message
// ---------------------------------------------------------------------------

const CLOUD_REFUSAL_RE = /local.first|cloud.provider|allow.cloud|no local/i;

function isCloudRefusalError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CLOUD_REFUSAL_RE.test(err.message);
}

function printCloudRefusal(err: Error, jsonMode: boolean): void {
  const msg = [
    '',
    `  ${red('Local-first refusal:')} ${err.message}`,
    '',
    `  ashlr run only uses LOCAL providers (Ollama / LM Studio) by default.`,
    `  To allow a cloud provider, pass ${bold('--allow-cloud')} and ensure the API key is set.`,
    '',
    `  Example: ashlr run "<goal>" --allow-cloud`,
    '',
  ].join('\n');

  if (jsonMode) {
    process.stderr.write(msg + '\n');
  } else {
    process.stdout.write(msg + '\n');
  }
}

// ---------------------------------------------------------------------------
// `run show <id>`
// ---------------------------------------------------------------------------

async function cmdRunShow(id: string, jsonMode: boolean): Promise<number> {
  const { loadRun } = await importOrchestrator();
  const state = loadRun(id);

  if (!state) {
    const msg = `Run not found: ${id}`;
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n');
    } else {
      process.stderr.write(red('error: ') + msg + '\n');
    }
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    return 0;
  }

  printRunSummary(state);
  return 0;
}

// ---------------------------------------------------------------------------
// `ashlr run` — main
// ---------------------------------------------------------------------------

/**
 * `ashlr run "<goal>" [--budget N] [--max-steps N] [--parallel N]
 *   [--engine builtin|ashlrcode|aw] [--allow-cloud] [--no-tools]
 *   [--resume <id>] [--json]`
 *
 * Also handles `ashlr run show <id>`.
 */
export async function cmdRun(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printRunHelp();
    return 0;
  }

  const parsed = parseRunArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Subcommand: show
  if (parsed.subcommand === 'show' && parsed.showId) {
    return cmdRunShow(parsed.showId, parsed.json);
  }

  // Build RunOptions
  const opts: RunOptions = {
    allowCloud: parsed.allowCloud,
    tools:      !parsed.noTools,
    parallel:   parsed.parallel,
    engine:     parsed.engine,
    json:       parsed.json,
    resumeId:   parsed.resumeId,
    verifyModel: parsed.verifyModel,
  };

  if (parsed.budget !== undefined || parsed.maxSteps !== undefined) {
    opts.budget = {};
    if (parsed.budget !== undefined)   opts.budget.maxTokens = parsed.budget;
    if (parsed.maxSteps !== undefined) opts.budget.maxSteps  = parsed.maxSteps;
    if (parsed.allowCloud !== undefined) opts.budget.allowCloud = parsed.allowCloud;
  }

  // Determine goal — either explicit or from resumed run
  let goal = parsed.goal ?? '';

  // If --resume only (no goal), we need to load stored goal for display
  if (!goal && parsed.resumeId) {
    try {
      const { loadRun } = await importOrchestrator();
      const prior = loadRun(parsed.resumeId);
      if (!prior) {
        process.stderr.write(red('error: ') + `Cannot resume: run not found: ${parsed.resumeId}\n`);
        return 1;
      }
      goal = prior.goal;
    } catch (err) {
      process.stderr.write(
        red('error: ') + `Failed to load run ${parsed.resumeId}: ` +
        (err instanceof Error ? err.message : String(err)) + '\n',
      );
      return 1;
    }
  }

  if (!parsed.json) {
    console.log('');
    console.log(bold('  ashlr run') + gray(`  — starting`));
    console.log(`  ${dim('Goal:')} ${goal}`);
    if (parsed.resumeId) {
      console.log(`  ${dim('Resuming:')} ${parsed.resumeId}`);
    }
    if (parsed.noMemory) {
      console.log(`  ${dim('Memory:')} disabled (--no-memory)`);
    }
    console.log('');
  } else {
    process.stderr.write(`[ashlr run] goal: ${goal}` + (parsed.resumeId ? ` (resuming ${parsed.resumeId})` : '') + '\n');
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

  // Load orchestrator
  let runGoal: (
    goal: string,
    cfg: import('../core/types.js').AshlrConfig,
    opts: RunOptions,
  ) => Promise<RunState>;

  try {
    const mod = await importOrchestrator();
    runGoal = mod.runGoal;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load orchestrator (M4 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Step callback — accumulate tasks map for goal lookup
  const taskGoalMap = new Map<string, string>();

  // M11: build a StreamSink for live progress rendering.
  // makeCliSink renders to stderr when --json (stdout stays clean JSON);
  // nullSink is used when --no-stream or non-TTY and flag not explicitly set.
  // Import is lazy/fault-tolerant — stubs returned when streaming.ts not yet present.
  type StreamSink = (e: import('../core/types.js').RunStreamEvent) => void;
  const streaming = await importStreaming();
  const sink: StreamSink = parsed.stream
    ? streaming.makeCliSink({ json: parsed.json })
    : streaming.nullSink();

  // Wire CLI progress via an optional __onStep side-channel on RunOptions:
  // the orchestrator calls it per step if present, else we just print the
  // final summary. Kept off the typed contract (extra props ignored at runtime).
  // M11: also attach the StreamSink as __sink so the orchestrator/agent-loop
  // can emit RunStreamEvents for live streaming (same escape-hatch pattern).
  const optsWithHook = opts as RunOptions & {
    __onStep?: (step: RunStep, tasks: RunTask[]) => void;
    __sink?: StreamSink;
    noMemory?: boolean;
    noCapture?: boolean;
  };

  optsWithHook.__sink = sink;

  optsWithHook.__onStep = (step: RunStep, tasks: RunTask[]) => {
    // Keep task goal map updated
    for (const t of tasks) {
      taskGoalMap.set(t.id, t.goal);
    }
    const taskGoal = taskGoalMap.get(step.taskId) ?? '';
    printStep(step, taskGoal, parsed.json);
  };

  // Pass --no-memory so the orchestrator skips genome injection.
  // Orchestrator checks: (cfg.genome?.injectOnRun ?? true) && !opts.noMemory
  if (parsed.noMemory) {
    optsWithHook.noMemory = true;
  }

  // Pass --no-capture so captureFromRun skips genome auto-capture for this run.
  if (parsed.noCapture) {
    optsWithHook.noCapture = true;
  }

  let state: RunState;
  try {
    state = await runGoal(goal, cfg, optsWithHook);
  } catch (err) {
    if (isCloudRefusalError(err)) {
      printCloudRefusal(err as Error, parsed.json);
      return 3;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('error: ') + msg + '\n');
    return 1;
  }

  // Output
  if (parsed.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  } else {
    printRunSummary(state);
  }

  // Exit code
  if (state.status === 'done') return 0;
  if (state.status === 'aborted') return 1;
  if (state.status === 'failed') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// `ashlr runs` — list past runs
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

/**
 * `ashlr runs [--json]` — list past runs.
 */
export async function cmdRuns(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  let listRuns: () => RunState[];
  try {
    const mod = await importOrchestrator();
    listRuns = mod.listRuns;
  } catch (err) {
    process.stderr.write(
      red('error: ') + 'Failed to load orchestrator (M4 module not yet built): ' +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  const runs = listRuns();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
    return 0;
  }

  if (runs.length === 0) {
    console.log('');
    console.log(`  ${dim('No past runs found.')} Start one with ${bold('ashlr run "<goal>"')}.`);
    console.log('');
    return 0;
  }

  const idW     = Math.max(4, ...runs.map(r => r.id.length));
  const statusW = 8;
  const tokW    = 8;
  const timeW   = 8;
  const goalW   = 48;

  console.log('');
  console.log(bold('  ashlr runs') + gray(`  — ${runs.length} run(s)`));
  console.log('');
  console.log(
    `  ${bold(pad('ID', idW))}  ${bold(pad('Status', statusW))}  ` +
    `${bold(pad('Tokens', tokW, 'right'))}  ${bold(pad('When', timeW))}  ${bold('Goal')}`,
  );
  console.log(
    `  ${'─'.repeat(idW)}  ${'─'.repeat(statusW)}  ${'─'.repeat(tokW)}  ${'─'.repeat(timeW)}  ${'─'.repeat(goalW)}`,
  );

  for (const r of runs) {
    const totalTokens = r.usage.tokensIn + r.usage.tokensOut;
    const goalTrunc   = r.goal.length > goalW ? r.goal.slice(0, goalW - 1) + '…' : r.goal;
    const when        = relativeTime(r.createdAt);
    const providerStr = /ollama|lmstudio/i.test(r.provider)
      ? seGreen(r.provider)
      : seYellow(r.provider);
    void providerStr; // not shown in list (too wide); shown in `show`

    console.log(
      `  ${pad(dim(r.id), idW)}  ${pad(statusColor(r.status), statusW)}  ` +
      `${pad(totalTokens.toLocaleString(), tokW, 'right')}  ${pad(gray(when), timeW)}  ${goalTrunc}`,
    );
  }

  console.log('');
  console.log(dim(`  Use 'ashlr run show <id>' to see details.`));
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printRunHelp(): void {
  console.log('');
  console.log(bold('  ashlr run') + dim(' — local-first agent orchestrator'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr run ${cyan('"<goal>"')} [options]`);
  console.log(`    ashlr run show ${cyan('<id>')}`);
  console.log(`    ashlr runs [--json]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['--budget N',              `Max total tokens (in+out) before aborting (default: ${DEFAULT_MAX_TOKENS}).`],
    ['--max-steps N',           `Max agent steps before aborting (default: ${DEFAULT_MAX_STEPS}).`],
    ['--parallel N',            `Max independent tasks to run concurrently (default: ${DEFAULT_PARALLEL}).`],
    ['--engine <e>',            `Execution engine: builtin (default), ashlrcode, aw, or claude.`],
    ['--model <name>',          `Local model to use (default: smallest/fastest; or set ASHLR_MODEL).`],
    ['--allow-cloud',           `Allow cloud provider if no local is available (requires API key).`],
    ['--no-tools',              `Disable MCP tool loading (faster; for simple goals).`],
    ['--no-memory',             `Skip genome recall injection into sub-agent prompts.`],
    ['--resume <id>',           `Resume a previously aborted/incomplete run.`],
    ['--json',                  `Emit RunState JSON on stdout; progress goes to stderr.`],
    ['--stream',                `Stream live progress as it happens (default: on when stderr is a TTY).`],
    ['--no-stream',             `Disable live streaming; only print the final summary.`],
    ['--no-capture',            `Skip auto-capture of this run to the genome (M16 playbook).`],
  ];

  const optW = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, optW))}  ${desc}`);
  }

  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${gray('# Run a quick goal (local Ollama, no tools)')}`)
  console.log(`    ashlr run "Summarize the three most active repos" --no-tools`);
  console.log('');
  console.log(`    ${gray('# Full run with tight budget')}`)
  console.log(`    ashlr run "Audit for TODOs across dev-tools" --budget 8000 --max-steps 6`);
  console.log('');
  console.log(`    ${gray('# Run without genome memory injection')}`)
  console.log(`    ashlr run "One-off task" --no-memory`);
  console.log('');
  console.log(`    ${gray('# Resume an aborted run')}`)
  console.log(`    ashlr run --resume <id>`);
  console.log('');
  console.log(`    ${gray('# List past runs')}`)
  console.log(`    ashlr runs`);
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• LOCAL-FIRST: only Ollama / LM Studio by default.')}`);
  console.log(`    ${dim('• Budget is a HARD ceiling — exceeding it aborts cleanly.')}`);
  console.log(`    ${dim('• State persists to ~/.ashlr/runs/<id>.json (never touches repos).')}`);
  console.log(`    ${dim('• --no-memory disables genome context injection for this run.')}`);
  console.log(`    ${dim('• --no-capture disables genome auto-capture for this run.')}`);
  console.log('');
}
