import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MatrixHeatmap, matrixTotals } from './MatrixHeatmap.js';
import { showTable } from './chart-test-support.js';

const rows = [
  { id: 'loop', label: 'Loop' },
  { id: 'struggle', label: 'Struggle' },
];
const columns = [
  { id: 'claude', label: 'Claude', engine: 'claude' as const },
  { id: 'grok', label: 'Grok', engine: 'grok' as const },
  { id: 'local', label: 'Local', engine: 'local' as const },
];
const values = [
  [4, 0, null],
  [1, 2, null],
];

describe('matrixTotals', () => {
  it('sums known cells and keeps an all-unknown line unknown', () => {
    const t = matrixTotals(values, 2, 3);
    expect(t.rows).toEqual([4, 3]);
    expect(t.columns).toEqual([5, 2, null]);
    expect(t.max).toBe(4);
    expect(t.grand).toBe(7);
  });
});

describe('MatrixHeatmap', () => {
  it('ramps known cells, keeps a true zero faint and hatches unknown cells', () => {
    const { container } = render(<MatrixHeatmap title="Insights" width={720} rows={rows} columns={columns} values={values} unit="insights" />);
    expect(container.querySelector('[data-cell="loop:claude"]')!.getAttribute('fill')).toBe('var(--chart-seq-7)');
    expect(container.querySelector('[data-cell="loop:grok"]')!.getAttribute('fill')).toBe('var(--chart-heat-0)');
    expect(container.querySelector('[data-cell="loop:local"]')!.getAttribute('fill')).toMatch(/^url\(#chart-hatch-/);
    // Engine columns carry the tick + monogram, never a logo.
    expect(container.querySelectorAll('[data-engine]')).toHaveLength(3);
    expect(container.querySelector('[data-row-total="loop"]')!.textContent).toBe('4');
    expect(screen.getByText('not measured')).toBeInTheDocument();
  });

  it('walks cells with the arrow keys and speaks them', () => {
    render(<MatrixHeatmap title="Insights" width={720} rows={rows} columns={columns} values={values} unit="insights" />);
    const grid = screen.getByRole('group');
    fireEvent.focus(grid);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Loop × Claude: 4 insights');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'End' });
    expect(live.textContent).toBe('Struggle × Local: not measured');
  });

  it('renders at 375 and can start on the table (Mind at compact width)', () => {
    const { container } = render(
      <MatrixHeatmap title="Insights" width={375} defaultView="table" rows={rows} columns={columns} values={values} />,
    );
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '—' })).toHaveLength(2);
  });

  it('says unknown when nothing was measured', () => {
    render(<MatrixHeatmap title="Insights" rows={rows} columns={columns} values={[[null, null, null], [null, null, null]]} />);
    expect(screen.getByRole('note')).toHaveTextContent('no cell in this matrix was measured');
  });

  it('fits a 375 px card', () => {
    const { container } = render(<MatrixHeatmap title="Insights" width={375} rows={rows} columns={columns} values={values} />);
    expect(Number(container.querySelector('svg[role="img"]')!.getAttribute('width'))).toBeLessThanOrEqual(375);
    showTable();
    expect(screen.getByRole('cell', { name: 'Loop' })).toBeInTheDocument();
  });
});

describe('MatrixHeatmap V3.10.1 — in-cell numbers', () => {
  it('prints each value in a plain fill chosen by the cell luminance, with no halo stroke', () => {
    const { container } = render(<MatrixHeatmap title="Insights" width={720} rows={rows} columns={columns} values={values} unit="insights" />);
    const text = (cell: string) => container.querySelector(`[data-cell-value="${cell}"]`)!;
    // 4 of max 4 → the darkest step (light theme) → surface ink (white).
    expect(text('loop:claude').getAttribute('fill')).toBe('var(--chart-surface)');
    // 1 of 4 → a pale step → the quantity ink; a true zero on heat-0 → the quantity ink.
    expect(text('struggle:claude').getAttribute('fill')).toBe('var(--chart-quantity-ink)');
    expect(text('loop:grok').getAttribute('fill')).toBe('var(--chart-quantity-ink)');
    for (const el of container.querySelectorAll('[data-cell-value]')) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/halo|labelStrong/);
      expect(el.getAttribute('stroke')).toBeNull();
    }
  });
});
