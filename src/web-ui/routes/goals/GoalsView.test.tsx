import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GoalsView } from './GoalsView.js';
import { evictAll } from '../../data/cache.js';

const GOALS = [
  {
    id: 'g1',
    objective: 'Ship the operator console',
    status: 'in-progress',
    milestones: [
      { title: 'foundation', status: 'done', order: 0 },
      { title: 'work views', status: 'in-progress', order: 1 },
    ],
    progress: { fractionDone: 0.5, counts: { done: 1, 'in-progress': 1 }, nextActionableId: 'm_abc123' },
  },
];

const MISSION = {
  schemaVersion: 1,
  state: 'ready',
  authority: 'planning-only',
  briefing: null,
  sources: {
    briefing: { sourceState: 'healthy', complete: true },
    goals: { sourceState: 'healthy', complete: true },
    enrollment: { sourceState: 'healthy', complete: true },
    proposals: { sourceState: 'healthy', complete: true },
  },
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/goals')) return new Response(JSON.stringify(GOALS), { status: 200 });
    if (url.startsWith('/api/vision/mission')) return new Response(JSON.stringify(MISSION), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('GoalsView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders goals with milestone progress and the mission state summary', async () => {
    render(
      <MemoryRouter>
        <GoalsView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Ship the operator console')).toBeInTheDocument());
    expect(screen.getByText('foundation')).toBeInTheDocument();
    expect(screen.getByText('work views')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    // nextActionableId is an internal milestone id with no matching field in
    // the milestones array — shown as its own line, not fabricated onto a title.
    expect(screen.getByText('m_abc123')).toBeInTheDocument();
  });
});
