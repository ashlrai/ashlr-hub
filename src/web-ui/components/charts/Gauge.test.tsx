import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Gauge } from './Gauge.js';

describe('Gauge', () => {
  it('is a meter with words-first severity', () => {
    const { container } = render(<Gauge title="Claude weekly" value={0.75} marker={{ value: 0.6, label: 'Autonomy stops' }} caption="resets Tue" />);
    const meter = screen.getByRole('meter', { name: 'Claude weekly' });
    expect(meter).toHaveAttribute('aria-valuenow', '0.75');
    expect(meter).toHaveAttribute('aria-valuetext', 'Claude weekly: 75%, near the limit');
    expect(screen.getByText('near the limit')).toBeInTheDocument();
    expect(screen.getByText('Autonomy stops: 60%')).toBeInTheDocument();
    expect(container.querySelector('[data-role="marker"]')).not.toBeNull();
    expect(container.querySelector('[data-role="fill"]')!.getAttribute('stroke')).toBe('var(--status-warning-solid)');
  });

  it('shows unknown, never 0%, for null', () => {
    const { container } = render(<Gauge title="Codex" value={null} />);
    expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('unknown', { selector: 'span' })).toBeInTheDocument();
    expect(container.querySelector('[data-role="fill"]')).toBeNull();
  });

  it('prints overages as they are while drawing a full arc', () => {
    render(<Gauge title="Cap" value={1.12} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('112%')).toBeInTheDocument();
    expect(screen.getByText('at the limit')).toBeInTheDocument();
  });
});

describe('Gauge V3.10 — fits its container', () => {
  it('sizes to the container, never below the floor or above the max', async () => {
    const { gaugeDiameter, MIN_GAUGE_SIZE } = await import('./Gauge.js');
    expect(gaugeDiameter(0, 180)).toBe(180); // not laid out yet (jsdom, hidden tab)
    expect(gaugeDiameter(150, 180)).toBe(150);
    expect(gaugeDiameter(60, 180)).toBe(MIN_GAUGE_SIZE);
    expect(gaugeDiameter(900, 180)).toBe(180);
  });

  it('hatches the track when the value is unknown', () => {
    const { container } = render(<Gauge title="Codex" value={null} />);
    expect(container.querySelector('[data-role="track"]')!.getAttribute('stroke')).toMatch(/^url\(#chart-hatch-/);
  });
});
