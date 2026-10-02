/**
 * HomeSeats.test.tsx — a seat meter's "N% used" follows the one percent rule
 * (routes/verse/percent-text.ts). Only `limitReached` may say a window is
 * spent; a measured 99.6% must not round up to "100% used".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { VerseSeat } from '../../../../data/api-types.js';
import { SeatMeter } from './HomeSeats.js';

const seat = (usedPercent: number | null): VerseSeat => ({
  id: 'claude',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'unknown', summary: null, windows: [{ id: 'five_hour', usedPercent, resetsAt: null }], observedAt: null },
});

describe('SeatMeter — one percent rule', () => {
  it('reads a 99.6% binding window as "99% used", never "100% used"', () => {
    render(<SeatMeter seat={seat(99.6)} />);
    expect(screen.getByText('99% used')).toBeInTheDocument();
    expect(screen.queryByText('100% used')).toBeNull();
  });

  it('reads a real reading under 1% as "<1% used", never "0% used"', () => {
    render(<SeatMeter seat={seat(0.4)} />);
    expect(screen.getByText('<1% used')).toBeInTheDocument();
  });

  it('keeps a whole reading as-is', () => {
    render(<SeatMeter seat={seat(37)} />);
    expect(screen.getByText('37% used')).toBeInTheDocument();
  });
});
