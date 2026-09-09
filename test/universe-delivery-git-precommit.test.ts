import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { deliveryGit } from '../src/core/universe/delivery-git.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'universe-git-precommit-')));
  roots.push(repo);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  writeFileSync(join(repo, 'value.txt'), 'seed\n'); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed']);
  return { repo, git, commit: git(['rev-parse', 'HEAD']), helper: deliveryGit(repo) };
}

describe('Universe delivery prepared transaction guard', () => {
  it('calls the guard once under the prepared lock before publication and preserves dirty work', async () => {
    const f = fixture(); const branch = 'codex/guarded';
    writeFileSync(join(f.repo, 'value.txt'), 'staged\n'); f.git(['add', 'value.txt']);
    writeFileSync(join(f.repo, 'value.txt'), 'unstaged\n');
    const index = readFileSync(join(f.repo, '.git', 'index'));
    const guard = vi.fn(() => {
      expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(true);
      expect(f.helper.ref(branch)).toBeNull();
    });
    await f.helper.createRef(branch, f.commit, guard);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(f.helper.ref(branch)).toBe(f.commit);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('unstaged\n');
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(false);
  });

  it('retains backward-compatible two-argument creation', async () => {
    const f = fixture();
    await f.helper.createRef('codex/legacy', f.commit);
    expect(f.helper.ref('codex/legacy')).toBe(f.commit);
  });

  it('aborts a thrown ownership or cancellation check without publishing and releases the ref lock', async () => {
    const f = fixture(); const branch = 'codex/cancelled';
    await expect(f.helper.createRef(branch, f.commit, () => { throw new Error('Caller cancelled publication'); }))
      .rejects.toThrow('Caller cancelled publication');
    expect(f.helper.ref(branch)).toBeNull();
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(false);
    await f.helper.createRef(branch, f.commit);
    expect(f.helper.ref(branch)).toBe(f.commit);
  });

  it.each(['resolved', 'rejected'] as const)('refuses a %s Promise guard and observes its rejection', async (status) => {
    const f = fixture(); const branch = 'codex/async-guard';
    const guard = status === 'resolved' ? () => Promise.resolve() : () => Promise.reject(new Error('Private async guard failure'));
    await expect(f.helper.createRef(branch, f.commit, guard)).rejects.toThrow('must be synchronous');
    expect(f.helper.ref(branch)).toBeNull();
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(false);
  });

  it('refuses a rejecting thenable without leaking an unhandled rejection', async () => {
    const f = fixture();
    const then = vi.fn((_resolve: unknown, reject: (error: Error) => void) => reject(new Error('Thenable rejected')));
    await expect(f.helper.createRef('codex/thenable', f.commit, () => ({ then }))).rejects.toThrow('must be synchronous');
    expect(then).toHaveBeenCalledTimes(1);
    expect(f.helper.ref('codex/thenable')).toBeNull();
  });

  it.each([false, true, null, 0, 'approved', {}])('refuses a non-void guard result: %j', async (result) => {
    const f = fixture(); const branch = 'codex/non-void';
    await expect(f.helper.createRef(branch, f.commit, () => result)).rejects.toThrow('must return undefined');
    expect(f.helper.ref(branch)).toBeNull();
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(false);
  });

  it('checks the transaction deadline again after the synchronous guard returns', async () => {
    const f = fixture(); const deadline = performance.now() + 10_000;
    const helper = deliveryGit(f.repo, deadline);
    try {
      await expect(helper.createRef('codex/expired', f.commit, () => {
        vi.spyOn(performance, 'now').mockReturnValue(deadline + 1);
      })).rejects.toThrow('deadline exceeded');
    } finally { vi.restoreAllMocks(); }
    expect(f.helper.ref('codex/expired')).toBeNull();
  });

  it('does not call the guard or overwrite a pre-existing branch', async () => {
    const f = fixture(); f.git(['branch', 'codex/existing']);
    const guard = vi.fn();
    await expect(f.helper.createRef('codex/existing', f.commit, guard)).rejects.toThrow();
    expect(guard).not.toHaveBeenCalled(); expect(f.helper.ref('codex/existing')).toBe(f.commit);
  });

  it('does not call the guard or replace a dangling symbolic branch', async () => {
    const f = fixture(); const ref = 'refs/heads/codex/symbolic';
    f.git(['symbolic-ref', ref, 'refs/heads/missing']);
    const guard = vi.fn();
    await expect(f.helper.createRef('codex/symbolic', f.commit, guard)).rejects.toThrow();
    expect(guard).not.toHaveBeenCalled();
    expect(f.git(['symbolic-ref', ref])).toBe('refs/heads/missing');
  });
});
