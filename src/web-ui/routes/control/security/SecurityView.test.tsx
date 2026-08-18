import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SecurityView } from './SecurityView.js';
import { evictAll } from '../../../data/cache.js';

function controlWith(security: unknown) {
  return {
    ts: new Date().toISOString(),
    security,
  };
}

function respondFor(body: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/control')) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('SecurityView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders severity counts and findings when available', async () => {
    vi.stubGlobal(
      'fetch',
      respondFor(
        controlWith({
          available: true,
          findings: [{ repo: 'ashlr-hub', title: 'vulnerable dep', severity: 'critical', source: 'security' }],
          counts: { critical: 1, high: 0, medium: 0, low: 0 },
        }),
      ),
    );
    render(
      <MemoryRouter>
        <SecurityView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('vulnerable dep')).toBeInTheDocument());
    // 'ashlr-hub' legitimately appears twice: once as a repo-filter <option>,
    // once as the finding row's repo cell.
    expect(screen.getAllByText('ashlr-hub').length).toBeGreaterThan(0);
  });

  it('renders "no cached data" distinctly from "0 findings, clean" when available is false', async () => {
    vi.stubGlobal(
      'fetch',
      respondFor(controlWith({ available: false, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } })),
    );
    render(
      <MemoryRouter>
        <SecurityView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No cached security data available/)).toBeInTheDocument());
    expect(screen.queryByText('Critical')).not.toBeInTheDocument();
  });
});
