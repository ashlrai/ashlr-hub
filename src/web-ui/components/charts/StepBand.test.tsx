import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StepBand, stepSpans, type StepPoint } from './StepBand.js';
import { showTable } from './chart-test-support.js';

const D = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const steps: StepPoint[] = [
  { id: 'h0', at: T0, value: 0, low: 0, high: 0, label: 'Baseline', detail: 'defaults' },
  { id: 'h1', at: T0 + 3 * D, value: 4, low: 1, high: 7, label: 'h-0001', detail: 'adopted' },
  { id: 'h2', at: T0 + 8 * D, value: null, label: 'h-0002', detail: 'canary' },
  { id: 'h3', at: T0 + 10 * D, value: 4, low: 1, high: 7, label: 'h-0001', detail: 'restored' },
];

describe('stepSpans', () => {
  it('holds each step until the next one, the last until now', () => {
    const spans = stepSpans([steps[1]!, steps[0]!], T0 + 5 * D);
    expect(spans.map((s) => [s.id, s.until])).toEqual([
      ['h0', T0 + 3 * D],
      ['h1', T0 + 5 * D],
    ]);
  });
});

describe('StepBand', () => {
  it('draws flat steps with a band, breaks at an unknown step and marks rollbacks with ▼', () => {
    const { container } = render(
      <StepBand
        title="Harness lift"
        width={720}
        now={T0 + 12 * D}
        steps={steps}
        markers={[{ id: 'rb', at: T0 + 10 * D, kind: 'rollback', label: 'h-0002 fell below baseline' }]}
        baseline={{ value: 0, label: 'Compiled defaults' }}
        unit="pts"
      />,
    );
    expect(container.querySelectorAll('[data-role="level"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-role="band"]')).toHaveLength(3);
    expect(container.querySelector('[data-step="h2"]')!.getAttribute('fill')).toMatch(/^url\(#chart-hatch-/);
    const marker = container.querySelector('[data-marker="rollback"]')!;
    expect(marker.getAttribute('fill')).toBe('var(--chart-diverging-neg)');
    expect(screen.getByText('Compiled defaults')).toBeInTheDocument();
  });

  it('walks steps from the keyboard in words', () => {
    render(<StepBand title="Harness lift" width={720} now={T0 + 12 * D} steps={steps} unit="pts" formatTime={(ms) => `day ${Math.round((ms - T0) / D)}`} />);
    const group = screen.getByRole('group');
    fireEvent.focus(group);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('h-0001 (restored), day 10 to day 12: +4.0 pts, 95% interval +1.0 to +7.0');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(live.textContent).toBe('h-0002 (canary), day 8 to day 10: not measured');
  });

  it('fits 375 px and lists rollbacks in the table', () => {
    const { container } = render(
      <StepBand title="Harness lift" width={375} now={T0 + 12 * D} steps={steps} markers={[{ id: 'rb', at: T0 + 10 * D, kind: 'rollback', label: 'canary below baseline' }]} />,
    );
    expect(Number(container.querySelector('svg[role="img"]')!.getAttribute('width'))).toBe(375);
    showTable();
    expect(screen.getByRole('cell', { name: '▼ Rolled back: canary below baseline' })).toBeInTheDocument();
  });

  it('empty and unknown are designed states', () => {
    const { unmount } = render(<StepBand title="Harness" steps={[]} />);
    expect(screen.getByText('No versions yet — the compiled defaults are in force.')).toBeInTheDocument();
    unmount();
    render(<StepBand title="Harness" steps={[{ id: 'a', at: T0, value: null, label: 'h-1' }]} />);
    expect(screen.getByRole('note')).toHaveTextContent('no version has a measured value yet');
  });
});
