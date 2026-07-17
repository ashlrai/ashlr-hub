import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunTask } from '../src/core/types.js';
import { makeCfg, withTmpHome, type DisposableRepo } from './helpers/h1-fixture.js';

const privateStorageMocks = vi.hoisted(() => ({ useRealAssurance: false }));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => privateStorageMocks.useRealAssurance
      ? actual.assurePrivateStoragePath(...args)
      : { ok: true, reason: 'exact-private-dacl' },
  };
});

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return { ...actual, spawnEngine: vi.fn() };
});

vi.mock('../src/core/run/agent-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/agent-loop.js')>();
  return { ...actual, runTask: vi.fn() };
});

import { runTask } from '../src/core/run/agent-loop.js';
import { spawnEngine } from '../src/core/run/engines.js';
import {
  runApiModelSandboxed,
  runEngineSandboxed,
  type SandboxedEngineResult,
} from '../src/core/run/sandboxed-engine.js';
import { listProposals } from '../src/core/inbox/store.js';
import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';
import { listSandboxes } from '../src/core/sandbox/worktree.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';

interface SourceSnapshot {
  tree: string;
  status: string;
  branch: string;
  branches: string[];
  worktrees: string;
}

function sourceSnapshot(repo: DisposableRepo): SourceSnapshot {
  return {
    tree: repo.shasumTree(),
    status: repo.gitStatus(),
    branch: repo.currentBranch(),
    branches: repo.branches().slice().sort(),
    worktrees: execFileSync('git', ['-C', repo.dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    }).trim(),
  };
}

function prepareAuthorityRoots(): void {
  privateStorageMocks.useRealAssurance = true;
  try {
    const fence = acquireOutwardMutationFence();
    try {
      if (!ownsOutwardMutationFence(fence)) {
        throw new Error('M409 fixture failed to establish private authority roots');
      }
    } finally {
      releaseOutwardMutationFence(fence);
    }
  } finally {
    privateStorageMocks.useRealAssurance = false;
  }
}

function makeConfig(): AshlrConfig {
  return makeCfg({
    models: { providerChain: [] },
    foundry: {
      completenessGate: false,
      dispatchRetries: 0,
      fleetMcp: false,
      models: {
        claude: 'claude-sonnet-4-5',
        'local-coder': 'qwen2.5:72b-instruct-q4_K_M',
      },
    },
  } as Partial<AshlrConfig>);
}

function abortGate(): {
  entered: Promise<void>;
  wait: (signal: AbortSignal | undefined) => Promise<void>;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  return {
    entered,
    wait: (signal) => {
      markEntered();
      if (signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

const spawnEngineMock = vi.mocked(spawnEngine);
const runTaskMock = vi.mocked(runTask);

afterEach(() => {
  vi.clearAllMocks();
});

describe('M409 engine execution outward mutation fence', () => {
  const cases: Array<{
    label: string;
    start: (
      repo: DisposableRepo,
      cfg: AshlrConfig,
      controller: AbortController,
      gate: ReturnType<typeof abortGate>,
    ) => Promise<SandboxedEngineResult>;
  }> = [
    {
      label: 'CLI agent',
      start: (repo, cfg, controller, gate) => {
        spawnEngineMock.mockImplementationOnce(async (_cmd, _cfg, opts) => {
          await gate.wait(opts.signal);
          return {
            ok: false,
            output: '',
            error: 'run cancelled',
            terminationReason: 'cancelled',
          };
        });
        return runEngineSandboxed('claude', 'remain blocked until cancelled', cfg, {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });
      },
    },
    {
      label: 'API-model agent',
      start: (repo, cfg, controller, gate) => {
        runTaskMock.mockImplementationOnce(async (task: RunTask, _client, ctx) => {
          await gate.wait(ctx.signal);
          return task;
        });
        return runApiModelSandboxed('local-coder', 'remain blocked until cancelled', cfg, {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });
      },
    },
  ];

  it.each(cases)('$label holds the fence through cancellation and cleanup', async ({ start }) => {
    await withTmpHome(async (fx) => {
      const previousAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      prepareAuthorityRoots();
      const repo = fx.makeRepo();
      repo.enroll();
      const before = sourceSnapshot(repo);
      const controller = new AbortController();
      const gate = abortGate();
      let running: Promise<SandboxedEngineResult> | undefined;

      try {
        running = start(repo, makeConfig(), controller, gate);
        await gate.entered;

        expect(listSandboxes()).toHaveLength(1);
        expect(listProposals()).toEqual([]);
        expect(setKill(true, { waitMs: 25 })).toEqual({
          ok: false,
          changed: true,
          quiesced: false,
          reason: 'kill armed; an outward mutation has not quiesced',
        });
        expect(killSwitchOn()).toBe(true);

        controller.abort();
        const result = await running;

        expect(result.state).toMatchObject({
          status: 'aborted',
          terminationReason: 'cancelled',
        });
        expect(result).not.toHaveProperty('proposalId');
        expect(result).not.toHaveProperty('proposalDraft');
        expect(result).not.toHaveProperty('proposalOutcome');
        expect(listProposals()).toEqual([]);
        expect(listSandboxes()).toEqual([]);
        expect(sourceSnapshot(repo)).toEqual(before);

        expect(setKill(false, { waitMs: 500 })).toMatchObject({
          ok: true,
          quiesced: true,
        });
        expect(killSwitchOn()).toBe(false);
      } finally {
        controller.abort();
        await running?.catch(() => undefined);
        setKill(false, { waitMs: 500 });
        if (previousAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previousAllowAnyRepo;
      }
    });
  }, 15_000);
});
