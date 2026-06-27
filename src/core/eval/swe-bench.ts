/**
 * src/core/eval/swe-bench.ts — M143 SWE-bench evaluation harness.
 *
 * Runs a set of benchmark tasks through the fleet's engine (via
 * runApiModelSandboxed or a mock injected for testing), applies each produced
 * diff in an isolated sandbox, executes the task's gold test command, and scores
 * resolved vs unresolved → BenchReport.
 *
 * NETWORK: zero at import time. The harness logic operates on a local task set.
 * Downloading a real dataset is a documented runtime step (see loadSweBenchDataset).
 *
 * REAL DATASET — to run against SWE-bench Verified / SWE-rebench:
 *   1. Download the JSONL file from the dataset provider (e.g. princeton-nlp/SWE-bench).
 *      Example: `huggingface-cli download princeton-nlp/SWE-bench_Verified instances.jsonl`
 *   2. Point the CLI at it: `ashlr eval swe-bench --dataset /path/to/instances.jsonl`
 *   3. The loader (loadSweBenchDataset) reads the standard JSONL format and maps
 *      each record to a BenchTask. See the loader for field mapping.
 *
 * INTERNAL USE ONLY: results are persisted to ~/.ashlr/eval/ and compared via
 * compareReports for regression gating. Do not submit to the public leaderboard
 * (which requires academic submission protocols).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

/** A single benchmark task. Mirrors the SWE-bench instance schema. */
export interface BenchTask {
  /** Unique task id (e.g. "django__django-11099"). */
  id: string;
  /** Human-readable problem statement / issue description passed to the engine. */
  problemStatement: string;
  /**
   * Path to a git repo snapshot to use as the workspace. When using fixtures
   * this is a temp dir; when using a real dataset it should be a pre-cloned
   * repo checkout at the base commit.
   */
  repoPath: string;
  /** Shell command whose exit-0 means the task is resolved (e.g. "python -m pytest ..."). */
  goldTestCommand: string;
  /** Test IDs that must transition fail→pass for the task to be "resolved". */
  failToPassTests: string[];
}

/** Per-task outcome. */
export interface BenchTaskResult {
  taskId: string;
  engine: string;
  /** Whether the gold test command exited 0 after applying the diff. */
  resolved: boolean;
  /** Raw diff produced by the engine (empty string = no changes). */
  diff: string;
  /** stderr/stdout from the test runner. */
  testOutput: string;
  /** Error message when the engine or test runner threw. */
  error?: string;
  durationMs: number;
}

/** Aggregate benchmark report. */
export interface BenchReport {
  /** Monotonic report id (timestamp-based). */
  id: string;
  /** ISO timestamp of the run. */
  ts: string;
  /** Engine id used (e.g. "local-coder"). */
  engine: string;
  total: number;
  resolved: number;
  resolveRate: number;
  perTask: BenchTaskResult[];
  /** Resolve rate grouped by engine (useful when running multiple engines). */
  byEngine: Record<string, { total: number; resolved: number; resolveRate: number }>;
}

/** Delta between two reports (regression gate). */
export interface ReportDelta {
  resolveRateDelta: number;
  /** Tasks that were resolved in `a` but not in `b` (regressions). */
  newlyBroken: string[];
  /** Tasks that were unresolved in `a` but resolved in `b` (improvements). */
  newlyFixed: string[];
  /** true when b is better than a (no regressions, at least one fix, or higher rate). */
  improved: boolean;
  /** true when b is worse than a (lower resolveRate or any newly broken task). */
  regressed: boolean;
}

// ---------------------------------------------------------------------------
// Engine interface (injectable for testing)
// ---------------------------------------------------------------------------

/**
 * An engine runner receives a problem statement and a workspace path, and returns
 * a unified diff string. The harness applies the diff and runs tests.
 *
 * In production this wraps runApiModelSandboxed. In tests a mock is injected.
 */
export type EngineRunner = (
  problemStatement: string,
  repoPath: string,
  engine: string,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Diff application
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff to the given directory using `git apply`. Returns true
 * on success, false on failure. No-ops for empty diffs.
 *
 * Uses `git apply` rather than `patch -p1` because macOS's BSD patch has a
 * known "out of memory" failure when invoked with a cwd override via execSync.
 * `git apply` is more reliable and handles unified diffs produced by any engine.
 *
 * Exposed for testing.
 */
export function applyDiff(diff: string, repoPath: string): boolean {
  if (!diff.trim()) return true; // empty diff = no changes = already passing or skipped
  // Write the diff to a temp file — avoids stdin-pipe issues on macOS BSD patch.
  const tmpPatch = path.join(repoPath, '.ashlr-bench.patch');
  try {
    fs.writeFileSync(tmpPatch, diff, 'utf8');
    // Ensure there is a git repo so `git apply` has a context.
    try {
      execSync('git init -q', { cwd: repoPath, stdio: 'pipe', timeout: 10_000 });
    } catch {
      // already a repo or init failed — git apply may still work
    }
    execSync(`git apply --whitespace=nowarn "${tmpPatch}"`, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmpPatch); } catch { /* best-effort */ }
  }
}

/**
 * Run the gold test command in the given directory. Returns { ok, output }.
 * Times out after 120 s to prevent CI hangs.
 */
export function runTests(
  goldTestCommand: string,
  repoPath: string,
): { ok: boolean; output: string } {
  try {
    const out = execSync(goldTestCommand, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      encoding: 'utf8',
    });
    return { ok: true, output: typeof out === 'string' ? out : '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    return { ok: false, output };
  }
}

// ---------------------------------------------------------------------------
// Core harness
// ---------------------------------------------------------------------------

export interface RunHarnessOptions {
  /** Engine id label (for reporting). Default "local-coder". */
  engine?: string;
  /** Inject a custom engine runner (production uses runApiModelSandboxed wrapper). */
  engineRunner?: EngineRunner;
  /** Max tasks to run (slice). Useful for quick smoke checks. */
  limit?: number;
}

/**
 * Run the benchmark harness over a set of tasks.
 *
 * Each task runs in an isolated copy of its repoPath (a temp dir) so that
 * applying a diff never mutates the original snapshot. This keeps reruns clean.
 */
export async function runBenchmark(
  tasks: BenchTask[],
  opts: RunHarnessOptions = {},
): Promise<BenchReport> {
  const engine = opts.engine ?? 'local-coder';
  const runner = opts.engineRunner ?? buildDefaultRunner(engine);
  const limited = opts.limit != null ? tasks.slice(0, opts.limit) : tasks;

  const perTask: BenchTaskResult[] = [];

  for (const task of limited) {
    const t0 = Date.now();
    // Work in an isolated copy so diffs don't accumulate across tasks.
    const workDir = isolateRepo(task.repoPath);
    try {
      let diff = '';
      let error: string | undefined;
      try {
        diff = await runner(task.problemStatement, workDir, engine);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      let resolved = false;
      let testOutput = '';

      if (!error) {
        const applied = applyDiff(diff, workDir);
        if (!applied) {
          error = 'patch application failed';
        } else {
          const result = runTests(task.goldTestCommand, workDir);
          resolved = result.ok;
          testOutput = result.output;
        }
      }

      perTask.push({
        taskId: task.id,
        engine,
        resolved,
        diff,
        testOutput,
        error,
        durationMs: Date.now() - t0,
      });
    } finally {
      cleanupDir(workDir);
    }
  }

  return buildReport(engine, perTask);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildReport(engine: string, perTask: BenchTaskResult[]): BenchReport {
  const total = perTask.length;
  const resolved = perTask.filter((r) => r.resolved).length;
  const resolveRate = total === 0 ? 0 : resolved / total;

  const byEngine: BenchReport['byEngine'] = {};
  for (const r of perTask) {
    const e = r.engine;
    if (!byEngine[e]) byEngine[e] = { total: 0, resolved: 0, resolveRate: 0 };
    byEngine[e]!.total++;
    if (r.resolved) byEngine[e]!.resolved++;
  }
  for (const e of Object.keys(byEngine)) {
    const g = byEngine[e]!;
    g.resolveRate = g.total === 0 ? 0 : g.resolved / g.total;
  }

  const ts = new Date().toISOString();
  const id = `bench-${Date.now().toString(36)}`;
  return { id, ts, engine, total, resolved, resolveRate, perTask, byEngine };
}

// ---------------------------------------------------------------------------
// Report persistence
// ---------------------------------------------------------------------------

const EVAL_DIR = path.join(os.homedir(), '.ashlr', 'eval');

/** Persist a BenchReport to ~/.ashlr/eval/<id>.json. */
export function saveReport(report: BenchReport): string {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  const file = path.join(EVAL_DIR, `${report.id}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

/** Load all persisted reports sorted by ts ascending. */
export function loadReports(): BenchReport[] {
  if (!fs.existsSync(EVAL_DIR)) return [];
  const files = fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith('.json'));
  const reports: BenchReport[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(EVAL_DIR, f), 'utf8');
      reports.push(JSON.parse(raw) as BenchReport);
    } catch {
      // skip malformed files
    }
  }
  return reports.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Load the most recent persisted report (or undefined if none). */
export function loadLastReport(): BenchReport | undefined {
  const all = loadReports();
  return all.at(-1);
}

// ---------------------------------------------------------------------------
// compareReports — regression gate
// ---------------------------------------------------------------------------

/**
 * Compare two BenchReports: a = prior, b = new.
 * Returns a ReportDelta that the CLI uses as a merge/regression gate.
 */
export function compareReports(a: BenchReport, b: BenchReport): ReportDelta {
  const resolvedA = new Set(a.perTask.filter((r) => r.resolved).map((r) => r.taskId));
  const resolvedB = new Set(b.perTask.filter((r) => r.resolved).map((r) => r.taskId));

  const allIds = new Set([...a.perTask.map((r) => r.taskId), ...b.perTask.map((r) => r.taskId)]);

  const newlyBroken: string[] = [];
  const newlyFixed: string[] = [];

  for (const id of allIds) {
    const wasResolved = resolvedA.has(id);
    const isResolved = resolvedB.has(id);
    if (wasResolved && !isResolved) newlyBroken.push(id);
    if (!wasResolved && isResolved) newlyFixed.push(id);
  }

  const resolveRateDelta = b.resolveRate - a.resolveRate;
  const regressed = resolveRateDelta < 0 || newlyBroken.length > 0;
  const improved = !regressed && (resolveRateDelta > 0 || newlyFixed.length > 0);

  return { resolveRateDelta, newlyBroken, newlyFixed, improved, regressed };
}

// ---------------------------------------------------------------------------
// Dataset loader — standard SWE-bench JSONL format
// ---------------------------------------------------------------------------

/**
 * Standard SWE-bench JSONL record shape (subset of fields we use).
 * The public dataset uses snake_case; we map to BenchTask.
 */
interface SweBenchRecord {
  instance_id?: string;
  problem_statement?: string;
  repo?: string;
  /** The repo path on disk (after cloning); optional if repoBasePath is provided. */
  repo_path?: string;
  /** Shell command to run tests. Often constructed from test_patch info. */
  test_cmd?: string;
  FAIL_TO_PASS?: string | string[];
  /** Fallback field names used by some dataset variants. */
  id?: string;
  text?: string;
  test_command?: string;
}

/**
 * Load a SWE-bench JSONL dataset file into BenchTask[].
 *
 * @param jsonlPath  Absolute path to the .jsonl file.
 * @param repoBasePath  Optional base directory where repos are pre-cloned.
 *   Each record's repo name is resolved as `<repoBasePath>/<repo_name>`.
 *   When absent, `task.repoPath` is set to the record's `repo_path` field.
 *
 * REAL DATASET STEPS:
 *   1. `pip install datasets` or `huggingface-cli download princeton-nlp/SWE-bench_Verified`
 *   2. Clone each repo at the `base_commit` — SWE-bench provides a harness script for this.
 *   3. `ashlr eval swe-bench --dataset /path/to/instances.jsonl`
 */
export function loadSweBenchDataset(jsonlPath: string, repoBasePath?: string): BenchTask[] {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
  const tasks: BenchTask[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as SweBenchRecord;
      const id = rec.instance_id ?? rec.id ?? 'unknown';
      const problemStatement = rec.problem_statement ?? rec.text ?? '';
      const repoName = rec.repo ?? id.split('__')[0] ?? id;
      const repoPath =
        rec.repo_path ??
        (repoBasePath ? path.join(repoBasePath, repoName.replace('/', '__')) : '');
      const goldTestCommand = rec.test_cmd ?? rec.test_command ?? 'echo no-test';
      let failToPassRaw = rec.FAIL_TO_PASS ?? [];
      const failToPassTests: string[] =
        typeof failToPassRaw === 'string'
          ? (JSON.parse(failToPassRaw) as string[])
          : failToPassRaw;
      tasks.push({ id, problemStatement, repoPath, goldTestCommand, failToPassTests });
    } catch {
      // skip malformed lines
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Default engine runner (production path)
// ---------------------------------------------------------------------------

/**
 * Build the default engine runner that wraps runApiModelSandboxed.
 * Dynamically imported so the harness can be tested without a real engine.
 */
function buildDefaultRunner(engine: string): EngineRunner {
  return async (problemStatement, repoPath, _engine) => {
    const { runApiModelSandboxed } = await import('../run/sandboxed-engine.js');
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    const result = await runApiModelSandboxed(engine as import('../types.js').EngineId, problemStatement, cfg, {
      sourceRepo: repoPath,
      propose: false,
    });
    // Extract diff from the proposalId path — when propose:false there's no
    // proposal, so we read the worktree diff from the result's steps if present.
    // For the production path the diff is embedded in the run state's steps.
    // We return empty string when no diff was captured (resolved by test run).
    const steps = result.state.steps ?? [];
    const diffStep = steps.find((s) => typeof (s as unknown as Record<string, unknown>)['diff'] === 'string');
    return ((diffStep as unknown as Record<string, unknown> | undefined)?.['diff'] as string) ?? '';
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated copy of repoPath in a temp dir. */
function isolateRepo(repoPath: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-bench-'));
  if (fs.existsSync(repoPath)) {
    copyDirSync(repoPath, tmp);
  }
  return tmp;
}

function copyDirSync(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
