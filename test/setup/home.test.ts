import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';
import { daemonStatePath } from '../../src/core/daemon/state.js';

it('establishes an isolated HOME and ASHLR_HOME before test modules load', () => {
  const home = process.env.HOME;

  expect(home).toBeTruthy();
  expect(existsSync(home!)).toBe(true);
  expect(basename(home!)).toMatch(/^ashlr-vitest-home-/);
  expect(process.env.USERPROFILE).toBe(home);
  expect(process.env.ASHLR_HOME).toBe(join(home!, '.ashlr'));
  expect(homedir()).toBe(home);
  expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
    encoding: 'utf8',
  })).toBe(home);
});

it('allows a test to relocate HOME and restore the isolated worker boundary', () => {
  const workerHome = process.env.HOME;
  const workerAshlrHome = process.env.ASHLR_HOME;
  const nestedHome = mkdtempSync(join(tmpdir(), 'ashlr-vitest-nested-home-'));

  try {
    process.env.HOME = nestedHome;
    process.env.ASHLR_HOME = join(nestedHome, '.ashlr');
    expect(homedir()).toBe(nestedHome);
  } finally {
    process.env.HOME = workerHome;
    process.env.ASHLR_HOME = workerAshlrHome;
    rmSync(nestedHome, { recursive: true, force: true });
  }

  expect(homedir()).toBe(workerHome);
  expect(process.env.ASHLR_HOME).toBe(workerAshlrHome);
});

// ---------------------------------------------------------------------------
// Regression guard — root-caused 2026-08-05/06 incident:
// a fail-OPEN `process.env['HOME'] || actual.homedir()` fallback let any test
// that cleared/misrestored HOME silently resolve to the REAL developer home,
// and daemon/state writers (which resolve homedir() fresh on every call) wrote
// real ~/.ashlr state with no error. These tests fail the suite loudly the
// instant that condition recurs, instead of letting it write through silently.
// ---------------------------------------------------------------------------

it('throws instead of silently falling back to the real home when HOME is cleared', () => {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(() => homedir()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
    if (userProfile !== undefined) process.env.USERPROFILE = userProfile;
  }
});

it('throws instead of silently resolving under the real developer home', () => {
  const realHome = process.env['ASHLR_VITEST_REAL_HOME'];
  // No ambient HOME was ever observed for this worker (unusual environment) —
  // nothing to guard against, so there's nothing this specific test can prove.
  if (!realHome) return;
  const home = process.env.HOME;
  try {
    process.env.HOME = realHome;
    expect(() => homedir()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
  }
});

it('protects real production path resolution (daemonStatePath), not just the raw os.homedir() call', () => {
  const home = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(() => daemonStatePath()).toThrow(/HOME isolation escaped/);
  } finally {
    process.env.HOME = home;
  }

  // Sanity check the escape hatch is closed, not just the alarm: with HOME
  // correctly restored, daemonStatePath() must resolve under the isolated
  // worker home and NEVER under the real developer home captured at worker
  // startup.
  const resolved = daemonStatePath();
  expect(resolved.startsWith(home!)).toBe(true);
  const realHome = process.env['ASHLR_VITEST_REAL_HOME'];
  if (realHome) expect(resolved.startsWith(realHome)).toBe(false);
});
