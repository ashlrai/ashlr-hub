import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkline, sparklineSummary } from './Sparkline.js';

describe('Sparkline', () => {
  it('keeps its original contract (label, gaps break the line)', () => {
    const { container } = render(<Sparkline points={[1, 2, null, 3, 4]} ariaLabel="Merges trend" />);
    expect(screen.getByRole('img', { name: 'Merges trend' })).toBeInTheDocument();
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('appends a spoken summary and an optional wash', () => {
    const { container } = render(<Sparkline points={[2, 5, null, 3]} ariaLabel="Runs" area describe={(v) => String(v)} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Runs: from 2 to 3, range 2 to 5, 1 point without data');
    expect(container.querySelectorAll('path').length).toBe(3); // one wash (2-point run) + two lines
  });

  it('draws a quiet baseline when fewer than two points are known', () => {
    const { container } = render(<Sparkline points={[null, 4]} ariaLabel="x" />);
    expect(container.querySelector('line')).not.toBeNull();
    expect(sparklineSummary([null, null], String)).toBe('no data');
  });
});
