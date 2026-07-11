import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, it } from 'vitest';

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
