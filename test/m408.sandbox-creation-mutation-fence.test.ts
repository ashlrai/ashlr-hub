import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SemanticPrivateStorageHarness,
  SemanticPrivateStorageRequest,
} from './helpers/semantic-private-storage.js';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import {
  canonicalPathIdentity,
  createSandbox,
  listSandboxes,
  removeSandbox,
  sandboxesDir,
} from '../src/core/sandbox/worktree.js';

const privateStorageHarness = vi.hoisted(() => ({
  harness: undefined as SemanticPrivateStorageHarness | undefined,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  const { createSemanticPrivateStorageHarness, trustedWindowsSystemRootForTest } =
    await import('./helpers/semantic-private-storage.js');
  privateStorageHarness.harness ??= createSemanticPrivateStorageHarness({
    systemRoot: trustedWindowsSystemRootForTest(),
  });
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      const options = args[3];
      if (process.platform !== 'win32' || options?.runner !== undefined) {
        return actual.assurePrivateStoragePath(...args);
      }
      return actual.assurePrivateStoragePath(args[0], args[1], args[2], {
        ...options,
        runner: privateStorageHarness.harness!.runner,
      });
    },
  };
});

const CHILD_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 8_000;
const fenceModuleUrl = new URL('../src/core/sandbox/mutation-fence.ts', import.meta.url).href;
const privateStorageModuleUrl = new URL('../src/core/util/private-storage.ts', import.meta.url).href;
const semanticPrivateStorageHelperUrl = new URL(
  './helpers/semantic-private-storage.ts',
  import.meta.url,
).href;
const CHILD_SOURCE = String.raw`
  import {
    acquireOutwardMutationFence,
    ownsOutwardMutationFence,
    releaseOutwardMutationFence,
  } from ${JSON.stringify(fenceModuleUrl)};
  import {
    PRIVATE_STORAGE_TEST_CONTROL,
    _setPrivateStorageTestControlForTest,
  } from ${JSON.stringify(privateStorageModuleUrl)};
  import {
    createSemanticPrivateStorageHarness,
    trustedWindowsSystemRootForTest,
  } from ${JSON.stringify(semanticPrivateStorageHelperUrl)};

  const semanticStorage = createSemanticPrivateStorageHarness({
    systemRoot: trustedWindowsSystemRootForTest(),
  });
  if (process.platform === 'win32') {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: semanticStorage.runner,
    });
  }

  const send = (message) => new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC unavailable'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });

  const fence = acquireOutwardMutationFence(1_000);
  await send({
    type: 'ready',
    acquired: fence !== null,
    owns: ownsOutwardMutationFence(fence),
    semanticRequests: semanticStorage.requests,
  });

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
  | {
      type: 'ready';
      acquired: boolean;
      owns: boolean;
      semanticRequests: readonly SemanticPrivateStorageRequest[];
    }
  | { type: 'released' };

interface SourceSnapshot {
  tree: string;
  status: string;
  branch: string;
  branches: string[];
  worktrees: string;
}

let fx: H1Fixture;
const children = new Set<ChildProcess>();

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  }).trim();
}

function hasRegisteredWorktree(repo: string, worktreePath: string): boolean {
  const expected = canonicalPathIdentity(worktreePath);
  if (expected === null) return false;
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => canonicalPathIdentity(line.slice('worktree '.length).trimEnd()) === expected);
}

function sourceSnapshot(repo: DisposableRepo): SourceSnapshot {
  return {
    tree: repo.shasumTree(),
    status: repo.gitStatus(),
    branch: repo.currentBranch(),
    branches: repo.branches().slice().sort(),
    worktrees: git(repo.dir, ['worktree', 'list', '--porcelain']),
  };
}

function metadataSnapshot(): string[] {
  const root = sandboxesDir();
  if (!existsSync(root)) return [];

  const snapshot: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        snapshot.push(`dir:${rel}`);
        walk(path);
      } else if (entry.isFile()) {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        snapshot.push(`file:${rel}:${digest}`);
      } else {
        snapshot.push(`other:${rel}`);
      }
    }
  };
  walk(root);
  return snapshot;
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
      reject(new Error(`M408 holder exited before ${type}: code=${code} signal=${signal}; ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`M408 holder did not send ${type}: ${stderr}`));
    }, CHILD_TIMEOUT_MS);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function startHolder(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: fx.home,
        USERPROFILE: fx.home,
        ASHLR_HOME: fx.ashlrDir,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));

  const ready = await waitForMessage(child, 'ready');
  expect(ready).toMatchObject({
    type: 'ready',
    acquired: true,
    owns: true,
  });
  if (process.platform === 'win32') {
    const authorityRoot = join(fx.home, '.ashlr', 'authority');
    expect(ready.semanticRequests.some((request) =>
      request.operation === 'assure-private-path' &&
      request.anchorPath === authorityRoot &&
      request.kind === 'file' &&
      request.mode === 'secure-created' &&
      request.paths.length === 1 &&
      /^outward-mutation\.lock\.\d+\.[0-9a-f-]+\.candidate$/iu.test(
        request.paths[0]!.slice(authorityRoot.length + 1),
      ),
    )).toBe(true);
  } else {
    expect(ready.semanticRequests).toEqual([]);
  }
  return child;
}

async function releaseHolder(child: ChildProcess): Promise<void> {
  const released = waitForMessage(child, 'released');
  child.send('release');
  await expect(released).resolves.toEqual({ type: 'released' });
  await waitForExit(child);
}

beforeEach(() => {
  privateStorageHarness.harness?.reset();
  fx = makeFixture();
});

afterEach(async () => {
  const running = [...children];
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(running.map(waitForExit));
  fx.cleanup();
});

describe('M408 createSandbox outward mutation fence', () => {
  it('refuses without branch, worktree, or metadata changes while another process owns the fence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    privateStorageHarness.harness?.reset();
    const holder = await startHolder();

    const sourceBefore = sourceSnapshot(repo);
    const metadataBefore = metadataSnapshot();
    expect(listSandboxes()).toEqual([]);

    expect(() => createSandbox(repo.dir)).toThrow(/outward mutation fence unavailable/i);

    expect(sourceSnapshot(repo)).toEqual(sourceBefore);
    expect(metadataSnapshot()).toEqual(metadataBefore);
    expect(listSandboxes()).toEqual([]);

    await releaseHolder(holder);

    const sandbox = createSandbox(repo.dir);
    try {
      expect(repo.branches()).toContain(sandbox.branch);
      expect(hasRegisteredWorktree(repo.dir, sandbox.worktreePath)).toBe(true);
      expect(listSandboxes().map((entry) => entry.id)).toContain(sandbox.id);
    } finally {
      removeSandbox(sandbox);
    }

    expect(sourceSnapshot(repo)).toEqual(sourceBefore);
    expect(listSandboxes()).toEqual([]);
  }, process.platform === 'win32' ? 120_000 : 15_000);
});
