import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProductionView } from './ProductionView.js';
import { evictAll } from '../../../data/cache.js';

const SNAPSHOT_ZERO_SHIP = {
  generatedAt: new Date().toISOString(),
  repos: { total: 1, dirty: 0, stale: 0 },
  tools: { installed: 0, total: 0 },
  activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
  runs: [],
  swarms: [],
  mcp: [],
  genome: { entries: 0, projects: 0 },
  inbox: { pending: 0 },
  production: {
    generatedAt: new Date().toISOString(),
    proposals24h: { pending: 5, applied: 0, rejected: 2, total: 7 },
    judgeVerdicts24h: { ship: 0, review: 4, noise: 1, harmful: 0, total: 5 },
    judgeFailures24h: { parse: 2, network: 1, total: 3 },
    autoMergesToday: { count: 0, titles: [] },
    activeGoals: [],
    // Honest zero: 0 ships across every day in the trend — the chart must
    // render this as real zero-height bars, not hide the chart or fake data.
    shipsPerDayTrend: [
      { date: '2026-08-10', count: 0 },
      { date: '2026-08-11', count: 0 },
      { date: '2026-08-12', count: 0 },
    ],
    proposalSourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], filesDiscovered: 7, filesRead: 7, bytesRead: 100, invalidFiles: 0, unreadableFiles: 0 },
    judgeTraceSourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], filesRead: 5, bytesRead: 100, rowsScanned: 5, invalidRows: 0, unreadableFiles: 0 },
    judgeFailureSourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], filesRead: 3, bytesRead: 90, rowsScanned: 3, invalidRows: 0, unreadableFiles: 0 },
    activeGoalsSourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true },
  },
};

const SNAPSHOT_DEGRADED_JUDGE_SOURCES = {
  ...SNAPSHOT_ZERO_SHIP,
  production: {
    ...SNAPSHOT_ZERO_SHIP.production,
    // A degraded/incomplete read must never be indistinguishable from
    // "genuinely zero failures" — Epistemic should render "unknown" instead
    // of the withheld (zeroed) count below.
    judgeFailures24h: { parse: 0, network: 0, total: 0 },
    judgeFailureSourceQuality: {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    },
    judgeVerdicts24h: { ship: 0, review: 0, noise: 0, harmful: 0, total: 0 },
    judgeTraceSourceQuality: {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    },
    activeGoals: [],
    activeGoalsSourceQuality: { sourceState: 'degraded', sourcePresent: true, complete: false },
  },
};

const MODELS_RESULT = {
  window: '30d',
  models: [
    {
      engine: 'claude',
      model: 'sonnet-5',
      engineModel: 'claude:sonnet-5',
      dispatches: 10,
      judged: 5,
      shipVerdicts: 0,
      merged: 0,
      rejected: 2,
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 1,
      judgeCostUsd: 0.2,
      avgLatencyMs: 1200,
      shipRate: 0,
      costPerMergedUsd: null,
      outcomes: { reverted: 0, followedUp: 0 },
      bestOfN: { entered: 0, selected: 0, partialSelections: 0, won: 0, selectionRate: 0, winRate: 0 },
      shadow: { participated: 0, judged: 0, testPassed: 0, scoreTotal: 0, averageScore: null, wouldHaveWon: 0, wouldHaveWonRate: 0 },
      bestOfNAvailable: true,
    },
  ],
  bestOfNSource: {
    sourceState: 'degraded',
    sourcePresent: true,
    complete: false,
    stopReasons: ['io-error'],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 1,
  },
};

function mockFetch(snapshot: unknown = SNAPSHOT_ZERO_SHIP) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/snapshot')) return new Response(JSON.stringify(snapshot), { status: 200 });
    if (url.startsWith('/api/models')) return new Response(JSON.stringify(MODELS_RESULT), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('ProductionView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a 0-ship trend honestly rather than hiding the chart', async () => {
    render(<ProductionView />);
    await waitFor(() => expect(screen.getAllByText('Ships per day').length).toBeGreaterThan(0));
    expect(screen.getByText(/0 ships in the last 7 days/)).toBeInTheDocument();
  });

  it('renders judge infrastructure failures separately from real review verdicts', async () => {
    render(<ProductionView />);
    await waitFor(() => expect(screen.getByText('Judge verdict breakdown')).toBeInTheDocument());
    expect(screen.getByText('Judge failures (24h)')).toBeInTheDocument();
    expect(screen.getByText('2 parse · 1 network')).toBeInTheDocument();
  });

  it('does not present degraded proposal zeroes as known facts', async () => {
    const degraded = structuredClone(SNAPSHOT_ZERO_SHIP);
    degraded.production.proposalSourceQuality = {
      ...degraded.production.proposalSourceQuality,
      sourceState: 'degraded',
      complete: false,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify(url.startsWith('/api/snapshot') ? degraded : MODELS_RESULT), { status: 200 });
    }));
    render(<ProductionView />);
    await waitFor(() => expect(screen.getByText('Proposals (24h)')).toBeInTheDocument());
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
  });

  it('renders judge failures as their own KPI tile, distinct from the verdict breakdown', async () => {
    render(<ProductionView />);
    await waitFor(() => expect(screen.getByText('Judge failures (24h)')).toBeInTheDocument());
    // Real counts from judgeFailures24h (3 total: 2 parse, 1 network), not folded
    // into the 'review' bucket of the verdict-breakdown chart.
    expect(screen.getByText(/2 parse.*1 network/)).toBeInTheDocument();
  });

  it('shows "unknown" (not a false zero) for judge failures when the ledger read is degraded', async () => {
    vi.stubGlobal('fetch', mockFetch(SNAPSHOT_DEGRADED_JUDGE_SOURCES));
    render(<ProductionView />);
    await waitFor(() => expect(screen.getByText('Judge failures (24h)')).toBeInTheDocument());
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
  });

  it('withholds best-of-N win rate behind Epistemic when bestOfNSource is degraded', async () => {
    render(<ProductionView />);
    await waitFor(() => expect(screen.getByText('claude:sonnet-5')).toBeInTheDocument());
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
  });
});
