/**
 * V3.10 Track B unit U2 — daemon git on agent-touched trees
 * (src/core/sandbox/safe-git.ts). Real git in temp repos under the isolated
 * HOME; every "evil" program here only writes a marker file, and the tests
 * assert the markers never appear.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SafeGitError,
  githubRemoteUrl,
  runSafeGit,
  runSafeGitSync,
  safeGitCommand,
  verifyGitTarget,
} from '../src/core/sandbox/safe-git.js';

interface World {
  root: string;
  mirror: string;
  common: string;
  worktree: string;
  gitDir: string;
  markers: string;
  evil: string;
}

/** Fixture setup uses plain git on purpose: the TEST builds the world, safe-git operates on it. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function makeWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'safe-git-')));
  const mirror = join(root, 'mirror');
  mkdirSync(mirror);
  git(mirror, 'init', '-q');
  writeFileSync(join(mirror, 'a.txt'), 'hello\n');
  git(mirror, 'add', 'a.txt');
  git(mirror, 'commit', '-q', '-m', 'init');
  const worktree = join(root, 'sandboxes', 'sb1');
  mkdirSync(join(root, 'sandboxes'));
  git(mirror, 'worktree', 'add', '-q', '-b', 'sb1', worktree, 'main');
  const markers = join(root, 'markers');
  mkdirSync(markers);
  const evil = join(root, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\ntouch "${markers}/$(basename "$0")-$$-ran"\ncat\n`, { mode: 0o755 });
  return { root, mirror, common: join(mirror, '.git'), worktree, gitDir: join(mirror, '.git', 'worktrees', 'sb1'), markers, evil };
}

const markersOf = (w: World): string[] => readdirSync(w.markers);

let w: World;
beforeEach(() => { w = makeWorld(); });
afterEach(() => { rmSync(w.root, { recursive: true, force: true }); });

describe('verified .git', () => {
  it('accepts the worktree the daemon created and runs git against its explicit git dir', () => {
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: w.gitDir })).toMatchObject({ ok: true, commonDir: w.common });
    const r = runSafeGitSync({ workTree: w.worktree, gitDir: w.gitDir, args: ['rev-parse', '--abbrev-ref', 'HEAD'] });
    expect(r).toMatchObject({ ok: true, stdout: 'sb1\n' });
  });

  it('refuses a .git the agent replaced with a directory full of planted config', () => {
    rmSync(join(w.worktree, '.git'));
    mkdirSync(join(w.worktree, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(w.worktree, '.git', 'config'), `[core]\n\tfsmonitor = ${w.evil}\n\thooksPath = ${w.root}\n`);
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: w.gitDir })).toMatchObject({ ok: false, reason: expect.stringMatching(/replaced/) });
    expect(() => runSafeGitSync({ workTree: w.worktree, gitDir: w.gitDir, args: ['status'] })).toThrow(SafeGitError);
    expect(markersOf(w)).toEqual([]);
  });

  it('refuses a .git redirected at another repository (e.g. Mason’s own checkout)', () => {
    const other = join(w.root, 'masons-checkout');
    mkdirSync(other);
    git(other, 'init', '-q');
    writeFileSync(join(w.worktree, '.git'), `gitdir: ${join(other, '.git')}\n`);
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: w.gitDir })).toMatchObject({ ok: false, reason: expect.stringMatching(/different git directory/) });
  });

  it('refuses a symlinked .git, a missing .git and a git dir inside the worktree', () => {
    rmSync(join(w.worktree, '.git'));
    symlinkSync(w.gitDir, join(w.worktree, '.git'));
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: w.gitDir }).ok).toBe(false);
    rmSync(join(w.worktree, '.git'));
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: w.gitDir })).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
    const inside = join(w.worktree, 'fake-gitdir');
    mkdirSync(inside);
    writeFileSync(join(w.worktree, '.git'), `gitdir: ${inside}\n`);
    expect(verifyGitTarget({ workTree: w.worktree, gitDir: inside })).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the worktree/) });
  });

  it('refuses a git dir that belongs to a different worktree', () => {
    const second = join(w.root, 'sandboxes', 'sb2');
    git(w.mirror, 'worktree', 'add', '-q', '-b', 'sb2', second, 'main');
    expect(verifyGitTarget({ workTree: second, gitDir: w.gitDir }).ok).toBe(false);
  });

  it("layout 'repo' is for the mirror itself", () => {
    expect(verifyGitTarget({ workTree: w.mirror, gitDir: w.common, layout: 'repo' })).toMatchObject({ ok: true });
    expect(verifyGitTarget({ workTree: w.mirror, gitDir: w.common }).ok).toBe(false);
  });
});

describe('planted hooks stay inert', () => {
  it('hooks, fsmonitor, filters, diff drivers, aliases and helpers from every config source never run', async () => {
    // 1. Hooks in the common dir (as if the mirror were compromised).
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction', 'post-index-change', 'pre-auto-gc']) {
      writeFileSync(join(w.common, 'hooks', hook), `#!/bin/sh\ntouch "${w.markers}/hook-${hook}"\n`, { mode: 0o755 });
    }
    // 2. Executables in the (trusted) repo config.
    git(w.mirror, 'config', 'core.fsmonitor', w.evil);
    git(w.mirror, 'config', 'filter.evil.clean', w.evil);
    git(w.mirror, 'config', 'filter.evil.smudge', w.evil);
    git(w.mirror, 'config', 'diff.evil.textconv', w.evil);
    git(w.mirror, 'config', 'credential.helper', `!${w.evil}`);
    git(w.mirror, 'config', 'core.sshCommand', w.evil);
    // 3. A global config in the daemon's HOME and an attributes file the agent wrote.
    const home = process.env['HOME']!;
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${w.root}/global-hooks\n\tfsmonitor = ${w.evil}\n[filter "g"]\n\tclean = ${w.evil}\n[alias]\n\tst = !${w.evil}\n`);
    mkdirSync(join(w.root, 'global-hooks'));
    writeFileSync(join(w.root, 'global-hooks', 'pre-commit'), `#!/bin/sh\ntouch "${w.markers}/global-hook"\n`, { mode: 0o755 });
    writeFileSync(join(w.worktree, '.gitattributes'), '* filter=evil diff=evil\n*.txt filter=g\n');
    writeFileSync(join(w.worktree, 'b.txt'), 'agent work\n');

    try {
      const t = { workTree: w.worktree, gitDir: w.gitDir, identity: { name: 'ashlr-fleet[bot]', email: 'fleet@ashlr.invalid' } };
      expect(runSafeGitSync({ ...t, args: ['status', '--porcelain'] }).ok).toBe(true);
      expect(runSafeGitSync({ ...t, args: ['add', '-A'] }).ok).toBe(true);
      expect(runSafeGitSync({ ...t, args: ['commit', '-q', '-m', 'fleet: add b'] })).toMatchObject({ ok: true });
      expect((await runSafeGit({ ...t, args: ['diff', 'HEAD~1', '--stat'] })).ok).toBe(true);
      expect(runSafeGitSync({ ...t, args: ['log', '-p', '-1'] }).ok).toBe(true);
      expect(runSafeGitSync({ ...t, args: ['checkout', '-q', '-b', 'sb1-copy'] }).ok).toBe(true);
      expect(runSafeGitSync({ ...t, args: ['log', '-1', '--format=%an <%ae>'] }).stdout).toBe('ashlr-fleet[bot] <fleet@ashlr.invalid>\n');
      expect(markersOf(w)).toEqual([]);
    } finally {
      rmSync(join(home, '.gitconfig'), { force: true });
    }
  });

  it('an agent-written .gitattributes cannot reach a driver configured in the mirror (SHA-1 and SHA-256 repos)', () => {
    for (const format of ['sha1', 'sha256']) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `safe-git-${format}-`)));
      try {
        const mirror = join(root, 'mirror');
        mkdirSync(mirror);
        git(mirror, 'init', '-q', `--object-format=${format}`);
        writeFileSync(join(mirror, 'a.txt'), 'hello\n');
        git(mirror, 'add', 'a.txt');
        git(mirror, 'commit', '-q', '-m', 'init');
        const worktree = join(root, 'wt');
        git(mirror, 'worktree', 'add', '-q', '-b', 'wt', worktree, 'main');
        const marker = join(root, 'filter-ran');
        writeFileSync(join(root, 'lfs-like.sh'), `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
        git(mirror, 'config', 'filter.lfs.clean', join(root, 'lfs-like.sh'));
        git(mirror, 'config', 'filter.lfs.smudge', join(root, 'lfs-like.sh'));
        writeFileSync(join(worktree, '.gitattributes'), '* filter=lfs\n');
        writeFileSync(join(worktree, 'big.bin'), 'agent\n');
        const t = { workTree: worktree, gitDir: join(mirror, '.git', 'worktrees', 'wt'), identity: { name: 'bot', email: 'bot@ashlr.invalid' } };
        expect(runSafeGitSync({ ...t, args: ['add', '-A'] }).ok, format).toBe(true);
        expect(runSafeGitSync({ ...t, args: ['commit', '-q', '-m', 'x'] }).ok, format).toBe(true);
        expect(runSafeGitSync({ ...t, args: ['checkout', '-q', 'HEAD~1'] }).ok, format).toBe(true);
        expect(existsSync(marker), format).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('ignores GIT_* pollution in the daemon environment', () => {
    const saved = { ...process.env };
    try {
      process.env['GIT_DIR'] = join(w.root, 'nowhere');
      process.env['GIT_EXEC_PATH'] = w.root;
      process.env['GIT_CONFIG_PARAMETERS'] = `'core.fsmonitor'='${w.evil}'`;
      process.env['GIT_ASKPASS'] = w.evil;
      const r = runSafeGitSync({ workTree: w.worktree, gitDir: w.gitDir, args: ['status', '--porcelain'] });
      expect(r.ok).toBe(true);
      expect(markersOf(w)).toEqual([]);
    } finally {
      process.env = saved;
    }
  });

  it('speaks https only: ext:: and file:// transports go nowhere', () => {
    const t = { workTree: w.worktree, gitDir: w.gitDir };
    const ext = runSafeGitSync({ ...t, args: ['ls-remote', `ext::sh -c touch% ${w.markers}/ext-ran`], timeoutMs: 10_000 });
    expect(ext.ok).toBe(false);
    expect(existsSync(join(w.markers, 'ext-ran'))).toBe(false);
    expect(runSafeGitSync({ ...t, args: ['ls-remote', `file://${w.mirror}`], timeoutMs: 10_000 }).ok).toBe(false);
    expect(runSafeGitSync({ ...t, args: ['ls-remote', `file://${w.mirror}`], allowProtocols: ['file'], timeoutMs: 10_000 }).ok).toBe(true);
  });
});

describe('ephemeral token headers', () => {
  const token = `ghs_${'Zz09'.repeat(9)}`;

  it('carries the token only in the child env, as a github.com-scoped header, resetting planted headers', () => {
    git(w.mirror, 'config', 'http.extraHeader', 'X-Planted: 1');
    const cmd = safeGitCommand({ workTree: w.worktree, gitDir: w.gitDir, args: ['config', '--get-all', 'http.extraheader'], auth: { token } });
    expect(cmd.args.join(' ')).not.toContain(token);
    expect(JSON.stringify(cmd.args)).not.toMatch(/AUTHORIZATION/i);
    expect(Object.values(cmd.env).join('\n')).toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));

    // Git's http layer applies extraHeader values in scope order and an empty
    // value clears the list: the planted repo ("local") header comes first,
    // then safe-git's empty "command" entry — so it is cleared.
    const generic = runSafeGitSync({ workTree: w.worktree, gitDir: w.gitDir, args: ['config', '--show-scope', '--get-all', 'http.extraheader'], auth: { token } });
    expect(generic.stdout).toBe('local\tX-Planted: 1\ncommand\t\n');
    const scoped = runSafeGitSync({
      workTree: w.worktree, gitDir: w.gitDir, auth: { token },
      args: ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/ashlrai/fleet-canary.git'],
    });
    expect(scoped.stdout.trim()).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
    const elsewhere = runSafeGitSync({
      workTree: w.worktree, gitDir: w.gitDir, auth: { token },
      args: ['config', '--get-urlmatch', 'http.extraheader', 'https://evil.example.com/x.git'],
    });
    expect(elsewhere.stdout).not.toContain('AUTHORIZATION');
  });

  it('never writes the token into the repository config', () => {
    runSafeGitSync({ workTree: w.worktree, gitDir: w.gitDir, args: ['status'], auth: { token } });
    expect(git(w.mirror, 'config', '--list')).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
  });

  it('refuses malformed tokens and global-option injection', () => {
    expect(() => safeGitCommand({ workTree: w.worktree, gitDir: w.gitDir, args: ['status'], auth: { token: 'has spaces and\nnewlines' } }))
      .toThrow(/token/);
    for (const args of [['-c', 'core.fsmonitor=x', 'status'], ['--git-dir=/elsewhere', 'status'], ['--exec-path=/x', 'status'], []]) {
      expect(() => safeGitCommand({ workTree: w.worktree, gitDir: w.gitDir, args })).toThrow(SafeGitError);
    }
    expect(githubRemoteUrl('ashlrai/fleet-canary')).toBe('https://github.com/ashlrai/fleet-canary.git');
    expect(() => githubRemoteUrl('ashlrai/../x y')).toThrow(SafeGitError);
  });

  it('builds the child env from nothing (no HOME, no inherited GIT_*)', () => {
    const cmd = safeGitCommand({ workTree: w.worktree, gitDir: w.gitDir, args: ['status'] });
    expect(cmd.env['HOME']).toBe('/var/empty');
    expect(cmd.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(cmd.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(Object.keys(cmd.env).filter((k) => k.startsWith('SSH_') || k === 'GIT_DIR' || k === 'GIT_EXEC_PATH')).toEqual([]);
    expect(cmd.args).toEqual(expect.arrayContaining(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', `--git-dir=${w.gitDir}`]));
    chmodSync(w.root, 0o700);
  });
});
