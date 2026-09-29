import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Meter } from './Meter.js';

/**
 * The shared Meter's spoken value follows the one percent rule
 * (routes/verse/percent-text.ts): rounding alone announced a 99.6% meter as
 * "100%" (spent) and a 0.3% one as "0%" (untouched). aria-valuenow stays the
 * plain numeric reading — ARIA requires a number there, and the text is what
 * a screen reader speaks when both are present.
 */
describe('Meter — aria-valuetext follows the one percent rule', () => {
  it('announces 99.6% as "99%", never a rounded "100%"', () => {
    render(<Meter value={996} max={1000} aria-label="Daily spend" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuetext', '99%');
    expect(meter).toHaveAttribute('aria-valuenow', '100');
  });

  it('announces a real reading under 1% as "<1%", never "0%"', () => {
    render(<Meter value={3} max={1000} variant="line" aria-label="Context" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuetext', '<1%');
    expect(meter).toHaveAttribute('aria-valuenow', '0');
  });

  it('keeps whole readings, an empty and a full meter exact', () => {
    const { rerender } = render(<Meter value={18} max={66} aria-label="Window" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '27%');
    rerender(<Meter value={0} max={66} aria-label="Window" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '0%');
    rerender(<Meter value={66} max={66} aria-label="Window" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '100%');
    // Over the limit: the bar clamps to full, and so does the text.
    rerender(<Meter value={80} max={66} aria-label="Window" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '100%');
  });

  it('says "unknown" (and no aria-valuenow) when the limit is unknown', () => {
    render(<Meter value={5} max={null} aria-label="Window" />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuetext', 'unknown');
    expect(meter).not.toHaveAttribute('aria-valuenow');
  });
});
