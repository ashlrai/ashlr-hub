import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SwarmDetailView } from './SwarmDetailView.js';
import { evictAll } from '../../../data/cache.js';

const SWARM = {
  id: 's1',
  goal: 'refactor auth',
  specId: null,
  project: null,
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:05:00.000Z',
  budget: { maxTokens: 100000, maxSteps: 20, allowCloud: true },
  usage: { tokensIn: 900, tokensOut: 300, estCostUsd: 0.2, steps: 4 },
  parallel: 3,
  status: 'running',
  plan: {
    specId: null,
    goal: 'refactor auth',
    tasks: [
      { id: 't1', phase: 'scaffold', goal: 'set up', deps: [] },
      { id: 't2', phase: 'build', goal: 'implement', deps: ['t1'] },
    ],
  },
  tasks: [
    { id: 't1', phase: 'scaffold', status: 'done' },
    { id: 't2', phase: 'build', status: 'running' },
  ],
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/swarm/s1')) {
      return new Response(JSON.stringify(SWARM), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('SwarmDetailView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the DAG and a keyboard-reachable task list with dependencies', async () => {
    render(
      <MemoryRouter initialEntries={['/work/swarms/s1']}>
        <Routes>
          <Route path="/work/swarms/:id" element={<SwarmDetailView />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('refactor auth')).toBeInTheDocument());
    // DAG node <text> and the plain-text task list both carry each task's
    // goal, so these appear twice — assert presence via getAllByText rather
    // than getByText (which throws on multiple matches).
    expect(screen.getAllByText('set up').length).toBeGreaterThan(0);
    expect(screen.getAllByText('implement').length).toBeGreaterThan(0);
    expect(screen.getByText('depends on: t1')).toBeInTheDocument();
    // Task list items are real elements with an id the DAG's <a> links target.
    expect(document.getElementById('dag-task-t1')).not.toBeNull();
    expect(document.getElementById('dag-task-t2')).not.toBeNull();
  });
});
