import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { JournalView } from './JournalView.js';
import { evictAll } from '../../data/cache.js';

const now = new Date().toISOString();

const LOGS = { entries: [{ ts: now, kind: 'merge', msg: 'merged proposal p9' }], sourceQuality: { sourceState: 'healthy', complete: true } };
const ACTIVITY = {
  recentMerges: [],
  recentTicks: [],
  recentActions: [{ ts: now, actor: 'daemon', kind: 'merge', outcome: 'success', action: 'merge', summary: 'did the thing', proseDigest: 'Did the thing autonomously' }],
};
const RUNS = [
  { id: 'r1', goal: 'ship the feature', status: 'done', engine: 'e', provider: 'p', createdAt: now, updatedAt: now, budget: { maxTokens: 1, maxSteps: 1, allowCloud: true }, usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 }, tasks: [], steps: [] },
];
const INBOX = { pending: 0, proposals: [] };
const SNAPSHOT = { runs: [], swarms: [] };

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/logs-observation')) return new Response(JSON.stringify(LOGS), { status: 200 });
    if (url.startsWith('/api/fleet-activity')) return new Response(JSON.stringify(ACTIVITY), { status: 200 });
    if (url.startsWith('/api/run/')) {
      const id = url.slice('/api/run/'.length);
      const run = RUNS.find((r) => r.id === id);
      return run ? new Response(JSON.stringify(run), { status: 200 }) : new Response('not found', { status: 404 });
    }
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(RUNS), { status: 200 });
    if (url.startsWith('/api/inbox')) return new Response(JSON.stringify(INBOX), { status: 200 });
    if (url.startsWith('/api/snapshot')) return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('JournalView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges daemon log, fleet activity, and run history into one filterable feed', async () => {
    render(<JournalView />);

    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());
    expect(screen.getByText('Did the thing autonomously')).toBeInTheDocument();
    expect(screen.getByText('Daemon merge')).toBeInTheDocument();
  });

  it('filters entries by source via the checkbox group', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Runs'));

    await waitFor(() => expect(screen.queryByText('ship the feature')).not.toBeInTheDocument());
    expect(screen.getByText('Did the thing autonomously')).toBeInTheDocument();
  });

  it('filters entries by search text', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search the work journal'), { target: { value: 'nonexistent-xyz' } });

    await waitFor(() => expect(screen.getByText('Nothing matches the current filters in this window.')).toBeInTheDocument());
  });

  it('expanding a run row lazily loads its drill-in detail', async () => {
    render(<JournalView />);
    await waitFor(() => expect(screen.getByText('ship the feature')).toBeInTheDocument());

    fireEvent.click(screen.getByText('ship the feature'));

    await waitFor(() => expect(screen.getByText(/Run finished/)).toBeInTheDocument());
  });
});
