/**
 * Entry point: run the task set N times and print a comparable number.
 *
 *   npx tsx src/core/local-eval/main.ts [--trials N] [--concurrency N]
 *                                       [--base-url URL] [--upstream URL]
 *                                       [--model REF] [--timeout-ms N]
 *                                       [--task ID] [--out FILE] [--no-trace]
 *                                       [--set core|heldout]
 *   npx tsx src/core/local-eval/main.ts --experiments [--fleet-busy]
 *
 * `--set heldout` runs the held-out set (tasks-heldout.ts) that harness
 * experiments are scored on. `--experiments` drains the harness-experiment
 * queue (learn/experiments.ts) one experiment at a time, each a paired
 * campaign on the held-out set, printing every verdict; `--fleet-busy` holds
 * it to one local slot as the daemon does while fleet work is queued.
 *
 * CONCURRENCY DEFAULTS TO 2, NOT TO THE SLOT COUNT. The runtime is shared with
 * whatever else is using this machine. Saturating all four slots would make the
 * harness's own timings a measurement of contention, and would degrade everyone
 * else's turns while it ran. Raise it deliberately, and only on an idle box —
 * and note that timings taken at different concurrencies are not comparable.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { captureConfiguration, projectBenchmarkText } from './configuration.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  DEFAULT_ANTHROPIC_PROXY_PORT,
  DEFAULT_LLAMA_HOST,
  DEFAULT_LLAMA_PORT,
} from '../local-runtime/llama/config.js';
import { buildReport, renderReport, summariseTask } from './report.js';
import { runTrial } from './runner.js';
import { TASKS } from './tasks.js';
import { HELD_OUT_TASKS, taskSetDigest } from './tasks-heldout.js';
import { compareReportsCli } from './compare.js';
import type { TaskOutcome, TaskSpec, TrialResult } from './types.js';

export interface Args {
  trials: number;
  concurrency: number;
  baseUrl: string;
  upstream: string;
  model: string;
  agentCli: string;
  timeoutMs: number;
  taskFilter: string | null;
  out: string | null;
  /** Insert the tracing proxy. On by default; `--no-trace` turns it off. */
  trace: boolean;
  /** Which task set: the core set (default) or the held-out experiment set. */
  set: 'core' | 'heldout';
  /** Drain the harness-experiment queue instead of running a plain baseline. */
  experiments: boolean;
  /** With --experiments: use one local slot, as the daemon does while fleet work waits. */
  fleetBusy: boolean;
  /** Operator-recorded control, not an assertion that this runner flushed caches. */
  cacheState: 'cold' | 'warm' | 'uncontrolled';
  cacheProtocol: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    trials: 3,
    concurrency: 2,
    // These DEFAULT TO THE SHIPPING PORTS, derived from config.ts rather than
    // written out, and that is the whole point. The previous default was
    // `http://127.0.0.1:8090`, which is not a port anything in this repository
    // ever binds — it was a hand-started scratch script outside the tree. A
    // baseline measured against it therefore could not be reproduced from a
    // clean checkout: the harness pointed at a port that, for anyone but the
    // one machine the script was running on, had nothing behind it. Deriving
    // both from the constants keeps the harness aimed at the lane the product
    // actually serves.
    baseUrl:
      process.env['ASHLR_EVAL_BASE_URL']
      ?? `http://${DEFAULT_LLAMA_HOST}:${DEFAULT_ANTHROPIC_PROXY_PORT}`,
    upstream:
      process.env['ASHLR_EVAL_UPSTREAM'] ?? `http://${DEFAULT_LLAMA_HOST}:${DEFAULT_LLAMA_PORT}`,
    // llama-server serves whatever is loaded and ignores this, but the CLI
    // stamps it into the result JSON, so it is the label the run is filed under.
    model: process.env['ASHLR_EVAL_MODEL'] ?? 'qwen3.8',
    agentCli: process.env['ASHLR_EVAL_AGENT'] ?? 'claude',
    timeoutMs: 900_000,
    taskFilter: null,
    out: null,
    trace: true,
    set: 'core',
    experiments: false,
    fleetBusy: false,
    cacheState: 'uncontrolled',
    cacheProtocol: '',
  };
  const seen = new Set<string>();
  const number = (value: string | undefined, flag: string): number => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new EvalUsageError(`invalid ${flag}: expected a positive safe integer`);
    return Number(value);
  };
  const string = (value: string | undefined, flag: string): string => {
    if (!value || value.startsWith('-') || value.length > 8192 || value.includes('\0')) throw new EvalUsageError(`invalid ${flag}: expected a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const key = flag === '--trace' || flag === '--no-trace' ? 'tracing' : flag!;
    if (seen.has(key)) throw new EvalUsageError('duplicate benchmark option');
    seen.add(key);
    switch (flag) {
      case '--trials': args.trials = number(value, flag); i += 1; break;
      case '--concurrency': args.concurrency = number(value, flag); i += 1; break;
      case '--base-url': args.baseUrl = string(value, flag); i += 1; break;
      case '--upstream': args.upstream = string(value, flag); i += 1; break;
      case '--model': args.model = string(value, flag); i += 1; break;
      case '--agent': args.agentCli = string(value, flag); i += 1; break;
      case '--timeout-ms': args.timeoutMs = number(value, flag); i += 1; break;
      case '--task': args.taskFilter = string(value, flag); i += 1; break;
      case '--out': args.out = string(value, flag); i += 1; break;
      case '--no-trace': args.trace = false; break;
      case '--trace': args.trace = true; break;
      case '--set':
        if (value !== 'core' && value !== 'heldout') throw new EvalUsageError('invalid --set: expected core or heldout');
        args.set = value; i += 1; break;
      case '--experiments': args.experiments = true; break;
      case '--fleet-busy': args.fleetBusy = true; break;
      case '--cache-state':
        if (value !== 'cold' && value !== 'warm' && value !== 'uncontrolled') throw new EvalUsageError('invalid --cache-state');
        args.cacheState = value; i += 1; break;
      case '--cache-protocol':
        args.cacheProtocol = string(value, flag); i += 1; break;
      default: throw new EvalUsageError('unknown benchmark option');
    }
  }
  if (args.fleetBusy && !args.experiments) throw new EvalUsageError('--fleet-busy requires --experiments');
  for (const url of [args.baseUrl, args.upstream]) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new EvalUsageError('invalid runtime URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new EvalUsageError('runtime URLs must use HTTP(S) without credentials, query or fragment');
    }
  }
  return args;
}

export class EvalUsageError extends Error {}

/** Run `jobs` with at most `limit` in flight, preserving result order. */
export async function pool<T>(
  jobs: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

/** The task list a run uses: the chosen set, optionally narrowed to one task. */
export function selectTasks(args: Pick<Args, 'set' | 'taskFilter'>): readonly TaskSpec[] {
  const set = args.set === 'heldout' ? HELD_OUT_TASKS : TASKS;
  return args.taskFilter ? set.filter((t) => t.id === args.taskFilter) : set;
}

/**
 * Drain the experiment queue. Imported lazily: learn/experiments.ts imports
 * this module (for `parseArgs`), and a static import back would be a cycle.
 */
async function runExperimentQueue(args: Args, out: (text: string) => void, err: (text: string) => void): Promise<number> {
  const { localEvalExecutor, runNextExperiment } = await import('../learn/experiments.js');
  const { renderExperimentResult } = await import('./report.js');
  const executor = await localEvalExecutor({
    baseUrl: args.baseUrl, model: args.model, agentCli: args.agentCli, timeoutMs: args.timeoutMs, trace: args.trace,
  });
  let exitCode = 0;
  for (;;) {
    const result = await runNextExperiment({ executor, fleetQueueDepth: () => (args.fleetBusy ? 1 : 0) });
    if (result.ran === null) {
      err(result.reason === 'no experiment is queued'
        ? '[local-eval] experiments: no experiment is queued'
        : '[local-eval] experiments: execution is held; inspect the private experiment record');
      return result.reason === 'no experiment is queued' ? exitCode : 1;
    }
    out(result.ran.status === 'failed' || result.ran.status === 'cancelled'
      ? `[local-eval] experiment ${projectBenchmarkText(result.ran.id)} ${result.ran.status}; inspect the private experiment record`
      : scrubSecrets(renderExperimentResult(result.ran)));
    out('');
    if (result.ran.status === 'failed' || result.ran.status === 'cancelled') exitCode = 1;
  }
}

export interface LocalEvalDeps {
  captureConfiguration: typeof captureConfiguration;
  runTrial: typeof runTrial;
  createArtifactRoot(): Promise<string>;
  writeReport(path: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void>;
  runExperiments(args: Args, out: (text: string) => void, err: (text: string) => void): Promise<number>;
  out(text: string): void;
  err(text: string): void;
}

async function privateArtifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ashlr-local-eval-'));
  await chmod(root, 0o700);
  return root;
}

async function privateReport(path: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void> {
  await writeFile(path, data, options);
  // writeFile's mode applies only on creation; a selected existing report must
  // not retain broader permissions after receiving benchmark metadata.
  await chmod(path, 0o600);
}

/** Resource estimate only: not a model-capacity measurement or a guarantee of launch memory. */
function checkWorkerAllocation(workerCount: number, resultCount: number): void {
  const heap = getHeapStatistics();
  const estimatedBookkeepingBytes = workerCount * 128 + resultCount * 256;
  if (workerCount > 0xffff_ffff || resultCount > 0xffff_ffff || !Number.isSafeInteger(estimatedBookkeepingBytes)
    || estimatedBookkeepingBytes > Math.max(0, heap.heap_size_limit - heap.used_heap_size)) {
    throw new Error('requested worker bookkeeping exceeds array or estimated available heap capacity');
  }
}

/** Lazy requested-trial inventory: retain results only for trials actually completed. */
async function indexedTrials(tasks: readonly TaskSpec[], args: Args, execute: (task: TaskSpec, trial: number) => Promise<TrialResult>): Promise<TrialResult[]> {
  const total = tasks.length * args.trials;
  let next = 0;
  let failed = false;
  const results: { index: number; result: TrialResult }[] = [];
  // Allocate bookkeeping before starting any trial, so allocation failure cannot orphan workers.
  const workers = new Array<Promise<void>>(Math.min(args.concurrency, total));
  const work = async (): Promise<void> => {
    while (!failed && next < total) {
      const index = next++;
      try {
        const result = await execute(tasks[Math.floor(index / args.trials)]!, index % args.trials + 1);
        results.push({ index, result });
      } catch {
        failed = true;
      }
    }
  };
  for (let worker = 0; worker < workers.length; worker += 1) workers[worker] = work();
  await Promise.allSettled(workers);
  if (failed) throw new Error('a benchmark trial could not be recorded');
  return results.sort((a, b) => a.index - b.index).map((entry) => entry.result);
}

/** Shared by the installed CLI and legacy source entry; only an explicit caller runs trials. */
export async function runLocalEval(argv: readonly string[], overrides: Partial<LocalEvalDeps> = {}): Promise<number> {
  const deps: LocalEvalDeps = { captureConfiguration, runTrial, createArtifactRoot: privateArtifactRoot,
    writeReport: privateReport, runExperiments: runExperimentQueue, out: console.log, err: console.error, ...overrides };
  // Before configuration capture, queue imports, or any agent/runtime interaction.
  if (argv.some((arg) => arg.startsWith('--compare'))) {
    const result = compareReportsCli(argv);
    deps.out(result.output);
    return result.exitCode;
  }
  let args: Args;
  try { args = parseArgs(argv); }
  catch (error) { deps.err(error instanceof EvalUsageError ? error.message : 'invalid benchmark options'); return 2; }
  if (args.experiments) {
    try { return await deps.runExperiments(args, deps.out, deps.err); }
    catch { deps.err('[local-eval] experiment execution failed; no successful result was inferred'); return 1; }
  }
  const tasks = selectTasks(args);
  if (tasks.length === 0) {
    deps.err('no benchmark task matched the selected task');
    return 2;
  }
  if (!Number.isSafeInteger(tasks.length * args.trials)) { deps.err('requested task/trial cardinality is not a safe integer'); return 2; }
  try { checkWorkerAllocation(Math.min(args.concurrency, tasks.length * args.trials), tasks.length * args.trials); }
  catch { deps.err('[local-eval] requested worker bookkeeping exceeds array or estimated available heap capacity; no runtime was probed'); return 1; }

  try {
    const configuration = await deps.captureConfiguration({
      baseUrl: args.baseUrl,
      upstreamOrigin: args.upstream,
      agentCli: args.agentCli,
      tracing: args.trace,
    });

    const root = await deps.createArtifactRoot();
    deps.err(`[local-eval] ${tasks.length} task(s) x ${args.trials} trial(s), `
      + `concurrency ${args.concurrency}, artifacts in ${root}`);

    const startedAt = Date.now();
    const all = await indexedTrials(tasks, args, async (task, trial) => {
      const result = await deps.runTrial({
        task,
        trial,
        trialDir: join(root, `${task.id}-${trial}`),
        baseUrl: args.baseUrl,
        model: args.model,
        agentCli: args.agentCli,
        timeoutMs: args.timeoutMs,
        trace: args.trace,
      });
      deps.err(`[local-eval] ${task.id}#${trial} ${result.mode} `
        + `(${(result.wallMs / 1000).toFixed(0)}s)`
        + (result.timeoutDiagnosis ? ` — ${result.timeoutDiagnosis.kind}` : ''));
      return result;
    });
    const finishedAt = Date.now();

    const outcomes: TaskOutcome[] = tasks.map((task) =>
      summariseTask(task, all.filter((r) => r.taskId === task.id)));

    const report = buildReport({
      configuration, outcomes,
      comparisonEvidence: { version: 1, taskDigest: taskSetDigest(tasks), cacheState: args.cacheState,
        cacheProtocol: projectBenchmarkText(args.cacheProtocol), agentModel: projectBenchmarkText(args.model), timeoutMs: args.timeoutMs,
        appendSystemPrompt: '', effort: 'default' },
      trialsPerTask: args.trials,
      concurrency: args.concurrency,
      startedAt, finishedAt,
    });

    const target = args.out ?? join(root, 'report.json');
    await deps.writeReport(target, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    deps.out(scrubSecrets(renderReport(report)));
    deps.err(`\n[local-eval] report written to ${target}`);
    return report.totalTrials > 0 && report.totalPasses === report.totalTrials ? 0 : 1;
  } catch {
    deps.err('[local-eval] benchmark execution or artifact writing failed; no successful result was inferred');
    return 1;
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (process.argv[1] && ['main.ts', 'main.js'].includes(basename(process.argv[1])) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLocalEval(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
