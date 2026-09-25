/**
 * SpendPanel.test.tsx — the Spend card's day axis names the same calendar day
 * as the table under it, in every zone.
 *
 * The ledger's days are calendar dates ("2026-09-24"). Stamped at UTC
 * midnight, they were labelled in LOCAL time by the chart kit, so west of UTC
 * the axis and tooltip read "Sep 23" for the row the table calls "Sep 24".
 * Each case runs in a named zone on either side of UTC (growth's
 * time-zone.test-support), so the check bites on a UTC CI box too.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { inTimeZone, TEST_ZONES } from '../growth/time-zone.test-support.js';
import { SpendPanel } from './SpendPanel.js';

describe('SpendPanel — the per-day spend line', () => {
  it.each([...TEST_ZONES, 'America/Los_Angeles'])('labels the axis ends with the ledger days themselves (%s)', (zone) => inTimeZone(zone, () => {
    render(
      <SpendPanel
        series={{
          available: true,
          tickCount: 9,
          caveat: 'Autonomous loop only.',
          days: [
            { day: '2026-09-22', usd: 0.4 },
            { day: '2026-09-23', usd: null },
            { day: '2026-09-24', usd: 1.25 },
          ],
        }}
        todaySpentUsd={null}
        todaySpentDate={null}
        dailyBudgetUsd={5}
      />,
    );
    const chart = screen.getByRole('img', { name: 'Autonomous loop spend per day' });
    const axis = chart.textContent ?? '';
    expect(axis).toContain('Sep 22');
    expect(axis).toContain('Sep 24');
    // Never the day before the first bucket (the UTC-midnight shift west of UTC).
    expect(axis).not.toContain('Sep 21');
    cleanup();
  }));
});
