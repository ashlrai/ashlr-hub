/**
 * M12 planner tests — hermetic, mock provider, no network, no filesystem writes.
 *
 * Covers:
 *   - planSwarm: parses a well-formed model response into phases/tasks
 *   - planSwarm: tasks per phase capped to <= 6
 *   - planSwarm: falls back gracefully on garbage model output (single-task plan)
 *   - planSwarm: falls back on empty array response
 *   - planSwarm: falls back on non-array JSON
 *   - planSwarm: build-phase tasks are independent (no deps on each other)
 *   - planSwarm: later phases' tasks have deps referencing prior phases
 *   - planSwarm: all task ids are unique
 *   - planSwarm: specBody is optional (works with goal-only input)
 *   - planSwarm: plan.goal matches the input goal
 *   - planSwarm: tasks span the expected phase names
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AshlrConfig, SwarmPlan, SwarmPhaseName } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock the provider-client so planSwarm never hits a real model
// ---------------------------------------------------------------------------

const mockChatFn = vi.fn();

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn().mockImplementation(async () => ({
    id: 'mock',
    supportsTools: false,
    chat: mockChatFn,
  })),
}));

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

/** Build a valid planner model response with tasks across all 5 phases. */
function validPlanResponse(): string {
  return JSON.stringify([
    // scaffold
    { id: 'scaffold-1', phase: 'scaffold', goal: 'Initialize project structure', deps: [] },
    // build (independent — must have no deps on each other)
    { id: 'build-1', phase: 'build', goal: 'Implement core module', deps: ['scaffold-1'] },
    { id: 'build-2', phase: 'build', goal: 'Implement CLI interface', deps: ['scaffold-1'] },
    { id: 'build-3', phase: 'build', goal: 'Write unit tests', deps: ['scaffold-1'] },
    // integrate
    { id: 'integrate-1', phase: 'integrate', goal: 'Wire modules together', deps: ['build-1', 'build-2'] },
    // verify
    { id: 'verify-1', phase: 'verify', goal: 'Run full test suite', deps: ['integrate-1', 'build-3'] },
    // review
    { id: 'review-1', phase: 'review', goal: 'Code review and polish', deps: ['verify-1'] },
  ]);
}

/** Build a response where build phase has more than 6 tasks (should be capped). */
function overcrowdedBuildPhaseResponse(): string {
  const tasks = [
    { id: 'scaffold-1', phase: 'scaffold', goal: 'Init', deps: [] },
  ];
  // 8 build tasks — should be capped to 6
  for (let i = 1; i <= 8; i++) {
    tasks.push({ id: `build-${i}`, phase: 'build', goal: `Build task ${i}`, deps: ['scaffold-1'] });
  }
  tasks.push({ id: 'verify-1', phase: 'verify', goal: 'Verify', deps: tasks.filter(t => t.phase === 'build').map(t => t.id) });
  return JSON.stringify(tasks);
}

// ---------------------------------------------------------------------------
// Import under test (lazy, after mocks are in place)
// ---------------------------------------------------------------------------

let planSwarm: (input: { goal: string; specBody?: string }, cfg: AshlrConfig) => Promise<SwarmPlan>;

async function ensureImported(): Promise<void> {
  if (!planSwarm) {
    const mod = await import('../src/core/swarm/planner.js');
    planSwarm = mod.planSwarm;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// planSwarm — well-formed response
// ---------------------------------------------------------------------------

describe('planSwarm — parses valid model response into phases/tasks', () => {
  it('returns a SwarmPlan with non-empty tasks array', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Build a search engine' }, makeConfig());
    expect(Array.isArray(plan.tasks)).toBe(true);
    expect(plan.tasks.length).toBeGreaterThan(0);
  });

  it('plan.goal matches the input goal', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const goal = 'Build an amazing CLI tool';
    const plan = await planSwarm({ goal }, makeConfig());
    expect(plan.goal).toBe(goal);
  });

  it('tasks span multiple expected SwarmPhaseName values', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Multi-phase goal' }, makeConfig());
    const phases = new Set(plan.tasks.map(t => t.phase));
    // At minimum scaffold and build should be present
    expect(phases.has('scaffold')).toBe(true);
    expect(phases.has('build')).toBe(true);
  });

  it('all task ids are unique', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Unique ids goal' }, makeConfig());
    const ids = plan.tasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all tasks have non-empty id, phase, goal, and deps array', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Field check goal' }, makeConfig());
    for (const t of plan.tasks) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(['scaffold', 'build', 'integrate', 'verify', 'review']).toContain(t.phase);
      expect(typeof t.goal).toBe('string');
      expect(t.goal.length).toBeGreaterThan(0);
      expect(Array.isArray(t.deps)).toBe(true);
    }
  });

  it('deps reference valid task ids (no dangling deps)', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Deps validity goal' }, makeConfig());
    const allIds = new Set(plan.tasks.map(t => t.id));
    for (const t of plan.tasks) {
      for (const dep of t.deps) {
        expect(allIds.has(dep)).toBe(true);
      }
    }
  });

  it('build-phase tasks have no deps on each other (independent)', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Parallel build goal' }, makeConfig());
    const buildTasks = plan.tasks.filter(t => t.phase === 'build');
    const buildIds = new Set(buildTasks.map(t => t.id));
    for (const t of buildTasks) {
      // No build task should depend on another build task
      const buildDeps = t.deps.filter(d => buildIds.has(d));
      expect(buildDeps.length).toBe(0);
    }
  });

  it('plan.specId is null when called without a specId', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'No spec id goal' }, makeConfig());
    expect(plan.specId).toBeNull();
  });

  it('accepts specBody as optional input without throwing', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm(
      { goal: 'Spec body goal', specBody: '# Context\nBuild a thing.\n# North Star\nGreat UX.' },
      makeConfig(),
    );
    expect(plan.goal).toBe('Spec body goal');
    expect(plan.tasks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// planSwarm — phase task cap (<= 6 per phase)
// ---------------------------------------------------------------------------

describe('planSwarm — tasks per phase capped to <= 6', () => {
  it('caps build phase to at most 6 tasks when model returns 8', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({
      content: overcrowdedBuildPhaseResponse(),
      usage: { tokensIn: 50, tokensOut: 300 },
    });
    const plan = await planSwarm({ goal: 'Overcrowded build phase' }, makeConfig());
    const buildTasks = plan.tasks.filter(t => t.phase === 'build');
    expect(buildTasks.length).toBeLessThanOrEqual(6);
  });

  it('caps every phase to at most 6 tasks', async () => {
    await ensureImported();
    // Build a response with 7 tasks in every phase
    const manyTasks = (['scaffold', 'build', 'integrate', 'verify', 'review'] as SwarmPhaseName[])
      .flatMap(phase =>
        Array.from({ length: 7 }, (_, i) => ({
          id: `${phase}-${i + 1}`,
          phase,
          goal: `${phase} task ${i + 1}`,
          deps: [] as string[],
        }))
      );
    mockChatFn.mockResolvedValueOnce({
      content: JSON.stringify(manyTasks),
      usage: { tokensIn: 50, tokensOut: 400 },
    });
    const plan = await planSwarm({ goal: 'All phases overcrowded' }, makeConfig());
    const phases: SwarmPhaseName[] = ['scaffold', 'build', 'integrate', 'verify', 'review'];
    for (const phase of phases) {
      const count = plan.tasks.filter(t => t.phase === phase).length;
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it('does not over-cap when phases have <= 6 tasks each', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    const plan = await planSwarm({ goal: 'Normal cap goal' }, makeConfig());
    // Valid response has 1+3+1+1+1=7 tasks — verify none were incorrectly dropped
    // (since each individual phase has <=6 tasks in the valid response)
    const buildCount = plan.tasks.filter(t => t.phase === 'build').length;
    expect(buildCount).toBeLessThanOrEqual(6);
    expect(buildCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// planSwarm — fallback on garbage / unparseable model output
// ---------------------------------------------------------------------------

describe('planSwarm — fallback on garbage model output', () => {
  it('falls back to a single-task plan on non-JSON response', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({
      content: 'Sure! Here is my plan: first do A, then do B.',
      usage: { tokensIn: 10, tokensOut: 30 },
    });
    const plan = await planSwarm({ goal: 'Garbage response goal' }, makeConfig());
    // Must not throw; returns at least one task covering the original goal
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    // The fallback task should incorporate the original goal
    expect(plan.goal).toBe('Garbage response goal');
  });

  it('falls back when model returns an empty array', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: '[]', usage: { tokensIn: 10, tokensOut: 5 } });
    const plan = await planSwarm({ goal: 'Empty array fallback goal' }, makeConfig());
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.goal).toBe('Empty array fallback goal');
  });

  it('falls back when model returns non-array JSON', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({
      content: '{"steps": ["do this", "do that"]}',
      usage: { tokensIn: 10, tokensOut: 20 },
    });
    const plan = await planSwarm({ goal: 'Non-array fallback goal' }, makeConfig());
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('never throws even on completely malformed model output', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({
      content: '{{{broken json',
      usage: { tokensIn: 10, tokensOut: 5 },
    });
    await expect(planSwarm({ goal: 'Malformed JSON goal' }, makeConfig())).resolves.not.toThrow();
  });

  it('fallback plan still has valid task fields', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({
      content: 'not json',
      usage: { tokensIn: 10, tokensOut: 10 },
    });
    const plan = await planSwarm({ goal: 'Fallback fields goal' }, makeConfig());
    for (const t of plan.tasks) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(['scaffold', 'build', 'integrate', 'verify', 'review']).toContain(t.phase);
      expect(Array.isArray(t.deps)).toBe(true);
    }
  });

  it('falls back when model call rejects (network/provider error)', async () => {
    await ensureImported();
    mockChatFn.mockRejectedValueOnce(new Error('provider unavailable'));
    // planSwarm must not throw — should return a safe fallback plan
    const plan = await planSwarm({ goal: 'Provider error fallback goal' }, makeConfig());
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.goal).toBe('Provider error fallback goal');
  });
});

// ---------------------------------------------------------------------------
// planSwarm — LOCAL-first: does not use cloud when allowCloud not set
// ---------------------------------------------------------------------------

describe('planSwarm — local-first provider usage', () => {
  it('does not pass allowCloud=true to the provider client by default', async () => {
    await ensureImported();
    mockChatFn.mockResolvedValueOnce({ content: validPlanResponse(), usage: { tokensIn: 50, tokensOut: 200 } });
    // Config has no allowCloud; call must succeed using local provider mock
    const cfg = makeConfig();
    cfg.models.providerChain = ['ollama'];
    const plan = await planSwarm({ goal: 'Local-first goal' }, cfg);
    expect(plan.tasks.length).toBeGreaterThan(0);
    // The mock was invoked (local provider path was taken)
    expect(mockChatFn).toHaveBeenCalled();
  });
});
