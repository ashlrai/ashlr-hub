import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunsView } from './RunsView.js';
import { evictAll } from '../../../data/cache.js';

const RUNS = [
  {
    id: 'r1',
    goal: 'ashlr-hub: ship the thing',
    engine: 'claude',
    provider: 'anthropic',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:05:00.000Z',
    budget: { maxTokens: 100000, maxSteps: 20, allowCloud: true },
    usage: { tokensIn: 500, tokensOut: 200, steps: 3, estCostUsd: 0.12 },
    tasks: [],
    steps: [],
    status: 'done',
  },
  {
    id: 'r2',
    goal: 'other-repo: fix the bug',
    engine: 'codex',
    provider: 'openai',
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:05:00.000Z',
    budget: { maxTokens: 100000, maxSteps: 20, allowCloud: true },
    usage: { tokensIn: 900, tokensOut: 400, steps: 5, estCostUsd: 0.4 },
    tasks: [],
    steps: [],
    status: 'failed',
  },
];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/runs')) {
      return new Response(JSON.stringify(RUNS), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('RunsView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders runs from GET /api/runs with search/filter/sort controls', async () => {
    render(
      <MemoryRouter>
        <RunsView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('ashlr-hub: ship the thing')).toBeInTheDocument());
    expect(screen.getByText('other-repo: fix the bug')).toBeInTheDocument();
    expect(screen.getByRole('search', { name: /filter runs/i })).toBeInTheDocument();
  });

  it('filters by search text matching goal (the repo-name proxy)', async () => {
    render(
      <MemoryRouter>
        <RunsView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('ashlr-hub: ship the thing')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/goal or run id/i);
    fireEvent.change(search, { target: { value: 'other-repo' } });

    await waitFor(() => expect(screen.queryByText('ashlr-hub: ship the thing')).not.toBeInTheDocument());
    expect(screen.getByText('other-repo: fix the bug')).toBeInTheDocument();
  });
});
