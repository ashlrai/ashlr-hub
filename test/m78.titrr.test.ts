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
      expect(titrrTestRun(emptyDir, makeConfig())).toBeNull();
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
      expect(titrrTestRun(dir, makeConfig())).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws for a non-existent path', async () => {
    const { titrrTestRun } = await import('../src/core/run/orchestrator.js');
    expect(() => titrrTestRun('/nonexistent-m78-xyz', makeConfig())).not.toThrow();
    expect(titrrTestRun('/nonexistent-m78-xyz', makeConfig())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TITRR loop — uses vi.doMock + vi.resetModules() so dynamic imports are fresh
// ---------------------------------------------------------------------------

describe('TITRR loop — sandboxed-engine path (doMock + resetModules)', () => {
  // Mock factories — rebuilt per test via vi.doMock.
  let engineMockFn: ReturnType<typeof vi.fn>;
  let detectVCMockFn: ReturnType<typeof vi.fn>;
  let runVCMockFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    engineMockFn = vi.fn();
    detectVCMockFn = vi.fn();
    runVCMockFn = vi.fn();

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runEngineSandboxed: engineMockFn,
      // stub other named exports so imports don't break
      engineTierOf: vi.fn(() => 'frontier'),
      buildContainedEnv: vi.fn(() => ({})),
    }));

    vi.doMock('../src/sandbox/worktree.js', () => ({
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

    // Reset module registry so next import() picks up the doMock stubs.
    vi.resetModules();

    // Stub fetch so provider probe doesn't reach real network.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in TITRR test')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('../src/core/run/sandboxed-engine.js');
    vi.doUnmock('../src/sandbox/worktree.js');
    vi.doUnmock('../src/core/run/verify-commands.js');
    vi.doUnmock('../src/core/run/provider-client.js');
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
    });

    expect(state.result).toMatch(/TITRR.*tests: pass \(attempt 1\)/);
    expect(engineMockFn).toHaveBeenCalled();
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
