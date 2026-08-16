/**
 * Global test setup: isolate every Vitest worker from the developer's home and
 * make `homedir()` follow `process.env.HOME` on every platform.
 *
 * Setup files run before each test module. The worker marker keeps one stable
 * temporary home for that worker, so tests may further relocate HOME and restore
 * the value they captured at module load without escaping the suite boundary.
 * Reasserting the boundary here also contains a preceding file that forgot to
 * restore its environment.
 *
 * The `node:os` mock reaches both named and default imports. It is required on
 * Windows, where the native `homedir()` ignores HOME and reads USERPROFILE.
 *
 * FAIL-LOUD BOUNDARY (root-caused 2026-08-05/06 incident — real ~/.ashlr/daemon.json
 * was corrupted by a test run):
 *   The previous mock was `process.env['HOME'] || actual.homedir()` — a FAIL-OPEN
 *   fallback. The instant any test cleared/deleted HOME (a bug, a thrown exception
 *   between an override and its restore, a stray `delete process.env.HOME`) OR
 *   accidentally reassigned HOME back to the real value, `homedir()` would SILENTLY
 *   resolve to the developer's REAL home with no error — and daemon/state writers
 *   (which recompute `homedir()` fresh on every call, by design, to honor mid-test
 *   relocation) would happily persist real state there. Nothing ever told you it
 *   happened.
 *
 *   `guardedHomedir()` below removes that fallback entirely. HOME falsy, or HOME
 *   resolving to the exact real developer home captured before this file's first
 *   override, is now a thrown error — the offending test fails immediately and
 *   loudly instead of the suite quietly writing through the isolation boundary.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';

const workerHomeKey = 'ASHLR_VITEST_WORKER_HOME';
const workerPidKey = 'ASHLR_VITEST_WORKER_PID';
const realHomeKey = 'ASHLR_VITEST_REAL_HOME';
let workerHome = process.env[workerHomeKey];

if (!workerHome || process.env[workerPidKey] !== String(process.pid)) {
  // First setup-file execution for this worker process: process.env.HOME (if
  // set at all) still holds whatever the ambient shell/CI environment gave us —
  // the REAL developer home. Capture it now, before it is overwritten below, as
  // the exact boundary no resolved path may ever cross again for this worker's
  // lifetime.
  if (!process.env[realHomeKey]) {
    const ambientHome = process.env['HOME'] || process.env['USERPROFILE'];
    if (ambientHome) process.env[realHomeKey] = resolve(ambientHome);
  }

  workerHome = mkdtempSync(join(tmpdir(), 'ashlr-vitest-home-'));
  process.env[workerHomeKey] = workerHome;
  process.env[workerPidKey] = String(process.pid);
  const homeToRemove = workerHome;
  process.once('exit', () => {
    try {
      rmSync(homeToRemove, { recursive: true, force: true });
    } catch {
      // Process shutdown must not turn a best-effort fixture cleanup into a failure.
    }
  });
}

process.env.HOME = workerHome;
process.env.USERPROFILE = workerHome;
process.env.ASHLR_HOME = join(workerHome, '.ashlr');

const realHome = process.env[realHomeKey];

function guardedHomedir(): string {
  const raw = process.env['HOME'];
  if (!raw) {
    throw new Error(
      'HOME isolation escaped: process.env.HOME is unset/empty mid-test. This is the exact ' +
      'condition that used to let os.homedir() silently fall back to the REAL developer home ' +
      'and write real ~/.ashlr state (see test/setup/home.ts). Find the test that cleared HOME ' +
      '(delete process.env.HOME / process.env.HOME = undefined) without restoring it to an ' +
      'isolated tmp dir before the next path resolution, and fix it to restore in a finally / ' +
      'afterEach.',
    );
  }
  if (realHome && resolve(raw) === realHome) {
    throw new Error(
      `HOME isolation escaped: process.env.HOME resolved to the REAL developer home ` +
      `(${realHome}) mid-test. A test restored or reassigned HOME to the real directory ` +
      `instead of an isolated tmp dir. Refusing to let daemon/state code resolve paths there ` +
      '(see test/setup/home.ts).',
    );
  }
  return raw;
}

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: guardedHomedir,
    default: { ...actual.default, homedir: guardedHomedir },
  };
});
