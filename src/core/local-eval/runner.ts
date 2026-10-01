/**
 * Running one trial, and running a whole set of them.
 *
 * THREE RULES THIS FILE ENFORCES, each learned the hard way here:
 *
 *   1. NEVER PIPE A COMMAND WHOSE STATUS MATTERS. `vitest ... | tail` reports
 *      tail's exit code, and has already made a failing run look green in this
 *      repository. Every child process below is spawned with its output
 *      captured to a buffer and a file, and the status read from the child
 *      itself. Nothing in this harness is piped.
 *   2. EVERY TRIAL IS ISOLATED. Fixtures are rebuilt from source into a fresh
 *      directory per trial, so trial 3 cannot inherit trial 2's half-finished
 *      edit and the order trials run in cannot change the result.
 *   3. THE CHECKER SOURCE IS CAPTURED BEFORE THE AGENT RUNS. Verification
 *      executes that string, never the agent-writable forensic check.mjs copy.
 *      This is grader-file integrity, not an OS sandbox for fixture execution.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { classifyTrial } from './classify.js';
import { diagnoseTimeout, startTrace, type TraceHandle } from './trace.js';
import type { TaskSpec, TimeoutDiagnosis, TrialResult, TrialTokens, TrialTrace, TrialTokenCoverage } from './types.js';

/** Directories that are never part of a fixture's observable state. */
const SNAPSHOT_IGNORE: ReadonlySet<string> = new Set(['.git', 'node_modules', '.claude']);

export interface RunTrialOptions {
  readonly task: TaskSpec;
  readonly trial: number;
  /** Fresh directory for this trial. Created; must not already hold state. */
  readonly trialDir: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly agentCli: string;
  /** Wall-clock budget for the agent turn. */
  readonly timeoutMs: number;
  /**
   * Insert the tracing proxy in front of `baseUrl`. Default on.
   *
   * Off is for proving the instrument innocent: if a result differs with
   * tracing on and off, the instrument is the finding, not the model.
   */
  readonly trace?: boolean;
  /**
   * Text appended to the agent's system prompt (`--append-system-prompt`) —
   * how a harness experiment's `prompts.producer` overlay reaches the agent.
   * Absent or empty = no overlay, byte-identical argv to a plain run.
   */
  readonly appendSystemPrompt?: string;
  /**
   * `--effort` for the agent turn — a harness experiment's `effort.local`.
   * Absent = the CLI's default. Passed with CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
   * so the CLI sends it to a model id it does not recognise (the local model
   * behind the proxy); whether the local runtime honours it is exactly what
   * the experiment measures.
   */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Abort the trial: the agent's whole process group is killed and the trial
   * resolves as a `harness-error` (the caller cancelled it — not a verdict on
   * the model). Used when an experiment is cancelled mid-run.
   */
  readonly signal?: AbortSignal;
}

/** Effort levels `--effort` accepts (ultracode is deliberately excluded: it is not a level). */
const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The agent CLI argv for one trial. Exported so tests can pin it: a harness
 * overlay that silently failed to reach argv would make both arms of an
 * experiment identical and report "no lift" for a change never applied.
 */
export function buildAgentArgs(opts: Pick<RunTrialOptions, 'task' | 'model' | 'appendSystemPrompt' | 'effort'>): string[] {
  const args = [
    '-p', opts.task.prompt,
    // --bare keeps hooks, plugins, CLAUDE.md, auto-memory and keychain reads
    // out of the measurement. Without it the harness would be scoring this
    // machine's configuration as much as the model.
    '--bare',
    '--model', opts.model,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--permission-prompts', 'none',
    '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  if (typeof opts.appendSystemPrompt === 'string' && opts.appendSystemPrompt.length > 0) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }
  if (opts.effort !== undefined) {
    if (!EFFORT_LEVELS.has(opts.effort)) throw new RangeError(`invalid effort level: ${String(opts.effort)}`);
    args.push('--effort', opts.effort);
  }
  return args;
}

interface ChildOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Killed because `signal` aborted. */
  readonly aborted: boolean;
}

/**
 * Spawn a child, capture both streams in full, and return its REAL status.
 *
 * `timeoutMs` is enforced here rather than with the `timeout` binary, which
 * does not exist on this machine — a fact discovered when an invocation exited
 * 127 and would have been read as a model failure by a harness that only
 * checked for "not zero".
 */
function runChild(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /**
     * Called SYNCHRONOUSLY, immediately before the kill signal.
     *
     * This ordering is the whole point. Killing the agent closes its sockets,
     * which makes every in-flight stream look like a client hang-up a
     * millisecond later — destroying the one observation that says whether the
     * model was still producing tokens. The evidence has to be read while the
     * connection is still up.
     */
    onTimeout?: () => void;
    /** Kill the process group when this aborts (checked before spawning too). */
    signal?: AbortSignal;
  },
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout kills the agent's children too rather
      // than orphaning a model request that keeps a runtime slot busy.
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const killGroup = (): void => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { opts.onTimeout?.(); } catch { /* forensics must never block the kill */ }
          killGroup();
        }, opts.timeoutMs)
      : null;

    const finish = (status: number | null): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ status, stdout, stderr, timedOut, aborted });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/** Content hash of every file under `dir`, keyed by relative path. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SNAPSHOT_IGNORE.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const buf = await readFile(full);
        out.set(relative(dir, full), createHash('sha256').update(buf).digest('hex'));
      } catch {
        /* unreadable files are not observable state */
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * How many files differ between two snapshots.
 *
 * Counts additions, deletions and modifications alike. Returning a count rather
 * than a diff is deliberate: `turnIntegrity` wants exactly this number, and it
 * is the one fact that decides whether a completion claim was supported.
 */
export function countChanges(before: Map<string, string>, after: Map<string, string>): number {
  let changed = 0;
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) changed += 1;
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed += 1;
  }
  return changed;
}

/** Pull the fields we report out of the agent CLI's result JSON. */
export function parseAgentResult(stdout: string): {
  finalMessage: string;
  tokens: TrialTokens;
  tokenSource: 'cli-result-v1';
  tokenCoverage: TrialTokenCoverage;
  tokenTotalStatus: 'not-reported' | 'unverified';
  turns: number | null;
  stopReason: string | null;
  terminalReason: string | null;
  isError: boolean;
} {
  const empty: TrialTokens = { input: null, output: null, cacheRead: null, cacheCreation: null };
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid result');
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      finalMessage: '', tokens: empty, tokenSource: 'cli-result-v1',
      tokenCoverage: { input: 'missing', output: 'missing', cacheRead: 'missing', cacheCreation: 'missing' },
      tokenTotalStatus: 'not-reported', turns: null,
      stopReason: null, terminalReason: null, isError: true,
    };
  }
  const rawUsage = parsed['usage'];
  const usage = rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
    ? rawUsage as Record<string, unknown> : {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const keys = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens',
    cacheCreation: 'cache_creation_input_tokens' } as const;
  const tokens = Object.fromEntries(Object.entries(keys).map(([key, field]) => [key, num(usage[field])])) as unknown as TrialTokens;
  const tokenCoverage = Object.fromEntries(Object.entries(keys).map(([key, field]) =>
    [key, !Object.hasOwn(usage, field) ? 'missing' : num(usage[field]) === null ? 'invalid' : 'reported'])) as TrialTokenCoverage;
  // No documented producer contract here defines total_tokens or which cache
  // counters it includes. Ignore it rather than invalidating measured fields
  // with an assumed cross-provider sum. Never synthesize an aggregate total.
  const suppliedTotal = Object.hasOwn(usage, 'total_tokens');
  return {
    finalMessage: typeof parsed['result'] === 'string' ? parsed['result'] : '',
    tokens,
    tokenCoverage,
    tokenTotalStatus: suppliedTotal ? 'unverified' : 'not-reported',
    tokenSource: 'cli-result-v1',
    turns: num(parsed['num_turns']),
    stopReason: str(parsed['stop_reason']),
    terminalReason: str(parsed['terminal_reason']),
    isError: parsed['is_error'] === true,
  };
}

/**
 * Capture the supported checker contract before any agent execution. The source
 * is passed as an argv value, never through a shell or read back from the trial.
 * Current checkers resolve fixture paths from cwd; eval has no check.mjs URL, so
 * file-relative imports/import.meta.url are not part of this checker contract.
 */
export function buildCheckerArgs(task: Pick<TaskSpec, 'check' | 'verify'>): string[] {
  if (!Array.isArray(task.verify) || task.verify.length !== 2 ||
      task.verify[0] !== 'node' || task.verify[1] !== 'check.mjs' || typeof task.check !== 'string') {
    throw new RangeError('Unsupported local-eval checker: expected node check.mjs with source');
  }
  return ['node', '--input-type=module', '--eval', task.check];
}

/** Write a fixture and an agent-writable forensic checker copy, never executed. */
async function materialise(task: TaskSpec, trialDir: string): Promise<string> {
  const work = join(trialDir, 'work');
  await rm(trialDir, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  for (const [path, contents] of Object.entries(task.files)) {
    const target = join(work, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  // Fixtures are ESM. Without this, `import './total.js'` fails for reasons
  // that have nothing to do with the agent under test.
  await writeFile(join(work, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
  await writeFile(join(trialDir, 'check.mjs'), task.check, 'utf8');
  return work;
}

/** Run one task once, end to end, and return a fully classified result. */
export async function runTrial(opts: RunTrialOptions): Promise<TrialResult> {
  const { task, trialDir } = opts;
  const [checkBin, ...checkArgs] = buildCheckerArgs(task);
  const work = await materialise(task, trialDir);
  const before = await snapshot(work);

  const args = buildAgentArgs(opts);

  // The agent talks to the tracer, and the tracer talks to whatever the run was
  // pointed at. A trial that produces no result JSON is otherwise a black box:
  // the CLI emits its usage and turn count once, at the end, so a kill at the
  // budget leaves usage unknown, even when work happened.
  //
  // The tracer is an OBSERVER, so failing to start one must not fail the trial
  // it was only watching. A benchmark that dies because its instrument could
  // not bind a port has turned the instrument into the experiment.
  let trace: TraceHandle | null = null;
  if (opts.trace !== false) {
    try {
      trace = await startTrace({ upstream: opts.baseUrl, captureDir: join(trialDir, 'wire') });
    } catch {
      trace = null;
    }
  }
  const agentBaseUrl = trace?.baseUrl ?? opts.baseUrl;

  // Read at the kill, not after it: see `onTimeout`.
  let traceAtTimeout: TrialTrace | null = null;

  const started = Date.now();
  let agent: ChildOutcome;
  try {
    agent = await runChild(opts.agentCli, args, {
      cwd: work,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: agentBaseUrl,
        ANTHROPIC_API_KEY: 'local-eval',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(opts.effort !== undefined ? { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1' } : {}),
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onTimeout: () => { traceAtTimeout = trace?.snapshot() ?? null; },
    });
  } finally {
    await trace?.close().catch(() => undefined);
  }
  const wallMs = Date.now() - started;

  const finalTrace: TrialTrace | null = traceAtTimeout ?? trace?.snapshot() ?? null;
  const timeoutDiagnosis: TimeoutDiagnosis | null =
    agent.timedOut && finalTrace ? diagnoseTimeout(finalTrace) : null;
  if (finalTrace) {
    await writeFile(join(trialDir, 'wire.summary.json'),
      JSON.stringify({ trace: finalTrace, timeoutDiagnosis }, null, 2), 'utf8');
  }

  // Kept for forensics: a pass rate you cannot drill into is not evidence.
  await writeFile(join(trialDir, 'agent.stdout.json'), agent.stdout, 'utf8');
  await writeFile(join(trialDir, 'agent.stderr.log'), agent.stderr, 'utf8');

  const parsed = parseAgentResult(agent.stdout);
  const after = await snapshot(work);
  const changedFiles = countChanges(before, after);

  // Trusted captured source runs from the trial root so cwd-relative ./work
  // paths retain their meaning. No post-agent checker-file read or shell eval.
  // The node binary/environment and imported fixture code remain host execution;
  // this does not isolate a malicious same-user process or authenticate results.
  let verifyExit: number | null = null;
  let verifyOutput = '';
  if (!agent.timedOut && !agent.aborted) {
    const check = await runChild(checkBin!, checkArgs, { cwd: trialDir, timeoutMs: 60_000 });
    verifyExit = check.status;
    verifyOutput = check.stdout + check.stderr;
    await writeFile(join(trialDir, 'verify.log'), verifyOutput, 'utf8');
  }

  const verdict = classifyTrial({
    expectation: task.expectation,
    timedOut: agent.timedOut,
    // An aborted trial never finished: forced to a harness-error (a null exit
    // with no result JSON), never scored as the model's pass or fail.
    agentExit: agent.aborted ? null : agent.status,
    agentReportedError: parsed.isError,
    stopReason: parsed.stopReason,
    terminalReason: parsed.terminalReason,
    finalMessage: parsed.finalMessage,
    changedFiles,
    verifyExit,
    diagnostics: `${agent.stderr}\n${verifyOutput}`,
  });

  const firstFailLine = verifyOutput.split('\n').find((l) => l.startsWith('FAIL:')) ?? '';
  return {
    taskId: task.id,
    trial: opts.trial,
    mode: verdict.mode,
    passed: verdict.passed,
    wallMs,
    tokens: parsed.tokens,
    tokenSource: parsed.tokenSource,
    tokenCoverage: parsed.tokenCoverage,
    tokenTotalStatus: parsed.tokenTotalStatus,
    agentExit: agent.status,
    verifyExit,
    changedFiles,
    claim: verdict.claim,
    integrity: verdict.integrity,
    turns: parsed.turns,
    // A timeout's note is its diagnosis. "killed at the wall-clock budget"
    // restates the classification and explains nothing; the whole reason the
    // tracer exists is so this line names a thing to go and fix.
    note: (agent.aborted ? 'aborted by the caller before the trial finished' : '')
      || firstFailLine
      || (agent.timedOut
        ? (timeoutDiagnosis ? `${timeoutDiagnosis.kind}: ${timeoutDiagnosis.detail}` : 'killed at the wall-clock budget (untraced)')
        : ''),
    timeoutDiagnosis,
    trace: finalTrace,
  };
}
