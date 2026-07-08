/**
 * M43: Structured verification primitives — detect & run typecheck/test/lint.
 *
 * The hub runs local-model tasks (`runTask`). After a task completes, M43 runs a
 * STRUCTURED verification (typecheck/test/lint). This module provides the two
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AshlrConfig } from '../types.js';
import { renderToolText } from '../mcp-native.js';
import { audit } from '../sandbox/audit.js';
import { detectRepoExecutionProfile } from './repo-profile.js';
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
export interface VerifyCommand {
  kind: 'typecheck' | 'test' | 'lint';
  /** Exact argv (executable + args). NEVER passed through a shell. */
  cmd: string[];
  /** Optional project root to run from when the repo has nested packages. */
  cwd?: string;
}

export type VerifyFailureCategory =
  | 'code'
  | 'tool'
  | 'timeout'
  | 'infra'
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
  /** Present only for non-OK results; lets autonomous repair loops avoid infra false positives. */
  failureCategory?: VerifyFailureCategory;
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
export function detectVerifyCommands(workspaceRoot: string): VerifyCommand[] {
  return detectRepoExecutionProfile(workspaceRoot).verifyCommands;
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

function commandRootFor(vc: VerifyCommand, workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  if (!vc.cwd) return root;
  const cwd = resolve(root, vc.cwd);
  const rel = relative(root, cwd);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return cwd;
  return root;
}

function formatVerifyCommand(vc: VerifyCommand, workspaceRoot: string): string {
  const command = vc.cmd.join(' ');
  const root = resolve(workspaceRoot);
  const cwd = commandRootFor(vc, root);
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
      prepend: localBins,
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
    Math.max(1, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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

  try {
    const baseOptions = spawnOptionsFor(commandRoot, timeout, bin, process.platform, {
      extraBinRoots: [workspaceRoot],
    });
    const runner = verifyRunnerPath();
    const isolated = makeIsolatedVerifyEnv(baseOptions.env ?? process.env);
    const res = (() => {
      try {
        return runner
          ? spawnSync(
              process.execPath,
              [
                runner,
                String(timeout),
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
            )
          : spawnSync(bin, vc.cmd.slice(1), {
              ...baseOptions,
              env: isolated.env,
            });
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
// Public: runVerifyCommandAsync
// ---------------------------------------------------------------------------

/**
 * Async twin of runVerifyCommand().
 *
 * It preserves the same wrapper, isolated HOME, timeout, output, and audit
 * contract, but waits without blocking Node's event loop. Daemon callers should
 * prefer this path so lock heartbeats, shared-queue lease renewal, and status
 * polling can continue during long repo verification.
 */
export async function runVerifyCommandAsync(
  vc: VerifyCommand,
  workspaceRoot: string,
  _cfg: AshlrConfig,
  opts?: { timeoutMs?: number },
): Promise<VerifyCommandResult> {
  const command = formatVerifyCommand(vc, workspaceRoot);
  const commandRoot = commandRootFor(vc, workspaceRoot);
  const timeout = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
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

  let isolated: { env: NodeJS.ProcessEnv; cleanup: () => void } | null = null;
  try {
    const baseOptions = spawnOptionsFor(commandRoot, timeout, bin, process.platform, {
      extraBinRoots: [workspaceRoot],
    });
    const runner = verifyRunnerPath();
    isolated = makeIsolatedVerifyEnv(baseOptions.env ?? process.env);

    const child = runner
      ? spawn(
          process.execPath,
          [
            runner,
            String(timeout),
            commandRoot,
            Buffer.from(JSON.stringify(vc.cmd), 'utf8').toString('base64'),
          ],
          {
            cwd: commandRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            env: {
              ...isolated.env,
              ASHLR_VERIFY_SHELL: baseOptions.shell === true ? '1' : '0',
            },
          },
        )
      : spawn(bin, vc.cmd.slice(1), {
          cwd: commandRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: baseOptions.shell === true,
          windowsHide: true,
          env: isolated.env,
        });

    return await new Promise<VerifyCommandResult>((resolveDone) => {
      const stdout = createBoundedStreamCapture();
      const stderr = createBoundedStreamCapture();
      let spawnError: Error | undefined;
      let wrapperTimedOut = false;
      let settled = false;

      const parentTimeout = runner ? timeout + WRAPPER_TIMEOUT_GRACE_MS : timeout;
      const wrapperTimer = setTimeout(() => {
        wrapperTimedOut = true;
        stderr.append(`\n[verify-runner] wrapper timed out after ${parentTimeout}ms`);
        try {
          child.kill('SIGKILL');
        } catch {
          try { child.kill(); } catch { /* best effort */ }
        }
      }, parentTimeout);

      const finish = (result: VerifyCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(wrapperTimer);
        isolated?.cleanup();
        resolveDone(result);
      };

      child.stdout?.on('data', (chunk) => { stdout.append(chunk); });
      child.stderr?.on('data', (chunk) => { stderr.append(chunk); });

      child.on('error', (err) => {
        spawnError = err;
      });

      child.on('close', (code, signal) => {
        const timedOut =
          wrapperTimedOut ||
          code === 124 ||
          (spawnError !== undefined && (spawnError as NodeJS.ErrnoException).code === 'ETIMEDOUT');

        if (spawnError) {
          const output = renderToolText(
            `${command}\n${stdout.text()}${stderr.text()}\n${spawnError.message}`,
          );
          const failureCategory = verifyFailureCategory(output, {
            exitCode: -1,
            timedOut,
            error: spawnError,
          });
          audit({
            action: 'verify:command',
            repo: workspaceRoot,
            sandboxId: null,
            summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : 'spawn error'}`,
            result: 'error',
          });
          finish({ ok: false, command, exitCode: -1, output, timedOut, failureCategory });
          return;
        }

        const exitCode = code ?? (signal ? 1 : -1);
        const ok = exitCode === 0 && !wrapperTimedOut;
        const output = renderToolText(`${stdout.text()}${stderr.text()}`);
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

        finish({ ok, command, exitCode, output, timedOut, ...(failureCategory ? { failureCategory } : {}) });
      });
    });
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
