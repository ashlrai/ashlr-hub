/**
 * 3.16 — the Auto seat: prompt classification, the advisor's choice over the
 * seat router (interactive, never fleet), its ONE-line explanation, and what
 * moves it — cost weights per difficulty, cheap-first, stickiness, learning
 * from Mason's outcomes, fleet ROI, a local-only repo, a pin, a tool-less
 * local model — and what can never move it (an ineligible seat stays out).
 */
import { describe, expect, it } from 'vitest';

import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import { adviseSeat, weightsFor, type AdvisorSeat } from '../src/core/verse/multimodel/advisor.js';
import { classifyPrompt, estimateTokens } from '../src/core/verse/multimodel/classify.js';
import { aggregateOutcomes, compareOutcomes, learnedTilt, LEARNING_HALF_LIFE_MS } from '../src/core/verse/multimodel/learning.js';
import type { PromptClassification, SeatOutcome } from '../src/core/verse/multimodel/types.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const FRESH = new Date(NOW - 60_000).toISOString();
const POLICY: BudgetPolicy = { mode: 'balanced', seats: {}, updatedAt: new Date(0).toISOString() };

function paid(seatId: string, engine: 'claude' | 'codex' | 'grok', label: string, usedPercent: number, extra: Partial<SeatCapacity> = {}): AdvisorSeat {
  return {
    seatId,
    engine,
    label,
    model: `${engine}-model`,
    local: false,
    private: false,
    supportsTools: true,
    capacity: {
      seatId,
      engine,
      label,
      free: false,
      windows: [{ id: engine === 'claude' ? 'five_hour' : `${engine}_primary`, usedPercent, resetsAt: new Date(NOW + 3_600_000).toISOString(), resetDescription: null, limitReached: usedPercent >= 100 }],
      signedOut: false,
      reachable: true,
      contextWindow: 1_000_000,
      observedAt: FRESH,
      spentTodayUsd: null,
      ...extra,
    },
  };
}

function local(seatId: string, label: string, opts: { private?: boolean; tools?: boolean | null; window?: number } = {}): AdvisorSeat {
  return {
    seatId,
    engine: 'local',
    label,
    model: seatId.replace(/^local:/, ''),
    local: true,
    private: opts.private ?? true,
    supportsTools: opts.tools ?? null,
    capacity: {
      seatId, engine: 'local', label, free: true, windows: [], signedOut: false, reachable: true,
      contextWindow: opts.window ?? 65_536, observedAt: null, spentTodayUsd: null,
    },
  };
}

const CLAUDE = paid('claude', 'claude', 'Claude Max', 30);
const CODEX = paid('codex-personal', 'codex', 'Personal Codex', 20);
const GROK = paid('grok', 'grok', 'Grok', 10);
const QWEN = local('local:qwen3.6:27b', 'Qwen 27B (local)');
const SEATS = [CLAUDE, CODEX, GROK, QWEN];

function advise(text: string, extra: Partial<Parameters<typeof adviseSeat>[0]> = {}, cls?: PromptClassification) {
  return adviseSeat({
    classification: cls ?? classifyPrompt(text),
    seats: SEATS,
    policy: POLICY,
    mode: 'auto',
    nowMs: NOW,
    ...extra,
  });
}

describe('classifyPrompt', () => {
  it('reads kind, size and difficulty from the words, and says why', () => {
    const q = classifyPrompt('what does this function return?');
    expect(q).toMatchObject({ kind: 'explain', difficulty: 'low', size: 'small', task: 'code' });
    expect(q.label).toBe('quick explanation');

    const review = classifyPrompt('Can you review this diff for the auth middleware before I merge?');
    expect(review.kind).toBe('review');
    expect(review.task).toBe('review');
    expect(review.difficulty).toBe('high'); // auth is a hard subject
    expect(review.signals).toContain('asks for a review');

    const trace = classifyPrompt('it blows up:\n    at handler (src/server.ts:42:13)\n    at next (node_modules/x.js:1:1)');
    expect(trace.kind).toBe('debug');
    expect(trace.signals).toContain('stack trace');

    expect(classifyPrompt('design the architecture for the new sync engine').kind).toBe('plan');
    expect(classifyPrompt('design the architecture for the new sync engine').difficulty).toBe('high');
    expect(classifyPrompt('rename every test file across the repo to .spec.ts').kind).toBe('bulk');
    expect(classifyPrompt('fix the typo in the README').difficulty).toBe('low');
  });

  it('a small question deep into a long chat is not a small turn', () => {
    expect(classifyPrompt('why?').difficulty).toBe('low');
    const deep = classifyPrompt('why?', { contextTokens: 400_000 });
    expect(deep.difficulty).toBe('medium');
    expect(deep.signals).toContain('deep into a long chat');
  });

  it('size: large past ~2k tokens or four files named', () => {
    expect(classifyPrompt('x'.repeat(9_000)).size).toBe('large');
    expect(classifyPrompt('update @a.ts @b.ts @c.ts @d.ts').size).toBe('large');
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
  });
});

describe('adviseSeat — the choice and its one-line explanation', () => {
  it('a quick question goes to the free local model, and says so in one line', () => {
    const a = advise('what does this regex match?');
    expect(a.choice?.seatId).toBe(QWEN.seatId);
    expect(a.why).toBe('Qwen 27B (local) — quick explanation — no provider token charge on this Mac.');
    expect(a.why.split('\n')).toHaveLength(1);
    expect(a.stay).toBe(false);
    expect(a.alternatives.map((o) => o.seatId)).toEqual(expect.arrayContaining(['claude', 'codex-personal', 'grok']));
    expect(a.factors.some((f) => f.includes('interactive — fleet reserves do not apply to you'))).toBe(true);
    expect(a.factors.some((f) => f.startsWith('Cost weight ×3'))).toBe(true);
  });

  it('hard work uses admitted headroom with unknown quality rather than family tiers', () => {
    const a = advise('refactor the concurrency model of the scheduler across @a.ts and @b.ts');
    expect(a.classification.difficulty).toBe('high');
    expect(a.choice?.seatId).toBe(QWEN.seatId);
    expect(a.routerWhy).toContain('quality and comparable latency are unmeasured');
    // Flip the headroom and Claude wins the same message — no house favourite.
    const flipped = adviseSeat({
      classification: classifyPrompt('refactor the concurrency model of the scheduler across @a.ts and @b.ts'),
      seats: [paid('claude', 'claude', 'Claude Max', 10), paid('codex-personal', 'codex', 'Personal Codex', 60)],
      policy: POLICY, mode: 'auto', nowMs: NOW,
    });
    expect(flipped.choice?.seatId).toBe('claude');
    expect(flipped.alternatives[0]?.seatId).toBe('codex-personal');
  });

  it('Mason may use the fleet reserve: a Claude seat at 85% is still his (interactive), not held back', () => {
    const tight = paid('claude', 'claude', 'Claude Max', 85);
    const a = adviseSeat({ classification: classifyPrompt('architect the new billing system'), seats: [tight, GROK], policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(a.choice?.seatId).toBe('grok');
    expect(a.alternatives.map(option=>option.seatId)).toContain('claude');
    expect(a.held).toEqual([]);
  });

  it('a spent or signed-out seat is held back with its reason and cannot be chosen, pinned or learned into', () => {
    const spent = paid('claude', 'claude', 'Claude Max', 100);
    const out = paid('codex-personal', 'codex', 'Personal Codex', 10, { signedOut: true });
    const learned = aggregateOutcomes(Array.from({ length: 8 }, () => outcome('claude', 'claude', 'plan', 'up', NOW)), NOW);
    const a = adviseSeat({
      classification: classifyPrompt('architect the new billing system'),
      seats: [spent, out, GROK, QWEN], policy: POLICY, mode: 'auto', nowMs: NOW, pinnedSeatId: 'claude', learned,
    });
    expect(a.choice?.seatId).toBe(QWEN.seatId);
    expect(a.held.map((h) => h.seatId).sort()).toEqual(['claude', 'codex-personal']);
    expect(a.held.find((h) => h.seatId === 'codex-personal')?.reason).toMatch(/Signed out/);
    expect(a.alternatives.some((o) => o.seatId === 'claude')).toBe(false);
  });

  it('calls a spent Codex subscription an Auto funding exclusion, not a whole-account denial', () => {
    const spent = paid('codex-personal', 'codex', 'Personal Codex', 100);
    const a = adviseSeat({ classification: classifyPrompt('architect a scheduler'), seats: [spent, GROK],
      policy: POLICY, mode: 'auto', nowMs: NOW, pinnedSeatId: spent.seatId });
    expect(a.choice?.seatId).toBe('grok');
    expect(a.held).toEqual([{ seatId: spent.seatId, label: spent.label,
      reason: 'Subscription window spent; Auto does not select Codex credit-funded turns. Credit balance and manual access are separate.' }]);
    expect(a.alternatives.some((option) => option.seatId === spent.seatId)).toBe(false);
    const alone = adviseSeat({ classification: classifyPrompt('architect a scheduler'), seats: [spent],
      policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(alone.choice).toBeNull();
    expect(alone.why).toBe('Auto cannot route this work. Codex credit balance and manual access are separate.');
    expect(adviseSeat({ classification: classifyPrompt('architect a scheduler'), seats: [
      paid(spent.seatId, 'codex', spent.label, 100, { signedOut: true }), GROK],
      policy: POLICY, mode: 'auto', nowMs: NOW }).held[0]!.reason).toMatch(/Signed out/);
  });

  it('a request larger than a seat can hold is not sent there', () => {
    const small = local('local:tiny', 'Tiny (local)', { window: 8_192 });
    const a = adviseSeat({ classification: classifyPrompt('what is this?'), seats: [small, CODEX], policy: POLICY, mode: 'auto', nowMs: NOW, contextTokens: 50_000 });
    expect(a.choice?.seatId).toBe('codex-personal');
    expect(a.held[0]?.reason).toMatch(/Needs about 50k tokens of context/);
  });

  it('mid-conversation, the current seat gets a head start and the line says why it stays', () => {
    const a = advise('can you explain what this does?', { currentSeatId: 'claude', turnCount: 6 });
    expect(a.choice?.seatId).toBe('claude');
    expect(a.stay).toBe(true);
    expect(a.why).toBe('Staying on Claude Max — quick explanation, mid-conversation — moving would re-send the whole context; 70% of its 5-hour window left.');
    // In a fresh chat the same message goes to the free seat…
    expect(advise('can you explain what this does?').choice?.seatId).toBe(QWEN.seatId);
    // …cheap-first comes back down to it even mid-conversation…
    expect(advise('what is 2+2?', { currentSeatId: 'claude', turnCount: 6, mode: 'cheap-first' }).choice?.seatId).toBe(QWEN.seatId);
    // Hard work does not invent a stronger hosted model from its family name.
    const up = advise('architect the replication layer', { currentSeatId: QWEN.seatId, turnCount: 6 });
    expect(up.choice?.seatId).toBe(QWEN.seatId);
    expect(up.stay).toBe(true);
  });

  it('cheap-first leans hard on cost for ordinary work but not for hard work', () => {
    expect(weightsFor(classifyPrompt('add a null check to parseUser'), 'cheap-first').lambdaCost).toBe(4);
    expect(weightsFor(classifyPrompt('add a null check to parseUser'), 'auto').lambdaCost).toBe(1.5);
    expect(weightsFor(classifyPrompt('architect the sync engine'), 'cheap-first').lambdaCost).toBe(1);
    const a = advise('add a null check to parseUser', { mode: 'cheap-first' });
    expect(a.choice?.seatId).toBe(QWEN.seatId);
    expect(a.why).toContain('local resource with admitted capacity');
    // A confident "needs frontier" from the decision layer counts as hard.
    const cls = { ...classifyPrompt('add a null check to parseUser'), decidedBy: 'jev' as const, confidence: 0.92, needsFrontier: 0.9 };
    expect(advise('', { mode: 'cheap-first' }, cls).choice?.seatId).toBe(QWEN.seatId);
    expect(advise('', { mode: 'cheap-first' }, cls).factors[0]).toContain('labelled by Jev, 92% sure');
  });

  it('learns from outcomes: enough evidence re-orders a close call and the line credits it', () => {
    const cls = classifyPrompt('review my change to the parser');
    expect(cls.difficulty).toBe('medium');
    expect(advise('', {seats:[CLAUDE,CODEX]}, cls).choice?.seatId).toBe('codex-personal');
    const learned = aggregateOutcomes([
      ...Array.from({ length: 5 }, () => outcome('claude', 'claude', 'review', 'up', NOW - 3_600_000)),
      outcome('codex-personal', 'codex', 'review', 'down', NOW - 3_600_000),
      outcome('codex-personal', 'codex', 'review', 'auto-overridden', NOW - 3_600_000),
      outcome('codex-personal', 'codex', 'review', 'compare-lost', NOW - 3_600_000),
    ], NOW);
    const a = advise('', { learned, seats:[CLAUDE,CODEX] }, cls);
    expect(a.choice?.seatId).toBe('claude');
    expect(a.why).toBe("Claude Max — review; you've preferred Claude Max for reviews (5 of 5 signals positive); 70% of its 5-hour window left.");
    expect(a.factors).toContain("Learned: you've preferred Claude Max for reviews (5 of 5 signals positive).");
  });

  it('provider-aggregated fleet ROI stays diagnostic even with extreme ship rate and latency', () => {
    const cls = classifyPrompt('add a retry to the upload client');
    const roi = { claude: { dispatches: 40, shipRate: 0.9, avgLatencyMs: 60_000 }, codex: { dispatches: 40, shipRate: 0.3, avgLatencyMs: 90_000 } };
    const a = adviseSeat({ classification: cls, seats: [CLAUDE, CODEX], policy: POLICY, mode: 'auto', nowMs: NOW, roi });
    expect(a.choice?.seatId).toBe('codex-personal');
    expect(a.factors.some((f) => f.startsWith('Fleet record:'))).toBe(false);
    const plain=adviseSeat({classification:cls,seats:[CLAUDE,CODEX],policy:POLICY,mode:'auto',nowMs:NOW});
    expect(a).toEqual(plain);
    // Thin evidence moves nothing: headroom decides (Codex has more).
    const thin = { claude: { dispatches: 3, shipRate: 1, avgLatencyMs: null }, codex: { dispatches: 3, shipRate: 0, avgLatencyMs: null } };
    expect(adviseSeat({ classification: cls, seats: [CLAUDE, CODEX], policy: POLICY, mode: 'auto', nowMs: NOW, roi: thin }).choice?.seatId).toBe('codex-personal');
  });

  it('a local-only repo is routed over private local seats only — or not at all', () => {
    const a = advise('architect the new billing system', { localOnly: { on: true, reason: 'notes is listed in foundry.wiki.localOnlyRepos.' } });
    expect(a.choice?.seatId).toBe(QWEN.seatId);
    expect(a.why).toBe('Qwen 27B (local) — architecture planning on a local-only repo — stays on this Mac.');
    expect(a.alternatives).toEqual([]);
    expect(a.factors[0]).toBe('This repo is local-only — notes is listed in foundry.wiki.localOnlyRepos.');
    const remoteLocal = local('local:remote', 'Remote box', { private: false });
    const none = adviseSeat({ classification: classifyPrompt('hi'), seats: [CLAUDE, remoteLocal], policy: POLICY, mode: 'auto', nowMs: NOW, localOnly: { on: true, reason: null } });
    expect(none.choice).toBeNull();
    expect(none.why).toMatch(/local-only and no local model is running/);
  });

  it('a pin wins whenever that seat is eligible, and says so', () => {
    const a = advise('what does this regex match?', { pinnedSeatId: 'grok' });
    expect(a.choice?.seatId).toBe('grok');
    expect(a.why).toBe('Grok — you pinned this seat; 90% of its weekly window left.');
  });

  it('a local model that cannot use tools is last for edit work, and the line names it', () => {
    const noTools = local('local:chat', 'Chat-only (local)', { tools: false });
    const a = adviseSeat({ classification: classifyPrompt('fix the typo in the README'), seats: [noTools, GROK], policy: POLICY, mode: 'cheap-first', nowMs: NOW });
    expect(a.choice?.seatId).toBe('grok');
    expect(a.why).toContain('Chat-only (local) cannot use tools');
    // …but it is fine for a question.
    expect(adviseSeat({ classification: classifyPrompt('what is a monad?'), seats: [noTools, GROK], policy: POLICY, mode: 'auto', nowMs: NOW }).choice?.seatId).toBe('local:chat');
  });

  it('seats with no runnable model are never auto-picked', () => {
    const noModel = { ...CODEX, model: null };
    const a = adviseSeat({ classification: classifyPrompt('what is this?'), seats: [noModel, CLAUDE], policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(a.choice?.seatId).toBe('claude');
    expect([...a.alternatives, ...a.held].some((o) => o.seatId === 'codex-personal')).toBe(false);
  });

  it('no seats at all: a null choice with a sentence, never a throw', () => {
    const a = adviseSeat({ classification: classifyPrompt('hi'), seats: [], policy: POLICY, mode: 'auto', nowMs: NOW });
    expect(a.choice).toBeNull();
    expect(a.why).toMatch(/No seats are known/);
  });
});

function outcome(seatId: string, engine: string, kind: SeatOutcome['kind'], signal: SeatOutcome['signal'], atMs: number): SeatOutcome {
  return { at: new Date(atMs).toISOString(), seatId, engine, kind, signal };
}

describe('learning', () => {
  it('decays with a two-week half-life and needs three signals before it tilts', () => {
    const two = aggregateOutcomes([outcome('grok', 'grok', 'code', 'up', NOW), outcome('grok', 'grok', 'code', 'up', NOW)], NOW);
    expect(learnedTilt(two, 'code', { seatId: 'grok', engine: 'grok', label: 'Grok' }).tilt).toBe(0);
    const old = aggregateOutcomes([outcome('grok', 'grok', 'code', 'up', NOW - LEARNING_HALF_LIFE_MS)], NOW);
    expect(old['code|seat:grok']?.n).toBeCloseTo(0.5, 3);
    const many = aggregateOutcomes(Array.from({ length: 6 }, () => outcome('grok', 'grok', 'code', 'down', NOW)), NOW);
    const tilt = learnedTilt(many, 'code', { seatId: 'grok', engine: 'grok', label: 'Grok' });
    expect(tilt.tilt).toBeGreaterThan(0);
    expect(tilt.tilt).toBeLessThanOrEqual(1.5);
    expect(tilt.phrase).toBe("you've passed over Grok for code changes (0 of 6 signals positive)");
  });

  it('engine evidence fills in for a seat never used; malformed rows are skipped', () => {
    const table = aggregateOutcomes([
      ...Array.from({ length: 4 }, () => outcome('codex-work', 'codex', 'review', 'up', NOW)),
      { at: 'nope', seatId: 'x', engine: 'x', kind: 'review', signal: 'up' },
      { at: new Date(NOW).toISOString(), seatId: 'x', engine: 'x', kind: 'review', signal: 'bogus' as never },
    ], NOW);
    expect(table['review|seat:x']).toBeUndefined();
    expect(learnedTilt(table, 'review', { seatId: 'codex-personal', engine: 'codex', label: 'Personal Codex' }).tilt).toBeLessThan(0);
  });

  it('a Compare pick is one win and a loss for each other answer', () => {
    const rows = compareOutcomes('s2', [
      { sessionId: 's1', seatId: 'claude', engine: 'claude' },
      { sessionId: 's2', seatId: 'codex-personal', engine: 'codex', model: 'gpt-5.5' },
      { sessionId: 's3', seatId: 'local:q', engine: 'local' },
    ], 'code', new Date(NOW).toISOString());
    expect(rows.map((r) => [r.seatId, r.signal])).toEqual([['claude', 'compare-lost'], ['codex-personal', 'compare-won'], ['local:q', 'compare-lost']]);
    expect(rows[1]?.model).toBe('gpt-5.5');
  });
});
