import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RunDetailView } from './RunDetailView.js';
import { evictAll } from '../../../data/cache.js';

const RUN = {
  id: 'r1',
  goal: 'ship the thing',
  engine: 'claude',
  provider: 'anthropic',
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:05:00.000Z',
  budget: { maxTokens: 100000, maxSteps: 20, allowCloud: true },
  usage: { tokensIn: 500, tokensOut: 200, steps: 2, estCostUsd: 0.12 },
  tasks: [
    { id: 't1', goal: 'scaffold', deps: [], status: 'done' },
    { id: 't2', goal: 'implement', deps: ['t1'], status: 'failed', error: 'boom' },
  ],
  steps: [{ ts: '2026-08-10T10:01:00.000Z', taskId: 't1', kind: 'tool', summary: 'ran a tool' }],
  status: 'failed',
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/run/r1')) {
      return new Response(JSON.stringify(RUN), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('RunDetailView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders full run detail with tasks (deps + errors) and step log', async () => {
    render(
      <MemoryRouter initialEntries={['/work/runs/r1']}>
        <Routes>
          <Route path="/work/runs/:id" element={<RunDetailView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('ship the thing')).toBeInTheDocument());
    expect(screen.getByText('scaffold')).toBeInTheDocument();
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText(/depends on:/)).toBeInTheDocument();
    expect(screen.getByText('ran a tool')).toBeInTheDocument();
  });
});
