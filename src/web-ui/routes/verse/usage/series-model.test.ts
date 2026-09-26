/**
 * series-model.test.ts — the chart projections, pinned on the cases where
 * drawing something would be worse than drawing nothing.
 */
import { describe, expect, it } from 'vitest';
import { formatDayLabel, formatTimeLabel, timeLabelLadder } from '../../../components/charts/format.js';
import { calendarDayStart } from '../growth/calendar-day.js';
import { inTimeZone, TEST_ZONES } from '../growth/time-zone.test-support.js';
import type { DailyUsage, UsageSeries } from './usage-contract.js';
import { projectUsageSeries } from './usage-contract.js';
import {
  SERIES_TOO_THIN,
  buildCacheSeries,
  buildSpendSeries,
  buildTokenSeries,
  sparklinePoints,
  totalsFor,
} from './series-model.js';

function day(over: Partial<DailyUsage> & { day: string }): DailyUsage {
  return {
    tokensIn: 0,
    tokensOut: 0,
    estCostUsd: 0,
    sessions: 0,
    cacheRead: null,
    cacheWrite: null,
    cacheHitRate: null,
    ...over,
  };
}

function series(days: DailyUsage[]): UsageSeries {
  return { window: '7d', days, generatedAt: null, estimated: true, caveats: [] };
}

const THREE_DAYS = series([
  day({ day: '2026-09-17', tokensIn: 1_000, tokensOut: 400, estCostUsd: 1.5, sessions: 3, cacheHitRate: 0.6 }),
  day({ day: '2026-09-18', tokensIn: 2_000, tokensOut: 900, estCostUsd: 2.5, sessions: 5, cacheHitRate: 0.8 }),
  day({ day: '2026-09-19', tokensIn: 3_000, tokensOut: 1_100, estCostUsd: 4, sessions: 7 }),
]);

describe('totalsFor', () => {
  it('sums the window and reports the day count behind it', () => {
    expect(totalsFor(THREE_DAYS.days)).toEqual({
      tokensIn: 6_000,
      tokensOut: 2_400,
      estCostUsd: 8,
      sessions: 15,
      dayCount: 3,
    });
  });
});

describe('buildTokenSeries', () => {
  it('keeps tokens in and out as two named series, never summed away', () => {
    const projected = buildTokenSeries(THREE_DAYS);
    expect(projected.available).toBe(true);
    if (!projected.available) return;
    expect(projected.series.map((s) => s.id)).toEqual(['tokensIn', 'tokensOut']);
    expect(projected.series[0]?.points.map((p) => p.y)).toEqual([1_000, 2_000, 3_000]);
  });

  it('refuses a single day, which is a point and not a trend', () => {
    const projected = buildTokenSeries(series([day({ day: '2026-09-19', tokensIn: 5 })]));
    expect(projected).toEqual({ available: false, reason: SERIES_TOO_THIN });
  });

  it('refuses when no series has been loaded rather than drawing an empty axis', () => {
    expect(buildTokenSeries(null).available).toBe(false);
  });
});

describe('buildSpendSeries', () => {
  it('plots the estimated cost column as a single series', () => {
    const projected = buildSpendSeries(THREE_DAYS);
    expect(projected.available).toBe(true);
    if (!projected.available) return;
    expect(projected.series[0]?.label).toBe('Estimated spend');
    expect(projected.series[0]?.points.map((p) => p.y)).toEqual([1.5, 2.5, 4]);
  });
});

/**
 * A day bucket is a calendar date. The chart kit labels an x in LOCAL time,
 * so the bucket sits at local midnight (growth/calendar-day) — stamped at UTC
 * midnight, the "2026-09-24" bucket was labelled "Sep 23" on the axis and in
 * the tooltip everywhere west of UTC while the card's own table said
 * "Sep 24". Each check walks zones on both sides of UTC, whatever zone the
 * suite itself runs in.
 */
describe('day buckets — the axis names the same day as the table', () => {
  const DAYS = ['2026-09-23', '2026-09-24', '2026-12-31', '2027-01-01', '2026-03-08', '2026-11-01'];

  it('plots every bucket at its own calendar day, and every rung of the axis ladder names the table\u2019s day', () => {
    for (const zone of [...TEST_ZONES, 'America/Los_Angeles']) {
      inTimeZone(zone, () => {
        const projected = buildSpendSeries(series(DAYS.map((d, i) => day({ day: d, estCostUsd: i + 1 }))));
        expect(projected.available).toBe(true);
        if (!projected.available) return;
        const xs = projected.series[0]!.points.map((p) => p.x);
        expect(xs).toEqual(DAYS.map(calendarDayStart));
        DAYS.forEach((d, i) => {
          // The axis/tooltip label (SeriesPanel passes formatTimeLabel) is the table's label.
          expect(formatTimeLabel(xs[i]!), `${zone} ${d}`).toBe(formatDayLabel(d));
        });
        // The ladder's fallback rungs are local too, so no rung names another day.
        const [a, b] = [xs[0]!, xs[1]!];
        for (const rung of timeLabelLadder(a, b, formatTimeLabel, [a, b])) {
          expect(rung(a), zone).toBe('Sep 23');
          expect(rung(b), zone).toBe('Sep 24');
        }
      });
    }
  });
});

describe('buildCacheSeries — an absent rate is not a 0% hit rate', () => {
  it('refuses the chart entirely when no day reported a rate', () => {
    const projected = buildCacheSeries(
      series([day({ day: '2026-09-18' }), day({ day: '2026-09-19' })]),
    );
    expect(projected.available).toBe(false);
    if (projected.available) return;
    expect(projected.reason).toBe('No cache data in this window.');
  });

  it('refuses a lone reported day as a trend', () => {
    const projected = buildCacheSeries(
      series([day({ day: '2026-09-18', cacheHitRate: 0.5 }), day({ day: '2026-09-19' })]),
    );
    expect(projected.available).toBe(false);
    if (projected.available) return;
    expect(projected.reason).toMatch(/Only 1 day/);
  });

  it('leaves an unreported day as a gap in the line, not a zero', () => {
    const projected = buildCacheSeries(THREE_DAYS);
    expect(projected.available).toBe(true);
    if (!projected.available) return;
    expect(projected.series[0]?.points.map((p) => p.y)).toEqual([0.6, 0.8, null]);
  });
});

describe('sparklinePoints', () => {
  it('preserves gaps so a sparkline breaks rather than dipping to zero', () => {
    expect(sparklinePoints(THREE_DAYS, (d) => d.cacheHitRate)).toEqual([0.6, 0.8, null]);
  });

  it('is undefined for a series too short to trend', () => {
    expect(sparklinePoints(series([day({ day: '2026-09-19' })]), (d) => d.tokensIn)).toBeUndefined();
  });
});

describe('projectUsageSeries — tolerant of the shape owner T actually ships', () => {
  it('accepts the enveloped form and sorts the days', () => {
    const projected = projectUsageSeries(
      { window: '30d', days: [{ day: '2026-09-19', tokensIn: 2 }, { day: '2026-09-18', tokensIn: 1 }] },
      '7d',
    );
    expect(projected?.window).toBe('30d');
    expect(projected?.days.map((d) => d.day)).toEqual(['2026-09-18', '2026-09-19']);
  });

  it('accepts a bare array and falls back to the requested window', () => {
    const projected = projectUsageSeries([{ day: '2026-09-19', tokensIn: 2 }], '30d');
    expect(projected?.window).toBe('30d');
    expect(projected?.days).toHaveLength(1);
  });

  it('drops rows with no usable day key rather than inventing one', () => {
    const projected = projectUsageSeries({ days: [{ tokensIn: 5 }, { day: 'nonsense' }] }, '7d');
    expect(projected?.days).toEqual([]);
  });

  it('is null — not an empty chart — for a body it does not recognise', () => {
    expect(projectUsageSeries({ nope: true }, '7d')).toBeNull();
  });

  it('leaves an absent cache column null instead of defaulting it to 0', () => {
    const projected = projectUsageSeries({ days: [{ day: '2026-09-19', tokensIn: 1 }] }, '7d');
    expect(projected?.days[0]?.cacheHitRate).toBeNull();
    expect(projected?.days[0]?.cacheRead).toBeNull();
  });
});
