/**
 * ui-parts.test.tsx — the phone Meter's default text follows the one percent
 * rule (routes/verse/percent-text.ts). It is both the visible readout and the
 * meter's aria-valuetext, so rounding alone told a screen reader a 99.6%
 * window was "100% used" (spent) and a 0.3% one "0% used" (untouched).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Meter } from './ui-parts.js';

describe('mobile Meter — one percent rule', () => {
  it('reads 99.6% as "99% used", never "100% used"; aria-valuenow stays numeric', () => {
    render(<Meter label="Claude" percent={99.6} />);
    const meter = screen.getByRole('meter', { name: 'Claude' });
    expect(meter).toHaveAttribute('aria-valuetext', '99% used');
    expect(meter).toHaveAttribute('aria-valuenow', '99.6');
    expect(screen.getByText('99% used')).toBeInTheDocument();
  });

  it('reads a real reading under 1% as "<1% used", never "0% used"', () => {
    render(<Meter label="Grok" percent={0.3} />);
    expect(screen.getByRole('meter', { name: 'Grok' })).toHaveAttribute('aria-valuetext', '<1% used');
  });

  it('keeps whole, empty, full and unknown readings exact', () => {
    const { rerender } = render(<Meter label="Seat" percent={42} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '42% used');
    rerender(<Meter label="Seat" percent={0} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '0% used');
    rerender(<Meter label="Seat" percent={100} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '100% used');
    rerender(<Meter label="Seat" percent={null} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', 'unknown');
  });
});
