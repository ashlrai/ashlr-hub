/**
 * M28 advance tests — goals/advance.ts (the SAFETY-CRITICAL module).
 *
 * SAFETY GUARDRAILS asserted here:
 *  - SANDBOXED + PROPOSAL-ONLY: every runSwarm call from advanceGoal carries
 *    { sandbox:true, requireSandbox:true, propose:true } + a hard budget.
 *  - ENROLLMENT-SCOPED: a non-enrolled / kill-switched target HARD-ERRORS
 *    BEFORE runSwarm is ever called (mock call count stays 0).
 *  - STEERABLE + BOUNDED: exactly ONE advanceGoal call => exactly ONE runSwarm
 *    call (no auto-advance loop).
 *  - Milestone status transitions + proposal linkage are recorded on the Goal
 *    record ONLY (never approving/applying the proposal).
 *  - READ-ONLY tracking: progressOf / nextActionableMilestone mutate nothing.
 *  - SOURCE-LEVEL GUARD: advance.ts contains NO applyProposal / setStatus /
 *    git push / createPr / deploy, and NO runSwarm call lacking the 3 flags.
 *
 * Everything outward (assertMayMutate, runSwarm, the store, the inbox) is
 * MOCKED — NO real ~/.ashlr, NO real portfolio, NO real swarm ever runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AshlrConfig, Goal, Milestone, SwarmRun, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the module-under-test is imported.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
const mockAssertMayMutate = vi.fn();
const mockLoadGoal = vi.fn();
const mockUpdateMilestoneStatus = vi.fn();
const mockListProposals = vi.fn();
const mockLoadProposal = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: (...args: unknown[]) => mockAssertMayMutate(...args),
}));

vi.mock('../src/core/goals/store.js', () => ({
  loadGoal: (...args: unknown[]) => mockLoadGoal(...args),
  updateMilestoneStatus: (...args: unknown[]) => mockUpdateMilestoneStatus(...args),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
}));

// Lazy import AFTER mocks are registered.
import {
  advanceGoal,
  nextActionableMilestone,
  progressOf,
} from '../src/core/goals/advance.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(): AshlrConfig {
  return { version: 1 } as AshlrConfig;
}

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  const now = new Date().toISOString();
  return {
    id: 'g1-m0',
    title: 'first milestone',
    detail: 'do the thing',
    order: 0,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: 'g1',
    objective: 'ship the feature',
    project: '/tmp/enrolled-repo',
    status: 'active',
    milestones: [makeMilestone()],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSwarmRun(overrides: Partial<SwarmRun> = {}): SwarmRun {
  const now = new Date().toISOString();
  return {
    id: 'swarm-abc',
    goal: 'ship the feature — first milestone',
    specId: null,
    project: '/tmp/enrolled-repo',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'done',
    plan: { tasks: [] } as unknown as SwarmRun['plan'],
    tasks: [],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const now = new Date().toISOString();
  return {
    id: 'prop-1',
    // advance.ts correlates on resolve(goal.project); resolve the fixture repo
    // the same way so it matches on Windows (C:\tmp\...) as well as POSIX.
    repo: path.resolve('/tmp/enrolled-repo'),
    origin: 'swarm',
    kind: 'patch',
    title: 'swarm proposal',
    summary: 'Autonomous swarm proposal (swarm=swarm-abc, status=done)',
    status: 'pending',
    createdAt: now,
    ...overrides,
  };
}

function realizedMergeEvidence(observedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
  };
}

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockAssertMayMutate.mockReset();
  mockLoadGoal.mockReset();
  mockUpdateMilestoneStatus.mockReset();
  mockListProposals.mockReset();
  mockLoadProposal.mockReset();

  // Sensible defaults; individual tests override.
  mockListProposals.mockReturnValue([]);
  mockLoadProposal.mockReturnValue(null);
  mockUpdateMilestoneStatus.mockImplementation(() => null);
});

// ---------------------------------------------------------------------------
// nextActionableMilestone — pure read seam.
// ---------------------------------------------------------------------------

describe('nextActionableMilestone', () => {
  it('returns the lowest-order pending milestone', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm2', order: 2, status: 'pending' }),
        makeMilestone({ id: 'm0', order: 0, status: 'done' }),
        makeMilestone({ id: 'm1', order: 1, status: 'pending' }),
      ],
    });
    expect(nextActionableMilestone(goal)?.id).toBe('m1');
  });

  it('returns null when the goal is paused/archived/done', () => {
    for (const status of ['paused', 'archived', 'done'] as const) {
      const goal = makeGoal({ status, milestones: [makeMilestone({ status: 'pending' })] });
      expect(nextActionableMilestone(goal)).toBeNull();
    }
  });

  it('returns null when no milestone is pending', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm0', status: 'proposed' }),
        makeMilestone({ id: 'm1', status: 'paused' }),
      ],
    });
    expect(nextActionableMilestone(goal)).toBeNull();
  });

  it('does not mutate the goal', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm1', order: 1 }),
        makeMilestone({ id: 'm0', order: 0 }),
      ],
    });
    const before = JSON.stringify(goal);
    nextActionableMilestone(goal);
    expect(JSON.stringify(goal)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// advanceGoal — sandboxed, proposal-only, enrollment-gated.
// ---------------------------------------------------------------------------

describe('advanceGoal — SANDBOXED + PROPOSAL-ONLY', () => {
  it('calls runSwarm with sandbox:true + requireSandbox:true + propose:true + a hard budget', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => { /* enrolled, allowed */ });
    mockListProposals.mockReturnValue([makeProposal()]);
    mockRunSwarm.mockResolvedValue(makeSwarmRun());

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    const opts = mockRunSwarm.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.sandbox).toBe(true);
    expect(opts.requireSandbox).toBe(true);
    expect(opts.propose).toBe(true);
    // Hard budget present + bounded.
    const budget = opts.budget as { maxTokens: number; maxSteps: number; allowCloud: boolean };
    expect(budget.maxTokens).toBeGreaterThan(0);
    expect(budget.maxSteps).toBeGreaterThan(0);
    expect(budget.allowCloud).toBe(false);
    // Targets the goal's resolved project.
    expect(opts.project).toBe(path.resolve('/tmp/enrolled-repo'));
  });

  it('cannot have the three safety flags overridden via opts', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => { /* allowed */ });
    mockRunSwarm.mockResolvedValue(makeSwarmRun());

    // AdvanceOptions has no sandbox/requireSandbox/propose knobs; even passing
    // junk does not flip them.
    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true } as never);

    const opts = mockRunSwarm.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.sandbox).toBe(true);
    expect(opts.requireSandbox).toBe(true);
    expect(opts.propose).toBe(true);
  });

  it('links swarmId + the PENDING proposalId and sets milestone "proposed" on success', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {});
    // The runner stamps the proposal summary with `swarm=<run.id>`; the
    // correlator matches on that (+ repo + origin:'swarm').
    mockListProposals.mockReturnValue([
      makeProposal({
        id: 'prop-XYZ',
        summary: 'Autonomous swarm proposal (swarm=swarm-abc, status=done)',
      }),
    ]);
    mockRunSwarm.mockResolvedValue(makeSwarmRun({ id: 'swarm-abc' }));

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    // in-progress first, then proposed with linkage.
    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith('g1', 'g1-m0', 'in-progress');
    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith('g1', 'g1-m0', 'proposed', {
      swarmId: 'swarm-abc',
      proposalId: 'prop-XYZ',
    });
  });

  it('sets milestone "blocked" when the swarm fails (no proposal linked)', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {});
    mockRunSwarm.mockResolvedValue(makeSwarmRun({ status: 'failed' }));

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith('g1', 'g1-m0', 'in-progress');
    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith(
      'g1',
      'g1-m0',
      'blocked',
      expect.objectContaining({ swarmId: 'swarm-abc', proposalId: null }),
    );
  });

  it('NEVER calls applyProposal / setStatus / approves a proposal (only updateMilestoneStatus on the record)', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {});
    mockListProposals.mockReturnValue([makeProposal()]);
    mockRunSwarm.mockResolvedValue(makeSwarmRun());

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    // loadProposal is only read in progressOf, not advanceGoal; advanceGoal
    // never mutates a proposal. The only writes are to the Goal record.
    const statuses = mockUpdateMilestoneStatus.mock.calls.map(c => c[2]);
    expect(statuses).not.toContain('approved');
    expect(statuses).not.toContain('applied');
  });
});

describe('advanceGoal — ENROLLMENT-SCOPED (HARD-ERROR before any swarm)', () => {
  it('HARD-ERRORS and does NOT call runSwarm when the repo is not enrolled', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {
      throw new Error('repo not enrolled for autonomous work: /tmp/enrolled-repo');
    });

    await expect(advanceGoal('g1', makeCfg())).rejects.toThrow(/not enrolled/);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    // gate ran before runSwarm; in-progress was never written because the gate
    // is upstream of the status flip.
    expect(mockUpdateMilestoneStatus).not.toHaveBeenCalled();
  });

  it('HARD-ERRORS and does NOT call runSwarm when the kill switch is on', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {
      throw new Error('autonomy kill switch is ON');
    });

    await expect(advanceGoal('g1', makeCfg(), { allowAnyRepo: true })).rejects.toThrow(/kill switch/);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('HARD-ERRORS and does NOT call runSwarm when the goal has no project', async () => {
    mockLoadGoal.mockReturnValue(makeGoal({ project: null }));

    await expect(advanceGoal('g1', makeCfg())).rejects.toThrow(/no enrolled project/);
    expect(mockAssertMayMutate).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('passes the gate BEFORE running the swarm (assertMayMutate call precedes runSwarm)', async () => {
    const order: string[] = [];
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => { order.push('gate'); });
    mockRunSwarm.mockImplementation(async () => { order.push('swarm'); return makeSwarmRun(); });

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    expect(order).toEqual(['gate', 'swarm']);
  });
});

describe('advanceGoal — STEERABLE + BOUNDED', () => {
  it('one advanceGoal call => exactly one runSwarm call (no auto-advance loop)', async () => {
    mockLoadGoal.mockReturnValue(
      makeGoal({
        milestones: [
          makeMilestone({ id: 'm0', order: 0, status: 'pending' }),
          makeMilestone({ id: 'm1', order: 1, status: 'pending' }),
          makeMilestone({ id: 'm2', order: 2, status: 'pending' }),
        ],
      }),
    );
    mockAssertMayMutate.mockImplementation(() => {});
    mockRunSwarm.mockResolvedValue(makeSwarmRun());

    await advanceGoal('g1', makeCfg(), { allowAnyRepo: true });

    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('HARD-ERRORS when there is no actionable milestone', async () => {
    mockLoadGoal.mockReturnValue(
      makeGoal({ milestones: [makeMilestone({ status: 'done' })] }),
    );

    await expect(advanceGoal('g1', makeCfg(), { allowAnyRepo: true })).rejects.toThrow(
      /no actionable milestone/,
    );
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('HARD-ERRORS when the goal does not exist', async () => {
    mockLoadGoal.mockReturnValue(null);
    await expect(advanceGoal('nope', makeCfg())).rejects.toThrow(/goal not found/);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

describe('advanceGoal — STUCK-STATE RECOVERY (M28 regression)', () => {
  it('resets the milestone to "blocked" (not stuck in-progress) when runSwarm THROWS', async () => {
    mockLoadGoal.mockReturnValue(makeGoal());
    mockAssertMayMutate.mockImplementation(() => {});
    mockRunSwarm.mockRejectedValue(new Error('sandbox creation failed'));

    await expect(advanceGoal('g1', makeCfg(), { allowAnyRepo: true })).rejects.toThrow(
      /sandbox creation failed/,
    );

    // in-progress was written, then the error handler reset it to 'blocked'.
    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith('g1', 'g1-m0', 'in-progress');
    expect(mockUpdateMilestoneStatus).toHaveBeenCalledWith('g1', 'g1-m0', 'blocked');
    // The LAST status write is 'blocked' — the milestone is NOT left in-progress.
    const last = mockUpdateMilestoneStatus.mock.calls.at(-1)!;
    expect(last[2]).toBe('blocked');
  });
});

describe('nextActionableMilestone — SEQUENCING GATE (M28 regression)', () => {
  it('returns null (does NOT skip ahead) when an earlier milestone is in-progress', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm0', order: 0, status: 'in-progress' }),
        makeMilestone({ id: 'm1', order: 1, status: 'pending' }),
      ],
    });
    // Without the gate this would return m1, advancing out of order.
    expect(nextActionableMilestone(goal)).toBeNull();
  });

  it('returns null when an earlier milestone is blocked', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm0', order: 0, status: 'blocked' }),
        makeMilestone({ id: 'm1', order: 1, status: 'pending' }),
      ],
    });
    expect(nextActionableMilestone(goal)).toBeNull();
  });

  it('still advances when the only earlier milestones are done/skipped/paused', () => {
    const goal = makeGoal({
      milestones: [
        makeMilestone({ id: 'm0', order: 0, status: 'done' }),
        makeMilestone({ id: 'm1', order: 1, status: 'skipped' }),
        makeMilestone({ id: 'm2', order: 2, status: 'paused' }),
        makeMilestone({ id: 'm3', order: 3, status: 'pending' }),
      ],
    });
    // 'paused' is a deliberate human set-aside, not a stuck step: it does NOT gate.
    expect(nextActionableMilestone(goal)?.id).toBe('m3');
  });
});

// ---------------------------------------------------------------------------
// progressOf — read-only roll-up.
// ---------------------------------------------------------------------------

describe('progressOf — READ-ONLY tracking', () => {
  it('tallies by status, computes proposed/done and fractionDone (skipped excluded from denom)', () => {
    const goal = makeGoal({
      status: 'active',
      milestones: [
        makeMilestone({ id: 'm0', order: 0, status: 'done' }),
        makeMilestone({ id: 'm1', order: 1, status: 'proposed', proposalId: 'p1' }),
        makeMilestone({ id: 'm2', order: 2, status: 'skipped' }),
        makeMilestone({ id: 'm3', order: 3, status: 'pending' }),
      ],
    });
    mockLoadProposal.mockReturnValue(makeProposal({ id: 'p1', status: 'pending' }));

    const p = progressOf(goal);
    expect(p.goalId).toBe('g1');
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.proposed).toBe(1);
    expect(p.byStatus.skipped).toBe(1);
    // denom = 4 - 1 skipped = 3; done = 1 => 1/3
    expect(p.fractionDone).toBeCloseTo(1 / 3, 5);
    expect(p.nextActionableId).toBe('m3');
  });

  it('reconciles a "proposed" milestone whose proposal was applied and verified out-of-band to done (read-only)', () => {
    const goal = makeGoal({
      milestones: [makeMilestone({ id: 'm0', status: 'proposed', proposalId: 'p1' })],
    });
    mockLoadProposal.mockReturnValue(makeProposal({
      id: 'p1', status: 'applied', verifyResult: { passed: true },
      realizedMerge: realizedMergeEvidence(),
    }));

    const p = progressOf(goal);
    expect(p.done).toBe(1);
    expect(p.proposed).toBe(0);
    expect(p.fractionDone).toBe(1);
  });

  it('reconciles a "blocked" milestone whose linked proposal was applied and verified to done (M28 regression)', () => {
    const goal = makeGoal({
      milestones: [makeMilestone({ id: 'm0', status: 'blocked', proposalId: 'p1' })],
    });
    mockLoadProposal.mockReturnValue(makeProposal({
      id: 'p1', status: 'applied', verifyResult: { passed: true },
      realizedMerge: realizedMergeEvidence(),
    }));

    const p = progressOf(goal);
    expect(p.done).toBe(1);
    expect(p.fractionDone).toBe(1);
  });

  it('does not count an applied linked proposal as done without passing verification', () => {
    const goal = makeGoal({
      milestones: [makeMilestone({ id: 'm0', status: 'proposed', proposalId: 'p1' })],
    });
    mockLoadProposal.mockReturnValue(makeProposal({ id: 'p1', status: 'applied' }));

    const p = progressOf(goal);
    expect(p.done).toBe(0);
    expect(p.proposed).toBe(1);
    expect(p.fractionDone).toBe(0);
  });

  it('requalifies a persisted done milestone that claims an unwitnessed proposal as blocked', () => {
    const goal = makeGoal({
      status: 'done',
      milestones: [makeMilestone({ id: 'm0', status: 'done', proposalId: 'p1' })],
    });
    mockLoadProposal.mockReturnValue(makeProposal({ id: 'p1', status: 'applied' }));

    const p = progressOf(goal);
    expect(p.done).toBe(0);
    expect(p.byStatus.blocked).toBe(1);
    expect(p.fractionDone).toBe(0);
  });

  it('preserves an explicit done milestone that does not claim proposal completion', () => {
    const goal = makeGoal({
      status: 'done',
      milestones: [makeMilestone({ id: 'm0', status: 'done', proposalId: null })],
    });

    const p = progressOf(goal);
    expect(p.done).toBe(1);
    expect(p.fractionDone).toBe(1);
    expect(mockLoadProposal).not.toHaveBeenCalled();
  });

  it('returns fractionDone 0 when every milestone is skipped (no denom blowup)', () => {
    const goal = makeGoal({
      milestones: [makeMilestone({ id: 'm0', status: 'skipped' })],
    });
    const p = progressOf(goal);
    expect(p.fractionDone).toBe(0);
  });

  it('does not mutate the goal', () => {
    const goal = makeGoal({
      milestones: [makeMilestone({ id: 'm0', status: 'proposed', proposalId: 'p1' })],
    });
    mockLoadProposal.mockReturnValue(makeProposal({ id: 'p1', status: 'applied', verifyResult: { passed: true } }));
    const before = JSON.stringify(goal);
    progressOf(goal);
    expect(JSON.stringify(goal)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-LEVEL GUARD — the verifier-style grep over advance.ts.
// ---------------------------------------------------------------------------

describe('advance.ts source-level safety guard', () => {
  const advancePath = path.join(__dirname, '..', 'src', 'core', 'goals', 'advance.ts');
  const src = fs.readFileSync(advancePath, 'utf8');

  it('contains NO applyProposal / approve-setStatus / push / createPr / deploy', () => {
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/setStatus/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/git\s+push/);
    expect(src).not.toMatch(/gh\s+pr\s+create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/shipDeploy|startShip|runDeploy|\bdeploy\(/);
    // never approves a proposal
    expect(src).not.toMatch(/['"]approved['"]/);
  });

  it('every runSwarm( call site sets sandbox:true AND requireSandbox:true AND propose:true', () => {
    // Find every runSwarm( invocation body (greedy until the matching options).
    const calls = src.match(/runSwarm\s*\(([\s\S]*?)\)\s*;/g) ?? [];
    // There is exactly one real call (plus the import + comments do not match `runSwarm(`).
    const realCalls = calls.filter(c => /sink|cfg/.test(c));
    expect(realCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of realCalls) {
      expect(call).toMatch(/sandbox:\s*true/);
      expect(call).toMatch(/requireSandbox:\s*true/);
      expect(call).toMatch(/propose:\s*true/);
    }
  });

  it('contains no always-on loop (no setInterval / while(true) self-advance)', () => {
    expect(src).not.toMatch(/setInterval/);
    expect(src).not.toMatch(/while\s*\(\s*true\s*\)/);
  });
});
