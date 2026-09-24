import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Funnel } from './Funnel.js';
import { showTable } from './chart-test-support.js';

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
    showTable();
    expect(screen.getAllByRole('cell', { name: '24.5%' })).toHaveLength(2); // of previous = of first
    expect(screen.getByRole('cell', { name: '0.2%' })).toBeInTheDocument();
  });
});

describe('Funnel V3.10.1 — zero is an empty track', () => {
  const zeros = ['Filed', 'Verified', 'Passed'].map((label) => ({ id: label.toLowerCase(), label, value: 0 }));

  it('draws no bar at all for an all-zero window, only neutral tracks', () => {
    const { container } = render(<Funnel title="Pipeline" width={700} status={{ kind: 'ready' }} stages={zeros} />);
    expect(container.querySelectorAll('[data-role="bar"]')).toHaveLength(0);
    const tracks = container.querySelectorAll('[data-role="track"]');
    expect(tracks).toHaveLength(3);
    // The neutral true-zero ground, not the pale azure meter track.
    for (const t of tracks) expect(t.getAttribute('class')).toMatch(/trackEmpty/);
  });

  it('sizes bars as a share of the first stage', () => {
    const { container } = render(
      <Funnel title="Pipeline" width={700} stages={[{ id: 'a', label: 'Filed', value: 100 }, { id: 'b', label: 'Verified', value: 50 }]} />,
    );
    const widthOf = (id: string) => {
      const d = container.querySelector(`[data-stage="${id}"] [data-role="bar"]`)!.getAttribute('d')!;
      const xs = [...d.matchAll(/[MLQ]\s*([\d.]+),/g)].map((m) => Number(m[1]));
      return Math.max(...xs) - Math.min(...xs);
    };
    const track = Number(container.querySelector('[data-role="track"]')!.getAttribute('width'));
    expect(widthOf('a')).toBeCloseTo(track, 0);
    expect(widthOf('b')).toBeCloseTo(track / 2, 0);
  });
});
