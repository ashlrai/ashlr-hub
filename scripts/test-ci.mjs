#!/usr/bin/env node
/**
 * Hermetic, watchdog-bounded Vitest runner for CI/publish gates.
 *
 * Why this exists: the full serial suite can leave a worker alive when a test
 * leaks network/process handles. A human can interrupt that locally; an
 * autonomous fleet needs a bounded command that fails loudly instead of hanging
 * forever.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const rawTimeout = Number(process.env.ASHLR_TEST_CI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
  ? Math.floor(rawTimeout)
  : DEFAULT_TIMEOUT_MS;

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
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ASHLR_HOME: join(home, '.ashlr'),
    CI: process.env.CI ?? '1',
  },
  detached: process.platform !== 'win32',
});

let timedOut = false;

const timer = setTimeout(() => {
  timedOut = true;
  console.error(
    `[test-ci] timed out after ${timeoutMs}ms; killing Vitest. ` +
    'Run `npm run test:serial -- --reporter verbose` to isolate the leaked handle.',
  );
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only; the temp HOME is under the OS temp dir.
  }

  if (timedOut) {
    process.exitCode = 124;
    return;
  }
  if (signal) {
    console.error(`[test-ci] Vitest exited via signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

child.on('error', (err) => {
  clearTimeout(timer);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
  console.error(`[test-ci] failed to start Vitest: ${err.message}`);
  process.exitCode = 1;
});
