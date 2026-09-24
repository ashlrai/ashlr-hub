import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile, deltaText } from './StatTile.js';

describe('StatTile', () => {
  it('puts the sparkline directly under the number and writes the delta with its unit and comparison', () => {
    const { container } = render(
      <StatTile
        label="Merged · 7d"
        value="23"
        delta={{ value: 5, unit: 'merges', versus: 'vs prior 7d', goodWhenPositive: true }}
        trend={[1, 2, 3, 2, 4, 5, 6]}
        trendLabel="Merges per day"
        caption="post-merge green 96%"
      />,
    );
    const tile = container.querySelector('[data-stat-tile]')!;
    const children = [...tile.children].map((el) => el.tagName.toLowerCase());
    // label, number, sparkline, then the meta line.
    expect(children).toEqual(['span', 'span', 'span', 'div']);
    expect(tile.children[2]!.querySelector('svg[role="img"]')).not.toBeNull();
    expect(screen.getByText('+5 merges vs prior 7d')).toBeInTheDocument();
  });

  it('formats signed deltas the caller controls (points, durations) and stays neutral when told nothing', () => {
    expect(deltaText({ value: -1.5, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, unit: 'pts', versus: 'vs prior 7d' })).toBe('-1.5 pts vs prior 7d');
    expect(deltaText({ value: 3 })).toBe('+3');
  });

  it('keeps the legacy API (value, caption, bare delta)', () => {
    render(<StatTile label="Sessions" value="12" caption="7d" delta={{ value: -1, goodWhenPositive: true }} />);
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
  });
});
