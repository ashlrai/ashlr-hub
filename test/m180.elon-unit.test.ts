/**
 * M180 — handleStrategicMessage unit tests.
 *
 * Tests the real implementation (no elon-dialogue mock).
 * External dependencies mocked: engines, goals store, strategist, fetch (Ollama path).
 *
 * Test counts (5):
 *   1. free-form text → Opus complete called → reply returned
 *   2. direction message → createGoal called
 *   3. never-throws — engine crash returns safe fallback string
 *   4. secrets scrubbed from reply
 *   5. only createGoal touched; sendTelegramMessage NOT called (separation of concerns)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  mockEngineInstalled,
  mockBuildEngineCommand,
  mockSpawnEngine,
  mockCreateGoal,
  mockCreateGoalIfAbsent,
  mockLoadGoal,
  mockSaveGoal,
  mockListGoals,
  mockLoadLatestBriefing,
  mockSendTelegramMessage,
} = vi.hoisted(() => ({
  mockEngineInstalled: vi.fn().mockReturnValue(false),
  mockBuildEngineCommand: vi.fn().mockReturnValue(null),
  mockSpawnEngine: vi.fn().mockReturnValue({ ok: false, output: '' }),
  mockCreateGoal: vi.fn().mockImplementation((objective: string) => ({
    id: 'test-goal-abc123',
    objective,
    status: 'planning',
    milestones: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project: null,
  })),
  mockCreateGoalIfAbsent: vi.fn().mockImplementation((objective: string) => ({
    status: 'created',
    goal: {
      id: 'test-goal-abc123', objective, status: 'planning', milestones: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: null,
    },
  })),
  mockLoadGoal: vi.fn().mockReturnValue(null),
  mockSaveGoal: vi.fn(),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockLoadLatestBriefing: vi.fn().mockReturnValue(null),
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: mockEngineInstalled,
  buildEngineCommand: mockBuildEngineCommand,
  spawnEngine: mockSpawnEngine,
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: mockCreateGoal,
  createGoalIfAbsent: mockCreateGoalIfAbsent,
  loadGoal: mockLoadGoal,
  saveGoal: mockSaveGoal,
  listGoals: mockListGoals,
  goalsDir: () => join(process.env['HOME'] ?? tmpdir(), '.ashlr', 'goals'),
}));

vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: mockLoadLatestBriefing,
  runStrategist: vi.fn(),
  adoptBriefing: vi.fn(),
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  pollTelegramUpdates: vi.fn().mockResolvedValue({ updates: [], newOffset: 0 }),
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  telegramEnabled: vi.fn().mockReturnValue(true),
}));

let tmpHome: string;
const origHome = process.env['HOME'];

function makeCfg() {
  return {
    comms: {
      enabled: true,
      channel: 'telegram' as const,
      telegram: { botToken: 'test-bot-token', chatId: '42' },
    },
    foundry: {},
  };
}

function mockFetchDialogue(reply: string, action: Record<string, unknown> = { type: 'none' }) {
  const body = JSON.stringify({ reply, action });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: body } }] }),
  }));
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm180u-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockEngineInstalled.mockReturnValue(false);
  mockListGoals.mockReturnValue([]);
  mockLoadLatestBriefing.mockReturnValue(null);
  mockSaveGoal.mockReturnValue(true);
  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockCreateGoal.mockImplementation((objective: string) => ({
    id: 'test-goal-abc123', objective, status: 'planning',
    milestones: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: null,
  }));
  mockCreateGoalIfAbsent.mockImplementation((objective: string) => ({
    status: 'created',
    goal: {
      id: 'test-goal-abc123', objective, status: 'planning', milestones: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: null,
    },
  }));
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

import { handleStrategicMessage } from '../src/core/comms/elon-dialogue.js';

describe('M180 handleStrategicMessage unit', () => {

  // Test 1: free-form text → Opus complete → reply returned
  it('returns the Opus reply for a free-form question', async () => {
    mockFetchDialogue('The fleet has 3 active goals focused on M180 dialogue.');

    const reply = await handleStrategicMessage('What is the fleet focused on?', makeCfg() as never);

    expect(reply).toContain('fleet');
    expect(reply).toBeTruthy();
  });

  // Test 2: direction message → createGoal called
  it('calls createGoal when Opus returns a create_goal action', async () => {
    const body = JSON.stringify({
      reply: 'Got it. Creating a goal to ship the billing module.',
      action: { type: 'create_goal', objective: 'Ship billing module v1', rationale: 'Unblocks revenue' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: body } }] }),
    }));

    await handleStrategicMessage('Focus on shipping the billing module', makeCfg() as never);

    expect(mockCreateGoalIfAbsent).toHaveBeenCalledWith(
      'Ship billing module v1',
      expect.objectContaining({ cfg: expect.anything() }),
    );
  });

  // Test 3: never-throws — engine crash → safe fallback
  it('returns a safe fallback string when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const reply = await handleStrategicMessage('Hello', makeCfg() as never);

    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  // Test 4: secrets scrubbed
  it('scrubs token-like secrets from the Opus reply', async () => {
    const tokenLike = 'ghp_abcdef1234567890abcdef1234567890abcdef';
    mockFetchDialogue(`Here is your answer. Token: ${tokenLike}`);

    const reply = await handleStrategicMessage('show me something', makeCfg() as never);

    expect(reply).not.toContain(tokenLike);
  });

  // Test 5: handleStrategicMessage returns string; never calls sendTelegramMessage
  it('returns a reply string and does NOT call sendTelegramMessage (dispatch sends it)', async () => {
    const body = JSON.stringify({
      reply: 'Understood. Goal created.',
      action: { type: 'create_goal', objective: 'Refactor auth module', rationale: 'Maintainability' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: body } }] }),
    }));

    const reply = await handleStrategicMessage('Refactor the auth module', makeCfg() as never);

    expect(mockCreateGoalIfAbsent).toHaveBeenCalled();
    expect(typeof reply).toBe('string');
    // handleStrategicMessage itself never sends — that's dispatch's job
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it('reports a priority action refusal when CAS persistence fails', async () => {
    mockLoadGoal.mockReturnValue({
      id: 'goal-concurrent', objective: 'Preserve steering', status: 'active',
      milestones: [], createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', project: null,
    });
    mockSaveGoal.mockReturnValue(false);
    mockFetchDialogue('I will update that priority.', {
      type: 'update_goal_priority', goalId: 'goal-concurrent', newPriority: 'Critical',
    });

    const reply = await handleStrategicMessage('Make it critical', makeCfg() as never);

    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    expect(reply).toContain('Action refused:');
    expect(reply).not.toContain('priority updated');
  });

  it('does not claim creation when the deterministic goal already exists', async () => {
    mockCreateGoalIfAbsent.mockReturnValue({
      status: 'exists',
      goal: {
        id: 'goal-existing', objective: 'Existing direction', status: 'active', milestones: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        project: null,
      },
    });
    mockFetchDialogue('I will create that goal.', {
      type: 'create_goal', objective: 'Existing direction',
    });

    const reply = await handleStrategicMessage('Create the existing direction', makeCfg() as never);

    expect(reply).toContain('Action refused: goal already exists: goal-existing');
    expect(mockCreateGoal).not.toHaveBeenCalled();
  });
});
