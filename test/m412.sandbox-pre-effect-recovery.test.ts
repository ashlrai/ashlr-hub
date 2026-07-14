import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Sandbox } from '../src/core/types.js';
import {
  canonicalPathIdentity,
  createSandbox,
  listSandboxes,
  removeSandbox,
  sandboxesDir,
  sweepOrphanSandboxesDetailed,
} from '../src/core/sandbox/worktree.js';
import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';

interface SourceSnapshot {
  branch: string;
  branches: string[];
  head: string;
  status: string;
  tree: string;
  worktrees: string;
}

let fx: H1Fixture;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  }).trim();
}

function hasRegisteredWorktree(repo: string, worktreePath: string): boolean {
  const expected = canonicalPathIdentity(worktreePath);
  if (expected === null) return false;
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => canonicalPathIdentity(line.slice('worktree '.length).trimEnd()) === expected);
}

function sourceSnapshot(repo: DisposableRepo): SourceSnapshot {
  return {
    branch: repo.currentBranch(),
    branches: repo.branches().slice().sort(),
    head: git(repo.dir, ['rev-parse', 'HEAD']),
    status: repo.gitStatus(),
    tree: repo.shasumTree(),
    worktrees: git(repo.dir, ['worktree', 'list', '--porcelain']),
  };
}

function writePreEffectReservation(repo: DisposableRepo): Sandbox {
  const id = 'm412-pre-effect-reservation';
  const home = join(sandboxesDir(), id);

  // Omit ownerPid so recovery does not depend on process-exit timing or PID reuse.
  const reservation: Sandbox = {
    id,
    sourceRepo: repo.dir,
    worktreePath: join(home, 'worktree'),
    branch: `ashlr/sandbox/${id}`,
    baseHead: git(repo.dir, ['rev-parse', 'HEAD']),
    createdAt: new Date().toISOString(),
  };

  mkdirSync(sandboxesDir(), { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(
    join(home, 'sandbox.json'),
    `${JSON.stringify(reservation, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return reservation;
}

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('M412 sandbox pre-effect recovery', () => {
  it('reclaims a metadata-only reservation and preserves ordinary creation', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    git(repo.dir, ['branch', 'user/keep']);
    const sourceBefore = sourceSnapshot(repo);

    const reservation = writePreEffectReservation(repo);
    expect(existsSync(reservation.worktreePath)).toBe(false);
    expect(repo.branches()).not.toContain(reservation.branch);
    expect(listSandboxes()).toEqual([reservation]);

    expect(sweepOrphanSandboxesDetailed()).toMatchObject({
      completed: [reservation.id],
      residual: [],
      refused: [],
      unavailable: [],
      inventory: {
        totalHomes: 1,
        validHomes: 1,
        malformedHomes: 0,
        unsafeEntries: 0,
      },
      unexpectedErrors: [],
    });
    expect(existsSync(join(sandboxesDir(), reservation.id))).toBe(false);
    expect(listSandboxes()).toEqual([]);
    expect(sourceSnapshot(repo)).toEqual(sourceBefore);

    const sandbox = createSandbox(repo.dir);
    try {
      expect(existsSync(sandbox.worktreePath)).toBe(true);
      expect(repo.branches()).toContain(sandbox.branch);
      expect(hasRegisteredWorktree(repo.dir, sandbox.worktreePath)).toBe(true);
      expect(listSandboxes().map((entry) => entry.id)).toEqual([sandbox.id]);
    } finally {
      expect(removeSandbox(sandbox).status).toBe('complete');
    }

    expect(sourceSnapshot(repo)).toEqual(sourceBefore);
    expect(listSandboxes()).toEqual([]);
  }, 15_000);
});
