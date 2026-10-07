/**
 * 3.15 — Telegram `/task <owner/repo> <text>`: parsed in the slash-command
 * switch and handed to the automations engine (mocked here — its routing is
 * covered in automations-dispatch-315). The reply is what the engine says;
 * a malformed command gets usage, and an engine failure never crashes the cycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ receiveTelegramTask: vi.fn() }));
vi.mock('../src/core/automations/engine.js', () => engine);

import { setTelegramSendClockForTests, setTelegramTransportForTests, type InboundEvent } from '../src/core/integrations/telegram.js';
import { handleSlashCommand, TELEGRAM_HELP_TEXT } from '../src/core/comms/telegram-channel.js';
import type { AshlrConfig } from '../src/core/types.js';

const sent: string[] = [];
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-315', chatId: '4242' } } } as AshlrConfig;
const event = (text: string): InboundEvent => ({ kind: 'text', text, fromChatId: '4242', messageId: 7 });

let telegramNow = 0;

beforeEach(() => {
  telegramNow = 0;
  // Exercise actual-attempt pacing with a virtual monotonic clock, not a
  // fake-transport bypass or larger timeout.
  setTelegramSendClockForTests({
    now: () => telegramNow,
    sleep: async (ms) => { telegramNow += ms; },
  });
  sent.length = 0;
  engine.receiveTelegramTask.mockReset();
  setTelegramTransportForTests(async (method, body) => {
    if (method === 'sendMessage') sent.push(String(body['text']));
    return { ok: true, result: { message_id: 1 } };
  });
});
afterEach(() => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
});

describe('/task', () => {
  it('hands repo + text to the automations engine and replies with its answer', async () => {
    engine.receiveTelegramTask.mockResolvedValue({ ok: true, message: 'Sent to the cloud lane: Fix login' });
    const text = '/task acme/app Fix login\nit 500s';
    expect(await handleSlashCommand(event(text), text, cfg)).toBe(true);
    expect(engine.receiveTelegramTask).toHaveBeenCalledWith('acme/app', 'Fix login\nit 500s');
    expect(sent).toEqual(['Sent to the cloud lane: Fix login']);
  });

  it('answers usage for a malformed command without calling the engine', async () => {
    await handleSlashCommand(event('/task fix it'), '/task fix it', cfg);
    expect(engine.receiveTelegramTask).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Usage: \/task &lt;owner\/repo&gt;/);
  });

  it('survives an engine failure', async () => {
    engine.receiveTelegramTask.mockRejectedValue(new Error('disk full'));
    await handleSlashCommand(event('/task acme/app go'), '/task acme/app go', cfg);
    expect(sent[0]).toMatch(/Could not hand that over/);
  });

  it('is listed in /help', () => {
    expect(TELEGRAM_HELP_TEXT).toMatch(/\/task <owner\/repo>/);
    expect(TELEGRAM_HELP_TEXT).toContain('Talk to Phantom’s Leader:');
  });
});
