import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, win32 } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalPathIdentity,
  createSandbox,
  listSandboxes,
  removeSandbox,
  sandboxesDir,
  sweepOrphanSandboxesDetailed,
} from '../src/core/sandbox/worktree.js';
import {
  acquireOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import { enroll, isEnrolled } from '../src/core/sandbox/policy.js';
import type { Sandbox } from '../src/core/types.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

vi.setConfig({ testTimeout: 15_000 });

const privateStorageHarness = vi.hoisted(() => ({ useSemanticAdapter: false }));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => process.platform === 'win32' && privateStorageHarness.useSemanticAdapter
      ? { ok: true, reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl' }
      : actual.assurePrivateStoragePath(...args),
  };
});

interface PublicationObservation {
  metadataExists: boolean;
  ownerPid: number | null;
  worktreeExists: boolean;
}

interface RepositoryObservation {
  head: string;
  branches: string[];
  status: string;
  tree: string;
  worktrees: string;
}

let fx: H1Fixture;
let originalPath: string | undefined;
let originalNodeOptions: string | undefined;
let originalAllowAnyRepo: string | undefined;
const cleanupPaths = new Set<string>();
const transientWindowsCleanupErrors = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

function cleanupTrackedPaths(options: {
  deferTransientWindowsLocks: boolean;
  maxRetries: number;
}): void {
  const failures: unknown[] = [];
  for (const path of [...cleanupPaths]) {
    try {
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: options.maxRetries,
        retryDelay: 100,
      });
      cleanupPaths.delete(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (options.deferTransientWindowsLocks && process.platform === 'win32' &&
        code !== undefined && transientWindowsCleanupErrors.has(code)) continue;
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'M426 temporary cleanup failed');
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  }).trim();
}

function branches(repo: string): string[] {
  const output = git(repo, ['branch', '--format=%(refname:short)']);
  return output ? output.split(/\r?\n/u) : [];
}

function observeRepository(repo: { dir: string; shasumTree(): string }): RepositoryObservation {
  return {
    head: git(repo.dir, ['rev-parse', 'HEAD']),
    branches: branches(repo.dir),
    status: git(repo.dir, ['status', '--porcelain']),
    tree: repo.shasumTree(),
    worktrees: git(repo.dir, ['worktree', 'list', '--porcelain']),
  };
}

function realGitPath(): string {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  return execFileSync(command, ['git'], { encoding: 'utf8', stdio: 'pipe' })
    .split(/\r?\n/u)[0]!
    .trim();
}

function installGitShim(
  mode: 'observe-add' | 'common-dir-alias' |
    'retarget-source' | 'retarget-common-dir' | 'retarget-during-worktree-add' |
    'retarget-sandbox-home' | 'retarget-sandbox-parent' | 'observe-pinned-argv' |
    'hang-worktree-descendant' | 'retarget-after-worktree-add' |
    'retarget-source-path-during-discovery' | 'fail-add-then-appear-on-remove' |
    'fail-worktree-cleanup',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m426-git-'));
  cleanupPaths.add(dir);
  const script = join(dir, 'git-shim.cjs');
  writeFileSync(script, `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(process.platform === 'win32' ? 1 : 2);
if (process.platform === 'win32' && args[0]) args[0] = path.basename(args[0]);
const mode = process.env.M426_GIT_MODE;
const worktreeIndex = args.indexOf('worktree');

if (mode === 'observe-add' && worktreeIndex >= 0 && args[worktreeIndex + 1] === 'add') {
  const worktree = args[worktreeIndex + 4];
  const metadata = path.join(path.dirname(worktree), 'sandbox.json');
  let ownerPid = null;
  if (fs.existsSync(metadata)) ownerPid = JSON.parse(fs.readFileSync(metadata, 'utf8')).ownerPid ?? null;
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify({
    metadataExists: fs.existsSync(metadata),
    ownerPid,
    worktreeExists: fs.existsSync(worktree),
  }));
}

if (mode === 'observe-pinned-argv' && worktreeIndex >= 0 && args[worktreeIndex + 1] === 'add') {
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify(args));
}

if (mode === 'fail-add-then-appear-on-remove' && worktreeIndex >= 0 &&
    args[worktreeIndex + 1] === 'add') process.exit(1);

if (mode === 'fail-add-then-appear-on-remove' && worktreeIndex >= 0 &&
    args[worktreeIndex + 1] === 'remove') {
  const worktree = args[worktreeIndex + 3];
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(process.env.M426_MARKER, worktree);
  // The destination monitor owns termination once it observes the appeared path.
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}

if (mode === 'fail-worktree-cleanup' && worktreeIndex >= 0 &&
    (args[worktreeIndex + 1] === 'remove' || args[worktreeIndex + 1] === 'prune')) {
  fs.appendFileSync(process.env.M426_MARKER, args.join('\\0') + '\\n');
  process.exit(1);
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

if (mode === 'retarget-source' && args[0] === 'rev-parse' &&
    args.includes('--git-common-dir') &&
    !fs.existsSync(process.env.M426_MARKER)) {
  fs.rmSync(process.env.M426_SOURCE_ALIAS, { recursive: true, force: true });
  fs.symlinkSync(
    process.env.M426_REPLACEMENT_REPO,
    process.env.M426_SOURCE_ALIAS,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.writeFileSync(process.env.M426_MARKER, 'retargeted\\n');
}

if (mode === 'retarget-source-path-during-discovery' && args[0] === 'rev-parse' &&
    args.includes('--git-common-dir') && !fs.existsSync(process.env.M426_MARKER)) {
  fs.renameSync(process.env.M426_SOURCE_ALIAS, process.env.M426_SOURCE_GIT_BACKUP);
  fs.symlinkSync(
    process.env.M426_REPLACEMENT_REPO,
    process.env.M426_SOURCE_ALIAS,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.writeFileSync(process.env.M426_MARKER, 'retargeted\\n');
}

if (mode === 'retarget-common-dir' && args[0] === 'rev-parse' && args[1] === 'HEAD' &&
    !fs.existsSync(process.env.M426_MARKER)) {
  fs.renameSync(process.env.M426_SOURCE_GIT_DIR, process.env.M426_SOURCE_GIT_BACKUP);
  fs.symlinkSync(
    process.env.M426_REPLACEMENT_GIT_DIR,
    process.env.M426_SOURCE_GIT_DIR,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.writeFileSync(process.env.M426_MARKER, 'retargeted\\n');
}

if (mode === 'retarget-during-worktree-add' && worktreeIndex >= 0 &&
    args[worktreeIndex + 1] === 'add' && !fs.existsSync(process.env.M426_MARKER)) {
  fs.rmSync(process.env.M426_SOURCE_GIT_DIR, { recursive: true, force: true });
  fs.symlinkSync(
    process.env.M426_REPLACEMENT_GIT_DIR,
    process.env.M426_SOURCE_GIT_DIR,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.writeFileSync(process.env.M426_MARKER, 'retargeted\\n');
}

if ((mode === 'retarget-sandbox-home' || mode === 'retarget-sandbox-parent') &&
    worktreeIndex >= 0 && args[worktreeIndex + 1] === 'add' &&
    !fs.existsSync(process.env.M426_MARKER)) {
  const worktree = args[worktreeIndex + 4];
  const home = path.dirname(worktree);
  const target = mode === 'retarget-sandbox-home' ? home : path.dirname(home);
  const backup = target + '.m426-original';
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify({ target, backup }));
  fs.renameSync(target, backup);
  fs.mkdirSync(target);
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}

if (mode === 'hang-worktree-descendant' && worktreeIndex >= 0 &&
    args[worktreeIndex + 1] === 'add') {
  const descendantEnv = { ...process.env };
  delete descendantEnv.NODE_OPTIONS;
  const descendant = cp.spawn(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 60000)',
    process.env.M426_MARKER + '.alive',
  ], { env: descendantEnv, stdio: 'ignore' });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(process.env.M426_MARKER + '.alive') && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify({
    shimPid: process.pid,
    descendantPid: descendant.pid,
  }));
  fs.writeSync(1, Buffer.alloc(70 * 1024, 120));
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}

if (mode === 'retarget-after-worktree-add' && worktreeIndex >= 0 &&
    args[worktreeIndex + 1] === 'add') {
  const result = cp.spawnSync(process.env.M426_REAL_GIT, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const worktree = args[worktreeIndex + 4];
  const home = path.dirname(worktree);
  const backup = home + '.m426-original';
  fs.writeFileSync(process.env.M426_MARKER, JSON.stringify({ home, backup }));
  fs.renameSync(home, backup);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, 'worktree'));
  process.stdout.write(result.stdout);
  process.exit(0);
}

const result = cp.spawnSync(process.env.M426_REAL_GIT, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(script, 0o700);

  if (process.platform === 'win32') {
    // execFileSync does not execute .cmd launchers. A Node hardlink gives the
    // test a real git.exe whose preload runs this shim before Node loads argv[1].
    // Repository context is always transported via cwd, never git -C, because
    // Node consumes -C as its own option before a preload can reconstruct argv.
    const launcher = join(dir, 'git.exe');
    try {
      linkSync(process.execPath, launcher);
    } catch {
      copyFileSync(process.execPath, launcher);
    }
    // NODE_OPTIONS applies shell-like backslash escaping even though it arrives
    // through the environment. Use Windows' accepted forward-slash spelling so
    // an absolute path such as C:\\Users\\... is not parsed as C:Users....
    const requireShim = `--require "${script.replaceAll('\\', '/')}"`;
    process.env.NODE_OPTIONS = [originalNodeOptions, requireShim].filter(Boolean).join(' ');
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

function prepareSandboxAuthorityRoot(): void {
  const fence = acquireOutwardMutationFence();
  if (!fence) throw new Error('M426 fixture could not prepare sandbox authority root');
  releaseOutwardMutationFence(fence);
}

beforeEach(() => {
  originalPath = process.env.PATH;
  originalNodeOptions = process.env.NODE_OPTIONS;
  originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  privateStorageHarness.useSemanticAdapter = process.platform === 'win32';
  fx = makeFixture();
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  delete process.env.M426_GIT_MODE;
  delete process.env.M426_REAL_GIT;
  delete process.env.M426_MARKER;
  delete process.env.M426_WORKTREE;
  delete process.env.M426_COMMON_REAL;
  delete process.env.M426_COMMON_ALIAS;
  delete process.env.M426_SOURCE_ALIAS;
  delete process.env.M426_REPLACEMENT_REPO;
  delete process.env.M426_SOURCE_GIT_DIR;
  delete process.env.M426_SOURCE_GIT_BACKUP;
  delete process.env.M426_REPLACEMENT_GIT_DIR;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
  try {
    fx.cleanup();
    cleanupTrackedPaths({ deferTransientWindowsLocks: true, maxRetries: 10 });
  } finally {
    privateStorageHarness.useSemanticAdapter = false;
  }
});

afterAll(() => {
  cleanupTrackedPaths({ deferTransientWindowsLocks: false, maxRetries: 15 });
}, 30_000);

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
    prepareSandboxAuthorityRoot();
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
      const physicalNative = realpathSync.native(physical);
      const driveCaseAlias = physicalNative.replace(/^([A-Za-z]):/u, (_match, drive: string) =>
        `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
      const caseIdentity = canonicalPathIdentity(join(driveCaseAlias, 'future-worktree'));
      expect(caseIdentity).toBe(canonicalPathIdentity(join(physicalNative, 'future-worktree')));
      expect(caseIdentity).not.toBeNull();
      expect(win32.isAbsolute(caseIdentity!)).toBe(true);
      expect(caseIdentity).not.toMatch(/^[\\/][A-Za-z]:/u);
      expect(caseIdentity).not.toMatch(/^[A-Za-z]::/u);

      const shortPathScript = join(fx.home, 'resolve-short-path.cmd');
      writeFileSync(
        shortPathScript,
        '@echo off\r\nfor %%I in ("%~1") do @echo %%~sI\r\n',
        'utf8',
      );
      const short = execFileSync(
        'cmd.exe',
        ['/d', '/c', shortPathScript, physical],
        { encoding: 'utf8', stdio: 'pipe' },
      ).trim().replace(/^"(.*)"$/u, '$1');
      expect(win32.isAbsolute(short)).toBe(true);
      expect(short).toMatch(/~\d/u);
      expect(canonicalPathIdentity(short)).toBe(canonicalPathIdentity(physical));
      const shortIdentity = canonicalPathIdentity(join(short, 'future-worktree'));
      expect(shortIdentity).toBe(canonicalPathIdentity(join(physical, 'future-worktree')));
      expect(shortIdentity).not.toMatch(/^[\\/][A-Za-z]:/u);
      expect(shortIdentity).not.toMatch(/^[A-Za-z]::/u);
    }


    expect(canonicalPathIdentity(join(alias, 'missing-one', 'missing-two', 'worktree')))
      .toBe(canonicalPathIdentity(join(physical, 'missing-one', 'missing-two', 'worktree')));
  });

  it('starts pinned Git commands with the subcommand instead of a global option', () => {
    const repo = fx.makeRepo();
    const marker = join(fx.home, 'pinned-git-argv.json');
    installGitShim('observe-pinned-argv');
    process.env.M426_MARKER = marker;

    const sandbox = createSandbox(repo.dir, { allowAnyRepo: true });
    try {
      const args = JSON.parse(readFileSync(marker, 'utf8')) as string[];
      expect(args[0]).toBe('worktree');
      expect(args[0]).not.toMatch(/^-/u);
    } finally {
      removeSandbox(sandbox);
    }
  });

  it('ignores inherited Git repository overrides during parent validation', () => {
    const source = fx.makeRepo();
    const replacement = fx.makeRepo();
    const expectedHead = git(source.dir, ['rev-parse', 'HEAD']);
    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    const previousGitCommonDir = process.env.GIT_COMMON_DIR;
    let sandbox: Sandbox;
    try {
      process.env.GIT_DIR = join(replacement.dir, '.git');
      process.env.GIT_WORK_TREE = replacement.dir;
      process.env.GIT_COMMON_DIR = join(replacement.dir, '.git');
      sandbox = createSandbox(source.dir, { allowAnyRepo: true });
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
      if (previousGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previousGitCommonDir;
    }
    try {
      expect(git(sandbox!.worktreePath, ['rev-parse', 'HEAD'])).toBe(expectedHead);
    } finally {
      removeSandbox(sandbox!);
    }
  });

  it('retains recovery authority when an absent worktree appears during rollback', () => {
    const source = fx.makeRepo();
    const marker = join(fx.home, 'appeared-during-rollback.txt');
    installGitShim('fail-add-then-appear-on-remove');
    process.env.M426_MARKER = marker;

    expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
      .toThrow(/git worktree add failed/u);
    const worktree = readFileSync(marker, 'utf8');
    const home = dirname(worktree);
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(home, 'sandbox.json'))).toBe(true);

    process.env.PATH = originalPath;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not report cleanup complete when Git retains an alias-spelled registration', () => {
    const repo = fx.makeRepo();
    prepareSandboxAuthorityRoot();
    const sandbox = createSandbox(repo.dir, { allowAnyRepo: true });
    const aliasHome = makeDirectoryAlias(fx.home);
    const aliasWorktree = join(aliasHome, relative(fx.home, sandbox.worktreePath));
    const worktreeGitFile = join(sandbox.worktreePath, '.git');
    const gitdirRecord = readFileSync(worktreeGitFile, 'utf8').trim();
    expect(gitdirRecord).toMatch(/^gitdir: /u);
    const worktreeAdminDir = resolve(
      sandbox.worktreePath,
      gitdirRecord.slice('gitdir: '.length),
    );
    const registrationGitdir = join(worktreeAdminDir, 'gitdir');
    const physicalRegistration = readFileSync(registrationGitdir, 'utf8');
    const aliasRegistration = `${join(aliasWorktree, '.git')}\n`;
    git(repo.dir, [
      'worktree', 'lock', '--reason', 'M426 retained registration', sandbox.worktreePath,
    ]);
    git(sandbox.worktreePath, ['checkout', '--detach']);
    writeFileSync(registrationGitdir, aliasRegistration, 'utf8');
    expect(readFileSync(registrationGitdir, 'utf8')).toBe(aliasRegistration);
    const retainedBefore = git(repo.dir, ['worktree', 'list', '--porcelain']);
    expect(retainedBefore).toContain(aliasWorktree);
    expect(retainedBefore).toContain('locked M426 retained registration');
    const cleanupMarker = join(fx.home, 'failed-worktree-cleanup.txt');
    installGitShim('fail-worktree-cleanup');
    process.env.M426_MARKER = cleanupMarker;

    try {
      const result = removeSandbox(sandbox);
      expect(result).toMatchObject({
        status: 'residual',
        postconditions: { registration: 'present', branch: 'absent', home: 'present' },
      });
      expect(result.failureClasses).toContain('worktree-remaining');
      expect(existsSync(sandbox.worktreePath)).toBe(true);
      expect(readFileSync(registrationGitdir, 'utf8')).toBe(aliasRegistration);
      expect(git(repo.dir, ['worktree', 'list', '--porcelain'])).toContain(aliasWorktree);
      const attemptedCleanup = readFileSync(cleanupMarker, 'utf8');
      expect(attemptedCleanup).toContain('worktree\0remove');
      expect(attemptedCleanup).toContain('worktree\0prune');
    } finally {
      process.env.PATH = originalPath;
      writeFileSync(registrationGitdir, physicalRegistration, 'utf8');
      try { git(repo.dir, ['worktree', 'unlock', sandbox.worktreePath]); } catch { /* best effort */ }
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

  it('keeps sandbox creation pinned to the enrolled repository when its alias is retargeted', () => {
    const source = fx.makeRepo();
    const replacement = fx.makeRepo();
    const alias = makeDirectoryAlias(source.dir);
    const marker = join(fx.home, 'retargeted-source.txt');
    const replacementBefore = observeRepository(replacement);
    expect(enroll(alias)).toMatchObject({ ok: true, quiesced: true });

    installGitShim('retarget-source');
    process.env.M426_MARKER = marker;
    process.env.M426_SOURCE_ALIAS = alias;
    process.env.M426_REPLACEMENT_REPO = replacement.dir;

    const sandbox = createSandbox(alias);
    try {
      expect(readFileSync(marker, 'utf8')).toBe('retargeted\n');
      expect(realpathSync.native(alias)).toBe(realpathSync.native(replacement.dir));
      expect(canonicalPathIdentity(sandbox.sourceRepo)).toBe(canonicalPathIdentity(source.dir));
      expect(branches(source.dir)).toContain(sandbox.branch);
      expect(observeRepository(replacement)).toEqual(replacementBefore);
    } finally {
      expect(removeSandbox(sandbox).status).toBe('complete');
    }
  });

  it('asserts enrollment against the pinned physical repository during an alias race', () => {
    const source = fx.makeRepo();
    const replacement = fx.makeRepo();
    const alias = makeDirectoryAlias(source.dir);
    const marker = join(fx.home, 'retargeted-before-enrollment.txt');
    const sourceBefore = observeRepository(source);
    const replacementBefore = observeRepository(replacement);
    expect(enroll(replacement.dir)).toMatchObject({ ok: true, quiesced: true });

    installGitShim('retarget-source');
    process.env.M426_MARKER = marker;
    process.env.M426_SOURCE_ALIAS = alias;
    process.env.M426_REPLACEMENT_REPO = replacement.dir;

    expect(() => createSandbox(alias)).toThrow(/repo not enrolled for autonomous work/u);
    expect(existsSync(marker)).toBe(false);
    expect(realpathSync.native(alias)).toBe(realpathSync.native(source.dir));
    expect(observeRepository(source)).toEqual(sourceBefore);
    expect(observeRepository(replacement)).toEqual(replacementBefore);
    expect(listSandboxes()).toEqual([]);
  });

  it('refuses a retargeted Git common directory before worktree effects', () => {
    const source = fx.makeRepo();
    const replacement = fx.makeRepo();
    const marker = join(fx.home, 'retargeted-common-dir.txt');
    const sourceGitDir = join(source.dir, '.git');
    const sourceGitBackup = join(source.dir, '.git.m426-original');
    const sourceBefore = observeRepository(source);
    const replacementBefore = observeRepository(replacement);

    installGitShim('retarget-common-dir');
    process.env.M426_MARKER = marker;
    process.env.M426_SOURCE_GIT_DIR = sourceGitDir;
    process.env.M426_SOURCE_GIT_BACKUP = sourceGitBackup;
    process.env.M426_REPLACEMENT_GIT_DIR = join(replacement.dir, '.git');

    try {
      expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
        .toThrow(/Git common directory identity changed/u);
      expect(readFileSync(marker, 'utf8')).toBe('retargeted\n');
    } finally {
      rmSync(sourceGitDir, { recursive: true, force: true });
      if (existsSync(sourceGitBackup)) renameSync(sourceGitBackup, sourceGitDir);
    }

    expect(observeRepository(source)).toEqual(sourceBefore);
    expect(observeRepository(replacement)).toEqual(replacementBefore);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a physical source replacement during repository discovery before effects',
    () => {
      const source = fx.makeRepo();
      const replacement = fx.makeRepo();
      const sourceBackup = `${source.dir}.m426-original`;
      const marker = join(fx.home, 'retargeted-source-discovery.txt');
      const sourceBefore = observeRepository(source);
      const replacementBefore = observeRepository(replacement);
      cleanupPaths.add(sourceBackup);

      installGitShim('retarget-source-path-during-discovery');
      process.env.M426_MARKER = marker;
      process.env.M426_SOURCE_ALIAS = source.dir;
      process.env.M426_SOURCE_GIT_BACKUP = sourceBackup;
      process.env.M426_REPLACEMENT_REPO = replacement.dir;

      try {
        expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
          .toThrow(/repository.*identity changed|discovery identity changed/u);
        expect(readFileSync(marker, 'utf8')).toBe('retargeted\n');
        expect(observeRepository(replacement)).toEqual(replacementBefore);
        expect(listSandboxes()).toEqual([]);
      } finally {
        rmSync(source.dir, { recursive: true, force: true });
        renameSync(sourceBackup, source.dir);
      }
      expect(observeRepository(source)).toEqual(sourceBefore);
    },
  );

  it('keeps Git effects on the retained common directory when its source path retargets', () => {
    const source = fx.makeRepo();
    const replacement = fx.makeRepo();
    const marker = join(fx.home, 'retargeted-during-worktree-add.txt');
    const sourceGitDir = join(source.dir, '.git');
    const sourceGitBackup = `${source.dir}.git.m426-original`;
    const sourceBefore = observeRepository(source);
    const replacementBefore = observeRepository(replacement);
    cleanupPaths.add(sourceGitBackup);
    renameSync(sourceGitDir, sourceGitBackup);
    symlinkSync(sourceGitBackup, sourceGitDir, process.platform === 'win32' ? 'junction' : 'dir');

    installGitShim('retarget-during-worktree-add');
    process.env.M426_MARKER = marker;
    process.env.M426_SOURCE_GIT_DIR = sourceGitDir;
    process.env.M426_REPLACEMENT_GIT_DIR = join(replacement.dir, '.git');

    let sandbox: Sandbox | undefined;
    try {
      sandbox = createSandbox(source.dir, { allowAnyRepo: true });
      expect(readFileSync(marker, 'utf8')).toBe('retargeted\n');
      expect(branches(sourceGitBackup)).toContain(sandbox.branch);
      expect(observeRepository(replacement)).toEqual(replacementBefore);

      rmSync(sourceGitDir, { recursive: true, force: true });
      symlinkSync(sourceGitBackup, sourceGitDir, process.platform === 'win32' ? 'junction' : 'dir');
      expect(removeSandbox(sandbox).status).toBe('complete');
      sandbox = undefined;
    } finally {
      rmSync(sourceGitDir, { recursive: true, force: true });
      if (existsSync(sourceGitBackup)) renameSync(sourceGitBackup, sourceGitDir);
    }

    expect(sandbox).toBeUndefined();
    expect(observeRepository(source)).toEqual(sourceBefore);
  });

  it('refuses post-create writes when the created sandbox home is replaced', () => {
    const source = fx.makeRepo();
    mkdirSync(join(source.dir, 'node_modules'));
    const marker = join(fx.home, 'retargeted-after-worktree-add.json');
    installGitShim('retarget-after-worktree-add');
    process.env.M426_MARKER = marker;

    expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
      .toThrow(/sandbox reservation identity changed during git command/u);
    const { home, backup } = JSON.parse(readFileSync(marker, 'utf8')) as {
      home: string;
      backup: string;
    };
    expect(existsSync(join(home, 'worktree', 'node_modules'))).toBe(false);

    const sandbox = JSON.parse(readFileSync(join(backup, 'sandbox.json'), 'utf8')) as Sandbox;
    rmSync(home, { recursive: true, force: true });
    renameSync(backup, home);
    expect(removeSandbox(sandbox).status).toBe('complete');
  });

  it('performs node_modules and exclude writes under the pinned worktree authority', () => {
    const source = fx.makeRepo();
    mkdirSync(join(source.dir, 'node_modules'));

    const sandbox = createSandbox(source.dir, { allowAnyRepo: true });
    try {
      expect(realpathSync.native(join(sandbox.worktreePath, 'node_modules')))
        .toBe(realpathSync.native(join(source.dir, 'node_modules')));
      const gitdir = git(sandbox.worktreePath, ['rev-parse', '--git-dir']);
      const absoluteGitdir = realpathSync.native(resolve(sandbox.worktreePath, gitdir));
      expect(readFileSync(join(absoluteGitdir, 'info', 'exclude'), 'utf8'))
        .toMatch(/^node_modules$/mu);
    } finally {
      expect(removeSandbox(sandbox).status).toBe('complete');
    }
  });

  for (const targetKind of ['home', 'parent'] as const) {
    it(`fails closed when the reserved sandbox ${targetKind} retargets during worktree add`, () => {
      const source = fx.makeRepo();
      const marker = join(fx.home, `retargeted-sandbox-${targetKind}.json`);
      const sourceBefore = observeRepository(source);

      installGitShim(targetKind === 'home' ? 'retarget-sandbox-home' : 'retarget-sandbox-parent');
      process.env.M426_MARKER = marker;

      expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
        .toThrow(/sandbox reservation identity changed during git command/u);
      const { target, backup } = JSON.parse(readFileSync(marker, 'utf8')) as {
        target: string;
        backup: string;
      };
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);

      expect(observeRepository(source)).toEqual(sourceBefore);
      rmSync(targetKind === 'home' ? target : sandboxesDir(), { recursive: true, force: true });
      expect(listSandboxes()).toEqual([]);
    });
  }

  it('joins a hanging Git descendant tree before sandbox creation returns', () => {
    const source = fx.makeRepo();
    const marker = join(fx.home, 'hanging-git-descendant.json');
    const sourceBefore = observeRepository(source);

    installGitShim('hang-worktree-descendant');
    process.env.M426_MARKER = marker;

    expect(() => createSandbox(source.dir, { allowAnyRepo: true }))
      .toThrow(/git worktree add failed/u);
    const observation = JSON.parse(readFileSync(marker, 'utf8')) as {
      shimPid: number;
      descendantPid: number;
    };
    expect(readFileSync(`${marker}.alive`, 'utf8')).toBe(String(observation.descendantPid));
    expect(() => process.kill(observation.shimPid, 0)).toThrow();
    expect(() => process.kill(observation.descendantPid, 0)).toThrow();
    expect(observeRepository(source)).toEqual(sourceBefore);
    expect(listSandboxes()).toEqual([]);
  });

  it('does not authorize a new physical repository after an ancestor alias is retargeted', () => {
    const original = fx.makeRepo({ prefix: 'ashlr-m426-original-' });
    const replacement = fx.makeRepo({ prefix: 'ashlr-m426-replacement-' });
    const originalRoot = join(fx.home, 'original-root');
    const replacementRoot = join(fx.home, 'replacement-root');
    const repoName = 'project';
    mkdirSync(originalRoot);
    mkdirSync(replacementRoot);
    const originalRepo = join(originalRoot, repoName);
    const replacementRepo = join(replacementRoot, repoName);
    renameSync(original.dir, originalRepo);
    renameSync(replacement.dir, replacementRepo);

    const ancestorAlias = join(fx.home, 'repo-root');
    symlinkSync(originalRoot, ancestorAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const enrolledAlias = join(ancestorAlias, repoName);
    expect(enroll(enrolledAlias)).toMatchObject({ ok: true, quiesced: true });
    expect(isEnrolled(originalRepo)).toBe(true);

    rmSync(ancestorAlias, { recursive: true, force: true });
    symlinkSync(replacementRoot, ancestorAlias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(realpathSync.native(enrolledAlias)).toBe(realpathSync.native(replacementRepo));
    expect(isEnrolled(enrolledAlias)).toBe(false);
    expect(() => createSandbox(enrolledAlias)).toThrow(/repo not enrolled for autonomous work/u);
    expect(git(replacementRepo, ['branch', '--format=%(refname:short)'])).toBe('main');
  });
});
