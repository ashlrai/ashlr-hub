import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PulseView } from './PulseView.js';
import { evictAll } from '../../../data/cache.js';

const ROLLUP_7D = {
  window: '7d',
  since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  totals: { tokensIn: 10_000, tokensOut: 5_000, estCostUsd: 12.5, sessions: 4, commits: 6 },
  byProject: [
    { project: '/repos/ashlr-hub', sessions: 3, commits: 5, tokensIn: 8000, tokensOut: 4000, estCostUsd: 10, lastActive: new Date().toISOString() },
  ],
  // Deliberate gap: day 2 is missing tokens (represented here as a day with
  // no session activity — the view must not fabricate a data point for it).
  byDay: [
    { day: '2026-08-10', tokensIn: 5000, tokensOut: 2500, estCostUsd: 6, sessions: 2 },
    { day: '2026-08-12', tokensIn: 5000, tokensOut: 2500, estCostUsd: 6.5, sessions: 2 },
  ],
  byModel: [{ model: 'claude-sonnet-5', tokensIn: 10000, tokensOut: 5000, estCostUsd: 12.5, calls: 4 }],
  budget: { level: 'ok', window: '7d', spentUsd: 12.5, capUsd: 100, spentTokens: 15000, capTokens: 1_000_000, message: 'under budget' },
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/pulse')) return new Response(JSON.stringify(ROLLUP_7D), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('PulseView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders KPIs, budget status, and chart data from a real rollup', async () => {
    render(<PulseView />);

    await waitFor(() => expect(screen.getByText('under budget')).toBeInTheDocument());

    expect(screen.getAllByText('$12.50').length).toBeGreaterThan(0); // total cost KPI (+ table twin)
    expect(screen.getAllByText('4').length).toBeGreaterThan(0); // sessions KPI (+ table twin values)
    expect(screen.getAllByText('ashlr-hub').length).toBeGreaterThan(0); // top project bar label (+ table twin)
  });

  it('exposes the full daily series via the table-view twin, including the gap day', async () => {
    render(<PulseView />);
    await waitFor(() => expect(screen.getByText('Cost over time')).toBeInTheDocument());

    // The table twin lists every day the rollup returned (2 days here) —
    // it must not synthesize a 3rd "filled" day for the gap between them.
    expect(screen.getByText('2026-08-10')).toBeInTheDocument();
    expect(screen.getByText('2026-08-12')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-11')).not.toBeInTheDocument();
  });
});
