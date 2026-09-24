import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CalendarHeatmap } from './CalendarHeatmap.js';
import { showTable } from './chart-test-support.js';

function days(n: number, start = '2026-01-05', value = (i: number) => (i % 7 === 3 ? null : i % 5)): { day: string; value: number | null }[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({ day: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), value: value(i) }));
}

describe('CalendarHeatmap', () => {
  it('distinguishes a true zero from unknown', () => {
    const { container } = render(<CalendarHeatmap title="Runs" width={800} days={days(14)} unit="runs" />);
    expect(container.querySelector('rect[data-day="2026-01-05"]')!.getAttribute('data-bucket')).toBe('0');
    const unknown = container.querySelector('rect[data-day="2026-01-08"]')!;
    expect(unknown.getAttribute('data-bucket')).toBe('unknown');
    // V3.10: unknown is the 45° hatch, not an empty or pale cell.
    expect(unknown.getAttribute('fill')).toMatch(/^url\(#chart-hatch-/);
    expect(container.querySelector(`pattern#${unknown.getAttribute('fill')!.slice(5, -1)}`)).not.toBeNull();
    expect(container.querySelector('rect[data-day="2026-01-09"]')!.getAttribute('data-bucket')).toBe('4');
    expect(screen.getByText('no data')).toBeInTheDocument();
  });

  it('shows the latest weeks that fit at 375 px and says how many are hidden', () => {
    const { container } = render(<CalendarHeatmap title="Runs" width={375} days={days(365)} />);
    const svg = container.querySelector('svg[role="img"]')!;
    expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(375);
    expect(screen.getByText(/Showing the latest \d+ weeks; \d+ earlier weeks are in the table\./)).toBeInTheDocument();
    expect(container.querySelector('rect[data-day="2026-12-31"]') ?? container.querySelector('rect[data-day="2027-01-04"]')).not.toBeNull();
    showTable();
    expect(screen.getAllByRole('row')).toHaveLength(366);
  });

  it('moves a focus day with the arrow keys and announces it', () => {
    render(<CalendarHeatmap title="Runs" width={800} days={days(14)} unit="runs" />);
    const grid = screen.getByRole('group');
    fireEvent.focus(grid);
    const live = () => document.querySelector('[aria-live="polite"]')!.textContent;
    expect(live()).toBe('Jan 18: 3 runs');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(live()).toBe('Jan 11: 1 runs');
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(live()).toBe('Jan 10: 0 runs');
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(live()).toBe('Jan 5: 0 runs');
  });

  it('summarises totals, busiest day and missing days', () => {
    render(<CalendarHeatmap title="Runs" width={800} days={days(7)} unit="runs" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Runs: 7 days, 8 runs in total, busiest Jan 9 with 4, 1 days without data.');
  });
});
