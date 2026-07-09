/**
 * M78 TITRR (Test→Iterate→Test→Refine→Repeat) unit tests.
 *
 * Strategy: use vi.doMock + vi.resetModules() before each test so that the
 * orchestrator's internal dynamic imports (sandboxed-engine.js, worktree.js)
 * pick up fresh mocks on every test — this is required because vi.mock cannot
 * intercept already-cached dynamic imports in ESM.
 *
 * Covers:
 *  1. Passing tests on first attempt → "tests: pass (attempt 1)" annotation
 *  2. Failing then passing → re-invokes engine once, "tests: pass (attempt 2)"
 *  3. Failing tests exhausted (maxAttempts=2) → "tests: still failing after 2 attempt(s)"
 *  4. No test command detected → "tests: not detected (skipped)", no throw
 *  5. Budget exhausted mid-loop → stops, annotation matches budget/still-failing
 *  6. titrrTestRun returns null for empty dir (real detectVerifyCommands)
 *  7. titrrTestRun returns null for pkg.json with no test script
 *  8. titrrTestRun never throws for non-existent path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(foundry?: AshlrConfig['foundry']): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...(foundry ? { foundry } : {}),
  };
}

function sandboxCfg(): AshlrConfig {
  return makeConfig({ sandboxExternal: true, models: {} });
}

function makeRunState(overrides: { status?: string; result?: string; usage?: Record<string, number> } = {}) {
  return {
    id: `run-titrr-${Math.random().toString(36).slice(2)}`,
    goal: 'test goal',
    engine: 'claude' as const,
    provider: 'external',
    engineModel: 'claude:default',
    engineTier: 'frontier' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0, ...(overrides.usage ?? {}) },
    tasks: [],
    steps: [],
    status: (overrides.status ?? 'done') as 'done' | 'failed' | 'running' | 'aborted' | 'skipped',
    result: overrides.result ?? 'engine output',
  };
}

// ---------------------------------------------------------------------------
// titrrTestRun — pure unit tests (real detectVerifyCommands, no process spawn)
// These do NOT mock verify-commands — they exercise the real detection logic.
// ---------------------------------------------------------------------------

describe('titrrTestRun — unit (real detectVerifyCommands)', () => {
  it('returns null for an empty directory (no package.json)', async () => {
    const { titrrTestRun } = await import('../src/core/run/orchestrator.js');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m78-'));
    try {
      await expect(titrrTestRun(emptyDir, makeConfig())).resolves.toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('returns null for package.json with no test script and no vitest dep', async () => {
    const { titrrTestRun } = await import('../src/core/run/orchestrator.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m78-notest-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }),
      );
      await expect(titrrTestRun(dir, makeConfig())).resolves.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws for a non-existent path', async () => {
    const { titrrTestRun } = await import('../src/core/run/orchestrator.js');
    await expect(titrrTestRun('/nonexistent-m78-xyz', makeConfig())).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TITRR loop — uses vi.doMock + vi.resetModules() so dynamic imports are fresh
// ---------------------------------------------------------------------------

describe('TITRR loop — sandboxed-engine path (doMock + resetModules)', () => {
  // Mock factories — rebuilt per test via vi.doMock.
  let engineMockFn: ReturnType<typeof vi.fn>;
  let captureMockFn: ReturnType<typeof vi.fn>;
  let detectVCMockFn: ReturnType<typeof vi.fn>;
  let runVCMockFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    engineMockFn = vi.fn();
    captureMockFn = vi.fn(async () => ({
      state: makeRunState({ result: 'proposal captured' }),
      proposalId: 'p-captured',
      proposalOutcome: {
        kind: 'filed',
        reason: 'proposal filed',
        proposalId: 'p-captured',
      },
    }));
    detectVCMockFn = vi.fn();
    runVCMockFn = vi.fn();

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runEngineSandboxed: engineMockFn,
      captureSandboxedProposal: captureMockFn,
      // M300 routes api-model engines through runApiModelSandboxed; alias it to
      // the same mock so the module's exports are complete regardless of path.
      runApiModelSandboxed: engineMockFn,
      // stub other named exports so imports don't break
      engineTierOf: vi.fn(() => 'frontier'),
      buildContainedEnv: vi.fn(() => ({})),
    }));

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: vi.fn(() => ({
        id: 'mock-sb',
        worktreePath: '/mock/wt',
        sourceRepo: '/mock/repo',
        branch: 'scratch/mock',
      })),
      removeSandbox: vi.fn(),
      sandboxDiff: vi.fn(() => ({ files: 0, patch: '', insertions: 0, deletions: 0 })),
    }));

    vi.doMock('../src/core/run/verify-commands.js', () => ({
      detectVerifyCommands: detectVCMockFn,
      runVerifyCommand: runVCMockFn,
      runVerifyCommandAsync: runVCMockFn,
      spawnOptionsFor: vi.fn(),
    }));

    // Stub the provider-resolution layer so runGoal's run-level getActiveClient()
    // does not perform a real local-provider reachability probe. Without this,
    // hermetic CI (no Ollama/LM Studio) throws "local-first: no provider is
    // reachable" before the TITRR loop under test ever runs. The sandbox engine
    // is mocked, so this client is never used to chat — only client.id is read.
    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn(async () => ({
        id: 'ollama',
        chat: vi.fn(async () => ({ content: '', usage: { tokensIn: 0, tokensOut: 0 } })),
      })),
    }));

    // Force the requested engine "installed" so runGoal enters the mocked
    // runEngineSandboxed/TITRR path. Without this, engineInstalled('claude')
    // shells `which claude`; on a host without the CLI (Linux CI) it returns
    // false and the orchestrator falls back to 'builtin', never reaching the
    // TITRR loop under test (it then reports "No tasks completed successfully").
    vi.doMock('../src/core/run/engines.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
      return { ...actual, engineInstalled: vi.fn(() => true) };
    });

    // Reset module registry so next import() picks up the doMock stubs.
    vi.resetModules();

    // Stub fetch so provider probe doesn't reach real network.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in TITRR test')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../src/core/run/sandboxed-engine.js');
    vi.doUnmock('../src/core/sandbox/worktree.js');
    vi.doUnmock('../src/core/run/verify-commands.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/run/engines.js');
    vi.resetModules();
  });

  // Lazy-load runGoal after doMock+resetModules so it picks up the fresh mocks.
  async function loadRunGoal() {
    const m = await import('../src/core/run/orchestrator.js');
    return m.runGoal;
  }

  // ---- Test 1: tests pass on first attempt ----
  it('passing tests → proposes with "tests: pass (attempt 1)" annotation', async () => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({ status: 'done', result: 'engine ok' }),
      proposalId: 'p1',
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({ ok: true, command: 'npm test', exitCode: 0, output: 'All pass', timedOut: false });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
        budget: { maxTokens: 1_000_000, maxSteps: 100 },
        tools: false,
        workItemId: 'work-titrr',
        workSource: 'manual',
        delegationScope: {
          origin: 'daemon',
          sourceRepo: '/mock/repo',
          workItemId: 'work-titrr',
          workSource: 'manual',
          allowedFiles: { include: ['src/fix.ts'] },
          memoryMode: 'bounded',
          resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        },
      });

    expect(state.result).toMatch(/TITRR.*tests: pass \(attempt 1\)/);
    expect(engineMockFn).toHaveBeenCalled();
    const attemptOpts = engineMockFn.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(attemptOpts).toMatchObject({ propose: false });
    expect(attemptOpts['delegationScope']).toMatchObject({
      origin: 'daemon',
      sourceRepo: '/mock/repo',
      workItemId: 'work-titrr',
      workSource: 'manual',
      allowedFiles: { include: ['src/fix.ts'] },
      memoryMode: 'bounded',
    });
    const captureOpts = captureMockFn.mock.calls.find((call) => {
      const opts = call[3] as Record<string, unknown> | undefined;
      return Boolean(opts?.['delegationScope']);
    })?.[3] as Record<string, unknown> | undefined;
    expect(captureOpts).toBeDefined();
    expect(captureOpts?.['delegationScope']).toMatchObject({
      origin: 'daemon',
      sourceRepo: '/mock/repo',
      workItemId: 'work-titrr',
      workSource: 'manual',
      allowedFiles: { include: ['src/fix.ts'] },
      memoryMode: 'bounded',
    });
  });

  it('api-model TITRR capture returns filed metadata instead of stale proposal-disabled metadata', async () => {
    const usage = { tokensIn: 11, tokensOut: 7, steps: 2, estCostUsd: 0 };
    const disabledOutcome = {
      kind: 'proposal-disabled' as const,
      reason: 'proposal filing disabled for this api-model attempt',
      files: 1,
      insertions: 4,
      deletions: 0,
    };
    const producerBase = makeRunState({ status: 'done', result: 'api model ok', usage });
    const apiProducerState = {
      ...producerBase,
      engine: 'local-coder' as const,
      provider: 'openai-compat',
      engineModel: 'local-coder:qwen',
      engineTier: 'mid' as const,
      proposalOutcome: disabledOutcome,
      runEventSummary: {
        runId: producerBase.id,
        status: 'done',
        outcome: 'proposal-disabled',
        diffFiles: 1,
        diffLines: 4,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.estCostUsd,
        actionCounts: {
          modelSteps: 1,
          totalSteps: 2,
          diffFiles: 1,
          diffLines: 4,
          proposalCreated: 0,
          proposalBlocked: 0,
          proposalDisabled: 1,
        },
      },
    };
    const filedOutcome = {
      kind: 'filed' as const,
      reason: 'proposal filed',
      proposalId: 'p-api',
      files: 2,
      insertions: 10,
      deletions: 3,
    };

    engineMockFn.mockResolvedValue({
      state: apiProducerState,
      proposalOutcome: disabledOutcome,
    });
    captureMockFn.mockImplementationOnce(async (_engine: unknown, _goal: unknown, _cfg: unknown, opts: { runId?: string }) => {
      const runId = opts.runId ?? 'run-api-capture';
      return {
        state: {
          ...makeRunState({ status: 'done', result: 'proposal filed', usage }),
          id: runId,
          engine: 'local-coder' as const,
          provider: 'external',
          engineModel: 'local-coder:qwen',
          engineTier: 'mid' as const,
          proposalOutcome: filedOutcome,
          runEventSummary: {
            runId,
            status: 'done',
            outcome: 'proposal-created',
            proposalCreated: true,
            proposalId: 'p-api',
            diffFiles: 2,
            diffLines: 13,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            costUsd: usage.estCostUsd,
            actionCounts: {
              modelSteps: 1,
              totalSteps: 2,
              proposalCaptureAttempts: 1,
              diffFiles: 2,
              diffLines: 13,
              proposalCreated: 1,
              proposalBlocked: 0,
              proposalDisabled: 0,
            },
          },
        },
        proposalId: 'p-api',
        proposalOutcome: filedOutcome,
      };
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({ ok: true, command: 'npm test', exitCode: 0, output: 'All pass', timedOut: false });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    });

    const attemptOpts = engineMockFn.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(attemptOpts).toMatchObject({ propose: false });
    const captureOpts = captureMockFn.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(captureOpts).toMatchObject({
      runId: apiProducerState.id,
      sourceLabel: 'TITRR api-model',
      producerStatus: 'done',
      usage,
    });
    expect(captureOpts['actionCounts']).toMatchObject({
      modelSteps: 1,
      totalSteps: 2,
      proposalDisabled: 1,
    });

    expect(state.id).toBe(apiProducerState.id);
    expect(state.result).toBe('api model ok');
    expect(state.proposalOutcome).toMatchObject({ kind: 'filed', proposalId: 'p-api' });
    expect(state.runEventSummary).toMatchObject({
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'p-api',
      diffFiles: 2,
      diffLines: 13,
    });
    expect(state.runEventSummary?.actionCounts).toMatchObject({
      modelSteps: 1,
      totalSteps: 2,
      proposalCaptureAttempts: 1,
      proposalCreated: 1,
      proposalDisabled: 0,
      diffFiles: 2,
      diffLines: 13,
    });
  });

  // ---- Test 2: fail then pass → engine re-invoked ----
  it('fail then pass → re-invokes engine, annotates "tests: pass (attempt 2)"', async () => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({ status: 'done', result: 'engine ok' }),
      proposalId: 'p2',
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn
      .mockReturnValueOnce({ ok: false, command: 'npm test', exitCode: 1, output: 'FAIL: test-a', timedOut: false })
      .mockReturnValueOnce({ ok: true,  command: 'npm test', exitCode: 0, output: 'All pass',   timedOut: false });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(state.result).toMatch(/TITRR.*tests: pass \(attempt 2\)/);
    expect(engineMockFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ---- Test 3: exhausted maxAttempts ----
  it('exhausts maxAttempts → annotates "still failing"', async () => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({ status: 'done', result: 'engine ok' }),
      proposalId: 'p3',
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({ ok: false, command: 'npm test', exitCode: 1, output: 'FAIL', timedOut: false });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(state.result).toMatch(/TITRR.*still failing after 2 attempt\(s\)/);
  });

  // ---- Test 4: no test command → skip gracefully ----
  it('no test command detected → skips gracefully without throwing', async () => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({ status: 'done', result: 'engine ok' }),
      proposalId: 'p4',
    });
    // Only a typecheck command — no test kind.
    detectVCMockFn.mockReturnValue([{ kind: 'typecheck', cmd: ['npx', 'tsc', '--noEmit'] }]);

    const runGoal = await loadRunGoal();
    let error: unknown = null;
    let state;
    try {
      state = await runGoal('fix a bug', sandboxCfg(), {
        engine: 'claude',
        sandboxEngine: true,
        budget: { maxTokens: 1_000_000, maxSteps: 100 },
        tools: false,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeNull();
    expect(state).toBeDefined();
    expect(state!.result).toMatch(/TITRR.*tests: not detected \(skipped\)/);
    // runVerifyCommand must NOT have been called with a test-kind cmd.
    const testCalls = runVCMockFn.mock.calls.filter(
      (args) => (args[0] as { kind: string })?.kind === 'test',
    );
    expect(testCalls.length).toBe(0);
  });

  // ---- Test 5: budget exhausted mid-loop ----
  it('budget exhausted mid-loop → stops, annotation matches budget/still-failing', async () => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({
        status: 'done',
        result: 'engine ok',
        usage: { tokensIn: 100_000, tokensOut: 100_000, steps: 1, estCostUsd: 0 },
      }),
      proposalId: 'p5',
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({ ok: false, command: 'npm test', exitCode: 1, output: 'FAIL', timedOut: false });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 10, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 3,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(state.result).toMatch(/TITRR.*(budget exceeded|still failing)/);
    expect(engineMockFn.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
