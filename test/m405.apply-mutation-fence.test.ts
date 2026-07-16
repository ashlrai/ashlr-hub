import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyProposal } from '../src/core/inbox/apply.js';
import { createProposal, loadProposal, setStatus } from '../src/core/inbox/store.js';
import {
  acquireProposalMutationLock,
  ownsProposalMutationLock,
  releaseProposalMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import {
  makeAddFileDiff,
  makeFixture,
  type DisposableRepo,
  type H1Fixture,
} from './helpers/h1-fixture.js';

const CHILD_TIMEOUT_MS = 8_000;
const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};
const fenceModuleUrl = new URL('../src/core/sandbox/mutation-fence.ts', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import {
    acquireOutwardMutationFence,
    ownsOutwardMutationFence,
    releaseOutwardMutationFence,
  } from ${JSON.stringify(fenceModuleUrl)};

  const send = (message) => new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC unavailable'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });

  const fence = acquireOutwardMutationFence(1_000);
  await send({ type: 'ready', acquired: fence !== null, owns: ownsOutwardMutationFence(fence) });
  if (!fence) {
    process.disconnect();
  } else {
    const keepAlive = setInterval(() => {}, 1_000);
    process.on('message', async (message) => {
      if (message !== 'release') return;
      releaseOutwardMutationFence(fence);
      clearInterval(keepAlive);
      await send({ type: 'released' });
      process.disconnect();
    });
  }
`;

type ChildMessage =
  | { type: 'ready'; acquired: boolean; owns: boolean }
  | { type: 'released' };

interface GitSnapshot {
  branch: string;
  branches: string[];
  head: string;
  refs: string;
  status: string;
  treeHash: string;
}

let fx: H1Fixture;
let repo: DisposableRepo;
let holder: ChildProcess | undefined;

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function snapshotGit(target: DisposableRepo): GitSnapshot {
  return {
    branch: target.currentBranch(),
    branches: target.branches(),
    head: git(target.dir, ['rev-parse', 'HEAD']),
    refs: git(target.dir, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
    ]),
    status: target.gitStatus(),
    treeHash: target.shasumTree(),
  };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function waitForMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T,
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    const onStderr = (chunk: string): void => { stderr += chunk; };
    child.stderr?.on('data', onStderr);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    };
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== type) return;
      cleanup();
      resolve(message as Extract<ChildMessage, { type: T }>);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`fence holder exited before ${type}: code=${code} signal=${signal}; ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fence holder did not send ${type}: ${stderr}`));
    }, CHILD_TIMEOUT_MS);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function startFenceHolder(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: fx.home,
        USERPROFILE: fx.home,
        ASHLR_HOME: join(fx.home, '.ashlr'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  holder = child;
  await expect(waitForMessage(child, 'ready')).resolves.toEqual({
    type: 'ready',
    acquired: true,
    owns: true,
  });
  return child;
}

async function releaseFenceHolder(child: ChildProcess): Promise<void> {
  const released = waitForMessage(child, 'released');
  child.send('release');
  await expect(released).resolves.toEqual({ type: 'released' });
  await waitForExit(child);
}

beforeEach(() => {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  fx = makeFixture();
  const fence = acquireOutwardMutationFence();
  if (!ownsOutwardMutationFence(fence)) {
    throw new Error('failed to establish the M405 outward mutation authority root');
  }
  releaseOutwardMutationFence(fence);
  _setPrivateStorageTestControlForTest(
    PRIVATE_STORAGE_TEST_CONTROL,
    process.platform === 'win32' ? { runner: semanticPrivateStorageRunner } : undefined,
  );
  repo = fx.makeRepo();
});

afterEach(async () => {
  try {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL');
      await waitForExit(holder);
    }
    holder = undefined;
    fx.cleanup();
  } finally {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  }
});

describe('M405 applyProposal outward mutation fence', { timeout: 15_000 }, () => {
  it('refuses before Git or proposal mutation when another process holds the fence', async () => {
    repo.enroll();
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'manual',
      kind: 'patch',
      title: 'M405 fenced apply',
      summary: 'This approved patch must remain retryable while the outward fence is held.',
      diff: makeAddFileDiff('m405-fenced.txt', 'must not be applied\n'),
    });
    expect(setStatus(proposal.id, 'approved')).toBe(true);

    const proposalBefore = loadProposal(proposal.id);
    expect(proposalBefore?.status).toBe('approved');
    const gitBefore = snapshotGit(repo);

    holder = await startFenceHolder();
    const result = await applyProposal(proposal.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('approved');
    expect(result.detail).toMatch(/outward mutation fence/i);
    expect(snapshotGit(repo)).toEqual(gitBefore);
    expect(loadProposal(proposal.id)).toEqual(proposalBefore);

    await releaseFenceHolder(holder);
    holder = undefined;
  });

  it('serializes concurrent applies so one approved patch produces one terminal effect', async () => {
    repo.enroll();
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'manual',
      kind: 'patch',
      title: 'M405 concurrent apply',
      summary: 'Two confirmed callers must share one proposal lifecycle authority.',
      diff: makeAddFileDiff('m405-concurrent.txt', 'applied exactly once\n'),
    });
    expect(setStatus(proposal.id, 'approved')).toBe(true);

    const gitBefore = snapshotGit(repo);
    const results = await Promise.all([
      applyProposal(proposal.id, { confirmed: true }),
      applyProposal(proposal.id, { confirmed: true }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => ['applied', 'failed'].includes(result.status))).toHaveLength(1);
    expect(loadProposal(proposal.id)?.status).toBe('applied');

    const proposalBranch = `ashlr/proposal/${proposal.id}`;
    expect(repo.branches().filter((branch) => branch === proposalBranch)).toEqual([proposalBranch]);
    expect(git(repo.dir, ['show', `${proposalBranch}:m405-concurrent.txt`])).toBe('applied exactly once');
    expect(repo.currentBranch()).toBe(gitBefore.branch);
    expect(git(repo.dir, ['rev-parse', 'HEAD'])).toBe(gitBefore.head);
    expect(repo.gitStatus()).toBe(gitBefore.status);
    expect(repo.shasumTree()).toBe(gitBefore.treeHash);
  });

  it('does not let a note claim or persist applied after another status transition owns the proposal lock', async () => {
    const proposal = createProposal({
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'M405 conditional note apply',
      summary: 'A note outcome must be conditional on the approved state it observed.',
    });
    expect(setStatus(proposal.id, 'approved')).toBe(true);

    const proposalLock = acquireProposalMutationLock(proposal.id, 100);
    expect(ownsProposalMutationLock(proposal.id, proposalLock)).toBe(true);
    try {
      const noteApply = applyProposal(proposal.id, { confirmed: true });
      expect(setStatus(
        proposal.id,
        'rejected',
        'status transition won the proposal lock',
        undefined,
        proposalLock ?? undefined,
        {},
        'approved',
      )).toBe(true);

      const result = await noteApply;
      expect(result.ok).toBe(false);
      expect(result.status).not.toBe('applied');
      expect(result.detail).toMatch(/proposal mutation|persist|status/i);
      expect(loadProposal(proposal.id)).toMatchObject({
        status: 'rejected',
        result: 'status transition won the proposal lock',
      });
    } finally {
      releaseProposalMutationLock(proposalLock);
    }
  });
});
