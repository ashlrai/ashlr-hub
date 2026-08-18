import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GenomeView } from './GenomeView.js';
import { evictAll } from '../../../data/cache.js';

const LIST: unknown[] = [
  { id: 'g1', project: 'ashlr-hub', source: 'project', title: 'genome loop notes', text: 'the propose+consolidate loop runs on PostToolUse', tags: ['genome'], ts: new Date().toISOString() },
  { id: 'g2', project: 'ashlr-hub', source: 'project', title: 'merge pipeline state', text: 'autonomous merge pipeline is functional', tags: ['merge'], ts: new Date(Date.now() - 86_400_000).toISOString() },
];

const SEARCH_HITS: unknown[] = [
  { entry: LIST[0], score: 0.92, method: 'embedding' },
];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('q=')) return new Response(JSON.stringify(SEARCH_HITS), { status: 200 });
    if (url.startsWith('/api/genome')) return new Response(JSON.stringify(LIST), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('GenomeView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('browse mode lists entries and a top-projects chart without a query', async () => {
    render(<GenomeView />);
    await waitFor(() => expect(screen.getByText('genome loop notes')).toBeInTheDocument());
    expect(screen.getByText('Top projects by genome entries')).toBeInTheDocument();
  });

  it('debounced search switches to recall results with score/method', async () => {
    const user = userEvent.setup();
    render(<GenomeView />);
    await waitFor(() => expect(screen.getByText('genome loop notes')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Search cross-repo knowledge'), 'propose');
    await waitFor(() => expect(screen.getByText(/embedding/)).toBeInTheDocument(), { timeout: 2000 });
  });
});
