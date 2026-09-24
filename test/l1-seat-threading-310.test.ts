/**
 * V3.10 fixer L1-core — the SeatRouter's codex seat reaches the sandboxed
 * producer. runGoal (RunOptions.seatId) must forward it on BOTH
 * runEngineSandboxed call sites (the TITRR attempt and the shared-sandbox
 * fallback); without it a standing codex run is refused as unconfinable.
 * Harness: m78's doMock + resetModules recipe (no engine, seat or network).
 * HOME-isolated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

function sandboxCfg(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    foundry: { sandboxExternal: true, models: {} },
  } as AshlrConfig;
}

function runState(status: 'done' | 'failed', result: string) {
  return {
    id: `run-l1-${Math.random().toString(36).slice(2)}`,
    goal: 'g',
    engine: 'codex' as const,
    provider: 'external',
    engineModel: 'codex:default',
    engineTier: 'frontier' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status,
    result,
  };
}

describe('runGoal forwards RunOptions.seatId to runEngineSandboxed', () => {
  let engineMock: ReturnType<typeof vi.fn>;
  let createSandboxMock: ReturnType<typeof vi.fn>;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-l1-seat-'));
    process.env.HOME = tmpHome;
    engineMock = vi.fn();
    createSandboxMock = vi.fn(() => ({ id: 'mock-sb', worktreePath: '/mock/wt', sourceRepo: '/mock/repo', branch: 'scratch/mock' }));
    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runEngineSandboxed: engineMock,
      runApiModelSandboxed: engineMock,
      captureSandboxedProposal: vi.fn(async () => ({
        state: runState('done', 'captured'),
        proposalId: 'p-l1',
        proposalOutcome: { kind: 'filed', reason: 'proposal filed', proposalId: 'p-l1' },
      })),
      recordSandboxedRunAgentAction: vi.fn(),
      engineTierOf: vi.fn(() => 'frontier'),
      buildContainedEnv: vi.fn(() => ({})),
    }));
    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: createSandboxMock,
      createSandboxAsync: async (...args: unknown[]) => (createSandboxMock as unknown as (...a: unknown[]) => unknown)(...args),
      removeSandbox: vi.fn(),
      sandboxDiff: vi.fn(() => ({ files: 0, patch: '', insertions: 0, deletions: 0 })),
    }));
    vi.doMock('../src/core/run/verify-commands.js', () => ({
      detectVerifyCommands: vi.fn(() => []),
      runVerifyCommand: vi.fn(),
      runVerifyCommandAsync: vi.fn(),
      spawnOptionsFor: vi.fn(),
    }));
    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn(async () => ({ id: 'ollama', chat: vi.fn(async () => ({ content: '', usage: { tokensIn: 0, tokensOut: 0 } })) })),
    }));
    vi.doMock('../src/core/run/engines.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/core/run/engines.js')>()),
      engineInstalled: vi.fn(() => true),
    }));
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const m of [
      '../src/core/run/sandboxed-engine.js',
      '../src/core/sandbox/worktree.js',
      '../src/core/run/verify-commands.js',
      '../src/core/run/provider-client.js',
      '../src/core/run/engines.js',
    ]) vi.doUnmock(m);
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  async function runGoal() {
    return (await import('../src/core/run/orchestrator.js')).runGoal;
  }

  it('TITRR attempt path carries the seat', async () => {
    engineMock.mockResolvedValue({ state: runState('done', 'ok') });
    await (await runGoal())('fix a bug', sandboxCfg(), {
      engine: 'codex', sandboxEngine: true, tools: false, seatId: 'codex-a',
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(engineMock).toHaveBeenCalled();
    expect(engineMock.mock.calls[0]?.[3]).toMatchObject({ seatId: 'codex-a', propose: false });
  });

  it('shared-sandbox fallback path carries the seat', async () => {
    createSandboxMock.mockImplementationOnce(() => { throw new Error('no shared sandbox'); });
    engineMock.mockResolvedValue({ state: runState('failed', 'fallback') });
    await (await runGoal())('fix a bug', sandboxCfg(), {
      engine: 'codex', sandboxEngine: true, tools: false, seatId: 'codex-a',
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(engineMock).toHaveBeenCalledTimes(1);
    expect(engineMock.mock.calls[0]?.[3]).toMatchObject({ seatId: 'codex-a', propose: true });
  });

  it('no seat given ⇒ no seatId key (the producer then refuses a standing codex run, fail-closed)', async () => {
    engineMock.mockResolvedValue({ state: runState('done', 'ok') });
    await (await runGoal())('fix a bug', sandboxCfg(), {
      engine: 'codex', sandboxEngine: true, tools: false,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(Object.keys(engineMock.mock.calls[0]?.[3] as Record<string, unknown>)).not.toContain('seatId');
  });
});
