/**
 * V3.10 INT3 — G3 verification runs CONFINED under a standing grant
 * (inbox/merge.ts openStandingVerificationConfinement; U2's critical request:
 * "G3 verification runs agent-written code. It must use
 * autonomousVerificationProfile() with an overlay built for engine local").
 *
 * - No standing policy → null: legacy verification is unchanged.
 * - A live policy → every verify command runs under sandbox-exec with the
 *   run's overlay: it can write its worktree, cannot write outside it, and a
 *   read of ~/.ashlr/authority is a tripwire kill (never a readable secret).
 *
 * The darwin cases run the REAL sandbox-exec (macOS only; skipped elsewhere).
 * HOME is the per-test isolated home (test/setup), so the run dir, the
 * worktree and the "authority" secret all live in a throwaway directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => standing.policy,
}));

const { openStandingVerificationConfinement, VerificationConfinementError } = await import('../src/core/inbox/merge.js');
const { runVerifyCommandAsync } = await import('../src/core/run/verify-commands.js');
type AshlrConfig = import('../src/core/types.js').AshlrConfig;

const onDarwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

let root: string;
let worktree: string;

beforeEach(() => {
  standing.policy = null;
  const home = realpathSync(homedir());
  mkdirSync(join(home, '.ashlr', 'tmp'), { recursive: true, mode: 0o700 });
  root = mkdtempSync(join(home, '.ashlr', 'tmp', 'vwt-test-'));
  worktree = join(root, 'wt');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function nodeCommand(script: string) {
  // Bare `node`: verify commands may not name an absolute executable; the
  // confinement puts the daemon's node toolchain first on the child's PATH.
  return { kind: 'test' as const, cmd: ['node', '-e', script], required: true, id: 'int3-confined' };
}

describe('openStandingVerificationConfinement', () => {
  it('returns null when no standing policy is live (legacy verification unchanged)', async () => {
    standing.policy = null;
    await expect(openStandingVerificationConfinement(worktree)).resolves.toBeNull();
  });

  it('fails CLOSED (throws) when a policy is live but no sandbox can be built', async () => {
    standing.policy = { grantId: 'g' };
    // A worktree that does not exist cannot be confined: the caller must not run unconfined.
    await expect(openStandingVerificationConfinement(join(root, 'missing'))).rejects.toBeInstanceOf(VerificationConfinementError);
  });

  it.skipIf(!onDarwin)('runs a verify command confined: worktree writable, outside not, authority reads trip', async () => {
    standing.policy = { grantId: 'g' };
    const home = realpathSync(homedir());
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    const secret = join(home, '.ashlr', 'authority', 'int3-secret');
    writeFileSync(secret, 'not-for-verified-code', { mode: 0o600 });
    const outside = join(root, 'outside.txt');

    const confined = await openStandingVerificationConfinement(worktree);
    expect(confined).not.toBeNull();
    try {
      const opts = { _runSubprocess: confined!.runSubprocess, timeoutMs: 30_000 };
      const cfg = {} as AshlrConfig;

      const inside = await runVerifyCommandAsync(nodeCommand("require('fs').writeFileSync('inside.txt', 'ok')"), worktree, cfg, opts);
      expect(inside.ok, inside.output).toBe(true);
      expect(readFileSync(join(worktree, 'inside.txt'), 'utf8')).toBe('ok');

      const escape = await runVerifyCommandAsync(nodeCommand(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`), worktree, cfg, opts);
      expect(escape.ok).toBe(false);
      expect(existsSync(outside)).toBe(false);

      const steal = await runVerifyCommandAsync(
        nodeCommand(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))`),
        worktree,
        cfg,
        opts,
      );
      expect(steal.ok).toBe(false);
      expect(steal.output).not.toContain('not-for-verified-code');
    } finally {
      confined!.close();
    }
  });

  it.skipIf(!onDarwin)('close() removes the run\'s private dir', async () => {
    standing.policy = { grantId: 'g' };
    const before = new Set(listRunDirs());
    const confined = await openStandingVerificationConfinement(worktree);
    const created = listRunDirs().filter((d) => !before.has(d));
    expect(created).toHaveLength(1);
    confined!.close();
    confined!.close(); // idempotent
    expect(existsSync(created[0]!)).toBe(false);
  });
});

function listRunDirs(): string[] {
  const dir = join(realpathSync(homedir()), '.ashlr', 'tmp');
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => name.startsWith('verify-confine-'))
    .map((name) => join(dir, name));
}
