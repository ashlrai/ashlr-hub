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

describe('StepBand V3.10.1', () => {
  const tickTexts = (root: ParentNode) =>
    [...root.querySelectorAll('svg[role="img"] text')].filter((t) => t.getAttribute('text-anchor') === 'end' && !t.hasAttribute('data-axis-label')).map((t) => t.textContent);

  it('labels an all-zero lift axis 0 / +1, never +1.0 / +0.8 / +0.5 / +0.3', () => {
    const { container } = render(
      <StepBand title="Harness level" width={720} now={T0 + 2 * D} steps={[{ id: 'b', at: T0, value: 0, low: 0, high: 0, label: 'Compiled defaults' }]} />,
    );
    expect(tickTexts(container)).toEqual(['0', '+1']);
  });

  it('prints fractional lifts at the step precision with a sign', () => {
    const { container } = render(
      <StepBand title="Harness level" width={720} now={T0 + 2 * D} steps={[{ id: 'b', at: T0, value: 0.4, low: 0.1, high: 0.9, label: 'h-1' }]} />,
    );
    expect(tickTexts(container)).toEqual(['0', '+0.2', '+0.4', '+0.6', '+0.8', '+1.0']);
  });

  it('keeps an epoch-0 baseline off the axis: no "Dec 31", and "—" in the table', () => {
    const { container } = render(
      <StepBand
        title="Harness level"
        width={720}
        now={T0 + 12 * D}
        formatTime={(ms) => new Date(ms).toISOString().slice(0, 10)}
        steps={[{ id: 'b', at: 0, value: 0, label: 'Compiled defaults' }, { ...steps[1]!, at: T0 + 3 * D }]}
        markers={[{ id: 'm0', at: 0, kind: 'rollback', label: 'bogus' }]}
      />,
    );
    const labels = [...container.querySelectorAll('[data-axis-label]')].map((t) => t.textContent);
    expect(labels).toEqual(['2026-09-04', '2026-09-13']);
    expect(container.querySelector('[data-marker]')).toBeNull();
    showTable();
    expect(screen.getAllByRole('cell', { name: '—' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('cell', { name: '1970-01-01' })).toBeNull();
  });

  it('widens a degenerate span so the ends are two different labels', () => {
    const { container } = render(<StepBand title="H" width={720} now={T0} steps={[{ id: 'a', at: T0, value: 1, label: 'h-1' }]} />);
    const labels = [...container.querySelectorAll('[data-axis-label]')].map((t) => t.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
