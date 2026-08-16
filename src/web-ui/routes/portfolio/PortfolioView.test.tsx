import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioView } from './PortfolioView.js';
import { evictAll } from '../../data/cache.js';

const SNAPSHOT = {
  generatedAt: new Date().toISOString(),
  repos: { total: 3, dirty: 0, stale: 0 },
  tools: { installed: 0, total: 0 },
  activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
  runs: [],
  swarms: [],
  mcp: [],
  genome: { entries: 0, projects: 0 },
  inbox: { pending: 0 },
};

const PORTFOLIO = {
  health: {
    reposScored: 3,
    averageScore: 72,
    averageGrade: 'B',
    worstRepos: [{ repo: '/repos/legacy-app', score: 41, grade: 'D' }],
  },
  goalsInFlight: [
    { goalId: 'goal1', objective: 'ship the chart layer', status: 'active', fractionDone: 0.5, proposed: 1, totalMilestones: 4, nextActionable: 'wire nav-config' },
  ],
  backlogTop: [{ title: 'add retry to judge client', repo: '/repos/ashlr-hub', score: 8.4 }],
  cost: { window: '7d', spentUsd: 4.2, localSavingsUsd: 10, projectedMonthlyUsd: 18 },
  effectiveness: { successRate: 0.6, effectivenessDeltaPct: 2.1, headline: 'Effectiveness trending up' },
  today: { previousAt: new Date().toISOString(), pendingProposalsDelta: 1, dirtyReposDelta: 0, spendUsdDelta: 0.4, healthScoreDelta: -1 },
};

function mockFetch(portfolioBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/portfolio')) return new Response(JSON.stringify(portfolioBody), { status: 200 });
    if (url.startsWith('/api/snapshot')) return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('PortfolioView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders health, goals, backlog, and cost from a real portfolio payload', async () => {
    vi.stubGlobal('fetch', mockFetch(PORTFOLIO));
    render(<PortfolioView />);

    await waitFor(() => expect(screen.getByText('ship the chart layer')).toBeInTheDocument());
    expect(screen.getByText('add retry to judge client')).toBeInTheDocument();
    expect(screen.getByText('Effectiveness trending up')).toBeInTheDocument();
  });

  it('renders an honest "not available" state instead of a fake chart when portfolio is null', async () => {
    vi.stubGlobal('fetch', mockFetch(null));
    render(<PortfolioView />);

    await waitFor(() =>
      expect(screen.getByText(/No portfolio roll-up available/)).toBeInTheDocument(),
    );
  });
});
