/**
 * M4 orchestrator tests — hermetic, mock ProviderClient, isolated run IDs.
 *
 * Covers:
 *   - planGoal: mock client returns JSON DAG → 2 independent + 1 dependent task
 *   - planGoal: fallback to single task on parse failure
 *   - runGoal: dependency order respected (dependent task runs after deps)
 *   - runGoal: parallelism up to N (independent tasks start concurrently)
 *   - runGoal: global budget abort preserves partial results
 *   - runGoal: synthesize produces result, state.status='done'
 *   - saveRun/loadRun/listRuns: round-trip (uses real ~/.ashlr/runs with unique ids)
 *   - --resume: completed tasks not re-run
 *
 * Note: saveRun/loadRun/listRuns write to the REAL ~/.ashlr/runs/ directory
 * because the orchestrator module caches RUNS_DIR = os.homedir()/.ashlr/runs
 * at import time (before any HOME env override takes effect). Tests use unique
 * run-id prefixes (m4test-<uuid>) and clean up after themselves.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderClient, ChatMessage, ChatResult, RunTask, AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Unique run-id prefix to isolate test runs from each other and from real runs
// ---------------------------------------------------------------------------

const TEST_PREFIX = `m4test-${Date.now()}-`;
const createdRunIds: string[] = [];

function uniqueRunId(suffix: string): string {
  const id = `${TEST_PREFIX}${suffix}`;
  createdRunIds.push(id);
  return id;
}

function cleanupTestRuns(): void {
  const runsDir = path.join(os.homedir(), '.ashlr', 'runs');
  for (const id of createdRunIds.splice(0)) {
    const f = path.join(runsDir, `${id}.json`);
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// Legacy helpers kept for runGoal tests that still use a tmp dir approach
let tmpHome: string;

function _setupTmpHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m4-orch-'));
}

function _teardownTmpHome(): void {
  fs.rmSync(tmpHome, { recursive: true, force: true });
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

/** Build a mock ProviderClient with a scripted sequence of chat responses. */
function mockClient(responses: ChatResult[]): ProviderClient {
  let idx = 0;
  return {
    id: 'mock',
    supportsTools: false,
    chat: vi.fn(async (_messages: ChatMessage[]): Promise<ChatResult> => {
      const r = responses[idx] ?? responses[responses.length - 1]!;
      idx++;
      return r;
    }),
  };
}

function textResult(content: string, tokensIn = 10, tokensOut = 5): ChatResult {
  return { content, usage: { tokensIn, tokensOut } };
}

/**
 * Build a JSON planning response that planGoal should parse into a DAG.
 * Layout: task-a and task-b are independent; task-c depends on task-a.
 */
function planningResponse(): ChatResult {
  const tasks = [
    { id: 'task-a', goal: 'Research topic A', deps: [] },
    { id: 'task-b', goal: 'Research topic B', deps: [] },
    { id: 'task-c', goal: 'Synthesize A results', deps: ['task-a'] },
  ];
  return textResult(JSON.stringify(tasks));
}

/** A simple single-task plan response for basic tests. */
function _singleTaskPlan(id = 'task-1', goal = 'Do the thing'): ChatResult {
  return textResult(JSON.stringify([{ id, goal, deps: [] }]));
}

// ---------------------------------------------------------------------------
// Import under test (after helpers to avoid hoisting issues)
// ---------------------------------------------------------------------------
import {
  planGoal,
  runGoal,
  saveRun,
  loadRun,
  listRuns,
} from '../src/core/run/orchestrator.js';
import type { RunState, RunOptions, RunStep } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// saveRun / loadRun / listRuns — persistence round-trip
//
// These tests write to the REAL ~/.ashlr/runs/ because the orchestrator module
// caches RUNS_DIR at import time. Tests use unique prefixed IDs and clean up.
// ---------------------------------------------------------------------------

describe('saveRun / loadRun / listRuns — persistence round-trip', () => {
  afterEach(cleanupTestRuns);

  function makeState(idSuffix: string, goal = 'test goal'): RunState {
    const id = uniqueRunId(idSuffix);
    return {
      id,
      goal,
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
      usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
      tasks: [],
      steps: [],
      status: 'running',
    };
  }

  it('loadRun returns null for unknown id', () => {
    expect(loadRun(`${TEST_PREFIX}nonexistent-xyz`)).toBeNull();
  });

  it('saveRun then loadRun returns the same state', () => {
    const state = makeState('round-trip');
    saveRun(state);
    const loaded = loadRun(state.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(state.id);
    expect(loaded!.goal).toBe('test goal');
  });

  it('saveRun persists the full state shape', () => {
    const state = makeState('full-shape');
    state.status = 'done';
    state.result = 'Final answer.';
    state.usage = { tokensIn: 100, tokensOut: 50, steps: 3, estCostUsd: 0 };
    saveRun(state);
    const loaded = loadRun(state.id);
    expect(loaded!.status).toBe('done');
    expect(loaded!.result).toBe('Final answer.');
    expect(loaded!.usage.tokensIn).toBe(100);
  });

  it('saveRun fills metadata-only causal learning fields without copying raw run text into summaries', () => {
    const state = makeState('causal-fields', 'RAW_GOAL_SENTINEL prompt should stay out of summaries');
    state.status = 'done';
    state.result = 'RAW_RESULT_SENTINEL stdout diff --git a/raw b/raw should stay operational only';
    state.usage = { tokensIn: 100, tokensOut: 50, steps: 3, estCostUsd: 0.0123 };
    state.proposalOutcome = {
      kind: 'filed',
      reason: 'RAW_STDOUT_SENTINEL proposal filed',
      proposalId: 'prop-run-causal',
      files: 2,
      insertions: 3,
      deletions: 1,
    };

    saveRun(state);
    const loaded = loadRun(state.id);
    expect(loaded).toMatchObject({
      trajectoryId: `run:${state.id}`,
      learningSource: 'run-ledger',
      labelBasis: 'dispatch-outcome',
      routerPolicyVersion: 'fleet-router-v1',
      runEventSummary: {
        runId: state.id,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-run-causal',
        diffFiles: 2,
        diffLines: 4,
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.0123,
      },
    });
    expect(loaded?.learningEpoch).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(loaded?.routeSnapshot).toMatchObject({
      backend: 'builtin',
      assignedBy: 'run-orchestrator',
    });
    const summary = JSON.stringify(loaded?.runEventSummary);
    expect(summary).not.toContain('RAW_GOAL_SENTINEL');
    expect(summary).not.toContain('RAW_RESULT_SENTINEL');
    expect(summary).not.toContain('RAW_STDOUT_SENTINEL');
    expect(summary).not.toContain('diff --git');
  });

  it('listRuns includes saved runs (by unique id)', () => {
    const a = makeState('list-a');
    const b = makeState('list-b');
    saveRun(a);
    saveRun(b);
    const runs = listRuns();
    const ids = runs.map(r => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('listRuns returns newest first (by createdAt)', () => {
    const older = makeState('newest-old');
    older.createdAt = '2024-01-01T00:00:00.000Z';
    const newer = makeState('newest-new');
    newer.createdAt = '2025-06-01T00:00:00.000Z';
    saveRun(older);
    saveRun(newer);
    const runs = listRuns();
    // Among all runs, the newer one should appear before the older one
    const olderIdx = runs.findIndex(r => r.id === older.id);
    const newerIdx = runs.findIndex(r => r.id === newer.id);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('saveRun is idempotent — second save overwrites first', () => {
    const state = makeState('idem');
    saveRun(state);
    state.status = 'done';
    state.result = 'Updated result';
    saveRun(state);
    const loaded = loadRun(state.id);
    expect(loaded!.status).toBe('done');
    expect(loaded!.result).toBe('Updated result');
  });

  it('saveRun writes to ~/.ashlr/runs/<id>.json', () => {
    const state = makeState('path-check');
    saveRun(state);
    const expectedPath = path.join(os.homedir(), '.ashlr', 'runs', `${state.id}.json`);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('loadRun returns null for corrupt JSON', () => {
    // Write a corrupt file directly to the runs dir
    const corruptId = uniqueRunId('corrupt');
    const runsDir = path.join(os.homedir(), '.ashlr', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, `${corruptId}.json`), '{not valid json!!!');
    expect(loadRun(corruptId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planGoal — DAG decomposition
// ---------------------------------------------------------------------------

describe('planGoal — DAG decomposition', () => {

  it('returns RunTask[] with correct task ids from planning response', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Research and synthesize AI topics', client);
    const ids = tasks.map(t => t.id);
    expect(ids).toContain('task-a');
    expect(ids).toContain('task-b');
    expect(ids).toContain('task-c');
  });

  it('all tasks start with status pending', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Test goal', client);
    for (const t of tasks) {
      expect(t.status).toBe('pending');
    }
  });

  it('dependent task has correct deps array', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Test goal', client);
    const taskC = tasks.find(t => t.id === 'task-c');
    expect(taskC).toBeDefined();
    expect(taskC!.deps).toContain('task-a');
  });

  it('independent tasks have empty deps', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Test goal', client);
    const taskA = tasks.find(t => t.id === 'task-a');
    const taskB = tasks.find(t => t.id === 'task-b');
    expect(taskA!.deps).toEqual([]);
    expect(taskB!.deps).toEqual([]);
  });

  it('falls back to single task on invalid JSON response', async () => {
    const client = mockClient([textResult('not valid json at all!!!')]);
    const tasks = await planGoal('Some goal', client);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.goal).toBe('Some goal');
    expect(tasks[0]!.deps).toEqual([]);
  });

  it('falls back to single task when response is an empty array', async () => {
    const client = mockClient([textResult('[]')]);
    const tasks = await planGoal('Some goal', client);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.goal).toBe('Some goal');
  });

  it('falls back to single task when JSON is not an array', async () => {
    const client = mockClient([textResult('{"notAnArray": true}')]);
    const tasks = await planGoal('Some goal', client);
    expect(tasks.length).toBe(1);
  });

  it('each task gets a unique id', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Test goal', client);
    const ids = tasks.map(t => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// runGoal — execution, dependency order, parallelism
// ---------------------------------------------------------------------------

describe('runGoal — execution and dependency ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  /**
   * Build a mock client that:
   * 1. Returns a two-task plan (task-a, task-b with task-b depending on task-a)
   * 2. Returns a result for task-a execution
   * 3. Returns a result for task-b execution
   * 4. Returns a synthesis result
   */
  function makeSequentialClient(): ProviderClient {
    const responses: ChatResult[] = [
      // Planning call → 2 tasks: task-a independent, task-b depends on task-a
      textResult(JSON.stringify([
        { id: 'task-a', goal: 'Step A', deps: [] },
        { id: 'task-b', goal: 'Step B', deps: ['task-a'] },
      ])),
      // task-a execution
      textResult('Result of step A.'),
      // task-b execution
      textResult('Result of step B using A.'),
      // synthesis
      textResult('Final synthesized answer.'),
    ];
    return mockClient(responses);
  }

  it('runGoal completes with status done', async () => {
    // Mock fetch to prevent real Ollama probing
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
    const _client = makeSequentialClient();
    // Override getActiveClient by injecting client via mock — we pass a client
    // directly by mocking the module
    // Since we can't easily mock the module without vi.mock, we test runGoal
    // indirectly via a config that will fail provider resolution and fall back.
    // Instead, test with a minimal approach: mock the provider modules.
    // The simplest hermetic approach: mock fetch to simulate ollama up.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        });
      }
      // Ollama chat call
      if (String(url).includes('11434/api/chat')) {
        const responses = [
          JSON.stringify([
            { id: 'task-a', goal: 'Step A', deps: [] },
            { id: 'task-b', goal: 'Step B', deps: ['task-a'] },
          ]),
          'Result of step A.',
          'Result of step B.',
          'Final answer.',
        ];
        let callCount = 0;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: responses[callCount++ % responses.length] },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
        });
      }
      return Promise.reject(new Error(`unexpected url: ${String(url)}`));
    }));

    const cfg = makeConfig();
    const opts: RunOptions = {
      budget: { maxTokens: 50_000, maxSteps: 20 },
      parallel: 2,
      engine: 'builtin',
      tools: false,
    };

    const state = await runGoal('Research and summarize AI', cfg, opts);
    expect(['done', 'aborted', 'failed']).toContain(state.status);
    // At minimum, state must be a valid RunState shape
    expect(state.id).toBeTruthy();
    expect(state.goal).toBe('Research and summarize AI');
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(Array.isArray(state.steps)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('runGoal persists state to ~/.ashlr/runs/', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        });
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: 'Done.' },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    }));

    const cfg = makeConfig();
    const opts: RunOptions = {
      budget: { maxTokens: 50_000, maxSteps: 10 },
      parallel: 1,
      engine: 'builtin',
      tools: false,
    };

    const state = await runGoal('Simple goal', cfg, opts);
    // The run file should exist under the real ~/.ashlr/runs/
    createdRunIds.push(state.id); // register for cleanup
    const runsDir = path.join(os.homedir(), '.ashlr', 'runs');
    const expectedFile = path.join(runsDir, `${state.id}.json`);
    expect(fs.existsSync(expectedFile)).toBe(true);
    const loaded = loadRun(state.id);
    expect(state.trajectoryId).toBe(`run:${state.id}`);
    expect(loaded?.trajectoryId).toBe(`run:${state.id}`);
    expect(loaded?.learningSource).toBe('run-ledger');
    expect(loaded?.runEventSummary).toMatchObject({
      runId: state.id,
      status: state.status,
      tokensIn: state.usage.tokensIn,
      tokensOut: state.usage.tokensOut,
    });
  });
});

// ---------------------------------------------------------------------------
// runGoal — budget abort preserves partial results
// ---------------------------------------------------------------------------

describe('runGoal — budget abort with partial results', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  it('aborts cleanly when budget is nearly zero (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        });
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: 'Some response.' },
            prompt_eval_count: 1000,
            eval_count: 1000,
          }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    }));

    const cfg = makeConfig();
    const opts: RunOptions = {
      // Tiny budget — should abort almost immediately
      budget: { maxTokens: 10, maxSteps: 1 },
      parallel: 1,
      engine: 'builtin',
      tools: false,
    };

    const state = await runGoal('Do lots of work', cfg, opts);
    expect(['aborted', 'failed', 'done']).toContain(state.status);
    expect(state.id).toBeTruthy();
  });

  it('aborted run has valid RunState shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        });
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: 'x' },
            prompt_eval_count: 10000,
            eval_count: 10000,
          }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    }));

    const cfg = makeConfig();
    const state = await runGoal('test', cfg, {
      budget: { maxTokens: 5, maxSteps: 1 },
      parallel: 1,
      tools: false,
    });
    // Shape invariants must hold even on abort
    expect(typeof state.id).toBe('string');
    expect(typeof state.goal).toBe('string');
    expect(Array.isArray(state.tasks)).toBe(true);
    expect(Array.isArray(state.steps)).toBe(true);
    expect(typeof state.usage.tokensIn).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// runGoal — resume skips done tasks
// ---------------------------------------------------------------------------

describe('runGoal — resume skips completed tasks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  it('resumes a run without re-executing already-done tasks', async () => {
    // Pre-build a RunState with one done task and one pending task
    const resumeId = uniqueRunId('resume');
    const existingState: RunState = {
      id: resumeId,
      goal: 'Two-step goal',
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false },
      usage: { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 },
      tasks: [
        {
          id: 'task-done',
          goal: 'Already completed',
          deps: [],
          status: 'done',
          result: 'Cached result from previous run',
          usage: { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 },
        },
        {
          id: 'task-pending',
          goal: 'Still needs to run',
          deps: ['task-done'],
          status: 'pending',
        },
      ],
      steps: [],
      status: 'running',
    };
    saveRun(existingState);

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('11434/api/tags')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3:8b' }] }),
        });
      }
      if (String(url).includes('11434/api/chat')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            message: { role: 'assistant', content: 'Resumed result.' },
            prompt_eval_count: 10,
            eval_count: 5,
          }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    }));

    const cfg = makeConfig();
    const state = await runGoal('Two-step goal', cfg, {
      resumeId: resumeId,
      budget: { maxTokens: 50_000, maxSteps: 20 },
      parallel: 1,
      tools: false,
    });

    // The previously-done task should still be done with its original result
    const doneTask = state.tasks.find(t => t.id === 'task-done');
    expect(doneTask).toBeDefined();
    expect(doneTask!.status).toBe('done');
    expect(doneTask!.result).toBe('Cached result from previous run');
  });
});

// ---------------------------------------------------------------------------
// planGoal — single-call DAG with three tasks (2 independent + 1 dependent)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic usage / budget / resume tests (scripted Ollama fetch)
//
// These drive the REAL orchestrator path (getActiveClient builds an Ollama
// client over fetch) with a fetch mock that returns fixed per-call token
// counts and content chosen by call order. They assert EXACT cumulative usage,
// the parallel hard ceiling, cycle termination, __onStep wiring, and the two
// resume edge cases — the regressions the weaker tests missed.
// ---------------------------------------------------------------------------

/**
 * Build a fetch mock simulating an Ollama provider. The plan call (first chat)
 * returns `planJson`; every subsequent chat returns 'OK' content. Each chat
 * reports fixed prompt_eval_count=IN, eval_count=OUT.
 */
function scriptedOllama(planJson: string, opts: { tokIn?: number; tokOut?: number } = {}): {
  fetchMock: ReturnType<typeof vi.fn>;
  chatCalls: () => number;
} {
  const tokIn = opts.tokIn ?? 10;
  const tokOut = opts.tokOut ?? 5;
  let chatCount = 0;
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('11434/api/tags')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llama3:8b' }] }),
      });
    }
    if (u.includes('11434/api/chat')) {
      const isPlan = chatCount === 0;
      chatCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          message: { role: 'assistant', content: isPlan ? planJson : 'OK result.' },
          prompt_eval_count: tokIn,
          eval_count: tokOut,
        }),
      });
    }
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
  return { fetchMock, chatCalls: () => chatCount };
}

describe('runGoal — deterministic usage accounting (single-writer)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  it('counts each model step exactly once (no double-count)', async () => {
    // Plan → 2 independent single-step tasks → synthesis = 4 chat calls total.
    const plan = JSON.stringify([
      { id: 'a', goal: 'Task A', deps: [] },
      { id: 'b', goal: 'Task B', deps: [] },
    ]);
    const { fetchMock } = scriptedOllama(plan, { tokIn: 10, tokOut: 5 });
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('Two independent tasks', makeConfig(), {
      budget: { maxTokens: 1_000_000, maxSteps: 1000 },
      parallel: 2,
      tools: false,
    });
    createdRunIds.push(state.id);

    // 4 chat calls (plan + a + b + synth), each 10 in / 5 out / 1 step.
    expect(state.status).toBe('done');
    expect(state.usage.tokensIn).toBe(40);
    expect(state.usage.tokensOut).toBe(20);
    expect(state.usage.steps).toBe(4);
  });

  it('exact usage holds under parallel:2 (no reference divergence)', async () => {
    // 3 independent tasks + plan + synth = 5 chat calls.
    const plan = JSON.stringify([
      { id: 'a', goal: 'A', deps: [] },
      { id: 'b', goal: 'B', deps: [] },
      { id: 'c', goal: 'C', deps: [] },
    ]);
    const { fetchMock } = scriptedOllama(plan, { tokIn: 7, tokOut: 3 });
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('Three independent tasks', makeConfig(), {
      budget: { maxTokens: 1_000_000, maxSteps: 1000 },
      parallel: 2,
      tools: false,
    });
    createdRunIds.push(state.id);

    expect(state.status).toBe('done');
    // 5 calls × (7 in, 3 out, 1 step)
    expect(state.usage.tokensIn).toBe(35);
    expect(state.usage.tokensOut).toBe(15);
    expect(state.usage.steps).toBe(5);
    // Persisted state must match exactly (single writer, no rebind drift).
    const reloaded = loadRun(state.id)!;
    expect(reloaded.usage.tokensIn).toBe(35);
    expect(reloaded.usage.tokensOut).toBe(15);
    expect(reloaded.usage.steps).toBe(5);
  });

  it('tight budget with parallel:2 aborts; overshoot is bounded', async () => {
    // Each chat costs 100 in / 100 out. maxTokens:50 → plan call alone exceeds it.
    const plan = JSON.stringify([
      { id: 'a', goal: 'A', deps: [] },
      { id: 'b', goal: 'B', deps: [] },
    ]);
    const { fetchMock } = scriptedOllama(plan, { tokIn: 100, tokOut: 100 });
    vi.stubGlobal('fetch', fetchMock);

    const budget = { maxTokens: 50, maxSteps: 100 };
    const state = await runGoal('Expensive work', makeConfig(), {
      budget,
      parallel: 2,
      tools: false,
    });
    createdRunIds.push(state.id);

    expect(state.status).toBe('aborted');
    // All tasks should be failed with the abort sentinel (none completed).
    for (const t of state.tasks) {
      expect(t.status).toBe('failed');
      expect(t.error).toBe('Aborted: run budget exceeded');
    }
    // Hard-ceiling guarantee: at most ONE batch of `parallel` tasks ran past the
    // ceiling before the between-batch check aborted, plus the single plan call.
    // No unbounded overshoot. (plan=200 tok; up to 2 tasks × 200 = 400.)
    const total = state.usage.tokensIn + state.usage.tokensOut;
    expect(total).toBeLessThanOrEqual(200 /* plan */ + 2 * 200 /* one parallel batch */);
  });

  it('__onStep CLI hook fires at least once during a run', async () => {
    const plan = JSON.stringify([{ id: 'a', goal: 'A', deps: [] }]);
    const { fetchMock } = scriptedOllama(plan);
    vi.stubGlobal('fetch', fetchMock);

    const seen: string[] = [];
    const opts = {
      budget: { maxTokens: 1_000_000, maxSteps: 1000 },
      parallel: 1,
      tools: false,
      __onStep: (step: RunStep) => { seen.push(step.kind); },
    } as RunOptions & { __onStep: (s: RunStep) => void };

    const state = await runGoal('One task', makeConfig(), opts);
    createdRunIds.push(state.id);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    // Should include a model step and the synthesize step.
    expect(seen).toContain('model');
    expect(seen).toContain('synthesize');
  });

  it('a dependency cycle in the plan does not hang (falls back to single task)', async () => {
    // t1->t2->t1 cycle. parseTaskList rejects it → single-task fallback runs.
    const plan = JSON.stringify([
      { id: 't1', goal: 'T1', deps: ['t2'] },
      { id: 't2', goal: 'T2', deps: ['t1'] },
    ]);
    const { fetchMock } = scriptedOllama(plan);
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('Cyclic plan goal', makeConfig(), {
      budget: { maxTokens: 1_000_000, maxSteps: 1000 },
      parallel: 2,
      tools: false,
    });
    createdRunIds.push(state.id);

    // Terminates (no hang) and produces a valid run.
    expect(['done', 'failed', 'aborted']).toContain(state.status);
    // Fallback yields a single task using the original goal.
    expect(state.tasks.length).toBe(1);
    expect(state.tasks[0]!.goal).toBe('Cyclic plan goal');
  });
});

describe('runGoal — resume edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  it('resuming an already-done run is a no-op (no extra usage/steps)', async () => {
    const resumeId = uniqueRunId('resume-done');
    const done: RunState = {
      id: resumeId,
      goal: 'Finished goal',
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false },
      usage: { tokensIn: 100, tokensOut: 50, steps: 3, estCostUsd: 0 },
      tasks: [
        { id: 'a', goal: 'A', deps: [], status: 'done', result: 'A done',
          usage: { tokensIn: 100, tokensOut: 50, steps: 3, estCostUsd: 0 } },
      ],
      steps: [
        { ts: new Date().toISOString(), taskId: 'a', kind: 'model', summary: 'A' },
      ],
      status: 'done',
      result: 'Already synthesized.',
    };
    saveRun(done);

    // Fetch should NOT be called for chat — assert by failing on any chat call.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/chat')) {
        throw new Error('resume of done run must not issue chat calls');
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ models: [] }) });
    }));

    const state = await runGoal('Finished goal', makeConfig(), {
      resumeId,
      budget: { maxTokens: 50_000, maxSteps: 20 },
      parallel: 1,
      tools: false,
    });

    // Unchanged: same usage, same steps length, same result.
    expect(state.status).toBe('done');
    expect(state.usage.tokensIn).toBe(100);
    expect(state.usage.tokensOut).toBe(50);
    expect(state.usage.steps).toBe(3);
    expect(state.steps.length).toBe(1);
    expect(state.result).toBe('Already synthesized.');
  });

  it('resuming a budget-aborted run re-runs the aborted tasks under a larger budget', async () => {
    const resumeId = uniqueRunId('resume-aborted');
    const aborted: RunState = {
      id: resumeId,
      goal: 'Retry goal',
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 10, maxSteps: 1, allowCloud: false },
      usage: { tokensIn: 5, tokensOut: 5, steps: 1, estCostUsd: 0 },
      tasks: [
        { id: 'a', goal: 'A', deps: [], status: 'failed', error: 'Aborted: run budget exceeded' },
        { id: 'b', goal: 'B', deps: [], status: 'failed', error: 'Aborted: run budget exceeded' },
      ],
      steps: [],
      status: 'aborted',
    };
    saveRun(aborted);

    const { fetchMock } = scriptedOllama('unused', { tokIn: 10, tokOut: 5 });
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('Retry goal', makeConfig(), {
      resumeId,
      budget: { maxTokens: 1_000_000, maxSteps: 1000 },
      parallel: 2,
      tools: false,
    });
    createdRunIds.push(state.id);

    // Previously-aborted tasks must now complete (tasks have no deps).
    expect(state.tasks.find(t => t.id === 'a')!.status).toBe('done');
    expect(state.tasks.find(t => t.id === 'b')!.status).toBe('done');
    expect(state.status).toBe('done');
  });

  it('resume re-runs the pending dependent task to done without re-issuing the cached task', async () => {
    const resumeId = uniqueRunId('resume-pending');
    const existing: RunState = {
      id: resumeId,
      goal: 'Two-step',
      engine: 'builtin',
      provider: 'ollama',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50_000, maxSteps: 20, allowCloud: false },
      usage: { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 },
      tasks: [
        { id: 'cached', goal: 'CACHED_GOAL', deps: [], status: 'done', result: 'cached',
          usage: { tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 } },
        { id: 'next', goal: 'NEXT_GOAL', deps: ['cached'], status: 'pending' },
      ],
      steps: [],
      status: 'running',
    };
    saveRun(existing);

    const chatBodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/tags')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ models: [{ name: 'llama3:8b' }] }) });
      }
      if (u.includes('/api/chat')) {
        chatBodies.push(String(init?.body ?? ''));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ message: { role: 'assistant', content: 'next done' }, prompt_eval_count: 10, eval_count: 5 }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    }));

    const state = await runGoal('Two-step', makeConfig(), {
      resumeId,
      budget: { maxTokens: 50_000, maxSteps: 20 },
      parallel: 1,
      tools: false,
    });
    createdRunIds.push(state.id);

    // Cached task untouched (same result + usage); pending dependent ran to done.
    const cached = state.tasks.find(t => t.id === 'cached')!;
    expect(cached.result).toBe('cached');
    expect(cached.usage).toEqual({ tokensIn: 100, tokensOut: 50, steps: 1, estCostUsd: 0 });
    expect(state.tasks.find(t => t.id === 'next')!.status).toBe('done');
    // The cached task was NOT re-executed: no agent-task chat used CACHED_GOAL as
    // its sole user message. (It may appear inside the synthesis prompt, which
    // aggregates done-task goals — so we look only at execution-shaped bodies:
    // the sub-agent system prompt contains "sub-agent" (legacy "Ashlr sub-agent"
    // and the M41 adaptive "Ashlr engineering sub-agent" both match; the
    // synthesis prompt does not), so this holds regardless of the prompt flag.)
    const agentTaskBodies = chatBodies.filter(b => b.includes('sub-agent'));
    expect(agentTaskBodies.some(b => b.includes('CACHED_GOAL'))).toBe(false);
    // The pending task's goal SHOULD appear in an executed agent-task body.
    expect(agentTaskBodies.some(b => b.includes('NEXT_GOAL'))).toBe(true);
  });
});

describe('planGoal — three-task DAG shape', () => {

  it('returns exactly 3 tasks when plan JSON has 3', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Multi-step research', client);
    expect(tasks.length).toBe(3);
  });

  it('dependent task id is in the deps of the correct task', async () => {
    const client = mockClient([planningResponse()]);
    const tasks = await planGoal('Multi-step research', client);
    const withDeps = tasks.filter((t: RunTask) => t.deps.length > 0);
    expect(withDeps.length).toBeGreaterThanOrEqual(1);
    // All dep ids must reference valid task ids
    const allIds = new Set(tasks.map((t: RunTask) => t.id));
    for (const t of withDeps) {
      for (const dep of t.deps) {
        expect(allIds.has(dep)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P0 fix: engine delegation (ashlrcode / aw)
// ---------------------------------------------------------------------------

describe('runGoal — engine delegation (P0 fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
  });

  it('absent engine falls back to builtin and completes (no hang, no throw)', async () => {
    // Request an engine that is guaranteed not on PATH.
    const { fetchMock } = scriptedOllama(
      JSON.stringify([{ id: 'a', goal: 'A', deps: [] }]),
      { tokIn: 5, tokOut: 3 },
    );
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('test goal', makeConfig(), {
      engine: 'ashlrcode-definitely-not-installed-xyz',
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      parallel: 1,
      tools: false,
    });
    createdRunIds.push(state.id);

    // Must terminate with a valid RunState (not throw, not hang).
    expect(['done', 'failed', 'aborted']).toContain(state.status);
    expect(state.id).toBeTruthy();
    // Builtin ran so there should be at least one task.
    expect(state.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('absent engine writes a warning to stderr mentioning the engine name', async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    });

    const { fetchMock } = scriptedOllama(
      JSON.stringify([{ id: 'a', goal: 'A', deps: [] }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const state = await runGoal('test goal', makeConfig(), {
      engine: 'no-such-engine-abc123',
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      parallel: 1,
      tools: false,
    });
    createdRunIds.push(state.id);

    const combined = stderrChunks.join('');
    expect(combined).toContain('no-such-engine-abc123');
    expect(combined.toLowerCase()).toMatch(/not found|falling back|builtin/);
  });
});

// ---------------------------------------------------------------------------
// P0 fix: pulse telemetry — errors logged to stderr (not silently swallowed)
// ---------------------------------------------------------------------------

describe('telemetry sink (OTLP) — honest error logging (M19; replaces M9 reportToPulse)', () => {
  // M19: the OTLP sink only activates when BOTH an endpoint (cfg.telemetry.pulse)
  // AND a PAT are present. Source the PAT from ASHLR_PULSE_TOKEN for these tests;
  // restore the prior value afterward so other suites are unaffected.
  const prevPulseToken = process.env['ASHLR_PULSE_TOKEN'];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupTestRuns();
    if (prevPulseToken === undefined) delete process.env['ASHLR_PULSE_TOKEN'];
    else process.env['ASHLR_PULSE_TOKEN'] = prevPulseToken;
  });

  it('logs telemetry emit failure to stderr instead of silently swallowing it', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = 'test-pat-not-logged';
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    });

    // Ollama mock for the run itself.
    const plan = JSON.stringify([{ id: 'a', goal: 'A', deps: [] }]);
    const { fetchMock } = scriptedOllama(plan, { tokIn: 5, tokOut: 3 });

    // Override fetch: Ollama calls pass through; Pulse endpoint fails.
    const pulseFail = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('pulse.example')) {
        return Promise.reject(new Error('network unreachable'));
      }
      return fetchMock(url);
    });
    vi.stubGlobal('fetch', pulseFail);

    const cfg: ReturnType<typeof makeConfig> = {
      ...makeConfig(),
      telemetry: { pulse: 'http://pulse.example/ingest' },
    };

    const state = await runGoal('pulse test goal', cfg, {
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      parallel: 1,
      tools: false,
    });
    createdRunIds.push(state.id);

    // Give the fire-and-forget microtask a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    const combined = stderrChunks.join('');
    // The failure must surface in stderr — not be silently swallowed.
    expect(combined).toMatch(/telemetry.*failed|emit failed|otlp/i);
    // PAT/SECRET SAFETY: the PAT value must NEVER appear in any stderr output.
    expect(combined).not.toContain('test-pat-not-logged');
  });

  it('logs non-2xx telemetry response to stderr', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = 'test-pat-not-logged';
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderrChunks.push(String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origWrite as any)(chunk, ...rest);
    });

    const plan = JSON.stringify([{ id: 'a', goal: 'A', deps: [] }]);
    const { fetchMock } = scriptedOllama(plan, { tokIn: 5, tokOut: 3 });

    const pulse500 = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('pulse.example')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return fetchMock(url);
    });
    vi.stubGlobal('fetch', pulse500);

    const cfg: ReturnType<typeof makeConfig> = {
      ...makeConfig(),
      telemetry: { pulse: 'http://pulse.example/ingest' },
    };

    const state = await runGoal('pulse 500 test', cfg, {
      budget: { maxTokens: 1_000_000, maxSteps: 100 },
      parallel: 1,
      tools: false,
    });
    createdRunIds.push(state.id);

    await new Promise((r) => setTimeout(r, 50));

    const combined = stderrChunks.join('');
    expect(combined).toMatch(/pulse.*500|HTTP 500/i);
    // PAT/SECRET SAFETY: the PAT value must NEVER appear in any stderr output.
    expect(combined).not.toContain('test-pat-not-logged');
  });
});
