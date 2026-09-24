import { describe, expect, it } from 'vitest';
import { citesSession, insightMatrix, insightRepos, reasoningTrendSeries, sessionInsights, topInsights } from './mind-model.js';
import { countdownText, expectedDeltaText, isVetoable, memoActions, outcomeMark, vetoWindowFraction } from './leader-model.js';
import { leaderState, reasoningDigest } from '../command/fixtures.test-support.js';
import { formatDayLabel, timeLabelLadder } from '../../../components/charts/format.js';
import { TEST_ZONES, inTimeZone } from '../growth/time-zone.test-support.js';

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

  it('offers ONE facet entry per folder, however the folder was spelled, and counts every spelling in it', () => {
    const live = reasoningDigest('live', NOW);
    // i2 (3×) and i4 (2×) are binshield's; record them under the two macOS spellings of one temp folder.
    const d = {
      ...live,
      insights: live.insights.map((i) => (i.id === 'i2' ? { ...i, repo: '/private/tmp/e2e/proj' } : i.id === 'i4' ? { ...i, repo: '/tmp/e2e/proj' } : i)),
    };
    const repos = insightRepos(d);
    expect(repos).toEqual(['ashlr-hub', '/private/tmp/e2e/proj', 'ashlrcode']);
    // Faceting on either spelling finds both insights.
    for (const facet of ['/private/tmp/e2e/proj', '/tmp/e2e/proj']) {
      expect(insightMatrix(d, facet).values.flat().filter((v) => v !== null && v > 0), facet).toEqual([3, 2]);
    }
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

  it('puts each day where the chart\'s local labels name that same day — west of UTC too', () => {
    const d = reasoningDigest('live', NOW);
    for (const zone of TEST_ZONES) {
      inTimeZone(zone, () => {
        const [struggles] = reasoningTrendSeries(d);
        // AreaTrend labels a time axis with formatTimeLabel (local) — its
        // default formatX and the ladder's only rung without a caller format.
        const ladder = timeLabelLadder(struggles!.points[0]!.x, struggles!.points.at(-1)!.x);
        expect(struggles!.points.map((p) => ladder.map((f) => f(p.x))), zone).toEqual(d.trends.map((t) => [formatDayLabel(t.day)]));
      });
    }
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
    // The deadline is an instant shown on the viewer's local day: noon local
    // on Sep 27 reads "Sun, Sep 27" in every zone (noon UTC is Mon east of UTC+12).
    expect(expectedDeltaText({ metric: 'merges/day', delta: 4, byDate: new Date(2026, 8, 27, 12).toISOString() })).toMatch(/^\+4 merges\/day by Sun, Sep 27$/);
    const tl = leaderState('live', NOW).timeline;
    expect(tl.map(outcomeMark)).toEqual(['pending', 'pending', 'miss', 'hit', 'hit', 'ungraded', 'hit']);
  });
});
