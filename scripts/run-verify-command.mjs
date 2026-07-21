#!/usr/bin/env node
/**
 * Watchdog-bounded verification command runner.
 *
 * `spawnSync(..., { timeout })` can kill only the direct child. Test runners
 * such as Vitest may leave worker grandchildren alive and reparented, which can
 * wedge autonomous daemon ticks. This wrapper owns a process group and kills the
 * group on timeout.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const [, , timeoutRaw, repoRoot, cwd, argvB64] = process.argv;
const timeoutMs = Number(timeoutRaw);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !repoRoot || !cwd || !argvB64) {
  console.error('usage: run-verify-command.mjs <timeoutMs> <repoRoot> <cwd> <base64-json-argv>');
  process.exit(2);
}

let argv;
try {
  argv = JSON.parse(Buffer.from(argvB64, 'base64').toString('utf8'));
} catch (err) {
  console.error(`invalid argv: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
  console.error('invalid argv: expected a non-empty string array');
  process.exit(2);
}

const [bin, ...args] = argv;
const inside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function executableError() {
  if (win32.isAbsolute(bin) || /^[a-zA-Z]:/.test(bin)) return 'must be repo-relative, not a Windows drive path';
  if (bin.includes('\\')) return 'must not use Windows backslash path separators';
  if (!bin.includes('/')) return null;
  if (isAbsolute(bin)) return 'must be repo-relative, not an absolute path';

  const lexical = resolve(cwd, bin);
  if (!inside(resolve(repoRoot), lexical)) return 'must resolve inside the repo';
  if (!existsSync(lexical)) return null;
  try {
    const physicalRoot = realpathSync(repoRoot);
    return inside(physicalRoot, realpathSync(lexical))
      ? null
      : 'must resolve inside the repo without escaping through a symlink';
  } catch {
    return 'must resolve inside the repo';
  }
}

try {
  const physicalRoot = realpathSync(repoRoot);
  const physicalCwd = realpathSync(cwd);
  if (!statSync(physicalCwd).isDirectory() || !inside(physicalRoot, physicalCwd)) {
    throw new Error('command cwd is outside the workspace or unavailable');
  }
  const error = executableError();
  if (error) throw new Error(`command executable ${error}`);
} catch (error) {
  console.error(`[verify-runner] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const child = spawn(bin, args, {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  shell: process.env.ASHLR_VERIFY_SHELL === '1',
  windowsHide: true,
  detached: process.platform !== 'win32',
});

let timedOut = false;
let forceTimer = null;

function terminateTree(signal) {
  if (process.platform === 'win32') {
    if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Best effort only.
    }
  }
}

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`[verify-runner] timed out after ${timeoutMs}ms; terminating process group`);
  terminateTree('SIGTERM');
  forceTimer = setTimeout(() => terminateTree('SIGKILL'), 5_000);
}, timeoutMs);

child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

child.on('error', (err) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  console.error(`[verify-runner] failed to start: ${err.message}`);
  process.exitCode = 127;
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) {
    process.exitCode = 124;
    return;
  }
  if (signal) {
    console.error(`[verify-runner] command exited via signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
