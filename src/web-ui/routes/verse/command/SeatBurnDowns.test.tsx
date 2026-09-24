/**
 * Seat burn-down cards (review 3.10 c17 + d2): the weekly axis carries dates,
 * and a 5-hour chart draws the 5-hour ceiling — so its verdict agrees with the
 * server's eligibility instead of claiming autonomy stopped at the weekly
 * reserve.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SeatBurnCard } from './SeatBurnDowns.js';
import type { SeatBurn } from './command-model.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function burn(over: Partial<SeatBurn>): SeatBurn {
  return {
    seatId: 'claude-a',
    label: 'Claude',
    engine: 'claude',
    window: 'weekly',
    points: [],
    start: null,
    resetAt: null,
    resetText: null,
    reservePercent: 40,
    line: { value: 40, label: 'Reserved for you' },
    enabled: true,
    free: false,
    eligible: true,
    reason: null,
    ...over,
  };
}

describe('SeatBurnCard', () => {
  it('weekly: the start and reset labels differ (they carry the date)', () => {
    const resetAt = NOW + 2 * 24 * HOUR;
    const { container } = render(
      <SeatBurnCard burn={burn({ start: resetAt - 7 * 24 * HOUR, resetAt, points: [{ t: NOW - HOUR, remaining: 70 }, { t: NOW, remaining: 68 }] })} now={NOW} width={320} />,
    );
    const text = container.textContent ?? '';
    const reset = /Resets ([A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, [^R]*?(AM|PM))/.exec(text);
    expect(reset).not.toBeNull();
    // The window start (7 days earlier) is on the same weekday and time, so only the date tells them apart.
    const startLabel = new Date(resetAt - 7 * 24 * HOUR).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(text).toContain(startLabel);
    expect(startLabel).not.toBe(reset![1]);
  });

  it('5-hour binding: 35% remaining is above the 70% ceiling, so it never says autonomy stopped', () => {
    // Review scenario: weekly 20% used, 5-hour 65% used → server: session binds, eligible.
    const resetAt = NOW + 2 * HOUR;
    render(
      <SeatBurnCard
        burn={burn({ window: 'session', start: resetAt - 5 * HOUR, resetAt, line: { value: 30, label: '5-hour ceiling' }, points: [{ t: NOW - 30 * MIN, remaining: 36 }, { t: NOW, remaining: 35 }] })}
        now={NOW}
        width={320}
      />,
    );
    expect(screen.getByText('Autonomy may use it now')).toBeInTheDocument();
    expect(screen.queryByText(/Inside .* autonomy has stopped/)).toBeNull();
    expect(screen.queryByText(/Reserved for you/)).toBeNull();
  });

  // P4 regression: Claude windows carry readings but no machine reset time.
  // The card used to say "No window reading" whenever resetAt was null.
  it('no machine reset: shows the reading and the provider\'s words, and projects nothing to a reset', () => {
    const { container } = render(
      <SeatBurnCard
        burn={burn({ window: 'session', line: { value: 30, label: '5-hour ceiling' }, resetText: 'Sep 24 at 5pm (America/New_York)', points: [{ t: NOW - 30 * MIN, remaining: 30 }, { t: NOW, remaining: 26 }], eligible: false, reason: '5-hour window at 74% — above the 70% ceiling' })}
        now={NOW}
        width={320}
      />,
    );
    expect(screen.queryByText(/No window reading/)).toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('26% left · resets Sep 24 at 5pm (America/New_York) · 5-hour window at 74% — above the 70% ceiling');
    expect(text).toContain('The provider reports this reset only in words');
    // No reset marker, no projection line — nothing points at an instant nobody published.
    expect(text).not.toMatch(/Resets /);
    expect(container.querySelector('[data-role="projection"]')).toBeNull();
    // The readings ARE drawn, with the 5-hour ceiling as the stop line.
    expect(text).toContain('5-hour ceiling');
    expect(container.querySelector('svg path')).not.toBeNull();
  });

  it('no machine reset and no words: says the reset was not reported', () => {
    render(<SeatBurnCard burn={burn({ window: 'weekly', points: [{ t: NOW, remaining: 46 }] })} now={NOW} width={320} />);
    expect(screen.getByText(/46% left · reset time not reported · Autonomy may use it now/)).toBeInTheDocument();
    expect(screen.getByText(/No reset time was reported for this window/)).toBeInTheDocument();
  });

  it('still says "No window reading" when there is no reading at all', () => {
    render(<SeatBurnCard burn={burn({ window: 'session', points: [] })} now={NOW} width={320} />);
    expect(screen.getByText(/No window reading/)).toBeInTheDocument();
    render(<SeatBurnCard burn={burn({ window: null, points: [{ t: NOW, remaining: 50 }] })} now={NOW} width={320} />);
    expect(screen.getAllByText(/No window reading/)).toHaveLength(2);
  });
});
