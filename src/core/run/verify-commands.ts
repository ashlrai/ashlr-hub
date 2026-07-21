/**
 * M43: Structured verification primitives — detect & run typecheck/lint/build/test.
 *
 * The hub runs local-model tasks (`runTask`). After a task completes, M43 runs a
 * STRUCTURED verification (typecheck/lint/build/test). This module provides the two
 * low-level halves the orchestrator's repair loop wires together:
 *
 *   detectVerifyCommands() — READ-ONLY introspection of a workspace to decide
 *     which verification commands exist (never installs, never mutates).
 *   runVerifyCommand()     — runs ONE detected command in the workspace with a
 *     hard timeout and arg arrays only; captures + scrubs + caps output. Uses a
 *     shell ONLY on Windows so PATHEXT can resolve npm.cmd/npx.cmd shims.
 *
 * Rules (mirroring git.ts):
 *   - Node builtins only; zero third-party deps.
 *   - Subprocesses run via ARG ARRAYS, NO shell except Windows package-manager
 *     shims, and a tight timeout so a hung verify can never block forever.
 *   - runVerifyCommand/runVerifyCommandAsync never throw — any failure resolves
 *     to { ok:false } with the error captured in `output`.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AshlrConfig } from '../types.js';
import { renderToolText } from '../mcp-native.js';
import { audit } from '../sandbox/audit.js';
import { detectRepoExecutionProfile, verifyExecutablePathError } from './repo-profile.js';
import { buildToolPath } from './tool-path.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Hard ceiling on the per-command timeout (ms). */
const MAX_TIMEOUT_MS = 600_000;

/** Extra grace for the wrapper itself after it asks the child tree to exit. */
const WRAPPER_TIMEOUT_GRACE_MS = 10_000;

/** Graceful cancellation/timeout window before escalating the owned group. */
const ASYNC_TERMINATION_GRACE_MS = 5_000;

/** Final bounded window for close events and pipe data after SIGKILL. */
const ASYNC_TERMINATION_DRAIN_MS = 150;

/** Prefix for per-command HOME directories used by verification subprocesses. */
const VERIFY_HOME_PREFIX = 'ashlr-verify-home-';

/** Per-stream async capture cap before the final renderToolText 32KB cap. */
const ASYNC_STREAM_CAPTURE_CHARS = 28 * 1024;
const ASYNC_STREAM_HEAD_CHARS = 20 * 1024;
const ASYNC_STREAM_TAIL_CHARS = 6 * 1024;
const ASYNC_STREAM_TRUNCATION_MARK = '\n[ashlr: verify output stream truncated]\n';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single verification command to run, classified by what it checks. */
export type VerifyCommandKind = 'typecheck' | 'lint' | 'build' | 'test';
export type VerifyCommandProfile = 'quick' | 'merge' | 'deep';

export interface VerifyCommand {
  /** Stable identifier when declared by ashlr.verify.json. */
  id?: string;
  kind: VerifyCommandKind;
  /** Exact argv (executable + args). NEVER passed through a shell. */
  cmd: string[];
  /** Optional project root to run from when the repo has nested packages. */
  cwd?: string;
  /** Optional per-command timeout declared by a repo verification contract. */
  timeoutMs?: number;
  /** Whether the command is required for its declared verification profile. */
  required?: boolean;
  /** Verification profiles this command participates in. */
  profiles?: VerifyCommandProfile[];
}

export type VerifyFailureCategory =
  | 'code'
  | 'tool'
  | 'timeout'
  | 'infra'
  | 'cancelled'
  | 'invalid-command';

/** Outcome of running one VerifyCommand. */
export interface VerifyCommandResult {
  ok: boolean;
  /** Human-readable command (the argv joined) for logs / verdicts. */
  command: string;
  exitCode: number;
  /** Combined stdout+stderr, secret-scrubbed and size-capped (≤32KB). */
  output: string;
  timedOut: boolean;
  /** True only when the invocation owner requested cancellation. */
  cancelled?: boolean;
  /** Present only for non-OK results; lets autonomous repair loops avoid infra false positives. */
  failureCategory?: VerifyFailureCategory;
}

export interface VerifySubprocessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Final argv containment check performed in this function immediately before spawn. */
  verifyBoundary?: { repoRoot: string; executable: string };
  /** Windows package-manager shims only; ignored on POSIX. */
  windowsShell?: boolean;
  signal?: AbortSignal;
  /** Hermetic ownership-test seams; production callers leave these unset. */
  _platform?: NodeJS.Platform;
  _spawn?: typeof spawn;
  _processKill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  _terminationGraceMs?: number;
  _terminationDrainMs?: number;
}

export interface VerifySubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

export interface RunVerifyCommandAsyncOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createBoundedStreamCapture(): { append: (chunk: unknown) => void; text: () => string } {
  let head = '';
  let tail = '';
  let truncated = false;

  return {
    append(chunk: unknown): void {
      const text = String(chunk);
      if (text.length === 0) return;

      if (!truncated) {
        const combined = head + text;
        if (combined.length <= ASYNC_STREAM_CAPTURE_CHARS) {
          head = combined;
          return;
        }

        truncated = true;
        head = combined.slice(0, ASYNC_STREAM_HEAD_CHARS);
        tail = combined.slice(-ASYNC_STREAM_TAIL_CHARS);
        return;
      }

      tail = (tail + text).slice(-ASYNC_STREAM_TAIL_CHARS);
    },

    text(): string {
      if (!truncated) return head;
      return `${head}${ASYNC_STREAM_TRUNCATION_MARK}${tail}`;
    },
  };
}

function verifyFailureCategory(
  output: string,
  opts: { exitCode: number; timedOut: boolean; error?: Error },
): VerifyFailureCategory {
  if (opts.timedOut || opts.exitCode === 124) return 'timeout';
  if (
    /\b(usage: run-verify-command|invalid argv|empty argv)\b/i.test(output)
  ) return 'invalid-command';

  const errorCode = (opts.error as NodeJS.ErrnoException | undefined)?.code;
  if (
    errorCode === 'ENOENT' ||
    opts.exitCode === 127 ||
    /\b(ENOENT|command not found|not recognized as an internal|not recognized as a command)\b/i.test(output) ||
    /\[verify-runner\] failed to start\b/i.test(output)
  ) return 'tool';

  if (opts.error) return 'infra';
  return 'code';
}

// ---------------------------------------------------------------------------
// Public: detectVerifyCommands
// ---------------------------------------------------------------------------

/**
 * READ-ONLY detection of the verification commands available in `workspaceRoot`.
 * Never installs, never spawns — purely inspects package.json + config files.
 *
 * Preference order per kind:
 *   typecheck: package.json `typecheck` script → else `tsc --noEmit` when a
 *              tsconfig.json exists.
 *   test:      package.json `test` script → else `vitest run` when vitest is a
 *              dep or a vitest.config.* exists.
 *   lint:      package.json `lint` script (no fallback).
 *
 * Scripts run through the detected package manager (`<pm> run <script>`);
 * fallbacks run through `npx`. Returns [] when nothing is detected — the caller
 * treats an empty list as a no-op.
 */
export function filterVerifyCommandsForProfile(
  commands: VerifyCommand[],
  profile: VerifyCommandProfile,
): VerifyCommand[] {
  return commands.filter(
    (command) => !command.profiles || command.profiles.includes(profile),
  );
}

export function detectVerifyCommands(
  workspaceRoot: string,
  profile?: VerifyCommandProfile,
): VerifyCommand[] {
  const commands = detectRepoExecutionProfile(workspaceRoot).verifyCommands;
  return profile ? filterVerifyCommandsForProfile(commands, profile) : commands;
}

// ---------------------------------------------------------------------------
// Public: spawnOptionsFor
// ---------------------------------------------------------------------------

/**
 * Build the spawnSync options for a verify command, made cross-platform.
 *
 * On Windows the package-manager runners we spawn (`npm`, `npx`, `pnpm`,
 * `yarn`, `bun`) are not real executables but `.cmd`/`.ps1` shims on PATH.
 * `spawnSync` does NOT consult PATHEXT, so `spawnSync('npm', …)` fails with
 * ENOENT and the command silently does nothing. Running through the shell
 * (`shell: true`) lets the OS resolve `npm.cmd`/`npx.cmd` etc. via PATHEXT.
 *
 * We only enable the shell for those shim binaries: routing real executables
 * (node/git/tsc) through cmd.exe would mangle argv that contains spaces, quotes
 * or `;` (e.g. `node -e 'a(); b()'`), since spawnSync does NOT quote argv array
 * elements under shell:true. `windowsHide` keeps a console window from flashing.
 *
 * `bin` + `platform` are injected so this can be unit-tested without switching
 * the host OS.
 */
const WINDOWS_SHIM_BINS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx']);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function verifyRunnerPath(): string | null {
  const p = resolve(MODULE_DIR, '../../../scripts/run-verify-command.mjs');
  return existsSync(p) ? p : null;
}

function commandRootFor(vc: VerifyCommand, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot);
  const cwd = vc.cwd ? resolve(root, vc.cwd) : root;
  const rel = relative(root, cwd);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return null;
  try {
    if (!statSync(cwd).isDirectory()) return null;
    const physicalRoot = realpathSync(root);
    const physicalCwd = realpathSync(cwd);
    const physicalRel = relative(physicalRoot, physicalCwd);
    return physicalRel === '' || (!physicalRel.startsWith('..') && !isAbsolute(physicalRel)) ? cwd : null;
  } catch {
    return null;
  }
}

function formatVerifyCommand(vc: VerifyCommand, workspaceRoot: string): string {
  const command = vc.cmd.join(' ');
  const root = resolve(workspaceRoot);
  const cwd = commandRootFor(vc, root);
  if (!cwd) return command;
  // M341b: posix-normalize — 'cd apps/web' works in sh AND cmd.exe, while a
  // native '\' sep leaks platform-specific strings into ledgers/logs.
  const rel = relative(root, cwd).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel)
    ? `(cd ${rel} && ${command})`
    : command;
}

function makeIsolatedVerifyEnv(baseEnv: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), VERIFY_HOME_PREFIX));
  const realHome = baseEnv.HOME ?? baseEnv.USERPROFILE ?? '';
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    ASHLR_HOME: join(home, '.ashlr'),
    ASHLR_REAL_HOME: realHome,
  };
  return {
    env,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; the temp directory lives under the OS temp dir.
      }
    },
  };
}

export function spawnOptionsFor(
  workspaceRoot: string,
  timeout: number,
  bin?: string,
  platform: NodeJS.Platform = process.platform,
  opts?: { extraBinRoots?: string[] },
): SpawnSyncOptionsWithStringEncoding {
  const isWin = platform === 'win32';
  const needsShell = isWin && bin !== undefined && WINDOWS_SHIM_BINS.has(bin);

  // M286 — inject the workspace-local node_modules/.bin into PATH so that
  // commands like `npm run typecheck` (which resolves to `tsc --noEmit`) and
  // `npx tsc` can find the local tsc/vitest binaries even when the workspace
  // is a git worktree that has a SYMLINKED node_modules pointing to the source
  // repo's real install. Without this, spawnSync inherits the parent PATH which
  // may not include the local .bin, causing "tsc: command not found".
  //
  // Rules:
  //  - Only prepend when the .bin dir actually exists (no-op for repos without
  //    a local install — the command will fail gracefully as before).
  //  - Use resolve() to normalise the path (handles symlinks transparently).
  //  - Never set env to undefined — always carry the full parent environment so
  //    NODE_PATH, HOME, etc. are inherited.
  const binRoots = [
    workspaceRoot,
    ...(opts?.extraBinRoots ?? []),
  ].map((root) => resolve(root, 'node_modules', '.bin'));
  const localBins = [...new Set(binRoots)].filter((binRoot) => existsSync(binRoot));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: buildToolPath({
      // Keep package-manager shims on the Node runtime that launched Ashlr.
      // Isolating HOME must not promote an unrelated system Node ahead of it.
      prepend: [...localBins, dirname(process.execPath)],
      // M341b: explicit for BOTH branches — 'undefined' fell back to the
      // HOST delimiter, so simulating linux on a win32 host joined with ';'.
      separator: isWin ? ';' : ':',
    }),
  };

  return {
    cwd: workspaceRoot,
    timeout,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: needsShell, // resolve npm.cmd/npx.cmd etc. via PATHEXT on Windows
    windowsHide: true,
    env,
  };
}

// ---------------------------------------------------------------------------
// Public: runVerifyCommand
// ---------------------------------------------------------------------------

/**
 * Run ONE verification command in `workspaceRoot` (cwd). Arg array, shell only
 * on Windows (see spawnOptionsFor), with a hard timeout (default 120s, capped at
 * 600s). Captures stdout+stderr,
 * scrubs + caps via renderToolText, and audits the outcome.
 *
 * Never throws — a spawn failure or timeout resolves to { ok:false } with the
 * error in `output`.
 */
export function runVerifyCommand(
  vc: VerifyCommand,
  workspaceRoot: string,
  _cfg: AshlrConfig,
  opts?: { timeoutMs?: number },
): VerifyCommandResult {
  const command = formatVerifyCommand(vc, workspaceRoot);
  const commandRoot = commandRootFor(vc, workspaceRoot);
  const timeout = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, opts?.timeoutMs ?? vc.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  const bin = vc.cmd[0];
  if (!bin) {
    const output = renderToolText(`verify command "${vc.kind}" has an empty argv`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: empty argv`,
      result: 'error',
    });
    return {
      ok: false,
      command,
      exitCode: -1,
      output,
      timedOut: false,
      failureCategory: 'invalid-command',
    };
  }
  if (!commandRoot) {
    const output = renderToolText(`${command}\n[verify-runner] command cwd is outside the workspace or unavailable`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → invalid cwd`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'invalid-command' };
  }
  const executableError = verifyExecutablePathError(workspaceRoot, commandRoot, bin);
  if (executableError) {
    const output = renderToolText(`${command}\n[verify-runner] command executable ${executableError}`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → invalid executable`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'invalid-command' };
  }

  try {
    const baseOptions = spawnOptionsFor(commandRoot, timeout, bin, process.platform, {
      extraBinRoots: [workspaceRoot],
    });
    const runner = verifyRunnerPath();
    if (!runner) {
      throw new Error('verification process-tree runner is unavailable');
    }
    const isolated = makeIsolatedVerifyEnv(baseOptions.env ?? process.env);
    const res = (() => {
      try {
        return spawnSync(
          process.execPath,
          [
            runner,
            String(timeout),
            workspaceRoot,
            commandRoot,
            Buffer.from(JSON.stringify(vc.cmd), 'utf8').toString('base64'),
          ],
          {
            cwd: commandRoot,
            timeout: timeout + WRAPPER_TIMEOUT_GRACE_MS,
            stdio: 'pipe',
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            env: {
              ...isolated.env,
              ASHLR_VERIFY_SHELL: baseOptions.shell === true ? '1' : '0',
            },
          },
        );
      } finally {
        isolated.cleanup();
      }
    })();

    const timedOut =
      res.status === 124 ||
      (res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');

    // spawn-level failure (binary not found, timeout, …): res.status is null.
    if (res.error) {
      const output = renderToolText(
        `${command}\n${(res.stdout ?? '')}${res.stderr ?? ''}\n${res.error.message}`,
      );
      const failureCategory = verifyFailureCategory(output, {
        exitCode: -1,
        timedOut,
        error: res.error,
      });
      audit({
        action: 'verify:command',
        repo: workspaceRoot,
        sandboxId: null,
        summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : 'spawn error'}`,
        result: 'error',
      });
      return { ok: false, command, exitCode: -1, output, timedOut, failureCategory };
    }

    const exitCode = res.status ?? -1;
    const ok = exitCode === 0;
    const output = renderToolText(`${(res.stdout ?? '')}${res.stderr ?? ''}`);
    const failureCategory = ok
      ? undefined
      : verifyFailureCategory(output, { exitCode, timedOut });

    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : `exit ${exitCode}`}`,
      result: ok ? 'ok' : 'error',
    });

    return { ok, command, exitCode, output, timedOut, ...(failureCategory ? { failureCategory } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const output = renderToolText(`${command}\n${msg}`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → threw: ${msg}`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'infra' };
  }
}

// ---------------------------------------------------------------------------
// Public: runVerifySubprocessAsync
// ---------------------------------------------------------------------------

/**
 * Run one argv-only subprocess with invocation-local process ownership.
 *
 * POSIX children start as detached process-group leaders. Cancellation targets
 * only that invocation-owned process group; descendants that deliberately leave
 * it with setsid(2) or another detached spawn are outside this ownership scope
 * and are not claimed to be terminated. Once the leader exits, its numeric PGID
 * is no longer a sufficient ownership identity, so delayed probes/escalations
 * fail closed instead of risking a recycled, unrelated group. A signaled Windows
 * invocation also fails closed because Node cannot prove complete tree ownership.
 */
export async function runVerifySubprocessAsync(
  argv: string[],
  opts: VerifySubprocessOptions,
): Promise<VerifySubprocessResult> {
  const emptyResult = (overrides: Partial<VerifySubprocessResult> = {}): VerifySubprocessResult => ({
    stdout: '',
    stderr: '',
    exitCode: -1,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  });

  if (argv.length === 0 || argv.some((arg) => typeof arg !== 'string')) {
    return emptyResult({ error: 'invalid argv: expected a non-empty string array' });
  }
  if (opts.signal?.aborted) {
    return emptyResult({
      stderr: '[verify-runner] cancelled before subprocess start',
      cancelled: true,
    });
  }
  if (opts.verifyBoundary) {
    const boundaryCwd = commandRootFor(
      { kind: 'test', cmd: [opts.verifyBoundary.executable], cwd: opts.cwd },
      opts.verifyBoundary.repoRoot,
    );
    const executableError = boundaryCwd
      ? verifyExecutablePathError(opts.verifyBoundary.repoRoot, boundaryCwd, opts.verifyBoundary.executable)
      : 'command cwd is outside the workspace or unavailable';
    if (executableError) {
      return emptyResult({ error: `[verify-runner] ${executableError}` });
    }
  }

  const platform = opts._platform ?? process.platform;
  if (opts.signal && platform === 'win32') {
    return emptyResult({
      error: 'AbortSignal-owned verification is unsupported on Windows because complete process-tree ownership cannot be guaranteed',
    });
  }

  return await new Promise<VerifySubprocessResult>((resolveDone) => {
    const stdout = createBoundedStreamCapture();
    const stderr = createBoundedStreamCapture();
    const processKill = opts._processKill ?? ((pid: number, signal: NodeJS.Signals | 0) => {
      process.kill(pid, signal);
    });
    const spawnImpl = opts._spawn ?? spawn;
    const ownsProcessGroup = platform !== 'win32';
    let settled = false;
    let childClosed = false;
    let leaderExited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let terminationReason: 'cancelled' | 'timeout' | null = null;
    let terminationRequested = false;
    let hardKillSent = false;
    let authorityFailure: string | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: platform === 'win32' && opts.windowsShell === true,
        windowsHide: true,
        ...(ownsProcessGroup ? { detached: true } : {}),
      });
    } catch (err) {
      resolveDone(emptyResult({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // detached:true makes this invocation's PID its PGID while the leader is
    // alive. Never derive or signal any broader group (including the daemon's).
    let ownedPgid = ownsProcessGroup && typeof child.pid === 'number' && child.pid > 0
      ? child.pid
      : null;

    function captured(): Pick<VerifySubprocessResult, 'stdout' | 'stderr'> {
      return { stdout: stdout.text(), stderr: stderr.text() };
    }

    function releaseProcessResources(): void {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      child.on('error', () => { /* ignore events after bounded settlement */ });
      child.unref();
    }

    function settle(result: VerifySubprocessResult): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (escalationTimer !== null) clearTimeout(escalationTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      releaseProcessResources();
      resolveDone(result);
    }

    function processSignalError(err: unknown, operation: string): 'absent' | 'failed' {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code ?? '')
        : '';
      if (code === 'ESRCH') {
        ownedPgid = null;
        return 'absent';
      }
      authorityFailure = `${operation} failed${code ? ` (${code})` : ''}: ${err instanceof Error ? err.message : String(err)}`;
      return 'failed';
    }

    function signalOwnedGroup(signal: NodeJS.Signals): 'sent' | 'absent' | 'failed' {
      if (ownedPgid === null) return 'absent';
      if (leaderExited) {
        authorityFailure = 'process-group ownership identity lost after leader exit; refusing delayed signal';
        ownedPgid = null;
        return 'failed';
      }
      try {
        processKill(-ownedPgid, signal);
        return 'sent';
      } catch (err) {
        return processSignalError(err, `${signal} process-group signal`);
      }
    }

    function probeOwnedGroup(): 'present' | 'absent' | 'failed' {
      if (ownedPgid === null) return 'absent';
      if (leaderExited) {
        authorityFailure = 'process-group ownership identity lost after leader exit; refusing delayed probe';
        ownedPgid = null;
        return 'failed';
      }
      try {
        processKill(-ownedPgid, 0);
        return 'present';
      } catch (err) {
        return processSignalError(err, 'process-group exit probe');
      }
    }

    function settleTermination(): void {
      const output = captured();

      if (authorityFailure) {
        settle(emptyResult({
          ...output,
          exitCode: exitCode ?? -1,
          signal: exitSignal,
          timedOut: terminationReason === 'timeout',
          error: `termination authority lost: ${authorityFailure ?? 'process-group state could not be authenticated'}`,
        }));
        return;
      }
      // SIGKILL was delivered while the original leader still authenticated
      // the PGID. An escaped setsid/detached descendant is out of scope and may
      // still hold a copied pipe; bounded resource release below does not claim
      // that such an escaped process was terminated.
      if (ownsProcessGroup && leaderExited && hardKillSent) {
        if (terminationReason === 'cancelled') {
          settle(emptyResult({ ...output, signal: exitSignal, cancelled: true }));
          return;
        }
        settle(emptyResult({ ...output, exitCode: 124, signal: exitSignal, timedOut: true }));
        return;
      }

      const groupState = ownsProcessGroup
        ? probeOwnedGroup()
        : (childClosed ? 'absent' : 'present');
      if (groupState === 'failed') {
        settle(emptyResult({
          ...output,
          exitCode: exitCode ?? -1,
          signal: exitSignal,
          timedOut: terminationReason === 'timeout',
          error: `termination authority lost: ${authorityFailure ?? 'process-group state could not be authenticated'}`,
        }));
        return;
      }
      if (groupState === 'present') {
        settle(emptyResult({
          ...output,
          exitCode: exitCode ?? -1,
          signal: exitSignal,
          timedOut: terminationReason === 'timeout',
          error: 'termination deadline elapsed with process-group exit unconfirmed',
        }));
        return;
      }
      if (terminationReason === 'cancelled') {
        settle(emptyResult({ ...output, signal: exitSignal, cancelled: true }));
        return;
      }
      if (terminationReason === 'timeout') {
        settle(emptyResult({ ...output, exitCode: 124, signal: exitSignal, timedOut: true }));
        return;
      }
      settle(emptyResult({ ...output, exitCode: exitCode ?? -1, signal: exitSignal }));
    }

    function beginTerminationDrain(): void {
      if (settled || drainTimer !== null) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        settleTermination();
      }, opts._terminationDrainMs ?? ASYNC_TERMINATION_DRAIN_MS);
      // Deliberately referenced: this is the final ownership deadline.
    }

    function requestTermination(reason: 'cancelled' | 'timeout'): void {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      stderr.append(
        reason === 'cancelled'
          ? '\n[verify-runner] cancelled by invocation owner; terminating process group'
          : `\n[verify-runner] timed out after ${opts.timeoutMs}ms; terminating process group`,
      );

      if (ownsProcessGroup) {
        if (leaderExited) {
          authorityFailure = 'process-group ownership identity lost after leader exit; refusing termination signal';
          ownedPgid = null;
          beginTerminationDrain();
          return;
        }
        const firstSignal: NodeJS.Signals = reason === 'cancelled' ? 'SIGINT' : 'SIGTERM';
        const firstResult = signalOwnedGroup(firstSignal);
        if (firstResult !== 'sent') {
          beginTerminationDrain();
          return;
        }
      } else {
        try {
          child.kill(reason === 'cancelled' ? 'SIGINT' : 'SIGTERM');
        } catch (err) {
          authorityFailure = `child termination failed: ${err instanceof Error ? err.message : String(err)}`;
          beginTerminationDrain();
          return;
        }
      }

      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        if (ownsProcessGroup) {
          hardKillSent = signalOwnedGroup('SIGKILL') === 'sent';
        } else {
          try {
            hardKillSent = child.kill('SIGKILL');
          } catch (err) {
            authorityFailure = `SIGKILL child termination failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        beginTerminationDrain();
      }, opts._terminationGraceMs ?? ASYNC_TERMINATION_GRACE_MS);
      // Deliberately referenced so graceful termination always escalates.
    }

    function onAbort(): void {
      requestTermination('cancelled');
    }

    child.stdout?.on('data', (chunk) => { stdout.append(chunk); });
    child.stderr?.on('data', (chunk) => { stderr.append(chunk); });

    child.on('error', (err) => {
      if (terminationRequested) {
        if (!authorityFailure) authorityFailure = `subprocess error during termination: ${err.message}`;
        beginTerminationDrain();
        return;
      }
      settle(emptyResult({ ...captured(), error: err.message }));
    });

    child.on('exit', (code, signal) => {
      leaderExited = true;
      exitCode = code;
      exitSignal = signal;
      if (!terminationRequested || hardKillSent) {
        ownedPgid = null;
        return;
      }

      // The leader PID can be recycled after this event. Without a separate
      // kernel-backed identity, retaining its numeric PGID for a later SIGKILL
      // could target an unrelated group. Revoke it and fail closed.
      if (escalationTimer !== null) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      authorityFailure = 'process-group ownership identity lost after leader exit before escalation';
      ownedPgid = null;
      beginTerminationDrain();
    });

    child.on('close', (code, signal) => {
      childClosed = true;
      exitCode = code;
      exitSignal = signal;

      if (terminationRequested) {
        if (leaderExited) {
          settleTermination();
          return;
        }
        beginTerminationDrain();
        return;
      }

      ownedPgid = null;
      settle(emptyResult({
        ...captured(),
        exitCode: code ?? (signal ? 1 : -1),
        signal,
      }));
    });

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    timeoutTimer = setTimeout(() => requestTermination('timeout'), opts.timeoutMs);
    timeoutTimer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Public: runVerifyCommandAsync
// ---------------------------------------------------------------------------

/**
 * Async twin of runVerifyCommand().
 *
 * It preserves the isolated HOME, timeout, output, and audit contract, but
 * waits without blocking Node's event loop. With a signal, the caller owns the
 * invocation through runVerifySubprocessAsync's bounded process-group teardown.
 */
export async function runVerifyCommandAsync(
  vc: VerifyCommand,
  workspaceRoot: string,
  _cfg: AshlrConfig,
  opts?: RunVerifyCommandAsyncOptions,
): Promise<VerifyCommandResult> {
  const command = formatVerifyCommand(vc, workspaceRoot);
  const commandRoot = commandRootFor(vc, workspaceRoot);
  const timeout = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, opts?.timeoutMs ?? vc.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  const bin = vc.cmd[0];
  if (!bin) {
    const output = renderToolText(`verify command "${vc.kind}" has an empty argv`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: empty argv`,
      result: 'error',
    });
    return {
      ok: false,
      command,
      exitCode: -1,
      output,
      timedOut: false,
      failureCategory: 'invalid-command',
    };
  }
  if (!commandRoot) {
    const output = renderToolText(`${command}\n[verify-runner] command cwd is outside the workspace or unavailable`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → invalid cwd`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'invalid-command' };
  }
  const executableError = verifyExecutablePathError(workspaceRoot, commandRoot, bin);
  if (executableError) {
    const output = renderToolText(`${command}\n[verify-runner] command executable ${executableError}`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → invalid executable`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'invalid-command' };
  }

  if (opts?.signal?.aborted) {
    const output = renderToolText(`${command}\n[verify-runner] cancelled before subprocess start`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → cancelled before start`,
      result: 'error',
    });
    return {
      ok: false,
      command,
      exitCode: -1,
      output,
      timedOut: false,
      cancelled: true,
      failureCategory: 'cancelled',
    };
  }

  let isolated: { env: NodeJS.ProcessEnv; cleanup: () => void } | null = null;
  try {
    const baseOptions = spawnOptionsFor(commandRoot, timeout, bin, process.platform, {
      extraBinRoots: [workspaceRoot],
    });
    const runner = verifyRunnerPath();
    isolated = makeIsolatedVerifyEnv(baseOptions.env ?? process.env);
    const useWindowsWrapper = process.platform === 'win32';
    if (useWindowsWrapper && !runner) {
      throw new Error('verification process-tree runner is unavailable on Windows');
    }
    const argv = useWindowsWrapper
      ? [
          process.execPath,
          runner!,
          String(timeout),
          workspaceRoot,
          commandRoot,
          Buffer.from(JSON.stringify(vc.cmd), 'utf8').toString('base64'),
        ]
      : vc.cmd;
    const subprocess = await runVerifySubprocessAsync(argv, {
      cwd: commandRoot,
      env: useWindowsWrapper
        ? {
            ...isolated.env,
            ASHLR_VERIFY_SHELL: baseOptions.shell === true ? '1' : '0',
          }
        : isolated.env,
      timeoutMs: useWindowsWrapper ? timeout + WRAPPER_TIMEOUT_GRACE_MS : timeout,
      windowsShell: useWindowsWrapper ? false : baseOptions.shell === true,
      verifyBoundary: { repoRoot: workspaceRoot, executable: bin },
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    isolated.cleanup();
    isolated = null;

    const timedOut = subprocess.timedOut || subprocess.exitCode === 124;
    const capturedOutput = `${subprocess.stdout}${subprocess.stderr}`;
    if (subprocess.cancelled) {
      const output = renderToolText(capturedOutput);
      audit({
        action: 'verify:command',
        repo: workspaceRoot,
        sandboxId: null,
        summary: `${vc.kind}: ${command} → cancelled`,
        result: 'error',
      });
      return {
        ok: false,
        command,
        exitCode: -1,
        output,
        timedOut: false,
        cancelled: true,
        failureCategory: 'cancelled',
      };
    }

    if (subprocess.error) {
      const output = renderToolText(`${command}\n${capturedOutput}\n${subprocess.error}`);
      const failureCategory = verifyFailureCategory(output, {
        exitCode: subprocess.exitCode,
        timedOut,
        error: new Error(subprocess.error),
      });
      audit({
        action: 'verify:command',
        repo: workspaceRoot,
        sandboxId: null,
        summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : 'subprocess error'}`,
        result: 'error',
      });
      return {
        ok: false,
        command,
        exitCode: subprocess.exitCode,
        output,
        timedOut,
        failureCategory,
      };
    }

    const exitCode = subprocess.exitCode;
    const ok = exitCode === 0 && !timedOut;
    const output = renderToolText(capturedOutput);
    const failureCategory = ok
      ? undefined
      : verifyFailureCategory(output, { exitCode, timedOut });

    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : `exit ${exitCode}`}`,
      result: ok ? 'ok' : 'error',
    });

    return {
      ok,
      command,
      exitCode,
      output,
      timedOut,
      ...(failureCategory ? { failureCategory } : {}),
    };
  } catch (err) {
    isolated?.cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    const output = renderToolText(`${command}\n${msg}`);
    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → threw: ${msg}`,
      result: 'error',
    });
    return { ok: false, command, exitCode: -1, output, timedOut: false, failureCategory: 'infra' };
  }
}
