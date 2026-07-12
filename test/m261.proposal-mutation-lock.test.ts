import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  priorHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-lock-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

describe('proposal mutation authority fence', () => {
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
