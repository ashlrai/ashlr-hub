/**
 * src/cli/eval-swe-bench.ts — M143 `ashlr eval swe-bench` CLI handler.
 *
 * Usage:
 *   ashlr eval swe-bench [--fixtures] [--dataset DIR] [--engine E] [-n N] [--json]
 *                        [--gate] [--baseline <report.json>]
 *
 * Options:
 *   --fixtures          Run the bundled local fixture tasks (default when no --dataset).
 *   --dataset <path>    Path to a SWE-bench JSONL file (instances.jsonl).
 *   --engine <id>       Engine id to use (default: local-coder).
 *   -n <N>              Limit to the first N tasks.
 *   --json              Emit JSON report instead of a human-readable table.
 *   --gate              M336: exit non-zero when this run REGRESSED vs the
 *                       baseline (a newly-broken task or a resolve-rate drop).
 *                       Wire into CI or a weekly cron for "are we improving?".
 *   --baseline <path>   M336: explicit baseline report JSON. Default: the most
 *                       recent persisted report in ~/.ashlr/eval/.
 *
 * Exit codes:
 *   0  run completed (even when some tasks failed to resolve; with --gate:
 *      no regression, or first run seeding the baseline)
 *   1  fatal error (bad args, missing dataset/baseline file, etc.)
 *   2  usage error
 *   3  --gate: run REGRESSED vs the baseline
 *
 * Report persistence:
 *   Each run appends ~/.ashlr/eval/<id>.json. The CLI prints the resolve-rate
 *   and compares against the previous report (regression gate).
 *
 * Real dataset (offline runtime steps — no network at import time):
 *   1. Download SWE-bench Verified JSONL:
 *        huggingface-cli download princeton-nlp/SWE-bench_Verified --local-dir ~/swe-bench-data
 *      or: wget https://... (see SWE-bench repo for canonical URL)
 *   2. Pre-clone repos at base commits (SWE-bench provides harness/prepare.py for this).
 *   3. Run: ashlr eval swe-bench --dataset ~/swe-bench-data/instances.jsonl --engine local-coder
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  runBenchmark,
  loadSweBenchDataset,
  saveReport,
  loadLastReport,
  compareReports,
  type BenchTask,
  type BenchReport,
  type ReportDelta,
  type EngineRunner,
} from '../core/eval/swe-bench.js';
import { makeColors, isTty, pad } from './ui.js';

const { bold, dim, cyan, red, green, yellow, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  useFixtures: boolean;
  datasetPath?: string;
  engine: string;
  limit?: number;
  json: boolean;
  /** M336: exit 3 when the run regressed vs the baseline. */
  gate: boolean;
  /** M336: explicit baseline report path (default: last persisted report). */
  baselinePath?: string;
  usageError?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { useFixtures: false, engine: 'local-coder', json: false, gate: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--fixtures') {
      result.useFixtures = true;
      i++;
    } else if (arg === '--dataset') {
      result.datasetPath = args[++i];
      i++;
    } else if (arg === '--engine') {
      result.engine = args[++i] ?? 'local-coder';
      i++;
    } else if (arg === '-n') {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        result.usageError = '-n requires a positive integer';
        return result;
      }
      result.limit = Math.floor(v);
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else if (arg === '--gate') {
      result.gate = true;
      i++;
    } else if (arg === '--baseline') {
      result.baselinePath = args[++i];
      if (!result.baselinePath) {
        result.usageError = '--baseline requires a report path';
        return result;
      }
      i++;
    } else if (arg === '--help' || arg === '-h') {
      result.usageError = 'help';
      return result;
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }
  // Default to fixtures when nothing else specified.
  if (!result.useFixtures && !result.datasetPath) {
    result.useFixtures = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

// M341a (win32): URL.pathname yields '/D:/a/…' on Windows, which Node then
// resolves against the drive root as 'D:\D:\a\…' — fileURLToPath is the
// portable conversion. This broke `--fixtures` for every Windows user.
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/swe-bench',
);

/** Load the bundled fixture tasks. Builds a minimal self-contained repo in a temp dir. */
export function loadFixtureTasks(): BenchTask[] {
  const tasksFile = path.join(FIXTURE_DIR, 'tasks.json');
  const rawTasks: Array<{
    id: string;
    problemStatement: string;
    goldTestCommand: string;
    failToPassTests: string[];
  }> = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  return rawTasks.map((t) => {
    // Build a minimal self-contained repo snapshot in a temp dir.
    const repoPath = buildFixtureRepo(t.id);
    return {
      id: t.id,
      problemStatement: t.problemStatement,
      repoPath,
      goldTestCommand: t.goldTestCommand,
      failToPassTests: t.failToPassTests,
    };
  });
}

/**
 * Create a minimal self-contained repo for a named fixture.
 * Each fixture type is handled by a small factory function.
 */
function buildFixtureRepo(taskId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ashlr-fix-${taskId}-`));

  if (taskId === 'fix-add-off-by-one') {
    // src/math.js has a bug: returns a + b + 1 instead of a + b
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'math.js'),
      'function add(a, b) { return a + b + 1; }\nmodule.exports = { add };\n',
    );
    fs.writeFileSync(
      path.join(dir, 'test.js'),
      [
        "const { add } = require('./src/math.js');",
        "let ok = true;",
        "if (add(2, 3) !== 5) { console.error('FAIL test_add_basic: expected 5 got ' + add(2,3)); ok = false; }",
        "if (ok) { console.log('PASS'); process.exit(0); } else { process.exit(1); }",
      ].join('\n'),
    );
  } else if (taskId === 'fix-greet-missing-name') {
    // src/greet.js ignores the name arg
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'greet.js'),
      "function greet(name) { return 'Hello, World!'; }\nmodule.exports = { greet };\n",
    );
    fs.writeFileSync(
      path.join(dir, 'test.js'),
      [
        "const { greet } = require('./src/greet.js');",
        "let ok = true;",
        "if (greet('Alice') !== 'Hello, Alice!') { console.error('FAIL test_greet_name: expected Hello, Alice! got ' + greet('Alice')); ok = false; }",
        "if (ok) { console.log('PASS'); process.exit(0); } else { process.exit(1); }",
      ].join('\n'),
    );
  } else {
    // Unknown fixture: empty repo with a trivially-passing test
    fs.writeFileSync(path.join(dir, 'test.js'), "console.log('PASS'); process.exit(0);\n");
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReport(report: BenchReport, delta: ReportDelta | null): void {
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  console.log('');
  console.log(bold('  ashlr eval swe-bench') + dim(` — ${report.ts}`));
  console.log('');
  console.log(`  Engine  : ${cyan(report.engine)}`);
  console.log(`  Tasks   : ${report.total}`);
  console.log(`  Resolved: ${report.resolved}/${report.total} (${pct(report.resolveRate)})`);
  console.log('');

  // Per-task table
  const idW = Math.max(8, ...report.perTask.map((r) => r.taskId.length));
  const header = `${pad('task', idW)}  ${pad('resolved', 10)}  duration`;
  console.log('  ' + dim(header));
  console.log('  ' + dim('-'.repeat(header.length)));
  for (const r of report.perTask) {
    const status = r.resolved ? green('✓ yes') : red('✗ no ');
    const err = r.error ? dim(` [${r.error.slice(0, 40)}]`) : '';
    console.log(`  ${pad(r.taskId, idW)}  ${status}        ${r.durationMs}ms${err}`);
  }
  console.log('');

  // Regression gate delta
  if (delta) {
    const sign = delta.resolveRateDelta >= 0 ? '+' : '';
    const deltaStr = `${sign}${(delta.resolveRateDelta * 100).toFixed(1)}%`;
    const colour = delta.regressed ? red : delta.improved ? green : dim;
    console.log(`  vs prior: ${colour(deltaStr)}`);
    if (delta.newlyBroken.length > 0) {
      console.log(`  ${red('⚠ newly broken:')} ${delta.newlyBroken.join(', ')}`);
    }
    if (delta.newlyFixed.length > 0) {
      console.log(`  ${green('✓ newly fixed:')} ${delta.newlyFixed.join(', ')}`);
    }
    if (!delta.regressed && !delta.improved) {
      console.log(`  ${dim('(no change vs prior)')}`);
    }
    console.log('');
  } else {
    console.log(`  ${dim('(no prior report to compare against)')}`);
    console.log('');
  }
}

function renderHelp(): void {
  console.log('');
  console.log(bold('  ashlr eval swe-bench') + dim(' — M143 regression benchmark harness'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log('    ashlr eval swe-bench [--fixtures] [--dataset <path>] [--engine <id>] [-n N] [--json]');
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');
  const opts: [string, string][] = [
    ['--fixtures', 'Run the bundled local fixture tasks (default).'],
    ['--dataset <path>', 'Path to a SWE-bench JSONL file (instances.jsonl).'],
    ['--engine <id>', 'Engine id to benchmark (default: local-coder).'],
    ['-n <N>', 'Limit to the first N tasks.'],
    ['--json', 'Emit JSON report instead of a table.'],
    ['--gate', 'Exit 3 when this run regressed vs the baseline (M336; for CI/cron).'],
    ['--baseline <path>', 'Explicit baseline report JSON (default: last persisted report).'],
  ];
  const w = Math.max(...opts.map(([o]) => o.length));
  for (const [o, d] of opts) {
    console.log(`    ${cyan(pad(o, w))}  ${d}`);
  }
  console.log('');
  console.log('  ' + bold('Real dataset (download once, run locally):'));
  console.log('');
  console.log(`    ${gray('1. Download SWE-bench Verified JSONL:')}`);
  console.log(`    ${gray('     huggingface-cli download princeton-nlp/SWE-bench_Verified --local-dir ~/swe-bench-data')}`);
  console.log(`    ${gray('2. Pre-clone repos at base commits (see SWE-bench harness/prepare.py).')}`);
  console.log(`    ${gray('3. ashlr eval swe-bench --dataset ~/swe-bench-data/instances.jsonl')}`);
  console.log('');
  console.log('  ' + bold('Reports:'));
  console.log(`    ${gray('Saved to ~/.ashlr/eval/. Each run compares against the prior report (regression gate).')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface SweBenchRunOptions {
  /** Override the engine runner (for testing). */
  engineRunner?: EngineRunner;
}

export async function cmdSweBench(
  args: string[],
  _opts: SweBenchRunOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.usageError === 'help') {
    renderHelp();
    return 0;
  }
  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load tasks
  let tasks: BenchTask[];
  if (parsed.datasetPath) {
    if (!fs.existsSync(parsed.datasetPath)) {
      process.stderr.write(red('error: ') + `dataset not found: ${parsed.datasetPath}\n`);
      return 1;
    }
    tasks = loadSweBenchDataset(parsed.datasetPath);
  } else {
    tasks = loadFixtureTasks();
  }

  if (tasks.length === 0) {
    process.stderr.write(yellow('warning: ') + 'no tasks found — check --dataset path\n');
    return 0;
  }

  // M336: baseline resolution — an explicit --baseline file wins over the
  // most recent persisted report.
  let prior = loadLastReport();
  if (parsed.baselinePath) {
    if (!fs.existsSync(parsed.baselinePath)) {
      process.stderr.write(red('error: ') + `baseline not found: ${parsed.baselinePath}\n`);
      return 1;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(parsed.baselinePath, 'utf8')) as BenchReport;
      if (!Array.isArray(raw.perTask) || typeof raw.resolveRate !== 'number') {
        throw new Error('bad shape');
      }
      prior = raw;
    } catch {
      process.stderr.write(
        red('error: ') + `baseline is not a valid BenchReport: ${parsed.baselinePath}\n`,
      );
      return 1;
    }
  }

  if (!parsed.json) {
    process.stderr.write(
      `running ${parsed.limit ? Math.min(parsed.limit, tasks.length) : tasks.length} task(s) with engine ${parsed.engine}\n`,
    );
  }

  const report = await runBenchmark(tasks, {
    engine: parsed.engine,
    engineRunner: _opts.engineRunner,
    limit: parsed.limit,
  });

  const delta = prior ? compareReports(prior, report) : null;

  // Persist
  const savedPath = saveReport(report);

  // Output
  if (parsed.json) {
    process.stdout.write(JSON.stringify({ report, delta }, null, 2) + '\n');
  } else {
    renderReport(report, delta);
    console.log(`  ${dim('report saved:')} ${savedPath}`);
    console.log('');
  }

  // M336: regression gate — exit 3 when this run REGRESSED vs the baseline
  // (a newly-broken task, or a resolve-rate drop). A first run with no
  // baseline seeds it and passes, so the gate is safe to wire into CI/cron
  // from day one.
  if (parsed.gate) {
    if (!delta) {
      process.stderr.write(yellow('gate: ') + 'no baseline yet — this report seeds it (pass)\n');
      return 0;
    }
    if (delta.regressed) {
      process.stderr.write(
        red('gate: REGRESSED') +
          ` (${delta.newlyBroken.length} newly broken, resolve-rate ${(delta.resolveRateDelta * 100).toFixed(1)}%)\n`,
      );
      return 3;
    }
    process.stderr.write(green('gate: PASS') + '\n');
  }

  return 0;
}
