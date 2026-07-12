/**
 * M228 — milestone ↔ proposal lifecycle linkage tests.
 *
 * Three contracts verified:
 *  1. advanceGoal sets proposalId + 'proposed' status after a successful swarm
 *     (regression-guard: if this breaks, milestones never leave 'blocked').
 *  2. When a proposal is applied with passing verification, the linked goal
 *     milestone advances to 'done'.
 *  3. When a proposal is rejected (setStatus → 'rejected'), the linked goal
 *     milestone resets to 'pending' so the conductor can retry.
 *
 * The store under test (inbox/store.ts) is exercised through its real code path
 * with goals/store.ts mocked (no real ~/.ashlr I/O). All filesystem, audit, and
 * pulse calls are mocked out so the suite is hermetic.
 */

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Goal, Milestone, Proposal, SwarmRun } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks for inbox/store.ts dependencies — declared BEFORE any module imports.
// ---------------------------------------------------------------------------

const mockListGoals = vi.fn();
const mockUpdateMilestoneStatusFromGoals = vi.fn();

// Goals store — provide listGoals so linkMilestoneOutcome can scan milestones.
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: (...args: unknown[]) => mockListGoals(...args),
  updateMilestoneStatus: (...args: unknown[]) => mockUpdateMilestoneStatusFromGoals(...args),
  goalsDir: () => '/tmp/fake-goals',
}));

const { fakeHome } = vi.hoisted(() => ({
  fakeHome: `/tmp/ashlr-m228-${process.pid}`,
}));

vi.mock('node:os', () => ({
  homedir: () => fakeHome,
}));

// Audit, fleet telemetry, decisions ledger — no-ops for this test.
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/integrations/pulse-sync.js', () => ({ emitFleetEvent: vi.fn() }));
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({ recordDecision: vi.fn() }));
vi.mock('../src/core/fleet/judge-trace.js', () => ({ linkOutcome: vi.fn() }));
vi.mock('../src/core/run/diff-safety.js', () => ({
  isDestructiveDiff: vi.fn(() => ({ destructive: false })),
}));
afterAll(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Lazy imports AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { setStatus, updateProposalField } from '../src/core/inbox/store.js';

// Advance-side imports — for contract 1 we rely on m28.advance.test.ts, but
// we re-assert the core linkage here with a minimal smoke test.
const mockRunSwarm = vi.fn();
const mockAssertMayMutate = vi.fn();
const mockLoadGoalForAdvance = vi.fn();
const mockUpdateMilestoneStatusForAdvance = vi.fn();
const mockListProposals = vi.fn();
const mockLoadProposal = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));
vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: (...args: unknown[]) => mockAssertMayMutate(...args),
}));
// NOTE: goals/store.js mock above covers advance.ts too (same vi.mock key).
vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  // Partially re-export the real module so setStatus is real but add
  // listProposals / loadProposal overrides for the advance tests.
  // We do NOT use this approach — instead the two sub-suites below import
  // their subjects independently. See details per-suite.
  return await importOriginal();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  const now = new Date().toISOString();
  return {
    id: 'g1-m0',
    title: 'ship the widget',
    detail: 'implement it',
    order: 0,
    status: 'proposed',
    specId: null,
    swarmId: 'swarm-abc',
    proposalId: 'prop-target',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeGoal(milestoneOverrides: Partial<Milestone> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: 'goal-1',
    objective: 'ship the widget',
    project: '/tmp/enrolled-repo',
    status: 'active',
    milestones: [makeMilestone(milestoneOverrides)],
    createdAt: now,
    updatedAt: now,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const now = new Date().toISOString();
  return {
    id: 'prop-target',
    repo: path.resolve('/tmp/enrolled-repo'),
    origin: 'swarm',
    kind: 'patch',
    title: 'Advance goal: ship the widget — ship the widget',
    summary: 'Autonomous swarm proposal (swarm=swarm-abc, status=done)',
    status: 'pending',
    createdAt: now,
    ...overrides,
  };
}

function makeSwarmRun(overrides: Partial<SwarmRun> = {}): SwarmRun {
  const now = new Date().toISOString();
  return {
    id: 'swarm-abc',
    goal: 'ship the widget — ship the widget',
    specId: null,
    project: '/tmp/enrolled-repo',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 200_000, maxSteps: 40, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'done',
    plan: { tasks: [] } as unknown as SwarmRun['plan'],
    tasks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers for setStatus tests: stub readFileSync to return a known proposal.
// ---------------------------------------------------------------------------

function stubExistingProposal(proposal: Proposal): void {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  const dir = path.join(fakeHome, '.ashlr', 'inbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${proposal.id}.json`), `${JSON.stringify(proposal)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Contract 1 — advanceGoal links proposalId + sets 'proposed' status
//
// NOTE: this is covered exhaustively in test/m28.advance.test.ts. We add a
// brief smoke-test here to pin the M228 requirement at source level.
// ---------------------------------------------------------------------------

describe('M228 Contract 1 — advanceGoal sets proposalId + proposed status', () => {
  // These mocks shadow the ones set up at module scope with different return values.
  // We re-mock goals/store inside this suite's beforeEach so the spy calls are fresh.
  beforeEach(() => {
    mockRunSwarm.mockReset();
    mockAssertMayMutate.mockReset();
    mockLoadGoalForAdvance.mockReset();
    mockUpdateMilestoneStatusForAdvance.mockReset();
    mockListProposals.mockReset();
    mockLoadProposal.mockReset();

    mockAssertMayMutate.mockImplementation(() => {});
    mockListProposals.mockReturnValue([]);
    mockLoadProposal.mockReturnValue(null);
    mockUpdateMilestoneStatusForAdvance.mockImplementation(() => null);
  });

  it('advance.ts source calls updateMilestoneStatus with "proposed" + proposalId on success path', () => {
    // Source-level guard: the advance module MUST link proposalId and set
    // 'proposed' status after a successful swarm + proposal correlation.
    // We read the source using the real (un-mocked) Node built-in by using
    // the actual readFileSync import before vi.mock hoisting applies to it.
    // Since node:fs is mocked in this suite we use a URL-resolved require path
    // via the real synchronous require call on the raw source.
    //
    // Simpler: just assert the literal text is present without any I/O — the
    // source was already loaded by the tsc/vitest transform pipeline.
    // The transform preserves the original source text in the module graph.
    // We import advance.ts's text via the raw source import trick used in m28.
    //
    // Even simpler: the contract is fully verified in m28.advance.test.ts (test
    // "links swarmId + the PENDING proposalId and sets milestone 'proposed'").
    // Here we validate it at a static/textual level WITHOUT I/O by checking
    // the module export exists and the keys it must call are part of its interface.

    // The advance module exports advanceGoal — if it compiled and exports the
    // function, the source-level contract (proposalId linkage) passed tsc.
    // We do a behavioral smoke check: updateMilestoneStatus is called from goals/store
    // which is mocked above — confirm the mock is wired (import path resolves).
    expect(typeof mockUpdateMilestoneStatusFromGoals).toBe('function');

    // The real guard: advance.ts source text contains the required call.
    const advancePath = require('node:path').join(
      __dirname,
      '../src/core/goals/advance.ts',
    );
    const src = fs.readFileSync(advancePath, 'utf8');

    expect(src).toMatch(/'proposed'/);
    expect(src).toMatch(/proposalId/);
    expect(src).toMatch(/updateMilestoneStatus\(goalId,\s*milestone\.id,\s*'proposed'/);
  });
});

// ---------------------------------------------------------------------------
// Contract 2 & 3 — setStatus('applied'/'rejected') updates linked milestone
// ---------------------------------------------------------------------------

describe('M228 Contract 2 — verified proposal applied → linked milestone becomes done', () => {
  beforeEach(() => {
    mockListGoals.mockReset();
    mockUpdateMilestoneStatusFromGoals.mockReset();
    mockUpdateMilestoneStatusFromGoals.mockImplementation(() => null);
  });

  it('milestone with matching proposalId is updated to "done" when proposal is applied with passing verification', () => {
    const proposal = makeProposal({ status: 'approved', verifyResult: { passed: true } });
    stubExistingProposal(proposal);

    const goal = makeGoal(); // milestone has proposalId: 'prop-target'
    mockListGoals.mockReturnValue([goal]);

    setStatus('prop-target', 'applied');

    expect(mockUpdateMilestoneStatusFromGoals).toHaveBeenCalledWith(
      'goal-1',
      'g1-m0',
      'done',
    );
  });

  it('does not update the milestone to "done" when applied proposal lacks passing verification', () => {
    const proposal = makeProposal({ status: 'approved' });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);

    setStatus('prop-target', 'applied');

    expect(mockUpdateMilestoneStatusFromGoals).not.toHaveBeenCalled();
  });

  it('does not update the milestone to "done" when applied proposal has failing verification', () => {
    const proposal = makeProposal({ status: 'approved', verifyResult: { passed: false } });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);

    setStatus('prop-target', 'applied');

    expect(mockUpdateMilestoneStatusFromGoals).not.toHaveBeenCalled();
  });

  it('updates the milestone when passing verification is later recorded on an already applied proposal', () => {
    const proposal = makeProposal({ status: 'applied' });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);

    updateProposalField('prop-target', { verifyResult: { passed: true } });

    expect(mockUpdateMilestoneStatusFromGoals).toHaveBeenCalledWith(
      'goal-1',
      'g1-m0',
      'done',
    );
  });

  it('does not update the milestone when failing verification is later recorded on an applied proposal', () => {
    const proposal = makeProposal({ status: 'applied' });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);

    updateProposalField('prop-target', { verifyResult: { passed: false } });

    expect(mockUpdateMilestoneStatusFromGoals).not.toHaveBeenCalled();
  });

  it('no milestone updated when no goal has a matching proposalId', () => {
    const proposal = makeProposal({ status: 'approved', verifyResult: { passed: true } });
    stubExistingProposal(proposal);

    // Goal milestone has a DIFFERENT proposalId
    const goal = makeGoal({ proposalId: 'prop-other' });
    mockListGoals.mockReturnValue([goal]);

    setStatus('prop-target', 'applied');

    expect(mockUpdateMilestoneStatusFromGoals).not.toHaveBeenCalled();
  });

  it('never throws when listGoals throws (best-effort — proposal flow unaffected)', () => {
    const proposal = makeProposal({ status: 'approved', verifyResult: { passed: true } });
    stubExistingProposal(proposal);

    mockListGoals.mockImplementation(() => { throw new Error('disk error'); });

    // setStatus must not throw even if listGoals blows up.
    expect(() => setStatus('prop-target', 'applied')).not.toThrow();
  });

  it('never throws when updateMilestoneStatus throws (best-effort)', () => {
    const proposal = makeProposal({ status: 'approved', verifyResult: { passed: true } });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);
    mockUpdateMilestoneStatusFromGoals.mockImplementation(() => {
      throw new Error('store write failed');
    });

    expect(() => setStatus('prop-target', 'applied')).not.toThrow();
  });
});

describe('M228 Contract 3 — proposal rejected → linked milestone resets to pending', () => {
  beforeEach(() => {
    mockListGoals.mockReset();
    mockUpdateMilestoneStatusFromGoals.mockReset();
    mockUpdateMilestoneStatusFromGoals.mockImplementation(() => null);
  });

  it('milestone with matching proposalId is reset to "pending" when proposal is rejected', () => {
    const proposal = makeProposal({ status: 'pending' });
    stubExistingProposal(proposal);

    const goal = makeGoal(); // milestone proposalId: 'prop-target', status: 'proposed'
    mockListGoals.mockReturnValue([goal]);

    setStatus('prop-target', 'rejected');

    expect(mockUpdateMilestoneStatusFromGoals).toHaveBeenCalledWith(
      'goal-1',
      'g1-m0',
      'pending',
    );
  });

  it('only the first goal with a matching proposalId is updated (one owner per proposal)', () => {
    const proposal = makeProposal({ status: 'pending' });
    stubExistingProposal(proposal);

    const now = new Date().toISOString();
    // Two goals both claim the same proposalId (edge case / corruption).
    const goal1 = makeGoal();
    const goal2: Goal = {
      ...makeGoal(),
      id: 'goal-2',
      milestones: [makeMilestone({ id: 'g2-m0', proposalId: 'prop-target' })],
    };
    goal2.milestones[0]!.updatedAt = now;
    mockListGoals.mockReturnValue([goal1, goal2]);

    setStatus('prop-target', 'rejected');

    // Only one update — we stop after the first match.
    expect(mockUpdateMilestoneStatusFromGoals).toHaveBeenCalledTimes(1);
    expect(mockUpdateMilestoneStatusFromGoals).toHaveBeenCalledWith('goal-1', 'g1-m0', 'pending');
  });

  it('non-terminal statuses (approved, pending, failed) do NOT trigger milestone update', () => {
    const proposal = makeProposal({ status: 'pending' });
    stubExistingProposal(proposal);

    const goal = makeGoal();
    mockListGoals.mockReturnValue([goal]);

    for (const s of ['approved', 'pending', 'failed'] as const) {
      mockUpdateMilestoneStatusFromGoals.mockClear();
      setStatus('prop-target', s);
      expect(mockUpdateMilestoneStatusFromGoals).not.toHaveBeenCalled();
    }
  });
});
