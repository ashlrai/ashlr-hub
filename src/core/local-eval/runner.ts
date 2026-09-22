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
 *   3. THE AGENT CANNOT REACH ITS OWN GRADER. The checker is written one level
 *      ABOVE the directory the agent is given, which Claude Code confines its
 *      file tools to.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { classifyTrial } from './classify.js';
import type { TaskSpec, TrialResult, TrialTokens } from './types.js';

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
}

interface ChildOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
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
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
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
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, opts.timeoutMs)
      : null;

    const finish = (status: number | null): void => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
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
  turns: number | null;
  stopReason: string | null;
  terminalReason: string | null;
  isError: boolean;
} {
  const empty: TrialTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return {
      finalMessage: '', tokens: empty, turns: null,
      stopReason: null, terminalReason: null, isError: true,
    };
  }
  const usage = (parsed['usage'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    finalMessage: typeof parsed['result'] === 'string' ? parsed['result'] : '',
    tokens: {
      input: num(usage['input_tokens']),
      output: num(usage['output_tokens']),
      cacheRead: num(usage['cache_read_input_tokens']),
      cacheCreation: num(usage['cache_creation_input_tokens']),
    },
    turns: typeof parsed['num_turns'] === 'number' ? parsed['num_turns'] : null,
    stopReason: str(parsed['stop_reason']),
    terminalReason: str(parsed['terminal_reason']),
    isError: parsed['is_error'] === true,
  };
}

/** Write a task's fixture into `trialDir`, with the checker out of reach. */
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
  const work = await materialise(task, trialDir);
  const before = await snapshot(work);

  const args = [
    '-p', task.prompt,
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

  const started = Date.now();
  const agent = await runChild(opts.agentCli, args, {
    cwd: work,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: opts.baseUrl,
      ANTHROPIC_API_KEY: 'local-eval',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    timeoutMs: opts.timeoutMs,
  });
  const wallMs = Date.now() - started;

  // Kept for forensics: a pass rate you cannot drill into is not evidence.
  await writeFile(join(trialDir, 'agent.stdout.json'), agent.stdout, 'utf8');
  await writeFile(join(trialDir, 'agent.stderr.log'), agent.stderr, 'utf8');

  const parsed = parseAgentResult(agent.stdout);
  const after = await snapshot(work);
  const changedFiles = countChanges(before, after);

  // The check runs from the trial root so `check.mjs` can read ./work, and its
  // status is read from the child — never through a pipe.
  let verifyExit: number | null = null;
  let verifyOutput = '';
  if (!agent.timedOut) {
    // `verify` is a full argv INCLUDING the binary, so the head is the command
    // and the tail is its arguments. Passing the whole array as arguments ran
    // `node node check.mjs`, which fails with MODULE_NOT_FOUND — and scored a
    // flawless answer as `wrong-edit`. A harness bug that only ever moves the
    // pass rate DOWN is the most expensive kind: it looks like a model result.
    const [checkBin, ...checkArgs] = task.verify;
    const check = await runChild(checkBin!, checkArgs, { cwd: trialDir, timeoutMs: 60_000 });
    verifyExit = check.status;
    verifyOutput = check.stdout + check.stderr;
    await writeFile(join(trialDir, 'verify.log'), verifyOutput, 'utf8');
  }

  const verdict = classifyTrial({
    expectation: task.expectation,
    timedOut: agent.timedOut,
    agentExit: agent.status,
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
    agentExit: agent.status,
    verifyExit,
    changedFiles,
    claim: verdict.claim,
    integrity: verdict.integrity,
    turns: parsed.turns,
    note: firstFailLine || (agent.timedOut ? 'killed at the wall-clock budget' : ''),
  };
}
