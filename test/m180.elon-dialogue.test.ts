/**
 * M180 — Elon strategic dialogue DISPATCH integration tests.
 *
 * Tests that runCommsCycle routes correctly:
 *   - Free-form text → handleStrategicMessage + reply sent back
 *   - Numbered reply to outstanding request → resolves (not hijacked)
 *   - Button tap (callback) to outstanding request → resolves (not hijacked)
 *   - Foreign chatId → ignored (pollTelegramUpdates returns nothing)
 *   - No outstanding + free-form text → routes to dialogue
 *
 * handleStrategicMessage is mocked here (unit tests live in m180.elon-unit.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  mockSendTelegramMessage,
  mockPollTelegramUpdates,
  mockAnswerCallbackQuery,
  mockTelegramEnabled,
  mockHandleStrategicMessage,
} = vi.hoisted(() => ({
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockPollTelegramUpdates: vi.fn().mockResolvedValue({ updates: [], newOffset: 0 }),
  mockAnswerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  mockTelegramEnabled: vi.fn().mockReturnValue(true),
  mockHandleStrategicMessage: vi.fn().mockResolvedValue('Elon reply'),
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  pollTelegramUpdates: mockPollTelegramUpdates,
  answerCallbackQuery: mockAnswerCallbackQuery,
  telegramEnabled: mockTelegramEnabled,
}));

vi.mock('../src/core/comms/elon-dialogue.js', () => ({
  handleStrategicMessage: mockHandleStrategicMessage,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: unknown): boolean => {
      if (typeof p === 'string' && p.endsWith('chat.db')) return true;
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string, _args: string[], _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => { cb(null, '', ''); return {} as ReturnType<typeof actual.execFile>; },
  };
});

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

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm180d-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockPollTelegramUpdates.mockResolvedValue({ updates: [], newOffset: 0 });
  mockTelegramEnabled.mockReturnValue(true);
  mockHandleStrategicMessage.mockResolvedValue('Elon reply');
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { postRequest, outstanding } from '../src/core/comms/requests.js';

describe('M180 dispatch.ts Telegram routing integration', () => {

  it('routes free-form text to handleStrategicMessage and sends the reply back', async () => {
    mockHandleStrategicMessage.mockResolvedValue('Bold move. Creating goal now.');
    mockPollTelegramUpdates.mockResolvedValue({
      updates: [{ kind: 'text', text: 'what should we ship next?', fromChatId: '42' }],
      newOffset: 1,
    });

    await runCommsCycle(makeCfg() as never);

    expect(mockHandleStrategicMessage).toHaveBeenCalledWith(
      'what should we ship next?',
      expect.objectContaining({ comms: expect.objectContaining({ channel: 'telegram' }) }),
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      'Bold move. Creating goal now.',
      undefined,
      expect.anything(),
    );
  });

  it('resolves numbered reply to outstanding request without routing to dialogue', async () => {
    postRequest({ kind: 'test-kind', type: 'question', text: 'Approve?', options: ['Yes', 'No'] });

    mockPollTelegramUpdates.mockResolvedValueOnce({ updates: [], newOffset: 0 });
    await runCommsCycle(makeCfg() as never);

    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: '1', fromChatId: '42' }],
      newOffset: 1,
    });
    const result = await runCommsCycle(makeCfg() as never);

    expect(result.resolved).toBe(1);
    expect(mockHandleStrategicMessage).not.toHaveBeenCalled();
  });

  it('resolves button tap (callback) to outstanding request without routing to dialogue', async () => {
    postRequest({ kind: 'test-kind', type: 'question', text: 'Approve?', options: ['Yes', 'No'] });

    mockPollTelegramUpdates.mockResolvedValueOnce({ updates: [], newOffset: 0 });
    await runCommsCycle(makeCfg() as never);

    const out = outstanding();
    expect(out).toBeDefined();

    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{
        kind: 'callback',
        requestId: out!.id,
        optionIndex: 0,
        fromChatId: '42',
        callbackQueryId: 'cq1',
      }],
      newOffset: 2,
    });
    const result2 = await runCommsCycle(makeCfg() as never);

    expect(result2.resolved).toBe(1);
    expect(mockHandleStrategicMessage).not.toHaveBeenCalled();
    expect(mockAnswerCallbackQuery).toHaveBeenCalledWith('cq1', expect.anything());
  });

  it('does not call handleStrategicMessage when pollTelegramUpdates returns no updates', async () => {
    mockPollTelegramUpdates.mockResolvedValue({ updates: [], newOffset: 1 });
    await runCommsCycle(makeCfg() as never);
    expect(mockHandleStrategicMessage).not.toHaveBeenCalled();
  });

  it('routes free-form text to dialogue even when no outstanding request exists', async () => {
    mockHandleStrategicMessage.mockResolvedValue('Here is my assessment.');
    mockPollTelegramUpdates.mockResolvedValue({
      updates: [{ kind: 'text', text: 'Tell me the strategy', fromChatId: '42' }],
      newOffset: 1,
    });

    const result = await runCommsCycle(makeCfg() as never);

    expect(mockHandleStrategicMessage).toHaveBeenCalledWith('Tell me the strategy', expect.anything());
    expect(mockSendTelegramMessage).toHaveBeenCalledWith('Here is my assessment.', undefined, expect.anything());
    expect(result.resolved).toBe(0);
  });
});
