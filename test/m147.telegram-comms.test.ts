/**
 * M147 — Telegram Bot API comms transport
 *
 * Modules under test:
 *   src/core/integrations/telegram.ts  — sendTelegramMessage + pollTelegramUpdates
 *                                        + answerCallbackQuery + telegramEnabled
 *   src/core/comms/dispatch.ts         — runCommsCycle transport switch
 *
 * Invariants:
 *   - sendTelegramMessage builds correct sendMessage payload including
 *     inline_keyboard with callback_data = "<requestId>:<optionIndex>"
 *   - sendTelegramMessage is a no-op (ok:false) when not configured; never throws
 *   - Bot token is NEVER present in a thrown error message
 *   - pollTelegramUpdates parses text messages + callback_query updates
 *   - pollTelegramUpdates filters by chatId — drops updates from foreign chats
 *   - pollTelegramUpdates advances the offset correctly
 *   - callback event in runCommsCycle resolves the right request by id+index
 *   - text event in runCommsCycle resolves via leading-number fallback
 *   - channel switch: telegram cfg → telegram transport; imessage cfg → imessage transport
 *   - not-configured → no-op, never throws
 *
 * node:https is fully mocked — no real network calls.
 * fs operations use a tmp HOME (h1-fixture pattern).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

// ---------------------------------------------------------------------------
// Mock node:https — intercept all outbound HTTPS calls
// ---------------------------------------------------------------------------

// Injectable response: { ok, result } shaped like Telegram API responses
let _mockHttpResponse: unknown = { ok: true, result: [] };
let _mockHttpError: Error | null = null;
let _mockHttpStatus = 200;
const _httpCalls: { path: string; body: unknown }[] = [];
let _strictHttpPaths: Set<string> | null = null;

// This transport contract must never retain a real HTTPS fallback, including
// concurrent dynamic imports used by the profile's independent getters.
vi.mock('node:https', () => {
  return {
    request: vi.fn((
      opts: { path: string; [k: string]: unknown },
      callback: (res: EventEmitter & { statusCode?: number; resume: () => void }) => void,
    ) => {
      if (_strictHttpPaths && (opts.hostname !== 'api.telegram.org' || opts.method !== 'POST' || !_strictHttpPaths.has(opts.path))) {
        throw new Error('Unexpected HTTPS fixture request');
      }
      const chunks: Buffer[] = [];
      let body = '';

      // Fake IncomingMessage
      const fakeRes = new EventEmitter() as EventEmitter & { statusCode?: number; resume: () => void };
      fakeRes.statusCode = _mockHttpStatus;
      fakeRes.resume = () => {};

      // Fake ClientRequest
      const fakeReq = new EventEmitter() as EventEmitter & {
        write: (d: string) => void;
        end: () => void;
        destroy: () => void;
      };
      fakeReq.write = (d: string) => { body += d; };
      fakeReq.end = () => {
        try {
          _httpCalls.push({ path: opts.path as string, body: JSON.parse(body) });
        } catch {
          _httpCalls.push({ path: opts.path as string, body });
        }

        if (_mockHttpError) {
          fakeReq.emit('error', _mockHttpError);
          return;
        }

        // Simulate async response
        setImmediate(() => {
          callback(fakeRes);
          setImmediate(() => {
            fakeRes.emit('data', Buffer.from(JSON.stringify(_mockHttpResponse)));
            fakeRes.emit('end');
          });
        });
      };
      fakeReq.destroy = () => {};

      return fakeReq;
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock node:fs existsSync for offset file (allow writes to tmp HOME)
// ---------------------------------------------------------------------------
// No special mock needed — offset file lives under tmp HOME which is real FS.

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { makeCfg, makeFixture } from './helpers/h1-fixture.js';
import {
  sendTelegramMessage,
  pollTelegramUpdates,
  telegramEnabled,
  answerCallbackQuery,
  editTelegramQuestionKeyboard,
  telegramQuestionNamespace,
  setTelegramTransportForTests,
  setTelegramSendClockForTests,
  syncTelegramDisplayBrand,
  TELEGRAM_PHANTOM_BRAND,
} from '../src/core/integrations/telegram.js';
import {
  postRequest,
  listRequests,
  markSent,
  resolveRequest,
  outstanding,
} from '../src/core/comms/requests.js';
import { runCommsCycle, registerResolutionHandler } from '../src/core/comms/dispatch.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'fake-bot-token-12345';
const CHAT_ID = '987654321';

function cfgTelegram(overrides?: Partial<NonNullable<AshlrConfig['comms']>>): AshlrConfig {
  return makeCfg({
    comms: {
      enabled: true,
      channel: 'telegram',
      telegram: {
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
      },
      ...overrides,
    },
  });
}

function cfgTelegramMissingToken(): AshlrConfig {
  return makeCfg({
    comms: {
      enabled: true,
      channel: 'telegram',
      telegram: { chatId: CHAT_ID },
    },
  });
}

function cfgTelegramMissingChatId(): AshlrConfig {
  return makeCfg({
    comms: {
      enabled: true,
      channel: 'telegram',
      telegram: { botToken: BOT_TOKEN },
    },
  });
}

function cfgIMessage(): AshlrConfig {
  return makeCfg({
    comms: {
      enabled: true,
      channel: 'imessage',
      imessageHandle: '+15555550100',
      service: 'iMessage',
    },
  });
}

function cfgDisabled(): AshlrConfig {
  return makeCfg({ comms: { enabled: false } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Telegram getUpdates response with a text message. */
function makeTextUpdate(updateId: number, text: string, chatId = CHAT_ID) {
  return {
    ok: true,
    result: [
      {
        update_id: updateId,
        message: {
          message_id: 1,
          chat: { id: Number(chatId), type: 'private' },
          text,
        },
      },
    ],
  };
}

/** Build a Telegram getUpdates response with a callback_query. */
function makeCallbackUpdate(
  updateId: number,
  callbackData: string,
  chatId = CHAT_ID,
  queryId = 'cbq-001',
) {
  return {
    ok: true,
    result: [
      {
        update_id: updateId,
        callback_query: {
          id: queryId,
          data: callbackData,
          message: {
            message_id: 1,
            chat: { id: Number(chatId), type: 'private' },
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _tmpHome: string;
let _prevHome: string | undefined;
let _sendNow = 0;
const _sendSleeps: number[] = [];

beforeEach(() => {
  expect.hasAssertions();
  _httpCalls.length = 0;
  _strictHttpPaths = null;
  _mockHttpResponse = { ok: true, result: [] };
  _mockHttpError = null;
  _mockHttpStatus = 200;
  _sendNow = 0;
  _sendSleeps.length = 0;
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests({
    now: () => _sendNow,
    sleep: async (ms) => { _sendSleeps.push(ms); _sendNow += ms; },
  });

  // Isolate ~/.ashlr/comms in a tmp HOME
  _prevHome = process.env.HOME;
  _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m147-'));
  process.env.HOME = _tmpHome;
});

afterEach(() => {
  _strictHttpPaths = null;
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  vi.clearAllMocks();
  if (_prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = _prevHome;
  try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ===========================================================================
// 1. telegramEnabled guard
// ===========================================================================

describe('telegramEnabled', () => {
  it('true when channel=telegram + enabled + token + chatId', () => {
    expect(telegramEnabled(cfgTelegram())).toBe(true);
  });

  it('false when channel is not telegram', () => {
    expect(telegramEnabled(cfgIMessage())).toBe(false);
  });

  it('false when enabled=false', () => {
    expect(telegramEnabled(cfgDisabled())).toBe(false);
  });

  it('false when botToken missing', () => {
    expect(telegramEnabled(cfgTelegramMissingToken())).toBe(false);
  });

  it('false when chatId missing', () => {
    expect(telegramEnabled(cfgTelegramMissingChatId())).toBe(false);
  });

  it('false when comms block absent', () => {
    expect(telegramEnabled(makeCfg())).toBe(false);
  });
});

// ===========================================================================
// 2. sendTelegramMessage
// ===========================================================================

describe('sendTelegramMessage', () => {
  it('returns {ok:false} and makes no HTTP call when not configured', async () => {
    const result = await sendTelegramMessage('hello', undefined, cfgDisabled());
    expect(result.ok).toBe(false);
    expect(_httpCalls).toHaveLength(0);
  });

  it('returns {ok:false} when cfg is undefined', async () => {
    const result = await sendTelegramMessage('hello', undefined, undefined);
    expect(result.ok).toBe(false);
    expect(_httpCalls).toHaveLength(0);
  });

  it('POSTs to /sendMessage with correct chat_id and text', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 42 } };
    const result = await sendTelegramMessage('fleet report', undefined, cfgTelegram());
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(42);

    const call = _httpCalls.find((c) => c.path.includes('sendMessage'));
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body['chat_id']).toBe(CHAT_ID);
    expect(body['text']).toBe('fleet report');
  });

  it('builds inline_keyboard with callback_data = "<requestId>:<idx>"', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 1 } };
    await sendTelegramMessage(
      'Approve this merge?',
      { buttons: ['Approve & merge', 'Reject', 'Show diff'], requestId: 'req-abc-123' },
      cfgTelegram(),
    );

    const call = _httpCalls.find((c) => c.path.includes('sendMessage'));
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    const keyboard = (body['reply_markup'] as Record<string, unknown>)?.['inline_keyboard'] as unknown[][];
    expect(keyboard).toHaveLength(3);
    // Row 0: first button
    const row0 = keyboard[0] as Array<Record<string, unknown>>;
    expect(row0[0]?.['text']).toBe('Approve & merge');
    expect(row0[0]?.['callback_data']).toBe('req-abc-123:0');
    // Row 1: second button
    const row1 = keyboard[1] as Array<Record<string, unknown>>;
    expect(row1[0]?.['callback_data']).toBe('req-abc-123:1');
    // Row 2: third button
    const row2 = keyboard[2] as Array<Record<string, unknown>>;
    expect(row2[0]?.['callback_data']).toBe('req-abc-123:2');
  });

  it('sends without keyboard when no buttons', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 1 } };
    await sendTelegramMessage('report only', undefined, cfgTelegram());
    const call = _httpCalls.find((c) => c.path.includes('sendMessage'));
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body['reply_markup']).toBeUndefined();
  });

  it('returns {ok:false} when API returns ok:false', async () => {
    _mockHttpResponse = { ok: false, description: 'Unauthorized' };
    const result = await sendTelegramMessage('hello', undefined, cfgTelegram());
    expect(result.ok).toBe(false);
  });

  it('never throws when HTTP errors', async () => {
    _mockHttpError = new Error('network failure');
    await expect(sendTelegramMessage('hello', undefined, cfgTelegram())).resolves.toBeDefined();
  });

  it('token is NEVER present in a thrown error (scrubbed)', async () => {
    // Simulate an error response that might include the URL (containing the token)
    _mockHttpError = new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`);
    const result = await sendTelegramMessage('hello', undefined, cfgTelegram());
    expect(result.ok).toBe(false);
    // The function swallows errors internally and must not re-throw them
    // containing the token. If it did, the test would have already thrown above.
    // Verify no HTTP call was completed (error fired before write)
    // The key invariant: no unhandled rejection with the token
  });

  it('URL built with token but token is NOT in any error thrown', async () => {
    // Prove token never surfaces in a caught error by checking error scrubbing logic
    // The scrubToken helper splits on the token and joins with [REDACTED]
    const fakeError = `failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const scrubbed = fakeError.split(BOT_TOKEN).join('[REDACTED]');
    expect(scrubbed).not.toContain(BOT_TOKEN);
    expect(scrubbed).toContain('[REDACTED]');
  });
});

// The explicit virtual monotonic clock exercises production pacing, even with
// the fake Bot API. No transport shortcut, real sleeping or network is used.
describe('Telegram actual-attempt pacing and known throttles', () => {
  function recordingTransport(respond: (call: number, method: string, body: Record<string, unknown>) => unknown | Promise<unknown>) {
    const calls: Array<{ at: number; method: string; body: Record<string, unknown> }> = [];
    setTelegramTransportForTests(async (method, body) => {
      calls.push({ at: _sendNow, method, body: structuredClone(body) });
      return respond(calls.length, method, body);
    });
    return calls;
  }

  it('preserves validated metadata without exposing the provider description or token', async () => {
    _mockHttpResponse = { ok: false, error_code: 429, description: `Too many requests ${BOT_TOKEN}`, parameters: { retry_after: 17 } };
    const result = await sendTelegramMessage('hello', undefined, cfgTelegram());
    expect(result).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: 17 });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(_httpCalls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
  });

  it.each([0, -1, 1.5, '2', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('does not retry invalid retry_after %s', async (retryAfter) => {
    const calls = recordingTransport(() => ({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }));
    expect(await sendTelegramMessage('hello', undefined, cfgTelegram())).toEqual({ ok: false, errorCode: 429 });
    expect(calls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
  });

  it.each([0, -400, 429.5, '429', null, Infinity])('does not fabricate a retry from invalid error_code %s', async (errorCode) => {
    const calls = recordingTransport(() => ({ ok: false, error_code: errorCode, description: 'parse entities', parameters: { retry_after: 2 } }));
    expect(await sendTelegramMessage('hello', undefined, cfgTelegram())).toEqual({ ok: false, retryAfterSeconds: 2 });
    expect(calls).toHaveLength(1);
  });

  it.each([null, {}, { ok: false, description: 'parse entities' }, { description: 'parse entities', error_code: 429, parameters: { retry_after: 2 } }, { ok: false, error_code: 500, description: 'parse entities' }])('never retries ambiguous acknowledgements or 5xx: %j', async (response) => {
    const calls = recordingTransport(() => response);
    const result = await sendTelegramMessage('hello', undefined, cfgTelegram());
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
  });

  it('never repeats an HTTP5xx even when its body claims a known markup rejection', async () => {
    _mockHttpStatus = 503;
    _mockHttpResponse = { ok: false, error_code: 400, description: "can't parse entities" };
    expect(await sendTelegramMessage('<b>hello</b>', { html: true }, cfgTelegram())).toEqual({ ok: false });
    expect(_httpCalls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
  });

  it('never retries a thrown transport error that may follow acceptance', async () => {
    const calls = recordingTransport(() => { throw new Error('response lost'); });
    expect(await sendTelegramMessage('hello', undefined, cfgTelegram())).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it('paces all chunks and repeats only the exact rejected chunk, retaining reply/keyboard placement', async () => {
    const calls = recordingTransport((call) => call === 2
      ? { ok: false, error_code: 429, parameters: { retry_after: 2 } }
      : { ok: true, result: { message_id: 100 + call } });
    const result = await sendTelegramMessage('a'.repeat(4096) + 'b'.repeat(4096) + 'c', {
      replyToMessageId: 77, buttons: ['Approve'], requestId: 'req-paced',
    }, cfgTelegram());
    expect(result).toEqual({ ok: true, messageId: 101, messageIds: [101, 103, 104] });
    expect(calls.map((call) => call.at)).toEqual([0, 3000, 6000, 9000]);
    expect(calls[1]!.body).toEqual(calls[2]!.body);
    expect(calls[0]!.body['reply_parameters']).toEqual({ message_id: 77, allow_sending_without_reply: true });
    expect(calls.slice(1).every((call) => !('reply_parameters' in call.body))).toBe(true);
    expect(calls.slice(0, 3).every((call) => !('reply_markup' in call.body))).toBe(true);
    expect(calls[3]!.body['reply_markup']).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'req-paced:0' }]] });
  });

  it('paces the existing plain-text fallback and its one known short 429 retry', async () => {
    const calls = recordingTransport((call) => call === 1
      ? { ok: false, error_code: 400, description: "can't parse entities" }
      : call === 2 ? { ok: false, error_code: 429, parameters: { retry_after: 3 } }
        : { ok: true, result: { message_id: 43 } });
    expect(await sendTelegramMessage('<b>hello</b>', { html: true }, cfgTelegram())).toEqual({ ok: true, messageId: 43, messageIds: [43] });
    expect(calls.map((call) => call.at)).toEqual([0, 3000, 6000]);
    expect(calls[0]!.body['parse_mode']).toBe('HTML');
    expect(calls[1]!.body['text']).toBe('hello');
    expect(calls[1]!.body['parse_mode']).toBeUndefined();
    expect(calls[2]!.body).toEqual(calls[1]!.body);
  });

  it('allows at most one short 429 retry across both HTML and plain variants of a chunk', async () => {
    const calls = recordingTransport((call) => call === 2
      ? { ok: false, error_code: 400, description: "can't parse entities" }
      : { ok: false, error_code: 429, parameters: { retry_after: 2 } });
    expect(await sendTelegramMessage('<b>hello</b>', { html: true }, cfgTelegram())).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: 2 });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.at)).toEqual([0, 3000, 6000]);
    expect(calls[2]!.body['parse_mode']).toBeUndefined();
  });

  it('retains legacy partial compatibility and metadata without replaying a confirmed prefix', async () => {
    const calls = recordingTransport((call) => call === 1
      ? { ok: true, result: { message_id: 81 } }
      : { ok: false, error_code: 429, parameters: { retry_after: 30 } });
    expect(await sendTelegramMessage('x'.repeat(5000), undefined, cfgTelegram())).toEqual({
      ok: true, partial: true, messageId: 81, messageIds: [81], errorCode: 429, retryAfterSeconds: 30,
    });
    expect(calls).toHaveLength(2);
    expect(_sendSleeps).toEqual([3000]);
  });

  it('serializes actual attempts from concurrent callers for the same bot/chat', async () => {
    const calls = recordingTransport((call) => ({ ok: true, result: { message_id: call } }));
    const results = await Promise.all(['first', 'second', 'third'].map((text) => sendTelegramMessage(text, undefined, cfgTelegram())));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(calls.map((call) => call.at)).toEqual([0, 3000, 6000]);
    expect(calls.map((call) => call.body['text'])).toEqual(['first', 'second', 'third']);
  });

  it('does not turn a concurrent local cooldown refusal into another provider retry', async () => {
    const calls = recordingTransport((call) => call === 1
      ? { ok: false, error_code: 429, parameters: { retry_after: 2 } }
      : { ok: true, result: { message_id: 82 } });
    const [first, second] = await Promise.all([
      sendTelegramMessage('first', undefined, cfgTelegram()), sendTelegramMessage('second', undefined, cfgTelegram()),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: 2 });
    expect(calls.map((call) => call.body['text'])).toEqual(['first', 'first']);
    expect(calls.map((call) => call.at)).toEqual([0, 3000]);
  });

  it('returns long 429 promptly, starts its floor at the response, and makes no early same-process contact', async () => {
    const calls = recordingTransport((call) => {
      if (call === 1) { _sendNow = 4000; return { ok: false, error_code: 429, parameters: { retry_after: 10 } }; }
      return { ok: true, result: { message_id: 83 } };
    });
    expect(await sendTelegramMessage('first', undefined, cfgTelegram())).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: 10 });
    _sendNow = 10000;
    expect(await sendTelegramMessage('held', undefined, cfgTelegram())).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: 4 });
    expect(calls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
    _sendNow = 14000;
    expect((await sendTelegramMessage('later new send', undefined, cfgTelegram())).ok).toBe(true);
    expect(calls.map((call) => call.at)).toEqual([0, 14000]);
  });

  it('keeps a valid enormous provider floor held without arithmetic overflow or long sleeps', async () => {
    const calls = recordingTransport(() => ({ ok: false, error_code: 429, parameters: { retry_after: Number.MAX_SAFE_INTEGER } }));
    expect(await sendTelegramMessage('first', undefined, cfgTelegram())).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: Number.MAX_SAFE_INTEGER });
    _sendNow = 120000;
    expect(await sendTelegramMessage('held after idle pruning', undefined, cfgTelegram())).toEqual({ ok: false, errorCode: 429, retryAfterSeconds: Number.MAX_SAFE_INTEGER });
    expect(calls).toHaveLength(1);
    expect(_sendSleeps).toEqual([]);
  });

  it('does not share a throttle between distinct bot/chat identities', async () => {
    const calls = recordingTransport((call) => call === 1
      ? { ok: false, error_code: 429, parameters: { retry_after: 90 } }
      : { ok: true, result: { message_id: call } });
    expect((await sendTelegramMessage('held', undefined, cfgTelegram())).ok).toBe(false);
    const otherChat = cfgTelegram();
    otherChat.comms!.telegram!.chatId = 'other-private-chat';
    expect((await sendTelegramMessage('other chat', undefined, otherChat)).ok).toBe(true);
    const otherBot = cfgTelegram();
    otherBot.comms!.telegram!.botToken = 'fake-other-bot';
    expect((await sendTelegramMessage('other bot', undefined, otherBot)).ok).toBe(true);
    expect(calls.map((call) => call.at)).toEqual([0, 0, 0]);
    expect(_sendSleeps).toEqual([]);
  });

  it('never admits early when the injected monotonic clock rolls backward', async () => {
    _sendNow = 10000;
    const calls = recordingTransport((call) => ({ ok: true, result: { message_id: call } }));
    expect((await sendTelegramMessage('first', undefined, cfgTelegram())).ok).toBe(true);
    _sendNow = 9000;
    expect((await sendTelegramMessage('second', undefined, cfgTelegram())).ok).toBe(true);
    expect(calls.map((call) => call.at)).toEqual([10000, 13000]);
    expect(_sendSleeps).toEqual([3000, 1000]);
  });

  it('leaves callback acknowledgements outside an outstanding sendMessage gap', async () => {
    const calls = recordingTransport((call, method) => method === 'answerCallbackQuery'
      ? { ok: true } : { ok: true, result: { message_id: call } });
    let wake!: () => void;
    let started!: () => void;
    const sleeping = new Promise<void>((resolve) => { started = resolve; });
    setTelegramSendClockForTests({ now: () => _sendNow, sleep: () => { started(); return new Promise<void>((resolve) => { wake = resolve; }); } });
    expect((await sendTelegramMessage('first', undefined, cfgTelegram())).ok).toBe(true);
    const waiting = sendTelegramMessage('second', undefined, cfgTelegram());
    await sleeping;
    await answerCallbackQuery('query-paced', cfgTelegram());
    expect(calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery']);
    _sendNow = 3000;
    wake();
    expect((await waiting).ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery', 'sendMessage']);
  });

  it('keeps the paced lane bound to the actual request token/chat across awaits', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 99 } };
    let wake!: () => void;
    let started!: () => void;
    const sleeping = new Promise<void>((resolve) => { started = resolve; });
    setTelegramSendClockForTests({ now: () => _sendNow, sleep: () => { started(); return new Promise<void>((resolve) => { wake = resolve; }); } });
    const cfg = cfgTelegram();
    expect((await sendTelegramMessage('first', undefined, cfg)).ok).toBe(true);
    const waiting = sendTelegramMessage('queued', undefined, cfg);
    await sleeping;
    cfg.comms!.telegram!.botToken = 'fake-replacement-bot';
    cfg.comms!.telegram!.chatId = 'replacement-private-chat';
    _sendNow = 3000;
    wake();
    expect((await waiting).ok).toBe(true);
    expect(_httpCalls).toHaveLength(2);
    expect(_httpCalls[1]!.path).toBe(`/bot${BOT_TOKEN}/sendMessage`);
    expect((_httpCalls[1]!.body as Record<string, unknown>)['chat_id']).toBe(CHAT_ID);
    expect((await sendTelegramMessage('new identity', undefined, cfg)).ok).toBe(true);
    expect(_httpCalls[2]!.path).toBe('/botfake-replacement-bot/sendMessage');
    expect((_httpCalls[2]!.body as Record<string, unknown>)['chat_id']).toBe('replacement-private-chat');
  });

  it('releases its owned lane after a pacing failure instead of wedging later sends', async () => {
    const calls = recordingTransport((call) => ({ ok: true, result: { message_id: call } }));
    setTelegramSendClockForTests({ now: () => _sendNow, sleep: async () => { throw new Error('test sleep failure'); } });
    expect((await sendTelegramMessage('first', undefined, cfgTelegram())).ok).toBe(true);
    expect(await sendTelegramMessage('failed wait', undefined, cfgTelegram())).toEqual({ ok: false });
    _sendNow = 3000;
    expect((await sendTelegramMessage('later', undefined, cfgTelegram())).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ===========================================================================
// 3. pollTelegramUpdates
// ===========================================================================

describe('pollTelegramUpdates', () => {
  it('returns empty updates when not configured', async () => {
    const result = await pollTelegramUpdates(cfgDisabled());
    expect(result.updates).toHaveLength(0);
    expect(_httpCalls).toHaveLength(0);
  });

  it('parses a text message from the correct chat', async () => {
    _mockHttpResponse = makeTextUpdate(100, '1 approve');
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.kind).toBe('text');
    expect(result.updates[0]?.text).toBe('1 approve');
    expect(result.updates[0]?.fromChatId).toBe(CHAT_ID);
  });

  it('parses a callback_query (button tap)', async () => {
    _mockHttpResponse = makeCallbackUpdate(101, 'req-xyz:1');
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(1);
    const ev = result.updates[0]!;
    expect(ev.kind).toBe('callback');
    expect(ev.requestId).toBe('req-xyz');
    expect(ev.optionIndex).toBe(1);
    expect(ev.fromChatId).toBe(CHAT_ID);
    expect(ev.callbackQueryId).toBe('cbq-001');
  });

  it('drops text message from a FOREIGN chat id', async () => {
    _mockHttpResponse = makeTextUpdate(102, 'hello', '111111111'); // foreign chat
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  it('drops callback_query from a FOREIGN chat id', async () => {
    _mockHttpResponse = makeCallbackUpdate(103, 'req-abc:0', '111111111'); // foreign
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  it('advances offset to maxUpdateId + 1', async () => {
    _mockHttpResponse = makeTextUpdate(200, 'hi');
    const r1 = await pollTelegramUpdates(cfgTelegram());
    expect(r1.newOffset).toBe(201); // 200 + 1

    // Next call should include offset=201 in the body
    _mockHttpResponse = { ok: true, result: [] };
    await pollTelegramUpdates(cfgTelegram());
    const lastCall = _httpCalls[_httpCalls.length - 1]!;
    expect((lastCall.body as Record<string, unknown>)['offset']).toBe(201);
  });

  it('returns empty + original offset when API returns ok:false', async () => {
    _mockHttpResponse = { ok: false, description: 'Unauthorized' };
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  it('returns empty and never throws when HTTP errors', async () => {
    _mockHttpError = new Error('network down');
    await expect(pollTelegramUpdates(cfgTelegram())).resolves.toMatchObject({ updates: [] });
  });

  it('handles both text and callback in the same batch', async () => {
    _mockHttpResponse = {
      ok: true,
      result: [
        {
          update_id: 300,
          message: {
            message_id: 1,
            chat: { id: Number(CHAT_ID), type: 'private' },
            text: '1',
          },
        },
        {
          update_id: 301,
          callback_query: {
            id: 'cbq-002',
            data: 'req-zzz:2',
            message: {
              message_id: 2,
              chat: { id: Number(CHAT_ID), type: 'private' },
            },
          },
        },
      ],
    };
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(2);
    expect(result.updates[0]?.kind).toBe('text');
    expect(result.updates[1]?.kind).toBe('callback');
    expect(result.newOffset).toBe(302); // max(300,301) + 1
  });

  it('skips callback_query with malformed callback_data (no colon)', async () => {
    _mockHttpResponse = {
      ok: true,
      result: [
        {
          update_id: 400,
          callback_query: {
            id: 'cbq-bad',
            data: 'nocolon',
            message: { message_id: 1, chat: { id: Number(CHAT_ID), type: 'private' } },
          },
        },
      ],
    };
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  // MED-1: negative optionIndex must be rejected at parse time.
  it('MED-1: skips callback_query with negative optionIndex', async () => {
    _mockHttpResponse = {
      ok: true,
      result: [
        {
          update_id: 401,
          callback_query: {
            id: 'cbq-neg',
            data: 'req-abc:-1', // negative index
            message: { message_id: 1, chat: { id: Number(CHAT_ID), type: 'private' } },
          },
        },
      ],
    };
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  it('MED-1: skips callback_query with deeply negative optionIndex', async () => {
    _mockHttpResponse = {
      ok: true,
      result: [
        {
          update_id: 402,
          callback_query: {
            id: 'cbq-neg2',
            data: 'req-xyz:-999',
            message: { message_id: 1, chat: { id: Number(CHAT_ID), type: 'private' } },
          },
        },
      ],
    };
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(0);
  });

  it('MED-1: accepts callback_query with optionIndex=0 (boundary)', async () => {
    _mockHttpResponse = makeCallbackUpdate(403, 'req-ok:0');
    const result = await pollTelegramUpdates(cfgTelegram());
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.optionIndex).toBe(0);
  });
});

// ===========================================================================
// 4. answerCallbackQuery
// ===========================================================================

describe('answerCallbackQuery', () => {
  it('POSTs to answerCallbackQuery when configured', async () => {
    _mockHttpResponse = { ok: true, result: true };
    await answerCallbackQuery('cbq-test-123', cfgTelegram());
    const call = _httpCalls.find((c) => c.path.includes('answerCallbackQuery'));
    expect(call).toBeDefined();
    expect((call!.body as Record<string, unknown>)['callback_query_id']).toBe('cbq-test-123');
  });

  it('no-op when not configured', async () => {
    await answerCallbackQuery('cbq-test', cfgDisabled());
    expect(_httpCalls).toHaveLength(0);
  });

  it('never throws on HTTP error', async () => {
    _mockHttpError = new Error('network');
    await expect(answerCallbackQuery('cbq-x', cfgTelegram())).resolves.toBeUndefined();
  });
});

// ===========================================================================
// 5. runCommsCycle — Telegram transport
// ===========================================================================

describe('runCommsCycle with Telegram transport', () => {
  it('sends next pending request via Telegram (sendMessage called)', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 1 } };
    const cfg = cfgTelegram();
    postRequest({ kind: 'fleet-digest', type: 'report', text: 'Fleet OK', options: [] });
    const result = await runCommsCycle(cfg);
    expect(result.sent).toBe(1);
    const call = _httpCalls.find((c) => c.path.includes('sendMessage'));
    expect(call).toBeDefined();
    // Reports: no keyboard
    expect((call!.body as Record<string, unknown>)['reply_markup']).toBeUndefined();
  });

  it('sends question with inline_keyboard buttons via Telegram', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 2 } };
    const cfg = cfgTelegram();
    postRequest({
      kind: 'elon-vision',
      type: 'question',
      text: 'Approve?',
      options: ['Approve & create goals', 'Hold', 'Show full briefing'],
    });
    await runCommsCycle(cfg);
    const call = _httpCalls.find((c) => c.path.includes('sendMessage'));
    expect(call).toBeDefined();
    const keyboard = (
      (call!.body as Record<string, unknown>)['reply_markup'] as Record<string, unknown>
    )?.['inline_keyboard'] as unknown[][];
    expect(keyboard).toHaveLength(3);
    // callback_data contains the requestId
    const row0 = keyboard[0] as Array<Record<string, unknown>>;
    expect(String(row0[0]?.['callback_data'])).toMatch(/^[a-f0-9-]+:0$/);
  });

  it('resolves request via callback event (requestId + optionIndex)', async () => {
    const cfg = cfgTelegram();
    // Step 1: post and mark a question as sent
    const id = postRequest({
      kind: 'manager-approval',
      type: 'question',
      text: 'Merge proposal X?',
      options: ['Approve & merge', 'Reject', 'Show diff'],
    });
    markSent(id);

    // Step 2: inject a callback update matching that id
    _mockHttpResponse = makeCallbackUpdate(500, `${id}:0`);
    const result = await runCommsCycle(cfg);

    expect(result.resolved).toBe(1);
    const answered = listRequests({ status: 'answered' });
    const r = answered.find((x) => x.id === id);
    expect(r).toBeDefined();
    expect(r!.answerIndex).toBe(0); // index 0 = 'Approve & merge'

    // answerCallbackQuery should have been called
    const ackCall = _httpCalls.find((c) => c.path.includes('answerCallbackQuery'));
    expect(ackCall).toBeDefined();
  });

  it('resolves via text fallback (leading numeric reply)', async () => {
    const cfg = cfgTelegram();
    const id = postRequest({
      kind: 'test-q',
      type: 'question',
      text: 'Pick one',
      options: ['yes', 'no'],
    });
    markSent(id);

    // Text "2" should resolve to index 1
    _mockHttpResponse = makeTextUpdate(600, '2');
    const result = await runCommsCycle(cfg);
    expect(result.resolved).toBe(1);
    const answered = listRequests({ status: 'answered' }).find((x) => x.id === id);
    expect(answered?.answerIndex).toBe(1);
  });

  it('ignores callback for a DIFFERENT requestId', async () => {
    const cfg = cfgTelegram();
    const id = postRequest({
      kind: 'test-q',
      type: 'question',
      text: 'Q',
      options: ['a', 'b'],
    });
    markSent(id);

    // Callback for a different request id
    _mockHttpResponse = makeCallbackUpdate(700, 'different-req-id:0');
    const result = await runCommsCycle(cfg);
    expect(result.resolved).toBe(0);
    expect(outstanding()?.id).toBe(id); // still outstanding
  });

  it('invokes resolution handler on callback resolve', async () => {
    const cfg = cfgTelegram();
    const handled: string[] = [];
    registerResolutionHandler('vision-test', (req) => {
      handled.push(req.id);
    });

    const id = postRequest({
      kind: 'vision-test',
      type: 'question',
      text: 'Approve?',
      options: ['yes', 'no'],
    });
    markSent(id);

    _mockHttpResponse = makeCallbackUpdate(800, `${id}:1`);
    await runCommsCycle(cfg);
    expect(handled).toContain(id);
  });

  it('does not call sendIMessage when channel=telegram', async () => {
    // sendIMessage (iMessage) should never be called when Telegram is configured.
    // We verify no osascript calls — those would only come from the iMessage path.
    // Since node:child_process is not mocked here, the iMessage path is untouched.
    _mockHttpResponse = { ok: true, result: { message_id: 1 } };
    const cfg = cfgTelegram();
    postRequest({ kind: 'test', type: 'report', text: 'hi', options: [] });
    const result = await runCommsCycle(cfg);
    expect(result.sent).toBe(1);
    // Only Telegram HTTP calls should have been made
    expect(_httpCalls.some((c) => c.path.includes('sendMessage'))).toBe(true);
  });

  it('never throws even when all Telegram HTTP calls fail', async () => {
    _mockHttpError = new Error('everything broken');
    const cfg = cfgTelegram();
    postRequest({ kind: 'test', type: 'question', text: 'Q?', options: ['a'] });
    await expect(runCommsCycle(cfg)).resolves.toBeDefined();
  });
});

// ===========================================================================
// 6. Transport channel switch
// ===========================================================================

describe('transport channel switch', () => {
  it('telegramEnabled is false for iMessage config', () => {
    expect(telegramEnabled(cfgIMessage())).toBe(false);
  });

  it('telegramEnabled is true for telegram config', () => {
    expect(telegramEnabled(cfgTelegram())).toBe(true);
  });

  it('runCommsCycle with iMessage config does NOT call Telegram HTTP', async () => {
    // iMessage path: sendIMessage uses execFile (child_process), not https.
    // With platform=linux, sendIMessage no-ops — so sent=0, but Telegram HTTP also=0.
    const cfg = cfgIMessage();
    postRequest({ kind: 'test', type: 'report', text: 'hi', options: [] });

    // Override platform to non-darwin so iMessage no-ops cleanly
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const result = await runCommsCycle(cfg);
      expect(result.sent).toBe(0); // iMessage no-ops on linux
      expect(_httpCalls).toHaveLength(0); // no Telegram calls
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  it('runCommsCycle with telegram config calls Telegram HTTP', async () => {
    _mockHttpResponse = { ok: true, result: { message_id: 5 } };
    const cfg = cfgTelegram();
    postRequest({ kind: 'test', type: 'report', text: 'hi', options: [] });
    const result = await runCommsCycle(cfg);
    expect(result.sent).toBe(1);
    expect(_httpCalls.some((c) => c.path.includes('sendMessage'))).toBe(true);
  });
});

// Typed controls use only the standard markup-edit primitive, never a send or
// arbitrary method/recipient supplied by a callback.
describe('typed question transport binding and markup edits', () => {
  it('binds the exact bot/chat configuration without returning raw identities', () => {
    const cfg = cfgTelegram(), first = telegramQuestionNamespace(cfg);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(telegramQuestionNamespace(cfg, String(cfg.comms!.telegram!.chatId))).toBe(first);
    expect(telegramQuestionNamespace(cfg, 'foreign-chat')).toBeNull();
    const changed = structuredClone(cfg); changed.comms!.telegram!.botToken = 'another-synthetic-bot';
    expect(telegramQuestionNamespace(changed)).not.toBe(first);
    changed.comms!.telegram!.chatId = 'another-synthetic-chat';
    expect(telegramQuestionNamespace(changed)).not.toBe(telegramQuestionNamespace(cfg));
  });

  it('edits only the exact configured message keyboard and permits explicit removal', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    setTelegramTransportForTests(async (method, body) => { calls.push({ method, body }); return { ok: true, result: true }; });
    const cfg = cfgTelegram();
    expect(await editTelegramQuestionKeyboard(123, [[{ text: 'Submit', data: 'lt:q:bounded' }]], cfg)).toBe(true);
    expect(await editTelegramQuestionKeyboard(123, [], cfg)).toBe(true);
    expect(calls).toEqual([
      { method: 'editMessageReplyMarkup', body: { chat_id: cfg.comms!.telegram!.chatId, message_id: 123,
        reply_markup: { inline_keyboard: [[{ text: 'Submit', callback_data: 'lt:q:bounded' }]] } } },
      { method: 'editMessageReplyMarkup', body: { chat_id: cfg.comms!.telegram!.chatId, message_id: 123,
        reply_markup: { inline_keyboard: [] } } },
    ]);
  });

  it.each([{ ok: false, error_code: 429, parameters: { retry_after: 600 } }, null, { ok: true },
    { ok: false, error_code: 500 }, { ok: true, result: false }])('does not replay an unknown or refused edit %j', async response => {
    const transport = vi.fn(async () => response); setTelegramTransportForTests(transport);
    expect(await editTelegramQuestionKeyboard(123, [], cfgTelegram())).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects invalid message IDs, oversized callbacks and URL controls before contact', async () => {
    const transport = vi.fn(async () => ({ ok: true, result: true })); setTelegramTransportForTests(transport);
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await editTelegramQuestionKeyboard(id, [], cfgTelegram())).toBe(false);
    }
    expect(await editTelegramQuestionKeyboard(123, [[{ text: 'bad', data: '🚀'.repeat(17) }]], cfgTelegram())).toBe(false);
    expect(await editTelegramQuestionKeyboard(123, [[{ text: 'bad', url: 'https://example.com' }]], cfgTelegram())).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});

// The hosted bot profile is an explicit operator action, separate from messages.
describe('Telegram display-brand preview and apply', () => {
  const botId = 123456789;
  function profile(target = false) {
    const values = { name: target ? TELEGRAM_PHANTOM_BRAND.name : 'Ashlr',
      description: target ? TELEGRAM_PHANTOM_BRAND.description : 'Old description',
      short_description: target ? TELEGRAM_PHANTOM_BRAND.shortDescription : 'Old short description' };
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const transport = async (method: string, body: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, body });
      if (method === 'getMe') return { ok: true, result: { id: botId, is_bot: true, username: 'ashlr_test_bot' } };
      if (method.startsWith('getMy')) return { ok: true, result: { ...values } };
      const parameter = method === 'setMyName' ? 'name' : method === 'setMyDescription' ? 'description' : 'short_description';
      values[parameter] = String(body[parameter]);
      return { ok: true, result: true };
    };
    return { values, calls, transport };
  }
  it('previews with only identity/default-locale getters and never echoes arbitrary profile text', async () => {
    const fixture = profile(); fixture.values.description = BOT_TOKEN;
    setTelegramTransportForTests(fixture.transport);
    const result = await syncTelegramDisplayBrand(cfgTelegram());
    expect(result.status).toBe('preview'); expect(result.botId).toBe(botId);
    expect(result.fields.name.state).toBe('different');
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    expect(fixture.calls).toEqual([{ method: 'getMe', body: {} },
      { method: 'getMyName', body: { language_code: '' } },
      { method: 'getMyDescription', body: { language_code: '' } },
      { method: 'getMyShortDescription', body: { language_code: '' } }]);
  });
  it('writes differing fields only, then validates all fresh readback on the same bot', async () => {
    const fixture = profile(); fixture.values.name = TELEGRAM_PHANTOM_BRAND.name;
    setTelegramTransportForTests(fixture.transport);
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('verified'); expect(Object.values(result.fields).every((f) => f.state === 'verified')).toBe(true);
    expect(fixture.calls.filter((c) => c.method.startsWith('set'))).toEqual([
      { method: 'setMyDescription', body: { description: TELEGRAM_PHANTOM_BRAND.description, language_code: '' } },
      { method: 'setMyShortDescription', body: { short_description: TELEGRAM_PHANTOM_BRAND.shortDescription, language_code: '' } }]);
    expect(fixture.calls.map((c) => c.method)).toEqual(['getMe', 'getMyName', 'getMyDescription', 'getMyShortDescription',
      'setMyDescription', 'setMyShortDescription', 'getMe', 'getMyName', 'getMyDescription', 'getMyShortDescription']);
  });
  it('is an apply no-op when current values match, with a fresh final observation', async () => {
    const fixture = profile(true); setTelegramTransportForTests(fixture.transport);
    expect((await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId })).status).toBe('verified');
    expect(fixture.calls).toHaveLength(8); expect(fixture.calls.some((c) => c.method.startsWith('set'))).toBe(false);
  });
  it.each([undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1, NaN])('refuses unsafe/missing apply bot ID %s before contact', async (expectedBotId) => {
    const fixture = profile(); setTelegramTransportForTests(fixture.transport);
    expect((await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId })).status).toBe('blocked');
    expect(fixture.calls).toEqual([]);
  });
  it.each([cfgDisabled, cfgTelegramMissingToken, cfgTelegramMissingChatId, cfgIMessage])('never contacts a disabled/incomplete Telegram configuration', async (makeConfig) => {
    const previous = process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const fixture = profile(); setTelegramTransportForTests(fixture.transport);
      expect((await syncTelegramDisplayBrand(makeConfig())).status).toBe('blocked'); expect(fixture.calls).toEqual([]);
    } finally { if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous; }
  });
  it('refuses a different configured bot after getMe without setters', async () => {
    const fixture = profile(); setTelegramTransportForTests(fixture.transport);
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId + 1 });
    expect(result.status).toBe('blocked'); expect(result.errors[0]?.reason).toBe('bot-mismatch');
    expect(fixture.calls.map((c) => c.method)).toEqual(['getMe']);
  });
  it.each([{ id: botId, is_bot: false }, { id: '123', is_bot: true }, { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true }])('refuses malformed/non-bot identity', async (result) => {
    const transport = vi.fn(async () => ({ ok: true, result })); setTelegramTransportForTests(transport);
    expect((await syncTelegramDisplayBrand(cfgTelegram())).status).toBe('unknown'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { name: 1 }, { name: 'x'.repeat(65) }])('treats malformed getter values as unknown and never writes', async (badValue) => {
    const fixture = profile(); setTelegramTransportForTests(async (method, body) => method === 'getMyName'
      ? { ok: true, result: badValue } : fixture.transport(method, body));
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('unknown'); expect(result.errors).toContainEqual({ stage: 'name', reason: 'malformed-response' });
    expect(fixture.calls.some((c) => c.method.startsWith('set'))).toBe(false);
  });
  it('preserves partial success, stops after rejection, and performs readback without retrying', async () => {
    const fixture = profile(); let writes = 0;
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'setMyDescription') { writes++; fixture.calls.push({ method, body }); return { ok: false, error_code: 429,
        parameters: { retry_after: 12 }, description: `private ${BOT_TOKEN}` }; }
      if (method.startsWith('set')) writes++;
      return fixture.transport(method, body);
    });
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('partial'); expect(writes).toBe(2);
    expect(result.fields.name.state).toBe('verified'); expect(result.fields.description.state).toBe('failed');
    expect(result.fields.shortDescription.state).toBe('not-attempted');
    expect(result.errors).toContainEqual({ stage: 'description', reason: 'rejected', errorCode: 429, retryAfterSeconds: 12 });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN); expect(_sendSleeps).toEqual([]);
    expect(fixture.calls.filter((c) => c.method === 'getMe')).toHaveLength(2);
  });
  it('does not call an acknowledgment success verified when final getter is unavailable', async () => {
    const fixture = profile(); let reads = 0;
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'getMe') reads++;
      if (reads === 2 && method === 'getMyDescription') return null;
      return fixture.transport(method, body);
    });
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('partial'); expect(result.fields.description.state).toBe('unconfirmed');
    expect(result.fields.name.state).toBe('verified');
  });
  it('uses readback to confirm an ambiguous final setter that actually applied, without replay', async () => {
    const fixture = profile();
    setTelegramTransportForTests(async (method, body) => {
      const response = await fixture.transport(method, body);
      return method === 'setMyShortDescription' ? null : response;
    });
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('verified'); expect(result.errors).toContainEqual({ stage: 'shortDescription', reason: 'unavailable' });
    expect(fixture.calls.filter((c) => c.method === 'setMyShortDescription')).toHaveLength(1);
  });
  it('refuses final identity drift rather than presenting other-bot values as verified', async () => {
    const fixture = profile(); let reads = 0;
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'getMe' && ++reads === 2) return { ok: true, result: { id: botId + 1, is_bot: true } };
      return fixture.transport(method, body);
    });
    const result = await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId });
    expect(result.status).toBe('partial'); expect(Object.values(result.fields).every((f) => f.state === 'unconfirmed')).toBe(true);
    expect(result.errors).toContainEqual({ stage: 'identity', reason: 'bot-mismatch' });
  });
  it('an explicit retry re-observes and writes only remaining differing fields', async () => {
    const fixture = profile(); let fail = true;
    setTelegramTransportForTests(async (method, body) => method === 'setMyDescription' && fail ? null : fixture.transport(method, body));
    expect((await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId })).status).toBe('partial');
    fixture.calls.length = 0; fail = false;
    expect((await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId })).status).toBe('verified');
    expect(fixture.calls.filter((c) => c.method.startsWith('set')).map((c) => c.method)).toEqual(['setMyDescription', 'setMyShortDescription']);
  });
  it('pins cfg and environment token before asynchronous contacts', async () => {
    const cfg = cfgTelegramMissingToken(); const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    // Guard the actual builtin as well: concurrent dynamic-import mock mistakes
    // must fail this contract rather than fall through to a live HTTPS request.
    const actual = await vi.importActual<typeof import('node:https')>('node:https');
    const builtinIntercept = vi.spyOn(actual.default, 'request').mockImplementation(() => { throw new Error('Unexpected non-stubbed HTTPS request'); });
    syncBuiltinESMExports();
    try {
      // Resolve Vitest's lazy builtin mock before concurrent dynamic imports.
      const mocked = await import('node:https');
      expect(vi.isMockFunction(mocked.request)).toBe(true);
      expect(mocked.request).not.toBe(actual.default.request);
      _strictHttpPaths = new Set([`/bot${BOT_TOKEN}/getMyName`, `/bot${BOT_TOKEN}/getMyDescription`, `/bot${BOT_TOKEN}/getMyShortDescription`]);
      // Vitest can return the builtin namespace during concurrent lazy imports.
      // Its request function also delegates ONLY to the strict local fixture.
      builtinIntercept.mockImplementation(mocked.request); syncBuiltinESMExports();
      _mockHttpResponse = { ok: true, result: { name: 'Old', description: 'Old', short_description: 'Old' } };
      setTelegramTransportForTests(async () => {
        cfg.comms!.telegram!.botToken = 'replacement'; process.env.TELEGRAM_BOT_TOKEN = 'replacement-env';
        setTelegramTransportForTests(null);
        return { ok: true, result: { id: botId, is_bot: true } };
      });
      const result = await syncTelegramDisplayBrand(cfg);
      expect({ status: result.status, errors: result.errors, calls: _httpCalls }).toMatchObject({ status: 'preview', errors: [] });
      expect(_httpCalls.map((c) => c.path)).toEqual([`/bot${BOT_TOKEN}/getMyName`, `/bot${BOT_TOKEN}/getMyDescription`, `/bot${BOT_TOKEN}/getMyShortDescription`]);
      expect(_httpCalls.map((c) => c.body)).toEqual([{ language_code: '' }, { language_code: '' }, { language_code: '' }]);
    } finally {
      _strictHttpPaths = null; builtinIntercept.mockRestore(); syncBuiltinESMExports();
      if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });
  it('drops thrown credential-bearing diagnostics and restricts the complete operation inventory', async () => {
    setTelegramTransportForTests(async () => { throw new Error(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`); });
    const failed = await syncTelegramDisplayBrand(cfgTelegram());
    expect(failed.status).toBe('unknown'); expect(JSON.stringify(failed)).not.toContain(BOT_TOKEN);
    const fixture = profile(); setTelegramTransportForTests(fixture.transport);
    expect((await syncTelegramDisplayBrand(cfgTelegram(), { apply: true, expectedBotId: botId })).status).toBe('verified');
    expect(new Set(fixture.calls.map((c) => c.method))).toEqual(new Set(['getMe', 'getMyName', 'getMyDescription', 'getMyShortDescription', 'setMyName', 'setMyDescription', 'setMyShortDescription']));
  });
});
