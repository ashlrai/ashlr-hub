/**
 * V3.11 — runGoal forwards RunOptions.harness (the adopted harness's per-lane
 * effort / sampling) to every sandboxed producer call site, and sends no
 * harness key without one. Kept in its own file: it doMocks the sandboxed
 * engine, which must not leak into the suites that run the real one
 * (test/harness-dispatch-311.test.ts). Harness: l1-seat-threading's doMock +
 * resetModules recipe (no engine, seat or network). HOME-isolated by setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchHarness } from '../src/core/run/harness-dispatch.js';
import type { AshlrConfig } from '../src/core/types.js';

function harness(over: Partial<DispatchHarness> = {}): DispatchHarness {
  return { versionId: 'h-0007', effort: {}, sampling: {}, ...over };
}

// ---------------------------------------------------------------------------
// runGoal threading
// ---------------------------------------------------------------------------

describe('runGoal forwards RunOptions.harness to the sandboxed producers', () => {
  let engineMock: ReturnType<typeof vi.fn>;
  let createSandboxMock: ReturnType<typeof vi.fn>;

  function runState(status: 'done' | 'failed') {
    return {
      id: `run-h-${Math.random().toString(36).slice(2)}`, goal: 'g', engine: 'codex' as const, provider: 'external',
      engineModel: 'codex:default', engineTier: 'frontier' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false }, usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 },
      tasks: [], steps: [], status, result: 'r',
    };
  }

  beforeEach(() => {
    engineMock = vi.fn();
    createSandboxMock = vi.fn(() => ({ id: 'mock-sb', worktreePath: '/mock/wt', sourceRepo: '/mock/repo', branch: 'scratch/mock' }));
    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runEngineSandboxed: engineMock,
      runApiModelSandboxed: engineMock,
      captureSandboxedProposal: vi.fn(async () => ({
        state: runState('done'), proposalId: 'p-h', proposalOutcome: { kind: 'filed', reason: 'proposal filed', proposalId: 'p-h' },
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
      detectVerifyCommands: vi.fn(() => []), runVerifyCommand: vi.fn(), runVerifyCommandAsync: vi.fn(), spawnOptionsFor: vi.fn(),
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
  });

  const CFG_SANDBOX = {
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {}, tools: {}, foundry: { sandboxExternal: true, models: {} },
  } as unknown as AshlrConfig;
  const H = harness({ effort: { codex: 'high', local: 'medium' } });

  async function runGoal() {
    return (await import('../src/core/run/orchestrator.js')).runGoal;
  }

  it('cli-agent TITRR attempt carries the harness', async () => {
    engineMock.mockResolvedValue({ state: runState('done') });
    await (await runGoal())('fix a bug', CFG_SANDBOX, {
      engine: 'codex', sandboxEngine: true, tools: false, harness: H, budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(engineMock.mock.calls[0]?.[3]).toMatchObject({ harness: H, propose: false });
  });

  it('cli-agent shared-sandbox fallback carries the harness', async () => {
    createSandboxMock.mockImplementationOnce(() => { throw new Error('no shared sandbox'); });
    engineMock.mockResolvedValue({ state: runState('failed') });
    await (await runGoal())('fix a bug', CFG_SANDBOX, {
      engine: 'codex', sandboxEngine: true, tools: false, harness: H, budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(engineMock.mock.calls[0]?.[3]).toMatchObject({ harness: H, propose: true });
  });

  it('api-model attempt carries the harness', async () => {
    engineMock.mockResolvedValue({ state: { ...runState('done'), engine: 'local-coder' } });
    await (await runGoal())('fix a bug', CFG_SANDBOX, {
      engine: 'local-coder', sandboxEngine: true, tools: false, harness: H, budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(engineMock).toHaveBeenCalled();
    expect(engineMock.mock.calls[0]?.[3]).toMatchObject({ harness: H });
  });

  it('no harness ⇒ no harness key (compiled defaults)', async () => {
    engineMock.mockResolvedValue({ state: runState('done') });
    await (await runGoal())('fix a bug', CFG_SANDBOX, {
      engine: 'codex', sandboxEngine: true, tools: false, budget: { maxTokens: 1_000_000, maxSteps: 100 },
    });
    expect(Object.keys(engineMock.mock.calls[0]?.[3] as Record<string, unknown>)).not.toContain('harness');
  });
});

