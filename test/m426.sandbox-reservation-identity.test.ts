import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalPathIdentity,
  createSandbox,
  removeSandbox,
  sandboxesDir,
  sweepOrphanSandboxesDetailed,
} from '../src/core/sandbox/worktree.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

interface PublicationObservation {
  metadataExists: boolean;
  ownerPid: number | null;
  worktreeExists: boolean;
}

let fx: H1Fixture;
let originalPath: string | undefined;
let originalAllowAnyRepo: string | undefined;
const cleanupPaths = new Set<string>();

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  }).trim();
}

function realGitPath(): string {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  return execFileSync(command, ['git'], { encoding: 'utf8', stdio: 'pipe' })
    .split(/\r?\n/u)[0]!
    .trim();
}

function installGitShim(mode: 'observe-add' | 'registration-noop' | 'common-dir-alias'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m426-git-'));
  cleanupPaths.add(dir);
  const script = join(dir, 'git-shim.cjs');
  writeFileSync(script, `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const mode = process.env.M426_GIT_MODE;

if (mode === 'observe-add' && args[0] === 'worktree' && args[1] === 'add') {
  const worktree = args[4];
  const metadata = path.join(path.dirname(worktree), 'sandbox.json');
  let ownerPid = null;
  if (fs.existsSync(metadata)) ownerPid = JSON.parse(fs.readFileSync(metadata, 'utf8')).ownerPid ?? null;
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify({
    metadataExists: fs.existsSync(metadata),
    ownerPid,
    worktreeExists: fs.existsSync(worktree),
  }));
}

if (mode === 'registration-noop') {
  if (args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune')) process.exit(0);
  if (args[0] === 'branch' && args[1] === '-D') process.exit(0);
  if (args[0] === 'show-ref' && args.at(-1)?.startsWith('refs/heads/ashlr/sandbox/')) process.exit(1);
}

if (mode === 'common-dir-alias') {
  if (args[0] === 'worktree' && args[1] === 'list') process.exit(0);
  if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
    const cwd = fs.realpathSync.native(process.cwd());
    const worktree = fs.realpathSync.native(process.env.M426_WORKTREE);
    process.stdout.write((cwd.toLowerCase() === worktree.toLowerCase()
      ? process.env.M426_COMMON_REAL
      : process.env.M426_COMMON_ALIAS) + '\\n');
    process.exit(0);
  }
}

const result = cp.spawnSync(process.env.M426_REAL_GIT, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(script, 0o700);

  if (process.platform === 'win32') {
    writeFileSync(
      join(dir, 'git.cmd'),
      `@"${process.execPath}" "${script}" %*\r\n`,
      'utf8',
    );
  } else {
    const launcher = join(dir, 'git');
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      encoding: 'utf8',
      mode: 0o700,
    });
    chmodSync(launcher, 0o700);
  }

  process.env.M426_GIT_MODE = mode;
  process.env.M426_REAL_GIT = realGitPath();
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`;
  return dir;
}

function makeDirectoryAlias(target: string): string {
  const alias = `${target}-alias`;
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  cleanupPaths.add(alias);
  return alias;
}

beforeEach(() => {
  originalPath = process.env.PATH;
  originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  fx = makeFixture();
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.M426_GIT_MODE;
  delete process.env.M426_REAL_GIT;
  delete process.env.M426_MARKER;
  delete process.env.M426_WORKTREE;
  delete process.env.M426_COMMON_REAL;
  delete process.env.M426_COMMON_ALIAS;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
  fx.cleanup();
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
  cleanupPaths.clear();
});

describe('M426 sandbox reservation and path identity', () => {
  it('publishes durable owner metadata before the Git worktree effect', () => {
    const repo = fx.makeRepo();
    const marker = join(fx.home, 'creation-observation.json');
    installGitShim('observe-add');
    process.env.M426_MARKER = marker;

    const sandbox = createSandbox(repo.dir, { allowAnyRepo: true });
    try {
      expect(JSON.parse(readFileSync(marker, 'utf8')) as PublicationObservation).toEqual({
        metadataExists: true,
        ownerPid: process.pid,
        worktreeExists: false,
      });
    } finally {
      removeSandbox(sandbox);
    }
  });

  it('keeps fresh metadata-free homes and reclaims them after a nonzero recovery age', () => {
    const id = 'm426-metadata-free';
    const home = join(sandboxesDir(), id);
    mkdirSync(home, { recursive: true, mode: 0o700 });

    const fresh = sweepOrphanSandboxesDetailed();
    expect(fresh.completed).not.toContain(id);
    expect(existsSync(home)).toBe(true);

    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(home, old, old);
    const recovered = sweepOrphanSandboxesDetailed();
    expect(recovered.completed).toContain(id);
    expect(existsSync(home)).toBe(false);
  });

  it('normalizes aliases and missing suffixes to one canonical path identity', () => {
    const physical = join(fx.home, 'Long Sandbox Identity Directory');
    mkdirSync(physical, { recursive: true });
    const alias = makeDirectoryAlias(physical);

    expect(canonicalPathIdentity(join(alias, 'missing', '..', 'worktree')))
      .toBe(canonicalPathIdentity(join(physical, 'worktree')));

    if (process.platform === 'win32') {
      const short = execFileSync(
        'cmd.exe',
        ['/d', '/c', `for %I in ("${physical}") do @echo %~sI`],
        { encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      expect(canonicalPathIdentity(join(short, 'future-worktree')))
        .toBe(canonicalPathIdentity(join(physical, 'future-worktree')));
    }
  });

  it('does not report cleanup complete when Git retains an alias-spelled registration', () => {
    const repo = fx.makeRepo();
    const aliasHome = makeDirectoryAlias(fx.home);
    process.env.HOME = aliasHome;
    process.env.USERPROFILE = aliasHome;

    const sandbox = createSandbox(repo.dir, { allowAnyRepo: true });
    process.env.PATH = originalPath;
    installGitShim('registration-noop');
    try {
      const result = removeSandbox(sandbox);
      expect(result).toMatchObject({
        status: 'residual',
        postconditions: { registration: 'present', branch: 'absent', home: 'present' },
      });
      expect(result.failureClasses).toContain('worktree-remaining');
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      try { git(repo.dir, ['worktree', 'remove', '--force', sandbox.worktreePath]); } catch { /* best effort */ }
      try { git(repo.dir, ['worktree', 'prune']); } catch { /* best effort */ }
      try { git(repo.dir, ['branch', '-D', sandbox.branch]); } catch { /* best effort */ }
      rmSync(join(sandboxesDir(), sandbox.id), { recursive: true, force: true });
    }
  });

  it('accepts aliased common directories as the same repository authority', () => {
    const repo = fx.makeRepo();
    const repoAlias = makeDirectoryAlias(repo.dir);
    const sandbox = createSandbox(repo.dir, { allowAnyRepo: true });
    const commonReal = realpathSync.native(git(repo.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const commonAlias = join(repoAlias, '.git');

    process.env.PATH = originalPath;
    installGitShim('common-dir-alias');
    process.env.M426_WORKTREE = sandbox.worktreePath;
    process.env.M426_COMMON_REAL = commonReal;
    process.env.M426_COMMON_ALIAS = commonAlias;

    const result = removeSandbox(sandbox);
    expect(result).toMatchObject({ status: 'complete' });
    expect(existsSync(sandbox.worktreePath)).toBe(false);
  });
});
