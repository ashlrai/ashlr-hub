import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Funnel } from './Funnel.js';

const stages = [
  { id: 'filed', label: 'Filed', value: 542 },
  { id: 'verified', label: 'Verified', value: 133 },
  { id: 'passed', label: 'Passed', value: 1 },
  { id: 'ship', label: 'Judged ship', value: null },
  { id: 'merged', label: 'Merged', value: 0 },
];

describe('Funnel', () => {
  it('writes conversions in words and never guesses around an unknown stage', () => {
    const { container } = render(<Funnel title="Pipeline" width={700} stages={stages} />);
    const label = screen.getByRole('img').getAttribute('aria-label')!;
    expect(label).toContain('Verified 133 (25% of previous)');
    expect(label).toContain('Passed 1 (0.8% of previous)');
    expect(label).toContain('Judged ship unknown (— of previous)');
    expect(label).toContain('Merged 0 (— of previous)');
    expect(container.querySelectorAll('[data-unknown="true"]')).toHaveLength(1);
  });

  it('uses one hue for every stage and stacks labels above bars on a phone', () => {
    const { container } = render(<Funnel title="Pipeline" width={375} stages={stages.slice(0, 3)} />);
    const fills = new Set([...container.querySelectorAll('path')].map((p) => p.getAttribute('fill')));
    expect(fills.size).toBe(1);
    const label = screen.getByText('Filed');
    expect(label.getAttribute('text-anchor')).toBe('start');
  });

  it('reports unknown when the first stage is unknown, and empty when it is zero', () => {
    const { rerender } = render(<Funnel title="P" stages={[{ id: 'a', label: 'Filed', value: null }]} />);
    expect(screen.getByRole('note')).toHaveTextContent('the first stage (Filed) is unknown');
    rerender(<Funnel title="P" stages={[{ id: 'a', label: 'Filed', value: 0 }]} />);
    expect(screen.getByText('No filed in this window.')).toBeInTheDocument();
  });

  it('carries every rate in the table', () => {
    render(<Funnel title="P" width={700} stages={stages} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getAllByRole('cell', { name: '24.5%' })).toHaveLength(2); // of previous = of first
    expect(screen.getByRole('cell', { name: '0.2%' })).toBeInTheDocument();
  });
});
