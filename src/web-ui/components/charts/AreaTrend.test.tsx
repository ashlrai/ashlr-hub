import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AreaTrend } from './AreaTrend.js';
import { formatDayLabel } from './format.js';
import { showTable } from './chart-test-support.js';

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
