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
 *   - Subprocesses run with execFileSync / spawnSync via ARG ARRAYS, NO shell,
 *     and a tight timeout so a hung verify can never block the orchestrator.
 *   - runVerifyCommand never throws — any failure resolves to { ok:false } with
 *     the error captured in `output`.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { renderToolText } from '../mcp-native.js';
import { audit } from '../sandbox/audit.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Hard ceiling on the per-command timeout (ms). */
const MAX_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single verification command to run, classified by what it checks. */
export interface VerifyCommand {
  kind: 'typecheck' | 'test' | 'lint';
  /** Exact argv (executable + args). NEVER passed through a shell. */
  cmd: string[];
}

/** Outcome of running one VerifyCommand. */
export interface VerifyCommandResult {
  ok: boolean;
  /** Human-readable command (the argv joined) for logs / verdicts. */
  command: string;
  exitCode: number;
  /** Combined stdout+stderr, secret-scrubbed and size-capped (≤32KB). */
  output: string;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the package-manager runner from the lockfile present in `root`.
 * Order matters only insofar as a repo should have exactly one lockfile;
 * pnpm → yarn → bun → npm (default).
 */
function detectPackageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Build the argv to run a package.json script named `script` via `pm`. */
function runScriptArgv(pm: string, script: string): string[] {
  // npm/pnpm/yarn/bun all accept `<pm> run <script>`.
  return [pm, 'run', script];
}

/** The subset of package.json fields verification detection cares about. */
interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Read & parse package.json once; returns the parsed object or null on any error. */
function readPackageJson(root: string): PackageJson | null {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/** Extract the string-valued scripts map from a parsed package.json; {} when absent. */
function scriptsOf(pkg: PackageJson | null): Record<string, string> {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scripts)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** True when the parsed package.json declares `dep` in deps or devDeps. */
function hasDep(pkg: PackageJson | null, dep: string): boolean {
  if (!pkg) return false;
  return (
    (pkg.dependencies !== undefined && dep in pkg.dependencies) ||
    (pkg.devDependencies !== undefined && dep in pkg.devDependencies)
  );
}

/** True when a file matching `<prefix>.<ext>` exists for any common config ext. */
function hasConfigFile(root: string, prefix: string): boolean {
  try {
    const entries = readdirSync(root);
    return entries.some(
      (f) => f === prefix || f.startsWith(`${prefix}.`),
    );
  } catch {
    return false;
  }
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
  const commands: VerifyCommand[] = [];
  const pkg = readPackageJson(workspaceRoot);
  const scripts = scriptsOf(pkg);
  const pm = detectPackageManager(workspaceRoot);

  // --- typecheck ---
  if (scripts['typecheck']) {
    commands.push({ kind: 'typecheck', cmd: runScriptArgv(pm, 'typecheck') });
  } else if (existsSync(join(workspaceRoot, 'tsconfig.json'))) {
    commands.push({ kind: 'typecheck', cmd: ['npx', 'tsc', '--noEmit'] });
  }

  // --- test ---
  if (scripts['test']) {
    commands.push({ kind: 'test', cmd: runScriptArgv(pm, 'test') });
  } else if (hasDep(pkg, 'vitest') || hasConfigFile(workspaceRoot, 'vitest.config')) {
    commands.push({ kind: 'test', cmd: ['npx', 'vitest', 'run'] });
  }

  // --- lint ---
  if (scripts['lint']) {
    commands.push({ kind: 'lint', cmd: runScriptArgv(pm, 'lint') });
  }

  return commands;
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

export function spawnOptionsFor(
  workspaceRoot: string,
  timeout: number,
  bin?: string,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncOptionsWithStringEncoding {
  const isWin = platform === 'win32';
  const needsShell = isWin && bin !== undefined && WINDOWS_SHIM_BINS.has(bin);
  return {
    cwd: workspaceRoot,
    timeout,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: needsShell, // resolve npm.cmd/npx.cmd etc. via PATHEXT on Windows
    windowsHide: true,
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
  const command = vc.cmd.join(' ');
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
    return { ok: false, command, exitCode: -1, output, timedOut: false };
  }

  try {
    const res = spawnSync(bin, vc.cmd.slice(1), spawnOptionsFor(workspaceRoot, timeout, bin));

    const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';

    // spawn-level failure (binary not found, timeout, …): res.status is null.
    if (res.error) {
      const output = renderToolText(
        `${command}\n${(res.stdout ?? '')}${res.stderr ?? ''}\n${res.error.message}`,
      );
      audit({
        action: 'verify:command',
        repo: workspaceRoot,
        sandboxId: null,
        summary: `${vc.kind}: ${command} → ${timedOut ? 'timed out' : 'spawn error'}`,
        result: 'error',
      });
      return { ok: false, command, exitCode: -1, output, timedOut };
    }

    const exitCode = res.status ?? -1;
    const ok = exitCode === 0;
    const output = renderToolText(`${(res.stdout ?? '')}${res.stderr ?? ''}`);

    audit({
      action: 'verify:command',
      repo: workspaceRoot,
      sandboxId: null,
      summary: `${vc.kind}: ${command} → exit ${exitCode}`,
      result: ok ? 'ok' : 'error',
    });

    return { ok, command, exitCode, output, timedOut: false };
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
    return { ok: false, command, exitCode: -1, output, timedOut: false };
  }
}
