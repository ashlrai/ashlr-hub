import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, ProviderInferenceQuotaSession } from '../src/core/types.js';

const mockReserveFleetQuotaUses = vi.fn();
const mockChat = vi.fn();
const mockGetActiveClient = vi.fn();

vi.mock('../src/core/fleet/quota.js', () => ({
  reserveFleetQuotaUses: (...args: unknown[]) => mockReserveFleetQuotaUses(...args),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

import {
  GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT,
  GoalConductorQuotaRefusal,
  reserveGoalConductorProviderQuota,
} from '../src/core/goals/conductor-quota.js';
import { planSwarm } from '../src/core/swarm/planner.js';

const config = {
  foundry: { limits: { builtin: { window: '1h', max: 100 } } },
} as unknown as AshlrConfig;

const binding = {
  permitId: '1'.repeat(32),
  goalId: 'goal-private-name',
  milestoneId: 'milestone-private-name',
  goalDigest: 'a'.repeat(64),
  projectPath: '/private/enrolled/project',
};

function reservedReceipts(): Array<{
  backend: 'builtin';
  status: 'reserved';
  used: number;
  limit: number;
}> {
  return Array.from({ length: GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT }, () => ({
    backend: 'builtin',
    status: 'reserved',
    used: GOAL_CONDUCTOR_PROVIDER_TICKET_COUNT,
    limit: 100,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReserveFleetQuotaUses.mockReturnValue({
    kind: 'reserved',
    launchAuthorized: true,
    reservations: reservedReceipts(),
  });
  mockGetActiveClient.mockResolvedValue({
    id: 'ollama',
    supportsTools: false,
    authority: { requestLimits: 'enforced', usageAccounting: 'exact-provider-counters' },
    chat: (...args: unknown[]) => mockChat(...args),
  });
});

describe('M517 signed one-shot durable provider quota', () => {
  it('atomically reserves exactly 13 opaque builtin tickets and refuses a 14th claim', () => {
    const decision = reserveGoalConductorProviderQuota(config, binding);
    expect(decision.launchAuthorized).toBe(true);
    if (!decision.launchAuthorized) throw new Error(decision.reason);

    expect(mockReserveFleetQuotaUses).toHaveBeenCalledTimes(1);
    const [requests, passedConfig] = mockReserveFleetQuotaUses.mock.calls[0] as [
      Array<{ backend: string; dispatchId: string }>,
      AshlrConfig,
    ];
    expect(passedConfig).toBe(config);
    expect(requests).toHaveLength(13);
    expect(new Set(requests.map((request) => request.dispatchId)).size).toBe(13);
    expect(requests.every((request) => request.backend === 'builtin')).toBe(true);
    expect(decision.attemptId).toMatch(/^goal-attempt-[a-f0-9]{64}$/);
    expect(requests.map((request) => request.dispatchId)).toEqual(
      Array.from(
        { length: 13 },
        (_, ordinal) => `${decision.attemptId}.provider.${ordinal.toString().padStart(2, '0')}`,
      ),
    );
    const serializedIds = JSON.stringify(requests);
    expect(serializedIds).not.toContain(binding.goalId);
    expect(serializedIds).not.toContain(binding.milestoneId);
    expect(serializedIds).not.toContain(binding.projectPath);

    for (const request of requests) {
      expect(decision.providerQuota.claimNext()).toBe(request.dispatchId);
    }
    expect(() => decision.providerQuota.claimNext()).toThrowError(
      expect.objectContaining({
        name: 'GoalConductorQuotaRefusal',
        message: 'goal-conductor-provider-ticket-cap-exhausted',
      }),
    );
  });

  it.each(['unlimited', 'invalid', 'duplicate', 'conflict', 'exhausted', 'unavailable', 'capacity'])(
    'refuses %s quota authority without creating a claim session',
    (kind) => {
      mockReserveFleetQuotaUses.mockReturnValue({ kind, launchAuthorized: false });
      expect(reserveGoalConductorProviderQuota(config, binding)).toEqual({
        launchAuthorized: false,
        reason: `goal-conductor-provider-quota-${kind}`,
      });
    },
  );

  it('refuses unlimited and malformed success receipts fail-closed', () => {
    mockReserveFleetQuotaUses.mockReturnValueOnce({
      kind: 'unlimited',
      launchAuthorized: true,
      reservations: Array.from({ length: 13 }, () => ({
        backend: 'builtin', status: 'unlimited', used: 0, limit: null,
      })),
    });
    expect(reserveGoalConductorProviderQuota(config, binding)).toEqual({
      launchAuthorized: false,
      reason: 'goal-conductor-provider-quota-unlimited',
    });

    mockReserveFleetQuotaUses.mockReturnValueOnce({
      kind: 'reserved', launchAuthorized: true, reservations: reservedReceipts().slice(0, 12),
    });
    expect(reserveGoalConductorProviderQuota(config, binding)).toEqual({
      launchAuthorized: false,
      reason: 'goal-conductor-provider-quota-receipt-invalid',
    });
  });

  it('domain-separates attempt identity across exact target bindings', () => {
    const first = reserveGoalConductorProviderQuota(config, binding);
    const second = reserveGoalConductorProviderQuota(config, {
      ...binding,
      milestoneId: 'different-milestone',
    });
    expect(first.launchAuthorized && second.launchAuthorized).toBe(true);
    if (!first.launchAuthorized || !second.launchAuthorized) return;
    expect(first.attemptId).not.toBe(second.attemptId);
  });

  it('strictly binds claims to the configured quota window boundary', () => {
    const now = Date.parse('2026-08-16T22:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const decision = reserveGoalConductorProviderQuota({
        ...config,
        foundry: { ...config.foundry, limits: { builtin: { window: '1m', max: 100 } } },
      }, binding);
      expect(decision.launchAuthorized).toBe(true);
      if (!decision.launchAuthorized) return;

      nowSpy.mockReturnValue(now + 59_999);
      expect(decision.providerQuota.claimNext()).toBe(`${decision.attemptId}.provider.00`);
      nowSpy.mockReturnValue(now + 60_000);
      expect(() => decision.providerQuota.claimNext()).toThrowError(
        expect.objectContaining({ message: 'goal-conductor-provider-ticket-session-expired' }),
      );
      // Expiry is latched: a backward wall-clock jump cannot reopen authority.
      nowSpy.mockReturnValue(now + 1);
      expect(() => decision.providerQuota.claimNext()).toThrowError(
        expect.objectContaining({ message: 'goal-conductor-provider-ticket-session-expired' }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('refuses an absent or non-closed quota window before reservation', () => {
    const invalid = {
      ...config,
      foundry: { ...config.foundry, limits: { builtin: { window: '2h', max: 100 } } },
    } as AshlrConfig;
    expect(reserveGoalConductorProviderQuota(invalid, binding)).toEqual({
      launchAuthorized: false,
      reason: 'goal-conductor-provider-quota-window-invalid',
    });
    expect(mockReserveFleetQuotaUses).not.toHaveBeenCalled();
  });
});

describe('M517 provider-contact claim boundary', () => {
  it('rethrows a typed planner quota refusal instead of using the default-plan fallback', async () => {
    const providerQuota: ProviderInferenceQuotaSession = {
      attemptId: `goal-attempt-${'b'.repeat(64)}`,
      claimNext: () => {
        throw new GoalConductorQuotaRefusal('goal-conductor-provider-ticket-cap-exhausted');
      },
    };
    await expect(planSwarm({ goal: 'bounded work' }, config, undefined, providerQuota, 50_000))
      .rejects.toMatchObject({
        name: 'GoalConductorQuotaRefusal',
        message: 'goal-conductor-provider-ticket-cap-exhausted',
      });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('bounds the signed planner request and admits only exact in-bound usage', async () => {
    const providerQuota: ProviderInferenceQuotaSession = {
      attemptId: `goal-attempt-${'c'.repeat(64)}`,
      claimNext: vi.fn(() => 'opaque-ticket'),
    };
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({
        scaffold: [{ goal: 'Set up' }],
        build: [{ goal: 'Implement A' }, { goal: 'Implement B' }],
        integrate: [{ goal: 'Integrate' }],
        verify: [{ goal: 'Verify' }],
        review: [{ goal: 'Review' }],
      }),
      usage: { tokensIn: 100, tokensOut: 200 },
      usageKnown: true,
    });

    const plan = await planSwarm(
      { goal: 'bounded signed work' },
      config,
      undefined,
      providerQuota,
      50_000,
    );
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(providerQuota.claimNext).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0]?.[3]).toEqual({ maxOutputTokens: 4_096 });
  });

  it('refuses an ungoverned signed planner before claiming or provider contact', async () => {
    const providerQuota: ProviderInferenceQuotaSession = {
      attemptId: `goal-attempt-${'d'.repeat(64)}`,
      claimNext: vi.fn(() => 'opaque-ticket'),
    };
    mockGetActiveClient.mockResolvedValueOnce({
      id: 'plugin-provider', supportsTools: false, chat: (...args: unknown[]) => mockChat(...args),
    });
    await expect(planSwarm(
      { goal: 'ungoverned signed work' }, config, undefined, providerQuota, 50_000,
    )).rejects.toMatchObject({
      name: 'GoalConductorQuotaRefusal',
      message: 'goal-conductor-signed-planner-provider-ungoverned',
    });
    expect(providerQuota.claimNext).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it.each([
    [{ tokensIn: 1, tokensOut: 1 }, undefined],
    [{ tokensIn: 1, tokensOut: 5_000 }, true],
  ])('refuses unknown or out-of-bound signed planner usage before execution', async (usage, usageKnown) => {
    const providerQuota: ProviderInferenceQuotaSession = {
      attemptId: `goal-attempt-${'e'.repeat(64)}`,
      claimNext: vi.fn(() => 'opaque-ticket'),
    };
    mockChat.mockResolvedValueOnce({
      content: '{"scaffold":[{"goal":"would otherwise execute"}]}',
      usage,
      ...(usageKnown === true ? { usageKnown: true } : {}),
    });
    await expect(planSwarm(
      { goal: 'invalid usage' }, config, undefined, providerQuota, 50_000,
    )).rejects.toMatchObject({
      name: 'GoalConductorQuotaRefusal',
      message: 'goal-conductor-signed-planner-usage-invalid',
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('refuses expired planner authority before provider contact', async () => {
    const now = Date.parse('2026-08-16T23:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const decision = reserveGoalConductorProviderQuota({
        ...config,
        foundry: { ...config.foundry, limits: { builtin: { window: '1m', max: 100 } } },
      }, binding);
      expect(decision.launchAuthorized).toBe(true);
      if (!decision.launchAuthorized) return;
      nowSpy.mockReturnValue(now + 60_000);
      await expect(planSwarm(
        { goal: 'expired signed work' }, config, undefined, decision.providerQuota, 50_000,
      )).rejects.toMatchObject({
        name: 'GoalConductorQuotaRefusal',
        message: 'goal-conductor-provider-ticket-session-expired',
      });
      expect(mockChat).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('never converts signed provider or parse failures into a default plan', async () => {
    const providerQuota = (): ProviderInferenceQuotaSession => ({
      attemptId: `goal-attempt-${'f'.repeat(64)}`,
      claimNext: vi.fn(() => 'opaque-ticket'),
    });
    mockChat.mockRejectedValueOnce(new Error('signed provider unavailable'));
    await expect(planSwarm(
      { goal: 'provider failure' }, config, undefined, providerQuota(), 50_000,
    )).rejects.toMatchObject({
      message: 'goal-conductor-signed-planner-provider-failed',
    });

    mockChat.mockResolvedValueOnce({
      content: 'not a valid plan',
      usage: { tokensIn: 10, tokensOut: 10 },
      usageKnown: true,
    });
    await expect(planSwarm(
      { goal: 'parse failure' }, config, undefined, providerQuota(), 50_000,
    )).rejects.toMatchObject({
      message: 'goal-conductor-signed-planner-output-invalid',
    });
  });

  it('preserves ordinary planner fallback when no signed quota session exists', async () => {
    mockChat.mockRejectedValueOnce(new Error('ordinary provider unavailable'));
    const plan = await planSwarm({ goal: 'ordinary work' }, config);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(plan.goal).toBe('ordinary work');
    expect(plan.tasks.length).toBeGreaterThan(0);
  });
});
