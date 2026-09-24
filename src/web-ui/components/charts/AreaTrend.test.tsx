import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AreaTrend } from './AreaTrend.js';
import { formatDayLabel } from './format.js';
import { axisLabelBoxes, noOverlap, showTable } from './chart-test-support.js';

// Day-bucketed series are UTC midnights; label them as UTC days (runner TZ-independent).
const utcDay = (x: number) => formatDayLabel(new Date(x).toISOString().slice(0, 10));

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const pts = (ys: (number | null)[]) => ys.map((y, i) => ({ x: T0 + i * DAY, y }));

describe('AreaTrend', () => {
  it('summarises the series in its accessible name', () => {
    render(<AreaTrend title="Merges" width={600} formatX={utcDay} series={[{ id: 'm', label: 'Merges', points: pts([1, 2, 3]) }]} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toMatch(/Merges: 3 points from Sep 1 to Sep 3\. Latest Sep 3: Merges 3\./);
  });

  it('breaks the line at a null instead of drawing through it', () => {
    const { container } = render(
      <AreaTrend title="t" width={600} series={[{ id: 'a', label: 'A', points: pts([1, 2, null, 4, 5]) }]} />,
    );
    const lines = container.querySelectorAll('g[data-series="a"] path.line, g[data-series="a"] path[stroke]');
    // Two runs → two line paths (and two washes).
    expect([...lines].filter((p) => p.getAttribute('class')?.includes('line')).length).toBe(2);
  });

  it('breaks every stacked layer where any layer is unknown', () => {
    const { container } = render(
      <AreaTrend
        title="t"
        width={600}
        stacked
        series={[
          { id: 'a', label: 'A', points: pts([1, 1, 1]) },
          { id: 'b', label: 'B', points: pts([1, null, 1]) },
        ]}
      />,
    );
    // Middle x is unknown for the total, so each layer has 2 single-point runs.
    expect(container.querySelectorAll('g[data-series="a"] path').length).toBe(2);
    expect(container.querySelectorAll('g[data-series="b"] path').length).toBe(2);
  });

  it('is keyboard-readable through a live region, and a legend appears for 2+ series', async () => {
    render(
      <AreaTrend
        title="Runs"
        width={600}
        formatX={utcDay}
        series={[
          { id: 'a', label: 'Done', points: pts([1, 2]) },
          { id: 'b', label: 'Failed', points: pts([0, null]) },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: /Runs\. Use the left and right arrow keys/ });
    fireEvent.focus(group);
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('Sep 2: Done 2, Failed no data');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('Sep 1: Done 1, Failed 0');
    expect(screen.getByText('Done', { selector: 'li' })).toBeInTheDocument();
    showTable();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('cell', { name: '—' })).toBeInTheDocument();
  });

  it('shows the designed empty state when every value is unknown', () => {
    render(<AreaTrend title="t" series={[{ id: 'a', label: 'A', points: pts([null, null]) }]} />);
    expect(screen.getByText('Nothing happened in this window.')).toBeInTheDocument();
  });

  it('draws a labelled threshold and stays inside a 375 px width', () => {
    const { container } = render(
      <AreaTrend title="Spend" width={375} threshold={{ value: 50, label: 'Cap' }} series={[{ id: 'a', label: 'Spend', points: pts([10, 20, 30]) }]} />,
    );
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute('width')).toBe('375');
    expect(screen.getByText(/Cap · 50/)).toBeInTheDocument();
    for (const line of container.querySelectorAll('line')) {
      expect(Number(line.getAttribute('x2'))).toBeLessThanOrEqual(375);
    }
  });
});

describe('AreaTrend V3.10.1', () => {
  const T = Date.parse('2026-09-24T03:46:00Z');
  const tickTexts = (root: ParentNode) =>
    [...root.querySelectorAll('svg[role="img"] text')].filter((t) => t.getAttribute('text-anchor') === 'end' && !t.hasAttribute('data-axis-label')).map((t) => t.textContent);

  it('puts integer counts on whole-number ticks (a max of 1 is 0 and 1, never 0.3 / 0.8)', () => {
    const { container } = render(<AreaTrend title="Wins" width={600} series={[{ id: 'w', label: 'Wins', points: pts([0, 1, 1]) }]} />);
    expect(tickTexts(container)).toEqual(['0', '1']);
  });

  it('labels fractional data at the precision of the step', () => {
    const { container } = render(<AreaTrend title="Rate" width={600} series={[{ id: 'r', label: 'Rate', points: pts([0.1, 0.9, 0.5]) }]} />);
    expect(tickTexts(container)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1.0']);
  });

  it('dodges end labels of lines that end on the same value', () => {
    const { container } = render(
      <AreaTrend
        title="Struggles and wins"
        width={600}
        series={[
          { id: 's', label: 'Struggles', points: pts([0, 2, 3]) },
          { id: 'w', label: 'Wins', points: pts([1, 2, 3]) },
        ]}
      />,
    );
    const s = container.querySelector('[data-end-label="s"]')!;
    const w = container.querySelector('[data-end-label="w"]')!;
    expect(Math.abs(Number(s.getAttribute('y')) - Number(w.getAttribute('y')))).toBeGreaterThanOrEqual(14);
    // The legend still names both.
    expect(screen.getByText('Wins', { selector: 'li' })).toBeInTheDocument();
  });

  it('drops a 0 / pre-2000 x instead of starting the axis at "Dec 31" 1969', () => {
    const { container } = render(
      <AreaTrend title="Merges" width={600} formatX={utcDay} series={[{ id: 'm', label: 'Merges', points: [{ x: 0, y: 5 }, ...pts([1, 2, 3])] }]} />,
    );
    const labels = [...container.querySelectorAll('[data-axis-label]')].map((t) => t.textContent);
    expect(labels[0]).toBe('Sep 1');
    expect(labels.some((l) => /Dec 31|Jan 1/.test(l ?? ''))).toBe(false);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Merges: 3 points from Sep 1 to Sep 3/);
  });

  it('widens a burst of readings seconds apart instead of stacking three labels', () => {
    const weekly = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const { container } = render(
      <AreaTrend
        title="Claude · weekly"
        width={300}
        formatX={weekly}
        series={[{ id: 'r', label: 'Remaining', points: [{ x: T, y: 40 }, { x: T + 20_000, y: 39 }, { x: T + 40_000, y: 38 }] }]}
      />,
    );
    const boxes = axisLabelBoxes(container);
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    expect(noOverlap(boxes)).toBe(true);
    expect(new Set(boxes.map((b) => b.text)).size).toBe(boxes.length);
    // Inside one day the axis speaks in clock times.
    for (const b of boxes) expect(b.text).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    // The burst sits as a cluster, not stretched edge to edge.
    const line = container.querySelector('g[data-series="r"] path[class*="line"]')!;
    const xs = [...(line.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(40);
  });

  it('draws a percent card on 0–100% like its burn-down siblings, and honours an explicit domain', () => {
    const pctFmt = (v: number) => `${Math.round(v)}%`;
    const { container, unmount } = render(
      <AreaTrend title="Claude · weekly" width={600} formatY={pctFmt} series={[{ id: 'r', label: 'Remaining', points: pts([40, 38, 35]) }]} />,
    );
    expect(tickTexts(container)).toEqual(['0%', '25%', '50%', '75%', '100%']);
    unmount();
    const explicit = render(
      <AreaTrend title="Spend" width={600} yDomain={[0, 200]} series={[{ id: 'r', label: 'Spend', points: pts([40, 38, 35]) }]} />,
    );
    expect(tickTexts(explicit.container).at(-1)).toBe('200');
  });

  it('keeps x labels apart at 375 px with long caller labels', () => {
    const DAY = 86_400_000;
    const long = (ms: number) => `week ending ${new Date(ms).toISOString().slice(0, 10)}`;
    const { container } = render(
      <AreaTrend title="Merges" width={375} formatX={long} series={[{ id: 'm', label: 'Merges', points: Array.from({ length: 8 }, (_, i) => ({ x: T0 + i * 7 * DAY, y: i })) }]} />,
    );
    const boxes = axisLabelBoxes(container);
    expect(noOverlap(boxes)).toBe(true);
    expect(boxes.at(-1)!.key).toBe('7'); // the last point always keeps its label
  });
});
