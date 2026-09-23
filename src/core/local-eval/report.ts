/**
 * Turning trials into the number the harness exists to produce.
 *
 * MEDIAN, NOT JUST MEAN. Turn times on this hardware vary by tens of seconds,
 * and a single slow trial drags a mean far enough to invent a regression that
 * is not there. Both are reported, because a large gap between them is itself
 * the signal that a run was contended and its timings should not be compared.
 *
 * FAILURE MODES ARE RANKED. The most common mode is printed first, because the
 * question after "did this help?" is always "what is still broken?", and a
 * ranked list answers it without opening a single log.
 */

import type {
  EvalReport,
  FailureMode,
  HarnessConfiguration,
  TaskOutcome,
  TaskSpec,
  TrialResult,
} from './types.js';

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Aggregate every trial of one task. */
export function summariseTask(task: TaskSpec, trials: readonly TrialResult[]): TaskOutcome {
  const passes = trials.filter((t) => t.passed).length;
  const counts = new Map<FailureMode, number>();
  for (const trial of trials) {
    if (trial.passed) continue;
    counts.set(trial.mode, (counts.get(trial.mode) ?? 0) + 1);
  }
  const wall = trials.map((t) => t.wallMs);
  return {
    taskId: task.id,
    why: task.why,
    expectation: task.expectation,
    trials,
    passes,
    total: trials.length,
    passRate: trials.length === 0 ? 0 : passes / trials.length,
    medianWallMs: median(wall),
    meanWallMs: mean(wall),
    modes: [...counts.entries()]
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode)),
  };
}

export function buildReport(args: {
  readonly configuration: HarnessConfiguration;
  readonly outcomes: readonly TaskOutcome[];
  readonly trialsPerTask: number;
  readonly concurrency: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}): EvalReport {
  const totalTrials = args.outcomes.reduce((n, o) => n + o.total, 0);
  const totalPasses = args.outcomes.reduce((n, o) => n + o.passes, 0);
  return {
    configuration: args.configuration,
    trialsPerTask: args.trialsPerTask,
    concurrency: args.concurrency,
    outcomes: args.outcomes,
    overallPassRate: totalTrials === 0 ? 0 : totalPasses / totalTrials,
    totalPasses,
    totalTrials,
    startedAt: new Date(args.startedAt).toISOString(),
    finishedAt: new Date(args.finishedAt).toISOString(),
    wallMs: args.finishedAt - args.startedAt,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

/** Render a report for a terminal. Configuration first — it frames everything. */
export function renderReport(report: EvalReport): string {
  const c = report.configuration;
  const lines: string[] = [];

  lines.push('CONFIGURATION');
  lines.push(`  model            ${c.model} (${c.quantization})`);
  lines.push(`  slots            ${c.slots}`);
  lines.push(`  context/slot     ${c.contextPerSlot.toLocaleString()} (total ${c.contextTotal.toLocaleString()})`);
  lines.push(`  sampling         ${JSON.stringify(c.samplingParams)}`);
  lines.push(`  base url         ${c.baseUrl}  (proxy ${c.proxy}, tracing ${c.tracing})`);
  lines.push(`  proxy impl       ${c.proxyImplementation}`);
  lines.push(`  agent cli        ${c.agentCli}`);
  lines.push(`  concurrency      ${report.concurrency} trial(s) at a time`);
  lines.push('');

  lines.push(`RESULT  ${report.totalPasses}/${report.totalTrials} = ${pct(report.overallPassRate)} pass rate`
    + `  (${report.trialsPerTask} trials/task, ${secs(report.wallMs)} wall)`);
  lines.push('');

  const pad = (s: string, n: number): string => s.padEnd(n);
  lines.push(`  ${pad('task', 24)} ${pad('pass', 8)} ${pad('median', 8)} ${pad('mean', 8)} failure modes`);
  for (const o of report.outcomes) {
    const modes = o.modes.length === 0
      ? '-'
      : o.modes.map((m) => `${m.mode} x${m.count}`).join(', ');
    lines.push(`  ${pad(o.taskId, 24)} ${pad(`${o.passes}/${o.total}`, 8)} `
      + `${pad(secs(o.medianWallMs), 8)} ${pad(secs(o.meanWallMs), 8)} ${modes}`);
  }
  lines.push('');

  // Reported separately and never folded into the pass rate. An
  // `unsupported-claim` reading is a prompt to go and read one transcript, not
  // a verdict: the shared classifier fires on change verbs wherever they
  // appear, including in a refusal that merely MENTIONS refactoring. Treat a
  // flag on a passing trial as a question, and a flag on a failing one as the
  // most likely explanation.
  const flagged = report.outcomes.flatMap((o) =>
    o.trials
      .filter((t) => t.integrity === 'unsupported-claim')
      .map((t) => `${o.taskId}#${t.trial} (${t.passed ? 'passed the check' : t.mode})`));
  lines.push(`INTEGRITY FLAGS  ${flagged.length === 0 ? 'none' : flagged.join(', ')}`);
  lines.push('  claimed a change while the tree did not move — read the transcript before believing either side');
  lines.push('');

  // A timeout used to be the end of the story: the CLI emits its result JSON
  // once, at the end, so a killed trial recorded zero tokens, zero turns and no
  // transcript. An outcome nobody can act on is the same failure as a false
  // success, which is what this harness exists to catch — so every timeout now
  // reports what the wire was doing when the clock ran out.
  const timedOut = report.outcomes.flatMap((o) =>
    o.trials.filter((t) => t.mode === 'timeout').map((t) => ({ task: o.taskId, trial: t })));
  if (timedOut.length > 0) {
    lines.push('TIMEOUTS, DIAGNOSED');
    for (const { task, trial } of timedOut) {
      const d = trial.timeoutDiagnosis;
      lines.push(`  ${pad(`${task}#${trial.trial}`, 26)} ${d ? d.kind : 'UNDIAGNOSED (run without --no-trace)'}`);
      if (d) lines.push(`  ${' '.repeat(26)} ${d.detail}`);
      if (trial.trace) {
        // Turns the SERVER finished. The CLI's connectivity probe and token
        // counts are not SSE streams at all, and a turn the agent hung up on
        // is not evidence about the runtime — counting either would report a
        // terminator failure on every timeout.
        const turns = trial.trace.streams.filter(
          (x) => (x.events['message_start'] ?? 0) > 0 && x.ended === 'upstream-end');
        const unterminated = turns.filter((x) => !x.sawTerminator && x.ended === 'upstream-end').length;
        lines.push(`  ${' '.repeat(26)} ${turns.length} completed turn(s), `
          + `${unterminated} ended without a terminator; raw capture in ${trial.trace.captureDir}`);
        // Where the budget actually went. A single enormous turn and a long
        // series of ordinary ones are different problems with different fixes,
        // and the totals alone cannot tell them apart.
        if (turns.length > 0) {
          const longest = turns.reduce((a, b) => (a.durationMs >= b.durationMs ? a : b));
          const spent = turns.reduce((n, t) => n + t.durationMs, 0);
          lines.push(`  ${' '.repeat(26)} longest completed turn ${secs(longest.durationMs)} `
            + `(#${longest.seq}), ${secs(spent)} across all completed turns`);
        }
      }
    }
    lines.push('');
  }

  lines.push('TOKENS PER TRIAL (input / output / cache-read)');
  for (const o of report.outcomes) {
    for (const t of o.trials) {
      lines.push(`  ${pad(`${o.taskId}#${t.trial}`, 26)} `
        + `${pad(String(t.tokens.input), 8)} ${pad(String(t.tokens.output), 8)} `
        + `${pad(String(t.tokens.cacheRead), 10)} ${pad(t.mode, 26)} `
        + `${t.changedFiles ?? '?'} file(s), ${t.turns ?? '?'} turns${t.note ? ` — ${t.note}` : ''}`);
    }
  }

  return lines.join('\n');
}
