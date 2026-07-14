/**
 * M12 runner tests — hermetic, mock runGoal + planner, no real agents, no network.
 *
 * SAFETY GUARDRAIL: HOME is overridden to a tmp dir; process.env.ASHLR_IN_SWARM
 * is cleaned up after each test. orchestrator.runGoal is mocked — no real agents
 * are spawned. No cloud calls, no outward actions.
 *
 * Covers:
 *   - runSwarm executes phases in order: scaffold -> build -> integrate -> verify -> review
 *   - runSwarm fans out build tasks in parallel up to --parallel cap
 *   - runSwarm respects --parallel ceiling (never exceeds it)
 *   - HARD total budget abort: aborts cleanly with partial SwarmRun when exceeded
 *   - Budget abort: all pending tasks marked failed/skipped after abort
 *   - Budget abort: returned SwarmRun has status='aborted'
 *   - runSwarm persists SwarmRun after every step (via store.saveSwarm)
 *   - --dry-run: plans without executing any task (runGoal never called)
 *   - RECURSION GUARD: refuses to start when ASHLR_IN_SWARM env var is set
 *   - NO OUTWARD ACTION: does not invoke push/deploy/repo-create in default mode
 *   - runSwarm sets ASHLR_IN_SWARM=1 on task subprocesses (env isolation)
 *   - runSwarm returns a complete SwarmRun on success (status='done')
 *   - runSwarm aggregates usage across all tasks
 *   - Phase ordering: integrate does not start until all build tasks complete
 *   - listSwarms / loadSwarm can find the completed run (persistence round-trip)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AshlrConfig,
  SwarmOptions,
  SwarmPlan,
  SwarmRun,
  RunState,
  RunUsage,
} from '../src/core/types.js';
import type { StreamSink } from '../src/core/run/streaming.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';

// ---------------------------------------------------------------------------
// Mock modules before any import of the runner
// ---------------------------------------------------------------------------

// Track calls to runGoal so we can assert ordering + concurrency
const runGoalCalls: Array<{ goal: string; startTime: number }> = [];
let runGoalDelay = 0; // ms to artificially delay each mock task
let runGoalUsagePerTask: RunUsage = { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 };
let runGoalShouldFail = false;

const mockRunGoal = vi.fn().mockImplementation(async (goal: string) => {
  const startTime = Date.now();
  runGoalCalls.push({ goal, startTime });
  if (runGoalDelay > 0) {
    await new Promise(r => setTimeout(r, runGoalDelay));
  }
  if (runGoalShouldFail) {
    throw new Error('mock task failure');
  }
  const state: Partial<RunState> = {
    id: `mock-run-${Math.random().toString(36).slice(2)}`,
    goal,
    status: 'done',
    result: `Result for: ${goal}`,
    usage: { ...runGoalUsagePerTask },
    tasks: [],
    steps: [],
  };
  return state as RunState;
});

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: mockRunGoal,
  saveRun: vi.fn(),
  loadRun: vi.fn().mockReturnValue(null),
  listRuns: vi.fn().mockReturnValue([]),
  planGoal: vi.fn(),
}));

// Mock the planner so we control the plan returned
const mockPlanSwarm = vi.fn();

vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mockPlanSwarm,
}));

// ---------------------------------------------------------------------------
// Override HOME before swarm store / runner is imported
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrInSwarm = process.env.ASHLR_IN_SWARM;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m12-runner-'));
}

// Lazy import
let runSwarm: (
  input: { goal: string; specId?: string },
  cfg: AshlrConfig,
  opts: SwarmOptions,
  sink: StreamSink,
) => Promise<SwarmRun>;

let swarmsDir: () => string;
let loadSwarm: (id: string) => SwarmRun | null;
let listSwarms: () => SwarmRun[];
let saveSwarm: (run: SwarmRun) => { ok: true; revision: number } | { ok: false; reason: string };

async function ensureImported(): Promise<void> {
  if (!runSwarm) {
    const runner = await import('../src/core/swarm/runner.js');
    runSwarm = runner.runSwarm;
    const store = await import('../src/core/swarm/store.js');
    swarmsDir = store.swarmsDir;
    loadSwarm = store.loadSwarm;
    listSwarms = store.listSwarms;
    saveSwarm = store.saveSwarm;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
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
  };
}

const nullSink: StreamSink = () => {};

/** Build a small, well-formed SwarmPlan for testing. */
function smallPlan(goal = 'test goal'): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [
      { id: 'scaffold-1', phase: 'scaffold', goal: 'Init project', deps: [] },
      { id: 'build-1', phase: 'build', goal: 'Build module A', deps: ['scaffold-1'] },
      { id: 'build-2', phase: 'build', goal: 'Build module B', deps: ['scaffold-1'] },
      { id: 'integrate-1', phase: 'integrate', goal: 'Wire modules', deps: ['build-1', 'build-2'] },
      { id: 'verify-1', phase: 'verify', goal: 'Run tests', deps: ['integrate-1'] },
      { id: 'review-1', phase: 'review', goal: 'Code review', deps: ['verify-1'] },
    ],
  };
}

/** Build a plan with only scaffold + build phases (simpler tests). */
function minimalPlan(goal = 'minimal goal'): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [
      { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
      { id: 'build-1', phase: 'build', goal: 'Build A', deps: ['scaffold-1'] },
    ],
  };
}

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  delete process.env.ASHLR_IN_SWARM;
  runGoalCalls.length = 0;
  runGoalDelay = 0;
  runGoalUsagePerTask = { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 };
  runGoalShouldFail = false;
  vi.clearAllMocks();
  mockRunGoal.mockImplementation(async (goal: string) => {
    const startTime = Date.now();
    runGoalCalls.push({ goal, startTime });
    if (runGoalDelay > 0) {
      await new Promise(r => setTimeout(r, runGoalDelay));
    }
    if (runGoalShouldFail) {
      throw new Error('mock task failure');
    }
    return {
      id: `mock-run-${Math.random().toString(36).slice(2)}`,
      goal,
      status: 'done' as const,
      result: `Result for: ${goal}`,
      usage: { ...runGoalUsagePerTask },
      tasks: [],
      steps: [],
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
    } as RunState;
  });
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrInSwarm === undefined) {
    delete process.env.ASHLR_IN_SWARM;
  } else {
    process.env.ASHLR_IN_SWARM = origAshlrInSwarm;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// RECURSION GUARD — must refuse when ASHLR_IN_SWARM is set
// ---------------------------------------------------------------------------

describe('RECURSION GUARD — refuses when ASHLR_IN_SWARM is set', () => {
  // The runner returns a SwarmRun with status='failed' (never throws) when
  // ASHLR_IN_SWARM is set — it does not reject the promise.

  it('returns status=failed when ASHLR_IN_SWARM=1 is set', async () => {
    process.env.ASHLR_IN_SWARM = '1';
    const result = await runSwarm({ goal: 'recursive swarm goal' }, makeConfig(), {}, nullSink);
    expect(result.status).toBe('failed');
  });

  it('result message mentions recursion / nesting when guard fires', async () => {
    process.env.ASHLR_IN_SWARM = '1';
    const result = await runSwarm({ goal: 'nested swarm' }, makeConfig(), {}, nullSink);
    expect(result.status).toBe('failed');
    // result field should mention nesting/swarm/recursion
    expect(result.result ?? '').toMatch(/swarm|nest|recurs|ASHLR_IN_SWARM/i);
  });

  it('does not call runGoal when recursion guard fires', async () => {
    process.env.ASHLR_IN_SWARM = '1';
    await runSwarm({ goal: 'blocked goal' }, makeConfig(), {}, nullSink);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('succeeds normally when ASHLR_IN_SWARM is not set', async () => {
    delete process.env.ASHLR_IN_SWARM;
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('normal goal'));
    const result = await runSwarm(
      { goal: 'normal goal' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    expect(['done', 'failed', 'aborted']).toContain(result.status);
  });
});

describe('runSwarm — owner cancellation', () => {
  it('returns aborted without planning or executing when pre-cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSwarm(
      { goal: 'cancelled swarm' },
      makeConfig(),
      { signal: controller.signal },
      nullSink,
    );

    expect(result.status).toBe('aborted');
    expect(result.result).toContain('cancelled before execution');
    expect(mockPlanSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('forwards cancellation to builtin tasks and stops later phases', async () => {
    const controller = new AbortController();
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('cancel in flight'));
    mockRunGoal.mockImplementationOnce(async (_goal: string, _cfg: AshlrConfig, runOpts: { signal?: AbortSignal }) => {
      expect(runOpts.signal).toBe(controller.signal);
      controller.abort();
      return {
        id: 'cancelled-task',
        goal: 'cancel in flight',
        status: 'aborted',
        result: 'Run cancelled.',
        usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
        tasks: [],
        steps: [],
      } as RunState;
    });

    const result = await runSwarm(
      { goal: 'cancel in flight' },
      makeConfig(),
      { signal: controller.signal },
      nullSink,
    );

    expect(result.status).toBe('aborted');
    expect(result.result).toContain('cancelled during phase scaffold');
    expect(result.tasks[0]?.status).toBe('cancelled');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('stops a cancelled manual planner before tasks or proposal capture', async () => {
    const controller = new AbortController();
    const reason = new Error('planning cancelled');
    reason.name = 'AbortError';
    mockPlanSwarm.mockImplementationOnce(
      async (_input: unknown, _cfg: AshlrConfig, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
        throw reason;
      },
    );

    const result = await runSwarm(
      { goal: 'cancel during planning' },
      makeConfig(),
      {
        signal: controller.signal,
      },
      nullSink,
    );

    expect(result.status).toBe('aborted');
    expect(result.result).toBe('Swarm cancelled during planning.');
    expect(result.tasks).toEqual([]);
    expect(result.proposalOutcome).toBeUndefined();
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('returns a pre-cancelled resume with its persisted identity and state unchanged', async () => {
    const plan: SwarmPlan = {
      specId: null,
      goal: 'preserve resume state',
      tasks: [{ id: 'scaffold-1', phase: 'scaffold', goal: 'Fail once', deps: [] }],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);
    mockRunGoal.mockRejectedValueOnce(new Error('ordinary failure'));

    const first = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      {},
      nullSink,
    );
    const snapshot = loadSwarm(first.id);
    expect(snapshot).not.toBeNull();
    const callsBeforeResume = mockRunGoal.mock.calls.length;

    delete process.env.ASHLR_IN_SWARM;
    const controller = new AbortController();
    controller.abort();
    const resumed = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      { resumeId: first.id, signal: controller.signal },
      nullSink,
    );

    expect(resumed).toEqual(snapshot);
    expect(resumed.id).toBe(first.id);
    expect(mockRunGoal).toHaveBeenCalledTimes(callsBeforeResume);
  });

  it('resets only a cancelled task when resuming the same swarm', async () => {
    const controller = new AbortController();
    const plan: SwarmPlan = {
      specId: null,
      goal: 'resume cancelled task',
      tasks: [{ id: 'scaffold-1', phase: 'scaffold', goal: 'Retry me', deps: [] }],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);
    mockRunGoal.mockImplementationOnce(async () => {
      controller.abort();
      return {
        id: 'cancelled-task',
        goal: 'Retry me',
        status: 'aborted',
        result: 'Run cancelled.',
        terminationReason: 'cancelled',
        usage: { tokensIn: 4, tokensOut: 2, steps: 0, estCostUsd: 0 },
        tasks: [],
        steps: [],
      } as RunState;
    });

    const first = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      { signal: controller.signal },
      nullSink,
    );
    expect(first.status).toBe('aborted');
    expect(first.tasks[0]?.status).toBe('cancelled');

    delete process.env.ASHLR_IN_SWARM;
    const resumed = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      { resumeId: first.id },
      nullSink,
    );

    expect(resumed.id).toBe(first.id);
    expect(resumed.status).toBe('done');
    expect(resumed.tasks[0]?.status).toBe('done');
    expect(mockPlanSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunGoal).toHaveBeenCalledTimes(2);
    expect(resumed.usage.tokensIn).toBe(104);
    expect(resumed.usage.tokensOut).toBe(52);
  });

  it('does not rerun an ordinary failed task on resume', async () => {
    const plan: SwarmPlan = {
      specId: null,
      goal: 'do not retry failure',
      tasks: [{ id: 'scaffold-1', phase: 'scaffold', goal: 'Fail normally', deps: [] }],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);
    mockRunGoal.mockRejectedValueOnce(new Error('ordinary failure'));

    const first = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      {},
      nullSink,
    );
    expect(first.status).toBe('failed');
    expect(first.tasks[0]?.status).toBe('failed');

    delete process.env.ASHLR_IN_SWARM;
    const resumed = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      { resumeId: first.id },
      nullSink,
    );

    expect(resumed.status).toBe('failed');
    expect(resumed.tasks[0]?.status).toBe('failed');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// --dry-run — plan without executing
// ---------------------------------------------------------------------------

describe('--dry-run — plans without executing any task', () => {
  it('returns a SwarmRun without calling runGoal', async () => {
    mockPlanSwarm.mockResolvedValueOnce(smallPlan('dry run goal'));
    const result = await runSwarm(
      { goal: 'dry run goal' },
      makeConfig(),
      { dryRun: true, budget: { maxTokens: 1_000_000, maxSteps: 1000 } },
      nullSink,
    );
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('dry-run result contains the plan', async () => {
    const plan = smallPlan('dry run with plan');
    mockPlanSwarm.mockResolvedValueOnce(plan);
    const result = await runSwarm(
      { goal: 'dry run with plan' },
      makeConfig(),
      { dryRun: true },
      nullSink,
    );
    expect(result.plan).toBeDefined();
    expect(result.plan.tasks.length).toBe(plan.tasks.length);
  });

  it('dry-run all tasks have status pending (no execution)', async () => {
    mockPlanSwarm.mockResolvedValueOnce(smallPlan('dry run pending'));
    const result = await runSwarm(
      { goal: 'dry run pending' },
      makeConfig(),
      { dryRun: true },
      nullSink,
    );
    for (const t of result.tasks) {
      expect(t.status).toBe('pending');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase ordering — scaffold -> build -> integrate -> verify -> review
// ---------------------------------------------------------------------------

describe('runSwarm — executes phases in order', () => {
  it('scaffold tasks run before build tasks', async () => {
    const plan = smallPlan('phase order goal');
    mockPlanSwarm.mockResolvedValueOnce(plan);
    const completionOrder: string[] = [];

    mockRunGoal.mockImplementation(async (goal: string) => {
      completionOrder.push(goal);
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    const result = await runSwarm(
      { goal: 'phase order goal' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 3 },
      nullSink,
    );

    expect(result.status).toBe('done');

    // Scaffold must complete before build
    const scaffoldIdx = completionOrder.findIndex(g => g.includes('Init project'));
    const buildIdx = completionOrder.findIndex(g => g.includes('Build module'));
    expect(scaffoldIdx).toBeLessThan(buildIdx);
  });

  it('integrate tasks run after all build tasks', async () => {
    const plan = smallPlan('integrate ordering');
    mockPlanSwarm.mockResolvedValueOnce(plan);
    const completionOrder: string[] = [];

    mockRunGoal.mockImplementation(async (goal: string) => {
      completionOrder.push(goal);
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    await runSwarm(
      { goal: 'integrate ordering' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 3 },
      nullSink,
    );

    const buildIndices = completionOrder
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.includes('Build module'))
      .map(({ i }) => i);
    const integrateIdx = completionOrder.findIndex(g => g.includes('Wire modules'));

    expect(integrateIdx).toBeGreaterThan(-1);
    for (const bi of buildIndices) {
      expect(integrateIdx).toBeGreaterThan(bi);
    }
  });

  it('verify tasks run after integrate tasks', async () => {
    const plan = smallPlan('verify ordering');
    mockPlanSwarm.mockResolvedValueOnce(plan);
    const completionOrder: string[] = [];

    mockRunGoal.mockImplementation(async (goal: string) => {
      completionOrder.push(goal);
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    await runSwarm(
      { goal: 'verify ordering' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 3 },
      nullSink,
    );

    const integrateIdx = completionOrder.findIndex(g => g.includes('Wire modules'));
    const verifyIdx = completionOrder.findIndex(g => g.includes('Run tests'));
    if (verifyIdx >= 0 && integrateIdx >= 0) {
      expect(verifyIdx).toBeGreaterThan(integrateIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Parallelism — build tasks fan out
// ---------------------------------------------------------------------------

describe('runSwarm — parallel task execution', () => {
  it('launches multiple build tasks concurrently (parallel:3)', async () => {
    // Plan with 3 independent build tasks
    const plan: SwarmPlan = {
      specId: null,
      goal: 'parallel build test',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
        { id: 'build-1', phase: 'build', goal: 'Build A', deps: ['scaffold-1'] },
        { id: 'build-2', phase: 'build', goal: 'Build B', deps: ['scaffold-1'] },
        { id: 'build-3', phase: 'build', goal: 'Build C', deps: ['scaffold-1'] },
      ],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    // Give build tasks a small delay to allow overlap detection
    let activeBuilds = 0;
    let peakBuilds = 0;
    runGoalDelay = 10;
    mockRunGoal.mockImplementation(async (goal: string) => {
      const isBuild = ['Build A', 'Build B', 'Build C'].some((label) => goal.includes(label));
      if (isBuild) {
        activeBuilds++;
        peakBuilds = Math.max(peakBuilds, activeBuilds);
      }
      await new Promise(r => setTimeout(r, 10));
      if (isBuild) activeBuilds--;
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    const result = await runSwarm(
      { goal: 'parallel build test' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 3 },
      nullSink,
    );
    expect(result.status).toBe('done');
    // Assert actual overlap rather than wall-clock proximity, which is sensitive
    // to scheduler load when the exhaustive suite runs hundreds of test files.
    expect(peakBuilds).toBeGreaterThanOrEqual(2);
  });

  it('never exceeds --parallel cap', async () => {
    // 5 independent build tasks, parallel:2 → at most 2 concurrent
    const plan: SwarmPlan = {
      specId: null,
      goal: 'parallel cap test',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `build-${i + 1}`,
          phase: 'build' as const,
          goal: `Build ${i + 1}`,
          deps: ['scaffold-1'],
        })),
      ],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    let concurrent = 0;
    let maxConcurrent = 0;

    mockRunGoal.mockImplementation(async (goal: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 5));
      concurrent--;
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    await runSwarm(
      { goal: 'parallel cap test' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 2 },
      nullSink,
    );

    // Concurrency must never exceed parallel:2
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// HARD TOTAL BUDGET — abort with partial state
// ---------------------------------------------------------------------------

describe('runSwarm — HARD total budget abort', () => {
  it('aborts when total token usage exceeds maxTokens', async () => {
    // Each task costs 200 tokens; budget allows only 150 total
    // → first task will push us over
    runGoalUsagePerTask = { tokensIn: 100, tokensOut: 100, steps: 1, estCostUsd: 0 };
    const plan = minimalPlan('budget abort goal');
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const result = await runSwarm(
      { goal: 'budget abort goal' },
      makeConfig(),
      { budget: { maxTokens: 150, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    expect(result.status).toBe('aborted');
  });

  it('aborts when maxSteps is exceeded', async () => {
    runGoalUsagePerTask = { tokensIn: 10, tokensOut: 5, steps: 5, estCostUsd: 0 };
    const plan = smallPlan('steps abort goal');
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const result = await runSwarm(
      { goal: 'steps abort goal' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 3 }, parallel: 1 },
      nullSink,
    );

    expect(result.status).toBe('aborted');
  });

  it('aborted SwarmRun has valid shape (not undefined/null)', async () => {
    runGoalUsagePerTask = { tokensIn: 1000, tokensOut: 1000, steps: 1, estCostUsd: 0 };
    const plan = minimalPlan('abort shape');
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const result = await runSwarm(
      { goal: 'abort shape' },
      makeConfig(),
      { budget: { maxTokens: 100, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    expect(result).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(typeof result.goal).toBe('string');
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(typeof result.usage.tokensIn).toBe('number');
  });

  it('pending tasks are marked failed/skipped after budget abort, not running', async () => {
    runGoalUsagePerTask = { tokensIn: 1000, tokensOut: 1000, steps: 1, estCostUsd: 0 };
    // Plan with multiple tasks; first one should push over budget
    const plan: SwarmPlan = {
      specId: null,
      goal: 'abort pending tasks',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
        { id: 'build-1', phase: 'build', goal: 'Build A', deps: ['scaffold-1'] },
        { id: 'build-2', phase: 'build', goal: 'Build B', deps: ['scaffold-1'] },
      ],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const result = await runSwarm(
      { goal: 'abort pending tasks' },
      makeConfig(),
      { budget: { maxTokens: 500, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    // No task should be left in 'running' state
    for (const t of result.tasks) {
      expect(t.status).not.toBe('running');
    }
    // Status should be aborted
    expect(result.status).toBe('aborted');
  });

  it('does not throw on budget abort (resolves with SwarmRun)', async () => {
    runGoalUsagePerTask = { tokensIn: 5000, tokensOut: 5000, steps: 100, estCostUsd: 0 };
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('no throw on abort'));

    await expect(
      runSwarm(
        { goal: 'no throw on abort' },
        makeConfig(),
        { budget: { maxTokens: 10, maxSteps: 1 }, parallel: 1 },
        nullSink,
      )
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence — save after every step
// ---------------------------------------------------------------------------

describe('runSwarm — persists state after each step', () => {
  it('fails closed without throwing for an invalid caller-preallocated id', async () => {
    const result = await runSwarm(
      { goal: 'invalid id' },
      makeConfig(),
      { runId: '../escape' },
      nullSink,
    );

    expect(result.status).toBe('failed');
    expect(result.result).toMatch(/run id is invalid/i);
    expect(runGoalCalls).toHaveLength(0);
  });

  it('refuses a duplicate fresh id without overwriting the existing swarm', async () => {
    const runId = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1';
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('first owner'));
    const first = await runSwarm(
      { goal: 'first owner' },
      makeConfig(),
      { runId, budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    delete process.env.ASHLR_IN_SWARM;

    const second = await runSwarm(
      { goal: 'duplicate owner' },
      makeConfig(),
      { runId },
      nullSink,
    );

    expect(first.id).toBe(runId);
    expect(second.status).toBe('failed');
    expect(second.result).toMatch(/already exists/i);
    expect(loadSwarm(runId)?.goal).toBe('first owner');
  });

  it('surfaces a concurrent resume conflict without throwing or overwriting the winner', async () => {
    const runId = 'concurrent-resume-generation';
    const goal = 'concurrent resume';
    const now = new Date().toISOString();
    const initial: SwarmRun = {
      id: runId,
      goal,
      specId: null,
      project: null,
      createdAt: now,
      updatedAt: now,
      budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
      parallel: 1,
      status: 'aborted',
      plan: minimalPlan(goal),
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', status: 'pending' },
        { id: 'build-1', phase: 'build', status: 'pending' },
      ],
    };
    expect(saveSwarm(initial)).toEqual({ ok: true, revision: 1 });

    const resumed = runSwarm(
      { goal },
      makeConfig(),
      { resumeId: runId },
      nullSink,
    );
    const winner = loadSwarm(runId)!;
    winner.status = 'done';
    winner.result = 'Concurrent winner';
    expect(saveSwarm(winner)).toEqual({ ok: true, revision: 2 });

    await expect(resumed).resolves.toMatchObject({
      id: runId,
      status: 'failed',
      result: expect.stringMatching(/persistence generation conflict/i),
    });
    expect(loadSwarm(runId)).toMatchObject({
      status: 'done',
      result: 'Concurrent winner',
    });
  });

  it('stops a resumed swarm before task side effects when its write lock is unavailable', async () => {
    const runId = 'locked-resume-generation';
    const goal = 'locked resume';
    const now = new Date().toISOString();
    const initial: SwarmRun = {
      id: runId,
      goal,
      specId: null,
      project: null,
      createdAt: now,
      updatedAt: now,
      budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
      parallel: 1,
      status: 'aborted',
      plan: minimalPlan(goal),
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', status: 'pending' },
        { id: 'build-1', phase: 'build', status: 'pending' },
      ],
    };
    expect(saveSwarm(initial)).toEqual({ ok: true, revision: 1 });
    const folded = createHash('sha256').update(runId.toLowerCase()).digest('hex');
    const lock = acquireLocalStoreLock(path.join(swarmsDir(), `.write-lock-${folded}`));
    expect(lock).not.toBeNull();

    try {
      await expect(runSwarm(
        { goal },
        makeConfig(),
        { resumeId: runId },
        nullSink,
      )).resolves.toMatchObject({
        id: runId,
        status: 'failed',
        result: expect.stringMatching(/persistence unavailable/i),
      });
    } finally {
      releaseLocalStoreLock(lock);
    }

    expect(runGoalCalls).toHaveLength(0);
    expect(loadSwarm(runId)).toMatchObject({ status: 'aborted' });
  }, 10_000);

  it('swarm file exists on disk after runSwarm completes', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('persist test'));
    const result = await runSwarm(
      { goal: 'persist test' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    const dir = swarmsDir();
    const filePath = path.join(dir, `${result.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('loadSwarm can find the completed run by id', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('loadable run'));
    const result = await runSwarm(
      { goal: 'loadable run' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    const loaded = loadSwarm(result.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(result.id);
  });

  it('listSwarms includes the completed run', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('list test'));
    const result = await runSwarm(
      { goal: 'list test' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    const all = listSwarms();
    expect(all.some(s => s.id === result.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Successful completion
// ---------------------------------------------------------------------------

describe('runSwarm — successful completion', () => {
  it('returns status=done when all tasks succeed', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('success goal'));
    const result = await runSwarm(
      { goal: 'success goal' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    expect(result.status).toBe('done');
  });

  it('all tasks have status=done on success', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('all tasks done'));
    const result = await runSwarm(
      { goal: 'all tasks done' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    for (const t of result.tasks) {
      expect(t.status).toBe('done');
    }
  });

  it('usage is aggregated across all tasks', async () => {
    runGoalUsagePerTask = { tokensIn: 50, tokensOut: 25, steps: 1, estCostUsd: 0 };
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('usage aggregate'));
    const result = await runSwarm(
      { goal: 'usage aggregate' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    // 2 tasks × 50 tokensIn = 100 tokensIn minimum
    expect(result.usage.tokensIn).toBeGreaterThanOrEqual(100);
    expect(result.usage.tokensOut).toBeGreaterThanOrEqual(50);
  });

  it('includes exact planner tokens without inventing planner steps or cost', async () => {
    runGoalUsagePerTask = { tokensIn: 50, tokensOut: 25, steps: 1, estCostUsd: 0 };
    const plan = minimalPlan('planner usage aggregate');
    plan.usage = { tokensIn: 7, tokensOut: 3 };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const result = await runSwarm(
      { goal: plan.goal },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    expect(result.usage).toEqual({
      tokensIn: 107,
      tokensOut: 53,
      steps: 2,
      estCostUsd: 0,
    });
  });

  it('result.goal matches the input goal', async () => {
    const goal = 'Check goal preserved';
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan(goal));
    const result = await runSwarm(
      { goal },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    expect(result.goal).toBe(goal);
  });

  it('result has valid ISO createdAt and updatedAt', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('timestamp check'));
    const result = await runSwarm(
      { goal: 'timestamp check' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    expect(() => new Date(result.createdAt)).not.toThrow();
    expect(() => new Date(result.updatedAt)).not.toThrow();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  it('result has a non-empty swarm id', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('id check'));
    const result = await runSwarm(
      { goal: 'id check' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Streaming — sink receives events
// ---------------------------------------------------------------------------

describe('runSwarm — streaming events', () => {
  it('sink receives at least one event during execution', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('stream test'));
    const events: Parameters<StreamSink>[0][] = [];
    const sink: StreamSink = (e) => events.push(e);

    await runSwarm(
      { goal: 'stream test' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      sink,
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it('sink events have the required ts and kind fields', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('event shape'));
    const events: Parameters<StreamSink>[0][] = [];
    const sink: StreamSink = (e) => events.push(e);

    await runSwarm(
      { goal: 'event shape' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      sink,
    );

    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(typeof e.kind).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// NO OUTWARD ACTION — default mode must not invoke destructive operations
// ---------------------------------------------------------------------------

describe('runSwarm — NO OUTWARD ACTION in default mode', () => {
  it('does not invoke git push in any task goal (default mode)', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('safe operation'));
    const invocations: string[] = [];
    mockRunGoal.mockImplementation(async (goal: string) => {
      invocations.push(goal);
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    await runSwarm(
      { goal: 'safe operation' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    // None of the task goals should include outward/destructive verbs
    for (const inv of invocations) {
      expect(inv.toLowerCase()).not.toMatch(/\bgit push\b/);
      expect(inv.toLowerCase()).not.toMatch(/\bdeploy\b.*--confirm/);
      expect(inv.toLowerCase()).not.toMatch(/\bship --confirm\b/);
    }
  });

  it('tasks are invoked with a project-scoped working context, not system-wide', async () => {
    const projectDir = path.join(tmpHome, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('scoped project'));

    const result = await runSwarm(
      { goal: 'scoped project' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, project: projectDir },
      nullSink,
    );

    // Swarm run should record the project path
    expect(result.project).toBe(projectDir);
  });
});

// ---------------------------------------------------------------------------
// LOCAL-FIRST — does not use cloud by default
// ---------------------------------------------------------------------------

describe('runSwarm — local-first (no cloud without --allow-cloud)', () => {
  it('runGoal is called without allowCloud=true by default', async () => {
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('local first'));
    const capturedOpts: unknown[] = [];
    mockRunGoal.mockImplementation(async (goal: string, _cfg: AshlrConfig, opts: unknown) => {
      capturedOpts.push(opts);
      return {
        id: `run-${Math.random().toString(36).slice(2)}`,
        goal, status: 'done' as const, result: `done: ${goal}`,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
        tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
      } as RunState;
    });

    await runSwarm(
      { goal: 'local first' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    // Each runGoal call must NOT have allowCloud: true unless --allow-cloud was set
    for (const opts of capturedOpts) {
      const o = opts as { allowCloud?: boolean };
      expect(o?.allowCloud).not.toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// HARD TOTAL BUDGET — concurrent batch can NEVER overshoot the ceiling
// ---------------------------------------------------------------------------

describe('runSwarm — concurrent BUILD batch never overshoots hard budget', () => {
  it('sum of per-task authorized budgets in one batch stays <= total', async () => {
    // 6 independent build tasks, parallel:6 → all in ONE concurrent batch.
    // Each task records the budget it was AUTHORIZED (taskBudget.maxTokens).
    // The sum of all authorizations in the batch must not exceed the hard total.
    // Record (goal, authorizedTokens) so we can isolate the concurrent BUILD
    // batch (the scaffold task runs sequentially before the batch and its
    // authorization ceiling is irrelevant to the concurrency invariant).
    const authByGoal: Array<{ goal: string; tokens: number }> = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: AshlrConfig, opts: { budget?: { maxTokens?: number } }) => {
        authByGoal.push({ goal, tokens: opts?.budget?.maxTokens ?? 0 });
        // Hold the task open briefly so all siblings are in-flight together,
        // proving the reservation (not stale run.usage) bounds the batch.
        await new Promise((r) => setTimeout(r, 15));
        return {
          id: `run-${Math.random().toString(36).slice(2)}`,
          goal, status: 'done' as const, result: `done: ${goal}`,
          usage: { tokensIn: 50, tokensOut: 50, steps: 1, estCostUsd: 0 },
          tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
        } as RunState;
      },
    );

    const plan: SwarmPlan = {
      specId: null,
      goal: 'overshoot guard',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
        { id: 'build-1', phase: 'build', goal: 'B1', deps: ['scaffold-1'] },
        { id: 'build-2', phase: 'build', goal: 'B2', deps: ['scaffold-1'] },
        { id: 'build-3', phase: 'build', goal: 'B3', deps: ['scaffold-1'] },
        { id: 'build-4', phase: 'build', goal: 'B4', deps: ['scaffold-1'] },
        { id: 'build-5', phase: 'build', goal: 'B5', deps: ['scaffold-1'] },
        { id: 'build-6', phase: 'build', goal: 'B6', deps: ['scaffold-1'] },
      ],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const TOTAL = 40_000;
    await runSwarm(
      { goal: 'overshoot guard' },
      makeConfig(),
      { budget: { maxTokens: TOTAL, maxSteps: 1000 }, parallel: 6 },
      nullSink,
    );

    // Isolate the 6 build tasks that run concurrently in ONE batch. The
    // scaffold task ran first (sequentially) and only spent 100 tokens. The
    // sum of the 6 CONCURRENT authorizations must stay within the hard total —
    // this is the invariant the old code violated (8 x 25% = ~200%).
    const buildAuth = authByGoal.filter((a) => /Task: B\d$/.test(a.goal)).map((a) => a.tokens);
    expect(buildAuth.length).toBe(6);
    const sumBuild = buildAuth.reduce((a, b) => a + b, 0);
    expect(sumBuild).toBeLessThanOrEqual(TOTAL);
    // And no single task exceeded 25% of the total ceiling.
    for (const a of buildAuth) {
      expect(a).toBeLessThanOrEqual(Math.ceil(TOTAL / 4));
    }
  });

  it('exhausted pool skips remaining concurrent tasks rather than over-authorizing', async () => {
    // Tiny budget: after scaffold spends, the build batch pool is nearly empty.
    // Tasks beyond the pool must be skipped, never authorized phantom budget.
    const authorizedTokens: number[] = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: AshlrConfig, opts: { budget?: { maxTokens?: number } }) => {
        authorizedTokens.push(opts?.budget?.maxTokens ?? 0);
        return {
          id: `run-${Math.random().toString(36).slice(2)}`,
          goal, status: 'done' as const, result: `done: ${goal}`,
          usage: { tokensIn: 400, tokensOut: 400, steps: 1, estCostUsd: 0 },
          tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
        } as RunState;
      },
    );

    const plan: SwarmPlan = {
      specId: null,
      goal: 'tiny budget batch',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
        { id: 'build-1', phase: 'build', goal: 'B1', deps: ['scaffold-1'] },
        { id: 'build-2', phase: 'build', goal: 'B2', deps: ['scaffold-1'] },
        { id: 'build-3', phase: 'build', goal: 'B3', deps: ['scaffold-1'] },
      ],
    };
    mockPlanSwarm.mockResolvedValueOnce(plan);

    const TOTAL = 1_000;
    const result = await runSwarm(
      { goal: 'tiny budget batch' },
      makeConfig(),
      { budget: { maxTokens: TOTAL, maxSteps: 1000 }, parallel: 3 },
      nullSink,
    );

    const sumAuthorized = authorizedTokens.reduce((a, b) => a + b, 0);
    expect(sumAuthorized).toBeLessThanOrEqual(TOTAL);
    // Some build task should be skipped for budget-exhaustion, not left running.
    for (const t of result.tasks) {
      expect(t.status).not.toBe('running');
    }
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL NO-OUTWARD GUARD — tasks forced to builtin engine + project cwd
// ---------------------------------------------------------------------------

describe('runSwarm — structural no-outward guard (engine forced to builtin)', () => {
  it('every runGoal call forces engine="builtin"', async () => {
    const capturedOpts: Array<{ engine?: string }> = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: AshlrConfig, opts: { engine?: string }) => {
        capturedOpts.push(opts);
        return {
          id: `run-${Math.random().toString(36).slice(2)}`,
          goal, status: 'done' as const, result: `done: ${goal}`,
          usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
          tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
        } as RunState;
      },
    );
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('builtin forced'));

    await runSwarm(
      { goal: 'builtin forced' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    expect(capturedOpts.length).toBeGreaterThan(0);
    for (const o of capturedOpts) {
      expect(o.engine).toBe('builtin');
    }
  });

  it('passes the target project dir through to runGoal as cwd', async () => {
    const projectDir = path.join(tmpHome, 'target-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const capturedOpts: Array<{ cwd?: string }> = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: AshlrConfig, opts: { cwd?: string }) => {
        capturedOpts.push(opts);
        return {
          id: `run-${Math.random().toString(36).slice(2)}`,
          goal, status: 'done' as const, result: `done: ${goal}`,
          usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
          tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
        } as RunState;
      },
    );
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('cwd threading'));

    await runSwarm(
      { goal: 'cwd threading' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, project: projectDir },
      nullSink,
    );

    expect(capturedOpts.length).toBeGreaterThan(0);
    for (const o of capturedOpts) {
      expect(o.cwd).toBe(projectDir);
    }
  });

  it('threads bounded delegation scope into every swarm task run', async () => {
    const projectDir = path.join(tmpHome, 'scoped-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const capturedOpts: Array<{ delegationScope?: Record<string, unknown> }> = [];
    mockRunGoal.mockImplementation(
      async (goal: string, _cfg: AshlrConfig, opts: { delegationScope?: Record<string, unknown> }) => {
        capturedOpts.push(opts);
        return {
          id: `run-${Math.random().toString(36).slice(2)}`,
          goal, status: 'done' as const, result: `done: ${goal}`,
          usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
          tasks: [], steps: [], engine: 'builtin', provider: 'ollama',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
        } as RunState;
      },
    );
    mockPlanSwarm.mockResolvedValueOnce(minimalPlan('scoped swarm'));

    await runSwarm(
      { goal: 'scoped swarm' },
      makeConfig(),
      {
        budget: { maxTokens: 1_000_000, maxSteps: 1000 },
        parallel: 1,
        project: projectDir,
        workItemId: 'work-123',
        workSource: 'manual',
        delegationScope: {
          origin: 'daemon',
          sourceRepo: projectDir,
          allowedFiles: { include: ['src/focus.ts'] },
          memoryMode: 'bounded',
          resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        },
      },
      nullSink,
    );

    expect(capturedOpts.length).toBeGreaterThan(0);
    expect(capturedOpts[0]?.delegationScope).toMatchObject({
      origin: 'swarm',
      sourceRepo: projectDir,
      executionRoot: projectDir,
      workItemId: 'work-123',
      workSource: 'manual',
      taskId: 'scaffold-1',
      objective: 'Init',
      memoryMode: 'bounded',
      allowedFiles: { include: ['src/focus.ts'] },
      resultContract: { kind: 'text' },
    });
    expect(capturedOpts[0]?.delegationScope?.['swarmId']).toEqual(expect.any(String));
    expect(capturedOpts[0]?.delegationScope?.['budget']).toMatchObject({
      maxTokens: expect.any(Number),
      maxSteps: expect.any(Number),
      allowCloud: false,
    });
  });
});

// ---------------------------------------------------------------------------
// RECURSION GUARD is a PROCESS boundary — runSwarm is reentrant in-process
// ---------------------------------------------------------------------------

describe('runSwarm — recursion guard is process-scoped, not call-scoped', () => {
  it('a second runSwarm in the same process is NOT refused', async () => {
    mockPlanSwarm.mockResolvedValue(minimalPlan('reentrant'));

    const first = await runSwarm(
      { goal: 'reentrant-1' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );
    // After the first swarm, ASHLR_IN_SWARM is set on this process.env.
    expect(process.env.ASHLR_IN_SWARM).toBe('1');

    // The guard must be a PROCESS boundary (it bounds child spawns), not a
    // per-call refusal — a same-process caller (e.g. the background worker
    // re-exec clears the var; here we simulate a fresh runner call) should be
    // able to proceed once the marker is cleared, exactly as the worker does.
    delete process.env.ASHLR_IN_SWARM;

    const second = await runSwarm(
      { goal: 'reentrant-2' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1 },
      nullSink,
    );

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect(second.result).not.toMatch(/Refused: nested swarm/i);
  });
});
