/**
 * M102 — goal-aware conductor.
 *
 * Tests four capabilities:
 *  1. Frontier planning: decomposeGoal routes to the best available frontier
 *     CLI (claude/codex) and falls back to deterministic split on failure.
 *  2. Iterate-to-done: advanceGoalCycle re-advances a blocked milestone within
 *     the retry bound and correctly detects goal completion.
 *  3. Conductor goals-first: runConductor advances active goals before the
 *     backlog daemon and falls back when no active goals exist.
 *  4. Kill-switch: runConductor returns immediately when killSwitchOn() is true.
 *
 * Everything outward (engineInstalled, runGoal, runSwarm, assertMayMutate,
 * listGoals, killSwitchOn, runDaemon, loadGoal, resumeMilestone) is MOCKED —
 * no real ~/.ashlr, no real engine runs, no real swarm dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Goal, Milestone, SwarmRun } from '../src/core/types.js';

// ============================================================================
// ── Module mocks — declared BEFORE any imports of the modules under test ─────
// ============================================================================

const mockEngineInstalled = vi.fn<[string], boolean>();

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: (id: string) => mockEngineInstalled(id),
  buildEngineCommand: vi.fn(),
  spawnEngine: vi.fn(),
}));

const mockRunGoal = vi.fn();

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
  parseTaskList: vi.fn(),
  planGoal: vi.fn(),
  DEFAULT_MAX_TOKENS: 50_000,
  DEFAULT_MAX_STEPS: 40,
  DEFAULT_PARALLEL: 2,
  TITRR_MAX_ATTEMPTS: 2,
  titrrTestRun: vi.fn(),
  loadRun: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
}));

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockAssertMayMutate = vi.fn();
const mockKillSwitchOn = vi.fn<[], boolean>(() => false);

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: (...args: unknown[]) => mockAssertMayMutate(...args),
  killSwitchOn: () => mockKillSwitchOn(),
  setKill: vi.fn(),
  listEnrolled: vi.fn(() => []),
  isEnrolled: vi.fn(() => false),
}));

const mockListGoals = vi.fn();
const mockLoadGoal = vi.fn();
const mockResumeM = vi.fn();
const mockUpdateMilestoneStatus = vi.fn();

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: (...args: unknown[]) => mockListGoals(...args),
  loadGoal: (...args: unknown[]) => mockLoadGoal(...args),
  resumeMilestone: (...args: unknown[]) => mockResumeM(...args),
  updateMilestoneStatus: (...args: unknown[]) => mockUpdateMilestoneStatus(...args),
  saveGoal: vi.fn(),
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  addMilestone: vi.fn(),
  clearMilestones: vi.fn(),
  reorderMilestones: vi.fn(),
  pauseMilestone: vi.fn(),
  skipMilestone: vi.fn(),
}));

const mockListProposals = vi.fn();
const mockLoadProposal = vi.fn();

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
  pendingCount: vi.fn(() => 0),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  loadSwarm: vi.fn(),
  saveSwarm: vi.fn(),
  listSwarms: vi.fn(() => []),
}));

const mockRunDaemon = vi.fn();

vi.mock('../src/core/daemon/loop.js', () => ({
  runDaemon: (...args: unknown[]) => mockRunDaemon(...args),
  tick: vi.fn(),
  stopDaemon: vi.fn(),
  buildItemGoal: vi.fn(),
}));

// ── Late imports (AFTER vi.mock declarations) ─────────────────────────────────
import { decomposeGoal, pickFrontierEngine } from '../src/core/goals/planner.js';
import { advanceGoalCycle } from '../src/core/goals/advance.js';
import { runConductor } from '../src/core/goals/conductor.js';
import type { AshlrConfig } from '../src/core/types.js';

// ============================================================================
// ── Helpers ───────────────────────────────────────────────────────────────────
// ============================================================================

function makeCfg(frontierBackends?: string[]): AshlrConfig {
  return {
    version: 1,
    foundry: frontierBackends
      ? { allowedBackends: frontierBackends as AshlrConfig['foundry']['allowedBackends'] }
      : undefined,
  } as AshlrConfig;
}

function makeMilestone(order: number, status: Milestone['status'] = 'pending'): Milestone {
  return {
    id: `m${order}`,
    title: `Milestone ${order}`,
    detail: `Detail for milestone ${order}`,
    order,
    status,
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function makeGoal(
  id: string,
  status: Goal['status'] = 'active',
  milestones: Milestone[] = [makeMilestone(0), makeMilestone(1)],
): Goal {
  return {
    id,
    objective: `Objective for ${id}`,
    status,
    milestones,
    project: '/tmp/test-repo',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSwarmRun(id: string, status: SwarmRun['status'] = 'done'): SwarmRun {
  return {
    id,
    status,
    goal: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: { id: 'plan-1', phases: [], createdAt: new Date().toISOString() },
    tasks: [],
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, costUsd: 0 },
    budget: { maxTokens: 200_000, maxSteps: 40, allowCloud: false },
  } as unknown as SwarmRun;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  mockEngineInstalled.mockReset().mockReturnValue(false);
  mockRunGoal.mockReset();
  mockRunSwarm.mockReset();
  mockAssertMayMutate.mockReset().mockImplementation(() => { /* allow */ });
  mockKillSwitchOn.mockReturnValue(false);
  mockListGoals.mockReset().mockReturnValue([]);
  mockLoadGoal.mockReset().mockReturnValue(null);
  mockResumeM.mockReset();
  mockUpdateMilestoneStatus.mockReset().mockReturnValue(null);
  mockListProposals.mockReset().mockReturnValue([]);
  mockLoadProposal.mockReset().mockReturnValue(null);
  mockRunDaemon.mockReset().mockResolvedValue({ running: false });
});

// ============================================================================
// Suite 1: Frontier planning
// ============================================================================

describe('M102 — frontier planning: decomposeGoal routes to frontier when available', () => {
  it('pickFrontierEngine returns the first allowed+installed frontier', () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'codex', 'builtin']);
    expect(pickFrontierEngine(cfg)).toBe('claude');
  });

  it('pickFrontierEngine returns null when no frontier installed', () => {
    mockEngineInstalled.mockReturnValue(false);
    const cfg = makeCfg(['claude', 'codex']);
    expect(pickFrontierEngine(cfg)).toBeNull();
  });

  it('pickFrontierEngine returns null when no frontier in allowedBackends', () => {
    mockEngineInstalled.mockReturnValue(true);
    const cfg = makeCfg(['builtin']);
    expect(pickFrontierEngine(cfg)).toBeNull();
  });

  it('decomposeGoal uses frontier engine when installed+allowed', async () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'builtin']);

    const frontierPlan = [
      { title: 'Design schema', detail: 'Map the data model.' },
      { title: 'Implement API', detail: 'Build the REST endpoints.' },
      { title: 'Write tests', detail: 'Cover edge cases.' },
      { title: 'Document', detail: 'Add README sections.' },
    ];
    // RunState uses `result` field (not `finalAnswer`)
    mockRunGoal.mockResolvedValue({
      id: 'run-plan-1',
      status: 'done',
      result: JSON.stringify(frontierPlan),
    });

    const milestones = await decomposeGoal('Build a REST API for users', cfg);

    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(milestones.length).toBe(4);
    expect(milestones[0]!.title).toBe('Design schema');
    expect(milestones[1]!.title).toBe('Implement API');
  });

  it('decomposeGoal falls back to deterministic split when frontier returns garbled output', async () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'builtin']);

    mockRunGoal.mockResolvedValue({
      id: 'run-plan-2',
      status: 'done',
      result: 'Sure! Here is a plan for you: 1. Step one 2. Step two',
    });

    const milestones = await decomposeGoal('Build a REST API for users', cfg);

    // Falls back to STANDARD_PHASES scaffold (single-clause objective)
    expect(milestones.length).toBeGreaterThanOrEqual(2);
    expect(milestones[0]!.title).toBe('Design');
  });

  it('decomposeGoal falls back to deterministic split when frontier throws', async () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'builtin']);

    mockRunGoal.mockRejectedValue(new Error('engine unavailable'));

    const milestones = await decomposeGoal('Build a REST API for users', cfg);

    expect(milestones.length).toBeGreaterThanOrEqual(2);
    expect(milestones[0]!.title).toBe('Design');
  });

  it('decomposeGoal falls back when frontier returns fewer than 2 items', async () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'builtin']);

    mockRunGoal.mockResolvedValue({ id: 'run-plan-3', status: 'done', result: '[]' });

    const milestones = await decomposeGoal('Build a REST API for users', cfg);

    expect(milestones.length).toBeGreaterThanOrEqual(2);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('decomposeGoal uses deterministic split when no frontier installed', async () => {
    mockEngineInstalled.mockReturnValue(false);
    const cfg = makeCfg(['builtin']);

    const milestones = await decomposeGoal('Build a REST API for users', cfg);

    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(milestones.length).toBeGreaterThanOrEqual(2);
  });

  it('decomposeGoal caps frontier output to maxMilestones', async () => {
    mockEngineInstalled.mockImplementation((id) => id === 'claude');
    const cfg = makeCfg(['claude', 'builtin']);

    const oversizedPlan = Array.from({ length: 12 }, (_, i) => ({
      title: `Step ${i + 1}`,
      detail: `Do step ${i + 1}`,
    }));
    mockRunGoal.mockResolvedValue({
      id: 'run-plan-4',
      status: 'done',
      result: JSON.stringify(oversizedPlan),
    });

    const milestones = await decomposeGoal('Big refactor', cfg, { maxMilestones: 6 });

    expect(milestones.length).toBeLessThanOrEqual(6);
  });
});

// ============================================================================
// Suite 2: Iterate-to-done (advanceGoalCycle)
// ============================================================================

describe('M102 — iterate-to-done: advanceGoalCycle drives milestones to completion', () => {
  it('returns milestoneDone=true and proposalsFiled=1 when swarm produces a proposal', async () => {
    const goal = makeGoal('g1', 'active', [makeMilestone(0), makeMilestone(1)]);
    const afterAdvance = {
      ...goal,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 'swarm-1', proposalId: 'prop-1' },
        makeMilestone(1),
      ],
    };

    mockLoadGoal
      .mockReturnValueOnce(goal)      // advanceGoal: loadGoal(goalId)
      .mockReturnValue(afterAdvance); // advanceGoalCycle: reload after advance

    mockRunSwarm.mockResolvedValue(makeSwarmRun('swarm-1', 'done'));
    mockListProposals.mockReturnValue([
      { id: 'prop-1', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
        summary: 'swarm=swarm-1' },
    ]);
    mockUpdateMilestoneStatus.mockReturnValue(afterAdvance);

    const result = await advanceGoalCycle('g1', makeCfg(), { allowAnyRepo: true });

    expect(result.milestoneDone).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.proposalsFiled).toBe(1);
  });

  it('retries once when advance leaves milestone blocked, succeeds on retry', async () => {
    const goal = makeGoal('g2', 'active', [makeMilestone(0), makeMilestone(1)]);
    const blockedGoal = {
      ...goal,
      milestones: [
        { ...makeMilestone(0, 'blocked'), swarmId: 'swarm-fail' },
        makeMilestone(1),
      ],
    };
    const proposedGoal = {
      ...goal,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 'swarm-ok', proposalId: 'prop-2' },
        makeMilestone(1),
      ],
    };

    mockLoadGoal
      .mockReturnValueOnce(goal)          // attempt 1: advanceGoal loadGoal
      .mockReturnValueOnce(blockedGoal)   // advanceGoalCycle: reload after attempt 1
      .mockReturnValueOnce(proposedGoal)  // attempt 2: advanceGoal loadGoal (after resume)
      .mockReturnValue(proposedGoal);     // advanceGoalCycle: reload after attempt 2

    mockRunSwarm
      .mockResolvedValueOnce(makeSwarmRun('swarm-fail', 'failed'))
      .mockResolvedValueOnce(makeSwarmRun('swarm-ok', 'done'));

    mockListProposals
      .mockReturnValueOnce([]) // after swarm-fail
      .mockReturnValue([
        { id: 'prop-2', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
          summary: 'swarm=swarm-ok' },
      ]);

    mockUpdateMilestoneStatus.mockReturnValue(blockedGoal);
    mockResumeM.mockReturnValue(goal);

    const result = await advanceGoalCycle('g2', makeCfg(), { maxRetries: 1, allowAnyRepo: true });

    expect(result.runs).toHaveLength(2);
    expect(mockResumeM).toHaveBeenCalledTimes(1);
    expect(result.milestoneDone).toBe(true);
  });

  it('respects maxRetries bound — stops after initial + maxRetries attempts', async () => {
    const goal = makeGoal('g3', 'active', [makeMilestone(0), makeMilestone(1)]);
    const blockedGoal = {
      ...goal,
      milestones: [{ ...makeMilestone(0, 'blocked'), swarmId: 'swarm-x' }, makeMilestone(1)],
    };

    mockLoadGoal
      .mockReturnValueOnce(goal)
      .mockReturnValueOnce(blockedGoal)
      .mockReturnValueOnce(goal) // after resume
      .mockReturnValue(blockedGoal);

    mockRunSwarm.mockResolvedValue(makeSwarmRun('swarm-x', 'failed'));
    mockListProposals.mockReturnValue([]);
    mockUpdateMilestoneStatus.mockReturnValue(blockedGoal);
    mockResumeM.mockReturnValue(goal);

    const result = await advanceGoalCycle('g3', makeCfg(), { maxRetries: 1, allowAnyRepo: true });

    // initial + 1 retry = 2 total
    expect(result.runs).toHaveLength(2);
    expect(result.milestoneDone).toBe(false);
  });

  it('detects goal completion when all non-skipped milestones are proposed', async () => {
    const goal = makeGoal('g4', 'active', [
      { ...makeMilestone(0, 'proposed'), swarmId: 's0', proposalId: 'p0' },
      makeMilestone(1),
    ]);
    const doneGoal: Goal = {
      ...goal,
      status: 'done',
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 's0', proposalId: 'p0' },
        { ...makeMilestone(1, 'proposed'), swarmId: 's1', proposalId: 'p1' },
      ],
    };

    mockLoadGoal
      .mockReturnValueOnce(goal)   // advanceGoal: loadGoal
      .mockReturnValue(doneGoal);  // advanceGoalCycle: reload

    mockRunSwarm.mockResolvedValue(makeSwarmRun('s1', 'done'));
    mockListProposals.mockReturnValue([
      { id: 'p1', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
        summary: 'swarm=s1' },
    ]);
    mockUpdateMilestoneStatus.mockReturnValue(doneGoal);

    const result = await advanceGoalCycle('g4', makeCfg(), { allowAnyRepo: true });

    expect(result.goalDone).toBe(true);
    expect(result.milestoneDone).toBe(true);
  });

  it('throws immediately when loadGoal returns null (goal not found)', async () => {
    mockLoadGoal.mockReturnValue(null);

    await expect(advanceGoalCycle('g-missing', makeCfg())).rejects.toThrow('goal not found');
  });

  it('propagates assertMayMutate throws (enrollment / kill-switch hard errors)', async () => {
    const goal = makeGoal('g-unenrolled');
    mockLoadGoal.mockReturnValue(goal);
    mockAssertMayMutate.mockImplementation(() => {
      throw new Error('repo not enrolled for autonomous work');
    });

    await expect(advanceGoalCycle('g-unenrolled', makeCfg())).rejects.toThrow('repo not enrolled');
  });
});

// ============================================================================
// Suite 3: Conductor goals-first
// ============================================================================

describe('M102 — conductor: goals-first dispatch with daemon fallback', () => {
  it('advances active goals and does NOT call runDaemon when goals exist', async () => {
    const g1 = makeGoal('g-cond-1');
    mockListGoals.mockReturnValue([g1]);

    const afterAdvance = {
      ...g1,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 's1', proposalId: 'p1' },
        makeMilestone(1),
      ],
    };
    mockLoadGoal.mockReturnValue(afterAdvance);
    mockRunSwarm.mockResolvedValue(makeSwarmRun('s1', 'done'));
    mockListProposals.mockReturnValue([
      { id: 'p1', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
        summary: 'swarm=s1' },
    ]);
    mockUpdateMilestoneStatus.mockReturnValue(afterAdvance);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.daemonFallback).toBe(false);
    expect(mockRunDaemon).not.toHaveBeenCalled();
    expect(summary.goalsAdvanced).toBeGreaterThanOrEqual(1);
  });

  it('falls back to runDaemon when no active goals exist', async () => {
    mockListGoals.mockReturnValue([]);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.daemonFallback).toBe(true);
    expect(mockRunDaemon).toHaveBeenCalledTimes(1);
    expect(mockRunDaemon).toHaveBeenCalledWith(
      expect.anything(),
      { once: true, dryRun: false },
    );
  });

  it('respects maxGoalsPerCycle cap', async () => {
    const goals = Array.from({ length: 5 }, (_, i) => makeGoal(`g-cap-${i}`));
    mockListGoals.mockReturnValue(goals);

    mockLoadGoal.mockImplementation((id: string) => {
      const g = goals.find((g) => g.id === id);
      if (!g) return null;
      return {
        ...g,
        milestones: [
          { ...makeMilestone(0, 'proposed'), swarmId: `s-${id}`, proposalId: `p-${id}` },
          makeMilestone(1),
        ],
      };
    });
    mockRunSwarm.mockResolvedValue(makeSwarmRun('s-cap', 'done'));
    mockListProposals.mockReturnValue([]);
    mockUpdateMilestoneStatus.mockReturnValue(null);

    const summary = await runConductor(makeCfg(), {
      once: true,
      dryRun: false,
      maxGoalsPerCycle: 2,
    });

    expect(summary.milestonesAdvanced).toBeLessThanOrEqual(2);
  });

  it('dry-run records milestone intent without calling runSwarm', async () => {
    const goals = [makeGoal('g-dry-1'), makeGoal('g-dry-2')];
    mockListGoals.mockReturnValue(goals);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: true });

    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(summary.milestonesAdvanced).toBeGreaterThanOrEqual(1);
    expect(summary.daemonFallback).toBe(false);
  });

  it('continues advancing remaining goals after a single goal advance error', async () => {
    const g1 = makeGoal('g-err-1');
    const g2 = makeGoal('g-err-2');
    mockListGoals.mockReturnValue([g1, g2]);

    let swarmCallCount = 0;
    mockLoadGoal.mockImplementation((id: string) => {
      const g = id === g1.id ? g1 : g2;
      return g;
    });

    mockRunSwarm.mockImplementation(() => {
      swarmCallCount++;
      if (swarmCallCount === 1) throw new Error('sandbox creation failed');
      return Promise.resolve(makeSwarmRun('sok', 'done'));
    });

    const afterG2 = {
      ...g2,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 'sok', proposalId: 'pok' },
        makeMilestone(1),
      ],
    };
    // After first swarm throws, advance.ts sets milestone to 'blocked';
    // second swarm succeeds. We need loadGoal to reflect the state.
    mockLoadGoal
      .mockReturnValueOnce(g1)          // g1 advance: loadGoal
      .mockReturnValueOnce(g2)          // g2 advance: loadGoal
      .mockReturnValue(afterG2);        // reloads

    mockListProposals.mockReturnValue([
      { id: 'pok', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
        summary: 'swarm=sok' },
    ]);
    mockUpdateMilestoneStatus.mockReturnValue(null);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    // g1 failed but g2 should have succeeded
    expect(summary.goalsAdvanced).toBeGreaterThanOrEqual(1);
  });

  it('returns populated goalActivity entries for advanced goals', async () => {
    const g = makeGoal('g-activity');
    mockListGoals.mockReturnValue([g]);

    const afterAdvance = {
      ...g,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 's-act', proposalId: 'p-act' },
        makeMilestone(1),
      ],
    };
    mockLoadGoal.mockReturnValue(afterAdvance);
    mockRunSwarm.mockResolvedValue(makeSwarmRun('s-act', 'done'));
    mockListProposals.mockReturnValue([
      { id: 'p-act', origin: 'swarm', repo: '/tmp/test-repo', status: 'pending',
        summary: 'swarm=s-act' },
    ]);
    mockUpdateMilestoneStatus.mockReturnValue(afterAdvance);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.goalActivity).toHaveLength(1);
    expect(summary.goalActivity[0]!.goalId).toBe('g-activity');
    expect(typeof summary.goalActivity[0]!.fractionDone).toBe('number');
    expect(typeof summary.goalActivity[0]!.milestoneTitle).toBe('string');
  });
});

// ============================================================================
// Suite 4: Kill-switch
// ============================================================================

describe('M102 — kill-switch: conductor exits immediately when kill is on', () => {
  it('returns killSwitchTripped=true and skips all work', async () => {
    mockKillSwitchOn.mockReturnValue(true);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.killSwitchTripped).toBe(true);
    expect(summary.goalsAdvanced).toBe(0);
    expect(summary.daemonFallback).toBe(false);
    expect(mockListGoals).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunDaemon).not.toHaveBeenCalled();
  });

  it('trips kill-switch mid-cycle when toggled between goals', async () => {
    let killCheckCount = 0;
    mockKillSwitchOn.mockImplementation(() => {
      killCheckCount++;
      // First check (pre-cycle guard): pass. Second check (per-goal): kill.
      return killCheckCount > 1;
    });

    const goals = [makeGoal('g-mid-1'), makeGoal('g-mid-2')];
    mockListGoals.mockReturnValue(goals);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.killSwitchTripped).toBe(true);
    expect(summary.goalsAdvanced).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Suite 5: Source-level safety guard
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONDUCTOR_SRC = readFileSync(
  pathResolve(HERE, '../src/core/goals/conductor.ts'),
  'utf8',
);

const LOOP_SRC = readFileSync(pathResolve(HERE, '../src/cli/loop.ts'), 'utf8');

const OUTWARD_PRIMITIVES: RegExp[] = [
  /applyProposal/,
  /inbox\/apply/,
  /git\s+push/,
  /gh\s+pr\s+create/,
  /createPr\b/,
  /\bdeploy\s*\(/,
  /mergeProposal/,
  /autoMerge\s*\(/,
  /ship-deploy|shipDeploy|startShip\b/,
];

describe('M102 — source-level safety: conductor + loop carry no outward-mutation primitive', () => {
  for (const re of OUTWARD_PRIMITIVES) {
    it(`conductor.ts does not contain ${re}`, () => {
      expect(re.test(CONDUCTOR_SRC), `conductor.ts matched ${re}`).toBe(false);
    });

    it(`loop.ts does not contain ${re}`, () => {
      expect(re.test(LOOP_SRC), `loop.ts matched ${re}`).toBe(false);
    });
  }

  it('conductor.ts exports runConductor', () => {
    expect(CONDUCTOR_SRC).toMatch(/export\s+async\s+function\s+runConductor/);
  });

  it('loop.ts imports runConductor (not runDaemon directly)', () => {
    expect(LOOP_SRC).toMatch(/runConductor/);
    const directRunDaemon = /await\s+runDaemon\s*\(/.test(LOOP_SRC);
    expect(directRunDaemon).toBe(false);
  });
});
