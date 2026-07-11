#!/usr/bin/env node
/**
 * Hermetic, watchdog-bounded Vitest runner for CI/publish gates.
 *
 * The runner distinguishes a silent/stalled process from a healthy but slow
 * suite that reaches its absolute runtime cap. Output is streamed directly and
 * only a bounded last-line diagnostic is retained.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout as setTimer } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_HARD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_LINE_TAIL = 2_048;

function readPositiveDuration(name, fallback) {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

const hardTimeoutMs = readPositiveDuration(
  'ASHLR_TEST_CI_TIMEOUT_MS',
  DEFAULT_HARD_TIMEOUT_MS,
);
const idleTimeoutMs = readPositiveDuration(
  'ASHLR_TEST_CI_IDLE_TIMEOUT_MS',
  DEFAULT_IDLE_TIMEOUT_MS,
);
const terminationGraceMs = readPositiveDuration(
  'ASHLR_TEST_CI_TERMINATION_GRACE_MS',
  5_000,
);

const home = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-home-'));
const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
const extraArgs = process.argv.slice(2);
const args = [
  vitestBin,
  'run',
  '--no-file-parallelism',
  ...extraArgs,
];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ASHLR_HOME: join(home, '.ashlr'),
    CI: process.env.CI ?? '1',
  },
  detached: process.platform !== 'win32',
});

let lastOutputAt = Date.now();
let lastProgressLine = '';
let sawVitestSummary = false;
let stdoutTail = '';
let stderrTail = '';
let idleTimer;
let hardTimer;
let terminationReason;
let terminationPromise;
let childExited = false;

const childResult = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    childExited = true;
    resolve({ code, signal, error: undefined });
  });
  child.once('error', (error) => {
    childExited = true;
    resolve({ code: null, signal: null, error });
  });
});

function observeOutput(chunk, streamName) {
  lastOutputAt = Date.now();
  const text = chunk.toString('utf8');
  const combined = (streamName === 'stdout' ? stdoutTail : stderrTail) + text;
  const lines = combined.split(/\r?\n/);
  const tail = (lines.pop() ?? '').slice(-MAX_LINE_TAIL);
  if (streamName === 'stdout') stdoutTail = tail;
  else stderrTail = tail;

  for (const line of lines) {
    const bounded = line.trim().slice(-MAX_LINE_TAIL);
    if (bounded) lastProgressLine = bounded;
    if (/\b(Test Files|Tests)\b.*\b(passed|failed|skipped)\b/i.test(line)) {
      sawVitestSummary = true;
    }
  }
  armIdleTimer();
}

function pipeOutput(source, destination, streamName) {
  source.on('data', (chunk) => {
    observeOutput(chunk, streamName);
    if (!destination.write(chunk)) {
      source.pause();
      destination.once('drain', () => source.resume());
    }
  });
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

async function terminateTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await runTaskkill(child.pid);
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // The child may not have become a process-group leader yet.
  }
  child.kill('SIGTERM');
  await Promise.race([childResult, delay(terminationGraceMs)]);
  // Always kill the process group after grace. The leader may have exited on
  // SIGTERM while a descendant still owns inherited stdout/stderr pipes.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Fall through to the direct leader kill below.
  }
  if (!childExited) {
    child.kill('SIGKILL');
  }
}

function requestTermination(reason) {
  if (terminationReason) return terminationPromise;
  terminationReason = reason;
  clearTimeout(idleTimer);
  clearTimeout(hardTimer);

  if (reason.kind === 'idle-timeout') {
    const summary = sawVitestSummary
      ? 'Vitest had emitted its final summary; a leaked handle is plausible.'
      : 'Vitest had not emitted its final summary; this indicates a stalled or silent run, not proven leaked handles.';
    const progress = lastProgressLine
      ? ` Last output: ${JSON.stringify(lastProgressLine)}.`
      : ' No bounded progress line was captured.';
    console.error(
      `[test-ci] idle-timeout after ${idleTimeoutMs}ms without output. ${summary}${progress}`,
    );
  } else if (reason.kind === 'hard-runtime-cap') {
    const idleForMs = Date.now() - lastOutputAt;
    console.error(
      `[test-ci] hard-runtime-cap reached after ${hardTimeoutMs}ms ` +
      `(last output ${idleForMs}ms ago); the suite exceeded its runtime budget. ` +
      'This is not evidence of a leaked handle.',
    );
  } else {
    console.error(`[test-ci] received ${reason.signal}; terminating the Vitest process tree.`);
  }

  terminationPromise = terminateTree();
  return terminationPromise;
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimer(() => {
    void requestTermination({ kind: 'idle-timeout' });
  }, idleTimeoutMs);
}

pipeOutput(child.stdout, process.stdout, 'stdout');
pipeOutput(child.stderr, process.stderr, 'stderr');
armIdleTimer();
hardTimer = setTimer(() => {
  void requestTermination({ kind: 'hard-runtime-cap' });
}, hardTimeoutMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void requestTermination({ kind: 'signal', signal });
  });
}

const result = await childResult;
clearTimeout(idleTimer);
clearTimeout(hardTimer);
if (terminationPromise) await terminationPromise;

try {
  rmSync(home, { recursive: true, force: true });
} catch {
  // Best effort cleanup only; the temp HOME is under the OS temp dir.
}

if (terminationReason?.kind === 'idle-timeout' || terminationReason?.kind === 'hard-runtime-cap') {
  process.exitCode = 124;
} else if (terminationReason?.kind === 'signal') {
  process.exitCode = terminationReason.signal === 'SIGINT' ? 130 : 143;
} else if (result.error) {
  console.error(`[test-ci] failed to start Vitest: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`[test-ci] Vitest exited via signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code ?? 1;
}
