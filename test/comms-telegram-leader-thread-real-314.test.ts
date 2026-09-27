/**
 * 3.14 — the Telegram drain against the REAL Leader thread
 * (src/core/vision/leader-thread.ts), not a fake: a memo written to disk is
 * synced into the thread, drained to Telegram exactly once (memo summary +
 * its question, with buttons), and its delivery state is recorded as `sent`.
 *
 * No network (fake Bot API transport), no model (nothing here asks the Leader
 * to think), tmp HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { lookupTelegramMessage } from '../src/core/comms/telegram-thread-map.js';
import { writeLeaderMemo } from '../src/core/vision/leader-memo.js';
import { listThread, postLeaderMessage } from '../src/core/vision/leader-thread.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import type { AshlrConfig } from '../src/core/types.js';

const calls: { method: string; body: Record<string, unknown> }[] = [];
let nextId = 5000;
let home = '';
const savedHome = process.env['HOME'];

const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-real', chatId: '7' } } } as AshlrConfig;
const fast = { sendGapMs: 0, sleep: async () => {} };
const sends = () => calls.filter((c) => c.method === 'sendMessage');

function memo(): LeaderMemo {
  const at = new Date(Date.now() - 3_600_000);
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const id = `lm-${stamp}-abcdef`;
  return {
    v: 1, id, at: at.toISOString(), status: 'ok', statusReason: null, trigger: 'schedule', dryRun: false,
    seatId: 's', model: 'm', evidenceDigest: 'd',
    bottleneck: { statement: 'Reviews <slow>', metric: null, evidence: [] },
    move: { statement: 'Merge green PRs first', why: 'w', expectedDelta: null },
    killList: [], goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [],
    questionsForMason: ['Keep codex lanes off this week?'],
    actions: [],
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-tg314-real-'));
  process.env['HOME'] = home;
  calls.length = 0;
  setTelegramTransportForTests(async (method, body) => {
    calls.push({ method, body });
    if (method === 'getUpdates') return { ok: true, result: [] };
    if (method === 'sendMessage') return { ok: true, result: { message_id: nextId++ } };
    return { ok: true, result: true };
  });
});

afterEach(() => {
  setTelegramTransportForTests(null);
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram drain × real Leader thread', () => {
  it('delivers a synced memo and its question once, escaped, with buttons; state becomes sent', async () => {
    const m = memo();
    writeLeaderMemo(m);

    const first = await runCommsCycle(cfg, fast);
    expect(first.sent).toBe(2);
    const [memoSend, questionSend] = sends();
    expect(String(memoSend!.body['text'])).toMatch(new RegExp(`^Leader memo ${m.id}`));
    expect(String(memoSend!.body['text'])).toContain('Reviews &lt;slow&gt;');
    expect(JSON.stringify(memoSend!.body['reply_markup'])).toContain('lt:d:');
    expect(String(questionSend!.body['text'])).toContain('Keep codex lanes off this week?');
    expect(lookupTelegramMessage(nextId - 1)).toMatchObject({ kind: 'question', questionId: `${m.id}:0` });

    const thread = listThread();
    const leaderMsgs = thread.filter((x) => x.memoId === m.id);
    expect(leaderMsgs.length).toBe(2);
    for (const x of leaderMsgs) expect(x.delivery?.telegram).toBe('sent');

    // Exactly once: the next cycle has nothing to send.
    calls.length = 0;
    const second = await runCommsCycle(cfg, fast);
    expect(second.sent).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it('a proactive Leader update posted to the thread is drained and marked sent', async () => {
    const msg = postLeaderMessage({ channel: 'system', kind: 'update', text: 'Seat grok reset — lanes resume.' });
    await runCommsCycle(cfg, fast);
    expect(sends().map((c) => c.body['text'])).toContain('Leader update:\nSeat grok reset — lanes resume.');
    expect(listThread().find((x) => x.id === msg.id)?.delivery?.telegram).toBe('sent');
  });
});
