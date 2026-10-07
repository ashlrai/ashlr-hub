/**
 * 3.15 — Leader-conversation gaps.
 *
 *   1. Telegram `/directives` lists Mason's ACTIVE standing directives
 *      (leader-operator.ts, operator-directives.json): id, kind, text, HTML
 *      escaped exactly once. The Leader's own settings (lanes, router tuning)
 *      and standards moved to `/settings`.
 *   2. The help text says what Approve really does (applies a scheduled
 *      class-B action early, or records approval of a class-C ask).
 *   3. One directive limit for server and Verse (OPERATOR_DIRECTIVE_MAX = 300).
 *   5. Conversation replies NEVER use Claude, even with
 *      `foundry.leader.claudeFallback: true`; memo runs still honour the opt-in.
 *
 * Hermetic: tmp HOME, a fake Bot API transport, fake seats. No model, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setTelegramSendClockForTests, setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import { DIRECTIVES_EMPTY_HTML, TELEGRAM_HELP_TEXT, directivesHtml, handleSlashCommand } from '../src/core/comms/telegram-channel.js';
import { OPERATOR_DIRECTIVE_MAX } from '../src/core/vision/leader-thread-types.js';
import { OPERATOR_LIMITS, addOperatorDirective, retireOperatorDirective } from '../src/core/vision/leader-operator.js';
import { appendMasonMessage, setLeaderThreadDepsForTest } from '../src/core/vision/leader-thread.js';
import { planLeaderSeats, resolveLeaderSeat, type LeaderSeatCandidate, type LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import type { LeaderEvidenceSources, LeaderRunDeps } from '../src/core/vision/leader.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();

let telegramNow = 0;

beforeEach(() => {
  telegramNow = 0;
  // Exercise actual-attempt pacing with a virtual monotonic clock, not a
  // fake-transport bypass or larger timeout.
  setTelegramSendClockForTests({
    now: () => telegramNow,
    sleep: async (ms) => { telegramNow += ms; },
  });
  home.setup();
});
afterEach(() => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  setLeaderThreadDepsForTest(null);
  home.teardown();
});

// ---------------------------------------------------------------------------
// Telegram: /directives, /settings, help
// ---------------------------------------------------------------------------

interface Sent { text: string; parseMode: unknown; replyTo: unknown }

function fakeTelegram(): Sent[] {
  const sent: Sent[] = [];
  let id = 500;
  setTelegramTransportForTests(async (method, body) => {
    if (method === 'sendMessage') {
      sent.push({
        text: String(body['text']),
        parseMode: body['parse_mode'],
        replyTo: (body['reply_parameters'] as { message_id?: number } | undefined)?.message_id,
      });
      return { ok: true, result: { message_id: id++ } };
    }
    return { ok: true, result: true };
  });
  return sent;
}

const CHAT = '424242';
function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-315', chatId: CHAT } } } as AshlrConfig;
}

async function command(text: string, messageId = 7): Promise<void> {
  const handled = await handleSlashCommand({ kind: 'text', text, fromChatId: CHAT, messageId }, text, cfg());
  expect(handled).toBe(true);
}

describe('Telegram /directives — your standing directives', () => {
  it('lists the ACTIVE directives (id, kind, text), newest first, HTML-escaped once; retired ones are gone', async () => {
    const a = addOperatorDirective({ kind: 'focus', text: 'Focus on binshield <billing> & invoices', source: 'explicit', channel: 'telegram' }, Date.parse('2026-09-26T10:00:00Z'));
    const b = addOperatorDirective({ kind: 'stop', text: 'Stop opening new goals', source: 'direct', channel: 'verse' }, Date.parse('2026-09-26T11:00:00Z'));
    const c = addOperatorDirective({ kind: 'priority', text: 'locus before the wiki', source: 'explicit', channel: 'cli' }, Date.parse('2026-09-26T12:00:00Z'));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(retireOperatorDirective(b.directive.id, 'verse').ok).toBe(true);

    const sent = fakeTelegram();
    await command('/directives', 11);
    expect(sent).toHaveLength(1);
    const { text, parseMode, replyTo } = sent[0]!;
    expect(parseMode).toBe('HTML');
    expect(replyTo).toBe(11);
    expect(text.split('\n')).toEqual([
      '<b>Standing directives (2)</b>',
      `• <code>${c.directive.id}</code> [priority] locus before the wiki`,
      `• <code>${a.directive.id}</code> [focus] Focus on binshield &lt;billing&gt; &amp; invoices`,
    ]);
    // Escaped exactly once (html: true — the transport does not escape again).
    expect(text).not.toContain('&amp;lt;');
    expect(text).not.toContain('Stop opening new goals');
    // Not the Leader's settings any more.
    expect(text).not.toMatch(/grok lanes|router tuning|Standards/);
  });

  it('empty state names the four prefixes that set one', async () => {
    expect(await directivesHtml()).toBe(DIRECTIVES_EMPTY_HTML);
    const sent = fakeTelegram();
    await command('/directives');
    expect(sent[0]!.parseMode).toBe('HTML');
    expect(sent[0]!.text).toBe(
      'No standing directives — send <code>focus: …</code>, <code>stop: …</code>, <code>priority: …</code> or <code>directive: …</code>',
    );
  });

  it('/settings keeps the Leader\'s settings and standards view', async () => {
    const sent = fakeTelegram();
    await command('/settings', 12);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBe(12);
    expect(sent[0]!.text).toMatch(/^Leader settings\n {2}none set \(lane and router defaults apply\)/);
    expect(sent[0]!.text).toContain('Standards (0)');
  });
});

describe('Telegram help text', () => {
  it('lists /directives and /settings, and says what Approve really does', () => {
    expect(TELEGRAM_HELP_TEXT).toContain('/directives — your standing directives to the Leader');
    expect(TELEGRAM_HELP_TEXT).toMatch(/\/settings — the Leader's settings/);
    expect(TELEGRAM_HELP_TEXT).toContain('Approve (apply a scheduled class-B action now, or record your approval of a class-C ask)');
    expect(TELEGRAM_HELP_TEXT).not.toMatch(/escalated action/);
  });
});

// ---------------------------------------------------------------------------
// One directive limit
// ---------------------------------------------------------------------------

describe('directive length limit', () => {
  it('the server keeps OPERATOR_DIRECTIVE_MAX (300) — the same constant the Verse box counts against', () => {
    expect(OPERATOR_DIRECTIVE_MAX).toBe(300);
    expect(OPERATOR_LIMITS.directiveMaxChars).toBe(OPERATOR_DIRECTIVE_MAX);
    const r = addOperatorDirective({ kind: 'guidance', text: 'Keep shipping small safe changes every day. '.repeat(10), source: 'direct', channel: 'verse' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.directive.text).toHaveLength(OPERATOR_DIRECTIVE_MAX);
    expect(r.directive.text.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replies never use Claude
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();

function seat(id: string, engine: VerseSeat['engine'], model: string): VerseSeat {
  return {
    id, engine, label: id, accountId: engine === 'local' ? 'local' : id,
    models: [{ id: model, label: model, contextWindow: 200_000 }],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

const CLAUDE: LeaderSeatCandidate = { seat: seat('claude', 'claude', 'claude-opus-5-5'), launcher: ['node', '/profiles/claude/launcher.js'], ollamaBaseUrl: null };
const GROK: LeaderSeatCandidate = { seat: seat('grok', 'grok', 'grok-4.6'), launcher: ['node', '/profiles/grok/launcher.js'], ollamaBaseUrl: null };
const CLAUDE_OK: SeatCapacity = {
  seatId: 'claude', engine: 'claude', label: 'claude', free: false, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null,
  windows: [
    { id: 'five_hour', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
    { id: 'seven_day', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
  ],
};
const GROK_OK: SeatCapacity = {
  seatId: 'grok', engine: 'grok', label: 'grok', free: false, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null,
  windows: [{ id: 'weekly', usedPercent: 20, resetsAt: '2026-09-28T00:00:00.000Z', resetDescription: null, limitReached: false }],
};

const FALLBACK_ON = { foundry: { leader: { claudeFallback: true } } } as unknown as AshlrConfig;

function seatDeps(candidates: LeaderSeatCandidate[], snapshot: SeatCapacity[], calls: string[]): LeaderSeatDeps {
  return {
    cfg: FALLBACK_ON,
    now: () => NOW,
    candidates: async () => candidates,
    capacitySnapshot: () => ({ publishedAt: OBSERVED, seats: snapshot }),
    budgetPolicy: () => defaultBudgetPolicy(),
    standingPolicy: () => makePolicy(),
    clampBudget: (p) => p,
    route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      local: () => async () => { calls.push('local'); return '{}'; },
      grok: () => async () => { calls.push('grok'); return JSON.stringify({ reply: 'grok here' }); },
      claude: () => async () => { calls.push('claude'); throw new Error('claude must not be called for a reply'); },
    },
    claudeCredential: async () => undefined,
  };
}

describe('resolveLeaderSeat purpose: reply', () => {
  it('with claudeFallback on and only Claude viable, a reply gets no seat (and says why); a memo run still gets Claude', async () => {
    const calls: string[] = [];
    const deps = seatDeps([CLAUDE], [CLAUDE_OK], calls);
    const reply = await resolveLeaderSeat(deps, { deep: false, promptChars: 20_000, purpose: 'reply' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.reason).toBe('Conversation replies never use Claude, and no grok or local seat is available.');

    // Memo runs are unchanged: the opt-in still admits Claude as the fallback.
    const memo = await resolveLeaderSeat(deps, { deep: false, promptChars: 20_000 });
    expect(memo.ok && memo.choice.engine).toBe('claude');
    const plan = await planLeaderSeats(deps, { deep: false, promptChars: 20_000, mode: 'full' });
    expect(plan.ok && plan.steps.map((s) => s.choice.engine)).toEqual(['claude']);
    expect(calls).toEqual([]);
  });

  it('a reply with grok available uses grok and records Claude as passed over', async () => {
    const calls: string[] = [];
    const r = await resolveLeaderSeat(seatDeps([CLAUDE, GROK], [CLAUDE_OK, GROK_OK], calls), { deep: false, promptChars: 20_000, purpose: 'reply' });
    expect(r.ok && r.choice.engine).toBe('grok');
  });

  it('even the deep flag cannot put Claude on a reply', async () => {
    const r = await resolveLeaderSeat(seatDeps([CLAUDE], [CLAUDE_OK], []), { deep: true, promptChars: 20_000, purpose: 'reply' });
    expect(r.ok).toBe(false);
  });
});

describe('conversation replies never use Claude (end to end through appendMasonMessage)', () => {
  function world(candidates: LeaderSeatCandidate[], snapshot: SeatCapacity[]): { calls: string[] } {
    const calls: string[] = [];
    const ledger = fakeLedger();
    const policy = () => makePolicy();
    const { deps: apply } = makeApplyDeps({ ledger, policy });
    const sources: LeaderEvidenceSources = {
      standingPolicy: policy,
      budgetPolicy: () => defaultBudgetPolicy(),
      capacity: () => ({ publishedAt: new Date().toISOString(), seats: [] }),
      goals: () => ({ goals: [], complete: true }),
      readLedger: (o) => ledger.read(o),
      holds: () => [],
      quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: 0, acceptRate: 0, verifyPassRate: 0 }),
      models: () => [],
      reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }),
    };
    // The seat router keeps the fixture clock (NOW): the capacity readings are
    // stamped OBSERVED = NOW − 1 min, and routing refuses a reading older than
    // 15 min — a wall-clock router here made this test fail later in the day.
    const seatD = seatDeps(candidates, snapshot, calls);
    const deps: LeaderRunDeps = { cfg: FALLBACK_ON, now: () => Date.now(), sources, seat: seatD, apply };
    setLeaderThreadDepsForTest({ loadRunDeps: async () => deps });
    return { calls };
  }

  it('claudeFallback on + only Claude viable ⇒ the honest "I can\'t think right now: …" reply; Claude is never called', async () => {
    const w = world([CLAUDE], [CLAUDE_OK]);
    const { reply } = await appendMasonMessage('What is the plan this week?', { channel: 'verse' });
    expect(reply!.text).toBe("I can't think right now: Conversation replies never use Claude, and no grok or local seat is available.");
    expect(w.calls).toEqual([]);
  });

  it('with grok also viable, the reply comes from grok', async () => {
    const w = world([CLAUDE, GROK], [CLAUDE_OK, GROK_OK]);
    const { reply } = await appendMasonMessage('Status?', { channel: 'verse' });
    expect(reply!.text).toBe('grok here');
    expect(w.calls).toEqual(['grok']);
  });
});
