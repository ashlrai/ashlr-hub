import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ForestPlot, forestVerdict, type ForestRow } from './ForestPlot.js';
import { showTable } from './chart-test-support.js';

const rows: ForestRow[] = [
  { id: 'e1', label: 'Judge prompt v2', estimate: 4.2, low: 1.1, high: 7.3, n: 12, detail: 'adopted' },
  { id: 'e2', label: 'Lower temperature', estimate: -3, low: -5.5, high: -0.5, n: 9, detail: 'rejected' },
  { id: 'e3', label: 'Effort high', estimate: 0.8, low: -1.2, high: 2.8, n: 10, detail: 'inconclusive' },
  { id: 'e4', label: 'Skills pack', estimate: null, low: null, high: null, n: 3, detail: 'running' },
];

describe('forestVerdict', () => {
  it('reads the interval, not the dot', () => {
    expect(rows.map(forestVerdict)).toEqual(['positive', 'negative', 'none', 'unknown']);
  });
});

describe('ForestPlot', () => {
  it('draws a whisker and a point per known row, colour by interval, and hatches the unknown row', () => {
    const { container } = render(<ForestPlot title="Experiments" width={720} rows={rows} unit="pts" />);
    expect(container.querySelectorAll('[data-role="ci"]')).toHaveLength(3);
    expect(container.querySelector('[data-row="e1"]')!.getAttribute('data-verdict')).toBe('positive');
    expect(container.querySelector('[data-row="e1"] [data-role="estimate"]')!.getAttribute('fill')).toBe('var(--chart-diverging-pos)');
    expect(container.querySelector('[data-row="e2"] [data-role="estimate"]')!.getAttribute('fill')).toBe('var(--chart-diverging-neg)');
    const unknown = container.querySelector('[data-row="e4"] [data-role="unknown"] rect')!;
    expect(unknown.getAttribute('fill')).toMatch(/^url\(#chart-hatch-/);
    expect(container.querySelector('[data-role="zero"]')!.getAttribute('stroke')).toBe('var(--chart-diverging-mid)');
    expect(screen.getByText('not enough pairs yet', { selector: 'text' })).toBeInTheDocument();
  });

  it('announces each row in words from the keyboard', () => {
    render(<ForestPlot title="Experiments" width={720} rows={rows} unit="pts" />);
    const group = screen.getByRole('group');
    fireEvent.focus(group);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Judge prompt v2: +4.2 pts, 95% interval +1.1 to +7.3; helped (interval above zero)');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(live.textContent).toContain('hurt (interval below zero)');
    fireEvent.keyDown(group, { key: 'End' });
    expect(live.textContent).toBe('Skills pack: not enough pairs yet');
  });

  it('fits 375 px (numbers fold into the table) and the table has every row', () => {
    const { container } = render(<ForestPlot title="Experiments" width={375} rows={rows} unit="pts" />);
    const svg = container.querySelector('svg[role="img"]')!;
    expect(Number(svg.getAttribute('width'))).toBe(375);
    for (const el of container.querySelectorAll('svg[role="img"] line, svg[role="img"] rect')) {
      const x = Number(el.getAttribute('x2') ?? el.getAttribute('x') ?? 0);
      expect(x).toBeLessThanOrEqual(375);
    }
    expect(screen.queryByText(/\[\+1\.1, \+7\.3\]/)).toBeNull();
    showTable();
    expect(screen.getByRole('cell', { name: '+1.1 to +7.3' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'not enough pairs yet' })).toBeInTheDocument();
  });

  it('has a designed empty state', () => {
    render(<ForestPlot title="Experiments" rows={[]} />);
    expect(screen.getByText('No experiments have run yet.')).toBeInTheDocument();
  });
});
