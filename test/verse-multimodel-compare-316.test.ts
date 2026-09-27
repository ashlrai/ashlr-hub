/**
 * 3.16 — Compare fan-out (with fake seats), cross-family review, cheap-first
 * escalation (triage + draft assessment), and the per-chat meter's accounting
 * across every seat a conversation touched.
 */
import { describe, expect, it } from 'vitest';

import {
  COMPARE_MAX_SEATS,
  comparePrompt,
  crossFamilyReviewer,
  defaultCompareSet,
  fanOut,
  normalizeTargets,
  reviewPrompt,
  type CompareTarget,
} from '../src/core/verse/multimodel/compare.js';
import { classifyPrompt } from '../src/core/verse/multimodel/classify.js';
import { assessDraft, ESCALATE_BELOW, escalationPrompt, listCostUsd, triage } from '../src/core/verse/multimodel/escalation.js';
import { buildChatMeter, threadOf, THREAD_MAX_SESSIONS } from '../src/core/verse/multimodel/meter.js';
import type { SeatAdviceOption, ThreadLink } from '../src/core/verse/multimodel/types.js';
import type { VerseSession } from '../src/core/verse/types.js';

const opt = (seatId: string, engine: string, local = false): SeatAdviceOption => ({ seatId, label: seatId, engine, model: `${seatId}-m`, local, note: '' });
const target = (seatId: string, engine = seatId.split('-')[0]!): CompareTarget => ({ seatId, engine, label: seatId, model: null });

describe('Compare fan-out with fake seats', () => {
  it('sends the same prompt to every seat in parallel, links each chat, and one failure never sinks the others', async () => {
    const created: string[] = [];
    const sent: Array<{ id: string; text: string }> = [];
    const linked: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const entries = await fanOut([target('claude'), target('codex-personal', 'codex'), target('local:q', 'local'), target('grok')], 'why is the build slow?', {
      async createSession(t) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (t.seatId === 'codex-personal') throw new Error('Signed out — reconnect this account.');
        created.push(t.seatId);
        return { id: `s-${t.seatId}` };
      },
      async sendTurn(id, text) { sent.push({ id, text }); },
      async link(child) {
        linked.push(child);
        if (child === 's-local:q') throw new Error('link store down');
      },
    });
    expect(entries).toHaveLength(COMPARE_MAX_SEATS); // capped at three, in caller order
    expect(peak).toBe(3); // parallel, not serial
    expect(entries.map((e) => [e.target.seatId, e.ok])).toEqual([['claude', true], ['codex-personal', false], ['local:q', true]]);
    const failed = entries[1]!;
    expect(failed.ok === false && failed.error).toBe('Signed out — reconnect this account.');
    expect(failed.sessionId).toBeNull();
    expect(sent).toEqual([{ id: 's-claude', text: 'why is the build slow?' }, { id: 's-local:q', text: 'why is the build slow?' }]);
    expect(linked).toEqual(['s-claude', 's-local:q']); // a link failure did not fail the answer
  });

  it('a turn refused after the chat was created reports the chat it created', async () => {
    const [entry] = await fanOut([target('claude')], 'x', {
      createSession: async () => ({ id: 's1' }),
      sendTurn: async () => { throw new Error('seat-not-ready'); },
    });
    expect(entry).toMatchObject({ ok: false, sessionId: 's1', error: 'seat-not-ready' });
  });

  it('dedupes seats and drops empty ids', () => {
    expect(normalizeTargets([target('a'), target('a'), { ...target('b'), seatId: '' }, target('c')]).map((t) => t.seatId)).toEqual(['a', 'c']);
  });

  it('default set: one seat per engine, plus one local voice (Claude + Codex + local)', () => {
    const set = defaultCompareSet(opt('claude', 'claude'), [opt('claude-b', 'claude'), opt('codex-personal', 'codex'), opt('grok', 'grok'), opt('local:q', 'local', true)]);
    expect(set.map((o) => o.seatId)).toEqual(['claude', 'codex-personal', 'local:q']);
    expect(defaultCompareSet(null, [opt('local:q', 'local', true), opt('local:g', 'local', true)]).map((o) => o.seatId)).toEqual(['local:q', 'local:g']);
  });

  it('mid-thread, each seat gets the handoff note before the request', () => {
    expect(comparePrompt('ship it?', null)).toBe('ship it?');
    expect(comparePrompt('ship it?', 'NOTE')).toBe('NOTE\n\n---\n\nThe request to answer now:\n\nship it?');
  });
});

describe('cross-family review', () => {
  it('picks the best-ranked seat of a different engine', () => {
    const ranked = [opt('claude-b', 'claude'), opt('codex-personal', 'codex'), opt('local:q', 'local', true)];
    expect(crossFamilyReviewer('claude', ranked)?.seatId).toBe('codex-personal');
    expect(crossFamilyReviewer('codex', ranked)?.seatId).toBe('claude-b');
    expect(crossFamilyReviewer('claude', [opt('claude-b', 'claude')])).toBeNull();
  });

  it('asks for an independent, read-only critique with a verdict line', () => {
    const text = reviewPrompt({ question: 'add caching', answer: 'I added an LRU.', authorLabel: 'Claude Max' });
    expect(text).toContain('another model (Claude Max)');
    expect(text).toContain('change nothing');
    expect(text).toContain('"Verdict: ship"');
    expect(text).toContain('The request was:\n\nadd caching');
    expect(text).toContain('The answer to review:\n\nI added an LRU.');
    const long = reviewPrompt({ answer: 'x'.repeat(30_000), authorLabel: 'A' });
    expect(long).toContain('…(truncated for review)');
  });
});

describe('cheap-first escalation', () => {
  it('triage sends hard, large and "needs frontier" work straight to a frontier seat', () => {
    expect(triage(classifyPrompt('what is a closure?'), { localAvailable: true }).route).toBe('local');
    expect(triage(classifyPrompt('architect the new sync engine'), { localAvailable: true })).toMatchObject({ route: 'frontier' });
    expect(triage(classifyPrompt('x '.repeat(5_000)), { localAvailable: true }).route).toBe('frontier');
    expect(triage({ ...classifyPrompt('rename a var'), needsFrontier: 0.85 }, { localAvailable: true }).reason).toMatch(/Jev says this needs a frontier model \(85%\)/);
    expect(triage(classifyPrompt('what is a closure?'), { localAvailable: false }).route).toBe('frontier');
  });

  it('a clean, complete draft is accepted', () => {
    const v = assessDraft({ text: 'A closure is a function that captures variables from its enclosing scope.', ok: true, classification: classifyPrompt('what is a closure?') });
    expect(v).toEqual({ escalate: false, confidence: 1, reasons: ['The draft reads complete.'] });
  });

  it('failure, emptiness, hedging, loops, truncation and code-less code answers escalate, each named', () => {
    const cls = classifyPrompt('add a retry to the upload client');
    expect(assessDraft({ text: 'anything', ok: false, classification: cls })).toMatchObject({ escalate: true, confidence: 0 });
    expect(assessDraft({ text: '   ', ok: true, classification: cls }).reasons).toEqual(['The local model returned nothing.']);
    const hedgy = assessDraft({ text: "I'm not sure what the upload client is. I don't know which retry policy you want, so I cannot help.", ok: true, classification: cls });
    expect(hedgy.escalate).toBe(true);
    expect(hedgy.reasons).toContain('The answer hedges 3 times.');
    const loop = assessDraft({ text: ['```ts', ...Array.from({ length: 4 }, () => 'await upload(file); // retry'), '```'].join('\n'), ok: true, classification: cls });
    expect(loop.reasons).toContain('The answer repeats itself.');
    const noCode = assessDraft({ text: 'You should wrap the call in a loop and back off exponentially between attempts, up to three times.', ok: true, classification: cls });
    expect(noCode.reasons).toContain('A code request got neither code nor edits.');
    expect(noCode.escalate).toBe(false); // one mild signal alone is not enough
    // …but edits made through tools count as an answer.
    expect(assessDraft({ text: 'Done — added the retry.', ok: true, classification: cls, toolUses: 2 }).reasons).toEqual(['The draft reads complete.']);
    const cut = assessDraft({ text: `${'word '.repeat(120)}and then the`, ok: true, classification: classifyPrompt('explain the scheduler') });
    expect(cut.reasons).toContain('The answer looks cut off.');
    expect(ESCALATE_BELOW).toBeGreaterThan(0.5);
  });

  it('the escalation turn quotes the draft and says why it was escalated', () => {
    const prompt = escalationPrompt('add a retry', 'line one\nline two', { escalate: true, confidence: 0.2, reasons: ['The answer hedges.'] }, 'Qwen 27B (local)');
    expect(prompt).toContain('add a retry');
    expect(prompt).toContain('A local model (Qwen 27B (local)) drafted an answer first; it was escalated because: The answer hedges.');
    expect(prompt).toContain('> line one\n> line two');
  });

  it('list-price arithmetic (cache reads at a tenth of input)', () => {
    expect(listCostUsd({ input: 1_000_000, output: 1_000_000 }, { inPerM: 3, outPerM: 15 })).toBe(18);
    expect(listCostUsd({ input: 0, output: 0, cacheRead: 1_000_000 }, { inPerM: 3, outPerM: 15 })).toBe(0.3);
  });
});

function session(id: string, engine: VerseSession['engine'], model: string, usage: { in: number; out: number; cacheRead?: number; cacheCreation?: number }, handoffFrom?: string): VerseSession {
  return {
    id, title: id, projectPath: '/repo', engine, accountId: engine, seatId: engine === 'local' ? `local:${model}` : engine, model,
    nativeSessionId: null, createdAt: '', updatedAt: '', status: 'idle', turnCount: 1,
    usage: { inputTokens: usage.in, outputTokens: usage.out, cacheReadTokens: usage.cacheRead ?? 0, cacheCreationTokens: usage.cacheCreation ?? 0, contextTokens: 0, contextWindow: null },
    lastError: null,
    ...(handoffFrom ? { handoffFrom: { sessionId: handoffFrom, title: handoffFrom } } : {}),
  };
}

const PRICES: Record<string, { inPerM: number; outPerM: number }> = { claude: { inPerM: 3, outPerM: 15 }, codex: { inPerM: 10, outPerM: 30 } };

describe('per-chat meter — budget accounting across seats', () => {
  const sessions = [
    session('draft', 'local', 'qwen', { in: 200_000, out: 100_000 }),
    session('frontier', 'claude', 'claude-sonnet-5', { in: 100_000, out: 20_000, cacheRead: 1_000_000, cacheCreation: 50_000 }, 'draft'),
    session('cmp-codex', 'codex', 'gpt-5.5', { in: 10_000, out: 5_000 }),
    session('cmp-grok', 'grok', 'grok-4', { in: 10_000, out: 5_000 }),
    session('unrelated', 'claude', 'claude-opus-5', { in: 9_999_999, out: 9_999_999 }),
  ];
  const links: ThreadLink[] = [
    { parentSessionId: 'frontier', childSessionId: 'cmp-codex', relation: 'compare', at: '' },
    { parentSessionId: 'frontier', childSessionId: 'cmp-grok', relation: 'compare', at: '' },
    { parentSessionId: 'ghost', childSessionId: 'frontier', relation: 'review', at: '' },
  ];

  it('walks handoffs both ways and links down, never into unrelated chats', () => {
    const thread = threadOf('frontier', sessions, links);
    expect(thread.map((t) => [t.session.id, t.relation])).toEqual([['frontier', 'root'], ['draft', 'handoff'], ['cmp-codex', 'compare'], ['cmp-grok', 'compare']]);
    expect(threadOf('missing', sessions, links)).toEqual([]);
    expect(threadOf('cmp-grok', sessions, links).map((t) => t.session.id)).toContain('draft');
  });

  it('sums tokens and list-price equivalents per seat, prices local work at the frontier rate as savings', () => {
    const meter = buildChatMeter({
      sessionId: 'frontier',
      sessions,
      links,
      priceOf: (engine) => PRICES[engine] ?? null,
      seats: [
        { seatId: 'claude', label: 'Claude Max', engine: 'claude', window: '5-hour 40% used', fleetShare: 'The fleet may use 60%; 40% is kept for your chats.' },
        { seatId: 'local:qwen', label: 'Qwen', engine: 'local', window: null, fleetShare: null },
        { seatId: 'grok-2', label: 'Unused', engine: 'grok', window: null, fleetShare: null },
      ],
      budgetMode: 'balanced',
    });
    const row = (id: string) => meter.sessions.find((s) => s.sessionId === id)!;
    // claude: (100k + 50k cache creation) * $3 + 1M cache read * $0.30 + 20k * $15 = 0.45 + 0.3 + 0.3
    expect(row('frontier')).toMatchObject({ inputTokens: 150_000, outputTokens: 20_000, cacheReadTokens: 1_000_000, listUsd: 1.05, local: false });
    expect(row('cmp-codex').listUsd).toBe(0.25);
    expect(row('cmp-grok').listUsd).toBeNull(); // seat-routed subscription: no per-token price
    expect(row('draft')).toMatchObject({ local: true, listUsd: null });
    expect(meter.totals.listUsd).toBe(1.3);
    expect(meter.totals.localTokens).toBe(300_000);
    // Saved = the local tokens at the DEAREST paid rate the thread used (codex): 200k*$10 + 100k*$30.
    expect(meter.totals.savedUsd).toBe(5);
    expect(meter.totals.inputTokens).toBe(150_000 + 200_000 + 10_000 + 10_000);
    expect(meter.seats.map((s) => s.seatId)).toEqual(['claude', 'local:qwen']); // only seats this thread used
    expect(meter.note).toMatch(/list-price equivalents/);
    expect(meter.budgetMode).toBe('balanced');
  });

  it('a lone local chat saves nothing it cannot price, and the walk is bounded', () => {
    const lone = buildChatMeter({ sessionId: 'draft', sessions: [sessions[0]!], links: [], priceOf: () => null, seats: [], budgetMode: 'reserve' });
    expect(lone.totals).toMatchObject({ listUsd: 0, savedUsd: 0, localTokens: 300_000 });
    const chain = Array.from({ length: THREAD_MAX_SESSIONS + 10 }, (_, i) => session(`s${i}`, 'local', 'q', { in: 1, out: 1 }, i > 0 ? `s${i - 1}` : undefined));
    expect(threadOf('s0', chain, [])).toHaveLength(THREAD_MAX_SESSIONS);
  });
});
