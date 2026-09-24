import { describe, expect, it } from 'vitest';
import { citesSession, insightMatrix, insightRepos, reasoningTrendSeries, sessionInsights, topInsights } from './mind-model.js';
import { countdownText, expectedDeltaText, isVetoable, memoActions, outcomeMark, vetoWindowFraction } from './leader-model.js';
import { leaderState, reasoningDigest } from '../command/fixtures.test-support.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');

describe('insightMatrix', () => {
  it('counts kind × engine, keeps a measured engine\'s zero, and leaves an unmeasured engine unknown', () => {
    const d = reasoningDigest('live', NOW);
    const m = insightMatrix(d, null);
    expect(m.columns.map((c) => c.id)).toEqual(['claude', 'grok', 'local']);
    expect(m.columns[0]!.engine).toBe('claude');
    const loopRow = m.values[0]!;
    expect(loopRow).toEqual([6, 0, 0]);
    // An engine with no reasoning at all is unknown, not zero.
    const sparse = insightMatrix(reasoningDigest('sparse', NOW), null);
    expect(sparse.columns.map((c) => c.id)).toEqual(['claude']);
    const noClaude = { ...reasoningDigest('live', NOW), totals: { steps: 10, sessions: 1, byEngine: { grok: 10 } } };
    // win row: Claude reasoned nothing here (unknown); Grok reasoned, no wins (0); Local has 2 cited wins.
    expect(insightMatrix(noClaude, null).values[5]).toEqual([null, 0, 2]);
  });

  it('facets by repo', () => {
    const d = reasoningDigest('live', NOW);
    expect(insightRepos(d)).toEqual(['ashlr-hub', 'binshield', 'ashlrcode']);
    const hub = insightMatrix(d, 'binshield');
    expect(hub.values.flat().filter((v) => v !== null && v > 0)).toEqual([3, 2]);
  });
});

describe('insight cards and trends', () => {
  it('shows the three most severe non-win insights', () => {
    expect(topInsights(reasoningDigest('live', NOW)).map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });
  it('turns days with no reasoning into gaps', () => {
    const series = reasoningTrendSeries(reasoningDigest('sparse', NOW));
    expect(series[0]!.points[0]!.y).toBeNull();
    expect(series[0]!.points.at(-1)!.y).not.toBeNull();
  });
});

describe('session insight matching', () => {
  it('matches exact session ids in both evidence forms, never a prefix', () => {
    expect(citesSession({ evidence: [{ ref: 'session:s1#44', at: '' }] }, 's1')).toBe(true);
    expect(citesSession({ evidence: [{ ref: 'verse:s2:12', at: '' }] }, 's2')).toBe(true);
    expect(citesSession({ evidence: [{ ref: 'session:s12#4', at: '' }] }, 's1')).toBe(false);
    const d = reasoningDigest('live', NOW);
    expect(sessionInsights(d, 's1').map((i) => i.id)).toEqual(['i1']);
    expect(sessionInsights(d, 's2').map((i) => i.id)).toEqual(['i3']);
    expect(sessionInsights(d, 'nope')).toEqual([]);
  });
});

describe('leader-model', () => {
  it('orders actions A, B, C and knows which can be vetoed', () => {
    const list = memoActions(leaderState('live', NOW));
    expect(list.map((a) => a.class)).toEqual(['A', 'A', 'B', 'C']);
    expect(list.map(isVetoable)).toEqual([true, true, true, false]);
  });

  it('shrinks the veto window and says the time left', () => {
    const b = leaderState('live', NOW).actions.find((a) => a.class === 'B')!;
    expect(vetoWindowFraction(b, NOW)).toBeCloseTo(0.6, 1);
    expect(countdownText(b.applyAfter, NOW)).toBe('18m');
    expect(countdownText(b.applyAfter, Date.parse(b.applyAfter!) + 1)).toBe('applying…');
  });

  it('writes expected deltas and grades moves honestly', () => {
    expect(expectedDeltaText({ metric: 'merges/day', delta: 4, byDate: '2026-09-27T12:00:00Z' })).toMatch(/^\+4 merges\/day by Sun, Sep 27$/);
    const tl = leaderState('live', NOW).timeline;
    expect(tl.map(outcomeMark)).toEqual(['pending', 'pending', 'miss', 'hit', 'hit', 'ungraded', 'hit']);
  });
});
