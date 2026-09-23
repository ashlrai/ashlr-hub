/**
 * Entry point: run the task set N times and print a comparable number.
 *
 *   npx tsx src/core/local-eval/main.ts [--trials N] [--concurrency N]
 *                                       [--base-url URL] [--upstream URL]
 *                                       [--model REF] [--timeout-ms N]
 *                                       [--task ID] [--out FILE]
 *
 * CONCURRENCY DEFAULTS TO 2, NOT TO THE SLOT COUNT. The runtime is shared with
 * whatever else is using this machine. Saturating all four slots would make the
 * harness's own timings a measurement of contention, and would degrade everyone
 * else's turns while it ran. Raise it deliberately, and only on an idle box —
 * and note that timings taken at different concurrencies are not comparable.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureConfiguration } from './configuration.js';
import {
  DEFAULT_ANTHROPIC_PROXY_PORT,
  DEFAULT_LLAMA_HOST,
  DEFAULT_LLAMA_PORT,
} from '../local-runtime/llama/config.js';
import { buildReport, renderReport, summariseTask } from './report.js';
import { runTrial } from './runner.js';
import { TASKS } from './tasks.js';
import type { TaskOutcome, TrialResult } from './types.js';

interface Args {
  trials: number;
  concurrency: number;
  baseUrl: string;
  upstream: string;
  model: string;
  agentCli: string;
  timeoutMs: number;
  taskFilter: string | null;
  out: string | null;
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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--trials': args.trials = Number(value); i += 1; break;
      case '--concurrency': args.concurrency = Number(value); i += 1; break;
      case '--base-url': args.baseUrl = String(value); i += 1; break;
      case '--upstream': args.upstream = String(value); i += 1; break;
      case '--model': args.model = String(value); i += 1; break;
      case '--agent': args.agentCli = String(value); i += 1; break;
      case '--timeout-ms': args.timeoutMs = Number(value); i += 1; break;
      case '--task': args.taskFilter = String(value); i += 1; break;
      case '--out': args.out = String(value); i += 1; break;
      default: break;
    }
  }
  return args;
}

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = args.taskFilter ? TASKS.filter((t) => t.id === args.taskFilter) : TASKS;
  if (tasks.length === 0) {
    console.error(`no task matched ${args.taskFilter}`);
    process.exitCode = 2;
    return;
  }

  const configuration = await captureConfiguration({
    baseUrl: args.baseUrl,
    upstreamOrigin: args.upstream,
    agentCli: args.agentCli,
  });

  const root = join(tmpdir(), `ashlr-local-eval-${Date.now()}`);
  await mkdir(root, { recursive: true });
  console.error(`[local-eval] ${tasks.length} task(s) x ${args.trials} trial(s), `
    + `concurrency ${args.concurrency}, artifacts in ${root}`);

  const startedAt = Date.now();
  const jobs: (() => Promise<TrialResult>)[] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= args.trials; trial += 1) {
      jobs.push(async () => {
        const result = await runTrial({
          task,
          trial,
          trialDir: join(root, `${task.id}-${trial}`),
          baseUrl: args.baseUrl,
          model: args.model,
          agentCli: args.agentCli,
          timeoutMs: args.timeoutMs,
        });
        console.error(`[local-eval] ${task.id}#${trial} ${result.mode} `
          + `(${(result.wallMs / 1000).toFixed(0)}s)`);
        return result;
      });
    }
  }

  const all = await pool(jobs, args.concurrency);
  const finishedAt = Date.now();

  const outcomes: TaskOutcome[] = tasks.map((task) =>
    summariseTask(task, all.filter((r) => r.taskId === task.id)));

  const report = buildReport({
    configuration, outcomes,
    trialsPerTask: args.trials,
    concurrency: args.concurrency,
    startedAt, finishedAt,
  });

  const target = args.out ?? join(root, 'report.json');
  await writeFile(target, JSON.stringify(report, null, 2), 'utf8');
  console.log(renderReport(report));
  console.error(`\n[local-eval] report written to ${target}`);
}

// Only run when invoked directly, so the module stays importable by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
