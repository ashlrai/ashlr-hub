import { describe, expect, it } from 'vitest';
import {
  calendarGrid,
  clamp,
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
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
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
