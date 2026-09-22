import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryGit } from '../src/core/universe/delivery-git.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delivery-kill-')));
  vi.stubEnv('HOME', root);
  mkdirSync(join(root, '.ashlr'), { mode: 0o700 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'seed']);
  return { repo, helper: deliveryGit(repo), commit: git(['rev-parse', 'HEAD']) };
}
function engage() { writeFileSync(join(root, '.ashlr', 'KILL'), 'test-only\n', { mode: 0o600 }); }

describe('delivery global stop at real Git publication', () => {
  it('withholds legacy two-argument publication when KILL is active', async () => {
    const f = fixture(); engage();
    await expect(f.helper.createRef('codex/stopped', f.commit)).rejects.toThrow('global KILL');
    expect(f.helper.ref('codex/stopped')).toBeNull();
  });

  it('rechecks KILL after the prepared synchronous guard and releases the real ref lock', async () => {
    const f = fixture(); const branch = 'codex/late-stop'; const guard = vi.fn(() => {
      expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(true);
      engage();
    });
    await expect(f.helper.createRef(branch, f.commit, guard)).rejects.toThrow('global KILL');
    expect(guard).toHaveBeenCalledOnce(); expect(f.helper.ref(branch)).toBeNull();
    expect(existsSync(join(f.repo, '.git', 'refs', 'heads', `${branch}.lock`))).toBe(false);
  });

  it('fails closed for an unsafe sentinel at publication', async () => {
    const f = fixture();
    symlinkSync(join(root, 'missing-target'), join(root, '.ashlr', 'KILL'));
    await expect(f.helper.createRef('codex/unknown-stop', f.commit)).rejects.toThrow('global KILL');
    expect(f.helper.ref('codex/unknown-stop')).toBeNull();
  });

  it('keeps already-published Git evidence readable while KILL is active', async () => {
    const f = fixture(); await f.helper.createRef('codex/published', f.commit); engage();
    expect(deliveryGit(f.repo).ref('codex/published')).toBe(f.commit);
    expect(f.helper.oid(['rev-parse', '--verify', `${f.commit}^{commit}`])).toBe(f.commit);
  });
});
