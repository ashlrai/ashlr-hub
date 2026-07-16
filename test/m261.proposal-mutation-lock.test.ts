import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const faults = vi.hoisted(() => ({
  assuranceCalls: [] as Array<{
    path: string;
    kind: string;
    mode: string;
    anchorPath: string | undefined;
  }>,
  failLstatOnceFor: undefined as string | undefined,
  rejectRootAssurance: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync(path: PathLike, ...args: unknown[]) {
      const target = String(path);
      if (target === faults.failLstatOnceFor) {
        faults.failLstatOnceFor = undefined;
        throw Object.assign(new Error('injected transient lstat failure'), { code: 'EIO' });
      }
      return (actual.lstatSync as (...params: unknown[]) => import('node:fs').Stats)(path, ...args);
    },
  };
});

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath(
      target: string,
      kind: Parameters<typeof actual.assurePrivateStoragePath>[1],
      mode: Parameters<typeof actual.assurePrivateStoragePath>[2],
      options: Parameters<typeof actual.assurePrivateStoragePath>[3] = {},
    ) {
      faults.assuranceCalls.push({ path: target, kind, mode, anchorPath: options.anchorPath });
      if (faults.rejectRootAssurance && target.endsWith(`${join('', '.ashlr')}`) && kind === 'directory') {
        return { ok: false, reason: 'injected-root-assurance-failure' };
      }
      return actual.assurePrivateStoragePath(target, kind, mode, options);
    },
  };
});
import {
  acquireProposalStoreMutationLock,
  acquireProposalMutationLock,
  ownsProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  ownsProposalMutationLock,
  releaseProposalMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import { createProposal, listProposals } from '../src/core/inbox/store.js';

let priorHome: string | undefined;
let home: string;

beforeEach(() => {
  faults.assuranceCalls.length = 0;
  faults.failLstatOnceFor = undefined;
  faults.rejectRootAssurance = false;
  priorHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-lock-'));
  process.env.HOME = home;
});

afterEach(() => {
  faults.assuranceCalls.length = 0;
  faults.failLstatOnceFor = undefined;
  faults.rejectRootAssurance = false;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function storeLockPath(): string {
  return join(home, '.ashlr', '.proposal-store-locks', 'writer.lock');
}

function proposalLockPath(proposalId: string): string {
  const key = createHash('sha256').update(proposalId).digest('hex');
  return join(home, '.ashlr', '.proposal-mutation-locks', `${key}.lock`);
}

function replaceCanonicalLock(path: string): void {
  unlinkSync(path);
  writeFileSync(path, `${JSON.stringify({
    pid: process.pid,
    token: 'replacement-token',
    startRef: '0'.repeat(64),
    startRefVerified: true,
    startRefSource: 'self-clock-epoch-second',
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

describe('proposal mutation authority fence', () => {
  it('secures a fresh proposal authority root before lock candidate publication', () => {
    const root = join(home, '.ashlr');
    const owner = acquireProposalStoreMutationLock(20);
    expect(owner).not.toBeNull();

    expect(faults.assuranceCalls[0]).toEqual({
      path: root,
      kind: 'directory',
      mode: 'secure-created',
      anchorPath: home,
    });
    expect(faults.assuranceCalls.findIndex((call) =>
      call.kind === 'file' && call.mode === 'secure-created')).toBeGreaterThan(0);
    releaseProposalStoreMutationLock(owner);

    faults.assuranceCalls.length = 0;
    const successor = acquireProposalStoreMutationLock(20);
    expect(successor).not.toBeNull();
    expect(faults.assuranceCalls[0]).toEqual({
      path: root,
      kind: 'directory',
      mode: 'inspect-existing',
      anchorPath: home,
    });
    releaseProposalStoreMutationLock(successor);
  });

  it('fails closed before lock publication when root assurance fails', () => {
    const root = join(home, '.ashlr');
    faults.rejectRootAssurance = true;

    expect(acquireProposalStoreMutationLock(20)).toBeNull();

    expect(faults.assuranceCalls).toEqual([{
      path: root,
      kind: 'directory',
      mode: 'secure-created',
      anchorPath: home,
    }]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects unrelated same-process entrants and only accepts the exact owner capability', () => {
    const owner = acquireProposalMutationLock('prop-authority-fence', 20);
    expect(owner).not.toBeNull();
    expect(ownsProposalMutationLock('prop-authority-fence', owner)).toBe(true);
    expect(acquireProposalMutationLock('prop-authority-fence', 20)).toBeNull();

    releaseProposalMutationLock({ key: owner!.key, token: Symbol('forged') });
    expect(acquireProposalMutationLock('prop-authority-fence', 20)).toBeNull();

    releaseProposalMutationLock(owner);
    const successor = acquireProposalMutationLock('prop-authority-fence', 20);
    expect(successor).not.toBeNull();
    releaseProposalMutationLock(successor);
  });

  it('retries a pending per-proposal release before successor acquisition', () => {
    const proposalId = 'prop-pending-release';
    const owner = acquireProposalMutationLock(proposalId, 20);
    expect(owner).not.toBeNull();
    faults.failLstatOnceFor = proposalLockPath(proposalId);

    releaseProposalMutationLock(owner);

    expect(ownsProposalMutationLock(proposalId, owner)).toBe(false);
    const successor = acquireProposalMutationLock(proposalId, 20);
    expect(successor).not.toBeNull();
    expect(ownsProposalMutationLock(proposalId, successor)).toBe(true);
    releaseProposalMutationLock(successor);
  });

  it.runIf(process.platform !== 'win32')(
    'revokes per-proposal authority but retries cleanup after same-inode directory repair',
    () => {
      const proposalId = 'prop-directory-mode-drift';
      const path = proposalLockPath(proposalId);
      const owner = acquireProposalMutationLock(proposalId, 20);
      expect(owner).not.toBeNull();
      chmodSync(dirname(path), 0o755);

      expect(ownsProposalMutationLock(proposalId, owner)).toBe(false);
      expect(acquireProposalMutationLock(proposalId, 20)).toBeNull();
      expect(readFileSync(path, 'utf8')).toContain('"token"');

      chmodSync(dirname(path), 0o700);
      const successor = acquireProposalMutationLock(proposalId, 20);
      expect(successor).not.toBeNull();
      expect(ownsProposalMutationLock(proposalId, successor)).toBe(true);
      releaseProposalMutationLock(successor);
    },
  );

  it('revokes per-proposal authorization when the canonical inode is replaced', () => {
    const proposalId = 'prop-replaced-authority';
    const path = proposalLockPath(proposalId);
    const owner = acquireProposalMutationLock(proposalId, 20);
    expect(owner).not.toBeNull();
    replaceCanonicalLock(path);

    expect(ownsProposalMutationLock(proposalId, owner)).toBe(false);
    expect(() => releaseProposalMutationLock(owner)).not.toThrow();
    expect(JSON.parse(String(readFileSync(path)))).toMatchObject({
      token: 'replacement-token',
    });

    unlinkSync(path);
    const successor = acquireProposalMutationLock(proposalId, 20);
    expect(successor).not.toBeNull();
    releaseProposalMutationLock(successor);
  });

  it('serializes all durable proposal replacements behind one exact store capability', () => {
    const owner = acquireProposalStoreMutationLock(20);
    expect(owner).not.toBeNull();
    expect(ownsProposalStoreMutationLock(owner)).toBe(true);
    expect(acquireProposalStoreMutationLock(20)).toBeNull();

    releaseProposalStoreMutationLock({ token: Symbol('forged') });
    expect(acquireProposalStoreMutationLock(20)).toBeNull();

    const blockedProposal = createProposal({
      repo: home,
      origin: 'manual',
      kind: 'patch',
      title: 'blocked writer',
      summary: 'must not bypass the global store fence',
    });
    expect(blockedProposal).toMatchObject({
      status: 'rejected',
      decisionReason: 'proposal persistence failed',
    });
    expect(listProposals()).toEqual([]);

    releaseProposalStoreMutationLock(owner);
    createProposal({
      repo: home,
      origin: 'manual',
      kind: 'patch',
      title: 'successor writer',
      summary: 'persists after the exact owner releases the fence',
    });
    expect(listProposals()).toHaveLength(1);
  });

  it('retries a pending store release before successor acquisition', () => {
    const owner = acquireProposalStoreMutationLock(20);
    expect(owner).not.toBeNull();
    faults.failLstatOnceFor = storeLockPath();

    releaseProposalStoreMutationLock(owner);

    expect(ownsProposalStoreMutationLock(owner)).toBe(false);
    const successor = acquireProposalStoreMutationLock(20);
    expect(successor).not.toBeNull();
    expect(ownsProposalStoreMutationLock(successor)).toBe(true);
    releaseProposalStoreMutationLock(successor);
  });

  it.runIf(process.platform !== 'win32')(
    'revokes store authority but retries cleanup after same-inode directory repair',
    () => {
      const path = storeLockPath();
      const owner = acquireProposalStoreMutationLock(20);
      expect(owner).not.toBeNull();
      chmodSync(dirname(path), 0o755);

      expect(ownsProposalStoreMutationLock(owner)).toBe(false);
      expect(acquireProposalStoreMutationLock(20)).toBeNull();
      expect(readFileSync(path, 'utf8')).toContain('"token"');

      chmodSync(dirname(path), 0o700);
      const successor = acquireProposalStoreMutationLock(20);
      expect(successor).not.toBeNull();
      expect(ownsProposalStoreMutationLock(successor)).toBe(true);
      releaseProposalStoreMutationLock(successor);
    },
  );

  it('revokes store authorization when the canonical inode is replaced', () => {
    const path = storeLockPath();
    const owner = acquireProposalStoreMutationLock(20);
    expect(owner).not.toBeNull();
    replaceCanonicalLock(path);

    expect(ownsProposalStoreMutationLock(owner)).toBe(false);
    expect(() => releaseProposalStoreMutationLock(owner)).not.toThrow();
    expect(JSON.parse(String(readFileSync(path)))).toMatchObject({
      token: 'replacement-token',
    });

    unlinkSync(path);
    const successor = acquireProposalStoreMutationLock(20);
    expect(successor).not.toBeNull();
    releaseProposalStoreMutationLock(successor);
  });

  it.runIf(process.platform !== 'win32')('excludes a separate writer process from the same store root', () => {
    const moduleUrl = pathToFileURL(resolve('src/core/inbox/proposal-mutation-lock.ts')).href;
    const script = [
      `import { acquireProposalStoreMutationLock, releaseProposalStoreMutationLock } from ${JSON.stringify(moduleUrl)};`,
      'const lock = acquireProposalStoreMutationLock(100);',
      "process.stdout.write(lock ? 'acquired' : 'blocked');",
      'releaseProposalStoreMutationLock(lock);',
    ].join('\n');
    const tsx = resolve('node_modules/.bin/tsx');
    const runChild = () => spawnSync(tsx, ['-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 5_000,
    });

    const owner = acquireProposalStoreMutationLock(20);
    expect(owner).not.toBeNull();
    const blocked = runChild();
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toBe('blocked');

    releaseProposalStoreMutationLock(owner);
    const successor = runChild();
    expect(successor.status).toBe(0);
    expect(successor.stdout).toBe('acquired');
  });

  it('refuses a proposal that could not be read back within the hard store bound', () => {
    const oversized = createProposal({
      repo: home,
      origin: 'manual',
      kind: 'patch',
      title: 'oversized proposal',
      summary: 'x'.repeat((16 * 1024 * 1024) + 1),
    });

    expect(oversized).toMatchObject({
      status: 'rejected',
      decisionReason: 'proposal persistence failed',
    });
    expect(listProposals()).toEqual([]);
  });
});
