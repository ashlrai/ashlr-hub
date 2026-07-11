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
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

const workerHomeKey = 'ASHLR_VITEST_WORKER_HOME';
const workerPidKey = 'ASHLR_VITEST_WORKER_PID';
let workerHome = process.env[workerHomeKey];

if (!workerHome || process.env[workerPidKey] !== String(process.pid)) {
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

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => process.env['HOME'] || actual.homedir();
  return {
    ...actual,
    homedir,
    default: { ...actual.default, homedir },
  };
});
