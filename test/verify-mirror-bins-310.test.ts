/**
 * V3.10 P1 — confined verification finds the MIRROR's tools.
 *
 * The verify worktree's `node_modules` is a symlink to the fleet mirror's
 * install (inbox/merge.ts linkVerifyNodeModules), granted READ-ONLY to the
 * sandbox. The first cut of openStandingVerificationConfinement kept only
 * PATH entries that RESOLVE inside the worktree, so `<wt>/node_modules/.bin`
 * (resolving into the mirror) was dropped: a bare `tsc` / `vitest` / `eslint`
 * verify command could not run confined at all. Now the granted dir's real
 * `.bin` goes on PATH — for merge G3 and the post-merge watch alike — and a
 * pnpm workspace's package-level installs are linked and granted too.
 *
 * The darwin cases run the REAL sandbox-exec (skipped elsewhere). HOME is the
 * per-test isolated home (test/setup); everything lives under it.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const standing = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => standing.policy,
}));

const { confinedWorkspaceBins, linkVerifyNodeModules, openStandingVerificationConfinement } = await import('../src/core/inbox/merge.js');
const { runVerifyCommandAsync } = await import('../src/core/run/verify-commands.js');
const { runSuiteInMirrorWorktree } = await import('../src/core/fleet/post-merge-watch.js');
type AshlrConfig = import('../src/core/types.js').AshlrConfig;

const onDarwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

let root: string;

beforeEach(() => {
  standing.policy = null;
  const home = realpathSync(homedir());
  mkdirSync(join(home, '.ashlr', 'tmp'), { recursive: true, mode: 0o700 });
  root = realpathSync(mkdtempSync(join(home, '.ashlr', 'tmp', 'p1-bins-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tool(dir: string, name: string, says: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho ${says}\n`);
  chmodSync(file, 0o755);
}

/** A pnpm-workspace "mirror": root install + packages/a's own install; packages/b has none. */
function pnpmMirror(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "name": "ws", "private": true }\n');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  tool(join(dir, 'node_modules', '.bin'), 'p1tool', 'p1tool-ran');
  for (const pkg of ['a', 'b']) {
    mkdirSync(join(dir, 'packages', pkg), { recursive: true });
    writeFileSync(join(dir, 'packages', pkg, 'package.json'), `{ "name": "${pkg}" }\n`);
  }
  tool(join(dir, 'packages', 'a', 'node_modules', '.bin'), 'p1pkgtool', 'p1pkgtool-ran');
}

/** A "worktree" of the mirror: the tracked files only (no installs). */
function checkout(mirror: string, wt: string): void {
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, 'package.json'), '{ "name": "ws", "private": true }\n');
  for (const pkg of ['a', 'b']) {
    mkdirSync(join(wt, 'packages', pkg), { recursive: true });
    writeFileSync(join(wt, 'packages', pkg, 'package.json'), `{ "name": "${pkg}" }\n`);
  }
  void mirror;
}

describe('confinedWorkspaceBins', () => {
  it('replaces a worktree .bin that resolves into a GRANT with the grant\'s real .bin; drops it without the grant', () => {
    const mirror = join(root, 'mirror');
    const wt = join(root, 'wt');
    pnpmMirror(mirror);
    checkout(mirror, wt);
    symlinkSync(join(mirror, 'node_modules'), join(wt, 'node_modules'), 'dir');
    const path = [join(wt, 'node_modules', '.bin'), '/usr/bin'].join(delimiter);
    const granted = realpathSync(join(mirror, 'node_modules'));
    expect(confinedWorkspaceBins(path, wt, realpathSync(wt), [granted])).toEqual([join(granted, '.bin')]);
    // The old behaviour — and still the rule for an ungranted target.
    expect(confinedWorkspaceBins(path, wt, realpathSync(wt), [])).toEqual([]);
  });

  it('keeps a real .bin inside the worktree as-is and drops a planted link to an ungranted dir', () => {
    const wt = join(root, 'wt');
    tool(join(wt, 'node_modules', '.bin'), 'own', 'own');
    const elsewhere = join(root, 'elsewhere', 'node_modules');
    tool(join(elsewhere, '.bin'), 'evil', 'evil');
    mkdirSync(join(wt, 'packages', 'x'), { recursive: true });
    symlinkSync(elsewhere, join(wt, 'packages', 'x', 'node_modules'), 'dir');
    const path = [join(wt, 'packages', 'x', 'node_modules', '.bin'), join(wt, 'node_modules', '.bin'), join(elsewhere, '.bin')].join(delimiter);
    // The third entry lies outside the worktree: never kept, even though it exists.
    expect(confinedWorkspaceBins(path, wt, realpathSync(wt), [])).toEqual([join(wt, 'node_modules', '.bin')]);
  });
});

describe('linkVerifyNodeModules', () => {
  it('pnpm workspace: links the root AND each package\'s own install, and returns exactly those grants', () => {
    const mirror = join(root, 'mirror');
    const wt = join(root, 'wt');
    pnpmMirror(mirror);
    checkout(mirror, wt);
    const grants = linkVerifyNodeModules(mirror, wt);
    expect(grants).toEqual([join(mirror, 'node_modules'), join(mirror, 'packages', 'a', 'node_modules')]);
    expect(readlinkSync(join(wt, 'node_modules'))).toBe(join(mirror, 'node_modules'));
    expect(readlinkSync(join(wt, 'packages', 'a', 'node_modules'))).toBe(join(mirror, 'packages', 'a', 'node_modules'));
    expect(existsSync(join(wt, 'packages', 'b', 'node_modules'))).toBe(false); // no install there
  });

  it('package.json `workspaces` counts as a workspace; a plain repo links only the root', () => {
    const mirror = join(root, 'mirror');
    pnpmMirror(mirror);
    rmSync(join(mirror, 'pnpm-workspace.yaml'));
    const plain = join(root, 'wt-plain');
    checkout(mirror, plain);
    expect(linkVerifyNodeModules(mirror, plain)).toEqual([join(mirror, 'node_modules')]);
    expect(existsSync(join(plain, 'packages', 'a', 'node_modules'))).toBe(false);

    writeFileSync(join(mirror, 'package.json'), '{ "name": "ws", "private": true, "workspaces": ["packages/*"] }\n');
    const ws = join(root, 'wt-ws');
    checkout(mirror, ws);
    expect(linkVerifyNodeModules(mirror, ws)).toContain(join(mirror, 'packages', 'a', 'node_modules'));
  });

  it('never writes through a symlinked package dir and never replaces an existing node_modules', () => {
    const mirror = join(root, 'mirror');
    const wt = join(root, 'wt');
    pnpmMirror(mirror);
    checkout(mirror, wt);
    // packages/a in the worktree is a planted link to a directory outside it.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), '{}\n');
    rmSync(join(wt, 'packages', 'a'), { recursive: true });
    symlinkSync(outside, join(wt, 'packages', 'a'), 'dir');
    const grants = linkVerifyNodeModules(mirror, wt);
    expect(grants).toEqual([join(mirror, 'node_modules')]);
    expect(existsSync(join(outside, 'node_modules'))).toBe(false);

    const wt2 = join(root, 'wt2');
    checkout(mirror, wt2);
    mkdirSync(join(wt2, 'packages', 'a', 'node_modules'));
    expect(linkVerifyNodeModules(mirror, wt2)).toEqual([join(mirror, 'node_modules')]);
    expect(lstatSync(join(wt2, 'packages', 'a', 'node_modules')).isSymbolicLink()).toBe(false);
  });
});

describe('confined verification runs bare mirror tools (darwin sandbox)', () => {
  it.skipIf(!onDarwin)('G3: a bare root tool and a pnpm package tool both run confined; without the grant they cannot', async () => {
    standing.policy = { grantId: 'g' };
    const mirror = join(root, 'mirror');
    const wt = join(root, 'wt');
    pnpmMirror(mirror);
    checkout(mirror, wt);
    const grants = linkVerifyNodeModules(mirror, wt);
    const cfg = {} as AshlrConfig;

    const confined = await openStandingVerificationConfinement(wt, { readOnlyPaths: grants });
    expect(confined).not.toBeNull();
    try {
      const opts = { _runSubprocess: confined!.runSubprocess, timeoutMs: 30_000 };
      const rootTool = await runVerifyCommandAsync({ kind: 'test', cmd: ['p1tool'], required: true }, wt, cfg, opts);
      expect(rootTool.ok, rootTool.output).toBe(true);
      expect(rootTool.output).toContain('p1tool-ran');
      const pkgTool = await runVerifyCommandAsync({ kind: 'test', cmd: ['p1pkgtool'], cwd: 'packages/a', required: true }, wt, cfg, opts);
      expect(pkgTool.ok, pkgTool.output).toBe(true);
      expect(pkgTool.output).toContain('p1pkgtool-ran');
    } finally {
      confined!.close();
    }

    const ungranted = await openStandingVerificationConfinement(wt, { readOnlyPaths: [] });
    try {
      const r = await runVerifyCommandAsync({ kind: 'test', cmd: ['p1tool'], required: true }, wt, cfg, { _runSubprocess: ungranted!.runSubprocess, timeoutMs: 30_000 });
      expect(r.ok).toBe(false);
    } finally {
      ungranted!.close();
    }
  });

  it.skipIf(process.platform === 'win32')('post-merge watch (no grant): a package-scoped contract command runs in the package — its cwd is rebased off the removed detect tree', async () => {
    standing.policy = null;
    const landed = mirrorWithContract(join(root, 'mirror'));
    const run = await runSuiteInMirrorWorktree('ashlrai/p1-bins', landed, { mirrorPath: join(root, 'mirror') });
    expect(run.result, run.detail).toBe('pass');
    expect(run.commandsRun).toBe(2);
  });

  it.skipIf(!onDarwin)('post-merge watch: the suite runs bare mirror tools (root and package) confined and passes', async () => {
    standing.policy = { grantId: 'g' };
    const landed = mirrorWithContract(join(root, 'mirror'));
    const run = await runSuiteInMirrorWorktree('ashlrai/p1-bins', landed, { mirrorPath: join(root, 'mirror') });
    expect(run.result, run.detail).toBe('pass');
    expect(run.commandsRun).toBe(2);
  });
});

/** A git mirror (pnpm workspace + installs) whose contract runs a root tool and a package tool; returns the landing SHA. */
function mirrorWithContract(mirror: string): string {
  pnpmMirror(mirror);
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: mirror,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q', '-b', 'main']);
  const contract = {
    schemaVersion: 1,
    mode: 'replace-detected',
    commands: [
      { id: 'root-tool', kind: 'test', cmd: ['p1tool'], required: true, profiles: ['merge'] },
      { id: 'pkg-tool', kind: 'test', cmd: ['p1pkgtool'], cwd: 'packages/a', required: true, profiles: ['merge'] },
    ],
  };
  writeFileSync(join(mirror, 'ashlr.verify.json'), `${JSON.stringify(contract)}\n`);
  const commit = (message: string): string => {
    git(['add', '-A']);
    git(['-c', 'user.email=fleet@test', '-c', 'user.name=fleet', 'commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  commit('base');
  writeFileSync(join(mirror, 'docs.md'), 'docs\n');
  return commit('fleet landing');
}
