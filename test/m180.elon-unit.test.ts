/**
 * M180 → 3.14 — handleStrategicMessage delegates to the ONE Leader brain.
 *
 * Tests the real implementation (no elon-dialogue mock) with the Leader
 * thread mocked. Since 3.14 the free-form Telegram path:
 *   1. hands the text to appendMasonMessage (channel 'telegram', the caller's cfg)
 *      and returns the Leader's reply;
 *   2. marks the thread's queued Telegram copy delivered (dispatch sends the
 *      returned text itself — the outbound drain must not send it twice);
 *   3. scrubs secrets from the reply;
 *   4. never throws (thread failure → a safe sentence);
 *   5. has NO side effects of its own: no engine call, no goal creation, no
 *      stale Strategist briefing, no Telegram send;
 *   6. keeps the deterministic `status` fast path (no thread, no model).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  mockAppendMasonMessage,
  mockMarkDelivered,
  mockSpawnEngine,
  mockCreateGoalIfAbsent,
  mockListGoals,
  mockLoadLatestBriefing,
  mockSendTelegramMessage,
} = vi.hoisted(() => ({
  mockAppendMasonMessage: vi.fn(),
  mockMarkDelivered: vi.fn().mockReturnValue(true),
  mockSpawnEngine: vi.fn(),
  mockCreateGoalIfAbsent: vi.fn(),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockLoadLatestBriefing: vi.fn().mockReturnValue(null),
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../src/core/vision/leader-thread.js', () => ({
  appendMasonMessage: mockAppendMasonMessage,
  markDelivered: mockMarkDelivered,
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn().mockReturnValue(true),
  buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: [] }),
  spawnEngine: mockSpawnEngine,
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoalIfAbsent: mockCreateGoalIfAbsent,
  createGoal: vi.fn(),
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
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

import { handleStrategicMessage } from '../src/core/comms/elon-dialogue.js';

let tmpHome: string;
const origHome = process.env['HOME'];

function makeCfg() {
  return {
    comms: { enabled: true, channel: 'telegram' as const, telegram: { botToken: 'test-bot-token', chatId: '42' } },
    foundry: {},
  };
}

function threadReply(text: string) {
  return {
    message: { id: 'lt-20260926120000-aaaaaa', at: '2026-09-26T12:00:00.000Z', from: 'mason', channel: 'telegram', kind: 'message', text: 'q' },
    reply: { id: 'lt-20260926120001-bbbbbb', at: '2026-09-26T12:00:01.000Z', from: 'leader', channel: 'telegram', kind: 'message', text, delivery: { telegram: 'pending' } },
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm180u-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockMarkDelivered.mockReturnValue(true);
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('M180 handleStrategicMessage → the Leader thread (3.14)', () => {
  it('hands free-form text to appendMasonMessage and returns the Leader reply', async () => {
    mockAppendMasonMessage.mockResolvedValue(threadReply('One bottleneck: review latency. Kill the rest.'));
    const cfg = makeCfg();
    const reply = await handleStrategicMessage('What is the fleet focused on?', cfg as never);
    expect(reply).toBe('One bottleneck: review latency. Kill the rest.');
    expect(mockAppendMasonMessage).toHaveBeenCalledWith('What is the fleet focused on?', { channel: 'telegram', cfg });
  });

  it('marks the queued Telegram copy delivered, because dispatch sends the returned text itself', async () => {
    mockAppendMasonMessage.mockResolvedValue(threadReply('Noted.'));
    await handleStrategicMessage('Focus on shipping the billing module', makeCfg() as never);
    expect(mockMarkDelivered).toHaveBeenCalledWith('lt-20260926120001-bbbbbb', 'telegram', true);
  });

  it('scrubs secrets from the reply', async () => {
    mockAppendMasonMessage.mockResolvedValue(threadReply('Use sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789 now'));
    const reply = await handleStrategicMessage('Which key?', makeCfg() as never);
    expect(reply).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789');
  });

  it('never throws: a thread failure returns a safe sentence', async () => {
    mockAppendMasonMessage.mockRejectedValue(new Error('disk full'));
    const reply = await handleStrategicMessage('Hello', makeCfg() as never);
    expect(typeof reply).toBe('string');
    expect(reply).toMatch(/could not take your message/);
  });

  it('has no side effects of its own: no engine, no goal, no stale briefing, no Telegram send', async () => {
    mockAppendMasonMessage.mockResolvedValue(threadReply('I cannot create goals from a chat; my next memo will weigh it.'));
    await handleStrategicMessage('Create a goal to refactor the auth module', makeCfg() as never);
    expect(mockSpawnEngine).not.toHaveBeenCalled();
    expect(mockCreateGoalIfAbsent).not.toHaveBeenCalled();
    expect(mockLoadLatestBriefing).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it('keeps the deterministic status fast path (no thread, no model)', async () => {
    const reply = await handleStrategicMessage('status', makeCfg() as never);
    expect(reply).toMatch(/^Fleet status:/);
    expect(mockAppendMasonMessage).not.toHaveBeenCalled();
    expect(mockSpawnEngine).not.toHaveBeenCalled();
  });

  it('returns an empty string when the thread produced no reply', async () => {
    mockAppendMasonMessage.mockResolvedValue({ ...threadReply('x'), reply: null });
    expect(await handleStrategicMessage('ok', makeCfg() as never)).toBe('');
    expect(mockMarkDelivered).not.toHaveBeenCalled();
  });
});
