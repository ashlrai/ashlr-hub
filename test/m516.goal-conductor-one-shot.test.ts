import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, Goal } from '../src/core/types.js';

const mockKillSwitchOn = vi.fn();
const mockListEnrolled = vi.fn();
const mockListGoalsDetailed = vi.fn();
const mockLoadGoal = vi.fn();
const mockGoalDigest = vi.fn();
const mockNextMilestone = vi.fn();
const mockAdvanceGoalCycle = vi.fn();
const mockProgressOf = vi.fn();
const mockConsumePermit = vi.fn();
const mockClaimCapability = vi.fn();
const mockReserveQuota = vi.fn();
const mockLoadConfig = vi.fn();
const mockRunSimpleConductor = vi.fn();

vi.mock('../src/core/config.js', () => ({
  loadConfigReadOnlyStrict: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../src/core/simple-conductor.js', () => ({
  runSimpleConductor: (...args: unknown[]) => mockRunSimpleConductor(...args),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: (...args: unknown[]) => mockKillSwitchOn(...args),
  listEnrolled: (...args: unknown[]) => mockListEnrolled(...args),
}));

vi.mock('../src/core/goals/store.js', () => ({
  listGoalsDetailed: (...args: unknown[]) => mockListGoalsDetailed(...args),
  loadGoal: (...args: unknown[]) => mockLoadGoal(...args),
  goalSnapshotDigest: (...args: unknown[]) => mockGoalDigest(...args),
}));

vi.mock('../src/core/goals/advance.js', () => ({
  nextActionableMilestone: (...args: unknown[]) => mockNextMilestone(...args),
  advanceGoalCycle: (...args: unknown[]) => mockAdvanceGoalCycle(...args),
  progressOf: (...args: unknown[]) => mockProgressOf(...args),
}));

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  consumeGoalConductorActivationPermit: (...args: unknown[]) => mockConsumePermit(...args),
  isGoalConductorActivationCapability: (...args: unknown[]) => mockClaimCapability(...args),
  GOAL_CONDUCTOR_ONCE_MAX_TOKENS: 50_000,
  GOAL_CONDUCTOR_ONCE_MAX_STEPS: 12,
  liveConductorActivationAuthorized: () => false,
}));

vi.mock('../src/core/goals/conductor-quota.js', () => ({
  reserveGoalConductorProviderQuota: (...args: unknown[]) => mockReserveQuota(...args),
}));

import { runAuthorizedConductorOnce } from '../src/core/goals/conductor.js';
import { cmdLoop } from '../src/cli/loop.js';

const milestone = {
  id: 'goal-one-m0', title: 'Implement', detail: 'Implement', order: 0,
  status: 'pending', specId: null, swarmId: null, proposalId: null,
  createdAt: '2026-08-16T19:00:00.000Z', updatedAt: '2026-08-16T19:00:00.000Z',
} as const;
const goal = {
  id: 'goal-one', objective: 'Build one bounded thing',
  project: '/tmp/enrolled-project', status: 'active', milestones: [milestone],
  createdAt: '2026-08-16T19:00:00.000Z', updatedAt: '2026-08-16T19:00:00.000Z',
} as unknown as Goal;

beforeEach(() => {
  vi.clearAllMocks();
  mockKillSwitchOn.mockReturnValue(false);
  mockListEnrolled.mockReturnValue(['/tmp/enrolled-project']);
  mockListGoalsDetailed.mockReturnValue({
    goals: [goal], sourceState: 'healthy', sourcePresent: true, complete: true,
    scannedFiles: 1, unreadableFiles: 0, limitExceeded: false,
  });
  mockLoadGoal.mockReturnValue(goal);
  mockGoalDigest.mockReturnValue('a'.repeat(64));
  mockNextMilestone.mockReturnValue(milestone);
  mockConsumePermit.mockReturnValue({
    authorized: true, reason: 'authorized', permitId: '1'.repeat(32),
    capability: { opaque: true }, configSnapshot: { signed: true },
  });
  mockClaimCapability.mockReturnValue(true);
  mockReserveQuota.mockReturnValue({ launchAuthorized: true, reason: 'reserved' });
  mockAdvanceGoalCycle.mockResolvedValue({
    runs: [{ id: 'swarm-one' }], goalDone: false, milestoneDone: true, proposalsFiled: 1,
  });
  mockProgressOf.mockReturnValue({ fractionDone: 0.5 });
  mockLoadConfig.mockReturnValue({ foundry: { simpleConductor: false } });
  mockRunSimpleConductor.mockResolvedValue({
    tasksAttempted: 0, proposalsFiled: 0, merged: 0, errors: [],
  });
});

describe('M516 explicit signed one-shot conductor', () => {
  it.each([
    ['--watch'],
    ['--continuous'],
    ['--allow-cloud'],
    ['--dry-run'],
  ])('refuses --goal combined with %s before config or authority reads', async (flag) => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await cmdLoop(['--goal', goal.id, flag])).toBe(2);
      expect(mockConsumePermit).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('refuses an incomplete goal source before reading activation authority', async () => {
    mockListGoalsDetailed.mockReturnValue({
      goals: [goal], sourceState: 'degraded', sourcePresent: true, complete: false,
      scannedFiles: 2, unreadableFiles: 1, limitExceeded: false,
    });
    const result = await runAuthorizedConductorOnce({} as AshlrConfig, { goalId: goal.id });
    expect(result.activationRefusalReason).toBe('goal-conductor-goal-source-degraded');
    expect(mockConsumePermit).not.toHaveBeenCalled();
    expect(mockAdvanceGoalCycle).not.toHaveBeenCalled();
  });

  it('burns the permit but makes zero provider attempts when final quota authority refuses', async () => {
    mockReserveQuota.mockReturnValue({
      launchAuthorized: false,
      reason: 'goal-conductor-durable-quota-authority-unavailable',
    });
    const result = await runAuthorizedConductorOnce({} as AshlrConfig, { goalId: goal.id });
    expect(result).toMatchObject({
      activationRefused: true,
      activationRefusalReason: 'goal-conductor-durable-quota-authority-unavailable',
      activationPermitId: '1'.repeat(32),
      daemonFallback: false,
    });
    expect(mockConsumePermit).toHaveBeenCalledTimes(1);
    expect(mockClaimCapability).toHaveBeenCalledTimes(1);
    expect(mockAdvanceGoalCycle).not.toHaveBeenCalled();
  });

  it('refuses a stale action-time capability before reserving quota', async () => {
    mockClaimCapability.mockReturnValue(false);
    const result = await runAuthorizedConductorOnce({} as AshlrConfig, { goalId: goal.id });
    expect(result.activationRefusalReason).toBe('goal-conductor-capability-invalid-or-consumed');
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockAdvanceGoalCycle).not.toHaveBeenCalled();
  });

  it('refuses target drift after durable consumption and before quota/provider contact', async () => {
    mockGoalDigest.mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('b'.repeat(64));
    const result = await runAuthorizedConductorOnce({} as AshlrConfig, { goalId: goal.id });
    expect(result.activationRefusalReason).toBe('goal-conductor-target-drifted-after-consumption');
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockAdvanceGoalCycle).not.toHaveBeenCalled();
  });

  it('advances exactly one target with no retry, cloud, any-repo, or fallback', async () => {
    const result = await runAuthorizedConductorOnce({} as AshlrConfig, { goalId: goal.id });
    expect(result).toMatchObject({
      goalsAdvanced: 1, milestonesAdvanced: 1, proposalsFiled: 1,
      daemonFallback: false, activationPermitId: '1'.repeat(32),
    });
    expect(mockAdvanceGoalCycle).toHaveBeenCalledTimes(1);
    expect(mockAdvanceGoalCycle).toHaveBeenCalledWith(
      goal.id,
      { signed: true },
      expect.objectContaining({
        maxRetries: 0,
        allowCloud: false,
        allowAnyRepo: false,
        expectedGoalDigest: 'a'.repeat(64),
        expectedMilestoneId: milestone.id,
        budget: { maxTokens: 50_000, maxSteps: 12, allowCloud: false },
      }),
    );
  });

  it('never lets simple-conductor configuration intercept an explicit signed goal', async () => {
    mockLoadConfig.mockReturnValue({ foundry: { simpleConductor: true } });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await cmdLoop(['--goal', goal.id])).toBe(0);
      expect(mockRunSimpleConductor).not.toHaveBeenCalled();
      expect(mockConsumePermit).toHaveBeenCalledTimes(1);
      expect(mockAdvanceGoalCycle).toHaveBeenCalledTimes(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
