import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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

  // Pins the roving-tabindex row navigation this view previously lacked
  // (the audit finding: rows were plain <tr>s, a keyboard user could only
  // Tab through one Link per row with no Arrow/Enter row navigation).
  // Falsified by removing the ArrowDown branch from RunsView.tsx's
  // onTableKeyDown: the test failed with focus staying on row r1 and no
  // navigation firing on Enter, confirming it pins real Arrow+Enter
  // behavior rather than passing on the row-1 default.
  it('rows are keyboard navigable: ArrowDown moves focus, Enter opens the focused run', async () => {
    render(
      <MemoryRouter initialEntries={['/work/runs']}>
        <Routes>
          <Route path="/work/runs" element={<RunsView />} />
          <Route path="/work/runs/:id" element={<div>RUN DETAIL r1</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('ashlr-hub: ship the thing')).toBeInTheDocument());

    // Default sort is createdAt desc, so r2 (created 08-12) renders above r1
    // (created 08-10) — row 0 is "other-repo", row 1 is "ashlr-hub".
    const firstRow = screen.getByText('other-repo: fix the bug').closest('tr')!;
    expect(firstRow).toHaveAttribute('tabindex', '0');
    firstRow.focus();
    expect(firstRow).toHaveFocus();

    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });

    const secondRow = screen.getByText('ashlr-hub: ship the thing').closest('tr')!;
    await waitFor(() => expect(secondRow).toHaveFocus());

    fireEvent.keyDown(secondRow, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('RUN DETAIL r1')).toBeInTheDocument());
  });
});
