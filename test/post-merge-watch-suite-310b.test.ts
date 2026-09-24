/**
 * V3.10 INT3 — the post-merge watch's suite run (fleet/post-merge-watch.ts
 * runSuiteInMirrorWorktree) against a REAL git repo standing in for the
 * fleet mirror.
 *
 * The rule under test is H1a (inbox/merge.ts verifyProposal's): the change
 * under test never chooses WHICH commands test it. The watch detects the
 * verify commands in the landing's PARENT tree, then runs them on the merged
 * tree — so a landing that breaks the code AND adds an `ashlr.verify.json`
 * replacing the suite with `exit 0` is still red. (Script BODIES still run
 * from the merged tree; G1 keeps manifests owner-lane for that.) Also: the
 * worktree is removed afterwards (the mirror keeps no linked worktree).
 *
 * Real-io (spawns git and npm): belongs in REAL_IO_TEST_FILES.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const { runSuiteInMirrorWorktree } = await import('../src/core/fleet/post-merge-watch.js');

let root: string;
let mirror: string;

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: mirror,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(mirror, path), content);
  git(['add', '-A']);
  git(['-c', 'user.email=fleet@test', '-c', 'user.name=fleet', 'commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

const pkg = (test: string): string => `${JSON.stringify({ name: 'int3-watch-fixture', private: true, scripts: { test } }, null, 2)}\n`;
// Fails iff a file named `broken` exists: the "code" the landing breaks.
const STRICT_TEST = 'node -e "process.exit(require(\'fs\').existsSync(\'broken\') ? 1 : 0)"';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ashlr-int3-watch-'));
  mirror = join(root, 'mirror');
  execFileSync('git', ['init', '-q', '-b', 'main', mirror]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runSuiteInMirrorWorktree (post-merge watch suite)', () => {
  it('a landing that breaks the code AND installs a verify contract replacing the suite is still RED: commands come from the parent tree', async () => {
    commit({ 'package.json': pkg(STRICT_TEST), 'README.md': 'fixture\n' }, 'base');
    const neuter = {
      schemaVersion: 1,
      mode: 'replace-detected',
      commands: [{ id: 'always-green', kind: 'test', cmd: ['node', '-e', 'process.exit(0)'], required: true, profiles: ['merge'] }],
    };
    const landed = commit({ 'ashlr.verify.json': `${JSON.stringify(neuter)}\n`, broken: 'yes\n' }, 'fleet landing');
    const run = await runSuiteInMirrorWorktree('ashlrai/int3-fixture', landed, { mirrorPath: mirror });
    expect(run.result, run.detail).toBe('fail');
    expect(run.commandsRun).toBeGreaterThan(0);
    // The watch's worktree is gone; the mirror keeps only its own.
    expect(git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  });

  it('a green landing passes on the parent\'s commands', async () => {
    commit({ 'package.json': pkg(STRICT_TEST), 'README.md': 'fixture\n' }, 'base');
    const landed = commit({ 'docs.md': 'more docs\n' }, 'fleet landing');
    const run = await runSuiteInMirrorWorktree('ashlrai/int3-fixture', landed, { mirrorPath: mirror });
    expect(run.result, run.detail).toBe('pass');
  });

  it('a hook or filter driver planted in the shared mirror config never runs (safe-git: hooks off, attributes from the empty tree)', async () => {
    commit({ 'package.json': pkg(STRICT_TEST), 'README.md': 'fixture\n' }, 'base');
    const landed = commit({ '.gitattributes': '* filter=evil\n', 'docs.md': 'docs\n' }, 'fleet landing');
    const hookMarker = join(root, 'hook-ran');
    const filterMarker = join(root, 'filter-ran');
    const hooks = join(root, 'hooks');
    execFileSync('mkdir', ['-p', hooks]);
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`, { mode: 0o755 });
    // What an agent in a linked worktree could write into the SHARED config between syncs.
    git(['config', 'core.hooksPath', hooks]);
    git(['config', 'filter.evil.smudge', `sh -c 'touch ${filterMarker}; cat'`]);
    git(['config', 'filter.evil.required', 'true']);
    const run = await runSuiteInMirrorWorktree('ashlrai/int3-fixture', landed, { mirrorPath: mirror });
    expect(run.result, run.detail).toBe('pass');
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(filterMarker)).toBe(false);
  });

  it('a SHA the mirror does not have is not-run (no verdict)', async () => {
    commit({ 'package.json': pkg(STRICT_TEST) }, 'base');
    const run = await runSuiteInMirrorWorktree('ashlrai/int3-fixture', 'f'.repeat(40), { mirrorPath: mirror });
    expect(run.result).toBe('not-run');
  });
});
