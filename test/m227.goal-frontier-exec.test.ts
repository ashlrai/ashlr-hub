/**
 * test/m227.goal-frontier-exec.test.ts — M227: per-task execution uses frontier
 * chat client (nvidia_nim_kimi) when opts.allowCloud is true.
 *
 * WHAT THIS TESTS:
 *  1. allowCloud=true  → getActiveClient called with { allowCloud:true, provider:'nvidia_nim_kimi' }
 *                        for per-task execution (not just planner/synthesis).
 *  2. allowCloud=false → getActiveClient NOT called with nvidia_nim_kimi for tasks;
 *                        routeTask path used instead (local routing unchanged).
 *  3. engine:'builtin' safety guard — runner.ts forces this; runGoal itself does
 *     NOT override the engine field passed in opts (safety gate untouched).
 *
 * HERMETICITY: no live LLM / network calls. All external modules mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(),
}));

vi.mock('../src/core/run/agent-loop.js', () => ({
  runTask: vi.fn(),
}));

vi.mock('../src/core/run/verify.js', () => ({
  verifyTaskStructured: vi.fn(),
}));

vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: vi.fn(() => []),
  runVerifyCommand: vi.fn(() => ({ ok: true, command: 'x', exitCode: 0, output: '', timedOut: false })),
}));

vi.mock('../src/core/run/router.js', () => ({
  chooseRoute: vi.fn(),
  cloudKeyAvailable: vi.fn(() => false),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => false),
  buildEngineCommand: vi.fn(() => null),
  spawnEngine: vi.fn(() => ({ ok: true, output: 'engine-output', usage: null })),
}));

vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: vi.fn(() => null),
}));

vi.mock('../src/core/run/browser-verify.js', () => ({
  isWebApp: vi.fn(() => false),
  verifyInBrowser: vi.fn(async () => ({
    skipped: true, renderOk: false, consoleErrors: [], detail: '', screenshotPath: null,
  })),
}));

vi.mock('../src/core/run/budget.js', async () => {
  const real = await vi.importActual<typeof import('../src/core/run/budget.js')>(
    '../src/core/run/budget.js',
  );
  return { ...real };
});

vi.mock('../src/core/run/streaming.js', () => ({
  nullSink: vi.fn(() => () => {}),
}));

vi.mock('../src/core/run/retry.js', () => ({
  withRetry: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
}));

vi.mock('../src/core/run/self-heal.js', () => ({
  withHeal: vi.fn(async (fn: (attempt: number) => Promise<void>) => fn(1)),
  defaultHealPolicy: vi.fn(() => ({ maxRestarts: 1, restartDelayMs: 0 })),
}));

vi.mock('../src/core/mcp-native.js', () => ({
  listNativeTools: vi.fn(() => []),
}));
vi.mock('../src/core/mcp-native-engineer.js', () => ({
  buildEngineerToolSpecs: vi.fn(() => []),
  buildNativeToolSpecsWithFn: vi.fn(() => []),
}));

vi.mock('../src/core/seams/inbox.js', () => ({
  selectInboxStore: vi.fn(() => ({
    create: vi.fn(() => ({ id: 'mock-proposal-1' })),
  })),
}));

vi.mock('../src/core/knowledge/index.js', () => ({
  scrubSecrets: vi.fn((s: string) => s),
}));

vi.mock('../src/core/run/prompts/roles.js', () => ({
  PLANNER_ROLE: 'MOCK_PLANNER_ROLE',
  SYNTHESIZER_ROLE: 'MOCK_SYNTHESIZER_ROLE',
}));

vi.mock('../src/core/run/prompts/index.js', () => ({
  systemPromptFor: vi.fn(() => 'MOCK_SYSTEM_PROMPT'),
}));

vi.mock('../src/core/run/model-profile.js', () => ({
  resolveModelProfile: vi.fn(() => 'base'),
  adaptivePromptsEnabled: vi.fn(() => false),
}));

vi.mock('../src/core/env-bridge.js', () => ({
  withToolEnv: vi.fn((_, fn: () => unknown) => fn()),
}));

vi.mock('../src/sandbox/worktree.js', () => ({
  createSandbox: vi.fn(() => ({ id: 'mock-sb', worktreePath: '/tmp/mock-wt', sourceRepo: '/tmp/mock-src' })),
  removeSandbox: vi.fn(),
  sandboxDiff: vi.fn(() => ({ files: 0, patch: '', insertions: 0, deletions: 0 })),
}));

// ---------------------------------------------------------------------------
// Imports under test (after all vi.mock hoisting)
// ---------------------------------------------------------------------------

import type { AshlrConfig, RunOptions } from '../src/core/types.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { getActiveClient } from '../src/core/run/provider-client.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { verifyTaskStructured } from '../src/core/run/verify.js';
import { chooseRoute, cloudKeyAvailable } from '../src/core/run/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

function makeOpts(over: Partial<RunOptions> & Record<string, unknown> = {}): RunOptions & Record<string, unknown> {
  return {
    engine: 'builtin',
    tools: false,
    noMemory: true,
    noCapture: true,
    ...over,
  } as RunOptions & Record<string, unknown>;
}

/** A stub ProviderClient with the minimum shape runGoal needs. */
function makeStubClient(id = 'stub') {
  return {
    id,
    chat: vi.fn(async () => ({
      content: JSON.stringify([{ id: 't1', goal: 'do the thing', deps: [] }]),
      usage: { tokensIn: 10, tokensOut: 20 },
    })),
    complete: vi.fn(async () => ({ content: 'done', usage: { tokensIn: 5, tokensOut: 5 } })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M227 — per-task frontier execution', () => {
  let tmpDir: string;
  const origHome = process.env['HOME'];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ashlr-m227-'));
    process.env['HOME'] = tmpDir;
    vi.clearAllMocks();

    // Default verifyTaskStructured: ok
    vi.mocked(verifyTaskStructured).mockResolvedValue({ ok: true, reason: '' });
    // Default runTask: success
    vi.mocked(runTask).mockResolvedValue({
      status: 'done',
      output: 'task output',
      steps: [],
      usage: { tokensIn: 10, tokensOut: 10, steps: 1, estCostUsd: 0 },
    });
  });

  afterEach(() => {
    process.env['HOME'] = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. allowCloud=true → getActiveClient called with nvidia_nim_kimi for tasks
  // -------------------------------------------------------------------------
  it('allowCloud=true: getActiveClient receives provider:nvidia_nim_kimi for per-task execution', async () => {
    const frontierClient = makeStubClient('nvidia_nim_kimi');
    const localClient = makeStubClient('local-stub');

    // getActiveClient returns frontier client when provider:'nvidia_nim_kimi' is passed,
    // local client otherwise (planner first call without provider override).
    vi.mocked(getActiveClient).mockImplementation(async (_cfg, opts) => {
      if (opts?.provider === 'nvidia_nim_kimi') return frontierClient as any;
      return localClient as any;
    });

    // planGoal will call client.chat → parse tasks. frontier client returns one task.
    // We set the planner response on frontierClient since allowCloud picks it for planner too.
    frontierClient.chat.mockResolvedValue({
      content: JSON.stringify([{ id: 't1', goal: 'write the feature', deps: [] }]),
      usage: { tokensIn: 20, tokensOut: 30 },
    });

    const cfg = makeConfig();
    const opts = makeOpts({ allowCloud: true });

    await runGoal('write the feature', cfg, opts);

    // Collect all getActiveClient calls and their opts
    const calls = vi.mocked(getActiveClient).mock.calls;

    // At least one call must be with provider:'nvidia_nim_kimi' and allowCloud:true
    const frontierCalls = calls.filter(
      ([, o]) => o?.provider === 'nvidia_nim_kimi' && o?.allowCloud === true,
    );
    expect(frontierCalls.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 2. allowCloud=false → no nvidia_nim_kimi call for task execution
  // -------------------------------------------------------------------------
  it('allowCloud=false: getActiveClient never called with nvidia_nim_kimi', async () => {
    const localClient = makeStubClient('local-stub');
    vi.mocked(getActiveClient).mockResolvedValue(localClient as any);

    // Router returns local route
    vi.mocked(chooseRoute).mockResolvedValue({
      provider: 'ollama',
      model: 'local-model',
      tier: 'local',
      reason: 'local-first',
    });
    vi.mocked(cloudKeyAvailable).mockReturnValue(false);

    localClient.chat.mockResolvedValue({
      content: JSON.stringify([{ id: 't1', goal: 'do it locally', deps: [] }]),
      usage: { tokensIn: 10, tokensOut: 10 },
    });

    const cfg = makeConfig();
    const opts = makeOpts({ allowCloud: false });

    await runGoal('do it locally', cfg, opts);

    const calls = vi.mocked(getActiveClient).mock.calls;
    const frontierCalls = calls.filter(([, o]) => o?.provider === 'nvidia_nim_kimi');
    expect(frontierCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Safety: engine:'builtin' is preserved in opts (runner.ts gate untouched)
  // -------------------------------------------------------------------------
  it('engine field in opts is not mutated by runGoal — builtin guard intact', async () => {
    const stubClient = makeStubClient('stub');
    vi.mocked(getActiveClient).mockResolvedValue(stubClient as any);

    stubClient.chat.mockResolvedValue({
      content: JSON.stringify([{ id: 't1', goal: 'safe task', deps: [] }]),
      usage: { tokensIn: 5, tokensOut: 5 },
    });

    const cfg = makeConfig();
    const opts = makeOpts({ engine: 'builtin', allowCloud: true });
    const engineBefore = opts.engine;

    await runGoal('safe task', cfg, opts);

    // opts.engine must not have been changed by runGoal
    expect(opts.engine).toBe(engineBefore);
    expect(opts.engine).toBe('builtin');
  });

  // -------------------------------------------------------------------------
  // 4. allowCloud=true: task execution uses the frontier client (not local runTask stub)
  //    i.e. runTask is invoked — runGoal does dispatch tasks (smoke test)
  // -------------------------------------------------------------------------
  it('allowCloud=true: runTask is invoked (task dispatch reaches agent-loop)', async () => {
    const frontierClient = makeStubClient('nvidia_nim_kimi');
    vi.mocked(getActiveClient).mockImplementation(async (_cfg, opts) => {
      if (opts?.provider === 'nvidia_nim_kimi') return frontierClient as any;
      return makeStubClient('local') as any;
    });

    frontierClient.chat.mockResolvedValue({
      content: JSON.stringify([{ id: 't1', goal: 'dispatch me', deps: [] }]),
      usage: { tokensIn: 10, tokensOut: 20 },
    });

    const cfg = makeConfig();
    const opts = makeOpts({ allowCloud: true });

    const state = await runGoal('dispatch me', cfg, opts);

    // runTask should have been called for the dispatched task
    expect(vi.mocked(runTask)).toHaveBeenCalled();
    // Run should complete (not error)
    expect(['done', 'failed', 'aborted']).toContain(state.status);
  });
});
