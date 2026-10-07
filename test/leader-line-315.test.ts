/**
 * 3.15 — the Leader line on Telegram: briefs from recorded state, pacing
 * (quiet hours, ping caps, one question at a time), intent routing and
 * "go build X" turning into real work with a result ping.
 *
 * No network: a FAKE Bot API transport records every call. The Leader
 * thread is mocked; the Leader's action lanes are fakes behind the REAL
 * leader-apply store (fake ledger). HOME is a fresh tmp dir per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const thread = vi.hoisted(() => ({
  outbound: [] as Array<Record<string, unknown>>,
  delivered: [] as Array<{ id: string; ok: boolean }>,
  posted: [] as Array<Record<string, unknown>>,
  answerLeaderQuestion: vi.fn(),
  readLeaderQuestion: vi.fn(),
  appendMasonMessage: vi.fn(),
  approveLeaderAction: vi.fn(),
}));

vi.mock('../src/core/vision/leader-thread.js', () => ({
  appendMasonMessage: thread.appendMasonMessage,
  answerLeaderQuestion: thread.answerLeaderQuestion,
  readLeaderQuestion: thread.readLeaderQuestion,
  approveLeaderAction: thread.approveLeaderAction,
  leaderNarrativeLine: vi.fn(async () => null),
  postLeaderMessage: vi.fn((m: Record<string, unknown>) => {
    thread.posted.push(m);
    return { id: 'lt-20260927140000-aaaaaa', ...m };
  }),
  pendingOutbound: vi.fn(() => thread.outbound.filter((m) => !thread.delivered.some((d) => d.id === m['id'] && d.ok))),
  markDelivered: vi.fn((id: string, _channel: string, ok: boolean) => {
    thread.delivered.push({ id, ok });
    return true;
  }),
}));

import { setTelegramSendClockForTests, setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import { composeBrief, gatherBriefFacts, type BriefSources } from '../src/core/comms/leader-brief.js';
import {
  dueBrief,
  gateThreadMessage,
  handleTaskRequest,
  inQuietHours,
  isYesNoQuestion,
  pingAllowed,
  readLineState,
  resolveLineConfig,
  runLeaderLine,
  setLeaderLineDepsForTest,
  threadLineHooks,
  writeLineState,
  type LeaderLineDeps,
  type LineStateV1,
} from '../src/core/comms/leader-line.js';
import { converseWithLeader, createPacer, drainLeaderThread, handleLeaderButton } from '../src/core/comms/telegram-channel.js';
import { registerButtonTarget } from '../src/core/comms/telegram-thread-map.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { InboundEvent } from '../src/core/integrations/telegram.js';
import { fakeLedger, makeApplyDeps, makePolicy } from './helpers/leader-310b-fakes.js';
import type { LeaderPowersPorts } from '../src/core/vision/leader-powers.js';

// ---------------------------------------------------------------------------
// Fake Telegram
// ---------------------------------------------------------------------------

interface Call { method: string; body: Record<string, unknown> }
let calls: Call[] = [];
let nextMessageId = 5000;

function fakeTransport(method: string, body: Record<string, unknown>): Promise<unknown> {
  calls.push({ method, body });
  if (method === 'getUpdates') return Promise.resolve({ ok: true, result: [] });
  if (method === 'sendMessage') return Promise.resolve({ ok: true, result: { message_id: nextMessageId++ } });
  return Promise.resolve({ ok: true, result: true });
}
const sends = (): Call[] => calls.filter((c) => c.method === 'sendMessage');
// The transport HTML-escapes; assertions read the plain text Mason sees.
const unescape = (t: string): string => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const texts = (): string[] => sends().map((c) => unescape(String(c.body['text'])));
const keyboardData = (c: Call): string[] =>
  ((c.body['reply_markup'] as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [])
    .flat().map((b) => b.callback_data ?? '');

const CHAT = '424242';
function cfg(extra: Record<string, unknown> = {}): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-315', chatId: CHAT }, leaderLine: true, ...extra } } as AshlrConfig;
}
function textEvent(text: string, messageId = 77, replyTo?: number): InboundEvent {
  return { kind: 'text', text, fromChatId: CHAT, messageId, ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}) } as InboundEvent;
}

// New York wall-clock times on 2026-09-27 (EDT = UTC-4).
const ET = (hhmm: string): number => Date.parse(`2026-09-27T${hhmm}:00-04:00`);
const VERSE = 'ashlrai/ashlr-hub';

// ---------------------------------------------------------------------------
// Recorded-state fixtures
// ---------------------------------------------------------------------------

function briefSources(over: Partial<BriefSources> = {}): BriefSources {
  return {
    digest: {
      ledger: async () => [
        { kind: 'merge:landed', at: new Date(ET('06:00')).toISOString(), repo: VERSE, data: { repo: VERSE, prNumber: 541, proposalId: null } },
        { kind: 'pr:opened', at: new Date(ET('06:30')).toISOString(), repo: VERSE, data: { repo: VERSE, number: 542 } },
      ],
      appliedProposals: () => [],
      proposalTitle: () => null,
      cloudTasks: () => [],
      capacity: () => null,
      memos: () => [],
    },
    leader: () => ({
      health: { status: 'healthy', summary: 'ok' },
      latest: { id: 'lm-20260927063000-abcdef', at: new Date(ET('06:30')).toISOString(), status: 'ok', move: { statement: 'Ship the instant brief before anything else' } },
      actions: [
        { id: 'la-20260927063000-abcdef-0', class: 'B', status: 'scheduled', summary: 'Cloud: brief links', applyAfter: new Date(ET('10:30')).toISOString(), createdAt: new Date(ET('10:00')).toISOString() },
      ],
    }),
    cloudTasks: () => [{ id: 'ct_1', title: 'Fix the tracker', repo: VERSE, state: 'pr-open', updatedAt: new Date(ET('07:00')).toISOString(), pr: { url: 'https://github.com/ashlrai/ashlr-hub/pull/543', state: 'open' } }],
    devinTasks: () => [],
    openQuestion: () => ({ questionId: 'lm-20260927063000-abcdef:0', text: 'Should we move the budget to balanced?' }),
    driveReport: () => null,
    holds: () => [],
    autonomy: () => ({ on: true, mode: 'autonomous' }),
    ...over,
  };
}

let home = '';
const savedHome = process.env['HOME'];

function lineDeps(over: Partial<LeaderLineDeps> = {}): Partial<LeaderLineDeps> {
  return {
    now: () => ET('10:00'),
    briefSources: briefSources(),
    narrative: async () => 'The brief ships today; everything else waits.',
    isAnswered: () => false,
    driveReport: () => null,
    markDriveReportPosted: () => undefined,
    events: async () => [],
    leaderHealth: () => null,
    taskStatus: async () => null,
    thread: async () => (await import('../src/core/vision/leader-thread.js')) as never,
    ...over,
  };
}

let telegramNow = 0;

beforeEach(() => {
  telegramNow = 0;
  // Exercise actual-attempt pacing with a virtual monotonic clock, not a
  // fake-transport bypass or larger timeout.
  setTelegramSendClockForTests({
    now: () => telegramNow,
    sleep: async (ms) => { telegramNow += ms; },
  });
  home = mkdtempSync(join(tmpdir(), 'ashlr-line315-'));
  process.env['HOME'] = home;
  calls = [];
  nextMessageId = 5000;
  thread.outbound = [];
  thread.delivered = [];
  thread.posted = [];
  thread.answerLeaderQuestion.mockReset();
  // This suite's briefSources explicitly supplies a legacy canonical question.
  // Missing mock exports are unavailable capability, not a valid legacy row.
  thread.readLeaderQuestion.mockReset();
  thread.readLeaderQuestion.mockImplementation((questionId: string) => ({ questionId,
    text: 'Should we move the budget to balanced?', askedAt: new Date(ET('06:30')).toISOString(),
    messageId: null, answered: false, answer: null }));
  thread.appendMasonMessage.mockReset();
  thread.approveLeaderAction.mockReset();
  setTelegramTransportForTests(fakeTransport);
  setLeaderLineDepsForTest(lineDeps());
});

afterEach(() => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  setLeaderLineDepsForTest(null);
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Brief composition
// ---------------------------------------------------------------------------

describe('brief — composed from recorded state, with links', () => {
  it('shipped, running, blockers, next and one question, phone-sized', async () => {
    const facts = await gatherBriefFacts(ET('00:00'), ET('08:05'), briefSources());
    const text = composeBrief('morning', facts, { narrative: 'One line of narrative.' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Morning brief · Sun, Sep 27');
    expect(text).toContain('Shipped: 1 — ashlrai/ashlr-hub#541 https://github.com/ashlrai/ashlr-hub/pull/541 · 1 PR opened');
    expect(text).toContain('Running: 1 — cloud "Fix the tracker" (PR open) https://github.com/ashlrai/ashlr-hub/pull/543');
    expect(text).toContain('Blockers: none.');
    expect(text).toContain('Next: Ship the instant brief before anything else · "Cloud: brief links" applies 10:30 unless you veto');
    expect(text).toContain('Q: Should we move the budget to balanced? (reply to answer)');
    expect(lines[lines.length - 1]).toBe('One line of narrative.');
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(facts.pendingActionIds).toEqual(['la-20260927063000-abcdef-0']);
  });

  it('names blockers honestly: Leader degraded, reverts, holds, autonomy off', async () => {
    const facts = await gatherBriefFacts(ET('00:00'), ET('19:05'), briefSources({
      leader: () => ({ health: { status: 'degraded', summary: 'grok timed out twice' }, latest: null, actions: [] }),
      holds: () => [{ repo: VERSE, kind: 'leader-pause', reason: 'red CI' }],
      autonomy: () => ({ on: false, mode: null }),
      openQuestion: () => null,
      cloudTasks: () => [],
      digest: { ...briefSources().digest!, ledger: async () => [{ kind: 'revert:landed', at: new Date(ET('09:00')).toISOString(), repo: VERSE, data: { repo: VERSE, prNumber: 530, kind: 'revert' } }] },
    }));
    const text = composeBrief('evening', facts);
    expect(text.split('\n')[0]).toMatch(/^Evening recap · /);
    expect(text).toContain('Shipped: nothing merged today.');
    expect(text).toMatch(/Blockers: Leader degraded: grok timed out twice; reverted ashlrai\/ashlr-hub#530 https:\/\/github.com\/ashlrai\/ashlr-hub\/pull\/530; 1 repo hold/);
    expect(text).not.toContain('Q:');
  });
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe('pacing — quiet hours, caps, one question at a time', () => {
  const lc = resolveLineConfig(cfg());
  const empty = (): LineStateV1 => readLineState();

  it('config defaults: 08:00 / 19:00 New York, quiet 23–07, 6 pings a day', () => {
    expect(lc).toMatchObject({ enabled: true, morning: { h: 8, m: 0 }, evening: { h: 19, m: 0 }, timeZone: 'America/New_York', quiet: { start: 23, end: 7 }, maxPingsPerDay: 6, repo: VERSE });
    expect(resolveLineConfig(cfg({ briefTimes: ['06:45', '18:30'], timeZone: 'Nope/Zone' }))).toMatchObject({ morning: { h: 6, m: 45 }, evening: { h: 18, m: 30 }, timeZone: 'America/New_York' });
    // Under the test runner the line is off unless switched on explicitly.
    expect(resolveLineConfig({ comms: { enabled: true } } as AshlrConfig).enabled).toBe(false);
  });

  it('quiet hours wrap midnight in Mason\'s timezone', () => {
    expect(inQuietHours(ET('23:30'), lc)).toBe(true);
    expect(inQuietHours(ET('03:00'), lc)).toBe(true);
    expect(inQuietHours(ET('07:00'), lc)).toBe(false);
    expect(inQuietHours(ET('22:59'), lc)).toBe(false);
  });

  it('a brief is due once per slot per day, and a long-missed slot is skipped', () => {
    const s = empty();
    expect(dueBrief(ET('07:59'), lc, s)).toBeNull();
    expect(dueBrief(ET('08:05'), lc, s)).toBe('morning');
    expect(dueBrief(ET('11:30'), lc, s)).toBeNull(); // missed by > 3 h
    expect(dueBrief(ET('19:10'), lc, s)).toBe('evening');
    expect(dueBrief(ET('08:30'), lc, { ...s, briefs: { morning: '2026-09-27', evening: null } })).toBeNull();
  });

  it('pings: quiet hours hold all but urgent; a daily cap and a minimum gap', () => {
    const s = empty();
    expect(pingAllowed(ET('23:30'), lc, s, 'normal')).toEqual({ ok: false, reason: 'quiet hours' });
    expect(pingAllowed(ET('23:30'), lc, s, 'requested').ok).toBe(false);
    expect(pingAllowed(ET('23:30'), lc, s, 'urgent').ok).toBe(true);
    const recent = { ...s, pings: [{ at: new Date(ET('09:50')).toISOString(), key: 'a', urgent: false }] };
    expect(pingAllowed(ET('10:00'), lc, recent, 'normal').reason).toBe('too soon after the last ping');
    expect(pingAllowed(ET('10:00'), lc, recent, 'requested').ok).toBe(true);
    const full = { ...s, pings: Array.from({ length: 6 }, (_, i) => ({ at: new Date(ET(`0${i + 1}:00`)).toISOString(), key: `k${i}`, urgent: false })) };
    expect(pingAllowed(ET('12:00'), lc, full, 'normal').reason).toBe('daily ping cap reached');
    const storm = { ...s, pings: Array.from({ length: 4 }, (_, i) => ({ at: new Date(ET(`0${i + 1}:00`)).toISOString(), key: `u${i}`, urgent: true })) };
    expect(pingAllowed(ET('12:00'), lc, storm, 'urgent').ok).toBe(false);
  });

  it('the drain gate: replies always go; a second question waits for the first answer; quiet hours hold', () => {
    const s = { ...empty(), question: { questionId: 'lm-20260927063000-abcdef:0', sentAt: new Date(ET('09:00')).toISOString() } };
    const q2 = { kind: 'question' as const, questionId: 'lm-20260927063000-abcdef:1' };
    expect(gateThreadMessage(q2, ET('10:00'), lc, s, () => false)).toBe('hold');
    expect(gateThreadMessage(q2, ET('10:00'), lc, s, () => true)).toBe('send');
    expect(gateThreadMessage(q2, ET('10:00') + 86_400_000, lc, s, () => false)).toBe('send'); // held at most 24 h
    expect(gateThreadMessage({ kind: 'memo' }, ET('23:30'), lc, s, () => true)).toBe('hold');
    expect(gateThreadMessage({ kind: 'message', replyTo: 'lt-20260927140000-aaaaaa' }, ET('23:30'), lc, s, () => false)).toBe('send');
    expect(isYesNoQuestion('Should we move the budget to balanced?')).toBe(true);
    expect(isYesNoQuestion('Which repo should go first?')).toBe(false);
    expect(isYesNoQuestion('Should we pause?  Explain.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The proactive line
// ---------------------------------------------------------------------------

describe('runLeaderLine — briefs and reports on schedule, never nagging', () => {
  it.each(['typed', 'missing'] as const)('does not consume a %s canonical question as a legacy brief prompt', async state => {
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('08:05'),
      thread: async () => ({ readLeaderQuestion: () => state === 'missing' ? null : {
        questionForm: { schemaVersion: 1, revision: Array(8).fill('a'.repeat(8)).join('-'), mode: 'single', options: ['Yes'],
          expiresAt: new Date(ET('08:05') + 60_000).toISOString() },
      } }) as never,
    }));
    expect((await runLeaderLine(cfg())).brief).toBe('morning');
    expect(texts()[0]).not.toMatch(/^Q: /m);
    expect(readLineState().question).toBeNull();
    expect(thread.delivered).toEqual([]);
    expect(keyboardData(sends()[0]!).some(data => data.startsWith('lt:y:'))).toBe(false);
  });

  it('sends the morning brief once, with Approve / Veto for the pending launch', async () => {
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('08:05') }));
    const first = await runLeaderLine(cfg());
    expect(first.brief).toBe('morning');
    expect(texts()[0]).toMatch(/^Morning brief · /);
    expect(texts()[0]).toContain('The brief ships today; everything else waits.');
    expect(keyboardData(sends()[0]!).map((d) => d.replace(/\d+$/, ''))).toEqual(['lt:a:', 'lt:v:', 'lt:d:']);
    // The question rode along: it is now the one outstanding question.
    expect(readLineState().question?.questionId).toBe('lm-20260927063000-abcdef:0');
    const second = await runLeaderLine(cfg());
    expect(second.brief).toBeNull();
    expect(sends()).toHaveLength(1);
  });

  it('holds the self-improvement report through quiet hours, then posts it with buttons', async () => {
    let posted: string | null = null;
    const report = { day: '2026-09-27', text: 'Self-improvement — 1 move on Ashlr Verse today:\n• [cloud] Fix X — launches 10:30 unless you veto', actionIds: ['la-20260927090000-abcdef-0'], postedAt: null };
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('23:30'), driveReport: () => (posted ? { ...report, postedAt: posted } : report), markDriveReportPosted: (day) => { posted = day; } }));
    expect((await runLeaderLine(cfg())).driveReport).toBe(false);
    expect(sends()).toHaveLength(0);
    // 12:30: past the morning brief's window, so the report is the only message.
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('12:30'), driveReport: () => (posted ? { ...report, postedAt: posted } : report), markDriveReportPosted: (day) => { posted = day; } }));
    expect((await runLeaderLine(cfg())).driveReport).toBe(true);
    expect(texts()[0]).toMatch(/^Self-improvement/);
    expect(keyboardData(sends()[0]!)[0]).toMatch(/^lt:a:/);
    expect((await runLeaderLine(cfg())).driveReport).toBe(false);
  });

  it('pings a revert that failed even in quiet hours, but folds a plain merge into the brief', async () => {
    setLeaderLineDepsForTest(lineDeps({
      now: () => ET('02:00'),
      events: async () => [
        { key: 'pr:x#1:merged', kind: 'merge', text: 'x#1' },
        { key: 'revert-failed:L1', kind: 'revert-failed', text: 'ashlrai/ashlr-hub: revert FAILED — conflict' },
      ],
    }));
    const res = await runLeaderLine(cfg());
    expect(res.pings).toBe(1);
    expect(texts()[0]).toMatch(/^Urgent: ashlrai\/ashlr-hub: revert FAILED/);
    // Seen events are not pinged twice.
    await runLeaderLine(cfg());
    expect(sends()).toHaveLength(1);
  });

  it('is silent when switched off', async () => {
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('08:05') }));
    expect(await runLeaderLine(cfg({ leaderLine: false }))).toEqual({ brief: null, pings: 0, driveReport: false });
    expect(sends()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mason → the line
// ---------------------------------------------------------------------------

describe('routing Mason\'s texts', () => {
  it('"what\'s up" answers at once with the instant brief, as a reply', async () => {
    await converseWithLeader(textEvent("what's up?", 91), "what's up?", cfg());
    expect(texts()[0]).toMatch(/^Status · 10:00/);
    expect((sends()[0]!.body['reply_parameters'] as { message_id?: number })?.message_id).toBe(91);
    expect(thread.appendMasonMessage).not.toHaveBeenCalled();
  });

  it('"more" sends the rest of the last long reply', async () => {
    const state = readLineState();
    state.lastFull = { text: Array.from({ length: 10 }, (_, i) => `point ${i + 1}`).join('\n'), at: new Date().toISOString() };
    writeLineState(state, Date.now());
    await converseWithLeader(textEvent('more'), 'more', cfg());
    expect(texts()[0]).toContain('point 10');
  });

  it('More sends the complete stored long-line and >30-line answer through the existing splitter', async () => {
    const full = [
      '&😀'.repeat(250),
      ...Array.from({ length: 45 }, (_, i) => `point ${i + 1}: ${'detail '.repeat(12)}`.trimEnd()),
      'Full tail: 2499.91 credits, 12,345 tokens, $0.50 😀',
    ].join('\n');
    const state = readLineState();
    state.lastFull = { text: full, at: new Date().toISOString() };
    writeLineState(state, Date.now());
    await converseWithLeader(textEvent('more', 93), 'more', cfg());
    expect(sends().length).toBeGreaterThan(1);
    expect(texts().join('\n')).toBe(full);
    for (const call of sends()) expect(String(call.body['text']).length).toBeLessThanOrEqual(4096);
    expect(sends()[0]!.body['reply_parameters']).toMatchObject({ message_id: 93 });
    expect(sends().slice(1).every((call) => call.body['reply_parameters'] === undefined)).toBe(true);
    expect(readLineState().lastFull).toEqual(state.lastFull);
    expect(thread.appendMasonMessage).not.toHaveBeenCalled();
    expect(thread.posted).toHaveLength(0);
  });

  it('a partial More send consumes the intent without replay, composition or clearing the full answer', async () => {
    // Ordinary prose reaches splitting; long base64-looking runs are scrubbed
    // as possible secrets before any transport contact.
    const first = 'first '.repeat(580).trimEnd();
    const second = 'second '.repeat(585).trimEnd();
    const state = readLineState();
    state.lastFull = { text: `${first}\n${second}\nUnsent tail 😀`, at: new Date().toISOString() };
    writeLineState(state, Date.now());
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'sendMessage' && sends().length === 1) {
        calls.push({ method, body });
        return { ok: false, error_code: 500, description: 'synthetic unavailable' };
      }
      return fakeTransport(method, body);
    });
    await converseWithLeader(textEvent('more'), 'more', cfg());
    expect(sends()).toHaveLength(2);
    expect(texts()[0]).toBe(first);
    expect(texts().join('\n')).not.toContain('Unsent tail');
    expect(thread.appendMasonMessage).not.toHaveBeenCalled();
    expect(thread.posted).toHaveLength(0);
    expect(readLineState().lastFull).toEqual(state.lastFull);
    expect(readLineState().watches).toHaveLength(0);
  });

  it('chat still goes to the Leader thread (and the reply is kept phone-sized)', async () => {
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'lt-20260927140000-bbbbbb' },
      reply: { id: 'lt-20260927140000-cccccc', from: 'leader', channel: 'telegram', kind: 'message', text: Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') },
    });
    await converseWithLeader(textEvent('how do you feel about the roadmap?'), 'how do you feel about the roadmap?', cfg());
    expect(thread.appendMasonMessage).toHaveBeenCalledOnce();
    const sent = texts()[0]!;
    expect(sent.split('\n').length).toBeLessThanOrEqual(8);
    expect(sent).toMatch(/say "more"/);
    expect(readLineState().lastFull?.text).toContain('l12');
  });

  it('a clipped one-line reply retains the full answer for the existing More route', async () => {
    const full = `${'x'.repeat(398)}😀 remaining 12,345 tokens at $0.50`;
    thread.appendMasonMessage.mockResolvedValue({
      message: { id: 'lt-20260927140000-bbbbbb' },
      reply: { id: 'lt-20260927140000-cccccc', from: 'leader', channel: 'telegram', kind: 'message', text: full },
    });
    await converseWithLeader(textEvent('explain the result'), 'explain the result', cfg());
    expect(texts()[0]).toContain('say "more"');
    expect(texts()[0]).not.toContain('remaining');
    expect(readLineState().lastFull?.text).toBe(`Leader:\n${full}`);
    expect(thread.appendMasonMessage).toHaveBeenCalledWith('explain the result', expect.objectContaining({ channel: 'telegram' }));
  });

  it('"go build X" becomes a real launch at once, acknowledged in one line, with a result ping later', async () => {
    const ledger = fakeLedger();
    const policy = makePolicy({ repos: [...makePolicy().repos, { nameWithOwner: VERSE, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }] as never });
    const { deps } = makeApplyDeps({ ledger, now: () => ET('10:00'), policy: () => policy });
    const launched: string[] = [];
    const powers: LeaderPowersPorts = {
      cloud: { launch: async (req) => { launched.push(req.title); return { ok: true, taskId: 'ct_20260927T1400_zz9', url: 'https://claude.ai/code/session_9', detail: 'Cloud task ct_20260927T1400_zz9 — https://claude.ai/code/session_9.' }; } },
    };
    deps.powers = powers;
    let taskState = 'running';
    setLeaderLineDepsForTest(lineDeps({
      now: () => ET('12:30'), // outside the morning brief's window: only the result pings go out
      apply: async () => deps,
      laneBudget: async () => ({ mode: 'balanced', cloud: { ok: true, reason: null }, devin: null }),
      taskStatus: async (lane, id) => (lane === 'cloud' && id === 'ct_20260927T1400_zz9' ? { state: taskState, url: 'https://github.com/ashlrai/ashlr-hub/pull/550', reason: null } : null),
    }));

    await converseWithLeader(textEvent('go build an instant brief for status requests with links and tests', 92), 'go build an instant brief for status requests with links and tests', cfg());
    expect(launched).toEqual(['Build an instant brief for status requests with links and tests']);
    // A paid launch is acknowledged at once, then reported.
    expect(texts()[0]).toBe('Launching a cloud session for "Build an instant brief for status requests with links and tests" on ashlrai/ashlr-hub…');
    expect(texts()[1]).toMatch(/^On it\. Cloud session launched on ashlrai\/ashlr-hub: "Build an instant brief/);
    expect(texts()[1]).toContain('https://claude.ai/code/session_9');
    expect(texts()[1]!.split('\n').length).toBeLessThanOrEqual(2);
    expect(thread.posted[0]!['text']).toMatch(/^You asked: "build an instant brief/);
    expect(readLineState().watches).toHaveLength(1);
    // Mason's approval is on the ledger row.
    expect(ledger.rows('leader:action').some((r) => r.status === 'applied' && /Approved by Mason \(telegram\)/.test(r.statusReason ?? ''))).toBe(true);

    await runLeaderLine(cfg());
    expect(sends()).toHaveLength(2); // still running: no ping
    taskState = 'pr-open';
    await runLeaderLine(cfg());
    expect(texts()[2]).toBe('Cloud: "Build an instant brief for status requests with links and tests" — PR is up https://github.com/ashlrai/ashlr-hub/pull/550. Review when ready.');
    await runLeaderLine(cfg());
    expect(sends()).toHaveLength(3); // pinged once
  });

  it('falls back to the fleet when the paid lane says no, and says so', async () => {
    const ledger = fakeLedger();
    const policy = makePolicy({ repos: [...makePolicy().repos, { nameWithOwner: VERSE, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null }] as never });
    const { deps, units } = makeApplyDeps({ ledger, now: () => ET('10:00'), policy: () => policy });
    deps.powers = { cloud: { launch: async () => ({ ok: false, reason: '20 of 20 sessions used today.' }) } };
    setLeaderLineDepsForTest(lineDeps({ apply: async () => deps, laneBudget: async () => ({ mode: 'balanced', cloud: { ok: true, reason: null }, devin: null }) }));
    await handleTaskRequest(textEvent('x'), { text: 'build the weekly retro digest page with charts', repo: null, size: 'pr', lane: null }, cfg());
    expect(texts()[1]).toMatch(/^Cloud said no \(20 of 20 sessions used today\) — On it\. "Build the weekly retro digest page with charts" is queued for the fleet on ashlrai\/ashlr-hub/);
    expect(units.tasks.size).toBe(1);
  });

  it('outside the grant it says so plainly and starts nothing', async () => {
    const ledger = fakeLedger();
    const { deps } = makeApplyDeps({ ledger, now: () => ET('10:00'), policy: () => makePolicy() });
    let called = false;
    deps.powers = { cloud: { launch: async () => { called = true; return { ok: true, taskId: 't', url: null, detail: '' }; } } };
    setLeaderLineDepsForTest(lineDeps({ apply: async () => deps, laneBudget: async () => ({ mode: 'balanced', cloud: { ok: true, reason: null }, devin: null }) }));
    await handleTaskRequest(textEvent('x'), { text: 'build a status page for the whole portfolio', repo: null, size: 'pr', lane: 'cloud' }, cfg());
    expect(called).toBe(false);
    expect(texts()[1]).toMatch(/^Can't start "Build a status page/);
    expect(texts()[1]).toMatch(/not in the grant's current stage/);
  });
});

// ---------------------------------------------------------------------------
// Questions: one at a time, with buttons
// ---------------------------------------------------------------------------

describe('questions — one at a time, Yes / No / Your call', () => {
  const Q1 = 'lm-20260927063000-abcdef:0';
  const Q2 = 'lm-20260927063000-abcdef:1';

  it('the drain sends one yes/no question with buttons and holds the next', async () => {
    setLeaderLineDepsForTest(lineDeps({ now: () => ET('10:00'), isAnswered: () => false }));
    thread.outbound = [
      { id: 'lt-20260927100000-aaaaa1', at: new Date().toISOString(), from: 'leader', channel: 'system', kind: 'question', questionId: Q1, text: 'Should we move the budget to balanced?' },
      { id: 'lt-20260927100000-aaaaa2', at: new Date().toISOString(), from: 'leader', channel: 'system', kind: 'question', questionId: Q2, text: 'Should Devin take the tracker work?' },
    ];
    const hooks = await threadLineHooks(cfg());
    const res = await drainLeaderThread(cfg(), createPacer({ gapMs: 0, sleep: async () => undefined }), hooks);
    expect(res).toMatchObject({ sent: 1, skipped: 1 });
    expect(texts()[0]).toMatch(/Should we move the budget/);
    expect(keyboardData(sends()[0]!).map((d) => d.replace(/\d+$/, ''))).toEqual(['lt:y:', 'lt:n:', 'lt:c:']);
    expect(readLineState().question?.questionId).toBe(Q1);
  });

  it('a Yes tap answers the question through the thread', async () => {
    thread.answerLeaderQuestion.mockResolvedValue({
      message: { id: 'lt-20260927100000-bbbbb1' },
      reply: { id: 'lt-20260927100000-bbbbb2', from: 'leader', channel: 'telegram', kind: 'message', text: 'Balanced it is. Moving now.' },
    });
    const token = registerButtonTarget({ questionId: Q1 });
    const handled = await handleLeaderButton({ kind: 'callback', data: `lt:y:${token}`, fromChatId: CHAT, callbackQueryId: 'cq-1', messageId: 600 } as InboundEvent, cfg());
    expect(handled).toBe(true);
    expect(thread.answerLeaderQuestion).toHaveBeenCalledWith(Q1, 'Yes.', expect.objectContaining({ channel: 'telegram' }));
    expect(texts()).toContain('Leader:\nBalanced it is. Moving now.');
  });
});
