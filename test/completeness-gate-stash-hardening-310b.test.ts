/**
 * V3.10 R3a — the completeness gate's `git stash` runs through safe-git.
 *
 * The gate stashes the AGENT's changes to measure a baseline, then pops them.
 * A plain `git stash` in an agent-written worktree runs whatever git config
 * names — core.fsmonitor, and clean/smudge filter drivers an agent routes files
 * to with its own `.gitattributes` — as the daemon, outside every sandbox.
 *
 * Real git, temp repos under the isolated HOME:
 *  - control: an unhardened `git stash push/pop` DOES execute the planted
 *    programs (so the assertions below are meaningful);
 *  - the gate's stash round-trips the agent's changes (baseline sees the base
 *    tree, the after-run sees the change) and executes none of them;
 *  - under a standing policy a `.git` pointer the agent rewrote (to a git dir
 *    inside its worktree) or a plain `.git` directory is refused: no stash,
 *    the stricter AFTER-only check runs, and nothing planted executes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => standing.policy,
}));

const { runDeltaAwareTestCheck } = await import('../src/core/run/completeness-gate.js');
const { __setVerifyConfinementForTests } = await import('../src/core/run/verify-commands.js');
type AshlrConfig = import('../src/core/types.js').AshlrConfig;

const cfg = {} as AshlrConfig;
let root: string;
let src: string;
let wt: string;
let marker: string;
let runsLog: string;

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function markerLines(): string[] {
  return existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [];
}

/** A test command that logs whether the agent's new file is present, then passes. */
function probeCommand() {
  const script = `require('fs').appendFileSync(${JSON.stringify(runsLog)}, (require('fs').existsSync('b.txt') ? 'after' : 'baseline') + '\\n')`;
  return { kind: 'test' as const, cmd: ['node', '-e', script], required: true, id: 'r3a-stash' };
}

beforeEach(() => {
  standing.policy = null;
  const home = realpathSync(homedir());
  mkdirSync(join(home, 'work'), { recursive: true });
  root = realpathSync(mkdtempSync(join(home, 'work', 'r3a-stash-')));
  src = join(root, 'src');
  wt = join(root, 'wt');
  marker = join(root, 'marker');
  runsLog = join(root, 'runs.log');
  mkdirSync(src);
  git(src, ['init', '-q']);
  git(src, ['config', 'user.email', 't@example.invalid']);
  git(src, ['config', 'user.name', 't']);
  writeFileSync(join(src, 'a.txt'), 'base\n');
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-qm', 'init']);
  // Planted programs, reachable only through config git would consult.
  const fsmon = join(root, 'fsmon.sh');
  const filt = join(root, 'filter.sh');
  writeFileSync(fsmon, `#!/bin/sh\necho fsmonitor >> ${JSON.stringify(marker)}\nexit 1\n`);
  writeFileSync(filt, `#!/bin/sh\necho filter >> ${JSON.stringify(marker)}\ncat\n`);
  chmodSync(fsmon, 0o755);
  chmodSync(filt, 0o755);
  git(src, ['worktree', 'add', '-q', wt]);
  git(src, ['config', 'core.fsmonitor', fsmon]);
  git(src, ['config', 'filter.evil.clean', filt]);
  git(src, ['config', 'filter.evil.smudge', filt]);
  // The agent's work: a modified tracked file, a new file, and attributes that
  // route every .txt through the planted filter driver.
  writeFileSync(join(wt, 'a.txt'), 'changed\n');
  writeFileSync(join(wt, 'b.txt'), 'new\n');
  writeFileSync(join(wt, '.gitattributes'), '*.txt filter=evil\n');
});

afterEach(() => {
  __setVerifyConfinementForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe('completeness gate stash hardening', () => {
  it('control: an unhardened git stash executes the planted fsmonitor / filter programs', () => {
    git(wt, ['stash', 'push', '--include-untracked', '-m', 'control']);
    git(wt, ['stash', 'pop']);
    expect(markerLines().length).toBeGreaterThan(0);
  });

  it('the gate stash round-trips the agent changes and executes nothing planted', async () => {
    const result = await runDeltaAwareTestCheck(probeCommand(), wt, cfg, 30_000);
    expect(result).toEqual({ pass: true });
    expect(readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)).toEqual(['baseline', 'after']);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(wt, 'b.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(wt, '.gitattributes'), 'utf8')).toBe('*.txt filter=evil\n');
    expect(git(src, ['stash', 'list'])).toBe('');
    expect(markerLines()).toEqual([]);
  });

  it('standing: a .git pointer rewritten to a git dir inside the worktree is refused (AFTER-only, nothing runs)', async () => {
    standing.policy = { grantId: 'g' };
    // Verification itself is confined under standing; this test is about the
    // stash, so a pass-through stand-in keeps it platform-independent.
    __setVerifyConfinementForTests((input) => ({ prefix: ['/usr/bin/env'], env: { ...input.baseEnv }, runDir: root, dispose: () => {} }));
    const fake = join(wt, 'fakegit');
    mkdirSync(fake);
    writeFileSync(join(fake, 'gitdir'), `${join(wt, '.git')}\n`);
    writeFileSync(join(fake, 'commondir'), `${join(src, '.git')}\n`);
    writeFileSync(join(wt, '.git'), `gitdir: ${fake}\n`);
    const result = await runDeltaAwareTestCheck(probeCommand(), wt, cfg, 30_000);
    expect(result).toEqual({ pass: true });
    expect(readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)).toEqual(['after']);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(markerLines()).toEqual([]);
  });

  it('standing: a plain .git directory (not a daemon worktree) is refused', async () => {
    standing.policy = { grantId: 'g' };
    __setVerifyConfinementForTests((input) => ({ prefix: ['/usr/bin/env'], env: { ...input.baseEnv }, runDir: root, dispose: () => {} }));
    writeFileSync(join(src, 'a.txt'), 'changed-in-src\n');
    writeFileSync(join(src, 'b.txt'), 'new\n');
    const result = await runDeltaAwareTestCheck(probeCommand(), src, cfg, 30_000);
    expect(result).toEqual({ pass: true });
    expect(readFileSync(runsLog, 'utf8').split('\n').filter(Boolean)).toEqual(['after']);
    expect(git(src, ['stash', 'list'])).toBe('');
  });

  it('a failed pop blocks the gate instead of testing the base tree', async () => {
    // The baseline run deletes the pointer the pop needs: the agent changes
    // cannot come back, so the AFTER run would test base code — block.
    const script = `require('fs').appendFileSync(${JSON.stringify(runsLog)}, 'baseline\\n'); require('fs').rmSync('.git')`;
    const result = await runDeltaAwareTestCheck({ kind: 'test', cmd: ['node', '-e', script], required: true, id: 'r3a-pop' }, wt, cfg, 30_000);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/could not be restored/);
  });
});
