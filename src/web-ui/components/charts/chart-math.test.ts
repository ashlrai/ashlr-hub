import { describe, expect, it } from 'vitest';
import {
  MIN_PLAUSIBLE_TIME,
  MIN_TIME_SPAN_MS,
  allIntegers,
  axisTicks,
  calendarGrid,
  clamp,
  dodgeLabels,
  ensureSpan,
  isPlausibleTime,
  isTimeAxis,
  labelsFaithful,
  layoutAxisLabels,
  percentScale,
  xKeeper,
  funnelSteps,
  gaugeArc,
  gaugeSeverity,
  heatBucket,
  linearScale,
  niceTicks,
  projectBurnDown,
  roundedRightBar,
  roundedTopBar,
  splitRuns,
  stackColumn,
  thinIndexes,
} from './chart-math.js';

describe('niceTicks', () => {
  it('produces clean steps that cover the domain', () => {
    expect(niceTicks(0, 930, 4)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6, 8]);
    // V3.10.1: 0.2 steps, not 0.25 — a 0.25 step printed at one decimal read "0.3 / 0.8".
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    // 25 × 10^n stays available where it is a whole number.
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 10, 4)).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it('never returns float drift or a degenerate axis', () => {
    for (const t of niceTicks(0, 0.3, 3)) expect(String(t).length).toBeLessThan(6);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
    expect(niceTicks(Number.NaN, 1)).toEqual([0]);
  });
});

describe('scales and helpers', () => {
  it('maps linearly and handles a zero-width domain', () => {
    expect(linearScale(0, 10, 0, 100)(5)).toBe(50);
    expect(linearScale(3, 3, 0, 100)(3)).toBe(50);
  });
  it('thins labels but always keeps the last', () => {
    expect(thinIndexes(5, 10)).toEqual([0, 1, 2, 3, 4]);
    const thin = thinIndexes(90, 6);
    expect(thin.length).toBeLessThanOrEqual(6);
    expect(thin[thin.length - 1]).toBe(89);
    expect(thinIndexes(0, 3)).toEqual([]);
  });
  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });
});

describe('splitRuns', () => {
  it('breaks at nulls instead of dipping to zero', () => {
    const runs = splitRuns([{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 3 }, { x: 3, y: 4 }]);
    expect(runs).toEqual([[{ x: 0, y: 1 }], [{ x: 2, y: 3 }, { x: 3, y: 4 }]]);
  });
});

describe('stackColumn', () => {
  it('stacks known values and flags unknowns', () => {
    const col = stackColumn([2, null, 3]);
    expect(col.total).toBe(5);
    expect(col.incomplete).toBe(true);
    expect(col.unknown).toBe(false);
    expect(col.segments.map((s) => [s.index, s.y0, s.y1])).toEqual([[0, 0, 2], [2, 2, 5]]);
  });
  it('treats all-null as unknown and all-zero as a known zero', () => {
    expect(stackColumn([null, null]).unknown).toBe(true);
    const zero = stackColumn([0, 0]);
    expect(zero.unknown).toBe(false);
    expect(zero.total).toBe(0);
    expect(zero.segments).toEqual([]);
  });
});

describe('rounded bars', () => {
  it('rounds only the data end and shrinks the radius for tiny bars', () => {
    const top = roundedTopBar(0, 0, 20, 40);
    expect(top.startsWith('M0,40')).toBe(true); // square on the baseline
    expect(top).toContain('Q0,0 4,0');
    expect(roundedTopBar(0, 0, 20, 2)).toContain('Q0,0 2,0');
    expect(roundedTopBar(0, 0, 20, 0)).toBe('');
    expect(roundedRightBar(0, 0, 50, 20)).toContain('Q50,0 50,4');
  });
});

describe('funnelSteps', () => {
  it('computes conversions and never guesses around unknowns', () => {
    const steps = funnelSteps([100, 40, null, 5]);
    expect(steps[1]).toEqual({ value: 40, ofFirst: 0.4, ofPrevious: 0.4 });
    expect(steps[2]!.ofPrevious).toBeNull();
    expect(steps[3]!.ofPrevious).toBeNull(); // previous is unknown
    expect(steps[3]!.ofFirst).toBeCloseTo(0.05);
    expect(funnelSteps([0, 0])[1]!.ofFirst).toBeNull();
  });
});

describe('calendarGrid', () => {
  it('lays out Monday-first weeks and fills missing days as unknown', () => {
    // 2026-09-01 is a Tuesday.
    const grid = calendarGrid([{ day: '2026-09-01', value: 3 }, { day: '2026-09-03', value: 0 }]);
    expect(grid.weeks).toBe(1);
    const inside = grid.cells.filter((c) => !c.outside);
    expect(inside.map((c) => [c.day, c.value, c.weekday])).toEqual([
      ['2026-09-01', 3, 1],
      ['2026-09-02', null, 2],
      ['2026-09-03', 0, 3],
    ]);
    expect(grid.months).toEqual([{ week: 0, label: 'Sep' }]);
  });
  it('supports Sunday-first weeks and rejects impossible days', () => {
    const grid = calendarGrid([{ day: '2026-09-06', value: 1 }, { day: '2026-02-30', value: 9 }], 0);
    expect(grid.cells.find((c) => c.day === '2026-09-06')!.weekday).toBe(0);
    expect(grid.cells.some((c) => c.day === '2026-02-30')).toBe(false);
    expect(calendarGrid([]).cells).toEqual([]);
  });
});

describe('heatBucket', () => {
  it('reserves 0 for a true zero and null for unknown', () => {
    expect(heatBucket(null, 10)).toBeNull();
    expect(heatBucket(0, 10)).toBe(0);
    expect(heatBucket(1, 10)).toBe(1);
    expect(heatBucket(10, 10)).toBe(4);
    expect(heatBucket(6, 10)).toBe(3);
  });
});

describe('projectBurnDown', () => {
  const H = 3_600_000;
  it('projects exhaustion before reset from the recent slope', () => {
    const p = projectBurnDown([{ t: 0, remaining: 100 }, { t: H, remaining: 80 }, { t: 2 * H, remaining: 60 }], 10 * H, { reserve: 40 });
    expect(p.slopePerMs).toBeCloseTo(-20 / H);
    expect(p.exhaustAt).toBeCloseTo(5 * H);
    expect(p.reserveAt).toBeCloseTo(3 * H);
    expect(p.remainingAtReset).toBe(0);
  });
  it('does not exhaust when the pace is sustainable, and skips unknown readings', () => {
    const p = projectBurnDown([{ t: 0, remaining: 100 }, { t: H, remaining: null }, { t: 2 * H, remaining: 98 }], 10 * H);
    expect(p.exhaustAt).toBeNull();
    expect(p.remainingAtReset).toBeCloseTo(90);
  });
  it('refuses to project from a single reading', () => {
    const p = projectBurnDown([{ t: 0, remaining: 50 }], H);
    expect(p.slopePerMs).toBeNull();
    expect(p.from).toEqual({ t: 0, remaining: 50 });
  });
  it('reports already-exhausted windows at the last reading', () => {
    const p = projectBurnDown([{ t: 0, remaining: 5 }, { t: H, remaining: 0 }], 5 * H);
    expect(p.exhaustAt).toBe(H);
  });
});

describe('gauge helpers', () => {
  it('draws arcs over the top and clamps fractions', () => {
    expect(gaugeArc(50, 50, 40, 0, 1)).toBe('M10,50 A40,40 0 0 1 90,50');
    expect(gaugeArc(50, 50, 40, 0, 0.5)).toBe('M10,50 A40,40 0 0 1 50,10');
    expect(gaugeArc(50, 50, 40, 0, 2)).toBe(gaugeArc(50, 50, 40, 0, 1));
    expect(gaugeArc(50, 50, 40, 0.5, 0.5)).toBe('');
  });
  it('classifies severity with unknown for null', () => {
    expect(gaugeSeverity(null, 0.7, 0.9)).toBe('unknown');
    expect(gaugeSeverity(0.5, 0.7, 0.9)).toBe('ok');
    expect(gaugeSeverity(0.75, 0.7, 0.9)).toBe('warn');
    expect(gaugeSeverity(1.2, 0.7, 0.9)).toBe('danger');
  });
});

// ---------------------------------------------------------------------------
// V3.10.1 — the live-app chart defects
// ---------------------------------------------------------------------------

describe('niceTicks — integer data (counts)', () => {
  it('puts a count axis on whole numbers only', () => {
    // The live "1, 0.8, 0.5, 0.3, 0" count axis: a max of one run.
    expect(niceTicks(0, 1, 4, { integer: true })).toEqual([0, 1]);
    expect(niceTicks(0, 3, 4, { integer: true })).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0, 0, 4, { integer: true })).toEqual([0, 1]);
    expect(niceTicks(0, 0.0001, 4, { integer: true })).toEqual([0, 1]);
    for (const max of [1, 2, 3, 7, 13, 99, 1234]) {
      for (const t of niceTicks(0, max, 4, { integer: true })) expect(Number.isInteger(t), `${max}: ${t}`).toBe(true);
    }
  });
  it('knows counts from measurements', () => {
    expect(allIntegers([0, 1, 4])).toBe(true);
    expect(allIntegers([0, 1.5])).toBe(false);
    expect(allIntegers([])).toBe(true);
  });
});

describe('axisTicks — labels at the precision of the step', () => {
  it('labels a 0–1 axis in clean steps with matching decimals, never 0.3 / 0.8', () => {
    const a = axisTicks(0, 1);
    expect(a.labels).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1.0']);
    expect(axisTicks(0, 0.2).labels).toEqual(['0', '0.05', '0.10', '0.15', '0.20']);
    expect(axisTicks(0, 1, { integer: true }).labels).toEqual(['0', '1']);
    expect(axisTicks(0, 93_000).labels).toEqual(['0', '25K', '50K', '75K', '100K']);
  });

  it('coarsens the ticks until a caller\'s rounding formatter prints them faithfully', () => {
    const pct = (v: number) => `${Math.round(v)}%`;
    // 0–1.5 in whole percent: 0.5 steps would print "1%" twice.
    const a = axisTicks(0, 1.5, { format: pct });
    expect(labelsFaithful(a.ticks, a.labels)).toBe(true);
    expect(new Set(a.labels).size).toBe(a.labels.length);
    // A one-decimal formatter on a 0.05 step (0.05 → "0.1") is refused.
    const oneDecimal = (v: number) => v.toFixed(1);
    const b = axisTicks(0, 0.2, { format: oneDecimal });
    expect(labelsFaithful(b.ticks, b.labels)).toBe(true);
    expect(b.labels).not.toContain('0.3');
  });

  it('accepts unit changes (%, K) but not rounding', () => {
    expect(labelsFaithful([0, 0.5, 1], ['0%', '50%', '100%'])).toBe(true);
    expect(labelsFaithful([0, 12500], ['0', '12.5K'])).toBe(true);
    expect(labelsFaithful([0, 12500], ['0', '13K'])).toBe(false);
    expect(labelsFaithful([0, 0.25, 0.75], ['0', '0.3', '0.8'])).toBe(false);
    expect(labelsFaithful([0, 0.75, 1], ['0', '+0.8', '+1.0'])).toBe(false);
    expect(labelsFaithful([0, 1], ['0', '1'])).toBe(true);
    expect(labelsFaithful([0, 0.2], ['0%', '0%'])).toBe(false);
  });

  it('recognises percent formatters and their units', () => {
    expect(percentScale((v) => `${Math.round(v)}%`)).toBe(100);
    expect(percentScale((v) => `${(v * 100).toFixed(0)}%`)).toBe(1);
    expect(percentScale((v) => String(v))).toBeNull();
  });
});

describe('time domains', () => {
  const T = Date.parse('2026-09-24T12:00:00Z');
  it('treats 0, NaN and pre-2000 stamps as leaks on a time axis', () => {
    expect(isPlausibleTime(T)).toBe(true);
    expect(isPlausibleTime(0)).toBe(false);
    expect(isPlausibleTime(Number.NaN)).toBe(false);
    expect(isPlausibleTime(MIN_PLAUSIBLE_TIME - 1)).toBe(false);
    expect(isTimeAxis([0, T])).toBe(true);
    expect([0, T, Number.NaN, 5].filter(xKeeper([0, T, Number.NaN, 5]))).toEqual([T]);
    // An ordinal axis (0, 1, 2) is not a time axis and keeps every finite value.
    expect([0, 1, 2, Number.NaN].filter(xKeeper([0, 1, 2]))).toEqual([0, 1, 2]);
  });

  it('widens a degenerate span instead of stretching it edge to edge', () => {
    expect(ensureSpan(T, T + 30_000, MIN_TIME_SPAN_MS)).toEqual([T + 15_000 - MIN_TIME_SPAN_MS / 2, T + 15_000 + MIN_TIME_SPAN_MS / 2]);
    expect(ensureSpan(T, T, MIN_TIME_SPAN_MS, 'end')).toEqual([T - MIN_TIME_SPAN_MS, T]);
    expect(ensureSpan(T, T + 3_600_000, MIN_TIME_SPAN_MS)).toEqual([T, T + 3_600_000]);
  });

  it('keeps a pre-2000 day out of the calendar grid', () => {
    const grid = calendarGrid([{ day: '1970-01-01', value: 1 }, { day: '2026-09-01', value: 2 }]);
    expect(grid.weeks).toBe(1);
    expect(grid.cells.some((c) => c.day.startsWith('1970'))).toBe(false);
  });
});

describe('layoutAxisLabels', () => {
  const CH = 7.2;
  const bounds = { min: 0, max: 300 };

  it('keeps both labels at full detail when they fit', () => {
    const placed = layoutAxisLabels(
      [
        { key: 'start', x: 0, anchor: 'start', priority: 2, variants: ['Sep 18', 'x'] },
        { key: 'end', x: 300, anchor: 'end', priority: 3, variants: ['Resets Sep 25', 'y'] },
      ],
      bounds,
    );
    expect(placed.map((p) => p.text)).toEqual(['Sep 18', 'Resets Sep 25']);
  });

  it('shortens every label one rung before it drops any', () => {
    const full = 'Fri, Sep 18 at 11:46 PM';
    const reset = 'Resets Fri, Sep 25 at 11:46 PM';
    expect((full.length + reset.length) * CH).toBeGreaterThan(300); // they would overprint
    const placed = layoutAxisLabels(
      [
        { key: 'start', x: 0, anchor: 'start', priority: 2, variants: [full, 'Sep 18'] },
        { key: 'end', x: 300, anchor: 'end', priority: 3, variants: [reset, 'Resets Sep 25'] },
      ],
      bounds,
    );
    expect(placed).toEqual([
      { key: 'start', text: 'Sep 18', x: 0, anchor: 'start' },
      { key: 'end', text: 'Resets Sep 25', x: 300, anchor: 'end' },
    ]);
  });

  it('drops the lower-priority label when even the shortest rung collides', () => {
    const placed = layoutAxisLabels(
      [
        { key: 'start', x: 0, anchor: 'start', priority: 2, variants: ['Sat, Sep 19 at 8:43 AM'] },
        { key: 'reset', x: 250, anchor: 'end', priority: 3, variants: ['Resets Sat, Sep 26 at 8:43 AM'] },
      ],
      { min: 0, max: 250 },
    );
    expect(placed.map((p) => p.key)).toEqual(['reset']);
  });

  it('drops a duplicate label and colliding interior ticks, but keeps the ends', () => {
    const placed = layoutAxisLabels(
      [
        { key: 'a', x: 0, anchor: 'start', priority: 2, required: true, variants: ['Sep 24'] },
        { key: 'b', x: 20, anchor: 'middle', priority: 1, required: false, variants: ['Sep 24'] },
        { key: 'c', x: 150, anchor: 'middle', priority: 1, required: false, variants: ['Sep 25'] },
        { key: 'd', x: 300, anchor: 'end', priority: 3, required: true, variants: ['Sep 24'] },
      ],
      bounds,
    );
    expect(placed.map((p) => p.key)).toEqual(['c', 'd']);
  });

  it('pins a label that would overflow to the edge it hangs off', () => {
    const [p] = layoutAxisLabels([{ key: 'x', x: 295, anchor: 'middle', priority: 1, variants: ['11:46 PM'] }], bounds);
    expect(p).toEqual({ key: 'x', text: '11:46 PM', x: 300, anchor: 'end' });
  });
});

describe('dodgeLabels', () => {
  it('separates two labels at the same y, centred on it', () => {
    const out = dodgeLabels([{ key: 'struggles', y: 100 }, { key: 'wins', y: 100 }], 14, 0, 200)!;
    expect(out.get('struggles')).toBe(93);
    expect(out.get('wins')).toBe(107);
  });

  it('leaves labels that are already apart where they are', () => {
    const out = dodgeLabels([{ key: 'a', y: 20 }, { key: 'b', y: 120 }], 14, 0, 200)!;
    expect([out.get('a'), out.get('b')]).toEqual([20, 120]);
  });

  it('keeps a dodged cluster inside the plot', () => {
    const out = dodgeLabels([{ key: 'a', y: 198 }, { key: 'b', y: 199 }, { key: 'c', y: 200 }], 14, 0, 200)!;
    const ys = ['a', 'b', 'c'].map((k) => out.get(k)!);
    expect(Math.max(...ys)).toBeLessThanOrEqual(200);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(14);
    expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(14);
  });

  it('returns null (legend only) when the labels cannot fit', () => {
    expect(dodgeLabels([{ key: 'a', y: 5 }, { key: 'b', y: 5 }, { key: 'c', y: 5 }], 14, 0, 20)).toBeNull();
  });
});
