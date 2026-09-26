/**
 * 3.14 — Telegram becomes a real two-way line to the Leader.
 *
 * Modules under test (real, end to end through the transport):
 *   src/core/integrations/telegram.ts + telegram-format.ts  — escaping, splitting, threading fields
 *   src/core/comms/dispatch.ts            — informational vs question slot, pacing, inbound routing
 *   src/core/comms/telegram-channel.ts    — Leader-thread drain, replies, buttons, /commands
 *   src/core/comms/telegram-thread-map.ts — message_id ↔ thread mapping
 *   src/core/comms/migrations.ts          — one-time queue unblock
 *   src/core/comms/change-digest.ts       — change-driven digest
 *
 * No network: a FAKE Bot API transport (setTelegramTransportForTests) records
 * every call and answers like Telegram. The Leader thread
 * (src/core/vision/leader-thread.ts) and the veto/approve side effects are
 * fakes. HOME is a fresh tmp dir per test — nothing touches the real ~/.ashlr.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const thread = vi.hoisted(() => ({
  outbound: [] as Array<Record<string, unknown>>,
  delivered: [] as Array<{ id: string; channel: string; ok: boolean }>,
  appendMasonMessage: vi.fn(),
  answerLeaderQuestion: vi.fn(),
  approveLeaderAction: vi.fn(),
}));

vi.mock('../src/core/vision/leader-thread.js', () => ({
  appendMasonMessage: thread.appendMasonMessage,
  answerLeaderQuestion: thread.answerLeaderQuestion,
  approveLeaderAction: thread.approveLeaderAction,
  pendingOutbound: vi.fn(() => thread.outbound.filter((m) => !thread.delivered.some((d) => d.id === m['id'] && d.ok))),
  markDelivered: vi.fn((id: string, channel: string, ok: boolean) => {
    thread.delivered.push({ id, channel, ok });
  }),
}));

const apply = vi.hoisted(() => ({
  vetoLeaderMemo: vi.fn(async () => ({ ok: true, code: 200, message: 'memo vetoed, 1 action undone', records: [] })),
  vetoLeaderAction: vi.fn(async () => ({ ok: true, code: 200, message: 'action vetoed', records: [] })),
}));

vi.mock('../src/core/vision/leader-apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/vision/leader-apply.js')>();
  return {
    ...actual,
    loadDefaultLeaderDeps: vi.fn(async () => ({ fake: 'deps' })),
    vetoLeaderMemo: apply.vetoLeaderMemo,
    vetoLeaderAction: apply.vetoLeaderAction,
  };
});

import {
  escapeTelegramHtml,
  sendTelegramMessage,
  setTelegramTransportForTests,
  splitTelegramText,
  TELEGRAM_MAX_MESSAGE,
  pollTelegramUpdates,
} from '../src/core/integrations/telegram.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { listRequests, markSent, outstanding, postRequest } from '../src/core/comms/requests.js';
import { lookupTelegramMessage } from '../src/core/comms/telegram-thread-map.js';
import { writeLeaderMemo } from '../src/core/vision/leader-memo.js';
import {
  collectDigestFacts,
  planChangeDigest,
  runChangeDigest,
  type DigestFacts,
  type DigestSources,
} from '../src/core/comms/change-digest.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fake Telegram
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let updates: unknown[] = [];
let nextMessageId = 1000;
let failSends = false;
let rejectHtmlOnce = false;

function fakeTransport(method: string, body: Record<string, unknown>): Promise<unknown> {
  calls.push({ method, body });
  if (method === 'getUpdates') {
    const result = updates;
    updates = [];
    return Promise.resolve({ ok: true, result });
  }
  if (method === 'sendMessage') {
    if (failSends) return Promise.resolve({ ok: false, description: 'Forbidden: bot was blocked by the user' });
    if (rejectHtmlOnce && body['parse_mode'] === 'HTML') {
      rejectHtmlOnce = false;
      return Promise.resolve({ ok: false, description: "Bad Request: can't parse entities: unsupported start tag" });
    }
    return Promise.resolve({ ok: true, result: { message_id: nextMessageId++ } });
  }
  return Promise.resolve({ ok: true, result: true });
}

const sends = (): Call[] => calls.filter((c) => c.method === 'sendMessage');
const texts = (): string[] => sends().map((c) => String(c.body['text']));
const keyboardData = (c: Call): string[] =>
  ((c.body['reply_markup'] as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data ?? '');
const replyTarget = (c: Call): number | undefined =>
  (c.body['reply_parameters'] as { message_id?: number } | undefined)?.message_id;

const CHAT = '424242';
function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-314', chatId: CHAT } } } as AshlrConfig;
}

let updateId = 1;
function textUpdate(text: string, messageId: number, replyTo?: number): unknown {
  return {
    update_id: updateId++,
    message: {
      message_id: messageId,
      chat: { id: Number(CHAT), type: 'private' },
      text,
      ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}
function callbackUpdate(data: string, onMessage: number): unknown {
  return {
    update_id: updateId++,
    callback_query: { id: `cq-${updateId}`, data, message: { message_id: onMessage, chat: { id: Number(CHAT) } } },
  };
}

const fastCycle = { sendGapMs: 0, sleep: async () => {} };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMO_ID = 'lm-20260926063000-abcdef';
const ACTION_ESCALATED = 'la-20260926063000-abcdef-1';
const ACTION_APPLIED = 'la-20260926063000-abcdef-0';

function memo(): LeaderMemo {
  return {
    v: 1, id: MEMO_ID, at: '2026-09-26T06:30:00.000Z', status: 'ok', statusReason: null, trigger: 'schedule',
    dryRun: false, seatId: 's', model: 'm', evidenceDigest: 'd',
    bottleneck: { statement: 'Review queue <10 PRs> is the bottleneck', metric: null, evidence: [] },
    move: { statement: 'Merge the green PRs first', why: 'throughput', expectedDelta: null },
    killList: [], goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [],
    questionsForMason: ['Keep codex lanes off?'],
    actions: [
      { id: ACTION_APPLIED, status: 'applied', class: 'B', summary: 'Raise grok lanes', why: 'w' },
      { id: ACTION_ESCALATED, status: 'escalated', class: 'C', summary: 'Open billing repo', why: 'w' },
    ] as unknown as LeaderMemo['actions'],
  };
}

function leaderMsg(over: Record<string, unknown>): Record<string, unknown> {
  return { at: new Date().toISOString(), from: 'leader', channel: 'telegram', kind: 'message', text: 'hi', ...over };
}

let home = '';
const savedHome = process.env['HOME'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-tg314-'));
  process.env['HOME'] = home;
  calls = [];
  updates = [];
  nextMessageId = 1000;
  failSends = false;
  rejectHtmlOnce = false;
  thread.outbound = [];
  thread.delivered = [];
  thread.appendMasonMessage.mockReset();
  thread.answerLeaderQuestion.mockReset();
  thread.approveLeaderAction.mockReset();
  apply.vetoLeaderMemo.mockClear();
  apply.vetoLeaderAction.mockClear();
  setTelegramTransportForTests(fakeTransport);
});

afterEach(() => {
  setTelegramTransportForTests(null);
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

// ===========================================================================
// 1. Escaping + splitting
// ===========================================================================

describe('escapeTelegramHtml / splitTelegramText', () => {
  it('escapes &, <, > and " so model text can never break parse_mode=HTML', () => {
    expect(escapeTelegramHtml('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; &quot;d&quot;');
  });

  it('splits long text into chunks that are each ≤ 4096 AFTER escaping, losing nothing', () => {
    const line = '<tag> & more text '.repeat(20); // escaping grows it
    const text = Array.from({ length: 60 }, (_, i) => `${i}: ${line}`).join('\n');
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect(chunks.map(unescape).join('\n')).toBe(text);
  });

  it('hard-splits a single over-long line without cutting an emoji in half', () => {
    const text = '🚀'.repeat(3000); // 6000 UTF-16 units, no newlines
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
      expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false); // no dangling high surrogate
    }
    expect(chunks.join('')).toBe(text);
  });

  it('html mode keeps caller markup and splits only on line boundaries', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `<b>row ${i}</b> value`);
    const chunks = splitTelegramText(lines.join('\n'), { html: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
      expect((c.match(/<b>/g) ?? []).length).toBe((c.match(/<\/b>/g) ?? []).length);
    }
  });
});

describe('sendTelegramMessage (fake transport)', () => {
  it('escapes plain text by default and leaves html:true markup alone', async () => {
    await sendTelegramMessage('x < y & z', undefined, cfg());
    await sendTelegramMessage('<b>bold</b>', { html: true }, cfg());
    expect(texts()).toEqual(['x &lt; y &amp; z', '<b>bold</b>']);
  });

  it('sends a >4096 message as several replies-safe chunks: reply on the first, buttons on the last', async () => {
    const res = await sendTelegramMessage('line\n'.repeat(2000), {
      replyToMessageId: 77,
      keyboard: [[{ text: 'Details', data: 'lt:d:1' }]],
    }, cfg());
    const s = sends();
    expect(s.length).toBe(3);
    expect(res.ok).toBe(true);
    expect(res.messageIds).toEqual([1000, 1001, 1002]);
    expect(replyTarget(s[0]!)).toBe(77);
    expect(replyTarget(s[1]!)).toBeUndefined();
    expect(keyboardData(s[2]!)).toEqual(['lt:d:1']);
    expect(keyboardData(s[0]!)).toEqual([]);
    expect((s[0]!.body['reply_parameters'] as Record<string, unknown>)['allow_sending_without_reply']).toBe(true);
  });

  it('retries once as plain text when Telegram cannot parse the markup', async () => {
    rejectHtmlOnce = true;
    const res = await sendTelegramMessage('<b>broken', { html: true }, cfg());
    expect(res.ok).toBe(true);
    const s = sends();
    expect(s).toHaveLength(2);
    expect(s[1]!.body['parse_mode']).toBeUndefined();
    expect(s[1]!.body['text']).toBe('broken');
  });

  it('drops URL buttons Telegram cannot open (localhost) instead of failing the send', async () => {
    await sendTelegramMessage('merged', { buttons: ['View diff|http://localhost:4317/p/1', 'Revert (proposal)|revert:p1:r'], requestId: 'p1' }, cfg());
    const kb = (sends()[0]!.body['reply_markup'] as { inline_keyboard: Array<Array<Record<string, string>>> }).inline_keyboard;
    expect(kb).toEqual([[{ text: 'Revert (proposal)', callback_data: 'revert:p1:r' }]]);
  });

  it('poll surfaces message_id, reply_to_message and routed callback data', async () => {
    updates = [textUpdate('hello', 55, 1000), callbackUpdate('lt:v:3', 1000), callbackUpdate('req-1:0', 1001)];
    const { updates: ev } = await pollTelegramUpdates(cfg());
    expect(ev[0]).toMatchObject({ kind: 'text', text: 'hello', messageId: 55, replyToMessageId: 1000 });
    expect(ev[1]).toMatchObject({ kind: 'callback', data: 'lt:v:3', messageId: 1000 });
    expect(ev[2]).toMatchObject({ kind: 'callback', requestId: 'req-1', optionIndex: 0 });
  });
});

// ===========================================================================
// 2. Informational sends never block; the question slot is separate
// ===========================================================================

describe('queue: informational messages never wait for an unanswered question', () => {
  it('delivers reports and Leader-thread messages while a question is outstanding', async () => {
    const q = postRequest({ kind: 'manager-approval', type: 'approval', text: 'Merge X?', options: ['Yes', 'No'] });
    markSent(q);
    postRequest({ kind: 'test-question', type: 'question', text: 'Second question?', options: ['a', 'b'] });
    postRequest({ kind: 'fleet-digest', type: 'report', text: 'Fleet update: 2 merged', options: [] });
    thread.outbound = [leaderMsg({ id: 't-1', kind: 'update', text: 'Seat grok reset — resuming lanes.' })];

    const result = await runCommsCycle(cfg(), fastCycle);

    expect(texts()).toEqual(['Fleet update: 2 merged', 'Leader update:\nSeat grok reset — resuming lanes.']);
    expect(result.sent).toBe(2);
    expect(thread.delivered).toEqual([{ id: 't-1', channel: 'telegram', ok: true }]);
    // The second question still waits for the slot.
    expect(outstanding()?.id).toBe(q);
    expect(listRequests({ kind: 'test-question' })[0]!.status).toBe('pending');
  });

  it('paces informational sends (gap between sends) and caps the batch per cycle', async () => {
    for (let i = 0; i < 4; i++) postRequest({ kind: 'fleet-digest', type: 'report', text: `r${i}`, options: [] });
    const sleeps: number[] = [];
    const result = await runCommsCycle(cfg(), { sendGapMs: 3_000, batchCap: 3, sleep: async (ms) => { sleeps.push(ms); } });
    expect(result.sent).toBe(3);
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) expect(ms).toBeGreaterThan(2_000);
    expect(listRequests({ status: 'pending' })).toHaveLength(1);
  });

  it('a report the transport keeps rejecting is expired after 3 tries, so it cannot wedge the queue', async () => {
    failSends = true;
    postRequest({ kind: 'fleet-digest', type: 'report', text: 'stuck', options: [] });
    for (let i = 0; i < 3; i++) await runCommsCycle(cfg(), fastCycle);
    const [r] = listRequests({ kind: 'fleet-digest' });
    expect(r!.status).toBe('expired');
    expect(r!.expiredReason).toMatch(/send failed 3 times/);
  });
});

// ===========================================================================
// 3. Leader thread: outbound drain, two-way threading
// ===========================================================================

describe('Leader thread over Telegram', () => {
  it('drains pendingOutbound, marks delivered, and threads a reply under the message it answers', async () => {
    // Mason's earlier Telegram message 500 carried thread message m-9.
    updates = [textUpdate('what is blocking billing?', 500)];
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'm-9', at: '', from: 'mason', channel: 'telegram', kind: 'message', text: 'what is blocking billing?' },
      reply: null,
    });
    await runCommsCycle(cfg(), fastCycle);
    expect(texts().at(-1)).toMatch(/the Leader has it/);

    // Next cycle the Leader's async answer arrives through pendingOutbound.
    calls = [];
    thread.outbound = [leaderMsg({ id: 'l-9', kind: 'answer', text: 'CI flake in <billing-e2e>.', replyTo: 'm-9' })];
    await runCommsCycle(cfg(), fastCycle);
    const [s] = sends();
    expect(s!.body['text']).toBe('Leader:\nCI flake in &lt;billing-e2e&gt;.');
    expect(replyTarget(s!)).toBe(500);
    expect(thread.delivered).toContainEqual({ id: 'l-9', channel: 'telegram', ok: true });

    // Delivered messages are not sent again.
    calls = [];
    await runCommsCycle(cfg(), fastCycle);
    expect(sends()).toHaveLength(0);
  });

  it("mirrors Mason's Verse messages for context; never echoes his own Telegram messages", async () => {
    thread.outbound = [
      { ...leaderMsg({ id: 'v-1', text: 'ship billing first' }), from: 'mason', channel: 'verse' },
      { ...leaderMsg({ id: 't-own', text: 'already on the phone' }), from: 'mason', channel: 'telegram' },
    ];
    await runCommsCycle(cfg(), fastCycle);
    expect(texts()).toEqual(['You (in Verse):\nship billing first']);
    expect(thread.delivered).toEqual([
      { id: 'v-1', channel: 'telegram', ok: true },
      { id: 't-own', channel: 'telegram', ok: true },
    ]);
  });

  it('a failed thread send is marked not-delivered and retried next cycle', async () => {
    thread.outbound = [leaderMsg({ id: 'l-1', text: 'one' }), leaderMsg({ id: 'l-2', text: 'two' })];
    failSends = true;
    await runCommsCycle(cfg(), fastCycle);
    expect(thread.delivered).toEqual([{ id: 'l-1', channel: 'telegram', ok: false }]); // stops at first failure
    failSends = false;
    await runCommsCycle(cfg(), fastCycle);
    expect(thread.delivered.filter((d) => d.ok).map((d) => d.id)).toEqual(['l-1', 'l-2']);
  });

  it('a reply to a Leader QUESTION → answerLeaderQuestion; the answer comes back as a reply to Mason', async () => {
    thread.outbound = [leaderMsg({ id: 'q-msg', kind: 'question', questionId: 'q-7', text: 'Pause cortex for a week?' })];
    await runCommsCycle(cfg(), fastCycle);
    const questionTg = sends()[0]!;
    expect(questionTg.body['text']).toContain('Reply to this message to answer');
    const tgId = 1000;
    expect(lookupTelegramMessage(tgId)).toMatchObject({ threadId: 'q-msg', kind: 'question', questionId: 'q-7' });

    // An unrelated button-question is outstanding: a bare "2" replying to the
    // Leader question must answer the Leader, not pick option 2.
    const q = postRequest({ kind: 'test-question', type: 'question', text: 'Pick', options: ['a', 'b'] });
    markSent(q);
    thread.answerLeaderQuestion.mockResolvedValue({
      message: { id: 'a-1', at: '', from: 'mason', channel: 'telegram', kind: 'answer', text: '2' },
      reply: leaderMsg({ id: 'l-ack', text: 'Understood — two weeks then.' }),
    });
    calls = [];
    updates = [textUpdate('2', 610, tgId)];
    const result = await runCommsCycle(cfg(), fastCycle);

    expect(thread.answerLeaderQuestion).toHaveBeenCalledWith('q-7', '2', { channel: 'telegram' });
    expect(result.resolved).toBe(0);
    expect(outstanding()?.id).toBe(q);
    const reply = sends().find((c) => String(c.body['text']).includes('two weeks'))!;
    expect(replyTarget(reply)).toBe(610);
    expect(thread.delivered).toContainEqual({ id: 'l-ack', channel: 'telegram', ok: true });
  });

  it('a reply to any other Leader message → appendMasonMessage with replyTo; plain text → no replyTo', async () => {
    thread.outbound = [leaderMsg({ id: 'upd-1', kind: 'update', text: 'Shipped 3 PRs.' })];
    await runCommsCycle(cfg(), fastCycle);
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'm-1', at: '', from: 'mason', channel: 'telegram', kind: 'message', text: '' },
      reply: leaderMsg({ id: 'r-1', text: 'Next: docs.' }),
    });
    updates = [textUpdate('nice — what next?', 700, 1000), textUpdate('focus on billing this week', 701)];
    await runCommsCycle(cfg(), fastCycle);
    expect(thread.appendMasonMessage).toHaveBeenNthCalledWith(1, 'nice — what next?', { channel: 'telegram', replyTo: 'upd-1' });
    expect(thread.appendMasonMessage).toHaveBeenNthCalledWith(2, 'focus on billing this week', { channel: 'telegram' });
  });

  it('a directive with no immediate reply is acknowledged honestly', async () => {
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'm-2', at: '', from: 'mason', channel: 'telegram', kind: 'directive', text: '' },
      reply: null,
      directive: { text: 'No new repos until billing ships' },
    });
    updates = [textUpdate('no new repos until billing ships', 800)];
    await runCommsCycle(cfg(), fastCycle);
    const [s] = sends();
    expect(s!.body['text']).toBe('Directive recorded: No new repos until billing ships');
    expect(replyTarget(s!)).toBe(800);
  });
});

// ===========================================================================
// 4. Buttons: [Approve] [Veto] [Details]
// ===========================================================================

describe('Leader memo buttons', () => {
  async function deliverMemoReport(): Promise<{ tg: number; data: string[] }> {
    writeLeaderMemo(memo());
    postRequest({ kind: 'leader-memo', type: 'report', text: 'Leader memo — Move: merge green PRs', options: [], meta: { source: 'leader', memoId: MEMO_ID } });
    await runCommsCycle(cfg(), fastCycle);
    const s = sends().find((c) => String(c.body['text']).startsWith('Leader memo'))!;
    return { tg: 1000, data: keyboardData(s) };
  }

  it('a memo report carries Approve (escalated action) + Veto (live action) + Details, and is recorded', async () => {
    const { tg, data } = await deliverMemoReport();
    expect(data.map((d) => d.slice(0, 5))).toEqual(['lt:a:', 'lt:v:', 'lt:d:']);
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(lookupTelegramMessage(tg)).toMatchObject({ kind: 'memo', memoId: MEMO_ID });
  });

  it('Details replies with the full memo; Veto vetoes the memo; Approve approves the escalated action', async () => {
    const { tg, data } = await deliverMemoReport();
    const [approve, veto, details] = data as [string, string, string];
    thread.approveLeaderAction.mockResolvedValue({ ok: true, message: 'approved and applied' });

    calls = [];
    updates = [callbackUpdate(details, tg), callbackUpdate(veto, tg), callbackUpdate(approve, tg)];
    await runCommsCycle(cfg(), fastCycle);

    const out = texts();
    expect(out.find((t) => t.includes('BOTTLENECK'))).toContain('Review queue &lt;10 PRs&gt;');
    expect(apply.vetoLeaderMemo).toHaveBeenCalledWith({ fake: 'deps' }, MEMO_ID, 'Vetoed from Telegram');
    expect(out).toContain('Vetoed: memo vetoed, 1 action undone');
    expect(thread.approveLeaderAction).toHaveBeenCalledWith(ACTION_ESCALATED, { channel: 'telegram' });
    expect(out.find((t) => t.startsWith('Approved'))).toContain(ACTION_ESCALATED);
    // every reply threads under the tapped memo, and every tap is acked
    for (const c of sends()) expect(replyTarget(c)).toBe(tg);
    expect(calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(3);
  });

  it('a forged / unknown token does nothing but ack', async () => {
    updates = [callbackUpdate('lt:v:999999', 1)];
    await runCommsCycle(cfg(), fastCycle);
    expect(apply.vetoLeaderMemo).not.toHaveBeenCalled();
    const ack = calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(ack.body['text']).toMatch(/expired/);
  });

  it('a thread memo already delivered through the queue is not sent twice', async () => {
    await deliverMemoReport();
    calls = [];
    thread.outbound = [leaderMsg({ id: 'memo-msg', kind: 'memo', memoId: MEMO_ID, text: 'same memo' })];
    await runCommsCycle(cfg(), fastCycle);
    expect(sends()).toHaveLength(0);
    expect(thread.delivered).toContainEqual({ id: 'memo-msg', channel: 'telegram', ok: true });
  });
});

// ===========================================================================
// 5. Commands
// ===========================================================================

describe('slash commands and keywords', () => {
  it('/help, /status, /directives, /leader and unknown commands all answer as replies', async () => {
    writeLeaderMemo(memo());
    updates = [
      textUpdate('/help', 1), textUpdate('/status', 2), textUpdate('/directives', 3),
      textUpdate('/leader', 4), textUpdate('/bogus', 5),
    ];
    await runCommsCycle(cfg(), fastCycle);
    const s = sends();
    expect(s.map(replyTarget)).toEqual([1, 2, 3, 4, 5]);
    expect(texts()[0]).toContain('/status');
    expect(texts()[1]).toMatch(/Autonomy: off — next step: `ashlr authority setup`/);
    expect(texts()[2]).toContain('Directives');
    expect(texts()[3]).toContain(MEMO_ID);
    expect(keyboardData(s[3]!).some((d) => d.startsWith('lt:d:'))).toBe(true);
    expect(texts()[4]).toContain('Unknown command /bogus');
    expect(thread.appendMasonMessage).not.toHaveBeenCalled();
  });

  it('/leader <text> talks to the Leader', async () => {
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'm', at: '', from: 'mason', channel: 'telegram', kind: 'message', text: '' },
      reply: leaderMsg({ id: 'r', text: 'Yes.' }),
    });
    updates = [textUpdate('/leader are we on track?', 9)];
    await runCommsCycle(cfg(), fastCycle);
    expect(thread.appendMasonMessage).toHaveBeenCalledWith('are we on track?', { channel: 'telegram' });
  });

  it('paused: inbound still works (resume arrives) but nothing informational goes out', async () => {
    updates = [textUpdate('pause', 1)];
    await runCommsCycle(cfg(), fastCycle);
    calls = [];
    postRequest({ kind: 'fleet-digest', type: 'report', text: 'held', options: [] });
    await runCommsCycle(cfg(), fastCycle);
    expect(sends()).toHaveLength(0);
    updates = [textUpdate('resume', 2)];
    await runCommsCycle(cfg(), fastCycle);
    expect(texts()).toEqual(['▶️ Fleet resumed.', 'held']);
  });
});

// ===========================================================================
// 6. One-time migration
// ===========================================================================

describe('one-time queue migration', () => {
  function seed(rows: Array<Record<string, unknown>>): void {
    mkdirSync(join(home, '.ashlr', 'comms'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'comms', 'requests.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const base = { options: [], type: 'report' };

  it('expires the blocking legacy briefing + stale digests, delivers the newest Leader memo, logs it, runs once', async () => {
    const now = Date.now();
    const iso = (hAgo: number) => new Date(now - hAgo * 3_600_000).toISOString();
    writeLeaderMemo(memo());
    seed([
      { id: 'legacy-1', kind: 'elon-vision', type: 'question', text: 'Approve June briefing?', options: ['Approve', 'Hold', 'Show'], status: 'sent', createdAt: '2026-06-20T07:00:00.000Z', sentAt: iso(1) , meta: { source: 'strategist' } },
      { id: 'dig-old-1', kind: 'fleet-digest', ...base, text: 'old 1', status: 'pending', createdAt: iso(72) },
      { id: 'dig-old-2', kind: 'fleet-digest', ...base, text: 'old 2', status: 'pending', createdAt: iso(30) },
      { id: 'dig-new', kind: 'fleet-digest', ...base, text: 'fresh digest', status: 'pending', createdAt: iso(2) },
      { id: 'memo-old', kind: 'elon-vision', type: 'question', options: ['Keep it', 'Veto this memo', 'Show full memo'], text: 'Leader memo | Move: older', status: 'pending', createdAt: iso(40), meta: { source: 'leader', memoId: 'lm-20260924063000-aaaaaa' } },
      { id: 'memo-new', kind: 'elon-vision', type: 'question', options: ['Keep it', 'Veto this memo', 'Show full memo'], text: 'Leader memo | Move: merge green PRs', status: 'pending', createdAt: iso(20), meta: { source: 'leader', memoId: MEMO_ID } },
    ]);

    const result = await runCommsCycle(cfg(), fastCycle);

    const byId = new Map(listRequests().map((r) => [r.id, r]));
    expect(byId.get('legacy-1')!.status).toBe('expired');
    expect(byId.get('dig-old-1')!.status).toBe('expired');
    expect(byId.get('dig-old-2')!.status).toBe('expired');
    expect(byId.get('memo-old')!.status).toBe('expired');
    expect(byId.get('memo-new')!.status).toBe('expired');
    expect(byId.get('legacy-1')!.expiredReason).toMatch(/legacy Strategist/);
    expect(byId.get('dig-new')!.status).toBe('answered');
    const reposted = listRequests({ kind: 'leader-memo' });
    expect(reposted).toHaveLength(1);
    expect(reposted[0]!.meta).toMatchObject({ memoId: MEMO_ID, migratedFrom: 'memo-new' });
    expect(reposted[0]!.status).toBe('answered');
    expect(texts()).toEqual(['fresh digest', expect.stringContaining('Move: merge green PRs')]);

    expect(result.migration).toMatchObject({ expiredLegacyBriefings: 1, expiredStaleDigests: 2, expiredLeaderMemoQuestions: 2, repostedMemoId: MEMO_ID });
    expect(result.migration!.log.join('\n')).toContain('expired legacy briefing: elon-vision sent legacy-1');
    const recorded = JSON.parse(readFileSync(join(home, '.ashlr', 'comms', 'migrations.json'), 'utf8'));
    expect(recorded.done['telegram-leader-line-v1'].expiredStaleDigests).toBe(2);

    const again = await runCommsCycle(cfg(), fastCycle);
    expect(again.migration).toBeUndefined();
  });
});

// ===========================================================================
// 7. Change-driven digest
// ===========================================================================

describe('change-driven digest', () => {
  const NOW = Date.parse('2026-09-26T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  function sources(over: Partial<DigestSources> = {}): DigestSources {
    return {
      ledger: async () => [],
      appliedProposals: () => [],
      proposalTitle: () => null,
      cloudTasks: () => [],
      capacity: () => null,
      memos: () => [],
      autonomy: () => ({ on: true, mode: 'autonomous' }),
      ...over,
    };
  }

  it('reports concrete changes with numbers and PR links, then stays silent when nothing changed', async () => {
    const src = sources({
      ledger: async () => [
        { kind: 'merge:landed', at: hoursAgo(2), repo: 'ashlrai/hub', data: { repo: 'ashlrai/hub', prNumber: 512, proposalId: 'p1', mergeSha: 'abc' } },
        { kind: 'pr:opened', at: hoursAgo(1), repo: 'ashlrai/cortex', data: { repo: 'ashlrai/cortex', number: 88, kind: 'change', proposalId: null } },
        { kind: 'revert:landed', at: hoursAgo(1), repo: 'ashlrai/hub', data: { repo: 'ashlrai/hub', prNumber: 515, kind: 'revert' } },
      ],
      proposalTitle: (id) => (id === 'p1' ? 'Fix router <flake>' : null),
      cloudTasks: () => [
        { id: 'ct1', state: 'merged', updatedAt: hoursAgo(3), title: 'Docs pass', repo: 'ashlrai/site', pr: { url: 'https://github.com/ashlrai/site/pull/9' } },
        { id: 'ct2', state: 'running', updatedAt: hoursAgo(1), title: 'Still going', repo: 'ashlrai/site', pr: null },
      ],
      memos: () => [{ id: MEMO_ID, at: hoursAgo(5), status: 'ok', move: { statement: 'Merge green PRs' }, bottleneck: null }],
    });
    const facts = await collectDigestFacts(NOW - 24 * 3_600_000, src);
    const plan = planChangeDigest(null, facts, NOW);
    expect(plan.reason).toBe('changes');
    const text = plan.text!;
    expect(text).toMatch(/^Fleet update \(last 24h\): 1 merged, 1 PR opened, 1 revert, 1 cloud task finished/);
    expect(text).toContain('ashlrai/hub#512 — Fix router <flake> https://github.com/ashlrai/hub/pull/512');
    expect(text).toContain('https://github.com/ashlrai/cortex/pull/88');
    expect(text).toContain('https://github.com/ashlrai/hub/pull/515');
    expect(text).toContain('"Docs pass" (ashlrai/site) merged https://github.com/ashlrai/site/pull/9');
    expect(text).toContain(`New Leader memo (1):\n• ${MEMO_ID} — Merge green PRs`);
    expect(text).not.toMatch(/Still going|nominal|κ|Vision progress/);

    // Same facts again → silence.
    const again = planChangeDigest(plan.next, facts, NOW + 6 * 3_600_000);
    expect(again.text).toBeNull();
    expect(again.reason).toBe('unchanged');
  });

  it('seat exhaustion and reset are changes; the first evaluation only records the baseline', () => {
    const seats = (exhausted: boolean): DigestFacts => ({
      events: [],
      seats: [{ seatId: 'claude-a', label: 'Claude A', exhausted, resetHint: exhausted ? 'resets 3pm' : null }],
      autonomy: { on: true, mode: 'autonomous' },
    });
    const first = planChangeDigest(null, seats(false), NOW);
    const hit = planChangeDigest(first.next, seats(true), NOW + 3_600_000);
    expect(hit.text).toContain('Claude A exhausted (resets 3pm)');
    const reset = planChangeDigest(hit.next, seats(false), NOW + 7_200_000);
    expect(reset.text).toContain('Claude A reset — available again');
  });

  it('a new Leader memo alone is not a digest (the memo is delivered as its own message)', () => {
    const facts: DigestFacts = {
      events: [{ key: `memo:${MEMO_ID}`, kind: 'memo', at: hoursAgo(1), text: MEMO_ID, work: false }],
      seats: null,
      autonomy: { on: true, mode: 'autonomous' },
    };
    const first = planChangeDigest({
      v: 1, lastCheckAt: hoursAgo(6), lastSentAt: null, lastActivityAt: hoursAgo(3),
      reported: [], exhaustedSeats: [], idleNoticeFor: null,
    }, facts, NOW);
    expect(first.text).toBeNull();
    expect(first.next.reported).toContain(`memo:${MEMO_ID}`);
  });

  it('idle > 24h: exactly one honest line per idle stretch, naming the next setup step', () => {
    const idle: DigestFacts = { events: [], seats: null, autonomy: { on: false, mode: null } };
    const first = planChangeDigest(null, idle, NOW);
    expect(first.text).toBe('Fleet idle 24h+: autonomy is off — next step: `ashlr authority setup`.');
    const later = planChangeDigest(first.next, idle, NOW + 30 * 3_600_000);
    expect(later.text).toBeNull();

    // Activity resets the stretch; a new idle stretch gets one new line.
    const work: DigestFacts = { ...idle, events: [{ key: 'pr:a/b#1:merged', kind: 'merge', at: new Date(NOW + 31 * 3_600_000).toISOString(), text: 'a/b#1', work: true }] };
    const busy = planChangeDigest(later.next, work, NOW + 32 * 3_600_000);
    expect(busy.reason).toBe('changes');
    expect(busy.text).toContain('Autonomy: off — next step'); // merges while autonomy is off → say so
    const idleAgain = planChangeDigest(busy.next, idle, NOW + 60 * 3_600_000);
    expect(idleAgain.text).toMatch(/^Fleet idle 29h: autonomy is off/);
  });

  it('runChangeDigest queues a report only when there is something to say', async () => {
    const quiet = sources({ autonomy: () => ({ on: true, mode: 'autonomous' }) });
    const first = await runChangeDigest({ nowMs: NOW, sources: quiet });
    expect(first.reason).toBe('idle'); // nothing in the last 24h
    expect(listRequests({ kind: 'fleet-digest' })).toHaveLength(1);
    const second = await runChangeDigest({ nowMs: NOW + 6 * 3_600_000, sources: quiet });
    expect(second.posted).toBe(false);
    expect(listRequests({ kind: 'fleet-digest' })).toHaveLength(1);
  });
});
