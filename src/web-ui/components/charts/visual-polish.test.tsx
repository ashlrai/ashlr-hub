/**
 * visual-polish.test.tsx — the verse-visual-quality layer of the chart kit,
 * asserted through the DOM it renders (and, for colour and motion, through
 * the CSS and tokens that paint it in BOTH themes):
 *
 *   - gradient washes: one <linearGradient> per series, referenced by the
 *     wash, stopping on the series' own ink (theme-agnostic by construction);
 *   - monotone curves: through every reading, never overshooting;
 *   - crisp hairlines: gridlines on half pixels;
 *   - tooltips: exact values, local day / instant titles, placed beside the
 *     crosshair inside the plot, the total set apart;
 *   - entrance motion: data-motion="enter" only when neither Settings nor
 *     the OS asks for reduced motion, and every animation keyed off it;
 *   - skeletons: loading holds the chart's own shape and height;
 *   - the Table twin: reachable from every kit chart.
 */
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contrastRatio } from '../../design/contrast.js';
import { darkScope, lightScope, resolveValue, type TokenScope } from '../../design/token-probe.test-support.js';
import { AreaTrend } from './AreaTrend.js';
import { BarStack } from './BarStack.js';
import { BurnDown } from './BurnDown.js';
import { ChartSkeleton, tooltipSide } from './ChartParts.js';
import { Funnel } from './Funnel.js';
import { LineChart } from './LineChart.js';
import { Sparkline } from './Sparkline.js';
import { StatTile, StatTileSkeleton } from './StatTile.js';
import { Swimlane } from './Swimlane.js';
import { crisp, monotoneSegments, smoothAreaPath, smoothPath } from './chart-math.js';
import { showTable } from './chart-test-support.js';
import { CHART_SEQUENTIAL, seriesColor } from './colors.js';
import { formatExact, formatTooltipDay, formatTooltipInstant, tooltipTimeFormatter } from './format.js';
import { prefersReducedMotion } from './motion.js';

const DAY = 86_400_000;
/** Local midnights, as every Verse day series is stamped (growth/calendar-day). */
const day0 = new Date(2026, 8, 20).getTime();
const days = (ys: (number | null)[]) => ys.map((y, i) => ({ x: new Date(2026, 8, 20 + i).getTime(), y }));

afterEach(() => {
  document.documentElement.removeAttribute('data-motion');
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Every vertex (M/L point, or a curve segment's END point) a path passes through. */
function vertices(d: string): Array<[number, number]> {
  return Array.from(d.matchAll(/[MLC]([^MLCZ]*)/g)).map((m) => {
    const pairs = m[1]!.trim().split(/\s+/);
    const [x, y] = pairs[pairs.length - 1]!.split(',').map(Number);
    return [x!, y!];
  });
}

describe('monotone curves', () => {
  const run = [
    { x: 0, y: 50 },
    { x: 10, y: 10 },
    { x: 20, y: 12 },
    { x: 30, y: 80 },
    { x: 40, y: 80 },
    { x: 50, y: 20 },
  ];

  it('pass through every reading, in order', () => {
    expect(vertices(smoothPath(run))).toEqual(run.map((p) => [p.x, p.y]));
  });

  it('never overshoot a segment — no invented peak, dip or crossing', () => {
    for (const seg of monotoneSegments(run)) {
      const lo = Math.min(seg.from.y, seg.to.y);
      const hi = Math.max(seg.from.y, seg.to.y);
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const u = 1 - t;
        const y = u * u * u * seg.from.y + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t * t * t * seg.to.y;
        expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(y).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('keeps a flat stretch flat, draws two points straight and one point as a lone move', () => {
    const flat = monotoneSegments([{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }]);
    expect(flat.every((s) => s.c1.y === 5 && s.c2.y === 5)).toBe(true);
    const two = monotoneSegments([{ x: 0, y: 0 }, { x: 3, y: 3 }]);
    expect(two[0]!.c1).toEqual({ x: 1, y: 1 });
    expect(smoothPath([{ x: 4, y: 2 }])).toBe('M4,2');
  });

  it('closes an area whose base walks the same curve back, exactly reversed', () => {
    const base = run.map((p) => ({ x: p.x, y: p.y + 100 }));
    const d = smoothAreaPath(run, base);
    expect(d.endsWith('Z')).toBe(true);
    const back = vertices(d.slice(d.indexOf(' L')));
    expect(back.map(([x]) => x)).toEqual([...base].reverse().map((p) => p.x));
  });

  it('snaps hairlines to a half pixel so a 1 px rule paints one pixel, not two gray ones', () => {
    expect(crisp(10)).toBe(10.5);
    expect(crisp(10.49)).toBe(10.5);
    expect(crisp(10.9)).toBe(10.5);
  });
});

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

function gradientFor(container: HTMLElement, fill: string | null): Element | null {
  const id = /^url\(#(.+)\)$/.exec(fill ?? '')?.[1];
  return id ? container.querySelector(`linearGradient[id="${id}"]`) : null;
}

describe('gradient washes', () => {
  it('AreaTrend fills each series with its own ink fading to nothing, on one shared scale', () => {
    const { container } = render(
      <AreaTrend
        title="Two"
        width={600}
        series={[
          { id: 'a', label: 'A', points: days([1, 4, 2, 6]) },
          { id: 'b', label: 'B', points: days([2, 1, 3, 2]) },
        ]}
      />,
    );
    const grads = container.querySelectorAll('linearGradient[data-area-gradient]');
    expect(grads).toHaveLength(2);
    for (const [i, id] of ['a', 'b'].entries()) {
      const area = container.querySelector(`g[data-series="${id}"] path[data-role="area"]`)!;
      const grad = gradientFor(container, area.getAttribute('fill'));
      expect(grad, `${id} wash references a gradient that exists`).not.toBeNull();
      const stops = [...grad!.querySelectorAll('stop')] as SVGStopElement[];
      expect(stops[0]!.style.stopColor).toBe(seriesColor(i));
      expect(Number(stops[stops.length - 1]!.style.stopOpacity)).toBe(0);
      // userSpaceOnUse pinned to the plot, so both series fade on one scale.
      expect(grad!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
    }
    const [g0, g1] = [...grads];
    expect(g0!.getAttribute('y1')).toBe(g1!.getAttribute('y1'));
    expect(g0!.getAttribute('y2')).toBe(g1!.getAttribute('y2'));
  });

  it('LineChart, BurnDown and Sparkline washes are gradients too — never a flat 10% fill', () => {
    const line = render(<LineChart series={[{ id: 's', label: 'Spend', points: days([1, 3, 2]) }]} area ariaLabel="Spend" width={500} />);
    expect(gradientFor(line.container, line.container.querySelector('path[data-role="area"]')!.getAttribute('fill'))).not.toBeNull();
    line.unmount();

    const burn = render(
      <BurnDown title="Seat" width={500} capacity={100} start={day0} resetAt={day0 + 7 * DAY} now={day0 + 3 * DAY} points={[{ t: day0 + DAY, remaining: 90 }, { t: day0 + 2 * DAY, remaining: 70 }]} />,
    );
    expect(gradientFor(burn.container, burn.container.querySelector('path[data-role="area"]')!.getAttribute('fill'))).not.toBeNull();
    burn.unmount();

    const spark = render(<Sparkline points={[1, 3, 2, 5]} area ariaLabel="Trend" />);
    const wash = spark.container.querySelector('path[fill^="url("]');
    expect(gradientFor(spark.container, wash!.getAttribute('fill'))).not.toBeNull();
  });

  it('gives two charts on one page distinct gradient ids (ids are document-global)', () => {
    const { container } = render(
      <>
        <AreaTrend title="One" width={400} series={[{ id: 's', label: 'S', points: days([1, 2]) }]} />
        <AreaTrend title="Two" width={400} series={[{ id: 's', label: 'S', points: days([2, 1]) }]} />
      </>,
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Crisp chrome
// ---------------------------------------------------------------------------

describe('crisp gridlines', () => {
  it('draws every horizontal gridline and the baseline on a half pixel', () => {
    const { container } = render(<AreaTrend title="t" width={600} series={[{ id: 'a', label: 'A', points: days([3, 17, 9, 12]) }]} />);
    const rules = [...container.querySelectorAll('line')].filter((l) => l.getAttribute('y1') === l.getAttribute('y2'));
    expect(rules.length).toBeGreaterThan(2);
    for (const r of rules) expect(Number(r.getAttribute('y1')) % 1).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

describe('tooltips', () => {
  it('print the EXACT value (the axis rounds) and the local day with its weekday', () => {
    render(<AreaTrend title="Tokens" width={600} series={[{ id: 't', label: 'Tokens', points: days([12_934, 48_211, 30_502]) }]} />);
    const plot = screen.getByRole('group', { name: /Tokens\. Use the left and right arrow keys/ });
    fireEvent.focus(plot);
    const tip = document.querySelector('[data-chart-tooltip]') as HTMLElement;
    expect(tip).not.toBeNull();
    expect(within(tip).getByText('30,502')).toBeInTheDocument();
    expect(within(tip).getByText(formatTooltipDay(new Date(2026, 8, 22).getTime()))).toBeInTheDocument();
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(within(document.querySelector('[data-chart-tooltip]') as HTMLElement).getByText('12,934')).toBeInTheDocument();
  });

  it('keeps the caller\'s y format when one is given (a currency is already exact)', () => {
    render(<AreaTrend title="Spend" width={600} formatY={(v) => `$${v.toFixed(2)}`} series={[{ id: 's', label: 'Spend', points: days([1.5, 2.25]) }]} />);
    fireEvent.focus(screen.getByRole('group', { name: /^Spend\./ }));
    expect(within(document.querySelector('[data-chart-tooltip]') as HTMLElement).getByText('$2.25')).toBeInTheDocument();
  });

  it('sits beside the crosshair inside the plot — right while it fits, else left', () => {
    render(<AreaTrend title="Side" width={600} series={[{ id: 's', label: 'S', points: days([1, 2, 3, 4, 5]) }]} />);
    const plot = screen.getByRole('group', { name: /^Side\./ });
    fireEvent.focus(plot); // latest point, at the right edge
    expect(document.querySelector('[data-chart-tooltip]')!.getAttribute('data-chart-tooltip')).toBe('left');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(document.querySelector('[data-chart-tooltip]')!.getAttribute('data-chart-tooltip')).toBe('right');
    expect(tooltipSide(100, 200)).toBeUndefined(); // too narrow either way: centred above
  });

  it('LineChart is a keyboard stop with the same crosshair, tooltip and live region', () => {
    render(<LineChart series={[{ id: 'a', label: 'Tokens in', points: days([1_234_567, 2_000_001]) }]} formatY={(y) => `${Math.round(y / 1e6)}M`} formatTooltip={formatExact} ariaLabel="Tokens per day" width={600} />);
    const plot = screen.getByRole('group', { name: /Tokens per day\. Use the left and right arrow keys/ });
    fireEvent.focus(plot);
    expect(document.querySelector('[data-role="crosshair"]')).not.toBeNull();
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    const tip = document.querySelector('[data-chart-tooltip]') as HTMLElement;
    expect(within(tip).getByText('1,234,567')).toBeInTheDocument();
    expect(within(tip).getByText(formatTooltipDay(day0))).toBeInTheDocument();
    expect(plot.querySelector('[aria-live="polite"]')!.textContent).toContain('Tokens in 1,234,567');
  });

  it('LineChart draws interior x ticks at the kit\'s density, not just the two ends', () => {
    const { container } = render(<LineChart series={[{ id: 'a', label: 'A', points: days([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }]} ariaLabel="t" width={900} />);
    expect(container.querySelectorAll('[data-axis-label]').length).toBeGreaterThan(2);
  });

  it('BarStack sets the total apart and prints it exactly', () => {
    render(
      <BarStack
        title="Runs"
        width={600}
        categories={['Mon', 'Tue']}
        segments={[{ id: 'a', label: 'Done', color: seriesColor(0) }, { id: 'b', label: 'Failed', color: seriesColor(1) }]}
        values={[[1200, 34], [15_000, 250]]}
      />,
    );
    fireEvent.focus(screen.getByRole('group', { name: /^Runs\./ }));
    const tip = document.querySelector('[data-chart-tooltip]') as HTMLElement;
    const total = within(tip).getByText('Total').parentElement!;
    expect(total.className).toMatch(/tooltipTotal/);
    expect(within(total).getByText('15,250')).toBeInTheDocument();
    // …and the hovered column gets its slot band.
    expect(document.querySelector('[data-role="hover-band"]')).not.toBeNull();
  });

  it('BurnDown reads each reading by hover or keyboard, with where even pace would be', () => {
    const start = day0;
    const reset = day0 + 4 * DAY;
    render(
      <BurnDown
        title="Claude weekly"
        width={600}
        capacity={100}
        start={start}
        resetAt={reset}
        now={day0 + 2 * DAY}
        reserve={{ value: 20, label: 'Reserved for you' }}
        formatValue={(v) => `${Math.round(v)}%`}
        points={[{ t: day0 + DAY, remaining: 80 }, { t: day0 + 2 * DAY, remaining: 40 }]}
      />,
    );
    const plot = screen.getByRole('group', { name: /Claude weekly\. Use the left and right arrow keys/ });
    fireEvent.focus(plot);
    const tip = document.querySelector('[data-chart-tooltip]') as HTMLElement;
    expect(within(tip).getByText(formatTooltipInstant(day0 + 2 * DAY))).toBeInTheDocument();
    expect(within(within(tip).getByText('Remaining').parentElement!).getByText('40%')).toBeInTheDocument();
    // Halfway through the window → even pace is at 50%.
    expect(within(within(tip).getByText('Even pace').parentElement!).getByText('50%')).toBeInTheDocument();
  });
});

describe('BurnDown reserve band', () => {
  it('shades from empty up to the reserve line, under the line and its label', () => {
    const { container } = render(
      <BurnDown title="Seat" width={600} height={200} capacity={100} start={day0} resetAt={day0 + 7 * DAY} now={day0 + DAY} reserve={{ value: 25, label: 'Reserve' }} points={[{ t: day0 + DAY / 2, remaining: 90 }]} />,
    );
    const band = container.querySelector('[data-role="reserve-band"]')!;
    const line = container.querySelector('[data-role="reserve"] line')!;
    const top = Number(band.getAttribute('y'));
    const bottom = top + Number(band.getAttribute('height'));
    expect(Math.abs(top - Number(line.getAttribute('y1')))).toBeLessThanOrEqual(1);
    const axis = [...container.querySelectorAll('line')].find((l) => (l.getAttribute('class') ?? '').includes('axis'))!;
    expect(Math.abs(bottom - Number(axis.getAttribute('y1')))).toBeLessThanOrEqual(1);
    // The band sits BEHIND the data: it is painted before the remaining line.
    const order = [...container.querySelectorAll('[data-role]')].map((n) => n.getAttribute('data-role'));
    expect(order.indexOf('reserve-band')).toBeLessThan(order.indexOf('remaining'));
  });
});

// ---------------------------------------------------------------------------
// Local-time titles
// ---------------------------------------------------------------------------

describe('local-time tooltip titles', () => {
  it('name the day for daily buckets and the instant for readings at different times', () => {
    const daily = [0, 1, 2].map((i) => new Date(2026, 8, 20 + i).getTime());
    expect(tooltipTimeFormatter(daily)).toBe(formatTooltipDay);
    const readings = [new Date(2026, 8, 20, 9, 15).getTime(), new Date(2026, 8, 20, 14, 40).getTime()];
    expect(tooltipTimeFormatter(readings)).toBe(formatTooltipInstant);
    expect(formatTooltipInstant(readings[1]!)).toMatch(/2:40\s?PM$/);
  });

  it('print exact figures with grouping, keeping small fractions', () => {
    expect(formatExact(12934)).toBe('12,934');
    expect(formatExact(0.0425)).toBe('0.043');
    expect(formatExact(Number.NaN)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Entrance motion and reduced motion
// ---------------------------------------------------------------------------

describe('entrance motion', () => {
  function motionOf(): string | null {
    const { container, unmount } = render(<AreaTrend title="m" width={400} series={[{ id: 'a', label: 'A', points: days([1, 2, 3]) }]} />);
    const value = container.querySelector('[data-motion]')!.getAttribute('data-motion');
    unmount();
    return value;
  }

  it('enters by default, and marks each line to draw itself (pathLength=1)', () => {
    expect(motionOf()).toBe('enter');
    const { container } = render(<AreaTrend title="m" width={400} series={[{ id: 'a', label: 'A', points: days([1, 2, 3]) }]} />);
    const line = container.querySelector('path[data-role="line"]')!;
    expect(line.getAttribute('pathLength')).toBe('1');
    expect(line.getAttribute('class')).toMatch(/draw/);
  });

  it('holds still when Settings asks for reduced motion', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    expect(prefersReducedMotion()).toBe(true);
    expect(motionOf()).toBe('static');
  });

  it('holds still when the OS asks — unless Settings explicitly asked for full motion', () => {
    const mm = vi.fn().mockReturnValue({ matches: true, media: '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('matchMedia', mm);
    try {
      expect(motionOf()).toBe('static');
      document.documentElement.setAttribute('data-motion', 'full');
      expect(motionOf()).toBe('enter');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('every kit chart and the sparkline carry the flag on their plot', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    const views = [
      render(<BarStack title="b" width={400} categories={['a', 'b']} segments={[{ id: 's', label: 'S', color: CHART_SEQUENTIAL }]} values={[[1], [2]]} />),
      render(<Funnel title="f" width={600} stages={[{ id: 'a', label: 'A', value: 10 }, { id: 'b', label: 'B', value: 4 }]} />),
      render(<LineChart series={[{ id: 'a', label: 'A', points: days([1, 2]) }]} ariaLabel="l" width={400} />),
      render(<BurnDown title="bd" width={400} capacity={100} start={day0} resetAt={day0 + DAY * 2} now={day0 + DAY} points={[{ t: day0 + 1000, remaining: 90 }]} />),
      render(<Swimlane title="s" width={600} from={day0} to={day0 + DAY} now={day0 + DAY} lanes={[{ id: 'l', label: 'repo', items: [{ id: 'i', start: day0 + 1000, end: day0 + 5000, status: 'done' }] }]} />),
      render(<Sparkline points={[1, 2, 3]} ariaLabel="sp" />),
    ];
    for (const v of views) {
      const flagged = v.container.querySelector('[data-motion]');
      expect(flagged, v.container.innerHTML.slice(0, 80)).not.toBeNull();
      expect(flagged!.getAttribute('data-motion')).toBe('static');
    }
  });

  it('keys every entrance animation off data-motion="enter", with both reduced-motion guards', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web-ui/components/charts/plot.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const cls of ['draw', 'fadeIn', 'rise', 'grow']) {
      const rule = new RegExp(`\\[data-motion='enter'\\]\\s+\\.${cls}\\s*\\{[^}]*animation:\\s*chart-`);
      expect(css, cls).toMatch(rule);
    }
    const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const explicit = /((?::global\(:root\[data-motion='reduce'\]\)[^{]*,?\s*)+)\{\s*animation:\s*none;/.exec(css)?.[1] ?? '';
    for (const cls of ['draw', 'fadeIn', 'rise', 'grow', 'tooltip', 'skeleton']) {
      expect(media, `OS guard for .${cls}`).toMatch(new RegExp(`\\.${cls}\\b`));
      expect(explicit, `Settings guard for .${cls}`).toMatch(new RegExp(`\\.${cls}\\b`));
    }
    // Durations ride the motion tokens, which collapse under reduced motion.
    expect(css).not.toMatch(/animation:[^;]*\b\d+ms\b/);
  });
});

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

describe('loading skeletons', () => {
  it('hold each chart\'s own shape and height, and announce "Loading…" once', () => {
    const cases: Array<[string, ReactElement]> = [
      ['line', <AreaTrend key="a" title="A" height={180} status={{ kind: 'loading' }} series={[]} />],
      ['bars', <BarStack key="b" title="B" height={220} status={{ kind: 'loading' }} categories={[]} segments={[]} values={[]} />],
      ['funnel', <Funnel key="f" title="F" status={{ kind: 'loading' }} stages={[]} />],
      ['lanes', <Swimlane key="s" title="S" status={{ kind: 'loading' }} from={0} to={1} now={1} lanes={[]} />],
    ];
    for (const [shape, el] of cases) {
      const { container, unmount } = render(el);
      const sk = container.querySelector(`[data-chart-skeleton="${shape}"]`);
      expect(sk, shape).not.toBeNull();
      expect(sk!.getAttribute('aria-hidden')).toBe('true');
      const status = container.querySelector('[role="status"][aria-busy="true"]')!;
      expect(within(status as HTMLElement).getByText('Loading…')).toBeInTheDocument();
      if (shape === 'line') expect(sk!.getAttribute('height')).toBe('180');
      if (shape === 'bars') expect(sk!.getAttribute('height')).toBe('220');
      unmount();
    }
  });

  it('draws deterministic placeholders (identical on every render)', () => {
    const a = render(<ChartSkeleton shape="bars" height={160} />).container.innerHTML;
    const b = render(<ChartSkeleton shape="bars" height={160} />).container.innerHTML;
    expect(a).toBe(b);
  });

  it('gives a stat tile a placeholder in its own shape, hidden from assistive tech', () => {
    const { container } = render(<StatTileSkeleton />);
    const tile = container.querySelector('[data-stat-tile-skeleton]')!;
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelectorAll('.skeleton').length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

describe('stat tiles', () => {
  it('span the sparkline across the tile, in the quantity ink with a ringed latest point', () => {
    const { container } = render(<StatTile label="Merged · 7d" value="12" trend={[1, 3, 2, 4]} trendLabel="Merges per day" />);
    const line = container.querySelector('svg[role="img"] path[stroke]')!;
    expect(line.getAttribute('stroke')).toBe(CHART_SEQUENTIAL);
    expect(container.querySelector('svg[role="img"] circle')).not.toBeNull();
    expect(container.querySelector('[data-motion]')!.className).toMatch(/fillBox/);
  });

  it('put a judged delta on its tint with a direction arrow, and keep the words', () => {
    render(<StatTile label="Merged" value="12" delta={{ value: 5, unit: 'merges', versus: 'vs prior 7d', goodWhenPositive: true }} />);
    const text = screen.getByText('+5 merges vs prior 7d');
    const pill = text.parentElement!;
    expect(pill.getAttribute('data-delta-tone')).toBe('good');
    expect(pill.querySelector('[aria-hidden="true"]')!.textContent).toBe('↑');
  });
});

// ---------------------------------------------------------------------------
// The Table twin, everywhere
// ---------------------------------------------------------------------------

describe('the Table view', () => {
  it('is one menu pick away on every kit chart', () => {
    const charts: Array<[string, ReactElement]> = [
      ['Area', <AreaTrend key="a" title="Area" width={400} series={[{ id: 'a', label: 'A', points: days([1, 2]) }]} />],
      ['Bars', <BarStack key="b" title="Bars" width={400} categories={['x']} segments={[{ id: 's', label: 'S', color: CHART_SEQUENTIAL }]} values={[[3]]} />],
      ['Burn', <BurnDown key="bd" title="Burn" width={400} capacity={100} start={day0} resetAt={day0 + DAY} now={day0 + 1000} points={[{ t: day0 + 500, remaining: 90 }]} />],
      ['Pipe', <Funnel key="f" title="Pipe" width={600} stages={[{ id: 'a', label: 'A', value: 3 }]} />],
      ['Lanes', <Swimlane key="s" title="Lanes" width={600} from={day0} to={day0 + DAY} now={day0 + DAY} lanes={[{ id: 'l', label: 'r', items: [{ id: 'i', start: day0 + 1, end: day0 + 2, status: 'done' }] }]} />],
    ];
    for (const [title, el] of charts) {
      const { unmount } = render(el);
      showTable(title);
      const fig = screen.getByRole('figure', { name: title });
      expect(within(fig).getByRole('table'), title).toBeInTheDocument();
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Both themes — the new paint, measured through the real tokens
// ---------------------------------------------------------------------------

const THEMES: Array<[string, TokenScope]> = [
  ['light', lightScope()],
  ['dark', darkScope()],
];

describe.each(THEMES)('%s theme', (_name, scope) => {
  const lit = (token: string): string => {
    const v = resolveValue(scope, `var(${token})`);
    expect(v, `${token} resolves`).not.toBeNull();
    return v!;
  };
  const surface = (): string => lit('--bg-surface');

  it('keeps a judged delta\'s text readable on its tint (AA for 12 px)', () => {
    expect(contrastRatio(lit('--status-success-fg'), lit('--status-success-bg'), surface())!).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lit('--status-danger-fg'), lit('--status-danger-bg'), surface())!).toBeGreaterThanOrEqual(4.5);
  });

  it('draws the reserve band visibly but quietly — a region, never louder than the data', () => {
    const band = contrastRatio(lit('--status-warning-bg'), surface(), surface())!;
    expect(band).toBeGreaterThan(1.02);
    expect(band).toBeLessThan(1.6);
  });

  it('keeps the skeleton marks visible on the card, and the tooltip on its own raised surface', () => {
    expect(contrastRatio(lit('--bg-active'), surface(), surface())!).toBeGreaterThan(1.05);
    expect(lit('--bg-surface-raised')).toBeTruthy();
    expect(resolveValue(scope, 'var(--shadow-menu)')).toBeTruthy();
  });

  it('keeps the sparkline ink (the quantity azure) a readable graphic on the card (3:1)', () => {
    expect(contrastRatio(lit('--data-seq-5'), surface())!).toBeGreaterThanOrEqual(3);
  });
});
