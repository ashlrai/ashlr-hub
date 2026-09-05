#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`bounded command: ${message}`);
}

function seconds(value, label) {
  const match = /^(0|[1-9][0-9]*)s$/u.exec(value ?? '');
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 600) {
    fail(`${label} must be 1s-600s`);
  }
  return Number(match[1]) * 1_000;
}

export function parseBoundedCommandArgs(argv) {
  if (argv.length < 5 || argv[0] !== '--signal=TERM' || argv[1] !== '--kill-after=5s') {
    fail('expected --signal=TERM --kill-after=5s <timeout>s <command> [args...]');
  }
  return Object.freeze({
    timeoutMs: seconds(argv[2], 'timeout'),
    killAfterMs: 5_000,
    command: argv[3],
    args: Object.freeze(argv.slice(4)),
  });
}

async function terminate(child, killAfterMs) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, killAfterMs));
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export async function runBoundedCommand(options) {
  const child = spawn(options.command, options.args, {
    stdio: 'inherit',
    env: process.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    void terminate(child, options.killAfterMs);
  }, options.timeoutMs);
  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => resolveResult({ code: null, error }));
    child.once('exit', (code, signal) => resolveResult({ code, signal }));
  });
  globalThis.clearTimeout(timer);
  if (result.error) fail(`could not start ${options.command}: ${result.error.message}`);
  if (timedOut) return 124;
  if (typeof result.code === 'number') return result.code;
  return result.signal ? 128 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    process.exitCode = await runBoundedCommand(parseBoundedCommandArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 64;
  }
}
