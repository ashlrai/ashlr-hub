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

function makeKnownDiffState(files: number) {
  const base = makeRunState({ status: 'done', result: files > 0 ? 'edited' : 'no edits' });
  const lines = files > 0 ? 4 : 0;
  return {
    ...base,
    proposalOutcome: {
      kind: 'proposal-disabled' as const,
      reason: 'proposal filing disabled for this internal attempt',
      files,
      insertions: lines,
      deletions: 0,
    },
    runEventSummary: {
      runId: base.id,
      status: 'done' as const,
      outcome: 'proposal-disabled',
      proposalCreated: false,
      diffFiles: files,
      diffLines: lines,
      actionCounts: {
        modelSteps: 1,
        toolSteps: files > 0 ? 1 : 0,
        totalSteps: files > 0 ? 2 : 1,
        proposalCaptureAttempts: 0,
        proposalDisabled: 1,
        diffFiles: files,
        diffLines: lines,
      },
    },
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
  let createSandboxMockFn: ReturnType<typeof vi.fn>;
  let removeSandboxMockFn: ReturnType<typeof vi.fn>;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m78-home-'));
    process.env.HOME = tmpHome;
    engineMockFn = vi.fn();
    captureMockFn = vi.fn(async (...args: unknown[]) => {
      const captureOptions = (args[3] ?? {}) as { isPartial?: boolean };
      return {
        state: makeRunState({ result: 'proposal captured' }),
        proposalId: 'p-captured',
        proposalOutcome: {
          kind: 'filed',
          reason: captureOptions.isPartial ? 'partial proposal filed' : 'proposal filed',
          ...(captureOptions.isPartial ? { isPartial: true } : {}),
          proposalId: 'p-captured',
        },
      };
    });
    detectVCMockFn = vi.fn();
    runVCMockFn = vi.fn();
    createSandboxMockFn = vi.fn(() => ({
      id: 'mock-sb',
      worktreePath: '/mock/wt',
      sourceRepo: '/mock/repo',
      branch: 'scratch/mock',
    }));
    removeSandboxMockFn = vi.fn();

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
      createSandbox: createSandboxMockFn,
      removeSandbox: removeSandboxMockFn,
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
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  // Lazy-load runGoal after doMock+resetModules so it picks up the fresh mocks.
  async function loadRunGoal() {
    const m = await import('../src/core/run/orchestrator.js');
    return m.runGoal;
  }

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label cancellation waits for verifier settlement before removing the sandbox', async ({ engine }) => {
    engineMockFn.mockResolvedValue({
      state: makeRunState({ status: 'done', result: 'producer completed' }),
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    let settleVerifier!: (result: {
      ok: boolean;
      command: string;
      exitCode: number;
      output: string;
      timedOut: boolean;
    }) => void;
    runVCMockFn.mockReturnValue(new Promise((resolve) => {
      settleVerifier = resolve;
    }));
    const controller = new AbortController();
    const runGoal = await loadRunGoal();

    let runSettled = false;
    const pending = runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      signal: controller.signal,
    }).finally(() => {
      runSettled = true;
    });
    await vi.waitFor(() => expect(runVCMockFn).toHaveBeenCalledTimes(1));
    expect(runVCMockFn.mock.calls[0]?.[3]).toMatchObject({
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runSettled).toBe(false);
    expect(removeSandboxMockFn).not.toHaveBeenCalled();

    settleVerifier({
      ok: false,
      command: 'npm test',
      exitCode: 1,
      output: 'cancelled',
      timedOut: false,
    });
    const state = await pending;

    expect(state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label cancellation before attempt 1 returns aborted without dereferencing a producer', async ({ engine }) => {
    const controller = new AbortController();
    createSandboxMockFn.mockImplementationOnce(() => {
      controller.abort();
      return {
        id: 'mock-sb',
        worktreePath: '/mock/wt',
        sourceRepo: '/mock/repo',
        branch: 'scratch/mock',
      };
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      signal: controller.signal,
    });

    expect(state).toMatchObject({
      status: 'aborted',
      terminationReason: 'cancelled',
      result: 'Run cancelled before execution.',
    });
    expect(engineMockFn).not.toHaveBeenCalled();
    expect(captureMockFn).not.toHaveBeenCalled();
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label cancellation after a done producer returns aborted and preserves usage', async ({ engine }) => {
    const controller = new AbortController();
    const usage = { tokensIn: 23, tokensOut: 17, steps: 2, estCostUsd: 0.42 };
    engineMockFn.mockImplementationOnce(async () => {
      controller.abort();
      return { state: makeRunState({ status: 'done', result: 'stale success', usage }) };
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      signal: controller.signal,
    });

    expect(engineMockFn.mock.calls[0]?.[3]).toMatchObject({ signal: controller.signal });
    expect(state).toMatchObject({
      status: 'aborted',
      terminationReason: 'cancelled',
      result: 'Run cancelled.',
      usage,
    });
    expect(captureMockFn).not.toHaveBeenCalled();
    expect(runVCMockFn).not.toHaveBeenCalled();
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label capture abort is not relabeled as producer done', async ({ engine }) => {
    const producer = makeRunState({ status: 'done', result: 'producer completed' });
    engineMockFn.mockResolvedValue({ state: producer });
    detectVCMockFn.mockReturnValue([]);
    captureMockFn.mockResolvedValueOnce({
      state: {
        ...makeRunState({ status: 'aborted', result: 'Capture cancelled.' }),
        id: producer.id,
        terminationReason: 'cancelled',
      },
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    });

    expect(state).toMatchObject({
      id: producer.id,
      status: 'aborted',
      terminationReason: 'cancelled',
      result: expect.stringContaining('Capture cancelled.'),
      usage: producer.usage,
    });
  });

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

  it('api-model step-cap output remains partial when TITRR owns capture', async () => {
    const partialDisabledOutcome = {
      kind: 'proposal-disabled' as const,
      reason: 'proposal filing disabled for this api-model attempt',
      isPartial: true,
    };
    const producer = {
      ...makeRunState({ status: 'done', result: '[step cap reached — partial result]' }),
      engine: 'local-coder' as const,
      engineModel: 'local-coder:qwen',
      engineTier: 'mid' as const,
      proposalOutcome: partialDisabledOutcome,
    };
    engineMockFn.mockResolvedValue({ state: producer, proposalOutcome: partialDisabledOutcome });
    detectVCMockFn.mockReturnValue([]);

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    });

    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.calls[0]?.[3]).toMatchObject({
      runId: producer.id,
      isPartial: true,
      producerStatus: 'done',
    });
    expect(state.proposalOutcome).toMatchObject({
      kind: 'filed',
      isPartial: true,
      proposalId: 'p-captured',
    });
  });

  it('failed CLI producer captures one partial proposal before sandbox cleanup', async () => {
    const failedState = makeRunState({ status: 'failed', result: 'engine failed after editing' });
    engineMockFn.mockResolvedValue({ state: failedState });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      workItemId: 'repair-cli-failed',
      workItemGenerationId: 'a'.repeat(64),
      workSource: 'self',
    });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.calls[0]?.[3]).toMatchObject({
      runId: failedState.id,
      isPartial: true,
      sourceLabel: 'TITRR',
      producerStatus: 'failed',
      workItemId: 'repair-cli-failed',
      workItemGenerationId: 'a'.repeat(64),
      workSource: 'self',
    });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.invocationCallOrder[0]).toBeLessThan(removeSandboxMockFn.mock.invocationCallOrder[0]!);
    expect(state.status).toBe('failed');
    expect(state.proposalOutcome).toMatchObject({ kind: 'filed', isPartial: true, proposalId: 'p-captured' });
    expect(state.result).toMatch(/producer failed; partial capture attempted/);
    expect(runVCMockFn).not.toHaveBeenCalled();
    const { loadRun } = await import('../src/core/run/orchestrator.js');
    expect(loadRun(state.id)).toMatchObject({
      status: 'failed',
      proposalOutcome: { kind: 'filed', isPartial: true },
      runEventSummary: { outcome: 'gate-blocked', proposalCreated: false },
    });
  });

  it('retains a shared CLI worktree and durable recovery metadata when cleanup is unconfirmed', async () => {
    const controller = new AbortController();
    const failedState = {
      ...makeRunState({ status: 'failed', result: 'process-group exit unconfirmed' }),
      terminationReason: 'error-exit' as const,
    };
    const sandboxRetention = {
      status: 'retained' as const,
      reason: 'process-cleanup-unconfirmed' as const,
      sandboxId: 'mock-sb',
      worktreePath: '/mock/wt',
      recovery: 'orphan-sweep' as const,
    };
    engineMockFn.mockImplementationOnce(async () => {
      controller.abort();
      return { state: failedState, sandboxRetention };
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      signal: controller.signal,
    });

    expect(state).toMatchObject({
      status: 'failed',
      terminationReason: 'error-exit',
      sandboxRetention,
    });
    expect(captureMockFn).not.toHaveBeenCalled();
    expect(runVCMockFn).not.toHaveBeenCalled();
    expect(removeSandboxMockFn).not.toHaveBeenCalled();
    const { loadRun } = await import('../src/core/run/orchestrator.js');
    expect(loadRun(state.id)).toMatchObject({
      status: 'failed',
      terminationReason: 'error-exit',
      sandboxRetention,
    });
  });

  it('failed CLI producer with an empty sandbox files no proposal and still cleans up', async () => {
    const failedState = makeRunState({ status: 'failed', result: 'engine failed before editing' });
    const emptyOutcome = {
      kind: 'empty-diff' as const,
      reason: 'engine "claude" completed without file changes',
      files: 0,
      insertions: 0,
      deletions: 0,
    };
    engineMockFn.mockResolvedValue({ state: failedState });
    captureMockFn.mockResolvedValueOnce({
      state: { ...makeRunState({ status: 'failed' }), id: failedState.id, proposalOutcome: emptyOutcome },
      proposalOutcome: emptyOutcome,
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    });

    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('failed');
    expect(state.proposalOutcome).toMatchObject({ kind: 'engine-failed-no-diff' });
    expect(state.proposalOutcome?.proposalId).toBeUndefined();
    const { loadRun } = await import('../src/core/run/orchestrator.js');
    expect(loadRun(state.id)?.proposalOutcome).toMatchObject({ kind: 'engine-failed-no-diff' });
  });

  it('failed API-model producer uses the same partial capture boundary', async () => {
    const failedState = {
      ...makeRunState({ status: 'failed', result: 'api model failed after editing' }),
      engine: 'local-coder' as const,
      engineModel: 'local-coder:qwen',
      engineTier: 'mid' as const,
    };
    engineMockFn.mockResolvedValue({ state: failedState });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      workItemId: 'repair-api-failed',
      workItemGenerationId: 'b'.repeat(64),
      workSource: 'self',
    });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.calls[0]?.[3]).toMatchObject({
      runId: failedState.id,
      isPartial: true,
      sourceLabel: 'TITRR api-model failed producer',
      producerStatus: 'failed',
      workItemId: 'repair-api-failed',
      workItemGenerationId: 'b'.repeat(64),
      workSource: 'self',
    });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.invocationCallOrder[0]).toBeLessThan(removeSandboxMockFn.mock.invocationCallOrder[0]!);
    expect(state.status).toBe('failed');
    expect(state.proposalOutcome).toMatchObject({ kind: 'filed', isPartial: true, proposalId: 'p-captured' });
    expect(runVCMockFn).not.toHaveBeenCalled();
    const { loadRun } = await import('../src/core/run/orchestrator.js');
    expect(loadRun(state.id)).toMatchObject({
      status: 'failed',
      proposalOutcome: { kind: 'filed', isPartial: true },
      runEventSummary: { outcome: 'gate-blocked', proposalCreated: false },
    });
  });

  it('failed API-model producer with an empty sandbox preserves failure typing', async () => {
    const failedState = {
      ...makeRunState({ status: 'failed', result: 'api model failed before editing' }),
      engine: 'local-coder' as const,
      engineModel: 'local-coder:qwen',
      engineTier: 'mid' as const,
    };
    const emptyOutcome = {
      kind: 'empty-diff' as const,
      reason: 'engine "local-coder" completed without file changes',
      files: 0,
      insertions: 0,
      deletions: 0,
    };
    engineMockFn.mockResolvedValue({ state: failedState });
    captureMockFn.mockResolvedValueOnce({
      state: { ...makeRunState({ status: 'failed' }), id: failedState.id, proposalOutcome: emptyOutcome },
      proposalOutcome: emptyOutcome,
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    });

    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('failed');
    expect(state.proposalOutcome).toMatchObject({ kind: 'api-model-task-failed' });
    expect(state.proposalOutcome?.proposalId).toBeUndefined();
    const { loadRun } = await import('../src/core/run/orchestrator.js');
    expect(loadRun(state.id)?.proposalOutcome).toMatchObject({ kind: 'api-model-task-failed' });
  });

  it('shared sandbox creation failure uses one self-capturing fallback attempt', async () => {
    createSandboxMockFn.mockImplementationOnce(() => { throw new Error('shared sandbox unavailable'); });
    engineMockFn.mockResolvedValue({ state: makeRunState({ status: 'failed', result: 'fallback failed' }) });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine: 'claude',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      workItemGenerationId: 'c'.repeat(64),
    });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(engineMockFn.mock.calls[0]?.[3]).toMatchObject({
      propose: true,
      workItemGenerationId: 'c'.repeat(64),
    });
    expect((engineMockFn.mock.calls[0]?.[3] as Record<string, unknown>)['existingWorktree']).toBeUndefined();
    expect(captureMockFn).not.toHaveBeenCalled();
    expect(removeSandboxMockFn).not.toHaveBeenCalled();
    expect(state.status).toBe('failed');
  });

  it.each([
    ['claude', 'claude'],
    ['local-coder', 'local-coder'],
  ] as const)('%s capture failure still removes the shared sandbox', async (engine, stateEngine) => {
    const producer = {
      ...makeRunState({ status: 'done', result: 'producer completed' }),
      engine: stateEngine,
    };
    engineMockFn.mockResolvedValue({ state: producer });
    captureMockFn.mockRejectedValueOnce(new Error('capture exploded'));
    detectVCMockFn.mockReturnValue([]);

    const runGoal = await loadRunGoal();
    await expect(runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
    })).rejects.toThrow('capture exploded');

    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.invocationCallOrder[0]).toBeLessThan(removeSandboxMockFn.mock.invocationCallOrder[0]!);
  });

  // ---- Test 2: fail then pass → engine re-invoked ----
  it('fail then pass → re-invokes engine, annotates "tests: pass (attempt 2)"', async () => {
    const runId = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1';
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
      runId,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(state.result).toMatch(/TITRR.*tests: pass \(attempt 2\)/);
    expect(engineMockFn).toHaveBeenCalledTimes(2);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(engineMockFn.mock.calls.every((call) => call[3]?.runId === runId)).toBe(true);
  });

  it('api-model fail then pass captures exactly once after the retry boundary', async () => {
    engineMockFn.mockResolvedValue({
      state: {
        ...makeRunState({ status: 'done', result: 'api model ok' }),
        engine: 'local-coder' as const,
        engineModel: 'local-coder:qwen',
        engineTier: 'mid' as const,
      },
    });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn
      .mockReturnValueOnce({ ok: false, command: 'npm test', exitCode: 1, output: 'FAIL', timedOut: false })
      .mockReturnValueOnce({ ok: true, command: 'npm test', exitCode: 0, output: 'pass', timedOut: false });

    const runGoal = await loadRunGoal();
    await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(2);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it('api-model test repair stops at the cumulative budget ceiling', async () => {
    const exhausted = makeKnownDiffState(1);
    exhausted.usage = { tokensIn: 5, tokensOut: 5, steps: 1, estCostUsd: 0 };
    engineMockFn.mockResolvedValue({ state: exhausted });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({
      ok: false,
      command: 'npm test',
      exitCode: 1,
      output: 'FAIL',
      timedOut: false,
    });

    const runGoal = await loadRunGoal();
    await runGoal('fix a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 10, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(runVCMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.calls[0]?.[3]).toMatchObject({
      isPartial: true,
      forceGateBlockReason: 'tests: still failing - budget exceeded after attempt 1',
      usage: exhausted.usage,
    });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label required-diff run retries one known-empty attempt before testing', async ({ engine }) => {
    engineMockFn
      .mockResolvedValueOnce({ state: makeKnownDiffState(0) })
      .mockResolvedValueOnce({ state: makeKnownDiffState(1) });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({
      ok: true,
      command: 'npm test',
      exitCode: 0,
      output: 'pass',
      timedOut: false,
    });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: '/mock/repo',
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(2);
    expect(String(engineMockFn.mock.calls[1]?.[1])).toMatch(/required-diff retry/);
    expect(String(engineMockFn.mock.calls[1]?.[1])).toMatch(/do not make a cosmetic edit/);
    expect(engineMockFn.mock.calls[1]?.[3]).toMatchObject({
      budget: { maxTokens: 999_998, maxSteps: 99, allowCloud: false },
    });
    expect(state.usage).toEqual({ tokensIn: 2, tokensOut: 2, steps: 2, estCostUsd: 0 });
    expect(state.runEventSummary?.actionCounts).toMatchObject({
      modelSteps: 2,
      toolSteps: 1,
      totalSteps: 3,
    });
    expect(runVCMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn.mock.calls[0]?.[3]).toMatchObject({
      usage: { tokensIn: 2, tokensOut: 2, steps: 2, estCostUsd: 0 },
      actionCounts: { modelSteps: 2, toolSteps: 1, totalSteps: 3 },
    });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label required-diff run captures once after two empty attempts', async ({ engine }) => {
    engineMockFn.mockResolvedValue({ state: makeKnownDiffState(0) });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: '/mock/repo',
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(2);
    expect(runVCMockFn).not.toHaveBeenCalled();
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(state.usage).toEqual({ tokensIn: 2, tokensOut: 2, steps: 2, estCostUsd: 0 });
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label required-diff run does not retry after exhausting its budget', async ({ engine }) => {
    const exhausted = makeKnownDiffState(0);
    exhausted.usage = { tokensIn: 5, tokensOut: 5, steps: 1, estCostUsd: 0 };
    engineMockFn.mockResolvedValue({ state: exhausted });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 10, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: '/mock/repo',
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(runVCMockFn).not.toHaveBeenCalled();
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(state.usage).toEqual(exhausted.usage);
    expect(removeSandboxMockFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { engine: 'claude' as const, label: 'CLI' },
    { engine: 'local-coder' as const, label: 'API-model' },
  ])('$label missing usage still consumes one TITRR step', async ({ engine }) => {
    const unknownUsage = makeKnownDiffState(0);
    unknownUsage.usage = { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 };
    engineMockFn.mockResolvedValue({ state: unknownUsage });

    const runGoal = await loadRunGoal();
    const state = await runGoal('fix a bug', sandboxCfg(), {
      engine,
      sandboxEngine: true,
      budget: { maxTokens: 100, maxSteps: 1 },
      tools: false,
      titrrMaxAttempts: 2,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: '/mock/repo',
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    expect(state.usage).toMatchObject({ tokensIn: 0, tokensOut: 0, steps: 1 });
  });

  it('does not retry a known-empty run when the result contract does not require a diff', async () => {
    engineMockFn.mockResolvedValue({ state: makeKnownDiffState(0) });
    detectVCMockFn.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'] }]);
    runVCMockFn.mockReturnValue({
      ok: true,
      command: 'npm test',
      exitCode: 0,
      output: 'pass',
      timedOut: false,
    });

    const runGoal = await loadRunGoal();
    await runGoal('inspect a bug', sandboxCfg(), {
      engine: 'local-coder',
      sandboxEngine: true,
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      tools: false,
      titrrMaxAttempts: 2,
    } as Parameters<typeof runGoal>[2] & { titrrMaxAttempts: number });

    expect(engineMockFn).toHaveBeenCalledTimes(1);
    expect(runVCMockFn).toHaveBeenCalledTimes(1);
    expect(captureMockFn).toHaveBeenCalledTimes(1);
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
    const usage = { tokensIn: 100_000, tokensOut: 100_000, steps: 1, estCostUsd: 0 };
    const staleDisabledOutcome = {
      kind: 'proposal-disabled' as const,
      reason: 'proposal filing disabled for this internal attempt',
      files: 7,
      insertions: 14,
      deletions: 0,
    };
    const producerBase = makeRunState({
      status: 'done',
      result: 'engine ok',
      usage,
    });
    const producerState = {
      ...producerBase,
      proposalOutcome: staleDisabledOutcome,
      runEventSummary: {
        runId: producerBase.id,
        status: 'done',
        outcome: 'proposal-disabled',
        diffFiles: 7,
        diffLines: 14,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.estCostUsd,
        actionCounts: {
          modelSteps: 1,
          totalSteps: 1,
          proposalCaptureAttempts: 0,
          diffFiles: 7,
          diffLines: 14,
          proposalCreated: 0,
          proposalBlocked: 0,
          proposalDisabled: 1,
        },
      },
    };
    const emptyDiffOutcome = {
      kind: 'empty-diff' as const,
      reason: 'engine "claude" completed without file changes',
      files: 0,
      insertions: 0,
      deletions: 0,
    };
    engineMockFn.mockResolvedValue({
      state: producerState,
      proposalOutcome: staleDisabledOutcome,
    });
    captureMockFn.mockImplementationOnce(async (_engine: unknown, _goal: unknown, _cfg: unknown, opts: { runId?: string }) => {
      const runId = opts.runId ?? 'run-budget-capture';
      return {
        state: {
          ...makeRunState({ status: 'done', result: 'empty diff captured', usage }),
          id: runId,
          proposalOutcome: emptyDiffOutcome,
          runEventSummary: {
            runId,
            status: 'done',
            outcome: 'empty-diff',
            proposalCreated: false,
            diffFiles: 0,
            diffLines: 0,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            costUsd: usage.estCostUsd,
            actionCounts: {
              modelSteps: 1,
              totalSteps: 1,
              proposalCaptureAttempts: 1,
              diffFiles: 0,
              diffLines: 0,
              proposalCreated: 0,
              proposalBlocked: 1,
              proposalDisabled: 0,
            },
          },
        },
        proposalOutcome: emptyDiffOutcome,
      };
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
    expect(captureMockFn).toHaveBeenCalledTimes(1);
    const captureOpts = captureMockFn.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(captureOpts?.['existingWorktree']).toMatchObject({ id: 'mock-sb' });
    expect(captureOpts?.['isPartial']).toBe(true);
    expect(captureOpts?.['forceGateBlockReason']).toMatch(/budget exceeded after attempt 1/);
    expect(captureOpts?.['sourceLabel']).toBe('TITRR');
    expect(captureOpts?.['usage']).toMatchObject(usage);
    expect(captureOpts?.['producerStatus']).toBe('done');
    expect(captureOpts?.['actionCounts']).toMatchObject({
      proposalCaptureAttempts: 0,
      proposalDisabled: 1,
      diffFiles: 7,
      diffLines: 14,
    });
    expect(state.proposalOutcome?.kind).toBe('empty-diff');
    expect(state.runEventSummary).toMatchObject({
      outcome: 'empty-diff',
      diffFiles: 0,
      diffLines: 0,
    });
    expect(state.runEventSummary?.actionCounts).toMatchObject({
      proposalCaptureAttempts: 1,
      proposalDisabled: 0,
      diffFiles: 0,
      diffLines: 0,
    });
  });
});
