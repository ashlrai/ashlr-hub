import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SwarmsView } from './SwarmsView.js';
import { evictAll } from '../../../data/cache.js';

const SWARMS = [
  {
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
    plan: { specId: null, goal: 'refactor auth', tasks: [{ id: 't1', phase: 'build', goal: 'do it', deps: [] }] },
    tasks: [{ id: 't1', phase: 'build', status: 'running' }],
  },
];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/swarms')) {
      return new Response(JSON.stringify(SWARMS), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('SwarmsView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders swarms with a burndown bar from GET /api/swarms', async () => {
    render(
      <MemoryRouter>
        <SwarmsView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('refactor auth')).toBeInTheDocument());
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });
});
