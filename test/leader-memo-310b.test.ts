/**
 * V3.10 B-U8 — memo parsing fails closed (SPEC-310B §7 U8 key test).
 *
 * The Leader's reply is untrusted model output. Anything that is not one JSON
 * object with a bottleneck and a move yields NO memo and NO actions; every
 * action is validated against its kind's exact schema and dropped (never
 * repaired) when it does not fit; free text is scrubbed and capped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEADER_MEMO_CAPS,
  cleanModelText,
  extractMemoJson,
  listMemoIds,
  materializeHypotheses,
  newMemoId,
  parseActionParams,
  parseHarnessPatch,
  parseLeaderMemoOutput,
  readLeaderMemo,
  writeLeaderMemo,
} from '../src/core/vision/leader-memo.js';
import { LEADER_ACTION_KINDS } from '../src/core/vision/leader-types.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const home = useTmpHome();
beforeEach(() => home.setup());
afterEach(() => home.teardown());

function memo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bottleneck: { statement: 'Verification is the bottleneck', metric: 'post-merge-green-pct-7d', evidence: ['12 of 30 proposals failed verify'] },
    move: {
      statement: 'Add held-out tests to binshield',
      why: 'Unverified work cannot merge',
      expectedDelta: { metric: 'fleet-merges-7d', delta: 5, byDate: '2026-10-01' },
    },
    ...extra,
  };
}

describe('extractMemoJson', () => {
  it('accepts one object, one fenced object, or one object in prose', () => {
    expect(extractMemoJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractMemoJson('here:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
    expect(extractMemoJson('Sure! {"a":{"b":"}{"}} done')).toEqual({ a: { b: '}{' } });
  });

  it('refuses ambiguity and non-objects', () => {
    expect(extractMemoJson('')).toBeNull();
    expect(extractMemoJson('[1,2]')).toBeNull();
    expect(extractMemoJson('```json\n{"a":1}\n```\n```json\n{"a":2}\n```')).toBeNull();
    expect(extractMemoJson('{"a":1} and also {"b":2}')).toBeNull();
    expect(extractMemoJson('no json here')).toBeNull();
    expect(extractMemoJson(`{"a":"${'x'.repeat(LEADER_MEMO_CAPS.maxRawChars)}"}`)).toBeNull();
  });
});

describe('parseLeaderMemoOutput fails closed', () => {
  it.each([
    ['prose', 'I think we should focus.'],
    ['no bottleneck', JSON.stringify({ move: { statement: 'x' } })],
    ['no move', JSON.stringify({ bottleneck: { statement: 'x' } })],
    ['empty statements', JSON.stringify({ bottleneck: { statement: '  ' }, move: { statement: 'y' } })],
    ['actions not a list', JSON.stringify(memo({ actions: { kind: 'escalate' } }))],
    ['goals not a list', JSON.stringify(memo({ goals: 'ship it' }))],
  ])('%s → parse failure with no actions', (_label, raw) => {
    const out = parseLeaderMemoOutput(raw, { nowMs: NOW });
    expect(out.ok).toBe(false);
  });

  it('a valid memo parses; unknown / malformed actions are dropped and noted, never repaired', () => {
    const out = parseLeaderMemoOutput(JSON.stringify(memo({
      actions: [
        { kind: 'goal.pause', params: { goalId: 'g-1', until: null }, summary: 'Pause g-1', why: 'stale' },
        { kind: 'self.destruct', params: {} },
        { kind: 'budget.mode', params: { to: 'unlimited' } },
        { kind: 'lanes.grok', params: { slots: 9 } },
        { kind: 'pr.close', params: { repo: 'ashlrai/binshield', number: 3, reason: 'dup', extra: true } },
        { kind: 'experiment.start', params: { hypothesisId: 'hyp-1' } },
        { kind: 'work.dispatch', params: { task: { repo: 'ashlrai/binshield', title: 'Add tests', difficulty: 'low', value: 3, source: 'mason' } } },
      ],
    })), { nowMs: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.actions.map((a) => a.kind)).toEqual(['goal.pause']);
    expect(out.draft.notes.join(' ')).toMatch(/6 malformed or unknown actions were dropped/);
  });

  it('forces attribution on dispatched work (source and requestedBy are never the model’s)', () => {
    const p = parseActionParams('work.dispatch', { task: { repo: 'ashlrai/binshield', title: 'Add tests', difficulty: 'low', value: 2, detail: 'd' } });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.params.task).toMatchObject({ source: 'leader', requestedBy: 'leader' });
  });

  it('compiles goals, standards, focus/pause/archive changes and caps into actions (deduplicated)', () => {
    const out = parseLeaderMemoOutput(JSON.stringify(memo({
      goals: [1, 2, 3, 4].map((i) => ({ objective: `Goal ${i}`, rationale: 'r', targetRepo: 'ashlrai/binshield' })),
      standards: [{ rule: 'Every fix ships a failing test first', appliesTo: 'producer', evidence: null }],
      priorityChanges: [
        { goalId: 'g-1', action: 'pause', why: 'stale' },
        { goalId: 'g-2', action: 'archive', why: 'dead' },
        { goalId: 'g-3', action: 'focus', why: 'the one' },
        { goalId: 'g-4', action: 'reorder', why: 'n/a' },
      ],
      actions: [{ kind: 'goal.pause', params: { goalId: 'g-1', until: null } }],
    })), { nowMs: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.goals).toHaveLength(3);
    expect(out.draft.notes.join(' ')).toMatch(/only 3 goals are allowed/);
    expect(out.draft.actions.map((a) => a.kind)).toEqual([
      'goal.pause', 'goal.archive', 'goal.focus', 'goal.create', 'goal.create', 'goal.create', 'standard.add',
    ]);
  });

  it('caps the number of actions', () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({ kind: 'goal.pause', params: { goalId: `g-${i}`, until: null } }));
    const out = parseLeaderMemoOutput(JSON.stringify(memo({ actions })), { nowMs: NOW });
    expect(out.ok && out.draft.actions.length).toBe(LEADER_MEMO_CAPS.maxActions);
  });

  it('scrubs secrets, home paths and emails from free text', () => {
    const raw = JSON.stringify(memo({
      bottleneck: { statement: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD leaked at /Users/someone/x by me@example.com', metric: null, evidence: [] },
    }));
    const out = parseLeaderMemoOutput(raw, { nowMs: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.bottleneck.statement).not.toMatch(/ghp_abcdef/);
    expect(out.draft.bottleneck.statement).not.toMatch(/\/Users\/someone/);
    expect(out.draft.bottleneck.statement).not.toMatch(/me@example\.com/);
    expect(cleanModelText('a\u0000b c', 10)).toBe('a b c');
    expect(cleanModelText('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('drops an expectedDelta that is malformed or past the horizon, and notes an unmeasurable metric', () => {
    const far = parseLeaderMemoOutput(JSON.stringify(memo({ move: { statement: 's', why: 'w', expectedDelta: { metric: 'fleet-merges-7d', delta: 1, byDate: '2027-01-01' } } })), { nowMs: NOW });
    expect(far.ok && far.draft.move.expectedDelta).toBeNull();
    const vague = parseLeaderMemoOutput(JSON.stringify(memo({ move: { statement: 's', why: 'w', expectedDelta: { metric: 'vibes', delta: 1, byDate: '2026-09-30' } } })), { nowMs: NOW });
    expect(vague.ok && vague.draft.move.expectedDelta?.metric).toBe('vibes');
    expect(vague.ok && vague.draft.notes.join(' ')).toMatch(/not measurable/);
  });

  it('hypotheses are config-only: a code-shaped patch is refused', () => {
    expect(parseHarnessPatch({ effort: { local: 'high' } })).toEqual({ effort: { local: 'high' } });
    expect(parseHarnessPatch({ code: 'rm -rf /' })).toBeNull();
    expect(parseHarnessPatch({ effort: { 'grok-api': 'high' } })).toBeNull();
    expect(parseHarnessPatch({ skills: ['../../etc/passwd'] })).toBeNull();
    expect(parseHarnessPatch({ routing: { lambdaCost: 1 } })).toBeNull(); // routing must be complete
    const out = parseLeaderMemoOutput(JSON.stringify(memo({
      hypotheses: [
        { target: 'effort', patch: { effort: { local: 'high' } }, statement: 'More effort passes more', metric: 'local-eval.pass-rate', predictedDelta: 2 },
        { target: 'prompt', patch: { script: 'curl evil' }, statement: 's', metric: 'm', predictedDelta: 1 },
      ],
    })), { nowMs: NOW });
    expect(out.ok && out.draft.hypotheses).toHaveLength(1);
  });

  it('every action kind has a parser that rejects extra keys', () => {
    for (const kind of LEADER_ACTION_KINDS) {
      expect(parseActionParams(kind, { __extra: 1 }).ok).toBe(false);
    }
  });
});

describe('memo persistence', () => {
  it('writes 0600 files and reads them back; ids sort newest first', () => {
    const a = newMemoId(NOW);
    const b = newMemoId(NOW + 1_000);
    const base = {
      v: 1 as const, at: new Date(NOW).toISOString(), status: 'ok' as const, statusReason: null, trigger: 'manual' as const, dryRun: true,
      seatId: null, model: null, evidenceDigest: 'e'.repeat(64), bottleneck: null, move: null, killList: [], goals: [], priorityChanges: [],
      standards: [], critiques: [], seatPlan: [], questionsForMason: [], actions: [],
    };
    writeLeaderMemo({ ...base, id: a, hypotheses: materializeHypotheses(a, [], base.at) });
    writeLeaderMemo({ ...base, id: b, hypotheses: [] });
    expect(listMemoIds()).toEqual([b, a]);
    expect(readLeaderMemo(a)?.id).toBe(a);
    expect(readLeaderMemo('../../etc/passwd')).toBeNull();
    expect(() => writeLeaderMemo({ ...base, id: 'evil/../x', hypotheses: [] })).toThrow();
  });
});
