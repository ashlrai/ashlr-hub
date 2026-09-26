import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BarStack } from './BarStack.js';
import { toneColor } from './colors.js';
import { showTable } from './chart-test-support.js';

const segments = [
  { id: 'done', label: 'Done', color: toneColor('success') },
  { id: 'failed', label: 'Failed', color: toneColor('danger') },
];

describe('BarStack', () => {
  it('stacks segments with the rounded data end only on top and caps bar width at 24 px', () => {
    const { container } = render(
      <BarStack title="Runs" width={400} categories={['Mon', 'Tue']} segments={segments} values={[[3, 1], [2, 0]]} />,
    );
    const col0 = container.querySelector('g[data-column="0"]')!;
    expect(col0.querySelector('rect[data-segment="done"]')).not.toBeNull(); // bottom: square rect
    expect(col0.querySelector('path[data-segment="failed"]')).not.toBeNull(); // top: rounded path
    const col1 = container.querySelector('g[data-column="1"]')!;
    expect(col1.querySelector('path[data-segment="done"]')).not.toBeNull(); // zero segment skipped → done is top
    expect(Number(col0.querySelector('rect')!.getAttribute('width'))).toBeLessThanOrEqual(24);
  });

  it('never draws unknown as zero: placeholder for all-null, lower-bound cap for partial', () => {
    const { container } = render(
      <BarStack title="Runs" width={400} categories={['Mon', 'Tue', 'Wed']} segments={segments} values={[[null, null], [2, null], [1, 1]]} />,
    );
    expect(container.querySelectorAll('[data-unknown="true"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-incomplete="true"]')).toHaveLength(1);
    const group = screen.getByRole('group');
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('Tue: Done 2, Failed no data; total ≥ 2');
  });

  it('normalizes to 100% when asked', () => {
    render(<BarStack title="Mix" width={400} normalize categories={['a']} segments={segments} values={[[1, 3]]} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('turns a window of known zeros into the designed empty state', () => {
    render(<BarStack title="Runs" categories={['a', 'b']} segments={segments} values={[[0, 0], [0, 0]]} />);
    expect(screen.getByText('Nothing happened in this window.')).toBeInTheDocument();
  });

  it('has a legend for two segments and a table with totals', () => {
    render(<BarStack title="Runs" width={400} categories={['Mon']} segments={segments} values={[[3, 1]]} />);
    expect(screen.getByText('Failed', { selector: 'li' })).toBeInTheDocument();
    showTable();
    expect(screen.getByRole('cell', { name: '4' })).toBeInTheDocument();
  });
});

describe('BarStack V3.10', () => {
  it('hatches an all-unknown column and names it in the legend', () => {
    const { container } = render(
      <BarStack title="Runs" width={375} categories={['Mon', 'Tue']} segments={segments} values={[[null, null], [1, 1]]} />,
    );
    const unknown = container.querySelector('[data-unknown="true"]')!;
    expect(unknown.getAttribute('fill')).toMatch(/^url\(#chart-hatch-/);
    expect(screen.getByText('no data', { selector: 'li' })).toBeInTheDocument();
  });
});

describe('BarStack V3.10.1', () => {
  it('puts integer counts on whole-number ticks (a max of 1 run is 0 and 1)', () => {
    const { container } = render(<BarStack title="Model outcomes" width={400} categories={['a', 'b']} segments={segments} values={[[1, 0], [0, 1]]} />);
    const ticks = [...container.querySelectorAll('svg[role="img"] text')].filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent);
    expect(ticks).toEqual(['0', '1']);
  });
});

describe('BarStack category titles', () => {
  it('keeps the short label on the axis but names the full title in the tooltip, table and live text', () => {
    const { container } = render(
      <BarStack
        title="Model outcomes"
        width={400}
        categories={['grok-4.7-fast…', 'qwen3.8']}
        categoryTitles={['grok-4.7-fast-reasoning', undefined]}
        segments={segments}
        values={[[3, 1], [2, 0]]}
      />,
    );
    const axis = [...container.querySelectorAll('svg[role="img"] text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent);
    expect(axis).toEqual(['grok-4.7-fast…', 'qwen3.8']);
    expect(container.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toContain('Highest: grok-4.7-fast-reasoning with 4.');
    const group = screen.getByRole('group');
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('grok-4.7-fast-reasoning: Done 3, Failed 1; total 4');
    expect(screen.getByText('grok-4.7-fast-reasoning', { selector: ':not([aria-live]):not(svg *)' })).toBeInTheDocument();
    showTable();
    expect(screen.getByRole('cell', { name: 'grok-4.7-fast-reasoning' })).toBeInTheDocument();
    // No title for a category: it falls back to the label.
    expect(screen.getByRole('cell', { name: 'qwen3.8' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'grok-4.7-fast…' })).toBeNull();
  });
});
